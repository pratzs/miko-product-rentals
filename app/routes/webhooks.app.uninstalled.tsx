import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { deleteCartTransformOnUninstall } from "../utils/cart-transform.server";

/**
 * Fires when the merchant uninstalls the app. We:
 *
 *   1. Best-effort delete the CartTransform record on Shopify while the
 *      access token is still valid (it expires shortly after this fires).
 *      Without this the next install would see "already-active" but the
 *      record is tied to the prior install and won't fire.
 *
 *   2. Record subscriptionCancelledAt so a reinstall can surface a banner
 *      letting the merchant know their previous paid plan ended.
 *
 *   3. Demote planName to "free" since Shopify auto-cancels the subscription.
 *
 *   4. Keep ShopConfig + RentalProduct + RentalBooking + EmailTemplate so
 *      a reinstall gets all settings and history back. Sessions are deleted
 *      so the new install starts with a fresh token.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    return json({ ok: true });
  }

  // 1. Clean up the Cart Transform record while the token is still valid.
  if (session?.accessToken) {
    await deleteCartTransformOnUninstall(shop, session.accessToken);
  }

  // 2. Record the cancellation timestamp for the reinstall banner.
  // 3. Demote plan - Shopify auto-cancels the recurring subscription.
  await db.shopConfig
    .updateMany({
      where: { shop },
      data: {
        subscriptionCancelledAt: new Date(),
        planName: "free",
      },
    })
    .catch(() => {});

  // 4. Delete sessions only. Historical bookings, products, and settings
  // are preserved so a reinstall picks up exactly where they left off.
  await db.session.deleteMany({ where: { shop } }).catch(() => {});

  console.log(`[webhook] APP_UNINSTALLED for ${shop} - cleanup complete`);
  return json({ ok: true });
};
