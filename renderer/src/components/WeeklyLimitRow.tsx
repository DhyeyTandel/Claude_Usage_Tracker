import React from 'react';
import { Gauge } from './Gauge';

interface WeeklyLimitRowProps {
  label: string;
  percent: number; // 0 to 1
  resetsCaption: string; // e.g. "resets Sunday 12:00"
}

export const WeeklyLimitRow: React.FC<WeeklyLimitRowProps> = ({
  label,
  percent = 0,
  resetsCaption
}) => {
  const displayPercent = Math.round(percent * 100);

  return (
    <div className="flex flex-col py-2 border-b border-[var(--bg-secondary)] last:border-b-0">
      <div className="flex justify-between items-baseline mb-0.5">
        <span className="text-[11px] font-sans-plex font-medium text-[var(--text-secondary)]">
          {label}
        </span>
        <span className="font-mono-plex text-[11px] text-[var(--text-primary)] font-medium">
          {displayPercent}%
        </span>
      </div>
      <div className="text-[9px] text-[var(--text-dim)] font-sans-plex mb-1.5 leading-none">
        {resetsCaption}
      </div>
      <Gauge percent={percent} height={3.5} pulse={percent >= 0.90} />
    </div>
  );
};
