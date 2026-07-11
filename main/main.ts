import { app, BrowserWindow, Tray, ipcMain, safeStorage, screen, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import Store from 'electron-store';
import log from 'electron-log';

// Configure logging
log.initialize();
log.info('Application starting...');

// Declare instances
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
const store = new Store();

// Default configuration constants
const MIN_POLL_INTERVAL = 60; // 1 minute hard floor

// Polling interval state (in seconds)
let pollIntervalRateLimit = Math.max(MIN_POLL_INTERVAL, (store.get('pollIntervalRateLimit') as number) || 300);
let pollIntervalSpend = Math.max(MIN_POLL_INTERVAL, (store.get('pollIntervalSpend') as number) || 300);
let monthlyBudget = (store.get('monthlyBudget') as number) || 100.0;
let launchAtLogin = !!store.get('launchAtLogin');

// Data caches
let rateLimitData: any = null;
let tokenCounts: any = { session_input: 0, session_output: 0, today_input: 0, today_output: 0, last_activity: null };
let spendData: any = null;

// Polling timers
let rateLimitTimer: NodeJS.Timeout | null = null;
let tokenTimer: NodeJS.Timeout | null = null;
let spendTimer: NodeJS.Timeout | null = null;

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

/**
 * Resolves local Claude credentials.
 * 1. Checks ~/.claude/.credentials.json
 * 2. On macOS, falls back to Keychain security CLI search
 */
function getOAuthToken(): { token: string; source: string } {
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  
  if (fs.existsSync(credsPath)) {
    try {
      const content = fs.readFileSync(credsPath, 'utf-8');
      const parsed = JSON.parse(content);
      const token = parsed?.claudeAiOauth?.accessToken;
      if (token) {
        return { token, source: 'credentials file' };
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
        const token = parsed?.claudeAiOauth?.accessToken;
        if (token) {
          return { token, source: 'Keychain' };
        }
      }
    } catch (err: any) {
      log.error('Failed to read from macOS Keychain:', err.message);
    }
  }

  throw new Error('No credentials found');
}

/**
 * Update the dynamic tray icon based on status and percentage.
 * Uses pre-generated partial-ring icons.
 */
function updateTrayIcon(pctVal: number, statusStr: string, hasError: boolean) {
  if (!tray) return;

  let statusPrefix = 'disconnected';
  if (!hasError) {
    if (statusStr === 'allowed') statusPrefix = 'allowed';
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

  // Update hover tooltip: "exact percentage and status in the hover tooltip instead"
  const pctDisplay = Math.round(pctVal * 100);
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
    const { token } = getOAuthToken();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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

    if (!response.ok) {
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

  // Set up 5-hour cutoff window for session tokens
  const SESSION_HOURS = 5;
  const cutoffTime = Date.now() - SESSION_HOURS * 60 * 60 * 1000;

  // Local YYYY-MM-DD string
  const d = new Date();
  const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

        let inp = parseInt(obj.inputTokens, 10) || 0;
        let out = parseInt(obj.outputTokens, 10) || 0;
        
        if (!inp && !out) {
          const u = obj.message?.usage || {};
          inp = (parseInt(u.input_tokens, 10) || 0) + (parseInt(u.cache_creation_input_tokens, 10) || 0);
          out = parseInt(u.output_tokens, 10) || 0;
        }

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
          }
        }
      }
    } catch (err: any) {
      log.error('Failed reading tokens JSONL file:', item.file, err.message);
    }
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

/**
 * Compute popover position relative to tray bounds
 */
function getPopoverPosition(): { x: number; y: number } {
  if (!mainWindow || !tray) return { x: 0, y: 0 };
  
  const windowBounds = mainWindow.getBounds();
  const trayBounds = tray.getBounds();
  const primaryDisplay = screen.getPrimaryDisplay();
  const displayBounds = primaryDisplay.workArea;

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
  return {
    pollIntervalRateLimit,
    pollIntervalSpend,
    monthlyBudget,
    launchAtLogin,
    hasAdminKey: !!getAdminApiKey(),
    oauthSource: getConfigStatus().oauthSource
  };
});

ipcMain.handle('save-settings', async (_event, settings: any) => {
  if (settings.pollIntervalRateLimit !== undefined) {
    pollIntervalRateLimit = Math.max(MIN_POLL_INTERVAL, parseInt(settings.pollIntervalRateLimit, 10) || 300);
    store.set('pollIntervalRateLimit', pollIntervalRateLimit);
  }
  if (settings.pollIntervalSpend !== undefined) {
    pollIntervalSpend = Math.max(MIN_POLL_INTERVAL, parseInt(settings.pollIntervalSpend, 10) || 300);
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
  
  if (settings.adminApiKey !== undefined && typeof settings.adminApiKey === 'string' && settings.adminApiKey.trim() !== '') {
    const rawKey = settings.adminApiKey.trim();
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(rawKey).toString('base64');
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

  log.info('Settings saved and updated successfully');
  
  // Restart polling with new interval rates
  startPolling();
  sendConfigStatus();
  
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
  // Re-push configurations and values
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage-update', rateLimitData);
    mainWindow.webContents.send('tokens-update', tokenCounts);
    mainWindow.webContents.send('spend-update', spendData);
    sendConfigStatus();
  }
});
