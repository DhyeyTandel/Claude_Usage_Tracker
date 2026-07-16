# Manual QA Checklist — Clean-Install Smoke Test

Run this checklist before every release to confirm the app behaves correctly
for a user with no prior local state.

---

## Prerequisites

- Node.js 18+ and npm installed
- `npm install` completed in the project root
- `npm run build` passes without errors

---

## 1. Simulate a clean install

The goal is to remove every source of local state so the app starts as if
freshly installed on a new machine.

```bash
# 1a. Back up your real Claude credentials
mv ~/.claude ~/.claude.bak

# 1b. Delete the electron-store config (if it exists)
rm -f ~/Library/Application\ Support/claude-usage-tracker/config.json      # macOS
# rm -f %APPDATA%\claude-usage-tracker\config.json                         # Windows

# 1c. (Optional) Clear the electron-log so only this session's output is visible
rm -f ~/Library/Logs/claude-usage-tracker/main.log                         # macOS
# rm -f %USERPROFILE%\AppData\Local\claude-usage-tracker\logs\main.log     # Windows
```

---

## 2. Launch the app

```bash
npm run dev
```

Click the tray icon to open the popover.

---

## 3. Walk through each section

### 3a. Tray icon

| Check | Expected |
|---|---|
| Icon visible in the system tray / menu bar | `disconnected-0.png` (grey ring, 0%) |
| Hover tooltip | `Claude Code Usage Tracker\nStatus: disconnected\nError: Rate limit fetch failed` |

### 3b. Main panel — SESSION · 5H

| Check | Expected |
|---|---|
| Section heading | `SESSION · 5H` |
| Reset countdown | `disconnected` (not a countdown) |
| Body content | Italicised: *Requires a Claude Pro/Max subscription with Claude Code signed in* |
| No raw errors or stack traces visible | ✅ |

### 3c. Main panel — WEEKLY LIMITS

| Check | Expected |
|---|---|
| Section heading | `WEEKLY LIMITS` |
| Body content | Italicised: *Requires a Claude Pro/Max subscription with Claude Code signed in* |
| No raw errors or stack traces visible | ✅ |

### 3d. Main panel — SPEND · THIS MONTH

| Check | Expected |
|---|---|
| Section heading | `SPEND · THIS MONTH` |
| Body content | Italicised: *Add an Admin API key in Settings to see spend* |
| No raw errors or stack traces visible | ✅ |

### 3e. Status footer

| Check | Expected |
|---|---|
| Status dot | Grey (disconnected) |
| Status text | `disconnected · updated just now` (or seconds/minutes depending on timing) |
| Refresh button | Clickable; after click, status remains `disconnected` (no crash) |

### 3f. Header badge

| Check | Expected |
|---|---|
| Plan badge | No badge visible (neither `PRO` nor `API`) |

---

## 4. Settings panel

Click the gear icon to open Settings.

| Check | Expected |
|---|---|
| Admin API Key field | Empty; placeholder shows `sk-ant-admin...` |
| Monthly Budget | `100` (default) |
| Rate-Limit Poll Interval | `300` (default) |
| Spend Report Poll Interval | `300` (default) |
| Launch app at login | Unchecked |
| Source Found (credentials) | `NONE` badge |
| Test Connection button | Clickable; result shows `Fail: No credentials found` |
| Save button | Saves without error; returns to main panel |
| Cancel button | Returns to main panel without error |
| Reset All Data button | Two-click confirm works; returns all fields to defaults |

---

## 5. Settings edge case: open and close before first poll

This tests the null-data guard fix. Immediately after launch:

1. Click tray icon to open popover
2. Click gear icon to open Settings
3. Click Cancel **immediately** (before the first poll cycle finishes)
4. Verify: main panel renders without crash, shows initial empty states

---

## 6. Check electron-log output

```bash
cat ~/Library/Logs/claude-usage-tracker/main.log     # macOS
# type %USERPROFILE%\AppData\Local\claude-usage-tracker\logs\main.log  # Windows
```

| Check | Expected |
|---|---|
| `uncaughtException` | Not present |
| `unhandledRejection` | Not present |
| `TypeError` | Not present |
| `Rate Limit fetch failed: No credentials found` | ✅ Expected (gracefully handled) |
| `Application starting...` | ✅ Present |

---

## 7. Restore your environment

```bash
mv ~/.claude.bak ~/.claude
```

---

## 8. Verify normal operation after restore

```bash
npm run dev
```

Click the tray icon. Confirm:
- SESSION · 5H shows a real percentage and gauge
- WEEKLY LIMITS shows All models with a real percentage
- Status footer shows `allowed` with a green dot
- Token counts show `in` / `out` values (if you've used Claude Code today)

---

## Quick reference: what to grep for in logs

```bash
# Should find nothing (indicates a crash or unhandled error):
grep -iE "uncaughtException|unhandledRejection|TypeError|Cannot read prop" \
  ~/Library/Logs/claude-usage-tracker/main.log

# Should find graceful error handling lines:
grep -i "No credentials found\|Rate Limit fetch failed\|fetch failed" \
  ~/Library/Logs/claude-usage-tracker/main.log
```
