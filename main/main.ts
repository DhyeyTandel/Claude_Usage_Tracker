import { app, BrowserWindow, Tray, dialog, ipcMain, safeStorage, screen, nativeImage, powerMonitor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import Store from 'electron-store';
import log from 'electron-log';
import { autoUpdater } from 'electron-updater';

// Configure logging
log.initialize();

/**
 * Keep unexpected main-process failures visible and diagnosable. Electron can
 * otherwise exit after an uncaught error without giving a menu-bar-only app a
 * way to tell the user what happened.
 */
function reportUnhandledProcessError(source: string, error: unknown): void {
  // Pass the original value through so electron-log retains Error stacks and
  // any diagnostic properties carried by a rejected value.
  log.error(`${source}:`, error);

  try {
    dialog.showErrorBox(
      'Claude Usage Tracker encountered an unexpected error',
      'The error was recorded in the application log. Please check the log file and restart the app if the problem continues.'
    );
  } catch (dialogError) {
    // Logging must still be attempted if Electron cannot display a dialog
    // during early startup or shutdown.
    log.error('Unable to show unexpected-error dialog:', dialogError);
  }
}

process.on('uncaughtException', (error) => {
  reportUnhandledProcessError('Uncaught exception in the main process', error);
});

process.on('unhandledRejection', (reason) => {
  reportUnhandledProcessError('Unhandled promise rejection in the main process', reason);
});

log.info('Application starting...');

// Declare instances
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const store = new Store();

// Default configuration constants
const MIN_POLL_INTERVAL = 60; // 1 minute hard floor
const DEFAULT_POLL_INTERVAL = 300;
const DEFAULT_MONTHLY_BUDGET = 100.0;
const ADMIN_API_KEY_PATTERN = /^sk-ant-admin-\S+$/;

// Polling interval state (in seconds)
let pollIntervalRateLimit = Math.max(MIN_POLL_INTERVAL, (store.get('pollIntervalRateLimit') as number) || DEFAULT_POLL_INTERVAL);
let pollIntervalSpend = Math.max(MIN_POLL_INTERVAL, (store.get('pollIntervalSpend') as number) || DEFAULT_POLL_INTERVAL);
let monthlyBudget = (store.get('monthlyBudget') as number) || DEFAULT_MONTHLY_BUDGET;
let launchAtLogin = !!store.get('launchAtLogin');

// Data caches
let rateLimitData: any = null;
let tokenCounts: any = { session_input: 0, session_output: 0, today_input: 0, today_output: 0, last_activity: null };
let spendData: any = null;

// Polling timers
let rateLimitTimer: NodeJS.Timeout | null = null;
let tokenTimer: NodeJS.Timeout | null = null;
let spendTimer: NodeJS.Timeout | null = null;

// Auto-update: check on launch and every 4 hours while running
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let updateCheckTimer: NodeJS.Timeout | null = null;
let updatePromptShown = false;

// ── Telegram Notification State ──────────────────────────────────────────────
const NOTIFICATION_BG_POLL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_DROP_THRESHOLD_5H = 0.15; // absolute drop to trigger 5h refresh notification
const REFRESH_DROP_THRESHOLD_7D = 0.10; // absolute drop to trigger weekly refresh notification
const REFRESH_PREV_MIN_5H = 0.20;       // prev must be >= this to consider a drop meaningful
const REFRESH_PREV_MIN_7D = 0.10;

function getTelegramConfig() {
  return {
    enabled: !!store.get('telegramEnabled'),
    notifyRefresh: store.get('telegramNotifyRefresh') !== false, // default true
    notifyWeekly: store.get('telegramNotifyWeekly') !== false,   // default true
    weeklyDay: (store.get('telegramWeeklyDay') as number) ?? 0,  // 0 = Sunday
    weeklyHour: (store.get('telegramWeeklyHour') as number) ?? 9 // 9 AM
  };
}

function getTelegramBotToken(): string {
  const encrypted = store.get('telegramBotTokenEncrypted') as string | undefined;
  if (!encrypted) return '';
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (err: any) {
      log.error('Failed decrypting Telegram bot token:', err.message);
    }
  }
  return '';
}

function getTelegramChatId(): string {
  return (store.get('telegramChatId') as string) || '';
}

let prevSessionPct: number | null = null;
let prevWeeklyPct: number | null = null;
let notificationBackgroundTimer: NodeJS.Timeout | null = null;
let weeklyReportTimer: NodeJS.Timeout | null = null;

/**
 * Configure the macOS Dock: set the custom icon FIRST (so the Dock and
 * Cmd+Tab switcher never flash the default Electron icon), then hide it,
 * since this is a menu-bar-only utility.
 * Must run after 'ready' — dock APIs are unreliable before that.
 */
function configureMacDock() {
  if (process.platform !== 'darwin') return;
  try {
    const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  } catch (err) {
    log.error('Failed to set macOS dock icon:', err);
  }
  app.dock.hide();
}

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  source: 'credentials file' | 'Keychain';
  fullObject: any;
  account?: string;
}

let cachedToken: OAuthCredentials | null = null;

/**
 * Resolves local Claude credentials.
 * 1. Checks ~/.claude/.credentials.json
 * 2. On macOS, falls back to Keychain security CLI search
 */
function getOAuthToken(): OAuthCredentials {
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  
  if (fs.existsSync(credsPath)) {
    try {
      const content = fs.readFileSync(credsPath, 'utf-8');
      const parsed = JSON.parse(content);
      const oauth = parsed?.claudeAiOauth;
      if (oauth?.accessToken) {
        return {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken || '',
          expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : Number(oauth.expiresAt || 0),
          source: 'credentials file',
          fullObject: parsed
        };
      }
    } catch (err: any) {
      log.error('Failed to parse .credentials.json file:', err.message);
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { execFileSync } = require('child_process');
      const rawStdout = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf-8', timeout: 5000 }
      );
      const cleanStdout = rawStdout.trim();
      if (cleanStdout) {
        const parsed = JSON.parse(cleanStdout);
        const oauth = parsed?.claudeAiOauth;
        if (oauth?.accessToken) {
          let account = os.userInfo().username;
          try {
            const rawAttrs = execFileSync(
              'security',
              ['find-generic-password', '-s', 'Claude Code-credentials'],
              { encoding: 'utf-8', timeout: 5000 }
            );
            const m = rawAttrs.match(/"acct"<blob>="([^"]+)"/);
            if (m && m[1]) {
              account = m[1];
            }
          } catch (attrErr: any) {
            log.warn('Failed to parse account attribute from Keychain, falling back to OS username:', attrErr.message);
          }

          return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken || '',
            expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : Number(oauth.expiresAt || 0),
            source: 'Keychain',
            fullObject: parsed,
            account
          };
        }
      }
    } catch (err: any) {
      log.error('Failed to read from macOS Keychain:', err.message);
    }
  }

  throw new Error('No credentials found');
}

