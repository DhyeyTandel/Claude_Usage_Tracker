# Claude usage tracker — Antigravity build guide (v3)

A compact desktop widget that shows real Claude Code session/weekly usage plus Anthropic API spend — built fresh as an Electron app via Google Antigravity's agent, but reusing the proven data technique from your existing `CC_Usage_Monitor` project instead of guessing or self-logging. Paste each prompt below into the Antigravity agent sidebar in order; review what it produces before moving to the next.

## What changed from v1, and why

Your `CC_Usage_Monitor` folder already solves the hardest problem: getting a *real* session (5h) and weekly (7d) usage percentage with no manual logging. It works by:

1. Reading Claude Code's own local OAuth token — from `~/.claude/.credentials.json`, or the macOS Keychain entry `Claude Code-credentials` via the `security` CLI (Windows equivalent: Windows Credential Manager, or the same JSON file path under the user's home directory).
2. Firing one minimal request (`claude-haiku-4-5`, `max_tokens: 1`) at `https://api.anthropic.com/v1/messages` with that token as a Bearer token.
3. Reading Anthropic's official response headers — `anthropic-ratelimit-unified-5h-utilization`, `-5h-reset`, `-5h-status`, `-7d-utilization`, `-7d-reset`, `-7d-status`, `-overage-utilization`, `-overage-status`, `-overage-reset` — which are the same numbers Anthropic itself uses to enforce the limits.
4. Separately, reading token counts straight out of `~/.claude/projects/**/*.jsonl` (no API call at all) for input/output counts.

That's a better source of truth than anything I proposed in v1, so this guide drops the "self-logged session cap" idea entirely and has Antigravity port that same technique into the new Electron app. One honest caveat to carry forward: this only measures **Claude Code (CLI)** usage — it says nothing about Claude.ai web chat — and it uses Claude Code's OAuth token outside of Claude Code itself, which sits in a gray area of Anthropic's OAuth-use policy. It's your own token reading your own usage locally, never leaving your machine or going to a third party, but it's worth knowing that's the trade-off versus the fully-sanctioned Admin API key path used for the spend numbers below.

## Design direction: warm instrument panel, not dashboard

You asked for something that doesn't read as generated — no glowing rings, no gradient cards, no icon soup, and (later revision) light and warm rather than dark, with fonts that don't scream "AI-generated app." The direction settled on:

