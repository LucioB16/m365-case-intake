# M365 Case Intake

**Turn Outlook support-case threads into structured, reusable context for coding agents.**

This Agent Skill uses Microsoft 365 Copilot through Playwright and a deterministic local parser to write case histories into OneDrive-synced Markdown. Agents receive a consistent `AGENTS.md` / `CLAUDE.md` context structure while case updates remain append-oriented and checked against an output contract.

[![License: MIT](https://img.shields.io/badge/license-MIT-426e5a)](LICENSE)

| Collect | Normalize | Continue |
| :-- | :-- | :-- |
| Request daily or case-specific mail context through M365 Copilot. | Parse validated output into client folders, messages and environment notes. | Reuse local context without reconstructing every conversation. |

> [!IMPORTANT]
> Client emails and support details can contain sensitive data. Configure authentication, redaction, local paths and retention for your organization before processing real cases.

## Installation

To equip your AI Coding Agent (e.g. Codex, Claude Code, Cursor, GitHub Copilot, Antigravity) with this skill:

1. Clone this repository into your local machine.
2. Direct your agent to read the `SKILL.md` file in the root of the repository.
3. Tell your agent: *"Run the setup wizard for the M365 Case Intake skill."*

## First-time setup

Before using the skill, ask your AI Coding Agent to configure it:

1. The AI Agent will interactively ask you for your preferences (Name, Email, OneDrive path, Timezone, Products, etc.).
2. The AI Agent will generate a `config.json` file in the root directory.
3. The AI Agent will run `npm install` and `npm run setup`.
4. An Edge browser window will open automatically for you to log into M365 Copilot (close it when done).

## Usage

Because this is an Agent Skill, you don't need to run terminal commands manually. Just ask your AI Coding Agent to do it for you!

### Example Prompts
- **Daily Sync**: *"Run the M365 case intake skill to sync my daily cases."*
- **On-Demand Fetch**: *"Fetch the case CAS-1455051-S3F0 from the last 30 days using the case intake skill."*
- **Environments**: *"Scaffold the ENVIRONMENTS.md files for my clients."*

The agent will automatically read the `SKILL.md` instructions and execute the underlying Node scripts on your behalf.

## Output structure

```text
Client Cases/
  Contoso Ltd/
    ENVIRONMENTS.md                      the client's Dynamics environments
    CAS-1234567-A1B2 - Case title/
      AGENTS.md                          case header, agent instructions, activity log
      CLAUDE.md
      messages/                          full text of sent and received messages
        2026-08-26_15-57_Received.md
        images/
```

The model never touches this tree. It returns text, and the local parser writes it.

## Capabilities

- **Coding-agent oriented**: Designed for agents that can follow `SKILL.md` and run the repository's scripts; compatibility depends on each harness.
- **Strict output contract**: M365 Copilot returns machine-parseable payloads, and a narrative
  answer is reported as a failure instead of being silently treated as an empty run.
- **Append-only by design**: existing case files are never reprinted by the model. Copilot emits
  just the new Activity log entry and the local parser appends it, so history cannot be lost.
- **Environments per client**: an `ENVIRONMENTS.md` in each account folder supplies the Dynamics
  environment URL when a case email does not contain one. It handles clients that run several
  sets of environments, keeps D365 Finance & Operations environments separate from CRM, and
  rejects internal ticketing systems so they can never be mistaken for a client environment.
- **Idempotent**: re-running the same window appends nothing twice.
- **Auto-Discovery**: Automatically resolves your local OneDrive path based on system environment variables.
- **Data Obfuscation**: Toggleable PII redaction (names, IPs, server paths) to strictly respect client security policies.
- **Git Ready**: Automatically instructs coding agents to initialize local git repositories within case folders to track progress and prevent context loss.
- **Dual Modes**: Run full daily batch syncs or targeted on-demand single case fetches.

## Run verdicts

Every run ends with an explicit verdict, so a chatty or incomplete answer can never look like a
success:

| Exit code | Verdict | Meaning |
| --- | --- | --- |
| 0 | `CHANGES` / `NO_CHANGES` | Files were written or appended, or there was genuinely nothing to do |
| 1 | `INVALID` | The reply broke the output contract; nothing was written |
| 2 | `PARTIAL` | The reply was valid but some payloads could not be applied |
| 3 | failure | Config, browser or model-selection problem |

See `SKILL.md` for the full output contract, the parser's safety guarantees and troubleshooting.

## Development

```bash
npm test              # contract, parser, environments and prompt-pipeline tests
npm run prompt        # render the prompt without contacting M365
npm run environments  # report ENVIRONMENTS.md coverage per client
npm run normalize     # align the Agent Instructions block in every case file
```

Every write command is a dry run by default and prints what it would do. Pass `-- --write` to
apply it.
