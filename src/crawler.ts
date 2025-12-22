import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright';
import { getDomain } from 'tldts';
import fs from 'fs-extra';
import path from 'path';
import { Utils, ScrapingSummary } from './utils';

export interface CrawlerConfig {
    start_url: string;
    max_depth: number;
    file_types: string[];
    blocked_paths: string[];
    blocked_hosts: string[];
    allowed_external_domains: string[];
    run_mode: 'dry_run' | 'full_run';
    browser_config: {
        headless: boolean;
        browser_type: 'chromium' | 'firefox' | 'webkit';
        viewport: { width: number; height: number };
    };
    resume_from?: string;
}

interface QueueItem {
    url: string;
    depth: number;
}

export class Crawler {
    private config: CrawlerConfig;
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private exportDir: string;
    private visited: Set<string> = new Set();
    private queue: QueueItem[] = [];
    private summary: ScrapingSummary;
    private reportPath: string;
    private previousScraped: Set<string> = new Set();

    constructor(config: CrawlerConfig) {
        this.config = config;

        if (config.resume_from) {
            this.exportDir = config.resume_from;
            console.log(`Resuming into existing directory: ${this.exportDir}`);
        } else {
            const timestamp = Utils.generateTimestamp();
            this.exportDir = path.resolve(process.cwd(), 'Export', timestamp);
        }

        this.reportPath = path.join(this.exportDir, 'scraping_summary.json');

        this.summary = {
            scraping_info: {
                base_url: config.start_url,
                scraped_at: new Date().toISOString(),
                total_discovered: 0,
                successfully_scraped: 0,
                failed_urls: 0,
                failed_url_list: [],
            },
            scraped_urls: [],
        };
    }

    async init() {
        console.log(`Initializing Crawler... Output dir: ${this.exportDir}`);
        // Create export folder
        await fs.ensureDir(this.exportDir);
        // Do NOT update report yet, we might need to load it first!

        // Resume state loading (if applicable) is now based on whether exportDir has data
        if (this.config.resume_from && await fs.pathExists(this.reportPath)) {
            try {
                const summary: ScrapingSummary = await fs.readJson(this.reportPath);
                if (summary.scraped_urls) {
                    summary.scraped_urls.forEach(u => this.previousScraped.add(u));
                    console.log(`Loaded ${this.previousScraped.size} previously scraped URLs.`);
                }
                // We rely on the summary to populate previousScraped,
                // which helps us avoid re-queueing if we were using a persisted queue (which we aren't yet).
                // But mainly it helps with stats.
                this.summary.scraping_info.total_discovered = summary.scraping_info.total_discovered;
                this.summary.scraping_info.successfully_scraped = summary.scraping_info.successfully_scraped;
                this.summary.scraping_info.failed_urls = summary.scraping_info.failed_urls;
            } catch (e) {
                console.error(`Failed to load resume summary: ${e}`);
            }
        }

        // NOW we can save the initial state (either empty or loaded)
        await this.updateReport();

        const browserType = {
            chromium,
            firefox,
            webkit,
        }[this.config.browser_config.browser_type];

        this.browser = await browserType.launch({
            headless: this.config.browser_config.headless,
        });

        this.context = await this.browser.newContext({
            viewport: this.config.browser_config.viewport,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', // Standard user agent
        });

        // Handle interrupts
        process.on('SIGINT', async () => {
            console.log('\nCaught interrupt signal. Saving state and exiting...');
            await this.cleanup();
            process.exit();
        });
    }

    async start() {
        this.queue.push({ url: this.config.start_url, depth: 0 });
        this.visited.add(this.config.start_url);
        this.summary.scraping_info.total_discovered++;

        while (this.queue.length > 0) {
            const current = this.queue.shift()!;
            await this.processUrl(current);
        }

        console.log('Crawling finished.');
        await this.cleanup();
    }

