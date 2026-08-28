/**
 * Validates a raw M365 Copilot reply against the output contract defined in
 * prompts/base_intake.yaml and extracts the file payloads.
 *
 * The whole point of this module is that a narrative answer can never be mistaken
 * for a successful run: it is classified as INVALID and reported with reasons.
 */

const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

const SCAN_WINDOW_RE = /^scan\s*window\s*:/i;
const NO_CHANGES_RE = /^no[ _]changes\.?$/i;
const UNREADABLE_RE = /^UNREADABLE:\s*(\S.*)$/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;

// Markers that mean "I did not print the whole file".
const TRUNCATION_LINE_RE = /^(?:\.{3}|…|\[\s*\.{3}\s*\]|\(\s*\.{3}\s*\))$/;
const TRUNCATION_PHRASE_RE = /^[[(<]?\s*(?:rest|remainder|remaining|content|contents|the rest|body|text|lines?|entries)\b[^\n]*\b(?:unchanged|omitted|truncated|abbreviated|as above|as before|snipped|same)\b[^\n]*[\])>]?$/i;
const TRUNCATION_LITERALS = [
    '[complete file content]',
    '[full file content]',
    '[entire file content]',
    '[content omitted]',
    '[rest of file unchanged]',
    '[unchanged]',
    '[same as before]',
    '[previous content]',
    '[existing content]'
];

// Filler the model invents when it does not know a value. The contract says leave it blank.
const INVENTED_PLACEHOLDERS = [
    '[needs verification]',
    '[not available]',
    '[unknown]',
    '[to be determined]',
    '[tbd]',
    '[not specified]',
    '[not provided]',
    '[pending]'
];

