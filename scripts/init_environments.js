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
const { ENVIRONMENTS_FILE, isInternalUrl, normalizeEnvironmentUrl, parseEnvironments, resolveDefault, sortByPromotion } = require('./lib/environments');

const rootDir = path.join(__dirname, '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const fixDefault = args.includes('--fix-default');

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

function legacyBlankTemplate(account) {
    return [
        `# Environments - ${account}`,
        '',
        'One line per environment, as "LABEL: url". Add or correct these by hand.',
        'The case intake uses this file to fill "Environment URL:" when a case email does',
        'not contain one. "Default:" chooses which label is used; without it PROD wins.',
        '',
        'PROD:',
        'UAT:',
        'TEST:',
        'DEV:',
        '',
        'Default: PROD',
        '',
        'Notes:',
        '- Lines without a URL are ignored.',
        '- Internal Arbela/Argano systems are rejected and must not be listed here.',
        ''
    ].join('\n');
}

function template(account, discovered) {
    const ordered = sortByPromotion(discovered);
    const lines = [];
    lines.push(`# Environments - ${account}`);
    lines.push('');
    lines.push('One line per environment, as "LABEL: url". Add or correct these by hand.');
    lines.push('The case intake uses this file to fill "Environment URL:" when a case email does');
    lines.push('not contain one, and injects the whole list into the case file.');
    lines.push('"Default:" chooses which label is used; without it the LOWEST environment wins');
    lines.push('(DEV, then SANDBOX, QA, TEST, UAT, STAGING, PREPROD, PROD).');
    lines.push('');

    if (ordered.length > 0) {
        lines.push('Discovered from existing case files, please verify:');
        for (const d of ordered) lines.push(`${d.label}: ${d.url}`);
        lines.push('');
        lines.push(`Default: ${resolveDefault({ environments: ordered, requestedDefault: '' }).label}`);
    } else {
        lines.push('DEV:');
        lines.push('TEST:');
        lines.push('UAT:');
        lines.push('PROD:');
        lines.push('');
        lines.push('Default:');
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
    let fixed = 0;

    console.log(`Cases root: ${root}`);
    console.log(`Accounts:   ${accounts.length}${write ? '' : '   (dry run, pass --write to create files)'}\n`);

    for (const account of accounts) {
        const target = path.join(root, account, ENVIRONMENTS_FILE);
        if (fs.existsSync(target)) {
            const current = fs.readFileSync(target, 'utf8');
            const parsed = parseEnvironments(current);
            const chosen = resolveDefault(parsed);
            const lowest = resolveDefault({ environments: parsed.environments, requestedDefault: '' });

            // The first generation of these files hard-coded "Default: PROD". --fix-default
            // rewrites only that one line, so a hand-picked default is never clobbered silently.
            const stale = fixDefault && lowest && parsed.requestedDefault && parsed.requestedDefault !== lowest.label;
            if (stale) {
                console.log(`  [${write ? 'FIXED ' : 'WOULD '}] ${account} - Default ${parsed.requestedDefault} -> ${lowest.label}`);
                if (write) fs.writeFileSync(target, current.replace(/^Default\s*:.*$/mi, `Default: ${lowest.label}`), 'utf8');
                fixed++;
                continue;
            }

            // An untouched blank template from the first generation still carries the old
            // ordering and "Default: PROD". Regenerate it only when it is byte-identical to
            // what was generated, so anything hand-written is left alone.
            if (fixDefault && parsed.environments.length === 0 && current === legacyBlankTemplate(account)) {
                console.log(`  [${write ? 'FIXED ' : 'WOULD '}] ${account} - blank template refreshed to lowest-first ordering`);
                if (write) fs.writeFileSync(target, template(account, []), 'utf8');
                fixed++;
                continue;
            }
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

    console.log(`\n${existing} kept, ${fixed} default(s) ${write ? 'fixed' : 'to fix'}, ${created} ${write ? 'created' : 'to create'}.`);
    if (!write) console.log('Nothing was written. Re-run with: npm run environments -- --write' + (fixDefault ? ' --fix-default' : ''));
} catch (e) {
    console.error(`environments FAILED: ${e.message}`);
    process.exit(1);
}
