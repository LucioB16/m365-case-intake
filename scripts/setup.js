const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

async function main() {
    console.log("===============================================");
    console.log(" M365 Copilot Case Intake - First Run Auth");
    console.log("===============================================\n");

    console.log("Launching interactive browser...");
    console.log("Please ensure you are logged into M365 Copilot.");
    console.log("Once you verify you are logged in, CLOSE the browser window to continue.\n");

    const runBrowserCode = `
        const { chromium } = require('playwright');
        const path = require('path');
        const DATA_DIR = path.join(process.env.LOCALAPPDATA || process.cwd(), 'CopilotDailyProfile');
        (async () => {
            const context = await chromium.launchPersistentContext(DATA_DIR, { headless: false, channel: 'msedge' });
            const page = await context.newPage();
            await page.goto('https://m365.cloud.microsoft/chat');
            console.log("Browser opened. Please login if prompted. Close the browser window when done.");
            await new Promise(resolve => context.on('close', resolve));
        })();
    `;
    const tempScript = path.join(__dirname, 'temp_browser.js');
    fs.writeFileSync(tempScript, runBrowserCode);
    spawnSync('node', [tempScript], { stdio: 'inherit' });
    fs.unlinkSync(tempScript);
    
    console.log("\nAuth complete!");
    console.log("Make sure config.json is populated in the root directory before running tasks.");
}

main().catch(console.error);
