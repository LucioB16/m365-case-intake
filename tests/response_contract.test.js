const test = require('node:test');
const assert = require('node:assert');
const { analyzeResponse } = require('../scripts/lib/response_contract');

const WINDOW = 'Scan window: 2026-08-27 12:00 to 2026-08-28 12:00 America/Argentina/Buenos_Aires';

function agentsMd(caseId) {
    return [
        `Case ID: ${caseId}`,
        'Title: Example Title',
        'Account: Example Account',
        'Reporter: Example Reporter',
        'Created On: 2026-08-27 09:00 (local)',
        'Environment URL:',
        '',
        'Description:',
        'Something happened.',
        '',
        '---',
        'Activity log:'
    ].join('\n');
}

test('valid response with a single payload is CHANGES', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        agentsMd('CAS-1000000-A1B2'),
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.payloads.length, 1);
    assert.strictEqual(r.payloads[0].path, 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md');
    assert.strictEqual(r.payloads[0].content, agentsMd('CAS-1000000-A1B2'));
    assert.strictEqual(r.scanWindow, WINDOW);
});

test('valid response with several payloads', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        agentsMd('CAS-1000000-A1B2'),
        '```',
        'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md',
        '```markdown',
        'Please read AGENTS.md for the complete case context and instructions.',
        '```',
        'Other Account/CAS-1000001-C3D4 - Second Title/CLAUDE.md',
        '```markdown',
        'Please read AGENTS.md for the complete case context and instructions.',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.strictEqual(r.payloads.length, 3);
    assert.deepStrictEqual(r.writablePayloads.map((p) => p.path), [
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md',
        'Other Account/CAS-1000001-C3D4 - Second Title/CLAUDE.md'
    ]);
});

test('deterministic no-changes output is accepted and writes nothing', () => {
    const r = analyzeResponse(`${WINDOW}\nNO CHANGES`);
    assert.strictEqual(r.status, 'NO_CHANGES');
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.writablePayloads.length, 0);
});

test('prose that lists cases but emits no payload is INVALID', () => {
    const raw = [
        'I found 3 new cases in your inbox over the last 24 hours:',
        '',
        '1. CAS-1000000-A1B2 - Example Title (Example Account)',
        '2. CAS-1000001-C3D4 - Another Title (Other Account)',
        '3. CAS-1000002-E5F6 - Third Title (Third Account)',
        '',
        'However, I cannot create local files or write to your OneDrive folder,',
        'and I cannot maintain state between sessions.'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'CAPABILITY_REFUSAL'), 'refusal must be detected');
    assert.ok(r.errors.some((e) => e.code === 'NO_PAYLOAD_NO_MARKER'), 'missing payloads must be detected');
    assert.strictEqual(r.writablePayloads.length, 0);
});

test('an empty or unavailable response is INVALID, never NO_CHANGES', () => {
    const r = analyzeResponse('   \n\n');
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'EMPTY_RESPONSE'));
});

test('truncated payload content is rejected', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        'Case ID: CAS-1000000-A1B2',
        'Title: Example Title',
        '...',
        'Activity log:',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'TRUNCATED_PAYLOAD'));
    assert.strictEqual(r.writablePayloads.length, 0);
});

test('elision phrases such as [rest of file unchanged] are rejected', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        'Case ID: CAS-1000000-A1B2',
        '[rest of file unchanged]',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'TRUNCATED_PAYLOAD'));
});

test('invented filler values are rejected', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        'Case ID: CAS-1000000-A1B2',
        'Created On: [needs verification]',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'INVENTED_PLACEHOLDER'));
    assert.strictEqual(r.writablePayloads.length, 0);
});

test('a note to the reader inside a payload is rejected', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        'Case ID: CAS-1000000-A1B2',
        'Activity log:',
        '(Note: prior activity from earlier runs not reconstructed in this emission.)',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'META_NOTE_IN_PAYLOAD'));
});

test('unresolved template slots are rejected', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        'Case ID: <case_id>',
        'Title: Example Title',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'UNRESOLVED_PLACEHOLDER'));
});

