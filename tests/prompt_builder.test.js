const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildPrompt, rootFolderName } = require('../scripts/lib/prompt_builder');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'base_intake.yaml'), 'utf8');

const CONFIG = {
    USER_NAME: 'Test User',
    USER_EMAIL: 'test.user@example.com',
    ONEDRIVE_FOLDER: 'C:/Users/TestUser/OneDrive - Example Corp/Client Cases',
    TIMEZONE: 'America/Argentina/Buenos_Aires',
    PRODUCTS: ['CRM', 'Power Platform'],
    LOOKBACK_HOURS: 24,
    SCOPE: 'ALL',
    OBFUSCATE_DATA: false
};

const OBJECTIVE = 'In this single run, scan the mailbox for the active scan window.';

function render(overrides = {}) {
    return buildPrompt({ template: TEMPLATE, config: { ...CONFIG, ...overrides }, objective: OBJECTIVE });
}

test('the template only uses placeholders the builder knows how to resolve', () => {
    const declared = [...new Set(TEMPLATE.match(/{{[A-Z0-9_]+}}/g) || [])].sort();
    const supported = [
        '{{LOOKBACK_HOURS}}',
        '{{OBFUSCATION_RULES}}',
        '{{OBFUSCATION_WARNING}}',
        '{{OBJECTIVE_OVERRIDE}}',
        '{{PRODUCTS_YAML_LIST}}',
        '{{ROOT_FOLDER_NAME}}',
        '{{TIMEZONE}}',
        '{{TRACKING_SCOPE_RULES}}',
        '{{USER_EMAIL}}',
        '{{USER_NAME}}'
    ];
    assert.deepStrictEqual(declared.filter((d) => !supported.includes(d)), []);
    assert.deepStrictEqual(supported.filter((s) => !declared.includes(s)), []);
});

test('rendering leaves no unresolved placeholder', () => {
    const prompt = render();
    assert.strictEqual(prompt.match(/{{[A-Z0-9_]+}}/g), null);
});

test('every configured value reaches the rendered prompt', () => {
    const prompt = render();
    assert.ok(prompt.includes('owner_name: "Test User"'));
    assert.ok(prompt.includes('owner_email: "test.user@example.com"'));
    assert.ok(prompt.includes('timezone: "America/Argentina/Buenos_Aires"'));
    assert.ok(prompt.includes('lookback_hours: 24'));
    assert.ok(prompt.includes('root_folder_name: "Client Cases"'));
    assert.ok(prompt.includes(OBJECTIVE));
    assert.ok(prompt.includes('        - "CRM"'));
    assert.ok(prompt.includes('        - "Power Platform"'));
});

test('the local absolute OneDrive path never leaks into the prompt', () => {
    const prompt = render();
    assert.ok(!prompt.includes(CONFIG.ONEDRIVE_FOLDER), 'absolute path must not be sent to M365');
    assert.ok(!/[A-Za-z]:\//.test(prompt), 'no drive letter anywhere in the prompt');
    assert.ok(prompt.includes('"Client Cases"'));
});

test('a template that still carries an absolute path is rejected', () => {
    const poisoned = TEMPLATE + '\nstorage_root: "C:/Users/TestUser/OneDrive - Example Corp/Client Cases"\n';
    assert.throws(
        () => buildPrompt({ template: poisoned, config: CONFIG, objective: OBJECTIVE }),
        /local absolute filesystem path/
    );
});

test('a template with an unknown placeholder is rejected instead of being sent', () => {
    assert.throws(
        () => buildPrompt({ template: TEMPLATE + '\nextra: {{UNKNOWN_TOKEN}}\n', config: CONFIG, objective: OBJECTIVE }),
        /unresolved placeholders: {{UNKNOWN_TOKEN}}/
    );
});

test('the output contract survives rendering intact', () => {
    const prompt = render();
    assert.ok(prompt.includes('SHAPE A'));
    assert.ok(prompt.includes('SHAPE B'));
    assert.ok(prompt.includes('NO CHANGES'));
    assert.ok(prompt.includes('Scan window: <from yyyy-mm-dd HH:mm> to <to yyyy-mm-dd HH:mm> America/Argentina/Buenos_Aires'));
    assert.ok(prompt.includes('You are a read-only analyst and a text generator.'));
    assert.ok(prompt.includes('are FORBIDDEN and make'));
    assert.ok(!/create_account_folder_if_missing/.test(prompt), 'no filesystem-write framing may remain');
    assert.ok(!/storage_root/.test(prompt), 'no filesystem-write framing may remain');
});

test('obfuscation rules are injected only when enabled', () => {
    const off = render({ OBFUSCATE_DATA: false });
    assert.ok(!off.includes('OBFUSCATION REQUIRED'));
    assert.ok(!off.includes('has been intentionally obfuscated'));

    const on = render({ OBFUSCATE_DATA: true });
    assert.ok(on.includes('OBFUSCATION REQUIRED'));
    assert.ok(on.includes('has been intentionally obfuscated'));
    assert.ok(on.includes('  - OBFUSCATION REQUIRED'), 'must keep the guardrails list indentation');
});

test('scope rules switch with the SCOPE setting', () => {
    assert.ok(render({ SCOPE: 'ALL' }).includes('BOTH its subject_regex AND its body_signal'));
    assert.ok(render({ SCOPE: 'ASSIGNED_ONLY' }).includes("the 'Owner' field matches your name"));
});

test('an on-demand prefix is prepended without disturbing the contract', () => {
    const prefix = '>>> OVERRIDE <<<\n\n';
    const prompt = buildPrompt({ template: TEMPLATE, config: CONFIG, objective: OBJECTIVE, prefix });
    assert.ok(prompt.startsWith(prefix));
    assert.ok(prompt.includes('SHAPE A'));
});

test('incomplete configuration fails loudly', () => {
    assert.throws(() => buildPrompt({ template: TEMPLATE, config: { ...CONFIG, USER_EMAIL: '' }, objective: OBJECTIVE }), /missing required keys: USER_EMAIL/);
    assert.throws(() => buildPrompt({ template: TEMPLATE, config: { ...CONFIG, PRODUCTS: [] }, objective: OBJECTIVE }), /PRODUCTS must be a non-empty array/);
    assert.throws(() => buildPrompt({ template: TEMPLATE, config: CONFIG, objective: '  ' }), /non-empty objective/);
});

test('rootFolderName reduces any config form to the folder name', () => {
    assert.strictEqual(rootFolderName('C:/Users/A/OneDrive - Corp/Client Cases'), 'Client Cases');
    assert.strictEqual(rootFolderName('C:\\Users\\A\\OneDrive - Corp\\Client Cases\\'), 'Client Cases');
    assert.strictEqual(rootFolderName('Client Cases'), 'Client Cases');
});
