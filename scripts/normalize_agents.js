/**
 * Rewrites the "# Agent Instructions" block of every existing AGENTS.md so they all carry the
 * same instructions as the current prompt template.
 *
 *   npm run normalize            report only, writes nothing
 *   npm run normalize -- --write apply the change
 *
 * Only the instruction bullets are replaced. The header, the Description, the "---" separator,
 * the Activity log and everything below it are preserved byte for byte.
 */
const fs = require('fs');
const path = require('path');

const { loadConfig, loadTemplate } = require('./lib/prompt_builder');
const { resolveOneDriveRoot } = require('./lib/parser');

const rootDir = path.join(__dirname, '..');
const write = process.argv.slice(2).includes('--write');

const HEADING = '# Agent Instructions';

/** Pulls the canonical bullet list out of prompts/base_intake.yaml. */
function canonicalBullets(template) {
    const start = template.indexOf(`  ${HEADING}`);
    if (start === -1) throw new Error('The prompt template no longer contains an "# Agent Instructions" heading.');

    const bullets = [];
    // Split on either line ending: the template itself may be stored as CRLF, and a stray
    // carriage return would otherwise be written into every case file.
    for (const raw of template.slice(start).split(/\r?\n/).slice(1)) {
        const line = raw.replace(/^ {2}/, '');
        if (line.startsWith('- ')) { bullets.push(line); continue; }
        if (line.trim() === '' || line.startsWith('{{')) continue;
        break;
    }
    if (bullets.length === 0) throw new Error('No instruction bullets found in the prompt template.');
    return bullets;
}

/**
 * Replaces the block between the heading and the "---" that introduces the Activity log.
 * The file's existing line ending is preserved, so a CRLF file stays CRLF.
 * Returns null when the file has no recognisable block, so it is reported instead of guessed at.
 */
function rewrite(content, bullets) {
    // Pick the dominant line ending rather than "contains CRLF": a file can carry a few stray
    // carriage returns and converting the whole file because of them would be wrong.
    const crlf = (content.match(/\r\n/g) || []).length;
    const lfOnly = (content.match(/(?<!\r)\n/g) || []).length;
    const eol = crlf > lfOnly ? '\r\n' : '\n';

    const lines = content.split(/\r?\n/).map((l) => l.replace(/\r+$/, ''));
    const headingIndex = lines.findIndex((l) => l.trim() === HEADING);
    if (headingIndex === -1) return null;

    let end = -1;
    for (let i = headingIndex + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === '---' || t === 'Activity log:') { end = i; break; }
    }
    if (end === -1) return null;

    const tail = lines[end].trim() === '---' ? lines.slice(end) : ['---', ...lines.slice(end)];
    const rebuilt = [...lines.slice(0, headingIndex), HEADING, ...bullets, '', ...tail];
    return rebuilt.join(eol);
}

try {
    const config = loadConfig(rootDir);
    const root = resolveOneDriveRoot(config.ONEDRIVE_FOLDER);
    const bullets = canonicalBullets(loadTemplate(rootDir));

    console.log(`Cases root: ${root}`);
    console.log(`Canonical block: ${bullets.length} bullets${write ? '' : '   (dry run, pass --write to apply)'}\n`);

    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.toLowerCase() === 'agents.md') files.push(full);
        }
    };
    walk(root);

    let changed = 0;
    let same = 0;
    const failed = [];

    for (const file of files.sort()) {
        const rel = file.replace(root + path.sep, '');
        const current = fs.readFileSync(file, 'utf8');
        const rebuilt = rewrite(current, bullets);

        if (rebuilt === null) { failed.push(rel); console.log(`  [SKIP]   ${rel} - no recognisable Agent Instructions block`); continue; }
        if (rebuilt === current) { same++; continue; }

        console.log(`  [${write ? 'FIXED' : 'WOULD'}]  ${rel}`);
        if (write) fs.writeFileSync(file, rebuilt, 'utf8');
        changed++;
    }

    console.log(`\n${files.length} files: ${same} already correct, ${changed} ${write ? 'updated' : 'to update'}, ${failed.length} skipped.`);
    if (!write && changed > 0) console.log('Nothing was written. Re-run with: npm run normalize -- --write');
} catch (e) {
    console.error(`normalize FAILED: ${e.message}`);
    process.exit(1);
}
