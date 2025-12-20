# Playwright Web Crawler Specification (Phase Two)

## Goal Description
Create a robust, configurable web crawler in **TypeScript** using **Playwright** (running on Node.js) to recursively download web pages and specific file types. All downloads must be saved in a single flat timestamped directory per run.

## Critical Objective
The crawler must successfully bypass modern "Bot Protection" systems (Cloudflare, WAFs, etc.) by simulating a real user.

## Configuration
The application reads input parameters from `config.json` and overrides them with CLI arguments.

### Configuration Parameters
- **`start_url`** (String): Entry point.
- **`max_depth`** (Integer): Recursion limit (Max: 10).
- **`file_types`** (String[]): Extensions to download (e.g., `["web"]`, `["pdf", "docx"]`, `["all"]`).
    - `"web"` preset: Downloads page HTML (as `.html`) and typically text-based assets.
- **`blocked_paths`** (String[]): URL prefixes to strictly exclude.
- **`allowed_external_domains`** (String[]): Whitelist for external domains (download only, no recursion).
- **`run_mode`** (String): `"dry_run"` or `"full_run"`.
- **`browser_config`**:
    - `headless` (Boolean): Default `true` (can be toggled for debugging).
    - `browser_type` (String): `"chromium"` (default/recommended), `"firefox"`, `"webkit"`.
    - `browser_type` (String): `"chromium"` (default/recommended), `"firefox"`, `"webkit"`.
    - `viewport`: `{ width: 1920, height: 1080 }`.
- **`resume`** (Boolean): Optional flag. If set, the crawler attempts to resume from the most recent existing Export directory.

### Resume Capability
- **Goal**: Allow seamless continuation of interrupted crawls.
- **Behavior**:
    - When `--resume` is passed, the crawler identifies the most recent timestamped subfolder in `Export/`.
    - It maintains that **same** directory for output (does NOT create a new timestamped folder).
    - Previous downloaded files remain untouched.
    - `scraping_summary.json` is loaded to populate the "visited" cache and "successfully scraped" metrics.
    - The crawler proceeds to find *new* links and download *new* files into this same directory.
    - If no previous run exists, it falls back to starting a fresh run in a new directory.

## Core Logic & Rules

### 1. WAF & Bot Protection Strategy
- **Navigation**: Use `page.goto(url, { waitUntil: 'domcontentloaded' })`.
- **Challenge Handling**:
    - Check DOM for "Just a moment...", "Challenge", "Verify you are human".
    - **Action**: Wait (up to 30s) for `networkidle`. If content appears, proceed.
- **Cookie Consent Automation**:
    - Automatically detect and click "Allow All", "Accept", or "Agree" buttons to clear cookie modals.
- **Session**: Use persistent `BrowserContext` to maintain cookies/session state across requests where possible.

### 2. File Download & Storage Strategy (CRITICAL)
- **Directory Structure**:
    - Root: `Export/`
    - Run Folder: `Export/<YYYY-MM-DD_HH-MM-SS>/` (Created on new run; reused on `--resume`).
- **FLAT OUTPUT ONLY**: All files (HTML, PDF, Images, DOCX) must reside directly in this folder. **NO Subdirectories**.
- **Immediate Action**: Files and HTML must be saved **immediately** upon processing. Do not wait for the crawl to finish.
    - **EXCEPTION**: If `run_mode` is `"dry_run"`, **NO** HTML or content files should be saved. Only the JSON report is generated.
- **Real-time Reporting (`scraping_summary.json`)**:
    - A JSON file must be created and updated **in real-time** (after each page/file).
    - **Structure**:
      ```json
      {
        "scraping_info": {
          "base_url": "String",
          "scraped_at": "ISO String",
          "total_discovered": Integer,
          "successfully_scraped": Integer,
          "failed_urls": Integer,
          "failed_url_list": ["url1", "url2"]
        },
        "scraped_titles": [
          "Page Title 1",
          "Page Title 2"
        ]
      }
      ```
    - **Graceful Interrupt**: Pressing Ctrl+C must preserve the valid JSON state of this file.

### 3. Execution Flow (Async)
- **Setup**:
    - Check for `--resume`.
    - If Resume: Identify last folder -> Load State -> Set `ExportDir` to existing folder.
    - If New: Create `Export/<timestamp>/` -> Set `ExportDir`.
    - Launch Browser using Playwright.
- **Crawl Loop**:
    - **Queue System**: Manager URL queue with concurrency limit (e.g., using `p-queue` or custom array/promise handling).
    - **Worker Steps**:
        1. **Navigate**: `await page.goto(url)`.
        2. **WAF Check**: Wait if needed.
        3. **Cookie Check**: Auto-accept cookies.
        4. **Process Content**:
            - **Is File?**: Detect via headers/extension -> Download to flat folder.
            - **Is Page?**: Save HTML to flat folder.
            - **Recurse**: If `depth < max_depth`, extract links via `page.evaluate` -> Filter using `tldts` (root domain check) & `blocked_paths` -> Enqueue.
    - **Reporting**: Update in-memory structure and flush to `fs` (JSON) in real-time.
- **Completion**:
    - Close Browser.
    - Finalize reports.

## Technical Recommendations
- **Language**: TypeScript (Node.js).
- **Libraries**:
    - `playwright` (Core library).
    - `tldts` (For domain parsing).
    - `commander` or `yargs` (For CLI).
    - `fs-extra` (For file ops).
- **Pattern**: Use `page.waitForResponse` or event listeners to handle downloads dynamically.