/**
 * Persists the updated OAuthCredentials back to its source.
 */
function persistOAuthToken(creds: OAuthCredentials): void {
  if (creds.source === 'credentials file') {
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    try {
      fs.mkdirSync(path.dirname(credsPath), { recursive: true });
      // Write atomically (temp file + rename) so a crash mid-write can never
      // corrupt the credentials file, and owner-only (0600) so the token is
      // not readable by other local users.
      const tmpPath = credsPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(creds.fullObject, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, credsPath);
      try { fs.chmodSync(credsPath, 0o600); } catch {}
      log.info('Successfully persisted refreshed OAuth credentials to credentials file');
    } catch (err: any) {
      log.error('Failed to write refreshed OAuth credentials to credentials file:', err.message);
      throw err;
    }
  } else if (creds.source === 'Keychain') {
    if (process.platform === 'darwin') {
      try {
        const { execFileSync } = require('child_process');
        const jsonStr = JSON.stringify(creds.fullObject);
        const account = creds.account || os.userInfo().username;
        // Known limitation: passing the secret via -w exposes it in the local
        // process list for the sub-second duration of this call. This mirrors
        // how the Claude Code ecosystem writes this Keychain item; the
        // alternative (security's interactive stdin mode) has fragile quoting
        // that risks corrupting credentials, which is the worse failure mode.
        execFileSync(
          'security',
          ['add-generic-password', '-a', account, '-s', 'Claude Code-credentials', '-w', jsonStr, '-U'],
          { timeout: 5000 }
        );
        log.info('Successfully persisted refreshed OAuth credentials to macOS Keychain');
      } catch (err: any) {
        log.error('Failed to write refreshed OAuth credentials to macOS Keychain:', err.message);
        throw err;
      }
    } else {
      throw new Error('Keychain persistence is only supported on macOS');
    }
  }
}

/**
 * Performs a refresh of the OAuth access token.
 */
