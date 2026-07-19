import { useRef, useState, useEffect, useCallback } from "react";

/**
 * Shared "more from Miko" cross-sell section. Copy this file as-is into
 * any other Miko app's app/components/ folder and drop <CrossSellSection
 * currentApp="..." /> at the bottom of that app's dashboard route.
 *
 * Self-contained: all styling is inline plus one scoped <style> block, so it
 * looks identical in any Miko app whether or not that app loads the shared
 * miko-theme.css. It renders a dark, on-brand slider (arrows, scroll-snap,
 * dots) so the family of apps feels like a premium, coordinated suite.
 *
 * Only list apps that are actually live on the App Store, never link to an
 * app that isn't published yet.
 */

type MikoApp = {
  key: string;
  name: string;
  pitch: string;
  color: string;
  icon: string;
  url: string;
};

const MIKO_APPS: MikoApp[] = [
  {
    key: "loyalty",
    name: "Miko Loyalty and Rewards",
    pitch: "Turn one-time buyers into loyal regulars with points and VIP tiers.",
    color: "#F5A62D",
    icon: "/cross-sell/miko-loyalty-mark.png",
    url: "https://apps.shopify.com/trip-loyalty-and-rewards",
  },
  {
    key: "ai",
    name: "Miko AI",
    pitch: "Score customers, predict churn, and automate winback campaigns.",
    color: "#3FA9F5",
    icon: "/cross-sell/miko-ai-mark.png",
    url: "https://apps.shopify.com/miko-ai",
  },
  {
    key: "narrate",
    name: "Miko AI Descriptions and Narrate",
    pitch: "Generate on-brand product copy in bulk and add a Listen button shoppers love.",
    color: "#E8724C",
    icon: "/cross-sell/miko-narrate-mark.png",
    url: "https://apps.shopify.com/miko-ai-descriptions-narrate",
  },
  {
    key: "rentals",
    name: "Miko Product Rentals",
    pitch: "Turn products into rentals with dates and refundable deposits.",
    color: "#14C6AD",
    icon: "/cross-sell/miko-rentals-mark.png",
    url: "https://apps.shopify.com/miko-product-rentals",
  },
  {
    key: "b2b",
    name: "Miko B2B Wholesale House",
    pitch: "Wholesale pricing, volume tiers, and storefront applications on autopilot.",
    color: "#8B6BFF",
    icon: "/cross-sell/miko-b2b-mark.png",
    url: "https://apps.shopify.com/miko-b2b-wholesale-hub",
  },
];

// Card + gap width in px, kept in one place so scroll math and layout agree.
const CARD_W = 280;
const GAP = 16;

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CrossSellSection({ currentApp }: { currentApp: MikoApp["key"] }) {
  const apps = MIKO_APPS.filter((a) => a.key !== currentApp);
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [maxIndex, setMaxIndex] = useState(0);

  const recompute = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / (CARD_W + GAP));
    setActive(idx);
    // How many "pages" of scrolling exist given the visible width.
    const perView = Math.max(1, Math.round(el.clientWidth / (CARD_W + GAP)));
    setMaxIndex(Math.max(0, apps.length - perView));
  }, [apps.length]);

  useEffect(() => {
    recompute();
    const el = trackRef.current;
    if (!el) return;
    const onScroll = () => recompute();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", recompute);
    };
  }, [recompute]);

  const scrollToIndex = (i: number) => {
    const el = trackRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(i, apps.length - 1));
    el.scrollTo({ left: clamped * (CARD_W + GAP), behavior: "smooth" });
  };

  if (apps.length === 0) return null;

  const atStart = active <= 0;
  const atEnd = active >= maxIndex;

  const arrowBtn = (disabled: boolean): React.CSSProperties => ({
    width: 34,
    height: 34,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.08)",
    color: "#fff",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.35 : 1,
    transition: "background 0.15s, opacity 0.15s",
    flexShrink: 0,
  });

  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 16,
        padding: "24px 24px 20px",
        background:
          "linear-gradient(135deg, #0d0f2b 0%, #1a1a2e 55%, #16213e 100%)",
      }}
    >
      <style>{`
        .miko-xsell-track::-webkit-scrollbar { display: none; }
        .miko-xsell-track { -ms-overflow-style: none; scrollbar-width: none; }
        .miko-xsell-card { transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease; }
        .miko-xsell-card:hover { transform: translateY(-3px); }
      `}</style>

      {/* Ambient brand glow, non-interactive. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(circle at 88% 10%, rgba(91,141,239,0.28), transparent 55%), radial-gradient(circle at 8% 95%, rgba(139,124,246,0.22), transparent 50%)",
        }}
      />

      <div style={{ position: "relative", zIndex: 1 }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 18,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#fff", letterSpacing: "-0.01em" }}>
              More from Miko
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginTop: 3 }}>
              Built by the same team, made to work well together.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              aria-label="Previous"
              onClick={() => scrollToIndex(active - 1)}
              disabled={atStart}
              style={arrowBtn(atStart)}
            >
              <Arrow dir="left" />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={() => scrollToIndex(active + 1)}
              disabled={atEnd}
              style={arrowBtn(atEnd)}
            >
              <Arrow dir="right" />
            </button>
          </div>
        </div>

        {/* Track */}
        <div
          ref={trackRef}
          className="miko-xsell-track"
          style={{
            display: "flex",
            gap: GAP,
            overflowX: "auto",
            scrollSnapType: "x mandatory",
            paddingBottom: 4,
            scrollBehavior: "smooth",
          }}
        >
          {apps.map((app) => (
            <div
              key={app.key}
              className="miko-xsell-card"
              style={{
                flex: `0 0 ${CARD_W}px`,
                width: CARD_W,
                scrollSnapAlign: "start",
                boxSizing: "border-box",
                borderRadius: 14,
                padding: 18,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                background: `linear-gradient(160deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.04) 100%), radial-gradient(circle at 25% 0%, ${app.color}30, transparent 60%)`,
                border: `1px solid ${app.color}40`,
                minHeight: 210,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 13,
                    overflow: "hidden",
                    flexShrink: 0,
                    boxShadow: `0 6px 18px ${app.color}55, 0 0 0 1px rgba(255,255,255,0.14)`,
                  }}
                >
                  <img
                    src={app.icon}
                    alt=""
                    width={52}
                    height={52}
                    style={{ display: "block", width: 52, height: 52, objectFit: "cover" }}
                  />
                </div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 650,
                    color: "#fff",
                    lineHeight: 1.25,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {app.name}
                </div>
              </div>

              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "rgba(255,255,255,0.72)",
                  flex: 1,
                }}
              >
                {app.pitch}
              </div>

              <a
                href={app.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 7,
                  textDecoration: "none",
                  background: app.color,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  padding: "9px 14px",
                  borderRadius: 9,
                }}
              >
                View on the App Store
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M7 17L17 7M17 7H8M17 7v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </div>
          ))}
        </div>

        {/* Dots */}
        {maxIndex > 0 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 7, marginTop: 16 }}>
            {Array.from({ length: maxIndex + 1 }).map((_, i) => {
              const on = i === active;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`Go to slide ${i + 1}`}
                  onClick={() => scrollToIndex(i)}
                  style={{
                    width: on ? 22 : 8,
                    height: 8,
                    borderRadius: 4,
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    background: on ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)",
                    transition: "width 0.2s, background 0.2s",
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
