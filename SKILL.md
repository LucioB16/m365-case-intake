---
name: m365-case-intake
description: "M365 Copilot automated case intake syncing to OneDrive"
---

# M365 Case Intake Skill

This skill lets you (the AI Coding Agent) or the user run deterministic M365 Copilot case
intakes and persist support cases to the local filesystem (OneDrive) using Playwright.

## Division of responsibilities

This is the rule the whole design depends on:

| Actor | Responsibility |
| --- | --- |
| M365 Copilot (Claude Opus) | Query Outlook, classify the emails, and **print** either the full content of a brand new file or the single Activity log entry to add to an existing one. |
| The local Node.js scripts | Validate the reply against the output contract and **write or append** to disk, and maintain `.intake_index.json`. |

M365 Copilot never writes files, never reads existing case files, and is never asked to. If
it ever answers "I cannot create local files", that is a contract violation, not a
limitation, and the run is reported as `INVALID`.

## Initial Setup

Before using this skill for the first time, you (the AI Agent) MUST guide the user through setup:
1. Navigate to the directory where this repository was cloned.
2. Run `npm install`.
3. **DO NOT run setup yet.** First, interactively ask the user for their preferences to generate
   `config.json` in the root directory. You must ask for:
   - Full Name
   - Work Email
   - Path to OneDrive cases folder (e.g., `C:/Users/Name/OneDrive/Client Cases`)
   - Timezone (e.g., `America/Buenos_Aires`)
   - Products to track (comma-separated, e.g., `CRM, Power Platform`)
   - Lookback window in hours (e.g., `24`)
   - Scope of tracking (`ALL` or `ASSIGNED_ONLY`)
   - Enable Data Obfuscation (boolean, true/false)
4. Create the `config.json` file securely with the user's answers.
5. Run `npm run setup`. This launches an interactive browser for the user to log into M365
   Copilot. Wait for the user to close the browser.

Only the *name* of the OneDrive folder is ever sent to M365 Copilot. The absolute local path
stays on the machine and is used solely by the parser; `buildPrompt` refuses to send a prompt
that contains a local absolute path, because showing Copilot a `C:\...` path is what used to
make it answer "I cannot write to your local drive".

## Usage

```bash
npm run batch                                  # daily sync over the configured lookback window
npm run fetch "CAS-1234567-XXXX" "last 30 days" # on-demand single case
npm run prompt                                 # render the prompt only, no M365 call
npm run environments                           # report ENVIRONMENTS.md coverage per client
npm run parse                                  # re-parse logs/latest_response.md
npm test                                       # contract, parser and prompt tests
```

## Output contract

`prompts/base_intake.yaml` requires the reply to be exactly one of two shapes.

**SHAPE A — something changed.** One payload per file, each introduced by a path line and
followed immediately by a fenced block:

````text
Scan window: 2026-08-27 12:00 to 2026-08-28 12:00 America/Argentina/Buenos_Aires
Account Name/CAS-1234567-A1B2 - New Case/AGENTS.md
```markdown
<complete content of the new file>
```
APPEND Account Name/CAS-7654321-Z9Y8 - Existing Case/AGENTS.md
```markdown
[Portal Comment] 2026-08-28 11:42 (local) - Someone
<the comment>
```
````

- A plain path line means "this is the complete content of a **new** file". Used for
  `NEW_CASE` emails, which carry every header field.
- `APPEND <path>` means "this is **only** the new Activity log entry". Used for
  `PORTAL_COMMENT` and `ASSIGN_CASE` emails. Copilot never reprints an existing file, so it
  can never truncate one.
- No prose, no headings, no bullets, no recap, no truncation, no unresolved `<slots>`, no
  invented filler such as `[needs verification]`, no notes to the reader inside a payload.
- `.intake_index.json` must not be emitted; the parser owns it. If it is emitted anyway it is
  ignored with a warning.

**SHAPE B — nothing changed.** Exactly two lines:

```text
Scan window: 2026-08-27 12:00 to 2026-08-28 12:00 America/Argentina/Buenos_Aires
NO CHANGES
```

`NO CHANGES` is the only legitimate way to report an empty run. A narrative answer with no
payloads is never treated as success.

## Environment defaults per client

Case emails rarely contain the client's Dynamics environment URL, so `Environment URL:` was
empty in 45 of 54 case files, and the few that were filled had picked up the internal Arbela
ticketing CRM by mistake.

Each account folder therefore carries an `ENVIRONMENTS.md`:

```text
# Environments - Woodforest

DEV: https://woodforestsalesdevr2.crm.dynamics.com
PROD: https://woodforestsales.crm.dynamics.com

Default: DEV
```

- One line per environment, `LABEL: url`. Everything else in the file is free-form notes.
- `Default:` selects the label to use. Without it the **lowest** environment wins, following
  the promotion ladder DEV, SANDBOX, QA, TEST, UAT, STAGING, PREPROD, PROD. A client that only
  has PROD therefore defaults to PROD.