async function refreshOAuthToken(creds: OAuthCredentials): Promise<OAuthCredentials> {
  const clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
  log.info(`Attempting to refresh OAuth token from source: ${creds.source}`);
  
  const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: clientId
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OAuth refresh request failed status=${response.status}: ${errText}`);
  }

  const json: any = await response.json();
  const newAccessToken = json.access_token;
  const newRefreshToken = json.refresh_token || creds.refreshToken;
  const expiresIn = json.expires_in; // in seconds
  
  if (!newAccessToken || !expiresIn) {
    throw new Error('OAuth token response is missing access_token or expires_in');
  }

  const newExpiresAt = Date.now() + expiresIn * 1000;

  const updatedFullObject = JSON.parse(JSON.stringify(creds.fullObject));
  if (!updatedFullObject.claudeAiOauth) {
    updatedFullObject.claudeAiOauth = {};
  }
  updatedFullObject.claudeAiOauth.accessToken = newAccessToken;
  updatedFullObject.claudeAiOauth.refreshToken = newRefreshToken;
  updatedFullObject.claudeAiOauth.expiresAt = newExpiresAt;

  const updatedCreds: OAuthCredentials = {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt: newExpiresAt,
    source: creds.source,
    fullObject: updatedFullObject,
    account: creds.account
  };

  persistOAuthToken(updatedCreds);
  return updatedCreds;
}

/**
 * Retrieves a valid OAuth access token, refreshing it if expired or near expiry.
 * Refreshes are single-flight: concurrent callers await the same in-progress
 * refresh instead of firing parallel ones, which could invalidate a rotating
 * refresh token and force the user to log in again.
 */
let inFlightTokenRequest: Promise<string> | null = null;

async function getValidToken(forceRefresh = false): Promise<string> {
  const marginMs = 5 * 60 * 1000; // 5 minutes margin

  if (cachedToken && !forceRefresh && (cachedToken.expiresAt - Date.now() > marginMs)) {
    return cachedToken.accessToken;
  }

  if (inFlightTokenRequest) {
    return inFlightTokenRequest;
  }

  inFlightTokenRequest = (async () => {
    log.info('No valid cached token found or refresh forced. Reading from credentials source...');
    let creds: OAuthCredentials;
    try {
      creds = getOAuthToken();
    } catch (err) {
      cachedToken = null;
      throw err;
    }

    if (forceRefresh || (creds.expiresAt - Date.now() <= marginMs)) {
      try {
        creds = await refreshOAuthToken(creds);
      } catch (refreshErr: any) {
        log.error('Failed to refresh OAuth token:', refreshErr.message);
        cachedToken = null;
        throw refreshErr;
      }
    }

    cachedToken = creds;
    return creds.accessToken;
  })();

  try {
    return await inFlightTokenRequest;
  } finally {
    inFlightTokenRequest = null;
  }
}

/**
 * Update the dynamic tray icon based on status and percentage.
 * Uses pre-generated partial-ring icons.
 */
function updateTrayIcon(pctVal: number, statusStr: string, hasError: boolean) {
  if (!tray) return;

  let statusPrefix = 'disconnected';
  if (!hasError) {
    // When utilization >= 100%, force hard-limited status for the tray icon
    // regardless of what the API header says — the user is rate limited.
    if (pctVal >= 1.0) {
      statusPrefix = 'hard';
    } else if (statusStr === 'allowed') statusPrefix = 'allowed';
    else if (statusStr === 'soft_limited') statusPrefix = 'soft';
    else if (statusStr === 'hard_limited') statusPrefix = 'hard';
  }

  // Clamp and round percent to nearest 10
  const pct = Math.max(0, Math.min(100, Math.round((pctVal || 0) * 10) * 10));
  const iconName = `${statusPrefix}-${pct}.png`;
  const iconPath = path.join(__dirname, '..', 'assets', 'tray', iconName);

  if (fs.existsSync(iconPath)) {
    try {
      tray.setImage(iconPath);
    } catch (err: any) {
      log.error('Failed to set tray image:', err.message);
    }
  } else {
    log.warn('Tray icon not found:', iconPath);
  }

  // Update hover tooltip
  const pctDisplay = Math.min(100, Math.round(pctVal * 100));
  const statusDisplay = statusStr ? statusStr.replace('_', ' ') : 'disconnected';
  if (hasError) {
    tray.setToolTip(`Claude Code Usage Tracker\nStatus: disconnected\nError: Rate limit fetch failed`);
  } else {
    tray.setToolTip(`Claude Code Usage Tracker\nSession: ${pctDisplay}%\nStatus: ${statusDisplay}`);
  }
}

/**
 * Fetches Rate Limit headers using the Claude Code OAuth token.
 * Calls https://api.anthropic.com/v1/messages with a 1-token message payload.
 */
async function fetchRateLimits() {
  try {
    let token = await getValidToken(false);
    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      })
    });

    if (response.status === 401) {
      log.warn('API request failed with 401. Forcing re-read and refresh cycle.');
      try {
        token = await getValidToken(true);
      } catch (refreshErr: any) {
        log.error('Failed to force-refresh token after 401:', refreshErr.message);
        throw new Error('Unauthorized (401) and token refresh failed');
      }

      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
    }

    // 429 = rate limited (at 100% usage). The response still carries valid
    // rate-limit headers, so we must NOT throw here — fall through to the
    // header-reading logic below.
    if (!response.ok && response.status !== 429) {
      const bodyText = await response.text();
      log.error(`Anthropic API returned error status=${response.status}: ${bodyText}`);
      throw new Error(`API returned status ${response.status}: ${bodyText.substring(0, 150)}`);
    }

    const headers = response.headers;
    const g = (key: string): number => {
      const val = headers.get(key);
      return val ? parseFloat(val) : 0.0;
    };

    // Debug: log every rate-limit header so per-model buckets can be discovered
    const allRateLimitHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith('anthropic-ratelimit-')) {
        allRateLimitHeaders[name.toLowerCase()] = value;
      }
    });
    log.debug('All anthropic-ratelimit-* headers:', JSON.stringify(allRateLimitHeaders));

    // Discover per-model weekly buckets dynamically, e.g.
    // anthropic-ratelimit-unified-7d-fable-utilization / -reset / -status.
    // Anthropic does not document these; if absent, the UI degrades gracefully.
    const models: { name: string; pct: number; reset: number; status: string }[] = [];
    for (const name of Object.keys(allRateLimitHeaders)) {
      const m = name.match(/^anthropic-ratelimit-unified-7d-([a-z0-9]+)-utilization$/);
      if (m && m[1]) {
        const model = m[1];
        models.push({
          name: model.charAt(0).toUpperCase() + model.slice(1),
          pct: parseFloat(allRateLimitHeaders[name]) || 0,
          reset: parseFloat(allRateLimitHeaders[`anthropic-ratelimit-unified-7d-${model}-reset`] || '') || 0,
          status: allRateLimitHeaders[`anthropic-ratelimit-unified-7d-${model}-status`] || 'unknown'
        });
      }
    }

    log.info(`Successfully fetched Rate Limits. Status: ${response.status}. ` +
             `5h-utilization: ${headers.get('anthropic-ratelimit-unified-5h-utilization')}, ` +
             `7d-utilization: ${headers.get('anthropic-ratelimit-unified-7d-utilization')}, ` +
             `per-model buckets found: ${models.length ? models.map(m => m.name).join(', ') : 'none'}`);

    rateLimitData = {
      session_pct: g('anthropic-ratelimit-unified-5h-utilization'),
      weekly_pct: g('anthropic-ratelimit-unified-7d-utilization'),
      reset_ts: g('anthropic-ratelimit-unified-5h-reset'),
      status: headers.get('anthropic-ratelimit-unified-5h-status') || 'unknown',
      overage_pct: g('anthropic-ratelimit-unified-overage-utilization'),
      overage_status: headers.get('anthropic-ratelimit-unified-overage-status') || 'unknown',
      overage_reset: g('anthropic-ratelimit-unified-overage-reset'),
      weekly_reset: g('anthropic-ratelimit-unified-7d-reset'),
      weekly_status: headers.get('anthropic-ratelimit-unified-7d-status') || 'unknown',
      models,
      fetched_at: Date.now(),
      error: null
    };

    // Check for limit refresh and send Telegram notification
    checkForLimitRefresh(rateLimitData);
  } catch (err: any) {
    log.error('Rate Limit fetch failed:', err.message);
    rateLimitData = {
      session_pct: 0,
      weekly_pct: 0,
      reset_ts: 0,
      status: 'unknown',
      overage_pct: 0,
      overage_status: 'unknown',
      overage_reset: 0,
      weekly_reset: 0,
      weekly_status: 'unknown',
      models: [],
      fetched_at: Date.now(),
      error: err.message || 'Fetch failed'
    };
  }

  // Update tray icon state
  updateTrayIcon(
    rateLimitData.session_pct,
    rateLimitData.status,
    !!rateLimitData.error
  );

  // Push to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage-update', rateLimitData);
  }
}

/**
 * Recursively find all JSONL files in ~/.claude/projects/
 */
function findJsonlFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of list) {
      const res = path.join(dir, file.name);
      if (file.isDirectory()) {
        results = results.concat(findJsonlFiles(res));
      } else if (file.isFile() && file.name.endsWith('.jsonl')) {
        results.push(res);
      }
    }
  } catch (err) {
    log.error('Error listing directory:', dir, err);
  }
  return results;
}

/**
 * Scan JSONL files for local token usage
 */
function updateTokenCounts() {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const counts = { session_input: 0, session_output: 0, today_input: 0, today_output: 0, last_activity: null as number | null };

  if (!fs.existsSync(claudeDir)) {
    tokenCounts = counts;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tokens-update', tokenCounts);
    }
    return;
  }

  const files = findJsonlFiles(claudeDir);
  log.info(`[tokens] Scanning ${claudeDir}: found ${files.length} jsonl file(s).`);
  if (files.length === 0) {
    tokenCounts = counts;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tokens-update', tokenCounts);
    }
    return;
  }

  // Sort files by modified time to get the latest
  const fileStats = files.map(file => {
    try {
      const stat = fs.statSync(file);
      return { file, mtime: stat.mtimeMs };
    } catch {
      return { file, mtime: 0 };
    }
  });
  fileStats.sort((a, b) => a.mtime - b.mtime);
  const latestFile = fileStats[fileStats.length - 1];
  counts.last_activity = latestFile.mtime > 0 ? latestFile.mtime : null;

  const latestAgeMin = latestFile.mtime > 0 ? Math.round((Date.now() - latestFile.mtime) / 60000) : -1;
  log.info(`[tokens] Latest file: ${latestFile.file} (last modified ${latestAgeMin}m ago).`);

  // Set up 5-hour cutoff window for session tokens
  const SESSION_HOURS = 5;
  const cutoffTime = Date.now() - SESSION_HOURS * 60 * 60 * 1000;
  if (latestAgeMin > SESSION_HOURS * 60) {
    log.info(`[tokens] Latest activity is older than the ${SESSION_HOURS}h session window — session in/out will be 0 until you send a new message. This is expected, not a bug.`);
  }

  // Local YYYY-MM-DD string
  const d = new Date();
  const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let debugAssistantLinesInLatest = 0;
  let debugWindowMatchedLines = 0;
  let debugZeroTokenAssistantLines = 0;
  let debugSampleRawLine: string | null = null;

  for (const item of fileStats) {
    try {
      if (!fs.existsSync(item.file)) continue;
      const content = fs.readFileSync(item.file, 'utf-8');
      const lines = content.split('\n');
      const isLatest = (item.file === latestFile.file);

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (obj.type !== 'assistant') continue;
        if (isLatest) {
          debugAssistantLinesInLatest++;
          if (!debugSampleRawLine) debugSampleRawLine = trimmed.slice(0, 400);
        }

        let inp = parseInt(obj.inputTokens, 10) || 0;
        let out = parseInt(obj.outputTokens, 10) || 0;

        if (!inp && !out) {
          const u = obj.message?.usage || {};
          inp = (parseInt(u.input_tokens, 10) || 0) + (parseInt(u.cache_creation_input_tokens, 10) || 0);
          out = parseInt(u.output_tokens, 10) || 0;
        }
        if (isLatest && inp === 0 && out === 0) debugZeroTokenAssistantLines++;

        const ts = obj.timestamp || '';

        // Sum today total (all files)
        if (ts.startsWith(todayStr)) {
          counts.today_input += inp;
          counts.today_output += out;
        }

        // Sum session (latest file only, within 5-hour window)
        if (isLatest) {
          const entryTime = new Date(ts).getTime();
          if (!isNaN(entryTime) && entryTime >= cutoffTime) {
            counts.session_input += inp;
            counts.session_output += out;
            debugWindowMatchedLines++;
          }
        }
      }
    } catch (err: any) {
      log.error('Failed reading tokens JSONL file:', item.file, err.message);
    }
  }

  log.info(
    `[tokens] Latest file had ${debugAssistantLinesInLatest} assistant line(s); ` +
    `${debugWindowMatchedLines} fell inside the ${SESSION_HOURS}h window; ` +
    `${debugZeroTokenAssistantLines} assistant line(s) parsed with 0 tokens (possible schema mismatch).`
  );
  if (debugAssistantLinesInLatest > 0 && debugZeroTokenAssistantLines === debugAssistantLinesInLatest) {
    log.warn(`[tokens] Every assistant line in the latest file parsed to 0 tokens — the JSONL field names may have changed. Sample line: ${debugSampleRawLine}`);
  }

  tokenCounts = counts;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tokens-update', tokenCounts);
  }
}

/**
 * Helper to decrypt Admin API Key from Store
 */
function getAdminApiKey(): string {
  const encryptedKey = store.get('adminApiKeyEncrypted') as string | undefined;
  if (!encryptedKey) return '';
  
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
    } catch (err: any) {
      log.error('Failed decrypting Admin API Key:', err.message);
    }
  }
  return '';
}

/**
 * Fetches API spend data using the Admin API key.
 * Retrieves cost_report and usage_report/messages.
 */
async function fetchSpendReport() {
  const key = getAdminApiKey();
  if (!key) {
    spendData = { hasKey: false, error: null };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spend-update', spendData);
    }
    return;
  }

  try {
    const d = new Date();
    const year = d.getFullYear();
    const month = d.getMonth();
    const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0)).toISOString();
    
    // Cost report call
    const costResponse = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${startOfMonth}`, {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      }
    });

    if (!costResponse.ok) {
      const errTxt = await costResponse.text();
      throw new Error(`Cost Report API returned ${costResponse.status}: ${errTxt}`);
    }

    const costJson: any = await costResponse.json();
    let totalSpend = 0.0;
    if (costJson?.data && Array.isArray(costJson.data)) {
      for (const item of costJson.data) {
        totalSpend += parseFloat(item.cost_usd) || 0.0;
      }
    }

    // Usage report / messages call (for token counts)
    const usageResponse = await fetch(`https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${startOfMonth}&group_by[]=model`, {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      }
    });

    if (!usageResponse.ok) {
      const errTxt = await usageResponse.text();
      throw new Error(`Usage Report API returned ${usageResponse.status}: ${errTxt}`);
    }

    const usageJson: any = await usageResponse.json();
    let totalTokens = 0;
    if (usageJson?.data && Array.isArray(usageJson.data)) {
      for (const item of usageJson.data) {
        const inp = parseInt(item.input_tokens, 10) || 0;
        const out = parseInt(item.output_tokens, 10) || 0;
        totalTokens += (inp + out);
      }
    }

    const budgetPercent = monthlyBudget > 0 ? (totalSpend / monthlyBudget) * 100 : 0;

    spendData = {
      hasKey: true,
      total_cost: totalSpend,
      total_tokens: totalTokens,
      budget_percent: budgetPercent,
      error: null,
      fetched_at: Date.now()
    };

    log.info('Successfully fetched spend reports from Anthropic API');
  } catch (err: any) {
    log.error('Spend fetch failed:', err.message);
    spendData = {
      hasKey: true,
      total_cost: 0,
      total_tokens: 0,
      budget_percent: 0,
      error: err.message || 'Fetch failed',
      fetched_at: Date.now()
    };
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spend-update', spendData);
  }
}

