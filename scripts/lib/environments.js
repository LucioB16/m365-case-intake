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

// Lowest environment first. Work starts in DEV and is promoted upwards, so the safest
// default for a case is the lowest one the client actually has. A client with only PROD
// therefore defaults to PROD.
const PROMOTION_ORDER = ['DEV', 'SANDBOX', 'SBX', 'QA', 'TEST', 'UAT', 'STAGING', 'STAGE', 'PREPROD', 'PRE-PROD', 'PROD', 'PRODUCTION'];

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
 *
 * A "## Group name" heading starts a set. Some clients run more than one set of
 * environments, for example AquaCal and TeamHorner, or Woodforest R1 and R2, and each set
 * has its own DEV/TEST/UAT/PROD. Labels only have to be unique inside their set, and a
 * Default can be written as "Group/LABEL".
 * Everything else is treated as free-form notes and ignored.
 */
function parseEnvironments(content) {
    const environments = [];
    let requestedDefault = '';
    let group = '';

    for (const rawLine of String(content || '').split(/\r?\n/)) {
        const heading = rawLine.match(/^\s{0,3}#{2,6}\s+(\S.*?)\s*$/);
        if (heading) {
            const name = heading[1].trim();
            group = /^(notes?|environments?)$/i.test(name) ? '' : name;
            continue;
        }

        const line = rawLine.replace(/^[\s>*\-+]+/, '').trim();
        if (!line || line.startsWith('#')) continue;

        const defaultMatch = line.match(/^default\s*:\s*(\S.*)$/i);
        if (defaultMatch) {
            requestedDefault = defaultMatch[1].trim().replace(/[.`'"]+$/, '');
            continue;
        }

        const entryMatch = line.match(/^([A-Za-z][A-Za-z0-9 _/()-]{0,40}?)\s*:\s*(https?:\/\/\S+)\s*$/);
        if (!entryMatch) continue;

        const label = entryMatch[1].trim().toUpperCase();
        const url = normalizeEnvironmentUrl(entryMatch[2].replace(/[.,;)]+$/, ''));
        if (!url || isInternalUrl(url)) continue;
        if (environments.some((e) => e.group === group && e.label === label)) continue;
        environments.push({ group, label, url, name: group ? `${group}/${label}` : label });
    }

    return { environments, requestedDefault };
}

/**
 * Picks the environment to use when a case has none.
 * An explicit Default wins; it may name a label, a "Group/LABEL" pair, or a URL.
 * Otherwise the lowest environment on the promotion ladder wins, and when several sets are
 * declared the one from the first set in the file breaks the tie.
 */
function resolveDefault({ environments, requestedDefault }) {
    if (environments.length === 0) return null;

    if (requestedDefault) {
        const wanted = requestedDefault.toUpperCase();
        const byName = environments.find((e) => e.name.toUpperCase() === wanted);
        if (byName) return byName;
        const byLabel = environments.find((e) => e.label === wanted);
        if (byLabel) return byLabel;
        const byUrl = environments.find((e) => e.url.toLowerCase() === normalizeEnvironmentUrl(requestedDefault).toLowerCase());
        if (byUrl) return byUrl;
    }

    for (const step of PROMOTION_ORDER) {
        const match = environments.find((e) => e.label === step);
        if (match) return match;
    }
    return environments[0];
}

/**
 * Sorts environments for display: sets in the order they appear in the file, and inside each
 * set from the lowest environment to the highest. Unknown labels go last, in file order.
 */
function sortByPromotion(environments) {
    const groupOrder = [];
    for (const e of environments) if (!groupOrder.includes(e.group)) groupOrder.push(e.group);

    return [...environments].sort((a, b) => {
        const g = groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
        if (g !== 0) return g;
        const ia = PROMOTION_ORDER.indexOf(a.label);
        const ib = PROMOTION_ORDER.indexOf(b.label);
        return (ia === -1 ? PROMOTION_ORDER.length : ia) - (ib === -1 ? PROMOTION_ORDER.length : ib);
    });
}

function environmentsPathFor(rootPath, account) {
    return path.join(rootPath, account, ENVIRONMENTS_FILE);
}

/**
 * Reads the environments declared for one account, lowest environment first.
 * Returns null when the account has no ENVIRONMENTS.md or it declares no usable entry.
 */
function environmentsFor(rootPath, account) {
    const filePath = environmentsPathFor(rootPath, account);
    if (!fs.existsSync(filePath)) return null;
    const parsed = parseEnvironments(fs.readFileSync(filePath, 'utf8'));
    const chosen = resolveDefault(parsed);
    if (!chosen) return null;
    return { all: sortByPromotion(parsed.environments), default: chosen, source: filePath };
}

/** Convenience wrapper returning only the default environment. */
function defaultEnvironmentFor(rootPath, account) {
    const found = environmentsFor(rootPath, account);
    if (!found) return null;
    return { ...found.default, source: found.source, count: found.all.length };
}

module.exports = {
    ENVIRONMENTS_FILE,
    parseEnvironments,
    resolveDefault,
    sortByPromotion,
    environmentsFor,
    defaultEnvironmentFor,
    environmentsPathFor,
    isInternalUrl,
    normalizeEnvironmentUrl,
    PROMOTION_ORDER
};
