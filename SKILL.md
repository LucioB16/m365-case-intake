---
name: m365-case-intake
description: "M365 Copilot automated case intake syncing to OneDrive"
---

# M365 Case Intake Skill

This skill allows you (the AI Coding Agent) or the user to run deterministic M365 Copilot case intakes, persisting support cases directly to the local filesystem (OneDrive) using Playwright automation.

## Initial Setup
Before using this skill for the first time, you (the AI Agent) MUST guide the user through the setup process:
1. Navigate to the directory where this repository was cloned.
2. Run `npm install`.
3. **DO NOT run setup yet.** First, interactively ask the user for their preferences (one by one or as a form) to generate `config.json` in the root directory. You must ask for:
   - Full Name
   - Work Email
   - Path to OneDrive cases folder (e.g., `C:/Users/Name/OneDrive/Client Cases`)
   - Timezone (e.g., `America/Buenos_Aires`)
   - Products to track (comma-separated, e.g., `CRM, Power Platform`)
   - Lookback window in hours (e.g., `24`)
   - Scope of tracking (`ALL` or `ASSIGNED_ONLY`)
   - Enable Data Obfuscation (boolean, true/false)
4. Create the `config.json` file securely with the user's answers.
5. Run `npm run setup`. This will launch an interactive browser for the user to log into M365 Copilot. Wait for the user to close the browser.

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

## 🚑 Troubleshooting / Agent Fallbacks

If you (the AI Agent) run the intake scripts and the console output says `No file payload blocks found.`, it means M365 Copilot was too conversational and ignored the strict markdown block formatting rules. When this happens, you MUST execute this fallback protocol:

1. Read the raw response output saved in `./logs/latest_response.md`.
2. Analyze the prose summary provided by Copilot to identify the new cases, assignments, or portal comments it found.
3. Read `./prompts/base_intake.yaml` to understand the required `agents.md` and `claude.md` file schemas.
4. Manually generate and write the case files directly into the user's configured OneDrive directory using your own file-writing tools. Do not bother running `parser.js` again; just create the folders and files yourself based on the data Copilot returned.

## Internal Architecture
- `config.json`: The user's preferences.
- `prompts/base_intake.yaml`: The template instruction for Copilot.
- `scripts/lib/playwright_runner.js`: The headless browser automation bridging Node and M365.
- `scripts/lib/parser.js`: Reads the payload from Copilot and writes it safely to `agents.md` inside OneDrive.
