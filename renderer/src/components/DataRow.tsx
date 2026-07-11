import React from 'react';

interface DataRowProps {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}

export const DataRow: React.FC<DataRowProps> = ({ label, value, valueClass = '' }) => {
  return (
    <div className="flex justify-between items-center py-2 border-b border-hairline-t last:border-b-0">
      <span className="text-[10px] tracking-widest font-sans-plex uppercase font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      <span className={`font-mono-plex text-[11px] text-[var(--text-primary)] font-medium ${valueClass}`}>
        {value}
      </span>
    </div>
  );
};
