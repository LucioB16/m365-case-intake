/**
 * Renders the batch prompt and writes it to logs/latest_prompt.md without contacting
 * M365 Copilot. Use it to inspect exactly what will be sent.
 *
 *   npm run prompt
 */
const path = require('path');
const { buildPrompt, loadConfig, loadTemplate, savePrompt } = require('./lib/prompt_builder');

const rootDir = path.join(__dirname, '..');
const promptPath = path.join(rootDir, 'logs', 'latest_prompt.md');

const OBJECTIVE = [
    'In this single run, scan the mailbox for the active scan window, classify every matching email,',
    'and print the resulting content of every affected file as payload blocks, exactly as described in',
    'the OUTPUT CONTRACT section. If nothing matched and nothing changed, print the NO CHANGES shape instead.'
].join(' ');

try {
    const config = loadConfig(rootDir);
    const prompt = buildPrompt({ template: loadTemplate(rootDir), config, objective: OBJECTIVE });
    savePrompt(prompt, promptPath);
    console.log(`Prompt rendered: ${prompt.length} chars, ${prompt.split('\n').length} lines.`);
    console.log(`Saved to ${promptPath}`);
} catch (e) {
    console.error(`Prompt build FAILED: ${e.message}`);
    process.exit(1);
}
