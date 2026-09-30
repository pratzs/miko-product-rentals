import { useRef, useState, useEffect, useCallback } from "react";
import { useT } from "../i18n/context";

/**
 * Shared "more from Miko" cross-sell section. Copy this file as-is into
 * any other Miko app's app/components/ folder and drop <CrossSellSection
 * currentApp="..." /> at the bottom of that app's dashboard route.
 *
 * Self-contained: all styling is inline plus one scoped <style> block, so it
 * looks identical in any Miko app whether or not that app loads the shared
 * miko-theme.css. It renders a slider (arrows, scroll-snap, dots) styled
 * like a native Shopify admin card (Oct 2026 native-look pass), so it sits
 * seamlessly beside Polaris cards in every Miko app.
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
    name: "Miko B2B Wholesale Pricing",
    pitch: "Wholesale pricing, volume tiers, and storefront applications on autopilot.",
    color: "#8B6BFF",
    icon: "/cross-sell/miko-b2b-mark.png",
    url: "https://apps.shopify.com/miko-b2b-wholesale-hub",
  },
  {
    key: "stock",
    name: "Miko Restock: Inventory & PO",
    pitch: "Low-stock alerts and one-click purchase orders so you never sell out.",
    color: "#16A34A",
    icon: "/cross-sell/miko-restock-mark.png",
    url: "https://apps.shopify.com/miko-restock-inventory-po",
  },
  {
    key: "resizer",
    name: "Miko Bulk Image Resizer",
    pitch: "Batch-resize and compress product images without leaving your catalog.",
    color: "#DB2777",
    icon: "/cross-sell/miko-resizer-mark.png",
    url: "https://apps.shopify.com/miko-bulk-image-resizer",
  },
  {
    key: "authentica",
    name: "Authentica: COA Certificates",
    pitch: "Auto-issue a QR-verifiable Certificate of Authenticity with every order.",
    color: "#8A6D3B",
    icon: "/cross-sell/miko-authentica-mark.png",
    url: "https://apps.shopify.com/authentica-coa-certificates",
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
  const t = useT();
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
    width: 28,
    height: 28,
    borderRadius: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    background: "#FFFFFF",
    boxShadow: "0 1px 0 0 #e3e3e3, inset 0 -1px 0 0 #b5b5b5, inset -1px 0 0 0 #e3e3e3, inset 1px 0 0 0 #e3e3e3, inset 0 1px 0 0 #e3e3e3",
    color: "#303030",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transition: "background 0.15s, opacity 0.15s",
    flexShrink: 0,
  });

  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 12,
        padding: 16,
        background: "#FFFFFF",
        boxShadow: "0 1px 0 0 rgba(26,26,26,.07), inset 0 1px 0 0 rgba(204,204,204,.5), inset 0 -1px 0 0 rgba(0,0,0,.17), inset -1px 0 0 0 rgba(0,0,0,.13), inset 1px 0 0 0 rgba(0,0,0,.13)",
      }}
    >
      <style>{`
        .miko-xsell-track::-webkit-scrollbar { display: none; }
        .miko-xsell-track { -ms-overflow-style: none; scrollbar-width: none; }
        .miko-xsell-card { transition: background 0.15s ease; }
        .miko-xsell-card:hover { background: #fafafa !important; }
      `}</style>

      <div style={{ position: "relative", zIndex: 1 }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 650, color: "#303030", lineHeight: "20px" }}>
              {t("More from Miko")}
            </div>
            <div style={{ fontSize: 13, color: "#616161", lineHeight: "20px" }}>
              {t("Built by the same team, made to work well together.")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              aria-label={t("Previous")}
              onClick={() => scrollToIndex(active - 1)}
              disabled={atStart}
              style={arrowBtn(atStart)}
            >
              <Arrow dir="left" />
            </button>
            <button
              type="button"
              aria-label={t("Next")}
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
                borderRadius: 12,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                background: "#FFFFFF",
                border: "1px solid #e3e3e3",
                minHeight: 200,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    overflow: "hidden",
                    flexShrink: 0,
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
                  }}
                >
                  <img
                    src={app.icon}
                    alt=""
                    width={44}
                    height={44}
                    style={{ display: "block", width: 44, height: 44, objectFit: "cover" }}
                  />
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 650,
                    color: "#303030",
                    lineHeight: "20px",
                  }}
                >
                  {app.name}
                </div>
              </div>

              <div
                style={{
                  fontSize: 13,
                  lineHeight: "20px",
                  color: "#616161",
                  flex: 1,
                }}
              >
                {t(app.pitch)}
              </div>

              <a
                href={app.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  alignSelf: "flex-start",
                  gap: 6,
                  textDecoration: "none",
                  background: "#FFFFFF",
                  boxShadow: "0 1px 0 0 #e3e3e3, inset 0 -1px 0 0 #b5b5b5, inset -1px 0 0 0 #e3e3e3, inset 1px 0 0 0 #e3e3e3, inset 0 1px 0 0 #e3e3e3",
                  color: "#303030",
                  fontSize: 12,
                  fontWeight: 550,
                  lineHeight: "16px",
                  padding: "6px 12px",
                  borderRadius: 8,
                }}
              >
                {t("View on the App Store")}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M7 17L17 7M17 7H8M17 7v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </div>
          ))}
        </div>

        {/* Dots */}
        {maxIndex > 0 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 12 }}>
            {Array.from({ length: maxIndex + 1 }).map((_, i) => {
              const on = i === active;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={t("Go to slide {n}", { n: i + 1 })}
                  onClick={() => scrollToIndex(i)}
                  style={{
                    width: on ? 18 : 6,
                    height: 6,
                    borderRadius: 3,
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    background: on ? "#303030" : "#d4d4d4",
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
