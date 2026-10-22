/** The agent-terminal mark: terminal prompt + cursor + agent node. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden>
      <rect width="1024" height="1024" rx="190" fill="#0b0f0d" />
      <line x1="560" y1="512" x2="742" y2="318" stroke="#34d399" strokeOpacity="0.78" strokeWidth="26" />
      <polyline
        points="300,285 560,512 300,739"
        fill="none"
        stroke="#34d399"
        strokeWidth="96"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="596" y="648" width="232" height="96" rx="48" fill="#a7f3d0" />
      <circle cx="742" cy="318" r="62" fill="#38bdf8" />
    </svg>
  );
}
