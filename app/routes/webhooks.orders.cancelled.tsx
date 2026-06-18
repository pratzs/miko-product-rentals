import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CANCELLED") {
    return json({ ok: true });
  }

  const order = payload as any;
  const shopifyOrderId = String(order.id);

  // Cancel any bookings tied to this order that are still in a cancellable state
  await db.rentalBooking.updateMany({
    where: {
      shop,
      shopifyOrderId,
      status: { in: ["pending", "confirmed", "needs_review"] },
    },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
    },
  });

  return json({ ok: true });
};
