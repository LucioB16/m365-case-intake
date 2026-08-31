const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseEnvironments,
    resolveDefault,
    defaultEnvironmentFor,
    isInternalUrl,
    normalizeEnvironmentUrl
} = require('../scripts/lib/environments');
const { applyEnvironmentDefault, writePayloads } = require('../scripts/lib/parser');
const { analyzeResponse } = require('../scripts/lib/response_contract');

const WINDOW = 'Scan window: 2026-08-30 12:00 to 2026-08-31 12:00 America/Argentina/Buenos_Aires';

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'm365-env-test-'));
}

function agentsMd(envLine) {
    return [
        'Case ID: CAS-1000000-A1B2',
        'Title: Example Title',
        'Account: Contoso Ltd',
        'Reporter: Someone',
        'Created On: 2026-08-30 09:00 (local)',
        envLine,
        '',
        'Description:',
        'Something happened.',
        '',
        '---',
        'Activity log:'
    ].join('\n');
}

test('parses labelled environments and ignores prose', () => {
    const { environments } = parseEnvironments([
        '# Environments - Contoso Ltd',
        'Some free text that should be ignored.',
        'PROD: https://contoso.crm.dynamics.com',
        '- UAT: https://contoso-uat.crm.dynamics.com',
        'DEV:   https://contoso-dev.crm.dynamics.com',
        'Notes:',
        '- this line has no url'
    ].join('\n'));

    assert.deepStrictEqual(environments, [
        { label: 'PROD', url: 'https://contoso.crm.dynamics.com' },
        { label: 'UAT', url: 'https://contoso-uat.crm.dynamics.com' },
        { label: 'DEV', url: 'https://contoso-dev.crm.dynamics.com' }
    ]);
});

test('strips app ids and record ids down to the origin', () => {
    const { environments } = parseEnvironments(
        'PROD: https://contoso.crm.dynamics.com/main.aspx?appid=1234&pagetype=entityrecord&id=abcd'
    );
    assert.deepStrictEqual(environments, [{ label: 'PROD', url: 'https://contoso.crm.dynamics.com' }]);
    assert.strictEqual(normalizeEnvironmentUrl('https://x.crm.dynamics.com/main.aspx?a=1'), 'https://x.crm.dynamics.com');
});

test('internal Arbela and Argano systems are rejected', () => {
    assert.strictEqual(isInternalUrl('https://arbelatechnologies.crm.dynamics.com'), true);
    assert.strictEqual(isInternalUrl('https://arbelasupport.microsoftcrmportals.com/x'), true);
    assert.strictEqual(isInternalUrl('https://contoso.crm.dynamics.com'), false);

    const { environments } = parseEnvironments([
        'PROD: https://arbelatechnologies.crm.dynamics.com',
        'DEV: https://contoso-dev.crm.dynamics.com'
    ].join('\n'));
    assert.deepStrictEqual(environments, [{ label: 'DEV', url: 'https://contoso-dev.crm.dynamics.com' }]);
});

test('the explicit Default line wins', () => {
    const parsed = parseEnvironments([
        'PROD: https://contoso.crm.dynamics.com',
        'DEV: https://contoso-dev.crm.dynamics.com',
        'Default: DEV'
    ].join('\n'));
    assert.strictEqual(resolveDefault(parsed).label, 'DEV');
});

test('without a Default line PROD wins, then the first entry', () => {
    const withProd = parseEnvironments('DEV: https://a-dev.crm.dynamics.com\nPROD: https://a.crm.dynamics.com');
    assert.strictEqual(resolveDefault(withProd).label, 'PROD');

    const noProd = parseEnvironments('DEV: https://a-dev.crm.dynamics.com\nTEST: https://a-test.crm.dynamics.com');
    assert.strictEqual(resolveDefault(noProd).label, 'TEST', 'TEST outranks DEV');

    assert.strictEqual(resolveDefault({ environments: [], requestedDefault: '' }), null);
});

test('an unknown Default label falls back instead of failing', () => {
    const parsed = parseEnvironments('PROD: https://a.crm.dynamics.com\nDefault: STAGING');
    assert.strictEqual(resolveDefault(parsed).label, 'PROD');
});