// A meta remark the model adds inside a payload, which would be written into the user's file.
const PAYLOAD_NOTE_RE = /^[([]\s*note\s*[:\-]/i;

// Slots that come from the templates in the prompt; if they survive, nothing was resolved.
const UNRESOLVED_SLOTS = [
    '<case_id>', '<case_title>', '<account>', '<reporter>', '<created_on>',
    '<env_url_or_blank>', '<description>', '<comment_from>',
    '<yyyy-mm-dd hh:mm local>', '<relative/path/to/agents.md>'
];

const REFUSAL_PATTERNS = [
    /\bi\s+(?:can(?:no|')?t|cannot|am\s+unable\s+to|do\s+not\s+have\s+the\s+ability\s+to)\b[^.\n]{0,80}\b(?:creat\w*|writ\w*|sav\w*|generat\w*|modif\w*|edit\w*|access\w*|upload\w*)\b[^.\n]{0,80}\b(?:file|files|folder|folders|directory|directories|onedrive|disk|drive|filesystem|local)\b/i,
    /\b(?:i\s+)?(?:don'?t|do\s+not)\s+have\s+(?:the\s+)?(?:ability|permission|access|capability)\b[^.\n]{0,80}\b(?:creat\w*|writ\w*|sav\w*|file|files|folder|onedrive)\b/i,
    /\bi\s+(?:can(?:no|')?t|cannot|am\s+unable\s+to)\b[^.\n]{0,60}\bmaintain\b[^.\n]{0,40}\bstate\b/i,
    /\bas\s+an\s+ai\b[^.\n]{0,80}\b(?:cannot|can'?t|unable)\b/i
];

// The model critiquing the instructions instead of running them.
const PROMPT_REVIEW_PATTERNS = [
    /\b(?:this|the|your|el|este)\s+prompt\b/i,
    /\b(?:output[_ ]contract|these\s+instructions|estas\s+instrucciones)\b/i,
    /\b(?:i(?:'d)?\s+would\s+(?:add|suggest|recommend)|sugerencia|yo\s+agregar[ií]a|considerar[ií]a)\b/i
];

function matchFenceOpen(line) {
    const m = line.match(FENCE_OPEN_RE);
    if (!m) return null;
    return { marker: m[1][0].repeat(3), raw: m[1], lang: (m[2] || '').toLowerCase() };
}

function isFenceClose(line, fence) {
    const t = line.trim();
    if (t.length < 3) return false;
    const char = fence.marker[0];
    return new RegExp(`^\\${char}{3,}\\s*$`).test(t);
}

/**
 * Accepts the strict form (bare relative path on its own line) and reports the
 * tolerated-but-off-contract decorations that Copilot sometimes adds.
 *
 * A path line may be prefixed with "APPEND " to mean "this payload is the block to add at
 * the end of that file", instead of the full file content.
 */
function normalizePathLine(rawLine) {
    const original = rawLine.trim();
    if (!original || original.length > 400) return null;

    let t = original;
    t = t.replace(/^[-*+•]\s+/, '');
    t = t.replace(/^#{1,6}\s+/, '');
    t = t.replace(/^\d+[.)]\s+/, '');
    t = t.replace(/^(?:\*\*|__)\s*/, '').replace(/\s*(?:\*\*|__)$/, '');
    t = t.replace(/^(?:file\s*path|filepath|path|file|updated)\s*:\s*/i, '');
    t = t.replace(/^[`'"«]+/, '').replace(/[`'"»]+$/, '');
    t = t.replace(/[:.,;]$/, '');
    t = t.trim();

    let mode = 'full';
    const appendMatch = t.match(/^append\s*[:\-]?\s+(\S.*)$/i);
    if (appendMatch) {
        mode = 'append';
        t = appendMatch[1].trim().replace(/^[`'"]+/, '').replace(/[`'"]+$/, '').trim();
    }

    if (!/\.(?:md|json)$/i.test(t)) return null;
    // Whether this is really a path is decided by the caller: a path line only counts when a
    // fenced block follows it immediately. No word-based heuristic is applied here, because
    // real case folders contain ordinary words ("... - Reopening of CAS-1234567-A1B2/AGENTS.md").

    return { path: t.replace(/\\/g, '/'), mode, tolerated: t !== original && mode === 'full', original };
}

function scanPayloadContent(relPath, content, violations) {
    let clean = true;
    const lines = content.split('\n');
    const lower = content.toLowerCase();

    for (const literal of TRUNCATION_LITERALS) {
        if (lower.includes(literal)) {
            violations.push({
                code: 'TRUNCATED_PAYLOAD',
                severity: SEVERITY.ERROR,
                message: `Payload "${relPath}" contains the truncation marker "${literal}".`
            });
            clean = false;
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        if (TRUNCATION_LINE_RE.test(t) || TRUNCATION_PHRASE_RE.test(t)) {
            violations.push({
                code: 'TRUNCATED_PAYLOAD',
                severity: SEVERITY.ERROR,
                message: `Payload "${relPath}" line ${i + 1} is an elision marker ("${t}") instead of real content.`
            });
            clean = false;
        }
    }

    for (const slot of UNRESOLVED_SLOTS) {
        if (lower.includes(slot)) {
            violations.push({
                code: 'UNRESOLVED_PLACEHOLDER',
                severity: SEVERITY.ERROR,
                message: `Payload "${relPath}" still contains the unresolved template slot "${slot}".`
            });
            clean = false;
        }
    }

    for (const filler of INVENTED_PLACEHOLDERS) {
        if (lower.includes(filler)) {
            violations.push({
                code: 'INVENTED_PLACEHOLDER',
                severity: SEVERITY.ERROR,
                message: `Payload "${relPath}" contains the filler value "${filler}". Unknown fields must be left empty, never annotated.`
            });
            clean = false;
        }
    }

    for (let i = 0; i < lines.length; i++) {
        if (PAYLOAD_NOTE_RE.test(lines[i].trim())) {
            violations.push({
                code: 'META_NOTE_IN_PAYLOAD',
                severity: SEVERITY.ERROR,
                message: `Payload "${relPath}" line ${i + 1} is a note to the reader ("${lines[i].trim().slice(0, 60)}"), which would be written into the user's file.`
            });
            clean = false;
            break;
        }
    }

    if (/\.json$/i.test(relPath)) {
        try {
            JSON.parse(content);
        } catch (e) {
            violations.push({
                code: 'INVALID_JSON_PAYLOAD',
                severity: SEVERITY.ERROR,
                message: `Payload "${relPath}" is not valid JSON: ${e.message}`
            });
            clean = false;
        }
    }

    if (!content.trim()) {
        violations.push({
            code: 'EMPTY_PAYLOAD',
            severity: SEVERITY.ERROR,
            message: `Payload "${relPath}" is empty.`
        });
        clean = false;
    }

    return clean;
}

function analyzeResponse(rawResponse) {
    const violations = [];
    const payloads = [];
    const unreadable = [];
    const strayLines = [];

    const text = String(rawResponse == null ? '' : rawResponse).replace(/\r\n?/g, '\n');
    const lines = text.split('\n');

    if (!text.trim()) {
        violations.push({
            code: 'EMPTY_RESPONSE',
            severity: SEVERITY.ERROR,
            message: 'The captured response is empty. Nothing was received from M365 Copilot.'
        });
        return finalize({ status: 'INVALID', scanWindow: null, payloads, unreadable, violations, strayLines });
    }

    let scanWindow = null;
    let sawNoChanges = false;
    let firstNonEmptySeen = false;
    let seenPayload = false;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) { i++; continue; }

        const fence = matchFenceOpen(trimmed);
        if (fence) {
            // A fenced block with no path line in front of it: a payload we cannot place.
            let j = i + 1;
            while (j < lines.length && !isFenceClose(lines[j], fence)) j++;
            violations.push({
                code: 'ORPHAN_FENCE',
                severity: SEVERITY.ERROR,
                message: `A fenced block at line ${i + 1} is not preceded by a file path line, so its content cannot be written.`
            });
            i = j < lines.length ? j + 1 : j;
            firstNonEmptySeen = true;
            continue;
        }

        const pathLine = normalizePathLine(trimmed);
        if (pathLine) {
            let j = i + 1;
            let blanks = 0;
            while (j < lines.length && !lines[j].trim()) { j++; blanks++; }
            const openFence = j < lines.length ? matchFenceOpen(lines[j].trim()) : null;

            if (openFence) {
                if (blanks > 0) {
                    violations.push({
                        code: 'PATH_FENCE_GAP',
                        severity: SEVERITY.WARNING,
                        message: `Path "${pathLine.path}" is separated from its code fence by ${blanks} blank line(s); the contract requires the fence on the very next line.`
                    });
                }
                if (pathLine.tolerated) {
                    violations.push({
                        code: 'DECORATED_PATH',
                        severity: SEVERITY.WARNING,
                        message: `Path line was decorated ("${pathLine.original}") and had to be normalized to "${pathLine.path}".`
                    });
                }
                if (openFence.marker === '~~~') {
                    violations.push({
                        code: 'NON_BACKTICK_FENCE',
                        severity: SEVERITY.WARNING,
                        message: `Payload "${pathLine.path}" used a ~~~ fence instead of three backticks.`
                    });
                }

                let k = j + 1;
                const body = [];
                let closed = false;
                while (k < lines.length) {
                    if (isFenceClose(lines[k], openFence)) { closed = true; break; }
                    body.push(lines[k]);
                    k++;
                }
                if (!closed) {
                    violations.push({
                        code: 'UNCLOSED_FENCE',
                        severity: SEVERITY.ERROR,
                        message: `The code fence opened for "${pathLine.path}" is never closed; the response is truncated.`
                    });
                }

                const content = body.join('\n');
                // The state index is maintained locally by the parser, so an index payload is
                // informational only. Emitting it wastes output budget and truncates easily.
                const isIndex = /(^|\/)\.intake_index\.json$/i.test(pathLine.path);
                if (isIndex) {
                    violations.push({
                        code: 'INDEX_PAYLOAD_IGNORED',
                        severity: SEVERITY.WARNING,
                        message: 'The reply emitted .intake_index.json; it is ignored because the local parser maintains the index.'
                    });
                    payloads.push({ path: pathLine.path, lang: openFence.lang, content, line: i + 1, valid: false, ignored: true });
                    seenPayload = true;
                    firstNonEmptySeen = true;
                    i = closed ? k + 1 : k;
                    continue;
                }

                const ok = scanPayloadContent(pathLine.path, content, violations) && closed;
                payloads.push({
                    path: pathLine.path,
                    mode: pathLine.mode,
                    lang: openFence.lang,
                    content,
                    line: i + 1,
                    valid: ok
                });
                seenPayload = true;
                firstNonEmptySeen = true;
                i = closed ? k + 1 : k;
                continue;
            }
            // Path-looking line with no payload behind it is narrative, not a payload.
        }

        if (!firstNonEmptySeen && SCAN_WINDOW_RE.test(trimmed)) {
            scanWindow = trimmed;
            firstNonEmptySeen = true;
            i++;
            continue;
        }

        if (NO_CHANGES_RE.test(trimmed)) {
            sawNoChanges = true;
            firstNonEmptySeen = true;
            i++;
            continue;
        }

        const unreadableMatch = trimmed.match(UNREADABLE_RE);
        if (unreadableMatch) {
            unreadable.push(unreadableMatch[1].trim());
            firstNonEmptySeen = true;
            i++;
            continue;
        }

        if (SCAN_WINDOW_RE.test(trimmed) && !scanWindow) {
            scanWindow = trimmed;
            firstNonEmptySeen = true;
            i++;
            continue;
        }

        strayLines.push({ line: i + 1, text: trimmed, afterPayload: seenPayload });
        firstNonEmptySeen = true;
        i++;
    }

    if (!scanWindow) {
        violations.push({
            code: 'MISSING_SCAN_WINDOW',
            severity: SEVERITY.WARNING,
            message: 'The reply does not start with the required "Scan window: ..." line.'
        });
    }

    for (const pattern of REFUSAL_PATTERNS) {
        const offender = strayLines.find((s) => pattern.test(s.text));
        if (offender) {
            violations.push({
                code: 'CAPABILITY_REFUSAL',
                severity: SEVERITY.ERROR,
                message: `Copilot answered with a capability refusal at line ${offender.line}. It must never claim it cannot write files: a local script does the writing.`
            });
            break;
        }
    }

    if (strayLines.length > 0) {
        violations.push({
            code: 'NARRATIVE_TEXT',
            severity: payloads.length > 0 ? SEVERITY.WARNING : SEVERITY.ERROR,
            message: `${strayLines.length} line(s) of narrative text outside the contract (first at line ${strayLines[0].line}).`
        });

        if (payloads.length === 0) {
            const hits = PROMPT_REVIEW_PATTERNS.filter((p) => strayLines.some((s) => p.test(s.text))).length;
            if (hits >= 2) {
                violations.push({
                    code: 'PROMPT_REVIEW',
                    severity: SEVERITY.ERROR,
                    message: 'Copilot commented on the instructions instead of executing them. The prompt must open with an explicit "execute this now" directive.'
                });
            }
        }
    }

    if (payloads.length > 0 && sawNoChanges) {
        violations.push({
            code: 'CONTRADICTORY_RESPONSE',
            severity: SEVERITY.ERROR,
            message: 'The reply declares NO CHANGES and still emits file payloads.'
        });
    }

    const realPayloads = payloads.filter((p) => !p.ignored);

    if (realPayloads.length === 0 && !sawNoChanges) {
        violations.push({
            code: 'NO_PAYLOAD_NO_MARKER',
            severity: SEVERITY.ERROR,
            message: 'No file payload blocks and no explicit "NO CHANGES" marker. The output contract was not followed.'
        });
    }

    const byPath = new Map();
    for (const p of payloads) {
        if (byPath.has(p.path)) {
            const previous = byPath.get(p.path);
            violations.push({
                code: previous.content === p.content ? 'DUPLICATE_PAYLOAD' : 'CONFLICTING_PAYLOAD',
                severity: previous.content === p.content ? SEVERITY.WARNING : SEVERITY.ERROR,
                message: previous.content === p.content
                    ? `Payload "${p.path}" was emitted twice with identical content; only the first is used.`
                    : `Payload "${p.path}" was emitted twice with different content; refusing to guess which one is final.`
            });
            p.duplicateOf = previous.line;
        } else {
            byPath.set(p.path, p);
        }
    }

    let status;
    if (violations.some((v) => v.severity === SEVERITY.ERROR)) {
        status = 'INVALID';
    } else if (realPayloads.length > 0) {
        status = 'CHANGES';
    } else {
        status = 'NO_CHANGES';
    }

    return finalize({ status, scanWindow, payloads, unreadable, violations, strayLines });
}

function finalize(result) {
    result.errors = result.violations.filter((v) => v.severity === SEVERITY.ERROR);
    result.warnings = result.violations.filter((v) => v.severity === SEVERITY.WARNING);
    result.writablePayloads = result.payloads.filter((p) => p.valid && !p.duplicateOf && !p.ignored);
    return result;
}

function formatReport(result) {
    const lines = [];
    lines.push(`Contract status: ${result.status}`);
    if (result.scanWindow) lines.push(result.scanWindow);
    lines.push(`Payload blocks: ${result.payloads.length} (writable: ${result.writablePayloads.length})`);
    for (const w of result.warnings) lines.push(`  [WARN]  ${w.code}: ${w.message}`);
    for (const e of result.errors) lines.push(`  [ERROR] ${e.code}: ${e.message}`);
    for (const u of result.unreadable) lines.push(`  [INFO]  Copilot could not read existing file: ${u}`);
    return lines.join('\n');
}

module.exports = { analyzeResponse, formatReport, SEVERITY };