/**
 * Checks credentials availability to show in Settings
 */
function getConfigStatus() {
  let source = 'none';
  try {
    const creds = getOAuthToken();
    source = creds.source;
  } catch {}

  const hasAdminKey = !!getAdminApiKey();

  return {
    oauthSource: source,
    hasAdminKey
  };
}

/**
 * Pushes config statuses to renderer
 */
function sendConfigStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-status-update', getConfigStatus());
  }
}

/**
 * Starts all polling routines
 */
function startPolling() {
  stopPolling();

  // Run immediately on activation
  fetchRateLimits();
  updateTokenCounts();
  fetchSpendReport();

  // Set timers
  rateLimitTimer = setInterval(fetchRateLimits, pollIntervalRateLimit * 1000);
  tokenTimer = setInterval(updateTokenCounts, 5000); // hardcoded 5 seconds interval
  spendTimer = setInterval(fetchSpendReport, pollIntervalSpend * 1000);

  log.info(`Polling loops started. Rate limit interval: ${pollIntervalRateLimit}s, Spend interval: ${pollIntervalSpend}s`);
}

/**
 * Clears all polling timers
 */
function stopPolling() {
  if (rateLimitTimer) clearInterval(rateLimitTimer);
  if (tokenTimer) clearInterval(tokenTimer);
  if (spendTimer) clearInterval(spendTimer);
  
  rateLimitTimer = null;
  tokenTimer = null;
  spendTimer = null;
  
  log.info('Polling loops suspended');
}

