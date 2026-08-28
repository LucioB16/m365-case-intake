const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyzeResponse } = require('../scripts/lib/response_contract');
const {
    writePayloads,
    stripRootPrefix,
    findDroppedLines,
    findDuplicateActivityBlocks,
    mergeIndex,
    updateIndex,
    scanWindowEnd,
    resolveExistingSegments
} = require('../scripts/lib/parser');

const WINDOW = 'Scan window: 2026-08-27 12:00 to 2026-08-28 12:00 America/Argentina/Buenos_Aires';

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'm365-intake-test-'));
}

function payloadResponse(entries) {
    const parts = [WINDOW];
    for (const [p, body, lang] of entries) {
        parts.push(p, '```' + (lang || 'markdown'), body, '```');
    }
    return parts.join('\n');
}

function baseAgents(activity = []) {
    return [
        'Case ID: CAS-1000000-A1B2',
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
        'Activity log:',
        ...activity
    ].join('\n');
}

test('payloads are written under the configured root', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const result = analyzeResponse(payloadResponse([[rel, baseAgents()]]));
        const report = writePayloads(result, root, { root });

        assert.deepStrictEqual(report.written, [rel]);
        assert.strictEqual(report.blocking.length, 0);
        const written = fs.readFileSync(path.join(root, rel), 'utf8');
        assert.ok(written.startsWith('Case ID: CAS-1000000-A1B2'));
        assert.ok(written.endsWith('\n'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an appended activity block preserves all previous content', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const existing = baseAgents(['', '[Portal Comment] 2026-08-27 10:00 (local) - Someone', 'First comment.']);
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), existing + '\n', 'utf8');

        const updated = existing + '\n\n[Portal Comment] 2026-08-28 11:00 (local) - Someone Else\nSecond comment.';
        const result = analyzeResponse(payloadResponse([[rel, updated]]));
        const report = writePayloads(result, root, { root });

        assert.deepStrictEqual(report.written, [rel]);
        const written = fs.readFileSync(path.join(root, rel), 'utf8');
        assert.ok(written.includes('First comment.'), 'earlier entry must survive');
        assert.ok(written.includes('Second comment.'), 'new entry must be added');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a payload that would drop existing lines is refused, not written', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const existing = baseAgents(['', '[Portal Comment] 2026-08-27 10:00 (local) - Someone', 'Important history.']);
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), existing + '\n', 'utf8');

        const shortened = baseAgents(['', '[Portal Comment] 2026-08-28 11:00 (local) - Someone Else', 'Only the new one.']);
        const result = analyzeResponse(payloadResponse([[rel, shortened]]));
        const report = writePayloads(result, root, { root });

        assert.strictEqual(report.written.length, 0);
        assert.strictEqual(report.blocking.length, 1);
        assert.strictEqual(report.blocking[0].reason, 'CONTENT_LOSS');
        assert.strictEqual(fs.readFileSync(path.join(root, rel), 'utf8'), existing + '\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('re-writing an identical payload is idempotent and reported as unchanged', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md';
        const body = 'Please read AGENTS.md for the complete case context and instructions.';
        const result = analyzeResponse(payloadResponse([[rel, body]]));

        const first = writePayloads(result, root, { root });
        assert.deepStrictEqual(first.written, [rel]);

        const second = writePayloads(analyzeResponse(payloadResponse([[rel, body]])), root, { root });
        assert.deepStrictEqual(second.written, []);
        assert.deepStrictEqual(second.unchanged, [rel]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a payload repeating the same activity block twice is refused', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const block = '[Portal Comment] 2026-08-28 11:00 (local) - Someone\nSame text.';
        const body = baseAgents(['', block, '', block]);
        const result = analyzeResponse(payloadResponse([[rel, body]]));
        const report = writePayloads(result, root, { root });

        assert.strictEqual(report.written.length, 0);
        assert.strictEqual(report.blocking[0].reason, 'DUPLICATE_ACTIVITY_BLOCK');
        assert.strictEqual(fs.existsSync(path.join(root, rel)), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an emitted index payload never reaches the index file', () => {
    const root = tempRoot();
    try {
        const existing = {
            last_run_local: '2026-08-27 12:00',
            cases: {
                'CAS-0000001-OLD1': { account: 'Old Account', filename: 'CAS-0000001-OLD1 - Old/AGENTS.md', title: 'Old' }
            }
        };
        fs.writeFileSync(path.join(root, '.intake_index.json'), JSON.stringify(existing, null, 2) + '\n', 'utf8');

        const incoming = { last_run_local: '2026-08-28 12:00', cases: {} };
        const result = analyzeResponse(payloadResponse([['.intake_index.json', JSON.stringify(incoming, null, 2), 'json']]));
        const report = writePayloads(result, root, { root });

        assert.deepStrictEqual(report.written, []);
        const untouched = JSON.parse(fs.readFileSync(path.join(root, '.intake_index.json'), 'utf8'));
        assert.ok(untouched.cases['CAS-0000001-OLD1'], 'previous case must be preserved');
        assert.strictEqual(untouched.last_run_local, '2026-08-27 12:00');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the local index is rebuilt from the files actually written', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const result = analyzeResponse(payloadResponse([[rel, baseAgents()]]));
        writePayloads(result, root, { root });

        const first = updateIndex(root, [rel], '2026-08-28 12:00');
        assert.deepStrictEqual(first.updated, ['CAS-1000000-A1B2']);

        const index = JSON.parse(fs.readFileSync(path.join(root, '.intake_index.json'), 'utf8'));
        assert.strictEqual(index.last_run_local, '2026-08-28 12:00');
        assert.deepStrictEqual(index.cases['CAS-1000000-A1B2'], {
            account: 'Example Account',
            filename: 'CAS-1000000-A1B2 - Example Title/AGENTS.md',
            title: 'Example Title',
            first_seen_local: '2026-08-28 12:00',
            last_updated_local: '2026-08-28 12:00'
        });

        // A later run keeps first_seen_local and never removes older cases.
        updateIndex(root, [rel], '2026-08-29 12:00');
        const second = JSON.parse(fs.readFileSync(path.join(root, '.intake_index.json'), 'utf8'));
        assert.strictEqual(second.cases['CAS-1000000-A1B2'].first_seen_local, '2026-08-28 12:00');
        assert.strictEqual(second.cases['CAS-1000000-A1B2'].last_updated_local, '2026-08-29 12:00');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the local index never drops entries written by previous runs', () => {
    const root = tempRoot();
    try {
        updateIndex(root, ['Acme/CAS-0000001-OLD1 - Old Case/AGENTS.md'], '2026-08-27 12:00');
        updateIndex(root, ['Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md'], '2026-08-28 12:00');
        const index = JSON.parse(fs.readFileSync(path.join(root, '.intake_index.json'), 'utf8'));
        assert.deepStrictEqual(Object.keys(index.cases).sort(), ['CAS-0000001-OLD1', 'CAS-1000000-A1B2']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a corrupt existing index is left untouched and reported', () => {
    const root = tempRoot();
    try {
        fs.writeFileSync(path.join(root, '.intake_index.json'), '{ not json', 'utf8');
        const res = updateIndex(root, ['Acme/CAS-0000001-OLD1 - Old Case/AGENTS.md'], '2026-08-28 12:00');
        assert.ok(res.error);
        assert.strictEqual(fs.readFileSync(path.join(root, '.intake_index.json'), 'utf8'), '{ not json');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanWindowEnd extracts the end of the scan window line', () => {
    assert.strictEqual(
        scanWindowEnd('Scan window: 2026-08-27 13:52 to 2026-08-28 14:00 America/Argentina/Buenos_Aires'),
        '2026-08-28 14:00'
    );
    assert.match(scanWindowEnd(null), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('an emitted .intake_index.json payload is ignored, not written', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const raw = [
            WINDOW,
            rel, '```markdown', baseAgents(), '```',
            '.intake_index.json', '```json', '{"last_run_local":"2026-08-28 12:00","cases":{}}', '```'
        ].join('\n');

        const result = analyzeResponse(raw);
        assert.strictEqual(result.status, 'CHANGES');
        assert.ok(result.warnings.some((w) => w.code === 'INDEX_PAYLOAD_IGNORED'));
        assert.deepStrictEqual(result.writablePayloads.map((p) => p.path), [rel]);

        const report = writePayloads(result, root, { root });
        assert.deepStrictEqual(report.written, [rel]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an APPEND payload adds the block and keeps every existing line', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const existing = baseAgents(['', '[Portal Comment] 2026-08-27 10:00 (local) - Someone', 'First comment.']);
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), existing + '\n', 'utf8');

        const block = '[Portal Comment] 2026-08-28 11:00 (local) - Someone Else\nSecond comment.';
        const result = analyzeResponse([WINDOW, `APPEND ${rel}`, '```markdown', block, '```'].join('\n'));
        assert.strictEqual(result.status, 'CHANGES');
        assert.strictEqual(result.writablePayloads[0].mode, 'append');

        const report = writePayloads(result, root, { root });
        assert.deepStrictEqual(report.appended, [rel]);
        assert.deepStrictEqual(report.written, []);

        const written = fs.readFileSync(path.join(root, rel), 'utf8');
        assert.ok(written.includes('First comment.'), 'earlier entry must survive');
        assert.ok(written.includes('Second comment.'), 'new entry must be added');
        assert.ok(written.startsWith('Case ID: CAS-1000000-A1B2'), 'header must survive');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('appending the same block twice is idempotent', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), baseAgents() + '\n', 'utf8');

        const block = '[Assigned to me] 2026-08-28 11:00 (local)';
        const raw = [WINDOW, `APPEND ${rel}`, '```markdown', block, '```'].join('\n');

        const first = writePayloads(analyzeResponse(raw), root, { root });
        assert.deepStrictEqual(first.appended, [rel]);
        const afterFirst = fs.readFileSync(path.join(root, rel), 'utf8');

        const second = writePayloads(analyzeResponse(raw), root, { root });
        assert.deepStrictEqual(second.appended, []);
        assert.deepStrictEqual(second.unchanged, [rel]);
        assert.strictEqual(fs.readFileSync(path.join(root, rel), 'utf8'), afterFirst);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an APPEND to a file that does not exist is refused, not silently created', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const raw = [WINDOW, `APPEND ${rel}`, '```markdown', '[Assigned to me] 2026-08-28 11:00 (local)', '```'].join('\n');
        const report = writePayloads(analyzeResponse(raw), root, { root });

        assert.deepStrictEqual(report.appended, []);
        assert.strictEqual(report.blocking[0].reason, 'APPEND_TARGET_MISSING');
        assert.strictEqual(fs.existsSync(path.join(root, rel)), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an APPEND block re-sending a known entry only adds the new one', () => {
    const root = tempRoot();
    try {
        const rel = 'Example Account/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        const known = '[Portal Comment] 2026-08-27 15:48 (local) - Someone\nAlready recorded.';
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), baseAgents(['', known]) + '\n', 'utf8');

        const fresh = '[Portal Comment] 2026-08-28 14:27 (local) - Someone Else\nBrand new.';
        const raw = [WINDOW, `APPEND ${rel}`, '```markdown', `${known}\n\n${fresh}`, '```'].join('\n');
        const report = writePayloads(analyzeResponse(raw), root, { root });

        assert.deepStrictEqual(report.appended, [rel]);
        assert.ok(report.skipped.some((s) => s.reason === 'DUPLICATE_ENTRIES_SKIPPED' && s.nonFatal));

        const written = fs.readFileSync(path.join(root, rel), 'utf8');
        const occurrences = written.split('[Portal Comment] 2026-08-27 15:48 (local) - Someone').length - 1;
        assert.strictEqual(occurrences, 1, 'the known entry must not be duplicated');
        assert.ok(written.includes('Brand new.'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('folder names are matched to what exists on disk, not duplicated', () => {
    const root = tempRoot();
    try {
        const realRel = 'McWane, Inc/CAS-1000000-A1B2 - Example Title/AGENTS.md';
        fs.mkdirSync(path.dirname(path.join(root, realRel)), { recursive: true });
        fs.writeFileSync(path.join(root, realRel), baseAgents() + '\n', 'utf8');

        // Copilot wrote "McWane, Inc." with a trailing dot; Node does not normalise that.
        const emitted = 'McWane, Inc./CAS-1000000-A1B2 - Example Title/AGENTS.md';
        assert.strictEqual(resolveExistingSegments(root, emitted), realRel);

        const raw = [WINDOW, `APPEND ${emitted}`, '```markdown', '[Assigned to me] 2026-08-28 11:00 (local)', '```'].join('\n');
        const report = writePayloads(analyzeResponse(raw), root, { root });

        assert.deepStrictEqual(report.appended, [realRel]);
        assert.deepStrictEqual(fs.readdirSync(root), ['McWane, Inc'], 'no duplicate account folder');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('paths escaping the root are refused', () => {
    const root = tempRoot();
    try {
        const result = analyzeResponse(payloadResponse([['../escaped/AGENTS.md', 'Case ID: CAS-1000000-A1B2']]));
        const report = writePayloads(result, root, { root });
        assert.strictEqual(report.written.length, 0);
        assert.strictEqual(report.blocking[0].reason, 'UNSAFE_PATH');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an accidental root-folder prefix does not create a nested folder', () => {
    const root = tempRoot();
    const rootName = path.basename(root);
    try {
        const rel = `${rootName}/Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md`;
        const result = analyzeResponse(payloadResponse([[rel, 'Please read AGENTS.md for the complete case context and instructions.']]));
        const report = writePayloads(result, root, { root });

        assert.deepStrictEqual(report.written, ['Example Account/CAS-1000000-A1B2 - Example Title/CLAUDE.md']);
        assert.strictEqual(fs.existsSync(path.join(root, rootName)), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('stripRootPrefix handles the absolute-path config form', () => {
    const config = 'C:/Users/Someone/OneDrive - Corp/Client Cases';
    const abs = 'C:\\Users\\Someone\\OneDrive - Corp\\Client Cases';
    assert.strictEqual(stripRootPrefix('Client Cases/Acme/CAS-1 - T/AGENTS.md', config, abs), 'Acme/CAS-1 - T/AGENTS.md');
    assert.strictEqual(stripRootPrefix('Acme/CAS-1 - T/AGENTS.md', config, abs), 'Acme/CAS-1 - T/AGENTS.md');
    assert.strictEqual(stripRootPrefix('.intake_index.json', config, abs), '.intake_index.json');
});

test('helper predicates behave as documented', () => {
    assert.deepStrictEqual(findDroppedLines('a\nb\n', 'a\nb\nc\n'), []);
    assert.deepStrictEqual(findDroppedLines('a\nb\n', 'a\nc\n'), ['b']);

    assert.deepStrictEqual(findDuplicateActivityBlocks('header\n[Assigned to me] 2026-08-28 11:00 (local)\n'), []);
    assert.deepStrictEqual(
        findDuplicateActivityBlocks('header\n[Assigned to me] 2026-08-28 11:00 (local)\n[Assigned to me] 2026-08-28 11:00 (local)\n'),
        ['[Assigned to me] 2026-08-28 11:00 (local)']
    );

    const merged = mergeIndex('{"cases":{"A":{"x":1}}}', '{"cases":{"B":{"y":2}}}');
    assert.deepStrictEqual(merged.restored, ['A']);
    assert.deepStrictEqual(JSON.parse(merged.content).cases, { B: { y: 2 }, A: { x: 1 } });
});

test('an INVALID response yields nothing writable, so nothing reaches the disk', () => {
    const root = tempRoot();
    try {
        const result = analyzeResponse('I found 2 cases but I cannot create files in your OneDrive folder.');
        assert.strictEqual(result.status, 'INVALID');
        const report = writePayloads(result, root, { root });
        assert.strictEqual(report.written.length, 0);
        assert.deepStrictEqual(fs.readdirSync(root), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
