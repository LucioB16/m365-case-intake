const fs = require('fs');
const path = require('path');

const OBFUSCATION_RULE = "  - OBFUSCATION REQUIRED: Before writing ANY case description or activity log, aggressively replace sensitive PII (external names, email addresses, phone numbers, IP addresses, internal server names) with generic placeholders (e.g. [NAME], [EMAIL], [IP], [SERVER]).";
const OBFUSCATION_WARNING = "  - NOTE: Sensitive client data (PII, server names, emails, IPs) in this case log has been intentionally obfuscated with generic placeholders to comply with security policies. Do not be confused by missing real names.";

const SCOPE_RULE_ASSIGNED_ONLY = "  - an email matches ONLY if the 'Owner' field matches your name or you are in the TO/CC lines.";
const SCOPE_RULE_ALL = "  - an email matches a pattern ONLY if BOTH its subject_regex AND its body_signal match; if either side fails, the pattern does not match.";

const REQUIRED_CONFIG_KEYS = ['USER_NAME', 'USER_EMAIL', 'TIMEZONE', 'LOOKBACK_HOURS', 'ONEDRIVE_FOLDER', 'PRODUCTS'];

/**
 * The prompt must never contain the local absolute path of the OneDrive folder.
 * M365 Copilot has no access to the user's disk, and showing it one is the main
 * reason it used to answer "I cannot write to your local drive".
 */
function rootFolderName(onedriveFolderConfig) {
    const normalized = String(onedriveFolderConfig).replace(/\\/g, '/').replace(/\/+$/, '');
    const name = normalized.split('/').filter(Boolean).pop();
    if (!name) {
        throw new Error(`Cannot derive a root folder name from ONEDRIVE_FOLDER="${onedriveFolderConfig}"`);
    }
    return name;
}

function assertConfig(config) {
    const missing = REQUIRED_CONFIG_KEYS.filter((k) => config[k] === undefined || config[k] === null || config[k] === '');
    if (missing.length > 0) {
        throw new Error(`config.json is missing required keys: ${missing.join(', ')}`);
    }
    if (!Array.isArray(config.PRODUCTS) || config.PRODUCTS.length === 0) {
        throw new Error('config.json PRODUCTS must be a non-empty array.');
    }
}

/**
 * Renders prompts/base_intake.yaml into the exact text that is sent to M365 Copilot.
 *
 * @param {object} opts
 * @param {string} opts.template      Raw template text.
 * @param {object} opts.config        Parsed config.json.
 * @param {string} opts.objective     Value for {{OBJECTIVE_OVERRIDE}}.
 * @param {string} [opts.prefix]      Text prepended to the rendered prompt.
 * @returns {string}
 */
function buildPrompt({ template, config, objective, prefix = '' }) {
    assertConfig(config);
    if (!objective || !String(objective).trim()) {
        throw new Error('buildPrompt requires a non-empty objective.');
    }

    const productsYamlList = config.PRODUCTS.map((p) => `        - "${p}"`).join('\n');
    const scopeRule = config.SCOPE === 'ASSIGNED_ONLY' ? SCOPE_RULE_ASSIGNED_ONLY : SCOPE_RULE_ALL;

    const replacements = {
        USER_NAME: config.USER_NAME,
        USER_EMAIL: config.USER_EMAIL,
        TIMEZONE: config.TIMEZONE,
        LOOKBACK_HOURS: String(config.LOOKBACK_HOURS),
        ROOT_FOLDER_NAME: rootFolderName(config.ONEDRIVE_FOLDER),
        OBJECTIVE_OVERRIDE: objective,
        PRODUCTS_YAML_LIST: productsYamlList,
        TRACKING_SCOPE_RULES: `regex_rules:\n${scopeRule}`,
        OBFUSCATION_RULES: config.OBFUSCATE_DATA ? OBFUSCATION_RULE : '',
        OBFUSCATION_WARNING: config.OBFUSCATE_DATA ? OBFUSCATION_WARNING : ''
    };

    let rendered = template;
    for (const [key, value] of Object.entries(replacements)) {
        rendered = rendered.split(`{{${key}}}`).join(value);
    }

    // Optional shorthand placeholders keep the template user-agnostic while allowing
    // examples like "in progress with ${user}".
    const shorthand = { user: config.USER_NAME };
    for (const [key, value] of Object.entries(shorthand)) {
        rendered = rendered.split(`\${${key}}`).join(value);
        rendered = rendered.split(`{${key}}`).join(value);
    }

    // Fail loudly instead of shipping a half-rendered prompt to Copilot.
    const leftovers = [
        ...new Set(rendered.match(/{{[A-Z0-9_]+}}/g) || []),
        ...new Set(rendered.match(/\$\{[a-zA-Z0-9_]+\}/g) || [])
    ];
    if (leftovers.length > 0) {
        throw new Error(`Prompt template still contains unresolved placeholders: ${leftovers.join(', ')}`);
    }

    // A local absolute path in the prompt is what made Copilot refuse the task.
    const absolutePathLeak = rendered.match(/[A-Za-z]:[\\/]{1,2}Users[\\/]/);
    if (absolutePathLeak) {
        throw new Error('Refusing to send a prompt that contains a local absolute filesystem path.');
    }

    return prefix ? `${prefix}${rendered}` : rendered;
}

function loadConfig(rootDir) {
    const configPath = path.join(rootDir, 'config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error("config.json not found! Please run 'npm run setup' first.");
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function loadTemplate(rootDir) {
    return fs.readFileSync(path.join(rootDir, 'prompts', 'base_intake.yaml'), 'utf8');
}

function savePrompt(promptText, promptPath) {
    const dir = path.dirname(promptPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(promptPath, promptText, 'utf8');
}

module.exports = { buildPrompt, loadConfig, loadTemplate, savePrompt, rootFolderName };
