const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.LOCALAPPDATA || process.cwd(), 'CopilotDailyProfile');
const URL = 'https://m365.cloud.microsoft/chat';

async function runCopilot(promptText, outputFilePath) {
    console.log('[INFO] Starting M365 Copilot automation...');
    console.log('[INFO] Launching Edge with dedicated profile...');
    
    let context;
    try {
        context = await chromium.launchPersistentContext(DATA_DIR, {
            headless: true,
            channel: 'msedge',
            args: ['--disable-blink-features=AutomationControlled'],
            viewport: { width: 1280, height: 720 }
        });
        console.log('[INFO] Edge launched successfully!');
    } catch (e) {
        console.error('[ERROR] Failed to launch Edge:', e.message);
        process.exit(1);
    }

    const page = await context.newPage();
    console.log(`[INFO] Navigating to ${URL}`);
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

    try {
        console.log('[INFO] Switching to Work scope...');
        const workToggle = page.locator('button[data-content="Work"]');
        await workToggle.waitFor({ state: 'visible', timeout: 5000 });
        const isSelected = await workToggle.getAttribute('aria-selected');
        if (isSelected !== 'true') {
            await workToggle.click();
            await page.waitForTimeout(2000);
        }
    } catch (e) {
        console.log('[INFO] Work toggle not found within 5s, might be unavailable or already set.');
    }

    try {
        console.log('[INFO] Selecting Claude Opus model...');
        const claudeDropdown = page.locator('button[data-test-id="claude-submenu-trigger"]');
        await claudeDropdown.waitFor({ state: 'visible', timeout: 5000 });
        await claudeDropdown.click();
        await page.waitForTimeout(1000);
        const opusOption = page.locator('button[data-test-id="claude-opus-option"]');
        await opusOption.waitFor({ state: 'visible', timeout: 5000 });
        await opusOption.click();
        console.log('[INFO] Selected Claude Opus model.');
    } catch (e) {
        console.log('[INFO] Could not select Claude Opus explicitly, continuing with default model.');
    }

    console.log('[INFO] Pasting prompt into the composer...');
    const chatInput = page.locator('#chat-input-textarea');
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });
    
    // Evaluate to set value (bypasses slow typing)
    await chatInput.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, promptText);

    await page.waitForTimeout(1000);
    
    console.log('[INFO] Submitting prompt...');
    const sendBtn = page.locator('button[data-test-id="send-button"]');
    await sendBtn.waitFor({ state: 'visible' });
    await sendBtn.click();

    console.log('[INFO] Waiting for response to finish streaming (waiting for Copy button)...');
    
    const copyButton = page.locator('button[data-test-id="copy-button"]').last();
    await copyButton.waitFor({ state: 'visible', timeout: 600000 }); // Wait up to 10 mins
    
    console.log('[INFO] Response streaming completed (Copy button appeared).');
    
    await copyButton.click();
    console.log('[INFO] Copied to clipboard.');
    
    const clipboardText = await page.evaluate(async () => {
        return await navigator.clipboard.readText();
    });

    const outDir = path.dirname(outputFilePath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    
    fs.writeFileSync(outputFilePath, clipboardText, 'utf8');
    console.log(`[INFO] Saved final response to ${outputFilePath}`);

    await context.close();
}

module.exports = { runCopilot };
