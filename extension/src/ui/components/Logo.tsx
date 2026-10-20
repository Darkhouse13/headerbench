/** The Headerbench mark (same shapes as assets/icon.svg, without the tile). */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      class="logo"
      width={size}
      height={size}
      viewBox="24 32 80 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="30" y="38" width="68" height="20" rx="6" fill="var(--logo-strong, #1a73e8)" />
      <rect x="30" y="70" width="44" height="20" rx="6" fill="var(--logo-soft, #aecbfa)" />
      <circle cx="88" cy="80" r="10" fill="var(--logo-strong, #1a73e8)" />
    </svg>
  );
}
