import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { redactShop, safeErr } from "../utils/gdpr.server";

// GDPR: shop/redact, sent 48 hours after uninstall. Deletes every row this app
// holds for the shop (all shop-scoped models, in FK order, in one transaction).
// See redactShop() for the model list. Returns 500 on failure so Shopify retries.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  try {
    const counts = await redactShop(db, shop);
    console.log(`[webhook] ${topic} for ${shop}: deleted ${JSON.stringify(counts)}`);
  } catch (err) {
    console.error(`[webhook] ${topic} for ${shop} failed: ${safeErr(err)}`);
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
};
