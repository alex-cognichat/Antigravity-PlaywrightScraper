import { getDomain } from 'tldts';
import fs from 'fs-extra';
import path from 'path';

export interface ScrapingSummary {
    scraping_info: {
        base_url: string;
        scraped_at: string;
        total_discovered: number;
        successfully_scraped: number;
        failed_urls: number;
        failed_url_list: string[];
    };
    scraped_urls: string[];
}

export class Utils {
    static getRootDomain(url: string): string | null {
        return getDomain(url);
    }

    static generateTimestamp(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    }

    static async saveFile(exportDir: string, filename: string, content: string | Buffer): Promise<void> {
        const filePath = path.join(exportDir, filename);
        await fs.outputFile(filePath, content);
    }

    static sanitizeFilename(url: string): string {
        // Basic sanitization, can be improved
        return url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9.\-_]/g, '_').substring(0, 200);
    }
}
