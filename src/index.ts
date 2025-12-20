import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { Crawler, CrawlerConfig } from './crawler';

const program = new Command();

program
    .option('-c, --config <path>', 'Path to config file', 'config.json')
    .option('--start_url <url>', 'Start URL')
    .option('--run_mode <mode>', 'run mode (dry_run or full_run)')
    .option('--headless <boolean>', 'Headless mode')
    .option('--resume [path]', 'Resume from the last crawl or specific path')
    .parse(process.argv);

const options = program.opts();

async function main() {
    try {
        // Load config
        const configPath = path.resolve(process.cwd(), options.config);
        let config: CrawlerConfig;

        if (await fs.pathExists(configPath)) {
            config = await fs.readJson(configPath);
        } else {
            console.warn(`Config file not found at ${configPath}, using defaults/CLI args only.`);
            // @ts-ignore
            config = { browser_config: { headless: true, browser_type: 'chromium', viewport: { width: 1920, height: 1080 } }, blocked_paths: [], allowed_external_domains: [], file_types: ['web'] };
        }

        // Override with CLI args
        if (options.start_url) config.start_url = options.start_url;
        if (options.run_mode) config.run_mode = options.run_mode as 'dry_run' | 'full_run';
        if (options.headless !== undefined) config.browser_config.headless = options.headless === 'true';

        // Handle Resume
        // Handle Resume
        if (options.resume) {
            if (typeof options.resume === 'string') {
                const resumePath = path.resolve(process.cwd(), options.resume);
                if (await fs.pathExists(resumePath)) {
                    console.log(`Resuming from specified path: ${resumePath}`);
                    config.resume_from = resumePath;
                } else {
                    console.error(`Specified resume path not found: ${resumePath}`);
                    process.exit(1);
                }
            } else {
                const exportBase = path.resolve(process.cwd(), 'Export');
                if (await fs.pathExists(exportBase)) {
                    const entries = await fs.readdir(exportBase);
                    const dirs = [];
                    for (const entry of entries) {
                        const fullPath = path.join(exportBase, entry);
                        if ((await fs.stat(fullPath)).isDirectory()) {
                            dirs.push(entry);
                        }
                    }
                    // Sort descending (alphanumeric works for YYYY-MM-DD_time)
                    dirs.sort().reverse();

                    if (dirs.length > 0) {
                        const lastRun = path.join(exportBase, dirs[0]);
                        console.log(`Auto-resume enabled. Found last run: ${dirs[0]}`);
                        config.resume_from = lastRun;
                    } else {
                        console.warn('No previous runs found in Export/ to resume from.');
                    }
                } else {
                    console.warn('Export directory does not exist, cannot resume.');
                }
            }
        }

        if (!config.start_url) {
            console.error('start_url is required (in config or CLI)');
            process.exit(1);
        }

        const crawler = new Crawler(config);
        await crawler.init();
        await crawler.start();

    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

main();
