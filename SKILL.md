---
name: m365-case-intake
description: "M365 Copilot automated case intake syncing to OneDrive"
---

# M365 Case Intake Skill

This skill allows you (the AI Coding Agent) or the user to run deterministic M365 Copilot case intakes, persisting support cases directly to the local filesystem (OneDrive) using Playwright automation.

## Initial Setup
Before using this skill for the first time, you or the user MUST run the setup wizard:
1. Navigate to the skill directory: `cd C:\Users\LucioBottacin\Source\Personal\m365-case-intake`
2. Run `npm install`
3. Run `npm run setup`
4. Follow the interactive prompts in the terminal to configure the user's name, timezone, product filters, and OneDrive folder. The setup will also launch a browser to ensure the user is logged into M365 Copilot.

## Usage

Once `config.json` is generated, you can trigger workflows via npm scripts.

### 1. Daily Batch Sync
Syncs all cases matching the configured time window (default 24h) and configured products.
```bash
npm run batch
```

### 2. On-Demand Fetch (Single Case)
Fetches a specific case ignoring time restrictions and product filters.
```bash
npm run fetch "CAS-1234567-XXXX" "last 30 days"
```

## Internal Architecture
- `config.json`: The user's preferences.
- `prompts/base_intake.yaml`: The template instruction for Copilot.
- `scripts/lib/playwright_runner.js`: The headless browser automation bridging Node and M365.
- `scripts/lib/parser.js`: Reads the payload from Copilot and writes it safely to `agents.md` inside OneDrive.
