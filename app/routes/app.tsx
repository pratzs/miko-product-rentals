import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { normalizeLocale, getDict, isRtl } from "../i18n";
import { I18nProvider, useT } from "../i18n/context";
import mikoStyles from "../styles/miko-theme.css?url";
import { authenticate } from "../shopify.server";
import { db, upsertShopConfig } from "../db.server";
import { DEV_STORE_PLAN, fetchIsDevelopmentStore } from "../dev-store.server";
import { ensureShopName, ensureShopCurrency } from "../utils/shop-info.server";
import { PLANS } from "../utils/plans";
import { syncShopRentalConfig } from "../utils/rental-config-metafields.server";

// Polaris web components (loaded by root.tsx) need no stylesheet and take
// their language from the admin, so the Polaris React stylesheet and locale
// dictionaries this layout used to load are gone. Only our own theme remains.
export const links = () => [{ rel: "stylesheet", href: mikoStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);

  // Ensure shop config exists on every page load.
  const shopConfig = await upsertShopConfig({
    where: { shop: session.shop },
    // ShopConfig.accessToken used to get a copy of the Admin API token on
    // every load. Nothing reads it (the session store is the only source the
    // app uses), and a second copy of a credential is only a liability, so it
    // is no longer written and any old copy is blanked here.
    create: { shop: session.shop },
    update: { accessToken: "" },
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
      // No active payment. Before demoting to free, check whether this is a
      // Partner development store, which we deliberately grant the top plan.
      // Without this the grant made at install would be wiped on the very next
      // page load by the line below, and the affiliate would be back on free.
      const isDev = await fetchIsDevelopmentStore(admin);
      if (isDev !== null && isDev !== shopConfig.isDevelopmentStore) {
        await db.shopConfig.update({
          where: { shop: session.shop },
          data: { isDevelopmentStore: isDev },
        });
      }
      // null means the lookup failed: fall back to the cached flag rather than
      // demoting an affiliate mid-evaluation on a transient API error.
      const treatAsDev = isDev ?? shopConfig.isDevelopmentStore;
      resolved = treatAsDev ? DEV_STORE_PLAN : "free";
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

  // Checkout prices rentals from app-owned metafields. A shop that has never
  // had them written (set up before that change) gets them now. Not awaited:
  // it must never slow or fail the page, and the in-process scheduler covers
  // every shop anyway. Stamps rentalConfigSyncedAt so this runs once.
  if (!shopConfig.rentalConfigSyncedAt) {
    void syncShopRentalConfig(admin, session.shop).catch((err) =>
      console.error(`[rental-config] app-load sync failed for ${session.shop}:`, err),
    );
  }

  // Shopify sends the merchant's chosen admin language in the `locale` param.
  const locale = normalizeLocale(new URL(request.url).searchParams.get("locale"));

  return json({ apiKey: process.env.SHOPIFY_API_KEY || "", locale });
};

export default function App() {
  const { locale } = useLoaderData<typeof loader>();

  // No AppProvider: it only wrapped Polaris React. App Bridge loads first in
  // root.tsx and Polaris web components straight after it.
  return (
    <I18nProvider locale={locale} dict={getDict(locale)}>
      <AppShell locale={locale} />
    </I18nProvider>
  );
}

// Inner shell so hooks (useT) run inside the I18nProvider.
function AppShell({ locale }: { locale: string }) {
  const t = useT();
  return (
    <>
      {/* App Bridge's own nav element (replaces NavMenu). One flat level;
          App Bridge intercepts these relative links. */}
      <s-app-nav>
        <s-link
          href="/app"
          // Both @shopify/polaris-types and @shopify/app-bridge-types declare
          // `s-link`, and Polaris wins the JSX merge, so App Bridge's `rel` is
          // not on the type we get here.
          // @ts-expect-error rel is App Bridge's, not Polaris's
          rel="home"
        >
          {t("Dashboard")}
        </s-link>
        <s-link href="/app/products">{t("Rental Products")}</s-link>
        <s-link href="/app/bookings">{t("Bookings")}</s-link>
        <s-link href="/app/calendar">{t("Calendar")}</s-link>
        <s-link href="/app/analytics">{t("Analytics")}</s-link>
        <s-link href="/app/emails">{t("Emails")}</s-link>
        <s-link href="/app/pricing">{t("Pricing")}</s-link>
        <s-link href="/app/settings">{t("Settings")}</s-link>
        <s-link href="/app/help">{t("Help")}</s-link>
      </s-app-nav>
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
