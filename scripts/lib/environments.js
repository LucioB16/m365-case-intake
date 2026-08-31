const fs = require('fs');
const path = require('path');

const ENVIRONMENTS_FILE = 'ENVIRONMENTS.md';

// Internal Arbela/Argano systems are never a client environment. The ticketing CRM in
// particular has already leaked into several case files through the email parser.
const INTERNAL_HOST_PATTERNS = [
    /(^|\.)arbelatechnologies\.crm[0-9]*\.dynamics\.com$/i,
    /(^|\.)arbela[a-z0-9-]*\.crm[0-9]*\.dynamics\.com$/i,
    /(^|\.)argano[a-z0-9-]*\.crm[0-9]*\.dynamics\.com$/i,
    /(^|\.)arbelasupport\.microsoftcrmportals\.com$/i
];

const PREFERRED_LABEL_ORDER = ['PROD', 'PRODUCTION', 'UAT', 'TEST', 'QA', 'DEV', 'SANDBOX'];

function hostOf(url) {
    try {
        return new URL(String(url).trim()).hostname;
    } catch (e) {
        return '';
    }
}

/** True when the URL points at one of our own internal systems rather than a client's. */
function isInternalUrl(url) {
    const host = hostOf(url);
    if (!host) return false;
    return INTERNAL_HOST_PATTERNS.some((p) => p.test(host));
}

/** Reduces a full Dynamics URL to its origin, dropping app ids, record ids and query strings. */
function normalizeEnvironmentUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) return '';
    try {
        const parsed = new URL(trimmed);
        return `${parsed.protocol}//${parsed.hostname}`;
    } catch (e) {
        return trimmed;
    }
}

/**
 * Parses an account-level ENVIRONMENTS.md.
 *
 * Recognised lines, anywhere in the file, in any order:
 *   PROD: https://contoso.crm.dynamics.com
 *   - DEV: https://contoso-dev.crm.dynamics.com
 *   Default: PROD
 * Everything else is treated as free-form notes and ignored.
 */
function parseEnvironments(content) {
    const environments = [];
    let requestedDefault = '';

    for (const rawLine of String(content || '').split(/\r?\n/)) {
        const line = rawLine.replace(/^[\s>*\-+]+/, '').trim();
        if (!line || line.startsWith('#')) continue;

        const defaultMatch = line.match(/^default\s*:\s*(\S.*)$/i);
        if (defaultMatch) {
            requestedDefault = defaultMatch[1].trim().replace(/[.`'"]+$/, '').toUpperCase();
            continue;
        }

        const entryMatch = line.match(/^([A-Za-z][A-Za-z0-9 _/()-]{0,40}?)\s*:\s*(https?:\/\/\S+)\s*$/);
        if (!entryMatch) continue;

        const label = entryMatch[1].trim().toUpperCase();
        const url = normalizeEnvironmentUrl(entryMatch[2].replace(/[.,;)]+$/, ''));
        if (!url || isInternalUrl(url)) continue;
        if (environments.some((e) => e.label === label)) continue;
        environments.push({ label, url });
    }

    return { environments, requestedDefault };
}

/** Picks the environment to use when a case has none: explicit Default, then PROD, then first. */
function resolveDefault({ environments, requestedDefault }) {
    if (environments.length === 0) return null;

    if (requestedDefault) {
        const byLabel = environments.find((e) => e.label === requestedDefault);
        if (byLabel) return byLabel;
        const byUrl = environments.find((e) => e.url.toLowerCase() === normalizeEnvironmentUrl(requestedDefault).toLowerCase());
        if (byUrl) return byUrl;
    }

    for (const preferred of PREFERRED_LABEL_ORDER) {
        const match = environments.find((e) => e.label === preferred);
        if (match) return match;
    }
    return environments[0];
}

function environmentsPathFor(rootPath, account) {
    return path.join(rootPath, account, ENVIRONMENTS_FILE);
}

/**
 * Reads the default environment for one account.
 * Returns null when the account has no ENVIRONMENTS.md or it declares no usable entry.
 */
function defaultEnvironmentFor(rootPath, account) {
    const filePath = environmentsPathFor(rootPath, account);
    if (!fs.existsSync(filePath)) return null;
    const parsed = parseEnvironments(fs.readFileSync(filePath, 'utf8'));
    const chosen = resolveDefault(parsed);
    if (!chosen) return null;
    return { ...chosen, source: filePath, count: parsed.environments.length };
}

module.exports = {
    ENVIRONMENTS_FILE,
    parseEnvironments,
    resolveDefault,
    defaultEnvironmentFor,
    environmentsPathFor,
    isInternalUrl,
    normalizeEnvironmentUrl
};
