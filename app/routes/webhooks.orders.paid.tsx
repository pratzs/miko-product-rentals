import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { calculateRentalPrice } from "../utils/pricing";
import { sendBookingConfirmation } from "../utils/email";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_PAID") {
    return json({ ok: true });
  }

  const order = payload as any;
  const shopifyOrderId = String(order.id);
  const shopifyOrderName = order.name as string;
  const customerName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || "Customer";
  const customerEmail = order.customer?.email || order.email || "";

  // Look for rental line items — they carry rental metadata in note_attributes or properties
  // We use line item properties: start_date, end_date, rental_product_id
  for (const item of order.line_items || []) {
    const properties: { name: string; value: string }[] = item.properties || [];
    const prop = (key: string) => properties.find((p) => p.name === key)?.value || "";

    const rentalProductDbId = prop("_miko_rental_product_id");
    const startDateStr = prop("_miko_start_date");
    const endDateStr = prop("_miko_end_date");

    if (!rentalProductDbId || !startDateStr || !endDateStr) continue;

    const rentalProduct = await db.rentalProduct.findFirst({
      where: { id: rentalProductDbId, shop },
    });

    if (!rentalProduct) continue;

    // Check if a booking already exists for this order+product (idempotency)
    const existing = await db.rentalBooking.findFirst({
      where: { shop, shopifyOrderId, rentalProductId: rentalProductDbId },
    });
    if (existing) continue;

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);

    const config = await db.shopConfig.findUnique({ where: { shop } });

    const pricing = calculateRentalPrice({
      startDate,
      endDate,
      pricePerDay: rentalProduct.pricePerDay,
      pricePerWeek: rentalProduct.pricePerWeek,
      pricePerMonth: rentalProduct.pricePerMonth,
      depositAmount: rentalProduct.depositAmount,
    });

    const booking = await db.rentalBooking.create({
      data: {
        shop,
        rentalProductId: rentalProduct.id,
        shopifyOrderId,
        shopifyOrderName,
        customerName,
        customerEmail,
        startDate,
        endDate,
        unitsRented: 1,
        rentalDays: pricing.rentalDays,
        rentalPrice: pricing.rentalPrice,
        depositAmount: pricing.depositAmount,
        depositStatus: pricing.depositAmount > 0 ? "held" : "released",
        totalCharged: pricing.totalDue,
        status: "confirmed",
        lateFeeCharged: 0,
        merchantNotes: "",
      },
    });

    // Send confirmation email (config is fetched internally)
    if (customerEmail) {
      await sendBookingConfirmation({
        shop,
        bookingId: booking.id,
        customerEmail,
        customerName,
        productTitle: rentalProduct.shopifyProductTitle,
        orderName: shopifyOrderName,
        startDate,
        endDate,
        rentalDays: pricing.rentalDays,
        rentalPrice: pricing.rentalPrice,
        depositAmount: pricing.depositAmount,
        totalCharged: pricing.totalDue,
        currency: config?.currency || "USD",
      });
    }
  }

  return json({ ok: true });
};
