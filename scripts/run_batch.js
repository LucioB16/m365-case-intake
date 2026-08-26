const fs = require('fs');
const path = require('path');
const { runCopilot } = require('./lib/playwright_runner');
const { parsePayload } = require('./lib/parser');

const rootDir = path.join(__dirname, '..');
const configPath = path.join(rootDir, 'config.json');
const yamlPath = path.join(rootDir, 'prompts', 'base_intake.yaml');
const logPath = path.join(rootDir, 'logs', 'latest_response.md');

if (!fs.existsSync(configPath)) {
    console.error("config.json not found! Please run 'npm run setup' first.");
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

let template = fs.readFileSync(yamlPath, 'utf8');

// Inject Config
template = template
    .replace(/{{USER_NAME}}/g, config.USER_NAME)
    .replace(/{{USER_EMAIL}}/g, config.USER_EMAIL)
    .replace(/{{TIMEZONE}}/g, config.TIMEZONE)
    .replace(/{{LOOKBACK_HOURS}}/g, config.LOOKBACK_HOURS)
    .replace(/{{ONEDRIVE_FOLDER}}/g, config.ONEDRIVE_FOLDER)
    .replace(/{{OBJECTIVE_OVERRIDE}}/g, "In this single run, process every matching email received in the active scan window, keep a folder with AGENTS.md and CLAUDE.md per case, and return a single inline summary.");

// Inject Products
const productsYamlList = config.PRODUCTS.map(p => `        - "${p}"`).join('\n');
template = template.replace(/{{PRODUCTS_YAML_LIST}}/g, productsYamlList);

// Inject Tracking Scope
const scopeRules = config.SCOPE === 'ASSIGNED_ONLY' 
    ? "  - an email matches ONLY if the 'Owner' field matches your name or you are in the TO/CC lines.\n" 
    : "  - an email matches a pattern ONLY if BOTH its subject_regex AND its body_signal match; if either side fails, the pattern does not match.";
template = template.replace(/{{TRACKING_SCOPE_RULES}}/g, "regex_rules:\n" + scopeRules);

// Inject Obfuscation Rules
const obfRule = config.OBFUSCATE_DATA 
    ? "  - OBFUSCATION REQUIRED: Before writing ANY case description or activity log, aggressively replace sensitive PII (external names, email addresses, phone numbers, IP addresses, internal server names) with generic placeholders (e.g. [NAME], [EMAIL], [IP], [SERVER])."
    : "";
template = template.replace(/{{OBFUSCATION_RULES}}/g, obfRule);

const obfWarning = config.OBFUSCATE_DATA
    ? "  - NOTE: Sensitive client data (PII, server names, emails, IPs) in this case log has been intentionally obfuscated with generic placeholders to comply with security policies. Do not be confused by missing real names."
    : "";
template = template.replace(/{{OBFUSCATION_WARNING}}/g, obfWarning);

(async () => {
    try {
        await runCopilot(template, logPath);
        parsePayload(logPath, config.ONEDRIVE_FOLDER);
        console.log("\nBatch sync complete!");
    } catch (e) {
        console.error(e);
    }
})();
