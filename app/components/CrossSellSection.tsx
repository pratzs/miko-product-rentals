import { useRef, useState, useEffect, useCallback } from "react";
import { useT } from "../i18n/context";

/**
 * Shared "more from Miko" cross-sell section. Copy this file as-is into
 * any other Miko app's app/components/ folder and drop <CrossSellSection
 * currentApp="..." /> at the bottom of that app's dashboard route.
 *
 * Self-contained: all styling is inline plus one scoped <style> block, so it
 * looks identical in any Miko app whether or not that app loads the shared
 * miko-theme.css. It renders a native Polaris card holding a slider (arrows,
 * scroll-snap, dots) of admin-style app cards (current Shopify admin look).
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

  return (
    <s-section>
      <style>{`
        .miko-xsell-track::-webkit-scrollbar { display: none; }
        .miko-xsell-track { -ms-overflow-style: none; scrollbar-width: none; }
        .miko-xsell-card {
          box-sizing: border-box; border-radius: 12px; padding: 16px; background: #fff;
          display: flex; flex-direction: column; gap: 12px; min-height: 190px;
          box-shadow: 0 1px 0 0 rgba(26,26,26,.07), inset 0 1px 0 0 rgba(204,204,204,.5),
            inset 0 -1px 0 0 rgba(0,0,0,.17), inset -1px 0 0 0 rgba(0,0,0,.13), inset 1px 0 0 0 rgba(0,0,0,.13);
        }
        .miko-xsell-name { font-size: 13px; font-weight: 650; line-height: 20px; color: #303030; }
        .miko-xsell-pitch { font-size: 13px; line-height: 20px; color: #616161; flex: 1; }
        .miko-xsell-dot { height: 6px; border-radius: 3px; border: none; padding: 0; cursor: pointer; transition: width .2s, background .2s; }
      `}</style>

      <s-stack direction="block" gap="base">
        {/* Header */}
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-stack direction="block" gap="none">
            <s-heading>{t("More from Miko")}</s-heading>
            <s-text color="subdued">{t("Built by the same team, made to work well together.")}</s-text>
          </s-stack>
          <s-stack direction="inline" gap="small-200">
            <s-button
              icon="chevron-left"
              accessibilityLabel={t("Previous")}
              onClick={() => scrollToIndex(active - 1)}
              disabled={atStart || undefined}
            />
            <s-button
              icon="chevron-right"
              accessibilityLabel={t("Next")}
              onClick={() => scrollToIndex(active + 1)}
              disabled={atEnd || undefined}
            />
          </s-stack>
        </s-stack>

        {/* Track. Padding gives the card shadows room inside the scroll box. */}
        <div
          ref={trackRef}
          className="miko-xsell-track"
          style={{
            display: "flex",
            gap: GAP,
            overflowX: "auto",
            scrollSnapType: "x mandatory",
            padding: 2,
            scrollBehavior: "smooth",
          }}
        >
          {apps.map((app) => (
            <div
              key={app.key}
              className="miko-xsell-card"
              style={{ flex: `0 0 ${CARD_W}px`, width: CARD_W, scrollSnapAlign: "start" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <img
                  src={app.icon}
                  alt=""
                  width={40}
                  height={40}
                  style={{ display: "block", width: 40, height: 40, objectFit: "cover", borderRadius: 8, flexShrink: 0 }}
                />
                <div className="miko-xsell-name">{app.name}</div>
              </div>
              <div className="miko-xsell-pitch">{t(app.pitch)}</div>
              <div>
                <s-button href={app.url} target="_blank" icon="external">
                  {t("View on the App Store")}
                </s-button>
              </div>
            </div>
          ))}
        </div>

        {/* Dots */}
        {maxIndex > 0 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
            {Array.from({ length: maxIndex + 1 }).map((_, i) => {
              const on = i === active;
              return (
                <button
                  key={i}
                  type="button"
                  className="miko-xsell-dot"
                  aria-label={t("Go to slide {n}", { n: i + 1 })}
                  onClick={() => scrollToIndex(i)}
                  style={{ width: on ? 18 : 6, background: on ? "#303030" : "#d4d4d4" }}
                />
              );
            })}
          </div>
        )}
      </s-stack>
    </s-section>
  );
}
