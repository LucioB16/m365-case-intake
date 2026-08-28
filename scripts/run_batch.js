const path = require('path');
const { runCopilot } = require('./lib/playwright_runner');
const { parsePayload } = require('./lib/parser');
const { buildPrompt, loadConfig, loadTemplate, savePrompt } = require('./lib/prompt_builder');

const rootDir = path.join(__dirname, '..');
const responsePath = path.join(rootDir, 'logs', 'latest_response.md');
const promptPath = path.join(rootDir, 'logs', 'latest_prompt.md');

const OBJECTIVE = [
    'In this single run, scan the mailbox for the active scan window, classify every matching email,',
    'and print the resulting content of every affected file as payload blocks, exactly as described in',
    'the OUTPUT CONTRACT section. If nothing matched and nothing changed, print the NO CHANGES shape instead.'
].join(' ');

const EXIT = { OK: 0, INVALID: 1, PARTIAL: 2, FAILURE: 3 };

const START_TIME = Date.now();
const stamp = () => {
    const now = new Date();
    const clock = now.toTimeString().slice(0, 8);
    const elapsed = ((Date.now() - START_TIME) / 1000).toFixed(1).padStart(6, ' ');
    return `[${clock} +${elapsed}s]`;
};
const log = (msg) => console.log(`${stamp()} ${msg}`);

(async () => {
    let prompt;
    try {
        const config = loadConfig(rootDir);
        prompt = buildPrompt({ template: loadTemplate(rootDir), config, objective: OBJECTIVE });
        savePrompt(prompt, promptPath);
        log(`[INFO] Prompt rendered (${prompt.length} chars) and saved to ${promptPath}`);

        await runCopilot(prompt, responsePath);

        log('[INFO] Validating the reply against the output contract...');
        const outcome = parsePayload(responsePath, config.ONEDRIVE_FOLDER);
        log(`[INFO] Contract verdict: ${outcome.status}`);

        if (outcome.status === 'INVALID') {
            console.error(`\nBatch sync FAILED: M365 Copilot did not honour the output contract. Raw reply kept at ${responsePath}.`);
            process.exit(EXIT.INVALID);
        }
        if (outcome.status === 'PARTIAL') {
            console.error('\nBatch sync INCOMPLETE: the reply was valid, but some payloads were not applied (see [SKIP] above).');
            process.exit(EXIT.PARTIAL);
        }
        if (outcome.status === 'NO_CHANGES') {
            console.log('\nBatch sync complete: no changes in this scan window.');
            process.exit(EXIT.OK);
        }
        console.log('\nBatch sync complete!');
        process.exit(EXIT.OK);
    } catch (e) {
        console.error(`\nBatch sync FAILED: ${e && e.stack ? e.stack : e}`);
        process.exit(EXIT.FAILURE);
    }
})();