- **Palette: warm paper + beige, not stark white or dark mode by default.** Popover surface `#FBF9F4`, a secondary beige surface `#EFE7D8`/`#F4EEE0` behind gauge tracks, tag pills, and the spend data-list block, hairline dividers in `#E9E4D8`, warm near-black text `#2B2A26` (not pure black), muted warm gray for secondary text `#8A8478`/`#5C5748`. Still support OS dark mode as a secondary palette, not the design target.
- **Tick-mark gauges instead of circular progress rings.** A beige track with small perpendicular ticks every 10%, a solid rust fill bar for the current value, and a faint dashed tick at the 90% warning line. Reads like a fuel gauge, not a loading spinner.
- **Typography with one deliberate serif moment.** Body/labels in IBM Plex Sans, all numeric data in IBM Plex Mono (tabular figures) — except the single large session percentage, set in Fraunces (serif). That one exception is what makes it feel designed rather than templated; explicitly avoid Inter/Manrope/system-ui defaults everywhere else.
- **Hairline dividers, not nested cards** — three sections in one flat surface, no drop shadows on the sections themselves (the popover's outer edge is the one exception — see below).
- **One accent color used sparingly** — muted rust/terracotta `#A85C3A` for gauge fills, tag pills, and the status dot only. Desaturated (not neon) semantic colors for status: sage green, muted amber, muted brick red.
- **Footer status line**, not a big banner: a small colored dot plus "updated Xm ago", and a small beige "Code + API" tag showing which data sources are live.
- **Popover chrome is the one flat-design exception**: since it floats over the real desktop, give it a subtle native-style drop shadow and 1px border so it separates visually from whatever's behind it.
- **Tray icon**: no percentage rendered as text (illegible at 16-22px) — a small partial ring or filled bar colored by status instead, with the exact number in the hover tooltip.
- **States as first-class**: a plain-language empty state per missing data source (not three "—" at once), dimmed numbers when data is >15 minutes stale, and a small scoped retry affordance on fetch errors — never a fake/zero value standing in for "not configured."
- **Hierarchy**: SESSION is visually dominant (bigger type, more space); WEEKLY and SPEND are quieter, smaller siblings beneath it.

- **Weekly limits is a list, not a single gauge.** You sent a screenshot of Claude.ai's own "Plan usage limits" settings page: a "Current session" bar, then a "Weekly limits" section listing multiple rows — "All models" and "Fable" each with their own label, "resets [day time]" caption, thin progress bar, and percentage. Mirror that row pattern exactly (label left, tiny bar + reset caption, percentage right) instead of one aggregate weekly gauge. Build it as a repeatable row component so adding another model's row later (Opus, Sonnet) is a one-line change, not a redesign.

Reference the three mockups shown in chat (the beige/serif/Fable-row version is the current target) for exact spacing and proportions.

## Tech stack

Electron (main + renderer), React + TypeScript, Vite, Tailwind for layout utilities (but hand-styled hairlines/typography rather than default Tailwind card components — the instrument-panel look depends on restraint, not a component library's defaults), `electron-store` for local persistence, `safeStorage` for the Admin API key, `electron-builder` for packaging.

---

## Prompt 1 — scaffold the project

```
Scaffold an Electron + React + TypeScript desktop app called "claude-usage-tracker" using Vite as the renderer bundler and Tailwind CSS for layout only (spacing/flex utilities — no default card/shadow components, since the final UI needs a flat, hairline-divided "instrument panel" look, not typical dashboard cards). Requirements:
- Clean split between main/, preload/, and renderer/src/.
- Tray-only app: no dock/taskbar window on launch, just a Tray icon. Clicking it toggles a small frameless, always-on-top popover window (~340x460) anchored near the tray icon, closing on blur, like macOS menu-bar utilities (Bartender, Ice, Stats).
- Add electron-store for local JSON persistence and confirm Electron's safeStorage API is available.
- electron-builder config for macOS (dmg, arm64+x64) and Windows (nsis) targets, app id "com.dhyey.claude-usage-tracker".
- A README covering dev (`npm run dev`) and build (`npm run build`).
Give me a working "hello world" popover (placeholder text only) before we build real features, so I can confirm tray/popover mechanics work.
```

## Prompt 2 — warm, beige, human design shell

```
Build the visual shell of the popover. It must NOT look like a generic AI-generated dashboard — avoid these specifically: Inter/Manrope/Poppins/system-ui default fonts, purple-to-blue gradients or any gradients, glassmorphism/blur, neumorphism, pill badges on every element, rounded-icon-in-a-square feature grids, bouncy/spring animation easing, emoji anywhere, center-aligned hero text blocks.

Palette (bundle fonts as local files or via a bundler plugin, not a runtime CDN fetch):
- Popover surface: warm paper #FBF9F4 (light mode is the primary/default target; still support OS dark mode as a secondary palette).
- Secondary beige surface #EFE7D8 (or #F4EEE0 for a lighter variant) used behind gauge/bar tracks, the plan-tier tag pill, and as subtle row separation in the weekly-limits list — this is deliberately a second, slightly deeper tone from the page background, not the same cream reused everywhere.
- Hairline dividers #E9E4D8. Primary text: warm near-black #2B2A26 (not pure black). Secondary/muted text #8A8478 and #5C5748.
- One accent color only: muted rust/terracotta #A85C3A, used exclusively for gauge/bar fills and the status dot. Status dot uses desaturated semantic colors: sage green #6B8F5E (allowed), muted amber #C08A3E (soft_limited), muted brick red #B54A3F (hard_limited).

Typography:
- Body/labels: IBM Plex Sans (400/500 only).
- All numeric/data values (percentages except the session hero number, dollar amounts, token counts, countdowns): IBM Plex Mono, tabular figures.
- The one deliberate exception: the large current-session percentage is set in Fraunces (serif, weight ~500-550) at ~36px — this single serif moment is what makes it read as designed rather than templated.
- Section labels: 10-11px, uppercase, letter-spacing ~1px, muted secondary color.

Layout — header:
- Small tracked-out label "CLAUDE USAGE" left, a small beige-pill plan-tier tag (e.g. "PRO") next to it, no other header chrome. Settings reached via a subtle outline gear icon, muted color, no button background.

Layout — body, three stacked sections separated by hairline dividers (not boxed cards):
1. "SESSION · 5H" — label + "resets in Xh Ym" on one row (label left, reset right, both muted/small). Below: the Fraunces percentage. Below that: a horizontal bar gauge on the beige track (accent fill, no tick marks needed here — save ticks for the reusable component if you want them, but keep this bar clean and thick, ~5-6px). Below the gauge: small muted monospace "in 1.2k" / "out 340" token counts, left/right aligned.
2. "WEEKLY LIMITS" — not a single gauge. A vertical list of rows, one per model bucket, starting with "All models" and "Fable" (build as a repeatable component so more rows can be added later without redesign). Each row: label left / percentage right (IBM Plex Mono) on one line, a muted "resets [day] [time]" caption below it, then a thin beige-track bar with accent fill below that.
3. "SPEND · THIS MONTH" — plain label, then a data list: label left / IBM Plex Mono value right per row, faint hairline between rows, for "Total" ($) and "Budget" (percent of configured budget).

Footer, below a final hairline: small colored status dot + muted "status · updated Xm ago" text on the left, a small refresh icon on the right (not a "Code + API" text tag — a plain refresh affordance reads cleaner).

Motion: any bar/gauge fill animates over ~250-300ms ease-out on value change, never an instant snap, never spring/bounce easing. Reserve pulsing or color-shift animation strictly for the ≥90% warning state, and keep it subtle.

Popover chrome (the one deliberate exception to "flat, no shadow"): since this floats over the real desktop, give the popover itself a subtle native-style drop shadow and 1px border so it separates visually from whatever's behind it on screen — the sections inside stay flat, only the outer popover gets this treatment.

Tray icon: never render a percentage as text inside the icon (illegible at 16-22px). Use a small partial ring or filled bar with no text, colored by the same status logic, with the exact percentage and status in the hover tooltip instead.

States (build all three now, not later): a plain-language empty-state line per missing data source ("Sign in to Claude Code to see session usage" / "Add an Admin API key to see spend") instead of showing "—" everywhere at once; dim a section's numbers when its data is >15 minutes stale; a small retry affordance scoped to just the section that failed on error.

Componentize: Gauge (reusable bar component taking percent + accent color as props), WeeklyLimitRow (label, resets caption, percent, gauge — repeatable), DataRow, StatusFooter. No hardcoded data yet beyond realistic placeholders (Session 34%, All models 13%, Fable 3%, Spend $18.42 / 37% of $50) — wire it up, then take a screenshot so I can review against this spec before we move on.
```

## Locked logic decisions (don't leave these to agent judgment)

These three were open questions in v2; they're now decided so Antigravity doesn't improvise on the parts that matter most:

1. **Credential source, both platforms.** The reference scripts (`CC_Usage_Monitor/mac/claude_widget.py` and `.../windows/claude_widget.py`) are identical here: they read `~/.claude/.credentials.json` first, full stop. Only macOS has a secondary fallback (the `security` CLI / Keychain), because that's the only fallback the reference actually implements — there's no evidence Claude Code uses Windows Credential Manager, so don't invent one. Mirror this exactly: file first on both platforms, Keychain fallback on macOS only, no fallback on Windows (if the file's missing on Windows, show the "sign in to Claude Code" empty state).
2. **Poll interval: 5 minutes default, 1 minute hard floor.** Every fetch is a real, billed-against-your-quota API call — polling faster doesn't just risk rate-limiting, it measurably eats into the exact budget the gauge is trying to show you. Keep the reference script's 300-second default and enforce a 60-second minimum in Settings (reject/clamp anything lower, don't just suggest it).
3. **The header is the only source of truth for the gauge fill.** `anthropic-ratelimit-unified-5h-utilization` / `-7d-utilization` are the only values allowed to set gauge percentage. The JSONL-derived input/output counts are a cosmetic secondary readout ("in 1.2k / out 340") only — they use a naive last-N-hours-from-file-mtime window that isn't guaranteed to line up with Anthropic's actual server-side window start, so they must never feed into or override the percentage. If the header fetch fails, the gauge shows an explicit "—" / unavailable state, never a JSONL-estimated percentage as a stand-in.
4. **The per-model "Fable" row is best-effort, unlike everything above.** The Fable row in the "Weekly limits" section is modeled on a screenshot of Claude.ai's own account settings page, which is Claude.ai's own frontend surface — there's no confirmation that the same per-model breakdown is exposed through the `anthropic-ratelimit-unified-*` headers the way the aggregate 5h/7d numbers are. Treat this as a discovery task (see Prompt 3), not a guaranteed data path, and design the row to degrade gracefully (hidden, or an explicit "unavailable" state) if no such data can be found — never fabricate a Fable percentage from the aggregate weekly number.

## Prompt 3 — real session/weekly data (port from the existing widget)

```
Wire the "SESSION · 5H" and "WEEKLY · 7D" gauges to real data using the same technique as my existing Python widget at CC_Usage_Monitor/mac/claude_widget.py — do not build a manual/self-logged version, and do not deviate from the following without telling me first:

Credentials (main process only — the token must never reach renderer JS):
- Read ~/.claude/.credentials.json and parse claudeAiOauth.accessToken. This is the only source on Windows — if the file is missing there, treat it as "not signed in," full stop, no other fallback.
- On macOS only, if that file is missing, fall back to `security find-generic-password -s "Claude Code-credentials" -w` via child_process and parse the result the same way.

Rate-limit fetch:
- Every 300 seconds by default (a Settings value, hard-clamped to a 60-second minimum — reject config values below that rather than just warning), send one minimal POST to https://api.anthropic.com/v1/messages: body {"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}, headers Authorization: Bearer <token>, anthropic-version: 2023-06-01.
- Parse only these response headers (case-insensitive) and treat them as the sole source of truth for gauge percentages — nothing else may ever set these values: anthropic-ratelimit-unified-5h-utilization, -5h-reset, -5h-status, -7d-utilization, -7d-reset, -7d-status, -overage-utilization, -overage-status, -overage-reset.
- Send parsed values to the renderer via IPC; drive both TickGauge components and reset countdowns from them (countdowns tick client-side every second between fetches, computed from the reset timestamps, not re-derived from anything else).
- If credentials are missing or the fetch fails, send an explicit "unavailable" state over IPC and have the UI show "—" on the gauge and "Sign in to Claude Code to see session usage" inline — never fall back to a JSONL-derived estimate and never show stale data silently past, say, 15 minutes old without marking it stale.

JSONL token counts (cosmetic only, fully separate code path from the above):
- Every 5 seconds, glob ~/.claude/projects/**/*.jsonl, find the most recently modified file, and sum inputTokens/outputTokens (fallback: message.usage.input_tokens + cache_creation_input_tokens / output_tokens, matching the reference script's parsing exactly) for entries within a naive last-5-hour window based on file/entry timestamps.
- Use this only to populate the "in X / out Y" cosmetic line under the session gauge. It must have no path, direct or indirect, into the gauge's percentage or fill width.

Footer:
- Status dot from the 5h status field: allowed = green, soft_limited = amber, hard_limited = red.
- "updated Xm ago" from the last successful rate-limit fetch timestamp (not the JSONL read timestamp).

Per-model weekly rows (Fable, etc.) — exploratory, do this as a clearly separate step:
- On the same probe response used for the aggregate headers, log every response header whose name starts with "anthropic-ratelimit-" (not just the known ones) to a debug log, so we can see if Anthropic already returns model-specific fields (e.g. something like a "-7d-fable-utilization" pattern) alongside the aggregate ones.
- If nothing model-specific shows up on that probe, try one additional probe call using "model": "claude-fable-5" instead of the Haiku model, and compare its headers against the Haiku probe's — if a model's own weekly bucket is reflected in the response when you call using that model, the "fable" row's percentage should come from that call specifically, not the aggregate "-7d-utilization".
- If neither approach surfaces a real per-model number, do not fabricate one from the aggregate weekly percentage. Show the "All models" row only and drop or gray out the "Fable" row with a small "not available via API" note, and tell me what you found in the headers either way so we can decide whether it's worth pursuing further (e.g. a browser-based read of Claude.ai's own settings page as a fallback, which would be a separate, later prompt).

Test against my real Claude Code login and confirm the percentages match what CC_Usage_Monitor/mac/claude_widget.py shows for the same account at the same moment.
```

## Prompt 4 — API spend via the Admin API

```
Wire the "SPEND · THIS MONTH" data list to real Anthropic cost/token data — this is a separate, fully-sanctioned mechanism from the OAuth-token trick used for session/weekly, so keep the code paths distinct:
- Endpoints: GET https://api.anthropic.com/v1/organizations/usage_report/messages and GET https://api.anthropic.com/v1/organizations/cost_report. Auth header "x-api-key: <admin key>" plus "anthropic-version: 2023-06-01". Requires an Admin API key (sk-ant-admin..., created in Console under organization settings — distinct from both a normal API key and the Claude Code OAuth token used in Prompt 3).
- In Settings, add a field to paste the Admin API key, encrypted at rest via Electron's safeStorage before being persisted with electron-store. All requests happen in the main process only; the renderer only ever receives the computed numbers over IPC.
- Add a "Monthly budget (USD)" setting used for the Budget row.
- Query cost_report for the current calendar month to get total spend; query usage_report/messages for the same window, grouped by model, for total tokens. Cache results, refetch at most once a minute plus on manual refresh.
- If no Admin key is set, show "Add an Admin API key in Settings to see spend" in place of the data list rather than zeros. If a request fails, show a small inline error with a retry affordance.
Confirm the numbers match what I see in the Anthropic Console usage dashboard.
```

## Prompt 5 — settings

```
Build the Settings view (reached via the header gear icon), matching the same flat/hairline visual language as the main popover — no modal chrome, just a second view that swaps in:
- "API spend" section: Admin API key field (masked, with show/hide), Monthly budget field.
- "Claude Code source" section: read-only display of which credential source was found (credentials file vs Keychain vs none) and a "Test connection" button that re-runs the Prompt 3 fetch once and shows pass/fail.
- "General" section: refresh intervals for both the rate-limit fetch and the cost fetch (with sane minimums enforced — no faster than once a minute for either, per Anthropic's guidance), and a "Launch at login" checkbox (wired to app.setLoginItemSettings, finish this fully — don't stub it).
- Validate all numeric inputs (positive numbers only) with inline error text, not blocking silently.
- "Remove API key" action, with confirmation.
Confirm closing Settings returns to the main popover with fresh state, and that everything persists correctly across app restarts (check the electron-store file on disk).
```

## Prompt 6 — packaging polish

```
Finalize for daily use:
- Confirm the tray icon renders correctly at 1x/2x (Retina) and adapts to light/dark menu bars on macOS (template image) and both taskbar themes on Windows. Keep it minimal — a small mono glyph or the status-dot color, not a busy icon.
- Run electron-builder for macOS (arm64+x64 dmg) and Windows (nsis); confirm both produce installable artifacts.
- Add basic file logging (electron-log or similar) so failures are diagnosable without a dev console.
- Confirm the rate-limit and cost polling both fully pause while the popover is closed and the app is idle, so it's not making background requests (and burning your real Claude Code quota) when you're not looking at it.
Summarize what was built, how to install it, and where the log file lives.
```

---

## Deploy readiness — before sharing with others

Based on an actual code audit (not guesswork) once the core app was built. Prompts 7-8 matter regardless of audience; 9-10 specifically matter because this is going to other people, not just you.

## Prompt 7 — robustness and safety net

```
Harden main.ts for production use:
- Add process-level process.on('uncaughtException', ...) and process.on('unhandledRejection', ...) handlers near the existing log.initialize() call, that log the full error via electron-log (log.error) before either recovering gracefully or, if truly unrecoverable, showing a native dialog (electron's dialog.showErrorBox) telling the user to check the log file — never crash silently with no trace.
- Add validation on the Admin API key before it's saved: reject (with an inline error, not a silent failure) any value that doesn't match the expected sk-ant-admin-... prefix pattern, both in the renderer for immediate feedback and again in the main process save-settings handler as defense in depth.
- Add a "Reset all data" action in Settings, separate from the existing "Remove API key," with a confirmation step, that clears every electron-store key (poll intervals, budget, launch-at-login flag, encrypted API key) and restarts polling from scratch.
- Confirm this works by intentionally throwing inside a poll function temporarily and checking it's caught and logged instead of crashing the app.
```

## Prompt 8 — code signing and notarization

```
Set up macOS code signing and notarization in the electron-builder config (package.json build.mac block) so installs don't trigger Gatekeeper's "unidentified developer" warning for other users:
- Add hardenedRuntime: true and an entitlements file (create one if missing) covering the app's actual needs (network access, Keychain access for the "security find-generic-password" fallback call).
- Wire up identity and a notarize block that reads credentials from environment variables (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, or whatever electron-builder's current notarize API expects) rather than hardcoding anything — I'll supply real Apple Developer credentials as env vars when I run a signed build.
- Add a "repository" field to package.json pointing at wherever I host this.
- Document the exact env vars and build command for a signed, notarized dmg in a new README section, "Building a signed release," separate from the plain dev instructions.
Don't attempt to actually sign/notarize yet since I don't have credentials configured here — just get the config and docs ready so it works the moment I add real credentials.
```

## Prompt 9 — auto-update

```
Add auto-update support using electron-updater, targeting GitHub Releases as the feed:
- Install electron-updater, wire it into main.ts: check for updates on launch and periodically while running, download in the background, and prompt via a native dialog or in-popover banner when ready, letting the user choose "Restart now" or "Later."
- Configure the "publish" block in package.json's electron-builder config for GitHub Releases (owner/repo as placeholders I'll fill in once the repo exists).
- Update checks must fail silently (logged, not surfaced as an error) if there's no network or no repo configured yet, so this doesn't break the app for anyone building from source without a release feed.
- Add a small, unobtrusive version number display in Settings (e.g. "v1.0.0") so people can see what they're running.
```

## Prompt 10 — trust and privacy documentation

```
Add a short, prominent "Privacy & data access" section near the top of README.md, in plain language for someone who's never seen the code:
- What it reads: Claude Code's local OAuth token (file or Keychain), local JSONL session logs, and (only if added) an Anthropic Admin API key.
- What it sends and where: only to api.anthropic.com, using the user's own credentials to read their own usage — never to any third-party server, never any telemetry or analytics.
- Where data lives locally (electron-store config path, log file path) and how to fully remove it — reference the new "Reset all data" Settings action, and note that uninstalling the app on macOS does not automatically delete these files.
Keep it factual and short, a few sentences per bullet — this is meant to be read by a stranger deciding whether to trust the app with their auth token before installing it, not a legal document.
```

## Prompt 11 — Windows code signing

```
Set up Windows code signing in the electron-builder config, mirroring how macOS signing was wired (credentials from environment variables, never hardcoded, and no actual signing attempted here since I don't have a certificate configured in this environment):
- In package.json's build.win block, add certificateFile and certificatePassword (or the platform env-var convention electron-builder expects — CSC_LINK/CSC_KEY_PASSWORD or WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD, check current electron-builder docs for the exact names) so a real .pfx certificate can be supplied via env vars at build time.
- Add the "Building a signed release" README section's Windows equivalent, right next to the existing macOS instructions: what a Windows code signing certificate is (standard OV vs EV, and that EV gets instant SmartScreen reputation while OV builds it up over time with downloads), the exact env vars needed, and the exact build command.
- Note in that README section, honestly, that an unsigned or newly-signed-but-low-reputation build will still show a Windows SmartScreen "Windows protected your PC" warning until enough people have run it, and that's expected, not a bug in the build.
Acceptance check: run the existing unsigned Windows build (or confirm the win/nsis build still succeeds if you can only verify on this machine) and confirm the new config doesn't break it. Show me the diff to package.json and the README.
```

## Prompt 12 — clean-install / first-run verification pass

```
I need confidence this app behaves correctly for someone installing it fresh, with none of my local state (no Claude Code credentials cached, no electron-store config, no prior run). Do the following:
- Identify every code path that assumes something exists on first run: the credentials file/Keychain lookup, the electron-store config (poll intervals, budget, launch-at-login default), the Admin API key (absent), and the Fable per-model discovery step. For each, confirm there's already a graceful empty/loading state (most of this should already exist from earlier prompts) — if any path would throw or show a raw error instead of a friendly message, fix it now.
- Simulate a clean install: temporarily point electron-store and the credentials lookup at an empty temp directory (or clear your real local config/cache if you're comfortable doing that, since this is a dev environment), launch the app, and walk through what a brand-new user sees: tray icon state with no data yet, popover empty states for session/weekly/spend, first interaction with Settings.
- Fix anything that looks broken, confusing, or crashes during that walkthrough.
- Write a short TESTING.md (or a "Manual QA checklist" section in README) listing the exact steps to repeat this clean-install check before every future release — so this doesn't have to be rediscovered each time.
Acceptance check: show me a screenshot (or describe exactly what renders) at each stage of the clean-install walkthrough, and confirm no errors appeared in the electron-log output during the whole run.
```

---

## Notes for you (not for Antigravity)

- The session/weekly numbers this produces are Claude Code (CLI) usage specifically — same scope as your existing `CC_Usage_Monitor`. If you also want Claude.ai web chat visibility, there's still no public API for that; nothing in this guide changes that fact.
- Keep the Prompt 3 (OAuth token) and Prompt 4 (Admin API key) code paths separate, as instructed — they're different credentials with different trust levels and different policy footing. Don't let a future edit merge them.
- If you'd rather not depend on the OAuth-token trick at all (e.g. if Anthropic tightens enforcement on it later), the fallback is the self-logged approach from v1 of this guide — worth keeping that as a mental backup, not necessarily building it now.
- The Fable weekly row is the one piece in this guide without a confirmed data source — it's based on your Claude.ai settings screenshot, not on anything the reference script or the documented Admin API exposes. Go in expecting Prompt 3's Fable discovery step might come back empty, and that's fine — the row is designed to degrade gracefully if so.

Sources: [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api), [Google Antigravity overview](https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/), reference implementation: `CC_Usage_Monitor/mac/claude_widget.py` and `CC_Usage_Monitor/windows/claude_widget.py` in your connected folder.
