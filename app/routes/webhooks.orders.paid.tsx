import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { syncBookingsFromOrder } from "../utils/booking-from-order.server";
import { sendBookingConfirmation } from "../utils/email";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_PAID") {
    return json({ ok: true });
  }

  const result = await syncBookingsFromOrder(shop, payload as any, {
    upgradeToConfirmed: true,
  });

  if (result.bookingsCreated === 0 && result.bookingsUpgraded === 0) {
    return json({ ok: true, ...result });
  }

  // Send confirmation emails for any bookings that were just created OR upgraded
  // to confirmed by this webhook. A failed email must never fail the webhook,
  // otherwise Shopify retries forever against an already-created booking.
  const order = payload as any;
  const config = await db.shopConfig.findUnique({ where: { shop } });
  const bookings = await db.rentalBooking.findMany({
    where: { shop, shopifyOrderId: String(order.id), status: "confirmed" },
    include: { rentalProduct: true },
  });

  for (const booking of bookings) {
    if (!booking.customerEmail) continue;
    const alreadySent = await db.emailLog.findFirst({
      where: { shop, bookingId: booking.id, type: "confirmation" },
    });
    if (alreadySent) continue;
    try {
      await sendBookingConfirmation({
        shop,
        bookingId: booking.id,
        customerEmail: booking.customerEmail,
        customerName: booking.customerName,
        productTitle: booking.rentalProduct.shopifyProductTitle,
        orderName: booking.shopifyOrderName,
        startDate: booking.startDate,
        endDate: booking.endDate,
        rentalDays: booking.rentalDays,
        rentalPrice: booking.rentalPrice,
        depositAmount: booking.depositAmount,
        totalCharged: booking.totalCharged,
        currency: config?.currency || "USD",
      });
    } catch (err) {
      console.error(`[orders/paid] confirmation email failed for booking ${booking.id}:`, err);
    }
  }

  return json({ ok: true, ...result });
};
