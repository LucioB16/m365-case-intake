const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.LOCALAPPDATA || process.cwd(), 'CopilotDailyProfile');
const URL = 'https://m365.cloud.microsoft/chat';

const START_TIME = Date.now();
const stamp = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const elapsed = ((Date.now() - START_TIME) / 1000).toFixed(1).padStart(6, ' ');
    return `[${hh}:${mm}:${ss} +${elapsed}s]`;
};
const log = (msg) => console.log(`${stamp()} ${msg}`);
const warn = (msg) => console.log(`${stamp()} ${msg}`);
const fail = (msg) => console.error(`${stamp()} ${msg}`);
async function runCopilot(promptText, outputFilePath) {
    log('[INFO] Starting M365 Copilot automation...');
    log('[INFO] Launching Edge with dedicated profile...');
    
    let context;
    try {
        context = await chromium.launchPersistentContext(DATA_DIR, {
            headless: true,
            channel: 'msedge',
            args: ['--disable-blink-features=AutomationControlled'],
            viewport: { width: 1280, height: 720 }
        });
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        log('[INFO] Edge launched successfully!');
    } catch (e) {
        fail('[ERROR] Failed to launch Edge:', e.message);
        process.exit(1);
    }

    const page = await context.newPage();
    log(`[INFO] Navigating to ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const workIqCheck = async () => {
        try {
            log('[INFO] Ensuring Work IQ is enabled...');
            const workIqToggle = page.locator('button:has-text("Work IQ")').first();
            await workIqToggle.waitFor({ state: 'visible', timeout: 5000 });
            const ariaChecked = await workIqToggle.getAttribute('aria-checked');
            if (ariaChecked !== 'true') {
                await workIqToggle.click();
                log('[INFO] Turned ON Work IQ.');
                await page.waitForTimeout(2000);
            } else {
                log('[INFO] Work IQ is already ON.');
            }
        } catch (e) {
            log('[INFO] Work IQ toggle not found within 5s, continuing...');
        }
    };

    const openModelMenu = async () => {
        const modeSwitcher = page.locator('#gptModeSwitcher');
        const claudeTrigger = page.locator('#gptSubMenuModelTrigger-Claude, [data-test-id="gptSubMenuModelTrigger-Claude"], [role="menuitem"]:has-text("Claude")');

        for (let i = 0; i < 4; i++) {
            if (await claudeTrigger.count() > 0) return claudeTrigger.first();
            await modeSwitcher.click();
            for (let waited = 0; waited < 10; waited++) {
                await page.waitForTimeout(1000);
                if (await claudeTrigger.count() > 0) return claudeTrigger.first();
            }
            warn(`[WARN] Model menu did not open on click ${i + 1}/4, retrying...`);
            await page.waitForTimeout(2000);
        }
        throw new Error('the model menu never exposed the Claude entry');
    };

    const openClaudeSubmenu = async () => {
        const claudeTrigger = await openModelMenu();
        await claudeTrigger.click();
        await page.waitForTimeout(2500);

        const opus = page.locator('[role="menuitemradio"]:has-text("Opus")').last();
        for (let waited = 0; waited < 12; waited++) {
            if (await opus.count() > 0) return opus;
            await page.waitForTimeout(1000);
        }
        const seen = await page.locator('[role="menuitemradio"]').allInnerTexts().catch(() => []);
        throw new Error(`the Claude submenu did not show an "Opus" option (saw: ${seen.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ') || 'nothing'})`);
    };

    const withRetries = async (label, fn, attempts = 3) => {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await fn();
            } catch (e) {
                lastError = e;
                warn(`[WARN] ${label} failed on attempt ${attempt}/${attempts}: ${e.message.split('\n')[0]}`);
                try { await page.keyboard.press('Escape'); } catch (ignored) { /* menu may be closed */ }
                await page.waitForTimeout(3000);
            }
        }
        throw lastError;
    };

    try {
        log('[INFO] Waiting for the chat surface to be ready...');
        await page.waitForTimeout(8000);

        log('[INFO] Selecting Claude Opus model...');
        let opusOption = await withRetries('Opening the Claude submenu', openClaudeSubmenu);

        if ((await opusOption.getAttribute('aria-checked')) === 'true') {
            log('[INFO] Claude Opus is already selected.');
            await page.keyboard.press('Escape');
        } else {
            await opusOption.click();
            await page.waitForTimeout(2500);
            // Re-open the menu and confirm the radio actually flipped.
            opusOption = await withRetries('Re-opening the Claude submenu to verify', openClaudeSubmenu);
            const confirmed = (await opusOption.getAttribute('aria-checked')) === 'true';
            await page.keyboard.press('Escape');
            if (!confirmed) throw new Error('the Opus radio did not report aria-checked="true" after clicking it');
            log('[INFO] Selected Claude Opus model (verified).');
        }
        await page.waitForTimeout(1500);
    } catch (e) {
        fail(`[ERROR] Could not select and verify the Claude Opus model: ${e.message.split('\n')[0]}`);
        try {
            const shot = path.join(path.dirname(outputFilePath), 'model_menu_failure.png');
            if (!fs.existsSync(path.dirname(shot))) fs.mkdirSync(path.dirname(shot), { recursive: true });
            await page.screenshot({ path: shot, fullPage: false });
            fail(`[ERROR] Screenshot of the failing page saved to ${shot}`);
            const controls = await page.evaluate(() => {
                const out = [];
                document.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"],[role="dialog"]').forEach((el) => {
                    const t = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50);
                    const id = el.id || el.getAttribute('data-test-id') || '';
                    if (t || id) out.push(`${el.tagName.toLowerCase()}#${id}::${t}`);
                });
                return out.slice(0, 60);
            });
            fail(`[ERROR] Visible controls: ${controls.join(' | ')}`);
        } catch (ignored) { /* diagnostics are best effort */ }
        fail('[ERROR] Aborting: running on a different model would invalidate the run.');
        await context.close();
        process.exit(1);
    }

    await workIqCheck();

    log('[INFO] Pasting prompt into the composer...');
    let chatInput = page.locator('#m365-chat-editor-target-element, #chat-input-textarea, [contenteditable="true"]').first();
    await chatInput.waitFor({ state: 'visible', timeout: 15000 });
    
    // Fill the Lexical editor or textarea
    try {
        await chatInput.fill(promptText);
    } catch(e) {
        await chatInput.evaluate((el, val) => {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }, promptText);
    }

    await page.waitForTimeout(1000);

    // A composer that silently truncates the prompt would cut off the OUTPUT CONTRACT
    // and guarantee an off-contract reply. Detect it instead of discovering it later.
    try {
        const typed = await chatInput.evaluate((el) => (el.value !== undefined && el.value !== null ? el.value : el.innerText) || '');
        const normalize = (s) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
        const expected = normalize(promptText);
        const actual = normalize(typed);
        if (actual.length < expected.length * 0.98) {
            fail(`[ERROR] The composer only accepted ${actual.length} of ${expected.length} characters.`);
            fail('[ERROR] The prompt was truncated before sending; aborting instead of sending an incomplete contract.');
            await context.close();
            process.exit(1);
        }
        log(`[INFO] Composer content verified (${actual.length} chars).`);
    } catch (e) {
        log('[INFO] Could not verify composer content length, continuing...');
    }

    log('[INFO] Submitting prompt...');
    let sendBtn = page.locator('button.fai-SendButton, button[data-test-id="send-button"]').first();
    try { await sendBtn.waitFor({ state: 'visible', timeout: 3000 }); } catch(e) {}
    
    if (await sendBtn.isVisible()) {
        await sendBtn.click();
    } else {
        log('[INFO] Send button not found, submitting via Enter key...');
        await chatInput.focus();
        await page.keyboard.press('Enter');
    }

    // ---- Wait for the answer to finish, then capture it as markdown -------------------
    // Two M365 behaviours drive this code:
    //  1. Code blocks are virtualised (div.scriptor-component-code-block.scriptor-codeblock-virtualized),
    //     so the DOM only ever holds the lines currently on screen. Reading innerText yields a
    //     truncated payload plus gutter line numbers. The copy buttons return the full text.
    //  2. The message list is virtualised too, so the message action bar that holds
    //     "Copy Response" is only rendered once the end of the message is scrolled into view.
    const REPLY_SELECTOR = '[data-testid="lastChatMessage"] [data-testid="markdown-reply"], [data-testid="markdown-reply"]';
    const COPY_RESPONSE_SELECTOR = 'button[data-testid="CopyButtonTestId"], button[aria-label="Copy Response"]';
    const CODE_GROUP_SELECTOR = 'div[role="group"][aria-label="Code Preview"]';

    const scrollToBottom = async () => {
        await page.evaluate(() => {
            const sentinel = document.querySelector('[data-testid="scroll-bottom-sentinel"]');
            if (sentinel && sentinel.scrollIntoView) sentinel.scrollIntoView({ block: 'end' });
            document.querySelectorAll('*').forEach((el) => {
                if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200) el.scrollTop = el.scrollHeight;
            });
        }).catch(() => {});
    };

    const getReplyText = async () => page.evaluate((selector) => {
        const nodes = [...document.querySelectorAll(selector)];
        let best = '';
        for (const node of nodes) {
            const t = (node.innerText || '').trim();
            if (t.length > best.length) best = t;
        }
        return best;
    }, REPLY_SELECTOR);

    const readClipboard = async () => page.evaluate(async () => {
        try { return await navigator.clipboard.readText(); } catch (e) { return ''; }
    });

    const clearClipboard = async () => page.evaluate(async () => {
        try { await navigator.clipboard.writeText(''); } catch (e) { /* no clipboard */ }
    });

    log('[INFO] Waiting for the reply to finish (Copy Response button)...');
    const POLL_MS = 2500;
    const MAX_POLLS = 288; // ~12 minutes
    let finished = false;

    for (let i = 0; i < MAX_POLLS; i++) {
        await page.waitForTimeout(POLL_MS);
        await scrollToBottom();
        const copyCount = await page.locator(COPY_RESPONSE_SELECTOR).count().catch(() => 0);

        if (i % 8 === 0) {
            const chars = (await getReplyText()).length;
            log(`[INFO] ...still waiting (${Math.round((i + 1) * POLL_MS / 1000)}s, ${chars} chars on screen, copyBtn=${copyCount})`);
        }
        if (copyCount > 0) { finished = true; break; }
    }
    if (!finished) {
        warn('[WARN] The reply never exposed a "Copy Response" button; capturing what is reachable.');
    } else {
        log('[INFO] Reply is complete.');
        await page.waitForTimeout(2000);
    }

    const hasContent = (text) => !!text && text.trim().length > 0;

    // --- Capture 1: the message-level "Copy Response" button gives the raw markdown ---------
    // The button lives in a hover-revealed action bar, so hover its container before clicking
    // and verify the clipboard actually changed.
    let responseText = '';
    try {
        const copyResponse = page.locator(COPY_RESPONSE_SELECTOR).last();
        if (await copyResponse.count() > 0) {
            const actionBar = page.locator('[data-testid="CopyButtonContainerTestId"]').last();
            for (let attempt = 1; attempt <= 4 && !hasContent(responseText); attempt++) {
                await clearClipboard();
                try {
                    await actionBar.scrollIntoViewIfNeeded();
                    await actionBar.hover();
                    await page.waitForTimeout(800);
                } catch (e) { /* hover is only a hint */ }
                try {
                    if (attempt <= 2) await copyResponse.click();
                    else await copyResponse.evaluate((el) => el.click());
                } catch (e) {
                    await copyResponse.click({ force: true }).catch(() => {});
                }
                await page.waitForTimeout(2500);
                responseText = await readClipboard();
                if (!hasContent(responseText)) {
                    warn(`[WARN] "Copy Response" produced no clipboard content on attempt ${attempt}/4.`);
                }
            }
            if (hasContent(responseText)) {
                log(`[INFO] Captured the reply via "Copy Response" (${responseText.length} chars).`);
            }
        } else {
            warn('[WARN] The "Copy Response" button was not present.');
        }
    } catch (e) {
        warn(`[WARN] "Copy Response" capture failed: ${e.message.split('\n')[0]}`);
    }

    // --- Capture 2: rebuild the reply from the per-block "Copy code" buttons ----------------
    // Used when Copy Response is unavailable, or when it returned text without the fences that
    // the payloads clearly require. Each code block is copied in full, so virtualisation of the
    // block content cannot truncate anything.
    const codeGroupCount = await page.locator(CODE_GROUP_SELECTOR).count().catch(() => 0);
    const needsBlockCapture = !hasContent(responseText) || (codeGroupCount > 0 && !responseText.includes('```'));

    if (needsBlockCapture && codeGroupCount > 0) {
        warn(`[WARN] Rebuilding the reply from ${codeGroupCount} code block(s) via "Copy code"...`);
        try {
            const layout = await page.evaluate(({ replySel, groupSel }) => {
                const roots = [...document.querySelectorAll(replySel)];
                let root = null;
                let bestLen = -1;
                for (const r of roots) {
                    const len = (r.innerText || '').length;
                    if (len > bestLen) { root = r; bestLen = len; }
                }
                if (!root) return [];
                const out = [];
                const walk = (node) => {
                    for (const child of node.children) {
                        if (child.matches(groupSel)) { out.push({ type: 'code' }); continue; }
                        if (child.querySelector(groupSel)) { walk(child); continue; }
                        const t = (child.innerText || '').trim();
                        if (t) out.push({ type: 'text', value: t });
                    }
                };
                walk(root);
                return out;
            }, { replySel: REPLY_SELECTOR, groupSel: CODE_GROUP_SELECTOR });

            const groups = page.locator(CODE_GROUP_SELECTOR);
            const total = await groups.count();
            const blockContents = [];
            for (let i = 0; i < total; i++) {
                const group = groups.nth(i);
                await group.scrollIntoViewIfNeeded().catch(() => {});
                await clearClipboard();
                const btn = group.locator('button#copy-button, button[aria-label="Copy code"]').first();
                await btn.click({ force: true });
                await page.waitForTimeout(1200);
                let text = await readClipboard();
                if (!hasContent(text)) {
                    await page.waitForTimeout(1500);
                    text = await readClipboard();
                }
                blockContents.push(text.replace(/\s*$/, ''));
                log(`[INFO]   code block ${i + 1}/${total}: ${text.length} chars`);
            }

            const pieces = [];
            let blockIndex = 0;
            let lastPath = '';
            // Markdown collapses two consecutive source lines into a single paragraph, so the
            // "Scan window:" line and the first path arrive glued together. Re-split them.
            const SCAN_WINDOW_GLUE = /^(Scan window:\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+to\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+\S+)\s+(\S.*)$/i;
            for (const item of layout) {
                if (item.type === 'text') {
                    const glued = item.value.match(SCAN_WINDOW_GLUE);
                    const value = glued ? `${glued[1]}\n${glued[2]}` : item.value;
                    pieces.push(value);
                    const tail = value.split('\n').pop().trim();
                    if (/\.(md|json)$/i.test(tail)) lastPath = tail;
                } else {
                    const lang = /\.json$/i.test(lastPath) ? 'json' : 'markdown';
                    pieces.push('```' + lang + '\n' + (blockContents[blockIndex] || '') + '\n```');
                    blockIndex++;
                }
            }
            const rebuilt = pieces.join('\n').trim();
            if (hasContent(rebuilt)) {
                responseText = rebuilt;
                log(`[INFO] Rebuilt ${responseText.length} chars from the code blocks.`);
            }
        } catch (e) {
            warn(`[WARN] Code block capture failed: ${e.message.split('\n')[0]}`);
        }
    }

    if (!hasContent(responseText)) {
        fail('[ERROR] Could not capture the assistant response from the page.');
    }

    const outDir = path.dirname(outputFilePath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    
    fs.writeFileSync(outputFilePath, responseText, 'utf8');
    log(`[INFO] Saved final response to ${outputFilePath}`);

    await context.close();
}

module.exports = { runCopilot };
