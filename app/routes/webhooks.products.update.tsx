import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import { db } from "../db.server";
import { syncRentalProductVariants } from "../utils/variant-sync.server";
import { ensureRentalVariantsCanOversell } from "../utils/product-metafields.server";

/**
 * Fires whenever the merchant edits a product in Shopify (adds variants,
 * renames them, etc). For products we have enabled as rentals, we:
 *
 *   1. Re-sync RentalVariant rows so new variants get inherited pricing/units
 *      and removed variants are cleaned up.
 *   2. Re-flip inventoryPolicy to CONTINUE on every variant so any newly
 *      added variants can be booked even when stock is 0.
 *
 * Products we have NOT enabled as rentals are ignored - this webhook is
 * basically a no-op for non-rental products.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "PRODUCTS_UPDATE") return json({ ok: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const order = payload as any;
  const productNumericId = order?.id;
  if (!productNumericId) return json({ ok: true });
  const productGid = `gid://shopify/Product/${productNumericId}`;

  const rentalProduct = await db.rentalProduct.findFirst({
    where: { shop, shopifyProductId: productGid },
    select: { id: true, isActive: true, shopifyProductId: true },
  });
  if (!rentalProduct || !rentalProduct.isActive) {
    return json({ ok: true });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    await syncRentalProductVariants(admin, rentalProduct.id);
    await ensureRentalVariantsCanOversell(admin, rentalProduct.shopifyProductId);
  } catch (err) {
    console.error(`[products/update] sync failed for ${shop} ${productGid}:`, err);
  }

  return json({ ok: true });
};