    private getFileExtension(url: string): string | null {
        try {
            const parsedUrl = new URL(url);
            const pathname = parsedUrl.pathname;
            const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
            return match ? match[1].toLowerCase() : null;
        } catch {
            return null;
        }
    }

    private isFileTypeAllowed(extension: string): boolean {
        // 'web' means HTML pages (no extension or .html/.htm)
        // Other extensions like 'pdf' are checked directly
        if (this.config.file_types.includes('all')) return true;
        if (extension === 'html' || extension === 'htm') {
            return this.config.file_types.includes('web');
        }
        return this.config.file_types.includes(extension);
    }

    private async processUrl(item: QueueItem) {
        if (!this.context) throw new Error('Browser context not initialized');
        const page = await this.context.newPage();
        const { url, depth } = item;

        console.log(`Processing [Depth ${depth}]: ${url}`);

        try {
            // Detect file extension from URL
            const urlExtension = this.getFileExtension(url);
            const isWebPage = !urlExtension || urlExtension === 'html' || urlExtension === 'htm' || urlExtension === 'php' || urlExtension === 'aspx';

            // Check if it's a binary file that we should download
            if (urlExtension && !isWebPage && this.isFileTypeAllowed(urlExtension)) {
                // Binary file download (PDF, etc.)
                await this.downloadBinaryFile(url, urlExtension);
                return;
            }

            // Check if web pages are allowed
            if (isWebPage && !this.config.file_types.includes('web') && !this.config.file_types.includes('all')) {
                console.log(`Skipping web page (not in file_types): ${url}`);
                return;
            }

            let isResumed = false;

            // Check if file already exists (Resume logic)
            const filename = Utils.sanitizeFilename(url) + '.html';
            const filePath = path.join(this.exportDir, filename);

            if (this.config.resume_from && await fs.pathExists(filePath)) {
                console.log(`[Resuming] File exists, skipping download: ${url}`);
                const content = await fs.readFile(filePath, 'utf-8');
                const htmlWithBase = `<base href="${url}">\n` + content;
                await page.setContent(htmlWithBase);
                isResumed = true;
            }

            if (!isResumed) {
                // Navigation with WAF/Bot bypass waiting
                const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                // Check Content-Type header for binary files
                const contentType = response?.headers()['content-type'] || '';
                if (contentType.includes('application/pdf') && this.isFileTypeAllowed('pdf')) {
                    // It's a PDF served without .pdf extension
                    const body = await response?.body();
                    if (body) {
                        const pdfFilename = Utils.sanitizeFilename(url) + '.pdf';
                        await Utils.saveFile(this.exportDir, pdfFilename, body);
                        console.log(`Downloaded PDF: ${pdfFilename}`);
                        this.summary.scraping_info.successfully_scraped++;
                        this.summary.scraped_urls.push(url);
                        await this.updateReport();
                    }
                    await page.close();
                    return;
                }

                // Basic WAF checks
                await page.waitForTimeout(1000);

                // Check for specific challenge titles
                const title = await page.title();
                if (title.includes('Just a moment...') || title.includes('Challenge')) {
                    console.log('Detected WAF challenge. Waiting...');
                    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
                }

                // Cookie Consent
                try {
                    const cookieSelectors = [
                        '#onetrust-accept-btn-handler',
                        'button:has-text("Accept All")',
                        'button:has-text("Allow All")',
                        'button:has-text("I Agree")',
                        '[aria-label="Accept cookies"]'
                    ];
                    for (const selector of cookieSelectors) {
                        if (await page.$(selector)) {
                            await page.click(selector);
                            await page.waitForTimeout(500);
                            break;
                        }
                    }
                } catch (e) {
                    // Ignore
                }

                // Save HTML
                if (this.config.run_mode === 'full_run') {
                    const content = await page.content();
                    const filename = Utils.sanitizeFilename(url) + '.html';
                    await Utils.saveFile(this.exportDir, filename, content);
                }
            }

            // Update Summary
            if (!isResumed) {
                this.summary.scraping_info.successfully_scraped++;
                this.summary.scraped_urls.push(url);
                await this.updateReport();
            } else {
                if (!this.previousScraped.has(url)) {
                    this.summary.scraped_urls.push(url);
                    await this.updateReport();
                    this.previousScraped.add(url);
                }
            }

            // Recurse - extract links for both web pages AND discovering file links
            if (depth < this.config.max_depth) {
                const links = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href]'))
                        .map(a => (a as HTMLAnchorElement).href)
                        .filter(href => href.startsWith('http'));
                });

