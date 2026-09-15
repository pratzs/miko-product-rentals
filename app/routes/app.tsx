import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { normalizeLocale, polarisLocaleCode, getDict, isRtl } from "../i18n";
import { I18nProvider, useT } from "../i18n/context";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import mikoStyles from "../styles/miko-theme.css?url";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { ensureShopName, ensureShopCurrency } from "../utils/shop-info.server";
import { PLANS } from "../utils/plans";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: mikoStyles },
];

// Load the Polaris locale dictionary for a given Polaris locale code. Static
// cases so Vite bundles each; Arabic + unknowns fall back to English (our own
// strings still render in Arabic, and dir=rtl flips the layout).
async function loadPolarisTranslations(code: string) {
  switch (code) {
    case "de": return (await import("@shopify/polaris/locales/de.json")).default;
    case "es": return (await import("@shopify/polaris/locales/es.json")).default;
    case "it": return (await import("@shopify/polaris/locales/it.json")).default;
    case "fr": return (await import("@shopify/polaris/locales/fr.json")).default;
    case "ja": return (await import("@shopify/polaris/locales/ja.json")).default;
    case "zh-CN": return (await import("@shopify/polaris/locales/zh-CN.json")).default;
    default: return (await import("@shopify/polaris/locales/en.json")).default;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);

  // Ensure shop config exists on every page load.
  const shopConfig = await db.shopConfig.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, accessToken: session.accessToken || "" },
    update: { accessToken: session.accessToken || "" },
  });

  // ── Billing reconcile ───────────────────────────────────────────────────────
  // The stored planName was only ever demoted by the app/uninstalled webhook.
  // A webhook that never arrives, or a merchant who cancels the subscription
  // without uninstalling, left the shop on a paid tier indefinitely with no
  // charge behind it. Every other Miko app already reconciles here; this one
  // did not.
  //
  // Deliberately asymmetric, because the two mistakes are not equally bad:
  //   - No active payment            -> demote to free. Safe and correct.
  //   - Active payment we can map    -> trust it.
  //   - Active payment we CANNOT map (a plan renamed in the Partner Dashboard)
  //     -> change nothing. Silently demoting a paying merchant is the one
  //     outcome worth avoiding, so an unknown name keeps whatever is stored.
  // Never block the dashboard on any of it: billing being unreachable must not
  // cost the merchant their page.
  try {
    const isTest = process.env.SHOPIFY_BILLING_TEST !== "false";
    const check = await billing.check({
      plans: ["starter", "growth", "pro"],
      isTest,
    });

    let resolved: string | null = null;
    if (check.hasActivePayment) {
      const subName = (check.appSubscriptions?.[0]?.name ?? "").toLowerCase();
      resolved = subName in PLANS ? subName : null;
    } else {
      resolved = "free";
    }

    if (resolved && resolved !== shopConfig.planName) {
      await db.shopConfig.update({
        where: { shop: session.shop },
        data: { planName: resolved },
      });
    }
  } catch {
    // Keep the stored plan. A transient billing error must never downgrade.
  }

  // Repair the shop currency and name here too, not only in afterAuth. afterAuth
  // fires once at install, so when its write failed the shop was stranded on the
  // "USD" schema default forever with no way back. Both helpers short-circuit on
  // a cheap indexed read once seeded, so this costs one query on a normal load.
  // Never block or fail the page on it - a wrong currency label is bad, a dead
  // dashboard is worse.
  await Promise.allSettled([
    ensureShopName(admin, session.shop),
    ensureShopCurrency(admin, session.shop),
  ]);

  // Shopify sends the merchant's chosen admin language in the `locale` param.
  const locale = normalizeLocale(new URL(request.url).searchParams.get("locale"));
  const polarisTranslations = await loadPolarisTranslations(polarisLocaleCode(locale));

  return json({ apiKey: process.env.SHOPIFY_API_KEY || "", locale, polarisTranslations });
};

export default function App() {
  const { apiKey, locale, polarisTranslations } = useLoaderData<typeof loader>();

  return (
    // isEmbeddedApp={false} only suppresses AppProvider's own app-bridge.js
    // injection -- the script now loads first-in-head from root.tsx, and a
    // second copy must never be rendered. The app is still embedded.
    <AppProvider isEmbeddedApp={false} apiKey={apiKey} i18n={polarisTranslations}>
      <I18nProvider locale={locale} dict={getDict(locale)}>
        <AppShell locale={locale} />
      </I18nProvider>
    </AppProvider>
  );
}

// Inner shell so hooks (useT) run inside the I18nProvider.
function AppShell({ locale }: { locale: string }) {
  const t = useT();
  return (
    <>
      <NavMenu>
        <Link to="/app" rel="home">{t("Dashboard")}</Link>
        <Link to="/app/products">{t("Rental Products")}</Link>
        <Link to="/app/bookings">{t("Bookings")}</Link>
        <Link to="/app/calendar">{t("Calendar")}</Link>
        <Link to="/app/analytics">{t("Analytics")}</Link>
        <Link to="/app/emails">{t("Emails")}</Link>
        <Link to="/app/pricing">{t("Pricing")}</Link>
        <Link to="/app/settings">{t("Settings")}</Link>
        <Link to="/app/help">{t("Help")}</Link>
      </NavMenu>
      <div dir={isRtl(locale as any) ? "rtl" : "ltr"} style={{ paddingBottom: "3rem" }}>
        <Outlet />
      </div>
    </>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  // Suppress the brief 401/302 flash during App Bridge token exchange.
  // App Bridge intercepts and re-submits automatically - showing an error here breaks the flow.
  if (error instanceof Response && (error.status === 401 || error.status === 302)) {
    return null;
  }
  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
