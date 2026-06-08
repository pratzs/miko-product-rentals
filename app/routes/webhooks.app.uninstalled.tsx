import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    return json({ ok: true });
  }

  // Delete all sessions for this shop (Shopify sessions)
  await db.session.deleteMany({ where: { shop } });

  // We intentionally keep RentalBooking and ShopConfig records in case
  // the merchant reinstalls — their historical data and settings will
  // still be there. They can manually delete via the settings page if needed.

  return json({ ok: true });
};