// ── Telegram Notification Functions ──────────────────────────────────────────

/**
 * Sends a message via Telegram Bot API. Failures are logged, never surfaced.
 */
async function sendTelegramNotification(message: string): Promise<boolean> {
  const token = getTelegramBotToken();
  const chatId = getTelegramChatId();
  const config = getTelegramConfig();

  if (!config.enabled || !token || !chatId) {
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      log.error(`Telegram sendMessage failed status=${response.status}: ${errText}`);
      return false;
    }

    log.info('Telegram notification sent successfully');
    return true;
  } catch (err: any) {
    log.error('Telegram notification error:', err.message);
    return false;
  }
}

/**
 * Compares current utilization against previous values to detect limit refreshes.
 * Called after every successful rate limit fetch.
 */
function checkForLimitRefresh(newData: any): void {
  const config = getTelegramConfig();
  if (!config.enabled || !config.notifyRefresh) {
    prevSessionPct = newData.session_pct;
    prevWeeklyPct = newData.weekly_pct;
    return;
  }

  const nowPct5h = newData.session_pct;
  const nowPct7d = newData.weekly_pct;

  // Detect 5-hour session refresh
  if (prevSessionPct !== null && prevSessionPct >= REFRESH_PREV_MIN_5H) {
    const drop = prevSessionPct - nowPct5h;
    if (drop >= REFRESH_DROP_THRESHOLD_5H || nowPct5h === 0) {
      const prevDisplay = Math.round(prevSessionPct * 100);
      const nowDisplay = Math.round(nowPct5h * 100);
      const statusDisplay = (newData.status || 'unknown').replace('_', ' ');

      let resetTimeStr = '';
      if (newData.reset_ts > 0) {
        const resetDate = new Date(newData.reset_ts * 1000);
        resetTimeStr = `${String(resetDate.getHours()).padStart(2, '0')}:${String(resetDate.getMinutes()).padStart(2, '0')}`;
      }

      const msg =
        `🔄 *Claude Limit Refreshed!*\n` +
        `5h session: ${prevDisplay}% → ${nowDisplay}%\n` +
        `Status: ${statusDisplay}` +
        (resetTimeStr ? `\nNext reset at: ${resetTimeStr}` : '');

      log.info(`Limit refresh detected (5h): ${prevDisplay}% → ${nowDisplay}%`);
      void sendTelegramNotification(msg);
    }
  }

  // Detect weekly limit refresh / surprise reset
  if (prevWeeklyPct !== null && prevWeeklyPct >= REFRESH_PREV_MIN_7D) {
    const drop = prevWeeklyPct - nowPct7d;
    if (drop >= REFRESH_DROP_THRESHOLD_7D || nowPct7d === 0) {
      const prevDisplay = Math.round(prevWeeklyPct * 100);
      const nowDisplay = Math.round(nowPct7d * 100);

      const msg =
        `🔄 *Weekly Limit Reset!*\n` +
        `Weekly usage: ${prevDisplay}% → ${nowDisplay}%`;

      log.info(`Limit refresh detected (7d): ${prevDisplay}% → ${nowDisplay}%`);
      void sendTelegramNotification(msg);
    }
  }

  prevSessionPct = nowPct5h;
  prevWeeklyPct = nowPct7d;
}

/**
 * Formats a token count for display (e.g. 1.2k, 3.45M)
 */
function formatTokensForTelegram(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Sends a weekly usage summary via Telegram.
 */
async function sendWeeklyUsageSummary(): Promise<void> {
  const config = getTelegramConfig();
  if (!config.enabled || !config.notifyWeekly) return;

  log.info('Sending weekly usage summary via Telegram');

  // Refresh data before sending summary
  try {
    await fetchRateLimits();
    await fetchSpendReport();
    updateTokenCounts();
  } catch (err: any) {
    log.error('Failed to refresh data before weekly summary:', err.message);
  }

  let msg = `📊 *Claude Weekly Usage Summary*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Session info
  if (rateLimitData && !rateLimitData.error) {
    const sessionPct = Math.round(rateLimitData.session_pct * 100);
    const statusDisplay = (rateLimitData.status || 'unknown').replace('_', ' ');
    let resetStr = '';
    if (rateLimitData.reset_ts > 0) {
      const remaining = Math.max(0, rateLimitData.reset_ts - Date.now() / 1000);
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      resetStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    msg += `🔹 *Session (5h window)*\n`;
    msg += `Usage: ${sessionPct}% | Status: ${statusDisplay}`;
    if (resetStr) msg += `\nResets in: ${resetStr}`;
    msg += `\n\n`;

    // Weekly limits
    const weeklyPct = Math.round(rateLimitData.weekly_pct * 100);
    msg += `🔹 *Weekly Limits*\n`;
    msg += `All models: ${weeklyPct}%`;
    if (rateLimitData.models && rateLimitData.models.length > 0) {
      const modelParts = rateLimitData.models.map((m: any) => `${m.name}: ${Math.round(m.pct * 100)}%`);
      msg += `\n${modelParts.join(' | ')}`;
    }
    msg += `\n\n`;
  } else {
    msg += `🔹 *Session / Weekly*\nData unavailable (disconnected)\n\n`;
  }

  // Today's tokens
  if (tokenCounts) {
    msg += `🔹 *Today's Tokens*\n`;
    msg += `Input: ${formatTokensForTelegram(tokenCounts.today_input)} | Output: ${formatTokensForTelegram(tokenCounts.today_output)}\n\n`;
  }

  // Spend
  if (spendData && spendData.hasKey && !spendData.error) {
    msg += `💰 *Monthly Spend*\n`;
    msg += `Total: $${(spendData.total_cost || 0).toFixed(2)} | Budget: ${(spendData.budget_percent || 0).toFixed(1)}%`;
  } else {
    msg += `💰 *Monthly Spend*\nNo Admin API key configured`;
  }

  const success = await sendTelegramNotification(msg);
  if (success) {
    log.info('Weekly usage summary sent successfully via Telegram');
  } else {
    log.warn('Failed to send weekly usage summary via Telegram');
  }
}

