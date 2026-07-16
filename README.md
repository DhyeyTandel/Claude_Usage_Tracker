# Claude Usage Tracker

A compact desktop menu bar / system tray widget showing real-time **Claude Code (CLI)** utilization metrics and organization **Anthropic API spend**.

## Privacy & data access

- **What it reads.** The app reads Claude Code’s local OAuth token from `~/.claude/.credentials.json`, or from the macOS Keychain item `Claude Code-credentials` if the file isn’t there. It also reads local JSONL session logs under `~/.claude/projects/` for the in/out token counts. An Anthropic Admin API key is only read if you choose to add one in Settings.

- **What it sends and where.** Outbound requests go only to `api.anthropic.com`, using your own credentials to read your own usage and spend. Nothing is sent to any third-party server, and there is no telemetry or analytics of any kind.

- **Where data lives locally, and how to remove it.** App settings and the encrypted Admin API key (if you added one) are stored by electron-store at `~/Library/Application Support/claude-usage-tracker/config.json` on macOS, or `%APPDATA%\claude-usage-tracker\config.json` on Windows. Diagnostic logs from electron-log live at `~/Library/Logs/claude-usage-tracker/main.log` on macOS, or `%USERPROFILE%\AppData\Local\claude-usage-tracker\logs\main.log` on Windows. Use **Reset all data** in Settings to clear the store; uninstalling on macOS does not automatically delete these files, so delete the paths above for a full wipe.

## Who Can Use This

Each section of the widget has different account requirements:

| Feature | Requirement |
|---|---|
| Session & weekly limit gauges | **Claude Pro or Max subscription**, signed into Claude Code (reads subscription rate-limit headers) |
| Local token counters (in/out) | Any Claude Code usage (reads local `~/.claude` logs) |
| Monthly API spend | An **Anthropic Console Admin API key** (`sk-ant-admin...`) — no subscription needed |

**Free-plan users:** Claude's free plan does not include Claude Code, and Anthropic exposes no public API for free-plan usage limits, so the gauges will show an empty state. The header badge reflects what was detected: `PRO` (subscription limits live), `API` (Admin key only), or no badge.

## Features

- **Session & Weekly Gauges**: Real-time horizonal tick-mark indicators tracking utilization for `SESSION · 5H` and `WEEKLY · 7D` windows.
- **Token Counters**: Monospace statistics showing `in` and `out` token summaries within a naive 5-hour window.
- **Admin API Spend Tracking**: Displays monthly cost breakdown (`Total`, `Tokens`, and `Budget` utilization).
- **Telegram Notifications**: Instantly alerts you via a Telegram bot when Claude limits refresh (both the 5-hour rolling window decay and surprise Anthropic-wide limit resets). Can also send a scheduled weekly usage summary (day and time configurable).
- **Theme Selection**: Explicit custom 3-way segmented switch in Settings to force Light Mode, Dark Mode, or follow the System Preference.
- **Settings Panel**: Configure organization Admin API key, monthly budget constraints, refresh intervals, login items, and verify OAuth credentials connection.
- **Encrypted Local Storage**: Sensitive keys (Admin API key and Telegram bot token) are encrypted using Electron's `safeStorage` API before being persisted locally in `electron-store`.
- **System Tray Popover Design**: Resides strictly in the menu bar / system tray. Clicking the icon toggles a frameless, always-on-top window that hides automatically on losing focus (`blur`).

---

## Telegram Setup

To receive notifications via Telegram:

1. Chat with `@BotFather` on Telegram, type `/newbot`, and follow the steps to create a bot. Copy the **Bot Token** (`123456789:ABCdef...`).
2. Open a chat with your new bot and send a message (e.g., "hello").
3. Retrieve your **Chat ID** by visiting `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in your browser. Look for the `"chat":{"id":...}` field.
4. Open Claude Usage Tracker settings, check **Enable Telegram notifications**, paste the Token and Chat ID, and click **Test Notification** to verify.

---

## Getting Started

### Prerequisites

Ensure you have **Node.js** (v18+) and **npm** installed on your system.

### Installation

#### macOS (via Homebrew Cask)

You can install the desktop widget using Homebrew Cask. Since Homebrew requires all casks to be loaded from a tap, you can install it using one of the options below.

**Option 1: Local Installation (for testing/development)**
If you've cloned this repository, you can create a local tap and load the cask from it:
```bash
# 1. Create a new local tap
brew tap-new local/claude-usage-tracker

# 2. Create the Casks directory and copy the cask file into the tap
mkdir -p $(brew --repository)/Library/Taps/local/homebrew-claude-usage-tracker/Casks/
cp Casks/claude-usage-tracker.rb $(brew --repository)/Library/Taps/local/homebrew-claude-usage-tracker/Casks/

# 3. Install it
brew install --cask local/claude-usage-tracker/claude-usage-tracker
```

**Option 2: Via a Personal Tap**
To install or share it as a standard tap:
1. Create a public GitHub repository named `homebrew-tap` (or similar).
2. Place the [claude-usage-tracker.rb](file:///Users/dhyeytandel/Dhyey_Gemini/Projects/Claude_Usage_Tracker/Casks/claude-usage-tracker.rb) formula in a `Casks` folder inside that repository.
3. Users can then install it using:
   ```bash
   brew install --cask dhyeytandel/tap/claude-usage-tracker
   ```

#### From Source (Development / Custom Build)

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

### Building a signed release

macOS release builds use Developer ID signing and Apple notarization. Before the first signed release, replace the `YOUR_NAME` and `YOUR_TEAM_ID` placeholders in `build.mac.identity` in `package.json` with the exact name of the installed Developer ID Application certificate.

Export these values from your Apple Developer account; do not add them to source control:

```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="your-app-specific-password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

With that certificate installed in your login keychain, build the signed and notarized release with:

```bash
npm run dist
```

#### Windows

Windows release builds use a standard `.pfx` code-signing certificate (PKCS#12). Two certificate grades are available from certificate authorities such as DigiCert or Sectigo:

| Type | SmartScreen reputation |
|---|---|
| **OV (Organization Validation)** | Reputation is built gradually — a new OV certificate will still trigger a SmartScreen warning until your installer accumulates enough download volume across users. |
| **EV (Extended Validation)** | Reputation is granted immediately at issuance — SmartScreen warnings are bypassed from the first download. EV certificates require hardware-token verification and cost more. |

electron-builder reads the certificate path and password from environment variables — **never hardcode these in source control**:

| Variable | Description |
|---|---|
| `WIN_CSC_LINK` | Path to your `.pfx` file, or a base64-encoded string of the certificate (preferred for CI). |
| `WIN_CSC_KEY_PASSWORD` | Password to decrypt the `.pfx`. |

> **Tip — base64 encoding for CI secrets:** `base64 -i certificate.pfx` (macOS/Linux) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx"))` (PowerShell).

Export these before building (do not commit them):

```bash
export WIN_CSC_LINK="/path/to/certificate.pfx"
export WIN_CSC_KEY_PASSWORD="your-pfx-password"
```

Then build the signed NSIS installer with:

```bash
npm run dist
```

> **SmartScreen "Windows protected your PC" — this is expected, not a bug.**
> Even a validly signed installer will show a SmartScreen warning if the signing certificate is new or if download volume is low (common with OV certs). This is Microsoft's reputation system at work, not a build error. Users can click *More info → Run anyway* to proceed. The warning will disappear automatically as the installer accumulates download reputation. An EV certificate bypasses this immediately. An unsigned build will always show the warning with no *Run anyway* option.

The normal `npm run build` command above remains unsigned and is intended for local development and CI checks that do not have signing credentials.

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