- URLs are reduced to their origin, so pasting a full `main.aspx?appid=...` link is fine.
- Internal Arbela and Argano hosts are rejected by the parser and must not be listed.

When a **new** case file is written with a blank `Environment URL:`, the parser fills it with
the default and injects the whole list underneath, for example:

```text
Environment URL: https://woodforestsalesdevr2.crm.dynamics.com (DEV account default)
Environments:
- DEV: https://woodforestsalesdevr2.crm.dynamics.com
- PROD: https://woodforestsales.crm.dynamics.com
```

The marker matters: it tells a later reader the value was inherited from the account, not
confirmed for that specific case. A URL that really came from the email is never overwritten,
and `APPEND` payloads are never touched.

Scaffold or review the files with:

```bash
npm run environments             # report only, writes nothing
npm run environments -- --write  # create the missing files
npm run environments -- --write --fix-default   # realign a stale Default line
```

Existing `ENVIRONMENTS.md` files are never overwritten; they are hand-maintained. New ones are
pre-filled with the client URLs already found in that account's cases, with internal systems
filtered out, and marked "please verify".

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | `CHANGES` (files written/appended) or `NO_CHANGES` (nothing to do) |
| 1 | `INVALID` — the reply broke the output contract; nothing was written |
| 2 | `PARTIAL` — the reply was valid but some payloads could not be applied |
| 3 | The run itself failed (config, browser, model selection) |

## Safety guarantees in the parser

- Paths that resolve outside the configured root are refused.
- Path segments are matched against the folders that actually exist, so `McWane, Inc.` finds
  `McWane, Inc` instead of creating a duplicate account folder.
- `APPEND` is idempotent **per Activity log entry**: an entry that is already in the file is
  never appended twice, even when Copilot re-sends it bundled with a new one.
- `APPEND` to a case that was never ingested is refused with `APPEND_TARGET_MISSING` and the
  exact `npm run fetch` command to recover it.
- Full-content payloads for a file that already exists are refused with `CONTENT_LOSS` if any
  existing line would disappear.
- Identical payloads are reported as `UNCHANGED` and not rewritten.
- `.intake_index.json` is rebuilt locally from the files actually touched; entries from
  previous runs are never dropped, and a corrupt index is left untouched and reported.
- Truncation markers, unresolved slots, invented filler, reader notes and unclosed fences make
  the whole run `INVALID`.

## Browser automation notes

`scripts/lib/playwright_runner.js` depends on three M365 behaviours that are easy to get wrong:

- **Model selection**: the Claude entry is `#gptSubMenuModelTrigger-Claude` (an `id`, not a
  `data-test-id`). Opus is verified via `aria-checked` before continuing; the run aborts if it
  cannot be selected, because another model would invalidate the run.
- **Code blocks are virtualised** (`div.scriptor-component-code-block`), so the DOM only holds
  the lines currently on screen. Payloads are captured through the copy buttons, never by
  reading text out of the DOM.
- **The message list is virtualised too**, so the "Copy Response" button
  (`button[data-testid="CopyButtonTestId"]`) only appears once the end of the message is
  scrolled into view. Its presence is the completion signal.

Every log line is timestamped with wall clock and elapsed seconds, so a slow run can be
attributed to the right stage. In practice most of a run is Copilot thinking, not startup.

## 🚑 Troubleshooting

Read the contract report printed by the run. It names every violation, e.g.
`CAPABILITY_REFUSAL`, `PROMPT_REVIEW`, `NO_PAYLOAD_NO_MARKER`, `TRUNCATED_PAYLOAD`,
`INVENTED_PLACEHOLDER`, `META_NOTE_IN_PAYLOAD`, `CONTENT_LOSS`, `APPEND_TARGET_MISSING`.

If the run reports `INVALID`, the correct response is to fix the cause and re-run
`npm run batch`, not to hand-write the log.

**Manual fallback (exceptional recovery only).** If one specific run must be salvaged, you may
rewrite `logs/latest_response.md` into the contract shape by hand and run `npm run parse`.
That recovers data for that one run. It is **not** evidence that the pipeline works and must
never be used to declare the skill fixed.

## Internal Architecture
- `config.json`: user preferences (never sent verbatim to M365).
- `prompts/base_intake.yaml`: prompt template; it opens with an explicit "execute this now"
  directive and puts the output contract near the top.
- `scripts/lib/prompt_builder.js`: renders the template, asserts no placeholder or local path leaks.
- `scripts/lib/playwright_runner.js`: headless Edge bridge, model verification, prompt-length
  verification, and copy-button based capture.
- `scripts/lib/response_contract.js`: classifies the reply as `CHANGES` / `NO_CHANGES` / `INVALID`
  and extracts payloads.
- `scripts/lib/parser.js`: writes and appends validated payloads, and maintains the index.
- `scripts/lib/environments.js`: reads the per-account `ENVIRONMENTS.md` and resolves its default.
- `tests/`: `node --test` suite for the contract, the parser and the prompt pipeline.