/**
 * Schedules the weekly usage report timer.
 * Calculates ms until the next occurrence of the configured day/hour,
 * then sets a recurring weekly interval.
 */
function scheduleWeeklyReport(): void {
  // Clear any existing timer
  if (weeklyReportTimer) {
    clearTimeout(weeklyReportTimer);
    weeklyReportTimer = null;
  }

  const config = getTelegramConfig();
  if (!config.enabled || !config.notifyWeekly) {
    log.info('Weekly Telegram report disabled or Telegram not enabled.');
    return;
  }

  const now = new Date();
  const targetDay = config.weeklyDay;   // 0=Sun … 6=Sat
  const targetHour = config.weeklyHour; // 0–23

  // Find the next occurrence
  const next = new Date(now);
  next.setHours(targetHour, 0, 0, 0);

  // Calculate days until target day
  let daysUntil = targetDay - now.getDay();
  if (daysUntil < 0 || (daysUntil === 0 && now.getHours() >= targetHour)) {
    daysUntil += 7;
  }
  next.setDate(next.getDate() + daysUntil);

  const msUntilFirst = next.getTime() - now.getTime();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  log.info(`Weekly Telegram report scheduled: next firing in ${Math.round(msUntilFirst / 60000)} minutes (${next.toLocaleString()})`);

  weeklyReportTimer = setTimeout(() => {
    void sendWeeklyUsageSummary();
    // Set up recurring weekly interval
    weeklyReportTimer = setInterval(() => {
      void sendWeeklyUsageSummary();
    }, oneWeekMs) as unknown as NodeJS.Timeout;
  }, msUntilFirst) as unknown as NodeJS.Timeout;
}

/**
 * Starts or stops the background notification polling timer.
 * This runs independently of the main polling (which stops when window hides)
 * to ensure limit-refresh notifications are detected even when the popover is closed.
 */
function manageNotificationBackgroundPoll(): void {
  const config = getTelegramConfig();
  const shouldRun = config.enabled && config.notifyRefresh && !!getTelegramBotToken() && !!getTelegramChatId();

  if (shouldRun && !notificationBackgroundTimer) {
    log.info('Starting background notification poll (10 min interval)');
    notificationBackgroundTimer = setInterval(() => {
      // Only poll if the main polling is NOT active (i.e. window is hidden)
      if (!rateLimitTimer) {
        void fetchRateLimits();
      }
    }, NOTIFICATION_BG_POLL_MS);
  } else if (!shouldRun && notificationBackgroundTimer) {
    log.info('Stopping background notification poll');
    clearInterval(notificationBackgroundTimer);
    notificationBackgroundTimer = null;
  }
}

/**
 * Compute popover position relative to tray bounds
 */
function getPopoverPosition(): { x: number; y: number } {
  if (!mainWindow || !tray) return { x: 0, y: 0 };
  
  const windowBounds = mainWindow.getBounds();
  const trayBounds = tray.getBounds();
  // Find the display matching the tray bounds to support external displays correctly
  const activeDisplay = screen.getDisplayMatching(trayBounds);
  const displayBounds = activeDisplay.workArea;

  // Width and height of our popover window
  const width = windowBounds.width || 340;
  const height = windowBounds.height || 460;

  let x = 0;
  let y = 0;

  // On macOS, the menu bar is at the top. On Windows, taskbar is usually at the bottom.
  if (process.platform === 'darwin') {
    x = Math.round(trayBounds.x + (trayBounds.width / 2) - (width / 2));
    y = Math.round(trayBounds.y + trayBounds.height + 4);
  } else {
    // Windows or Linux
    x = Math.round(trayBounds.x + (trayBounds.width / 2) - (width / 2));
    y = Math.round(trayBounds.y - height - 4);
  }

  // Safety clamps to keep popover fully visible within screen display bounds
  x = Math.max(displayBounds.x, Math.min(x, displayBounds.x + displayBounds.width - width));
  y = Math.max(displayBounds.y, Math.min(y, displayBounds.y + displayBounds.height - height));

  return { x, y };
}

/**
 * Toggles visibility of the popover window
 */
function toggleWindow() {
  if (!mainWindow) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    const { x, y } = getPopoverPosition();
    mainWindow.setPosition(x, y, false);
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * Create popover BrowserWindow
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 340,
    height: 460,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist-preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Allow the popover to appear over fullscreen apps (e.g. fullscreen Chrome).
  // Requires the elevated 'screen-saver' window level plus visibility on all
  // Spaces including fullscreen ones; only meaningful on macOS but harmless elsewhere.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });

  // Security hardening: this window should never open popups or navigate away
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed = url.startsWith('file://') || (devUrl ? url.startsWith(devUrl) : false);
    if (!allowed) {
      event.preventDefault();
      log.warn('Blocked navigation attempt to:', url);
    }
  });

  // Load compiled production React bundle or local dev server URL
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  }

  // Hide window when it loses focus (macOS menu bar utility standard)
  mainWindow.on('blur', () => {
    if (mainWindow) {
      mainWindow.hide();
    }
  });

  mainWindow.on('show', () => {
    // Resume polling when panel is opened and refresh immediately
    startPolling();
    sendConfigStatus();
  });

  mainWindow.on('hide', () => {
    // Pause polling when panel is closed to conserve resources and API quotas
    stopPolling();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopPolling();
  });
}

