const fs = require('fs');
const path = require('path');
const os = require('os');
const { analyzeResponse, formatReport } = require('./response_contract');

const ACTIVITY_MARKER_RE = /^\[(?:Portal Comment|Assigned to me)\]/;

function resolveOneDriveRoot(onedriveFolderConfig) {
    const configured = String(onedriveFolderConfig).replace(/\\/g, '/').replace(/\/+$/, '');
    if (path.isAbsolute(configured)) return path.resolve(configured);

    const home = os.homedir();
    const candidates = [];
    try {
        for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
            if (entry.isDirectory() && /^OneDrive/i.test(entry.name)) {
                candidates.push(path.join(home, entry.name, configured));
            }
        }
    } catch (e) { /* home not enumerable; fall through to the plain candidates */ }
    candidates.push(path.join(home, 'OneDrive', configured));
    candidates.push(path.join(home, configured));
    candidates.push(path.resolve(configured));

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return path.resolve(candidate);
    }
    for (const candidate of candidates) {
        if (fs.existsSync(path.dirname(candidate))) return path.resolve(candidate);
    }
    return path.resolve(candidates[0]);
}

function stripRootPrefix(relativePath, onedriveFolderConfig, rootAbsPath) {
    let p = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const prefixes = [
        String(onedriveFolderConfig).replace(/\\/g, '/').replace(/\/+$/, ''),
        path.basename(rootAbsPath)
    ].filter(Boolean).sort((a, b) => b.length - a.length);

    for (const prefix of prefixes) {
        if (p.toLowerCase().startsWith(prefix.toLowerCase() + '/')) {
            p = p.substring(prefix.length + 1);
            break;
        }
    }
    return p.replace(/^\/+/, '');
}

const normalizeSegment = (s) => s.toLowerCase().replace(/[.\s]+$/g, '').replace(/\s+/g, ' ').trim();

/**
 * Maps each path segment onto the folder that actually exists on disk.
 * Copilot occasionally writes "McWane, Inc." where the folder is "McWane, Inc"; Node does not
 * normalise the trailing dot, so without this the run would append to nothing, or worse,
 * create a duplicate account folder.
 */
function resolveExistingSegments(rootPath, relativePath) {
    const segments = relativePath.split('/').filter(Boolean);
    let current = rootPath;
    const resolved = [];

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const candidate = path.join(current, segment);
        if (fs.existsSync(candidate)) {
            resolved.push(segment);
            current = candidate;
            continue;
        }
        let entries = [];
        try { entries = fs.readdirSync(current); } catch (e) { entries = []; }
        const target = normalizeSegment(segment);
        const match = entries.find((entry) => normalizeSegment(entry) === target);
        if (match) {
            resolved.push(match);
            current = path.join(current, match);
        } else {
            resolved.push(...segments.slice(i));
            return resolved.join('/');
        }
    }
    return resolved.join('/');
}

/** Lines present in the current file that the incoming payload would silently drop. */
function findDroppedLines(existingContent, incomingContent) {
    const incoming = new Set(incomingContent.split(/\r?\n/).map((l) => l.trim()));
    const dropped = [];
    for (const line of existingContent.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (!incoming.has(t)) dropped.push(t);
    }
    return dropped;
}

/** Splits a chunk of Activity log text into its individual entries. */
function splitActivityEntries(content) {
    const lines = content.split(/\r?\n/);
    const blocks = [];
    let current = null;
    for (const line of lines) {
        if (ACTIVITY_MARKER_RE.test(line.trim())) {
            if (current) blocks.push(current.join('\n').trim());
            current = [line];
        } else if (current) {
            current.push(line);
        }
    }
    if (current) blocks.push(current.join('\n').trim());
    return blocks.filter(Boolean);
}

/** Same activity block emitted twice inside one payload. */
function findDuplicateActivityBlocks(content) {
    const seen = new Set();
    const duplicates = new Set();
    for (const block of splitActivityEntries(content)) {
        if (seen.has(block)) duplicates.add(block.split('\n')[0]);
        seen.add(block);
    }
    return [...duplicates];
}

/** Never let a run delete case entries that a previous run recorded. */
function mergeIndex(existingRaw, incomingRaw) {
    let existing;
    let incoming;
    try {
        existing = JSON.parse(existingRaw);
        incoming = JSON.parse(incomingRaw);
    } catch (e) {
        return { content: incomingRaw, restored: [], parsed: false };
    }
    if (!existing || typeof existing !== 'object' || !existing.cases) {
        return { content: incomingRaw, restored: [], parsed: true };
    }
    if (!incoming || typeof incoming !== 'object') {
        return { content: incomingRaw, restored: [], parsed: false };
    }
    incoming.cases = incoming.cases && typeof incoming.cases === 'object' ? incoming.cases : {};

    const restored = [];
    for (const [caseId, entry] of Object.entries(existing.cases)) {
        if (!Object.prototype.hasOwnProperty.call(incoming.cases, caseId)) {
            incoming.cases[caseId] = entry;
            restored.push(caseId);
        } else if (entry && typeof entry === 'object' && incoming.cases[caseId] && typeof incoming.cases[caseId] === 'object') {
            incoming.cases[caseId] = { ...entry, ...incoming.cases[caseId] };
        }
    }
    return { content: JSON.stringify(incoming, null, 2), restored, parsed: true };
}

