import React from 'react';

interface GaugeProps {
  percent: number; // 0 to 1
  height?: number; // height in pixels
  pulse?: boolean; // trigger a warning pulse if true
}

export const Gauge: React.FC<GaugeProps> = ({
  percent = 0,
  height = 5,
  pulse = false
}) => {
  const clamped = Math.max(0, Math.min(1, percent));
  
  // Transition-width is set to 280ms ease-out to match the 250-300ms spec
  return (
    <div 
      className="w-full bg-[var(--bg-track)] relative overflow-hidden"
      style={{ height: `${height}px` }}
    >
      <div
        className={`h-full bg-[var(--accent-color)] transition-[width] duration-[280ms] ease-out ${
          pulse ? 'animate-pulse opacity-90' : ''
        }`}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
};