test('an emitted index payload is ignored instead of breaking the run', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        agentsMd('CAS-1000000-A1B2'),
        '```',
        '.intake_index.json',
        '```json',
        '{ "last_run_local": "2026-08-28 12:00", cases: }',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.ok(r.warnings.some((w) => w.code === 'INDEX_PAYLOAD_IGNORED'));
    assert.ok(!r.errors.some((e) => e.code === 'INVALID_JSON_PAYLOAD'));
    assert.deepStrictEqual(r.writablePayloads.map((p) => p.path), ['Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md']);
});

test('a declared NO CHANGES together with payloads is contradictory', () => {
    const raw = [
        WINDOW,
        'NO CHANGES',
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        agentsMd('CAS-1000000-A1B2'),
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'CONTRADICTORY_RESPONSE'));
});

test('an unclosed fence is reported instead of writing a half file', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md',
        '```markdown',
        'Case ID: CAS-1000000-A1B2'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'UNCLOSED_FENCE'));
    assert.strictEqual(r.writablePayloads.length, 0);
});

test('a fenced block with no path line in front of it is an error', () => {
    const raw = [
        WINDOW,
        '```markdown',
        'Case ID: CAS-1000000-A1B2',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'ORPHAN_FENCE'));
});

test('the same path emitted twice with different content is refused', () => {
    const p = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
    const raw = [
        WINDOW,
        p, '```markdown', agentsMd('CAS-1000000-A1B2'), '```',
        p, '```markdown', agentsMd('CAS-1000000-A1B2') + '\n\n[Assigned to me] 2026-08-28 11:00 (local)', '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'INVALID');
    assert.ok(r.errors.some((e) => e.code === 'CONFLICTING_PAYLOAD'));
});

test('the same path emitted twice with identical content is de-duplicated', () => {
    const p = 'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md';
    const body = 'Please read AGENTS.md for the complete case context and instructions.';
    const raw = [WINDOW, p, '```markdown', body, '```', p, '```markdown', body, '```'].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.strictEqual(r.payloads.length, 2);
    assert.strictEqual(r.writablePayloads.length, 1);
    assert.ok(r.warnings.some((w) => w.code === 'DUPLICATE_PAYLOAD'));
});

test('tilde fences and decorated path lines are tolerated but reported', () => {
    const raw = [
        WINDOW,
        '**Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md**',
        '~~~markdown',
        'Please read AGENTS.md for the complete case context and instructions.',
        '~~~'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.strictEqual(r.payloads[0].path, 'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md');
    assert.ok(r.warnings.some((w) => w.code === 'DECORATED_PATH'));
    assert.ok(r.warnings.some((w) => w.code === 'NON_BACKTICK_FENCE'));
});

test('CRLF responses parse identically to LF responses', () => {
    const body = 'Please read AGENTS.md for the complete case context and instructions.';
    const lf = [WINDOW, 'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md', '```markdown', body, '```'].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = analyzeResponse(lf);
    const b = analyzeResponse(crlf);
    assert.strictEqual(b.status, 'CHANGES');
    assert.strictEqual(b.payloads[0].content, a.payloads[0].content);
});

test('narrative text after valid payloads is a warning, not a silent pass', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md',
        '```markdown',
        'Please read AGENTS.md for the complete case context and instructions.',
        '```',
        'I processed 1 case and updated the index.'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.ok(r.warnings.some((w) => w.code === 'NARRATIVE_TEXT'));
});

test('UNREADABLE lines are captured and do not count as narrative', () => {
    const raw = [
        WINDOW,
        'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md',
        '```markdown',
        'Please read AGENTS.md for the complete case context and instructions.',
        '```',
        'UNREADABLE: Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.deepStrictEqual(r.unreadable, ['Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md']);
    assert.ok(!r.warnings.some((w) => w.code === 'NARRATIVE_TEXT'));
});

test('a missing scan window line is reported but does not discard good payloads', () => {
    const raw = [
        'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md',
        '```markdown',
        'Please read AGENTS.md for the complete case context and instructions.',
        '```'
    ].join('\n');

    const r = analyzeResponse(raw);
    assert.strictEqual(r.status, 'CHANGES');
    assert.ok(r.warnings.some((w) => w.code === 'MISSING_SCAN_WINDOW'));
    assert.strictEqual(r.writablePayloads.length, 1);
});
