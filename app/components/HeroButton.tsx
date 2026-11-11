import type { ReactNode } from "react";

/**
 * Buttons for the navy Miko hero. Polaris `s-button` has no colour option and
 * its primary style is near-black, which disappears on navy, so the hero keeps
 * our own brand buttons (green primary, white secondary) as it did before.
 * Styles live in miko-theme.css under `.miko-hero-btn`.
 */
export function HeroButton({
  children,
  onClick,
  href,
  variant = "primary",
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "secondary";
}) {
  const className = `miko-hero-btn miko-hero-btn--${variant}`;
  if (href) {
    return (
      <a className={className} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  );
}