/**
 * Check for app updates. Failures (no network, missing publish config,
 * placeholder owner/repo, etc.) are logged only — never shown to the user.
 */
async function checkForAppUpdates(): Promise<void> {
  try {
    log.info('Checking for application updates...');
    await autoUpdater.checkForUpdates();
  } catch (err: any) {
    log.warn('Auto-update check failed (non-fatal):', err?.message || err);
  }
}

/**
 * Prompt the user to restart once a downloaded update is ready.
 */
async function promptRestartToUpdate(version: string): Promise<void> {
  if (updatePromptShown) return;
  updatePromptShown = true;

  try {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${version} is ready to install.`,
      detail: 'Restart now to apply the update, or choose Later to install when you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    } else {
      log.info('User deferred update install; will apply on next quit.');
    }
  } catch (err: any) {
    log.warn('Failed to show update-ready dialog (non-fatal):', err?.message || err);
    updatePromptShown = false;
  }
}

/**
 * Wire electron-updater for packaged builds. Unpackaged / source builds
 * skip entirely so missing publish config never breaks local development.
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    log.info('Auto-updater skipped: app is not packaged (dev / from-source build).');
    return;
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('Auto-updater: checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    log.info(`Auto-updater: update available (${info.version}), downloading in background…`);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`Auto-updater: no update available (current ${info.version}).`);
  });

  autoUpdater.on('download-progress', (progress) => {
    log.debug(`Auto-updater download: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`Auto-updater: update ${info.version} downloaded and ready.`);
    void promptRestartToUpdate(info.version);
  });

  // Errors must never surface to the user (no network, bad/missing repo, etc.)
  autoUpdater.on('error', (err) => {
    log.warn('Auto-updater error (non-fatal):', err?.message || err);
  });

  // Defer the first check slightly so startup is not blocked by network I/O
  setTimeout(() => {
    void checkForAppUpdates();
  }, 3_000);

  updateCheckTimer = setInterval(() => {
    void checkForAppUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);

  log.info(`Auto-updater armed; periodic checks every ${UPDATE_CHECK_INTERVAL_MS / 3_600_000}h.`);
}

/**
 * Create system Tray icon
 */
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray', 'disconnected-0.png');
  if (fs.existsSync(iconPath)) {
    tray = new Tray(iconPath);
  } else {
    // Fallback if asset files are missing from the package
    const fallbackPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    if (fs.existsSync(fallbackPath)) {
      tray = new Tray(fallbackPath);
    } else {
      log.error('No tray icon assets found — using empty placeholder image.');
      tray = new Tray(nativeImage.createEmpty());
    }
  }
  
  tray.setToolTip('Claude Code Usage Tracker');
  tray.on('click', () => {
    toggleWindow();
  });
}

// Electron application lifecycle
app.whenReady().then(() => {
  configureMacDock();
  createMainWindow();
  createTray();

  // Initialize Telegram notification timers
  scheduleWeeklyReport();
  manageNotificationBackgroundPoll();

  // Auto-update: check on launch + periodically (no-ops / logs only when
  // unpackaged or when no GitHub Releases feed is configured yet).
  setupAutoUpdater();
  
  // Register powerMonitor event listeners
  powerMonitor.on('suspend', () => {
    log.info('System suspending. Suspending polling loops.');
    stopPolling();
  });

  powerMonitor.on('resume', () => {
    log.info('System resumed.');
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      log.info('Window is visible on resume. Restarting polling and refreshing immediately.');
      startPolling();
    }
  });

  if (process.platform === 'darwin') {
    powerMonitor.on('unlock-screen', () => {
      log.info('System screen unlocked.');
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        log.info('Window is visible on screen unlock. Restarting polling and refreshing immediately.');
        startPolling();
      }
    });
  }

  // Set up login item settings based on saved preference
  try {
    app.setLoginItemSettings({
      openAtLogin: launchAtLogin
    });
  } catch (err: any) {
    log.error('Failed to set login item settings:', err.message);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ── IPC Listeners for Settings and Actions ───────────────────────────────────

ipcMain.handle('get-settings', () => {
  const tgConfig = getTelegramConfig();
  const tgToken = getTelegramBotToken();
  return {
    pollIntervalRateLimit,
    pollIntervalSpend,
    monthlyBudget,
    launchAtLogin,
    hasAdminKey: !!getAdminApiKey(),
    oauthSource: getConfigStatus().oauthSource,
    appVersion: app.getVersion(),
    telegramEnabled: tgConfig.enabled,
    telegramNotifyRefresh: tgConfig.notifyRefresh,
    telegramNotifyWeekly: tgConfig.notifyWeekly,
    telegramWeeklyDay: tgConfig.weeklyDay,
    telegramWeeklyHour: tgConfig.weeklyHour,
    telegramChatId: getTelegramChatId(),
    hasTelegramToken: !!tgToken,
    telegramTokenHint: tgToken ? `••••${tgToken.slice(-4)}` : '',
    theme: (store.get('theme') as string) || 'system'
  };
});

ipcMain.handle('save-settings', async (_event, settings: any) => {
  if (!settings || typeof settings !== 'object') {
    return { success: false, error: 'Invalid settings payload.' };
  }

  let adminApiKey = '';
  if (settings.adminApiKey !== undefined) {
    if (typeof settings.adminApiKey !== 'string') {
      return { success: false, error: 'Admin API key must start with sk-ant-admin-.' };
    }

    const candidateAdminApiKey = settings.adminApiKey.trim();
    if (candidateAdminApiKey !== '' && !ADMIN_API_KEY_PATTERN.test(candidateAdminApiKey)) {
      log.warn('Rejected Admin API key with an invalid format.');
      return { success: false, error: 'Admin API key must start with sk-ant-admin-.' };
    }
    adminApiKey = candidateAdminApiKey;
  }

  if (settings.pollIntervalRateLimit !== undefined) {
    pollIntervalRateLimit = Math.max(MIN_POLL_INTERVAL, parseInt(settings.pollIntervalRateLimit, 10) || DEFAULT_POLL_INTERVAL);
    store.set('pollIntervalRateLimit', pollIntervalRateLimit);
  }
  if (settings.pollIntervalSpend !== undefined) {
    pollIntervalSpend = Math.max(MIN_POLL_INTERVAL, parseInt(settings.pollIntervalSpend, 10) || DEFAULT_POLL_INTERVAL);
    store.set('pollIntervalSpend', pollIntervalSpend);
  }
  if (settings.monthlyBudget !== undefined) {
    monthlyBudget = Math.max(0, parseFloat(settings.monthlyBudget) || 0.0);
    store.set('monthlyBudget', monthlyBudget);
  }
  if (settings.launchAtLogin !== undefined) {
    launchAtLogin = !!settings.launchAtLogin;
    store.set('launchAtLogin', launchAtLogin);
    try {
      app.setLoginItemSettings({
        openAtLogin: launchAtLogin
      });
    } catch (err: any) {
      log.error('Failed to update login item settings:', err.message);
    }
  }
  if (settings.theme !== undefined) {
    const validThemes = ['system', 'light', 'dark'];
    if (validThemes.includes(settings.theme)) {
      store.set('theme', settings.theme);
    }
  }
  
  if (adminApiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(adminApiKey).toString('base64');
      store.set('adminApiKeyEncrypted', encrypted);
    } else {
      // Never persist the key in a recoverable plaintext form (base64 is NOT
      // encryption). Refuse to save instead of silently degrading security.
      log.warn('OS-level encryption unavailable; refusing to store Admin API key.');
      startPolling();
      sendConfigStatus();
      return { success: false, error: 'Secure storage is unavailable on this system, so the API key was not saved.' };
    }
  }

  // ── Telegram Settings ──
  if (settings.telegramEnabled !== undefined) {
    store.set('telegramEnabled', !!settings.telegramEnabled);
  }
  if (settings.telegramNotifyRefresh !== undefined) {
    store.set('telegramNotifyRefresh', !!settings.telegramNotifyRefresh);
  }
  if (settings.telegramNotifyWeekly !== undefined) {
    store.set('telegramNotifyWeekly', !!settings.telegramNotifyWeekly);
  }
  if (settings.telegramWeeklyDay !== undefined) {
    const day = parseInt(settings.telegramWeeklyDay, 10);
    if (!isNaN(day) && day >= 0 && day <= 6) {
      store.set('telegramWeeklyDay', day);
    }
  }
  if (settings.telegramWeeklyHour !== undefined) {
    const hour = parseInt(settings.telegramWeeklyHour, 10);
    if (!isNaN(hour) && hour >= 0 && hour <= 23) {
      store.set('telegramWeeklyHour', hour);
    }
  }
  if (settings.telegramChatId !== undefined) {
    store.set('telegramChatId', String(settings.telegramChatId).trim());
  }
  if (settings.telegramBotToken !== undefined) {
    const candidateToken = String(settings.telegramBotToken).trim();
    if (candidateToken) {
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(candidateToken).toString('base64');
        store.set('telegramBotTokenEncrypted', encrypted);
      } else {
        log.warn('OS-level encryption unavailable; refusing to store Telegram bot token.');
        startPolling();
        sendConfigStatus();
        return { success: false, error: 'Secure storage is unavailable on this system, so the Telegram token was not saved.' };
      }
    }
  }

  log.info('Settings saved and updated successfully');
  
  // Restart polling with new interval rates
  startPolling();
  sendConfigStatus();

  // Re-schedule Telegram weekly report and manage background poll
  scheduleWeeklyReport();
  manageNotificationBackgroundPoll();
  
  return { success: true };
});

