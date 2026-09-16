import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db as prisma } from "../db.server";
import { DEV_STORE_PLAN, fetchIsDevelopmentStore } from "../dev-store.server";

/**
 * shop/update.
 *
 * The revocation half of the development-store grant. Granting a dev store the
 * top plan is only safe because it stops the moment the store becomes a real,
 * paying Shopify store. Shopify fires shop/update when the plan changes, so
 * this is where that transition is caught.
 *
 * The app loader re-checks the same flag on every request, so this is the fast
 * path, not the only path: if it is ever missed the grant still lapses on the
 * store's next visit.
 *
 * Always returns 200. A non-200 makes Shopify retry, and a retry storm on a
 * webhook that only adjusts a boolean is worse than losing one event.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await authenticate.webhook(request);

  try {
    // admin is undefined for a shop that has already uninstalled.
    if (!admin) return new Response(null, { status: 200 });

    const isDev = await fetchIsDevelopmentStore(admin);
    if (isDev === null) return new Response(null, { status: 200 }); // lookup failed, keep cache

    const cfg = await prisma.shopConfig.findUnique({ where: { shop } });
    if (!cfg) return new Response(null, { status: 200 });

    const data: { isDevelopmentStore: boolean; planName?: string } = {
      isDevelopmentStore: isDev,
    };

    // Converted from dev store to a real plan while holding the free grant:
    // drop to free now. Never touch planName if they hold a real subscription,
    // which is what subscriptionId being set means.
    // This app has no subscriptionId column: there is no paid-subscription
    // state to protect here, so holding the grant is the only condition.
    if (!isDev && cfg.isDevelopmentStore && cfg.planName === DEV_STORE_PLAN) {
      data.planName = "free";
      console.log(`[shop/update] ${shop}: dev store went paid, revoking free ${DEV_STORE_PLAN}`);
    }

    if (data.isDevelopmentStore !== cfg.isDevelopmentStore || data.planName) {
      await prisma.shopConfig.update({ where: { shop }, data });
    }
  } catch (error) {
    console.error("[shop/update] error:", error);
  }

  return new Response(null, { status: 200 });
};