/**
 * Writes the validated payloads of one response to disk.
 * It never turns a contract violation or a content loss into a success.
 */
function writePayloads(result, onedriveFolderConfig, options = {}) {
    const rootPath = path.resolve(options.root || resolveOneDriveRoot(onedriveFolderConfig));
    const report = { written: [], appended: [], unchanged: [], skipped: [], root: rootPath };

    if (!options.dryRun && !fs.existsSync(rootPath)) {
        fs.mkdirSync(rootPath, { recursive: true });
    }

    for (const payload of result.writablePayloads) {
        const relativePath = resolveExistingSegments(rootPath, stripRootPrefix(payload.path, onedriveFolderConfig, rootPath));
        const destPath = path.resolve(rootPath, relativePath);

        if (destPath === rootPath || !destPath.startsWith(rootPath + path.sep)) {
            report.skipped.push({ path: payload.path, reason: 'UNSAFE_PATH', detail: 'resolves outside the configured root folder' });
            continue;
        }

        let content = payload.content.replace(/\s*$/, '') + '\n';
        const exists = fs.existsSync(destPath);
        const existingContent = exists ? fs.readFileSync(destPath, 'utf8') : null;

        // "APPEND <path>" payloads carry only the new block. The local script owns the append,
        // so Copilot never has to reproduce a file it cannot read.
        if (payload.mode === 'append') {
            const block = payload.content.trim();
            if (!exists) {
                const caseId = (relativePath.match(/CAS-[A-Za-z0-9-]+/) || [])[0];
                report.skipped.push({
                    path: relativePath,
                    reason: 'APPEND_TARGET_MISSING',
                    detail: `the case folder has never been ingested, so there is nothing to append to${caseId ? `. Run: npm run fetch "${caseId}" "last 30 days"` : ''}`
                });
                continue;
            }
            // Idempotency is checked per Activity log entry, not per payload: a run often
            // re-sends an entry that a previous run already appended, bundled with a new one.
            const normalize = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
            const entries = splitActivityEntries(block);
            const candidates = entries.length > 0 ? entries : [block];

            let merged = existingContent.replace(/\s*$/, '');
            const added = [];
            for (const entry of candidates) {
                if (normalize(merged).includes(normalize(entry))) continue;
                merged += '\n\n' + entry;
                added.push(entry.split('\n')[0]);
            }

            if (added.length === 0) {
                report.unchanged.push(relativePath);
                continue;
            }
            if (!options.dryRun) fs.writeFileSync(destPath, merged + '\n', 'utf8');
            report.appended.push(relativePath);
            if (added.length < candidates.length) {
                report.skipped.push({
                    path: relativePath,
                    reason: 'DUPLICATE_ENTRIES_SKIPPED',
                    detail: `${candidates.length - added.length} entr(ies) were already present and were not appended again`,
                    nonFatal: true
                });
            }
            continue;
        }

        if (/\.json$/i.test(relativePath) && exists) {
            const merged = mergeIndex(existingContent, content);
            content = merged.content.replace(/\s*$/, '') + '\n';
            if (merged.restored.length > 0) {
                report.skipped.push({
                    path: relativePath,
                    reason: 'RESTORED_INDEX_ENTRIES',
                    detail: `${merged.restored.length} pre-existing case entries were missing from the payload and were preserved: ${merged.restored.join(', ')}`,
                    nonFatal: true
                });
            }
        }

        if (/\.md$/i.test(relativePath)) {
            const duplicates = findDuplicateActivityBlocks(content);
            if (duplicates.length > 0) {
                report.skipped.push({
                    path: relativePath,
                    reason: 'DUPLICATE_ACTIVITY_BLOCK',
                    detail: `the payload repeats the same activity entry: ${duplicates.join(' | ')}`
                });
                continue;
            }
            if (exists) {
                const dropped = findDroppedLines(existingContent, content);
                if (dropped.length > 0) {
                    report.skipped.push({
                        path: relativePath,
                        reason: 'CONTENT_LOSS',
                        detail: `${dropped.length} existing line(s) would be lost; this file is append-only, so nothing was written`
                    });
                    continue;
                }
            }
        }

        if (exists && existingContent === content) {
            report.unchanged.push(relativePath);
            continue;
        }

        if (!options.dryRun) {
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.writeFileSync(destPath, content, 'utf8');
        }
        report.written.push(relativePath);
    }

    report.blocking = report.skipped.filter((s) => !s.nonFatal);
    return report;
}

