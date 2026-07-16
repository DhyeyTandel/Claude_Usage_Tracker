import React from 'react';

interface StatusFooterProps {
  status: string;
  fetchedAt: number | null;
  onRefresh: () => void;
  refreshing: boolean;
}

export const StatusFooter: React.FC<StatusFooterProps> = ({
  status,
  fetchedAt,
  onRefresh,
  refreshing
}) => {
  const [timeAgo, setTimeAgo] = React.useState('never');

  React.useEffect(() => {
    if (!fetchedAt) {
      setTimeAgo('never');
      return;
    }

    const updateText = () => {
      const diffSecs = Math.floor((Date.now() - fetchedAt) / 1000);
      if (diffSecs < 10) {
        setTimeAgo('just now');
      } else if (diffSecs < 60) {
        setTimeAgo(`${diffSecs}s ago`);
      } else if (diffSecs < 3600) {
        const mins = Math.floor(diffSecs / 60);
        setTimeAgo(`${mins}m ago`);
      } else {
        const hrs = Math.floor(diffSecs / 3600);
        setTimeAgo(`${hrs}h ago`);
      }
    };

    updateText();
    const interval = setInterval(updateText, 5000);
    return () => clearInterval(interval);
  }, [fetchedAt]);

  // Dot color matching the desaturated semantic colors
  let dotStyle = { backgroundColor: 'var(--text-dim)' }; // Fallback gray
  if (status === 'allowed') {
    dotStyle = { backgroundColor: 'var(--status-allowed)' };
  } else if (status === 'soft_limited' || status === 'allowed_warning') {
    dotStyle = { backgroundColor: 'var(--status-soft-limit)' };
  } else if (status === 'hard_limited') {
    dotStyle = { backgroundColor: 'var(--status-hard-limit)' };
  }

  // Display status text labels
  const displayStatus = status ? status.replace('_', ' ') : 'disconnected';

  return (
    <div className="flex justify-between items-center py-2.5 border-t border-hairline-t select-none">
      {/* Left side: Status dot and text */}
      <div className="flex items-center space-x-2">
        <span 
          className="w-1.5 h-1.5 rounded-full transition-colors duration-300" 
          style={dotStyle}
        />
        <span className="uppercase text-[9px] font-sans-plex font-medium tracking-wider text-[var(--text-dim)]">
          {displayStatus} · updated {timeAgo}
        </span>
      </div>

      {/* Right side: Clickable refresh icon */}
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className={`text-[var(--text-dim)] hover:text-[var(--text-primary)] transition-all focus:outline-none ${
          refreshing ? 'animate-spin opacity-50' : ''
        }`}
        title="Refresh Data"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 11l3-3 3 3m-3-3v12" />
        </svg>
      </button>
    </div>
  );
};
