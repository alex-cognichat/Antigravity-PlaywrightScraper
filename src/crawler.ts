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

    private async processUrl(item: QueueItem) {
        if (!this.context) throw new Error('Browser context not initialized');
        const page = await this.context.newPage();
        const { url, depth } = item;

        console.log(`Processing [Depth ${depth}]: ${url}`);

        try {
            let isResumed = false;

            // Check if file already exists (Resume logic)
            // We strip protocol/sanitize to find filename
            const filename = Utils.sanitizeFilename(url) + '.html';
            const filePath = path.join(this.exportDir, filename);

            if (this.config.resume_from && await fs.pathExists(filePath)) {
                console.log(`[Resuming] File exists, skipping download: ${url}`);
                const content = await fs.readFile(filePath, 'utf-8');
                // Inject base href for "hydration" if needed, though mostly we just skip
                const htmlWithBase = `<base href="${url}">\n` + content;
                await page.setContent(htmlWithBase);
                isResumed = true;
            }

            if (!isResumed) {
                // Navigation with WAF/Bot bypass waiting
                const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                // Basic WAF checks
                await page.waitForTimeout(1000);

                // Check for specific challenge titles
                const title = await page.title();
                if (title.includes('Just a moment...') || title.includes('Challenge')) {
                    console.log('Use detected WAF challenge. Waiting...');
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

                // Save HTML/File
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
                // If resumed, ensure it records in the final JSON if it was missing (e.g. crash before save)
                if (!this.previousScraped.has(url)) {
                    this.summary.scraped_urls.push(url);
                    // We don't increment successfully_scraped count for *this* run to avoid inflating stats, 
                    // or we could counts it as "recovered". For now, we just ensure it's in the list.
                    await this.updateReport();
                    // Also track it so we don't add it again if we encounter it multiple times (unlikely with visited set)
                    this.previousScraped.add(url);
                }
            }

            // Recurse
            if (depth < this.config.max_depth) {
                const links = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href]'))
                        .map(a => (a as HTMLAnchorElement).href)
                        .filter(href => href.startsWith('http')); // Basic filter
                });

                for (const link of links) {
                    // Normalize
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

    private shouldCrawl(url: string): boolean {
        if (this.visited.has(url)) return false;

        // blocked paths
        if (this.config.blocked_paths.some(path => url.includes(path))) return false;

        // Domain check
        const rootDomain = Utils.getRootDomain(this.config.start_url);
        const linkDomain = Utils.getRootDomain(url);

        if (linkDomain === rootDomain) return true;

        // Check external allowed
        if (this.config.allowed_external_domains.includes(linkDomain || '')) return false; // Allowed internals logic is separate in spec, typically we crawl internal, but might allow download external. 
        // For this simplified logic, we only crawl internal.

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