                for (const link of links) {
                    const cleanLink = link.split('#')[0];

                    if (this.shouldCrawl(cleanLink)) {
                        this.visited.add(cleanLink);
                        this.queue.push({ url: cleanLink, depth: depth + 1 });
                        this.summary.scraping_info.total_discovered++;
                    }
                }
            }

        } catch (error: any) {
            console.error(`Failed to process ${url}: ${error.message}`);
            this.summary.scraping_info.failed_urls++;
            this.summary.scraping_info.failed_url_list.push(url);
            await this.updateReport();
        } finally {
            await page.close();
        }
    }

    private async downloadBinaryFile(url: string, extension: string) {
        console.log(`Downloading binary file [${extension}]: ${url}`);

        try {
            // Check for resume
            const filename = Utils.sanitizeFilename(url) + '.' + extension;
            const filePath = path.join(this.exportDir, filename);

            if (this.config.resume_from && await fs.pathExists(filePath)) {
                console.log(`[Resuming] File exists, skipping: ${url}`);
                if (!this.previousScraped.has(url)) {
                    this.summary.scraped_urls.push(url);
                    this.previousScraped.add(url);
                    await this.updateReport();
                }
                return;
            }

            // Use fetch-like approach with Playwright's request context
            const response = await this.context!.request.get(url);

            if (response.ok()) {
                const body = await response.body();
                await Utils.saveFile(this.exportDir, filename, body);
                console.log(`Downloaded: ${filename}`);

                this.summary.scraping_info.successfully_scraped++;
                this.summary.scraped_urls.push(url);
                await this.updateReport();
            } else {
                console.error(`Failed to download ${url}: HTTP ${response.status()}`);
                this.summary.scraping_info.failed_urls++;
                this.summary.scraping_info.failed_url_list.push(url);
                await this.updateReport();
            }
        } catch (error: any) {
            console.error(`Failed to download ${url}: ${error.message}`);
            this.summary.scraping_info.failed_urls++;
            this.summary.scraping_info.failed_url_list.push(url);
            await this.updateReport();
        }
    }

    private shouldCrawl(url: string): boolean {
        if (this.visited.has(url)) return false;

        // blocked paths
        if (this.config.blocked_paths.some(path => url.includes(path))) return false;

        // blocked hosts - check exact hostname match
        try {
            const urlHost = new URL(url).hostname;
            if (this.config.blocked_hosts?.some(blockedHost => urlHost === blockedHost)) {
                return false;
            }
        } catch {
            // Invalid URL, skip host check
        }

        // Hostname check - only crawl URLs on the same hostname as start_url
        try {
            const startHostname = new URL(this.config.start_url).hostname;
            const linkHostname = new URL(url).hostname;

            // Exact hostname match - this ensures we only crawl on support.heimdalsecurity.com
            // and not dashboard.heimdalsecurity.com or other subdomains
            if (linkHostname === startHostname) return true;
        } catch {
            // Invalid URL
        }

        // Check external allowed domains (by root domain)
        const linkDomain = Utils.getRootDomain(url);
        if (this.config.allowed_external_domains.includes(linkDomain || '')) return false;

        return false;
    }

    private async updateReport() {
        await fs.outputJson(this.reportPath, this.summary, { spaces: 2 });
    }

    private async cleanup() {
        if (this.browser) await this.browser.close();
        await this.updateReport(); // Final save
    }
}
