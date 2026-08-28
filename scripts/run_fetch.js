const path = require('path');
const { runCopilot } = require('./lib/playwright_runner');
const { parsePayload } = require('./lib/parser');
const { buildPrompt, loadConfig, loadTemplate, savePrompt } = require('./lib/prompt_builder');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: npm run fetch <CASE_ID> "<TIME_WINDOW>"');
    console.error('Example: npm run fetch CAS-1455051-S3F0 "last 30 days"');
    process.exit(1);
}

const caseId = args[0];
const timeWindow = args[1];

const rootDir = path.join(__dirname, '..');
const responsePath = path.join(rootDir, 'logs', 'latest_response.md');
const promptPath = path.join(rootDir, 'logs', 'latest_prompt.md');

const EXIT = { OK: 0, INVALID: 1, PARTIAL: 2, FAILURE: 3 };

const objective = [
    `In this single run, process ONLY emails related to CASE ID: ${caseId} received within the time window: ${timeWindow}.`,
    'Print the resulting content of every affected file as payload blocks, exactly as described in the OUTPUT CONTRACT section.'
].join(' ');

const overrideHeader = `=======================================================================
>>> CRITICAL OVERRIDE FOR THIS SPECIFIC ON-DEMAND RUN <<<
=======================================================================
1. IGNORE the standard lookback parameters.
2. ONLY search for and process emails matching THIS EXACT CASE ID: ${caseId}
3. ONLY search within this specific time window: ${timeWindow}
4. Process ALL matching emails for this specific case, skipping any other cases.
5. Report this window on the "Scan window:" line instead of the computed lookback.
6. FORCE-ACCEPT this case REGARDLESS of the Product field. IGNORE the "product_must_contain_any" filter entirely.
7. PAYLOAD FORM OVERRIDE: this run rebuilds the case folder from scratch, so do NOT use the
   APPEND form. Emit plain full-content payloads for both AGENTS.md and CLAUDE.md.
   The AGENTS.md payload must contain the case header, then the Agent Instructions block,
   then "---", then "Activity log:", then EVERY entry found in this window, oldest first,
   each as a "[Portal Comment] ..." or "[Assigned to me] ..." block.
   Fields you cannot find in the emails stay empty. Never invent a value.
8. Every other rule of the OUTPUT CONTRACT below still applies without exception.
=======================================================================

`;

(async () => {
    try {
        const config = loadConfig(rootDir);
        const prompt = buildPrompt({
            template: loadTemplate(rootDir),
            config,
            objective,
            prefix: overrideHeader
        });
        savePrompt(prompt, promptPath);

        await runCopilot(prompt, responsePath);

        const outcome = parsePayload(responsePath, config.ONEDRIVE_FOLDER);

        if (outcome.status === 'INVALID') {
            console.error(`\nFetch FAILED for ${caseId}: the reply did not honour the output contract. Raw reply kept at ${responsePath}.`);
            process.exit(EXIT.INVALID);
        }
        if (outcome.status === 'PARTIAL') {
            console.error(`\nFetch INCOMPLETE for ${caseId}: the reply was valid, but some payloads were not applied (see [SKIP] above).`);
            process.exit(EXIT.PARTIAL);
        }
        console.log(`\nFetch complete for ${caseId}!`);
        process.exit(EXIT.OK);
    } catch (e) {
        console.error(`\nFetch FAILED: ${e && e.stack ? e.stack : e}`);
        process.exit(EXIT.FAILURE);
    }
})();
