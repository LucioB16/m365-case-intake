const fs = require('fs');
const path = require('path');
const { runCopilot } = require('./lib/playwright_runner');
const { parsePayload } = require('./lib/parser');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: npm run fetch <CASE_ID> "<TIME_WINDOW>"');
    console.error('Example: npm run fetch CAS-1455051-S3F0 "last 30 days"');
    process.exit(1);
}

const caseId = args[0];
const timeWindow = args[1];

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

// Inject Base Config
template = template
    .replace(/{{USER_NAME}}/g, config.USER_NAME)
    .replace(/{{USER_EMAIL}}/g, config.USER_EMAIL)
    .replace(/{{TIMEZONE}}/g, config.TIMEZONE)
    .replace(/{{LOOKBACK_HOURS}}/g, config.LOOKBACK_HOURS)
    .replace(/{{ONEDRIVE_FOLDER}}/g, config.ONEDRIVE_FOLDER)
    .replace(/{{OBJECTIVE_OVERRIDE}}/g, `In this single run, process ONLY emails related to CASE ID: ${caseId} received within the time window: ${timeWindow}.`);

const productsYamlList = config.PRODUCTS.map(p => `        - "${p}"`).join('\n');
template = template.replace(/{{PRODUCTS_YAML_LIST}}/g, productsYamlList);

template = template.replace(/{{TRACKING_SCOPE_RULES}}/g, "regex_rules:\n  - an email matches a pattern ONLY if BOTH its subject_regex AND its body_signal match; if either side fails, the pattern does not match.");

const obfRule = config.OBFUSCATE_DATA 
    ? "  - OBFUSCATION REQUIRED: Before writing ANY case description or activity log, aggressively replace sensitive PII (external names, email addresses, phone numbers, IP addresses, internal server names) with generic placeholders (e.g. [NAME], [EMAIL], [IP], [SERVER])."
    : "";
template = template.replace(/{{OBFUSCATION_RULES}}/g, obfRule);

const obfWarning = config.OBFUSCATE_DATA
    ? "  - NOTE: Sensitive client data (PII, server names, emails, IPs) in this case log has been intentionally obfuscated with generic placeholders to comply with security policies. Do not be confused by missing real names."
    : "";
template = template.replace(/{{OBFUSCATION_WARNING}}/g, obfWarning);

const overrideHeader = `
=======================================================================
>>> CRITICAL OVERRIDE FOR THIS SPECIFIC ON-DEMAND RUN <<<
=======================================================================
1. IGNORE the standard lookback parameters.
2. ONLY search for and process emails matching THIS EXACT CASE ID: ${caseId}
3. ONLY search within this specific time window: ${timeWindow}
4. Process ALL matching emails for this specific case, skipping any other cases.
5. Emit the final payload EXACTLY as defined in the rules below.
6. FORCE-ACCEPT this case REGARDLESS of the Product field. IGNORE the "product_must_contain_any" filter entirely.
=======================================================================

`.trim() + '\n\n';

(async () => {
    try {
        await runCopilot(overrideHeader + template, logPath);
        parsePayload(logPath, config.ONEDRIVE_FOLDER);
        console.log(`\nFetch complete for ${caseId}!`);
    } catch (e) {
        console.error(e);
    }
})();
