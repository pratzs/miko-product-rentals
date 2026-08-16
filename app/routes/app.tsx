import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
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

  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Dashboard</Link>
        <Link to="/app/products">Rental Products</Link>
        <Link to="/app/bookings">Bookings</Link>
        <Link to="/app/calendar">Calendar</Link>
        <Link to="/app/analytics">Analytics</Link>
        <Link to="/app/emails">Emails</Link>
        <Link to="/app/pricing">Pricing</Link>
        <Link to="/app/settings">Settings</Link>
        <Link to="/app/help">Help</Link>
      </NavMenu>
      <div style={{ paddingBottom: "3rem" }}>
        <Outlet />
      </div>
    </AppProvider>
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
