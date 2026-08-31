/**
 * Creates or refreshes ENVIRONMENTS.md in every account folder.
 *
 *   npm run environments            report only, writes nothing
 *   npm run environments -- --write create the missing files
 *
 * Existing ENVIRONMENTS.md files are never overwritten: they are hand-maintained.
 * Each generated file is pre-filled with the client environment URLs already found in that
 * account's AGENTS.md files, with internal Arbela/Argano systems filtered out.
 */
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/prompt_builder');
const { resolveOneDriveRoot } = require('./lib/parser');
const { ENVIRONMENTS_FILE, isInternalUrl, normalizeEnvironmentUrl, parseEnvironments, resolveDefault } = require('./lib/environments');

const rootDir = path.join(__dirname, '..');
const write = process.argv.slice(2).includes('--write');

function labelFor(url) {
    const host = url.toLowerCase();
    if (/-?dev(r[0-9]+)?\./.test(host) || host.includes('dev.')) return 'DEV';
    if (host.includes('uat')) return 'UAT';
    if (host.includes('test')) return 'TEST';
    if (host.includes('sandbox') || host.includes('sbx')) return 'SANDBOX';
    if (host.includes('qa')) return 'QA';
    return 'PROD';
}

function discoverUrls(accountPath) {
    const found = new Map();
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (entry.name.toLowerCase() !== 'agents.md') continue;
            const content = fs.readFileSync(full, 'utf8');
            const match = content.match(/^Environment URL:[ \t]*(\S.*)$/m);
            if (!match) continue;
            const url = normalizeEnvironmentUrl(match[1].replace(/\(.*\)\s*$/, '').trim());
            if (!url || isInternalUrl(url)) continue;
            if (!found.has(url)) found.set(url, labelFor(url));
        }
    };
    walk(accountPath);
    return [...found.entries()].map(([url, label]) => ({ url, label }));
}

function template(account, discovered) {
    const lines = [];
    lines.push(`# Environments - ${account}`);
    lines.push('');
    lines.push('One line per environment, as "LABEL: url". Add or correct these by hand.');
    lines.push('The case intake uses this file to fill "Environment URL:" when a case email does');
    lines.push('not contain one. "Default:" chooses which label is used; without it PROD wins.');
    lines.push('');

    if (discovered.length > 0) {
        lines.push('Discovered from existing case files, please verify:');
        for (const d of discovered) lines.push(`${d.label}: ${d.url}`);
        lines.push('');
        lines.push(`Default: ${resolveDefault({ environments: discovered, requestedDefault: '' }).label}`);
    } else {
        lines.push('PROD:');
        lines.push('UAT:');
        lines.push('TEST:');
        lines.push('DEV:');
        lines.push('');
        lines.push('Default: PROD');
    }

    lines.push('');
    lines.push('Notes:');
    lines.push('- Lines without a URL are ignored.');
    lines.push('- Internal Arbela/Argano systems are rejected and must not be listed here.');
    lines.push('');
    return lines.join('\n');
}

try {
    const config = loadConfig(rootDir);
    const root = resolveOneDriveRoot(config.ONEDRIVE_FOLDER);
    if (!fs.existsSync(root)) throw new Error(`Cannot find the cases root at ${root}`);

    const accounts = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();

    let created = 0;
    let existing = 0;

    console.log(`Cases root: ${root}`);
    console.log(`Accounts:   ${accounts.length}${write ? '' : '   (dry run, pass --write to create files)'}\n`);

    for (const account of accounts) {
        const target = path.join(root, account, ENVIRONMENTS_FILE);
        if (fs.existsSync(target)) {
            const parsed = parseEnvironments(fs.readFileSync(target, 'utf8'));
            const chosen = resolveDefault(parsed);
            console.log(`  [KEEP]   ${account} - ${parsed.environments.length} environment(s)${chosen ? `, default ${chosen.label}` : ', no default resolvable'}`);
            existing++;
            continue;
        }
        const discovered = discoverUrls(path.join(root, account));
        const detail = discovered.length > 0
            ? discovered.map((d) => `${d.label} ${d.url}`).join(', ')
            : 'no client URL found in existing cases, template left blank';
        console.log(`  [${write ? 'CREATE' : 'WOULD'}] ${account} - ${detail}`);
        if (write) fs.writeFileSync(target, template(account, discovered), 'utf8');
        created++;
    }

    console.log(`\n${existing} kept, ${created} ${write ? 'created' : 'to create'}.`);
    if (!write) console.log('Nothing was written. Re-run with: npm run environments -- --write');
} catch (e) {
    console.error(`environments FAILED: ${e.message}`);
    process.exit(1);
}
