const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise(resolve => rl.question(query, resolve));

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

async function main() {
    console.log("===============================================");
    console.log(" M365 Copilot Case Intake - First Run Setup");
    console.log("===============================================\n");

    console.log("Step 1: M365 Authentication Check");
    console.log("We will launch an interactive browser. Please ensure you are logged into M365 Copilot.");
    console.log("Once you verify you are logged in, close the browser window to continue.\n");
    await question("Press Enter to open the browser...");

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
    
    console.log("\nStep 2: Configuration");
    
    const osUsername = os.userInfo().username;
    const name = await question(`Your Full Name (or press Enter for '${osUsername}'): `) || osUsername;
    const email = await question(`Your Work Email: `);
    
    // OneDrive Auto-Discovery
    const detectedOneDrive = process.env.OneDriveCommercial || process.env.OneDrive || path.join(os.homedir(), 'OneDrive');
    const defaultCasesPath = path.join(detectedOneDrive, 'Client Cases');
    const onedriveFolder = await question(`Path to cases (Press Enter for '${defaultCasesPath}'): `) || defaultCasesPath;
    
    // We normalize to forward slashes just in case, though Node path handles it.
    const normalizedFolder = onedriveFolder.replace(/\\/g, '/');

    const timezone = await question("Timezone (e.g., America/Argentina/Cordoba, UTC): ") || "UTC";
    const lookback = await question("Default batch lookback window in hours (default: 24): ") || "24";
    
    console.log("\nProducts tracked in the last year (discovered): CRM, ERP, Other, Power Platform, Reporting");
    const products = await question("Which products do you want to track? (comma-separated, default: CRM, Power Platform): ") || "CRM, Power Platform";
    
    console.log("\nScope of tracking:");
    console.log("1. All Cases (Default)");
    console.log("2. Only cases assigned to me or where I am the owner");
    const scopeOption = await question("Select scope (1 or 2): ") || "1";

    console.log("\nSecurity / Privacy:");
    const obf = await question("Enable Data Obfuscation to redact PII and sensitive server names in case files? (y/n, default: y): ") || "y";
    
    const config = {
        USER_NAME: name,
        USER_EMAIL: email || "",
        ONEDRIVE_FOLDER: normalizedFolder,
        TIMEZONE: timezone,
        LOOKBACK_HOURS: parseInt(lookback, 10),
        PRODUCTS: products.split(',').map(p => p.trim()),
        SCOPE: scopeOption === "2" ? "ASSIGNED_ONLY" : "ALL",
        OBFUSCATE_DATA: obf.toLowerCase().startsWith('y')
    };
    
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    
    console.log("\nSetup complete! Configuration saved to config.json.");
    console.log("You can now run 'npm run batch' for the daily sync or 'npm run fetch' for on-demand.");
    rl.close();
}

main().catch(console.error);
