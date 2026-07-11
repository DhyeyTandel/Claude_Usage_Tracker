# Claude Usage Tracker

A compact desktop menu bar / system tray widget showing real-time **Claude Code (CLI)** utilization metrics and organization **Anthropic API spend**.

## Features

- **Session & Weekly Gauges**: Real-time horizonal tick-mark indicators tracking utilization for `SESSION · 5H` and `WEEKLY · 7D` windows.
- **Token Counters**: Monospace statistics showing `in` and `out` token summaries within a naive 5-hour window.
- **Admin API Spend Tracking**: Displays monthly cost breakdown (`Total`, `Tokens`, and `Budget` utilization).
- **Settings Panel**: Configure organization Admin API key, monthly budget constraints, refresh intervals, login items, and verify OAuth credentials connection.
- **Encrypted Local Storage**: The Admin API key is encrypted using Electron's `safeStorage` API before being persisted locally in `electron-store`.
- **System Tray Popover Design**: Resides strictly in the menu bar / system tray. Clicking the icon toggles a frameless, always-on-top window that hides automatically on losing focus (`blur`).

---

## Getting Started

### Prerequisites

Ensure you have **Node.js** (v18+) and **npm** installed on your system.

### Installation

Clone this repository and run the package installer:

```bash
npm install
```

### Development

To run the application locally in development mode:

```bash
# Starts Vite dev server and launches Electron app in watch mode
npm run dev
```

### Production Build

To compile TypeScript and bundle assets for production:

```bash
npm run build
```

To test the packaged output locally without building the installer:

```bash
npm run pack
```

### Packaging Installer

To package and compile standard installers (`.dmg` for macOS, `.exe` NSIS installer for Windows):

```bash
# Packages installers to the release/ directory
npm run dist
```

---

## Data Retrieval Mechanics

1. **Credentials Parsing**:
   - The main process searches for Claude Code OAuth tokens in `~/.claude/.credentials.json`.
   - On macOS, it falls back to querying the Keychain for `Claude Code-credentials` using the `security` CLI if the file is missing.
2. **Rate Limit Utilization**:
   - Performs a minimal, low-overhead request (`claude-haiku-4-5`, `max_tokens: 1`) to `https://api.anthropic.com/v1/messages` using the extracted Bearer token.
   - Extracts utilization and reset headers (`anthropic-ratelimit-unified-*`) which Anthropic uses for rate limiting.
3. **Local Token Globbing**:
   - Scans `~/.claude/projects/**/*.jsonl` every 5 seconds.
   - Sums tokens in the active 5-hour session for the latest project log and compiles today's total across all logs.
4. **API Cost Report**:
   - Authenticates using the configured Admin API key (`sk-ant-admin...`).
   - Retrieves daily cost allocations and token records for the calendar month via `/v1/organizations/cost_report` and `/v1/organizations/usage_report/messages`.
5. **Background Suspension**:
   - Background polling automatically suspends when the popover widget window is hidden or blurred, preventing background API requests and saving token quotas.

---

## Logging & Diagnostics

Logs are automatically generated for diagnosing connections, credentials, or API issues. The log files reside under standard OS log directories:

- **macOS**: `~/Library/Logs/claude-usage-tracker/main.log`
- **Windows**: `%USERPROFILE%\AppData\Local\claude-usage-tracker\logs\main.log`