ipcMain.handle('remove-api-key', () => {
  store.delete('adminApiKeyEncrypted');
  spendData = { hasKey: false, error: null };
  
  log.info('Admin API key removed successfully');
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('spend-update', spendData);
  }
  sendConfigStatus();
  return { success: true };
});

ipcMain.handle('reset-all-data', () => {
  log.warn('Resetting all application data at the user\'s request.');
  stopPolling();

  // Clear Telegram timers
  if (weeklyReportTimer) { clearTimeout(weeklyReportTimer); weeklyReportTimer = null; }
  if (notificationBackgroundTimer) { clearInterval(notificationBackgroundTimer); notificationBackgroundTimer = null; }
  prevSessionPct = null;
  prevWeeklyPct = null;

  store.clear();
  pollIntervalRateLimit = DEFAULT_POLL_INTERVAL;
  pollIntervalSpend = DEFAULT_POLL_INTERVAL;
  monthlyBudget = DEFAULT_MONTHLY_BUDGET;
  launchAtLogin = false;
  cachedToken = null;
  rateLimitData = null;
  tokenCounts = { session_input: 0, session_output: 0, today_input: 0, today_output: 0, last_activity: null };
  spendData = null;

  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch (err: any) {
    log.error('Failed to disable launch at login during data reset:', err);
  }

  startPolling();
  sendConfigStatus();
  log.info('All application data was reset and polling restarted.');
  return { success: true };
});

ipcMain.handle('test-telegram', async () => {
  const token = getTelegramBotToken();
  const chatId = getTelegramChatId();

  if (!token || !chatId) {
    return { success: false, error: 'Bot token or chat ID is missing. Save settings first.' };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ *Claude Usage Tracker connected!*\nTelegram notifications are working.',
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      log.error(`Telegram test failed status=${response.status}: ${errText}`);
      return { success: false, error: `Telegram API error (${response.status})` };
    }

    log.info('Telegram test notification sent successfully');
    return { success: true };
  } catch (err: any) {
    log.error('Telegram test error:', err.message);
    return { success: false, error: err.message || 'Network error' };
  }
});

ipcMain.handle('test-connection', async () => {
  log.info('Testing Connection: triggering manual Rate Limit check');
  await fetchRateLimits();
  return {
    success: !rateLimitData?.error,
    error: rateLimitData?.error
  };
});

ipcMain.handle('refresh-all', async () => {
  log.info('Manual Refresh: triggering immediate data update');
  await Promise.all([
    fetchRateLimits(),
    fetchSpendReport()
  ]);
  updateTokenCounts();
  return { success: true };
});

ipcMain.on('close-settings', () => {
  log.info('Settings closed by renderer');
  // Re-push configurations and values — guard against null cached data
  // which can happen if Settings is opened before the first poll completes
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (rateLimitData) mainWindow.webContents.send('usage-update', rateLimitData);
    if (tokenCounts) mainWindow.webContents.send('tokens-update', tokenCounts);
    if (spendData) mainWindow.webContents.send('spend-update', spendData);
    sendConfigStatus();
  }
});
