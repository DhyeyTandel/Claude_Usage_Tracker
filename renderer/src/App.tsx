import { useEffect, useState } from 'react';
import { Gauge } from './components/Gauge';
import { WeeklyLimitRow } from './components/WeeklyLimitRow';
import { DataRow } from './components/DataRow';
import { StatusFooter } from './components/StatusFooter';

// Cast global window to access Preload IPC API
const electronAPI = (window as any).electronAPI;
const ADMIN_API_KEY_PATTERN = /^sk-ant-admin-\S+$/;
const ADMIN_API_KEY_ERROR = 'Admin API key must start with sk-ant-admin-.';

// Helper to format token counts in IBM Plex Mono (e.g. 1.2k / 340)
const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

// Helper to format countdowns (5h reset)
const formatCountdown = (s: number): string => {
  if (s <= 0) return 'NOW';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(sc).padStart(2, '0')}`;
};

// Helper to format resets epoch into local day/time string
const formatEpochToDayTime = (epochSecs: number, fallbackLabel: string): string => {
  if (!epochSecs || isNaN(epochSecs)) return fallbackLabel;
  const date = new Date(epochSecs * 1000);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = days[date.getDay()];
  const hrs = String(date.getHours()).padStart(2, '0');
  const mins = String(date.getMinutes()).padStart(2, '0');
  return `resets ${dayName} ${hrs}:${mins}`;
};

export default function App() {
  const [view, setView] = useState<'main' | 'settings'>('main');

  // Rate Limit usage state
  const [usage, setUsage] = useState<any>({
    session_pct: 0,
    weekly_pct: 0,
    reset_ts: 0,
    weekly_reset: 0,
    status: 'unknown',
    overage_pct: 0,
    overage_reset: 0,
    fetched_at: null,
    error: null
  });

  // Token counts state
  const [tokens, setTokens] = useState<any>({
    session_input: 0,
    session_output: 0,
    today_input: 0,
    today_output: 0,
    last_activity: null
  });

  // Spend state
  const [spend, setSpend] = useState<any>({
    hasKey: false,
    total_cost: 0,
    total_tokens: 0,
    budget_percent: 0,
    fetched_at: null,
    error: null
  });

  // Config availability status
  const [configStatus, setConfigStatus] = useState<any>({
    oauthSource: 'none',
    hasAdminKey: false
  });

  // Client-side countdown seconds
  const [sessionRemaining, setSessionRemaining] = useState<number>(0);
  const [refreshing, setRefreshing] = useState(false);

  // Settings form states
  const [adminApiKey, setAdminApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [monthlyBudgetInput, setMonthlyBudgetInput] = useState('');
  const [rateLimitPollInput, setRateLimitPollInput] = useState('');
  const [spendPollInput, setSpendPollInput] = useState('');
  const [launchAtLoginVal, setLaunchAtLoginVal] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [themeVal, setThemeVal] = useState<'system' | 'light' | 'dark'>('system');
  
  // Settings error/testing states
  const [settingsErrors, setSettingsErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ testing: boolean; success: boolean | null; error: string | null }>({
    testing: false,
    success: null,
    error: null
  });
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false);
  const [confirmResetAll, setConfirmResetAll] = useState(false);

  // Telegram notification settings states
  const [telegramEnabledVal, setTelegramEnabledVal] = useState(false);
  const [telegramBotTokenVal, setTelegramBotTokenVal] = useState('');
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [telegramChatIdVal, setTelegramChatIdVal] = useState('');
  const [telegramNotifyRefreshVal, setTelegramNotifyRefreshVal] = useState(true);
  const [telegramNotifyWeeklyVal, setTelegramNotifyWeeklyVal] = useState(true);
  const [telegramWeeklyDayVal, setTelegramWeeklyDayVal] = useState(0);
  const [telegramWeeklyHourVal, setTelegramWeeklyHourVal] = useState(9);
  const [hasTelegramToken, setHasTelegramToken] = useState(false);
  const [telegramTokenHint, setTelegramTokenHint] = useState('');
  const [telegramTestResult, setTelegramTestResult] = useState<{ testing: boolean; success: boolean | null; error: string | null }>({
    testing: false,
    success: null,
    error: null
  });

  // Subscribe to Electron IPC data events
  useEffect(() => {
    const unsubUsage = electronAPI.onUsageUpdate((data: any) => {
      if (data) setUsage(data);
    });

    const unsubTokens = electronAPI.onTokensUpdate((data: any) => {
      if (data) setTokens(data);
    });

    const unsubSpend = electronAPI.onSpendUpdate((data: any) => {
      if (data) setSpend(data);
    });

    const unsubConfig = electronAPI.onConfigStatusUpdate((data: any) => {
      if (data) setConfigStatus(data);
    });

    // Load initial theme and settings
    const initTheme = async () => {
      try {
        const config = await electronAPI.getSettings();
        if (config && config.theme) {
          applyTheme(config.theme);
        }
      } catch (err) {
        console.error('Failed to load initial settings:', err);
      }
    };
    initTheme();

    // Manual initial refresh
    handleRefreshAll();

    return () => {
      unsubUsage();
      unsubTokens();
      unsubSpend();
      unsubConfig();
    };
  }, []);

  // Update client-side countdowns every second
  useEffect(() => {
    const interval = setInterval(() => {
      const nowSecs = Date.now() / 1000;
      if (usage.reset_ts > 0) {
        setSessionRemaining(Math.max(0, usage.reset_ts - nowSecs));
      } else {
        setSessionRemaining(0);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [usage.reset_ts]);

  // Trigger manual refresh
  const handleRefreshAll = async () => {
    setRefreshing(true);
    try {
      await electronAPI.refreshAll();
    } catch {}
    setRefreshing(false);
  };

  const applyTheme = (theme: 'system' | 'light' | 'dark') => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  };

  const handleCancelSettings = async () => {
    const config = await electronAPI.getSettings();
    applyTheme(config.theme || 'system');
    electronAPI.closeSettings();
    setView('main');
  };

  // Load configuration details when opening Settings view
  const handleOpenSettings = async () => {
    const config = await electronAPI.getSettings();
    setMonthlyBudgetInput(String(config.monthlyBudget));
    setRateLimitPollInput(String(config.pollIntervalRateLimit));
    setRateLimitPollInput(String(config.pollIntervalRateLimit));
    setSpendPollInput(String(config.pollIntervalSpend));
    setLaunchAtLoginVal(config.launchAtLogin);
    setThemeVal(config.theme || 'system');
    setAppVersion(config.appVersion || '');
    setAdminApiKey('');
    setShowApiKey(false);
    setSettingsErrors({});
    setTestResult({ testing: false, success: null, error: null });
    setConfirmRemoveKey(false);
    setConfirmResetAll(false);

    // Load Telegram config
    setTelegramEnabledVal(config.telegramEnabled || false);
    setTelegramNotifyRefreshVal(config.telegramNotifyRefresh !== false);
    setTelegramNotifyWeeklyVal(config.telegramNotifyWeekly !== false);
    setTelegramWeeklyDayVal(config.telegramWeeklyDay ?? 0);
    setTelegramWeeklyHourVal(config.telegramWeeklyHour ?? 9);
    setTelegramChatIdVal(config.telegramChatId || '');
    setTelegramBotTokenVal('');
    setShowTelegramToken(false);
    setHasTelegramToken(config.hasTelegramToken || false);
    setTelegramTokenHint(config.telegramTokenHint || '');
    setTelegramTestResult({ testing: false, success: null, error: null });

    setView('settings');
  };

  // Save Settings configurations with validation
  const handleSaveSettings = async () => {
    const errors: Record<string, string> = {};

    const budgetNum = parseFloat(monthlyBudgetInput);
    if (isNaN(budgetNum) || budgetNum < 0) {
      errors.budget = 'Must be a positive number';
    }

    const rateLimitNum = parseInt(rateLimitPollInput, 10);
    if (isNaN(rateLimitNum) || rateLimitNum < 60) {
      errors.rateLimit = 'Must be at least 60 seconds';
    }

    const spendNum = parseInt(spendPollInput, 10);
    if (isNaN(spendNum) || spendNum < 60) {
      errors.spend = 'Must be at least 60 seconds';
    }

    const trimmedAdminApiKey = adminApiKey.trim();
    if (trimmedAdminApiKey !== '' && !ADMIN_API_KEY_PATTERN.test(trimmedAdminApiKey)) {
      errors.apiKey = ADMIN_API_KEY_ERROR;
    }

    if (Object.keys(errors).length > 0) {
      setSettingsErrors(errors);
      return;
    }

    const dataToSave: any = {
      monthlyBudget: budgetNum,
      pollIntervalRateLimit: rateLimitNum,
      pollIntervalSpend: spendNum,
      launchAtLogin: launchAtLoginVal,
      theme: themeVal
    };

    if (trimmedAdminApiKey !== '') {
      dataToSave.adminApiKey = trimmedAdminApiKey;
    }

    // Telegram fields
    dataToSave.telegramEnabled = telegramEnabledVal;
    dataToSave.telegramNotifyRefresh = telegramNotifyRefreshVal;
    dataToSave.telegramNotifyWeekly = telegramNotifyWeeklyVal;
    dataToSave.telegramWeeklyDay = telegramWeeklyDayVal;
    dataToSave.telegramWeeklyHour = telegramWeeklyHourVal;
    dataToSave.telegramChatId = telegramChatIdVal;
    if (telegramBotTokenVal.trim()) {
      dataToSave.telegramBotToken = telegramBotTokenVal.trim();
    }

    const result = await electronAPI.saveSettings(dataToSave);
    if (result && result.success === false) {
      setSettingsErrors({ apiKey: result.error || 'Failed to save settings' });
      return;
    }
    electronAPI.closeSettings();
    setView('main');
  };

  const handleRemoveApiKey = async () => {
    if (!confirmRemoveKey) {
      setConfirmRemoveKey(true);
      return;
    }
    await electronAPI.removeApiKey();
    setConfirmRemoveKey(false);
    const config = await electronAPI.getSettings();
    setConfigStatus({ ...configStatus, hasAdminKey: config.hasAdminKey });
  };

  const handleResetAllData = async () => {
    if (!confirmResetAll) {
      setConfirmResetAll(true);
      return;
    }

    const result = await electronAPI.resetAllData();
    if (result && result.success === false) {
      setSettingsErrors({ reset: result.error || 'Failed to reset application data.' });
      return;
    }

    const config = await electronAPI.getSettings();
    setMonthlyBudgetInput(String(config.monthlyBudget));
    setRateLimitPollInput(String(config.pollIntervalRateLimit));
    setSpendPollInput(String(config.pollIntervalSpend));
    setLaunchAtLoginVal(config.launchAtLogin);
    setThemeVal(config.theme || 'system');
    applyTheme(config.theme || 'system');
    setAdminApiKey('');
    setShowApiKey(false);
    setSettingsErrors({});
    setConfirmRemoveKey(false);
    setConfirmResetAll(false);
    setConfigStatus({ oauthSource: config.oauthSource, hasAdminKey: config.hasAdminKey });
  };

  const handleTestConnection = async () => {
    setTestResult({ testing: true, success: null, error: null });
    const res = await electronAPI.testConnection();
    setTestResult({
      testing: false,
      success: res.success,
      error: res.error
    });
  };

  const handleTestTelegram = async () => {
    setTelegramTestResult({ testing: true, success: null, error: null });
    const res = await electronAPI.testTelegram();
    setTelegramTestResult({
      testing: false,
      success: res.success,
      error: res.error
    });
  };

  // Check if data sources are stale (>15 minutes = 900 seconds)
  const isUsageStale = usage.fetched_at && (Date.now() - usage.fetched_at > 15 * 60 * 1000);
  const isSpendStale = spend.fetched_at && (Date.now() - spend.fetched_at > 15 * 60 * 1000);

  return (
    <div className="w-[340px] h-[460px] flex flex-col justify-between px-4 py-3 select-none border border-hairline-all shadow-xl bg-[var(--bg-primary)] text-[var(--text-primary)]">
      
      {view === 'main' ? (
        <>
          {/* Main Dashboard Panel */}
          <div className="flex flex-col flex-1 justify-between">
            {/* Header row */}
            <div className="flex justify-between items-center pb-2.5 border-b border-hairline-b">
              <div className="flex items-center">
                <span className="text-[10px] tracking-widest font-sans-plex font-bold text-[var(--text-primary)]">
                  CLAUDE USAGE
                </span>
                {/* Plan badge: PRO when subscription limits are live, API when
                    only an Admin key is configured, hidden otherwise */}
                {(!usage.error || configStatus.hasAdminKey) && (
                  <span className="text-[9px] font-sans-plex font-bold tracking-wider text-[var(--text-secondary)] bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded-sm uppercase ml-2 leading-none">
                    {!usage.error ? 'PRO' : 'API'}
                  </span>
                )}
              </div>
              <button 
                onClick={handleOpenSettings}
                className="text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-colors focus:outline-none"
                title="Settings"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>

            {/* Section 1: Session 5H */}
            <div className="py-2.5 flex flex-col justify-between flex-1">
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-[10px] tracking-widest font-sans-plex font-bold text-[var(--text-dim)] uppercase">
                  SESSION · 5H
                </span>
                <span className="font-mono-plex text-[9px] text-[var(--text-dim)]">
                  {usage.error ? 'disconnected' : `resets in ${formatCountdown(sessionRemaining)}`}
                </span>
              </div>
              
              {usage.error ? (
                <div className="text-[10px] text-[var(--text-dim)] italic py-2 leading-relaxed">
                  Requires a Claude Pro/Max subscription with Claude Code signed in
                </div>
              ) : (
                <div className={`flex flex-col ${isUsageStale ? 'opacity-40' : ''}`}>
                  <div className="my-1">
                    <span className="font-serif-fraunces text-[36px] tracking-tight leading-none">
                      {Math.min(100, Math.round(usage.session_pct * 100))}%
                    </span>
                  </div>
                  
                  <div className="my-1.5">
                    <Gauge 
                      percent={usage.session_pct} 
                      height={5.5}
                      pulse={usage.session_pct >= 0.9}
                    />
                  </div>
                  
                  {tokens.last_activity && (Date.now() - tokens.last_activity) < 5 * 60 * 60 * 1000 ? (
                    <div className="flex justify-between items-center font-mono-plex text-[9px] text-[var(--text-dim)] mt-0.5">
                      <span>in {formatTokens(tokens.session_input)}</span>
                      <span>out {formatTokens(tokens.session_output)}</span>
                    </div>
                  ) : (
                    <div className="font-sans-plex text-[9px] text-[var(--text-dim)] italic mt-0.5">
                      No Claude Code CLI activity in this window — session % above includes claude.ai and API usage too.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Hairline Divider */}
            <div className="border-t border-hairline-t"></div>

            {/* Section 2: Weekly Limits */}
            <div className="py-2.5 flex flex-col justify-between flex-1">
              <span className="text-[10px] tracking-widest font-sans-plex font-bold text-[var(--text-dim)] uppercase mb-1">
                WEEKLY LIMITS
              </span>

              {usage.error ? (
                <div className="text-[10px] text-[var(--text-dim)] italic py-2 leading-relaxed">
                  Requires a Claude Pro/Max subscription with Claude Code signed in
                </div>
              ) : (
                <div className={`flex flex-col space-y-1.5 ${isUsageStale ? 'opacity-40' : ''}`}>
                  {/* Repeatable weekly limit rows */}
                  <WeeklyLimitRow
                    label="All models"
                    percent={usage.weekly_pct}
                    resetsCaption={formatEpochToDayTime(usage.weekly_reset, 'resets Sunday 12:00')}
                  />
                  {(usage.models && usage.models.length > 0) ? (
                    usage.models.map((m: any) => (
                      <WeeklyLimitRow
                        key={m.name}
                        label={m.name}
                        percent={m.pct}
                        resetsCaption={formatEpochToDayTime(m.reset, 'resets Sunday 12:00')}
                      />
                    ))
                  ) : (
                    <div className="flex justify-between items-baseline opacity-50">
                      <span className="text-[10px] font-sans-plex text-[var(--text-dim)]">Fable</span>
                      <span className="font-mono-plex text-[9px] text-[var(--text-dim)]">not available via API</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Hairline Divider */}
            <div className="border-t border-hairline-t"></div>

            {/* Section 3: Spend This Month */}
            <div className="py-2.5 flex flex-col justify-between flex-1">
              <span className="text-[10px] tracking-widest font-sans-plex font-bold text-[var(--text-dim)] uppercase mb-1">
                SPEND · THIS MONTH
              </span>
              
              {!configStatus.hasAdminKey ? (
                <div className="text-[10px] text-[var(--text-dim)] italic py-2 leading-relaxed">
                  Add an Admin API key in Settings to see spend
                </div>
              ) : spend.error ? (
                <div className="flex flex-col py-1">
                  <span className="text-[9px] font-sans-plex text-rose-500 mb-1.5 truncate">
                    Spend Load Error: {spend.error}
                  </span>
                  <button 
                    onClick={() => electronAPI.refreshAll()}
                    className="self-start text-[8px] font-bold font-sans-plex uppercase tracking-wider text-[var(--accent-color)] hover:opacity-85 border border-hairline-all px-2 py-0.5 rounded-sm"
                  >
                    Retry Spend Load
                  </button>
                </div>
              ) : (
                <div className={`flex flex-col ${isSpendStale ? 'opacity-40' : ''}`}>
                  <DataRow 
                    label="Total" 
                    value={`$${(spend.total_cost || 0.0).toFixed(2)}`} 
                    valueClass="font-bold text-[var(--text-primary)] text-xs"
                  />
                  <DataRow 
                    label="Budget" 
                    value={`${(spend.budget_percent || 0.0).toFixed(1)}%`} 
                  />
                </div>
              )}
            </div>
          </div>

          {/* Footer Section */}
          <StatusFooter 
            status={usage.error ? 'disconnected' : usage.status} 
            fetchedAt={usage.fetched_at}
            onRefresh={handleRefreshAll}
            refreshing={refreshing}
          />
        </>
      ) : (
        /* Settings swap-in view */
        <div className="flex flex-col h-full justify-between overflow-y-auto pr-0.5">
          <div>
            {/* Settings Header */}
            <div className="flex justify-between items-center pb-2 border-b border-hairline-b mb-3">
              <span className="text-[10px] tracking-widest font-sans-plex font-bold text-[var(--text-primary)] uppercase">
                SETTINGS
              </span>
              <button 
                onClick={handleSaveSettings}
                className="text-[10px] font-sans-plex font-bold text-[var(--accent-color)] uppercase tracking-wider hover:opacity-80 focus:outline-none"
              >
                Save
              </button>
            </div>

            {/* API Spend section */}
            <div className="mb-4">
              <div className="text-[9px] font-sans-plex font-bold tracking-widest text-[var(--text-dim)] uppercase mb-2">
                API Spend
              </div>
              
              <div className="flex flex-col space-y-2.5">
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium">Admin API Key</label>
                    {configStatus.hasAdminKey && (
                      <button 
                        onClick={handleRemoveApiKey}
                        className="text-[8px] font-sans-plex font-bold uppercase tracking-wider text-rose-500 hover:opacity-80"
                      >
                        {confirmRemoveKey ? 'Confirm?' : 'Remove Key'}
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input 
                      type={showApiKey ? 'text' : 'password'}
                      value={adminApiKey}
                      onChange={(e) => {
                        const value = e.target.value;
                        setAdminApiKey(value);
                        setSettingsErrors((currentErrors) => {
                          const nextErrors = { ...currentErrors };
                          if (value.trim() !== '' && !ADMIN_API_KEY_PATTERN.test(value.trim())) {
                            nextErrors.apiKey = ADMIN_API_KEY_ERROR;
                          } else {
                            delete nextErrors.apiKey;
                          }
                          return nextErrors;
                        });
                      }}
                      placeholder={configStatus.hasAdminKey ? '••••••••••••••••••••' : 'sk-ant-admin...'}
                      className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                    />
                    <button 
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2 top-1.5 text-[9px] font-sans-plex text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                    >
                      {showApiKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {settingsErrors.apiKey && (
                    <span className="text-[9px] font-sans-plex text-rose-500 mt-0.5">{settingsErrors.apiKey}</span>
                  )}
                </div>

                <div>
                  <label className="block text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium mb-1">Monthly Budget (USD)</label>
                  <input 
                    type="number"
                    step="0.01"
                    min="0"
                    value={monthlyBudgetInput}
                    onChange={(e) => {
                      setMonthlyBudgetInput(e.target.value);
                      if (settingsErrors.budget) {
                        const newErrs = { ...settingsErrors };
                        delete newErrs.budget;
                        setSettingsErrors(newErrs);
                      }
                    }}
                    className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                  />
                  {settingsErrors.budget && (
                    <span className="text-[9px] font-sans-plex text-rose-500 mt-0.5">{settingsErrors.budget}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Claude Code Source section */}
            <div className="mb-4 pt-2 border-t border-hairline-t">
              <div className="text-[9px] font-sans-plex font-bold tracking-widest text-[var(--text-dim)] uppercase mb-2">
                Claude Code Credentials
              </div>
              <div className="flex justify-between items-center text-xs py-1">
                <span className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium">Source Found</span>
                <span className="font-mono-plex text-[9px] text-[var(--text-dim)] uppercase bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded border border-hairline-all">
                  {configStatus.oauthSource}
                </span>
              </div>
              <div className="mt-2.5 flex items-center space-x-2">
                <button 
                  onClick={handleTestConnection}
                  disabled={testResult.testing}
                  className="text-[9px] font-sans-plex font-bold uppercase tracking-wider text-[var(--text-primary)] border border-hairline-all hover:bg-[var(--bg-secondary)] px-2.5 py-0.5 rounded-sm transition-colors"
                >
                  {testResult.testing ? 'Testing...' : 'Test Connection'}
                </button>
                {testResult.success !== null && (
                  <span className={`text-[10px] font-sans-plex font-semibold ${testResult.success ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {testResult.success ? 'Pass ✓' : `Fail: ${testResult.error}`}
                  </span>
                )}
              </div>
            </div>

            {/* Telegram Notifications section */}
            <div className="mb-4 pt-2 border-t border-hairline-t">
              <div className="text-[9px] font-sans-plex font-bold tracking-widest text-[var(--text-dim)] uppercase mb-2">
                Telegram Notifications
              </div>

              <div className="flex flex-col space-y-2.5">
                {/* Enable toggle */}
                <div className="flex items-center space-x-2 py-0.5">
                  <input
                    type="checkbox"
                    id="telegramEnabled"
                    checked={telegramEnabledVal}
                    onChange={(e) => setTelegramEnabledVal(e.target.checked)}
                    className="w-3 h-3 accent-[var(--accent-color)]"
                  />
                  <label htmlFor="telegramEnabled" className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium select-none cursor-pointer">
                    Enable Telegram notifications
                  </label>
                </div>

                {telegramEnabledVal && (
                  <>
                    {/* Bot Token */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium">Bot Token</label>
                      </div>
                      <div className="relative">
                        <input
                          type={showTelegramToken ? 'text' : 'password'}
                          value={telegramBotTokenVal}
                          onChange={(e) => setTelegramBotTokenVal(e.target.value)}
                          placeholder={hasTelegramToken ? telegramTokenHint : 'Paste token from @BotFather'}
                          className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTelegramToken(!showTelegramToken)}
                          className="absolute right-2 top-1.5 text-[9px] font-sans-plex text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                        >
                          {showTelegramToken ? 'Hide' : 'Show'}
                        </button>
                      </div>
                    </div>

                    {/* Chat ID */}
                    <div>
                      <label className="block text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium mb-1">Chat ID</label>
                      <input
                        type="text"
                        value={telegramChatIdVal}
                        onChange={(e) => setTelegramChatIdVal(e.target.value)}
                        placeholder="e.g. 123456789"
                        className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                      />
                    </div>

                    {/* Test button */}
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={handleTestTelegram}
                        disabled={telegramTestResult.testing}
                        className="text-[9px] font-sans-plex font-bold uppercase tracking-wider text-[var(--text-primary)] border border-hairline-all hover:bg-[var(--bg-secondary)] px-2.5 py-0.5 rounded-sm transition-colors"
                      >
                        {telegramTestResult.testing ? 'Sending...' : 'Test Notification'}
                      </button>
                      {telegramTestResult.success !== null && (
                        <span className={`text-[10px] font-sans-plex font-semibold ${telegramTestResult.success ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {telegramTestResult.success ? 'Sent ✓' : `Fail: ${telegramTestResult.error}`}
                        </span>
                      )}
                    </div>

                    {/* Notification type toggles */}
                    <div className="border-t border-hairline-t pt-2 mt-1">
                      <div className="flex items-center space-x-2 py-0.5">
                        <input
                          type="checkbox"
                          id="notifyRefresh"
                          checked={telegramNotifyRefreshVal}
                          onChange={(e) => setTelegramNotifyRefreshVal(e.target.checked)}
                          className="w-3 h-3 accent-[var(--accent-color)]"
                        />
                        <label htmlFor="notifyRefresh" className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium select-none cursor-pointer">
                          Notify on limit refresh
                        </label>
                      </div>

                      <div className="flex items-center space-x-2 py-0.5 mt-1">
                        <input
                          type="checkbox"
                          id="notifyWeekly"
                          checked={telegramNotifyWeeklyVal}
                          onChange={(e) => setTelegramNotifyWeeklyVal(e.target.checked)}
                          className="w-3 h-3 accent-[var(--accent-color)]"
                        />
                        <label htmlFor="notifyWeekly" className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium select-none cursor-pointer">
                          Weekly usage summary
                        </label>
                      </div>
                    </div>

                    {/* Weekly schedule selectors */}
                    {telegramNotifyWeeklyVal && (
                      <div className="flex gap-3 mt-1">
                        <div className="flex-1">
                          <label className="block text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium mb-1">Summary day</label>
                          <select
                            value={telegramWeeklyDayVal}
                            onChange={(e) => setTelegramWeeklyDayVal(parseInt(e.target.value, 10))}
                            className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                          >
                            <option value={0}>Sunday</option>
                            <option value={1}>Monday</option>
                            <option value={2}>Tuesday</option>
                            <option value={3}>Wednesday</option>
                            <option value={4}>Thursday</option>
                            <option value={5}>Friday</option>
                            <option value={6}>Saturday</option>
                          </select>
                        </div>
                        <div className="flex-1">
                          <label className="block text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium mb-1">Summary hour</label>
                          <select
                            value={telegramWeeklyHourVal}
                            onChange={(e) => setTelegramWeeklyHourVal(parseInt(e.target.value, 10))}
                            className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                          >
                            {Array.from({ length: 24 }, (_, i) => (
                              <option key={i} value={i}>
                                {String(i).padStart(2, '0')}:00
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}

                    {/* Helper text */}
                    <div className="text-[8px] font-sans-plex text-[var(--text-dim)] leading-relaxed mt-1">
                      Create a bot via @BotFather on Telegram. Then message your bot and visit
                      {' '}<span className="font-mono-plex">api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</span>{' '}
                      to find your Chat ID.
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* General Settings Section */}
            <div className="mb-4 pt-2 border-t border-hairline-t">
              <div className="text-[9px] font-sans-plex font-bold tracking-widest text-[var(--text-dim)] uppercase mb-2">
                General Settings
              </div>
              
              <div className="flex flex-col space-y-2.5">
                {/* Theme Selector Segmented Switch */}
                <div>
                  <label className="block text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium mb-1.5">Theme</label>
                  <div className="flex border border-hairline-all rounded bg-[var(--bg-secondary)] p-0.5 w-full select-none">
                    {(['system', 'light', 'dark'] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setThemeVal(t);
                          applyTheme(t);
                        }}
                        className={`flex-1 text-[9px] font-sans-plex font-bold uppercase tracking-wider py-1 rounded transition-all focus:outline-none ${
                          themeVal === t
                            ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                            : 'text-[var(--text-dim)] hover:text-[var(--text-secondary)]'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium mb-1">Rate-Limit Poll Interval (sec)</label>
                  <input 
                    type="number"
                    min="60"
                    value={rateLimitPollInput}
                    onChange={(e) => {
                      setRateLimitPollInput(e.target.value);
                      if (settingsErrors.rateLimit) {
                        const newErrs = { ...settingsErrors };
                        delete newErrs.rateLimit;
                        setSettingsErrors(newErrs);
                      }
                    }}
                    className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                  />
                  {settingsErrors.rateLimit && (
                    <span className="text-[9px] font-sans-plex text-rose-500 mt-0.5">{settingsErrors.rateLimit}</span>
                  )}
                </div>

                <div>
                  <label className="block text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium mb-1">Spend Report Poll Interval (sec)</label>
                  <input 
                    type="number"
                    min="60"
                    value={spendPollInput}
                    onChange={(e) => {
                      setSpendPollInput(e.target.value);
                      if (settingsErrors.spend) {
                        const newErrs = { ...settingsErrors };
                        delete newErrs.spend;
                        setSettingsErrors(newErrs);
                      }
                    }}
                    className="w-full text-xs font-mono-plex bg-[var(--bg-secondary)] border border-hairline-all rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-color)]"
                  />
                  {settingsErrors.spend && (
                    <span className="text-[9px] font-sans-plex text-rose-500 mt-0.5">{settingsErrors.spend}</span>
                  )}
                </div>

                <div className="flex items-center space-x-2 py-1">
                  <input 
                    type="checkbox"
                    id="launchAtLogin"
                    checked={launchAtLoginVal}
                    onChange={(e) => setLaunchAtLoginVal(e.target.checked)}
                    className="w-3 h-3 accent-[var(--accent-color)]"
                  />
                  <label htmlFor="launchAtLogin" className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium select-none cursor-pointer">
                    Launch app at login
                  </label>
                </div>

                <div className="pt-2 border-t border-hairline-t">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-sans-plex text-[var(--text-secondary)] font-medium">Reset all data</div>
                      <div className="text-[9px] font-sans-plex text-[var(--text-dim)] mt-0.5">Clears every saved setting and restarts polling.</div>
                    </div>
                    <button
                      type="button"
                      onClick={handleResetAllData}
                      className="shrink-0 text-[9px] font-sans-plex font-bold uppercase tracking-wider text-rose-500 border border-rose-500/40 hover:bg-rose-500/10 px-2 py-1 rounded-sm transition-colors"
                    >
                      {confirmResetAll ? 'Confirm Reset' : 'Reset All Data'}
                    </button>
                  </div>
                  {confirmResetAll && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[9px] font-sans-plex text-rose-500">This removes the saved API key too.</span>
                      <button
                        type="button"
                        onClick={() => setConfirmResetAll(false)}
                        className="text-[9px] font-sans-plex text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {settingsErrors.reset && (
                    <span className="text-[9px] font-sans-plex text-rose-500 mt-0.5">{settingsErrors.reset}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Settings cancel button + version */}
          <div className="pt-2 border-t border-hairline-t flex justify-between items-center">
            <span className="text-[9px] font-mono-plex text-[var(--text-dim)]">
              {appVersion ? `v${appVersion}` : ''}
            </span>
            <button 
              onClick={handleCancelSettings}
              className="text-[10px] font-sans-plex font-bold text-[var(--text-dim)] uppercase tracking-wider hover:text-[var(--text-secondary)] py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
    </div>
  );
}
