import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { syncBookingsFromOrder } from "../utils/booking-from-order.server";

/**
 * Fires for every new order (paid, pending, COD, etc). We create a pending
 * booking immediately so it shows up in the merchant dashboard as soon as the
 * order is placed. The orders/paid webhook later upgrades it to "confirmed"
 * when payment is captured.
 *
 * This means bookings are tracked even for Cash on Delivery / Net 45 / manual
 * payment flows where there can be a long gap between order placement and
 * payment capture.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "ORDERS_CREATE") return json({ ok: true });

  const result = await syncBookingsFromOrder(shop, payload as any, {
    upgradeToConfirmed: false,
  });
  return json({ ok: true, ...result });
};