function printWriteReport(report) {
    console.log(`\nTarget root: ${report.root}`);
    for (const p of report.written) console.log(`  [WRITE]     ${p}`);
    for (const p of report.appended) console.log(`  [APPEND]    ${p}`);
    for (const p of report.unchanged) console.log(`  [UNCHANGED] ${p}`);
    for (const s of report.skipped) {
        console.log(`  ${s.nonFatal ? '[NOTE] ' : '[SKIP] '}     ${s.path} - ${s.reason}: ${s.detail}`);
    }
    console.log(`\n${report.written.length} written, ${report.appended.length} appended, ${report.unchanged.length} unchanged, ${report.blocking.length} skipped.`);
}

const CASE_PATH_RE = /^(?<account>[^/]+)\/(?<caseId>CAS-[A-Za-z0-9-]+) - (?<title>.+)\/AGENTS\.md$/i;

/**
 * The state index is maintained locally, not by M365 Copilot. Asking Copilot to reprint the
 * whole index every run wasted its output budget and truncated the JSON once the case list
 * grew. Rebuilding it here is deterministic and can never lose an entry.
 */
function updateIndex(rootPath, writtenPaths, lastRunLocal, options = {}) {
    const indexPath = path.join(rootPath, '.intake_index.json');
    let index = { last_run_local: '', cases: {} };

    if (fs.existsSync(indexPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                index = parsed;
                if (!index.cases || typeof index.cases !== 'object') index.cases = {};
            }
        } catch (e) {
            return { updated: [], error: `existing .intake_index.json is not valid JSON (${e.message}); left untouched` };
        }
    }

    const updated = [];
    for (const relativePath of writtenPaths) {
        const m = relativePath.replace(/\\/g, '/').match(CASE_PATH_RE);
        if (!m) continue;
        const { account, caseId, title } = m.groups;
        const previous = index.cases[caseId] && typeof index.cases[caseId] === 'object' ? index.cases[caseId] : {};
        index.cases[caseId] = {
            ...previous,
            account,
            filename: `${caseId} - ${title}/AGENTS.md`,
            title,
            first_seen_local: previous.first_seen_local || lastRunLocal,
            last_updated_local: lastRunLocal
        };
        updated.push(caseId);
    }

    if (updated.length === 0 && index.last_run_local === lastRunLocal) {
        return { updated: [], error: null };
    }

    index.last_run_local = lastRunLocal;
    if (!options.dryRun) {
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
    }
    return { updated, error: null };
}

function scanWindowEnd(scanWindowLine) {
    const m = scanWindowLine && scanWindowLine.match(/to\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/i);
    if (m) return m[1].replace(/\s+/g, ' ');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Entry point used by run_batch, run_fetch and `npm run parse`.
 * Returns { status, result, report } with status CHANGES | NO_CHANGES | PARTIAL | INVALID.
 */
function parsePayload(markdownFile, onedriveFolderConfig, options = {}) {
    if (!fs.existsSync(markdownFile)) {
        throw new Error(`Cannot find response log at ${markdownFile}`);
    }
    const raw = fs.readFileSync(markdownFile, 'utf8');
    const result = analyzeResponse(raw);

    console.log(`\n${formatReport(result)}`);

    if (result.status === 'INVALID') {
        console.error('\nThe M365 response does not satisfy the output contract. No files were written.');
        return { status: 'INVALID', result, report: null };
    }
    if (result.status === 'NO_CHANGES') {
        console.log('\nNo changes reported for this scan window. Nothing to write.');
        return { status: 'NO_CHANGES', result, report: null };
    }

    const report = writePayloads(result, onedriveFolderConfig, options);
    printWriteReport(report);

    const touched = [...report.written, ...report.appended, ...report.unchanged];
    if (touched.length > 0) {
        const stamp = scanWindowEnd(result.scanWindow);
        const indexResult = updateIndex(report.root, touched, stamp, options);
        if (indexResult.error) {
            console.log(`  [NOTE]      .intake_index.json - ${indexResult.error}`);
        } else if (indexResult.updated.length > 0) {
            console.log(`  [INDEX]     .intake_index.json updated for ${indexResult.updated.length} case(s): ${indexResult.updated.join(', ')}`);
        }
    }

    return { status: report.blocking.length > 0 ? 'PARTIAL' : 'CHANGES', result, report };
}

module.exports = {
    parsePayload,
    writePayloads,
    printWriteReport,
    resolveOneDriveRoot,
    stripRootPrefix,
    findDroppedLines,
    findDuplicateActivityBlocks,
    mergeIndex,
    updateIndex,
    scanWindowEnd,
    resolveExistingSegments
};