test('defaultEnvironmentFor reads the account file', () => {
    const root = tempRoot();
    try {
        fs.mkdirSync(path.join(root, 'Contoso Ltd'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'Contoso Ltd', 'ENVIRONMENTS.md'),
            'PROD: https://contoso.crm.dynamics.com\nDEV: https://contoso-dev.crm.dynamics.com\n',
            'utf8'
        );
        const chosen = defaultEnvironmentFor(root, 'Contoso Ltd');
        assert.strictEqual(chosen.label, 'PROD');
        assert.strictEqual(chosen.url, 'https://contoso.crm.dynamics.com');
        assert.strictEqual(chosen.count, 2);

        assert.strictEqual(defaultEnvironmentFor(root, 'Account With No File'), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a blank Environment URL is filled from the account default', () => {
    const root = tempRoot();
    try {
        fs.mkdirSync(path.join(root, 'Contoso Ltd'), { recursive: true });
        fs.writeFileSync(path.join(root, 'Contoso Ltd', 'ENVIRONMENTS.md'), 'PROD: https://contoso.crm.dynamics.com\n', 'utf8');

        const result = applyEnvironmentDefault(
            agentsMd('Environment URL: '),
            root,
            'Contoso Ltd/CAS-1000000-A1B2 - Example Title/AGENTS.md'
        );

        assert.strictEqual(result.applied.label, 'PROD');
        assert.ok(result.content.includes('Environment URL: https://contoso.crm.dynamics.com (PROD account default)'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a URL that came from the email is never overwritten', () => {
    const root = tempRoot();
    try {
        fs.mkdirSync(path.join(root, 'Contoso Ltd'), { recursive: true });
        fs.writeFileSync(path.join(root, 'Contoso Ltd', 'ENVIRONMENTS.md'), 'PROD: https://contoso.crm.dynamics.com\n', 'utf8');

        const original = agentsMd('Environment URL: https://contoso-uat.crm.dynamics.com');
        const result = applyEnvironmentDefault(original, root, 'Contoso Ltd/CAS-1000000-A1B2 - Example Title/AGENTS.md');

        assert.strictEqual(result.applied, null);
        assert.strictEqual(result.content, original);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an account with no ENVIRONMENTS.md leaves the field blank', () => {
    const root = tempRoot();
    try {
        const original = agentsMd('Environment URL: ');
        const result = applyEnvironmentDefault(original, root, 'Contoso Ltd/CAS-1000000-A1B2 - Example Title/AGENTS.md');
        assert.strictEqual(result.applied, null);
        assert.strictEqual(result.content, original);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an ENVIRONMENTS.md listing only internal systems changes nothing', () => {
    const root = tempRoot();
    try {
        fs.mkdirSync(path.join(root, 'Contoso Ltd'), { recursive: true });
        fs.writeFileSync(path.join(root, 'Contoso Ltd', 'ENVIRONMENTS.md'), 'PROD: https://arbelatechnologies.crm.dynamics.com\n', 'utf8');

        const original = agentsMd('Environment URL: ');
        const result = applyEnvironmentDefault(original, root, 'Contoso Ltd/CAS-1000000-A1B2 - Example Title/AGENTS.md');
        assert.strictEqual(result.applied, null);
        assert.strictEqual(result.content, original);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the default is applied end to end when a new case is written', () => {
    const root = tempRoot();
    try {
        fs.mkdirSync(path.join(root, 'Contoso Ltd'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'Contoso Ltd', 'ENVIRONMENTS.md'),
            'PROD: https://contoso.crm.dynamics.com\nDEV: https://contoso-dev.crm.dynamics.com\nDefault: DEV\n',
            'utf8'
        );

        const rel = 'Contoso Ltd/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const raw = [WINDOW, rel, '```markdown', agentsMd('Environment URL: '), '```'].join('\n');
        const report = writePayloads(analyzeResponse(raw), root, { root });

        assert.deepStrictEqual(report.written, [rel]);
        assert.strictEqual(report.enriched.length, 1);
        assert.strictEqual(report.enriched[0].label, 'DEV');

        const written = fs.readFileSync(path.join(root, rel), 'utf8');
        assert.ok(written.includes('Environment URL: https://contoso-dev.crm.dynamics.com (DEV account default)'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an APPEND payload is never touched by the environment default', () => {
    const root = tempRoot();
    try {
        const rel = 'Contoso Ltd/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        fs.mkdirSync(path.join(root, 'Contoso Ltd'), { recursive: true });
        fs.writeFileSync(path.join(root, 'Contoso Ltd', 'ENVIRONMENTS.md'), 'PROD: https://contoso.crm.dynamics.com\n', 'utf8');
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), agentsMd('Environment URL: ') + '\n', 'utf8');

        const raw = [WINDOW, `APPEND ${rel}`, '```markdown', '[Assigned to me] 2026-08-31 10:00 (local)', '```'].join('\n');
        const report = writePayloads(analyzeResponse(raw), root, { root });

        assert.deepStrictEqual(report.appended, [rel]);
        assert.strictEqual(report.enriched.length, 0);
        const written = fs.readFileSync(path.join(root, rel), 'utf8');
        assert.ok(written.includes('Environment URL: \n') || written.includes('Environment URL:\n'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
