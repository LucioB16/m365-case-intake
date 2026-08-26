# M365 Case Intake Skill

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Codex](https://img.shields.io/badge/Codex-compatible-blue)](https://github.com/LucioB16/m365-case-intake)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-orange)](https://github.com/LucioB16/m365-case-intake)

Automated M365 Copilot case intake and syncing skill for AI Coding Agents.

This repository provides an automated, deterministic workflow for extracting support cases from Outlook via Microsoft 365 Copilot (using Playwright automation) and persisting them into locally synced OneDrive folders as context-ready markdown files (`AGENTS.md` & `CLAUDE.md`).

## 🚀 Features

- **Agent Agnostic**: Works flawlessly with Codex, Claude Code, Cursor, GitHub Copilot, Antigravity, and others.
- **Auto-Discovery**: Automatically resolves your local OneDrive path based on system environment variables.
- **Data Obfuscation**: Toggleable PII redaction (names, IPs, server paths) to strictly respect client security policies.
- **Git Ready**: Automatically instructs coding agents to initialize local git repositories within case folders to track progress and prevent context loss.
- **Dual Modes**: Run full daily batch syncs or targeted on-demand single case fetches.

## 🔌 Installation

To equip your AI Coding Agent (e.g. Codex, Claude Code, Cursor, GitHub Copilot, Antigravity) with this skill:

1. Clone this repository into your local machine.
2. Direct your agent to read the `SKILL.md` file in the root of the repository.
3. Tell your agent: *"Run the setup wizard for the M365 Case Intake skill."*

## ⚙️ Setup

Before using the skill, ask your AI Coding Agent to configure it:

1. The AI Agent will interactively ask you for your preferences (Name, Email, OneDrive path, Timezone, Products, etc.).
2. The AI Agent will generate a `config.json` file in the root directory.
3. The AI Agent will run `npm install` and `npm run setup`.
4. An Edge browser window will open automatically for you to log into M365 Copilot (close it when done).

## 📦 Usage

Because this is an Agent Skill, you don't need to run terminal commands manually. Just ask your AI Coding Agent to do it for you!

### Example Prompts
- **Daily Sync**: *"Run the M365 case intake skill to sync my daily cases."*
- **On-Demand Fetch**: *"Fetch the case CAS-1455051-S3F0 from the last 30 days using the case intake skill."*

The agent will automatically read the `SKILL.md` instructions and execute the underlying Node scripts on your behalf.
