/**
 * Shared booking creation logic used by both the orders/create webhook
 * (which creates pending bookings) and the orders/paid webhook (which
 * upgrades them to confirmed). Also used by the manual "sync orders"
 * admin action.
 */
import { db } from "~/db.server";
import { calculateRentalPrice } from "./pricing";
import { eachDayOfInterval, startOfDay } from "date-fns";

interface OrderPayload {
  id: string | number;
  name: string;
  financial_status?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null };
  email?: string | null;
  phone?: string | null;
  shipping_address?: { phone?: string | null } | null;
  billing_address?: { phone?: string | null } | null;
  line_items?: Array<{
    id?: string | number;
    quantity?: number;
    variant_id?: string | number | null;
    properties?: Array<{ name: string; value: string }>;
  }>;
}

export interface SyncResult {
  bookingsCreated: number;
  bookingsUpgraded: number;
  bookingsFlaggedForReview: number;
  skipped: number;
}

/**
 * Atomic overbooking check: counts every active hold (pending/confirmed/active)
 * on this product that overlaps the new range, day by day. Returns the peak
 * already-booked units on any single day in the range. If peak + unitsNeeded
 * exceeds totalUnits, accepting the new booking would overbook.
 *
 * Excludes the booking we're about to upgrade so re-running orders/paid
 * doesn't double-count the same booking.
 */
async function peakBookedUnits(opts: {
  rentalProductId: string;
  rentalVariantId?: string | null;
  startDate: Date;
  endDate: Date;
  excludeBookingId?: string;
}): Promise<number> {
  const overlapping = await db.rentalBooking.findMany({
    where: {
      rentalProductId: opts.rentalProductId,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      startDate: { lt: opts.endDate },
      endDate: { gt: opts.startDate },
      ...(opts.rentalVariantId ? { rentalVariantId: opts.rentalVariantId } : {}),
      ...(opts.excludeBookingId ? { id: { not: opts.excludeBookingId } } : {}),
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  let peak = 0;
  const days = eachDayOfInterval({ start: opts.startDate, end: opts.endDate });
  for (const day of days) {
    const onThisDay = overlapping
      .filter((b) => startOfDay(b.startDate) <= startOfDay(day) && startOfDay(b.endDate) > startOfDay(day))
      .reduce((s, b) => s + b.unitsRented, 0);
    if (onThisDay > peak) peak = onThisDay;
  }
  return peak;
}

export async function syncBookingsFromOrder(
  shop: string,
  order: OrderPayload,
  options: { upgradeToConfirmed: boolean },
): Promise<SyncResult> {
  const result: SyncResult = {
    bookingsCreated: 0,
    bookingsUpgraded: 0,
    bookingsFlaggedForReview: 0,
    skipped: 0,
  };

  const shopifyOrderId = String(order.id);
  const shopifyOrderName = order.name;
  const customerName = `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim() || "Customer";
  const customerEmail = order.customer?.email || order.email || "";
  const customerPhone =
    order.customer?.phone || order.phone || order.shipping_address?.phone || order.billing_address?.phone || "";

  for (const item of order.line_items || []) {
    const properties = item.properties || [];
    const prop = (key: string) => properties.find((p) => p.name === key)?.value || "";

    // Read rental data in two formats:
    // - NEW (v17+): single _miko_data JSON blob (keeps admin order page tidy)
    // - OLD (pre-v17): six separate _miko_* properties
    // The fallback lets us recover bookings from orders placed before v17.
    let mikoData: {
      // Compact keys (v27+)
      p?: string;
      s?: string;
      e?: string;
      r?: string;
      d?: string;
      pu?: string;
      u?: number | string;
      // Legacy long keys (pre-v27) - we still read these so in-flight orders
      // keep working after the format change.
      productId?: string;
      startDate?: string;
      endDate?: string;
      totalPrice?: string;
      rentalPrice?: string;
      depositAmount?: string;
      perUnitPrice?: string;
      units?: number | string;
    } | null = null;

    const rawData = prop("_miko_data");
    if (rawData) {
      try {
        mikoData = JSON.parse(rawData);
      } catch {
        mikoData = null;
      }
    } else if (prop("_miko_rental_product_id")) {
      mikoData = {
        productId: prop("_miko_rental_product_id"),
        startDate: prop("_miko_start_date"),
        endDate: prop("_miko_end_date"),
        totalPrice: prop("_miko_total_price"),
        rentalPrice: prop("_miko_rental_price"),
        depositAmount: prop("_miko_deposit_amount"),
      };
    }

    if (!mikoData) {
      result.skipped++;
      continue;
    }

    // Resolve fields from either compact (p/s/e) or legacy (productId/start/end)
    // keys. The compact format only stores the numeric product id, so we
    // re-prepend the GID prefix.
    const compactProductId = mikoData.p ? `gid://shopify/Product/${mikoData.p}` : "";
    const shopifyProductGid = mikoData.productId || compactProductId;
    const startDateStr = mikoData.startDate || mikoData.s || "";
    const endDateStr = mikoData.endDate || mikoData.e || "";
    if (!shopifyProductGid || !startDateStr || !endDateStr) {
      result.skipped++;
      continue;
    }

    const rentalProduct = await db.rentalProduct.findFirst({
      where: { shopifyProductId: shopifyProductGid, shop },
    });
    if (!rentalProduct) {
      result.skipped++;
      continue;
    }

    // Resolve the variant if this is a multi-variant rental. Shopify includes
    // variant_id on every order line item, so we don't need it in _miko_data.
    // For single-variant rentals (hasVariants=false) the linkage is simply
    // null and capacity is checked against the product as a whole.
    let rentalVariantId: string | null = null;
    let variantTotalUnits = rentalProduct.totalUnits;
    if (rentalProduct.hasVariants && item.variant_id) {
      const variantGid = `gid://shopify/ProductVariant/${item.variant_id}`;
      const variant = await db.rentalVariant.findFirst({
        where: { rentalProductId: rentalProduct.id, shopifyVariantId: variantGid },
        select: { id: true, totalUnits: true, isActive: true },
      });
      if (variant && variant.isActive) {
        rentalVariantId = variant.id;
        variantTotalUnits = variant.totalUnits;
      }
    }

    // Existing booking lookup includes variant so two bookings on the same
    // order for different variants of the same product don't collide.
    const existing = await db.rentalBooking.findFirst({
      where: {
        shop,
        shopifyOrderId,
        rentalProductId: rentalProduct.id,
        ...(rentalVariantId ? { rentalVariantId } : {}),
      },
    });

    // If a booking already exists for this order, only the pending -> confirmed
    // upgrade is meaningful. Anything else (already confirmed, returned,
    // needs_review) we leave alone.
    if (existing) {
      if (options.upgradeToConfirmed && existing.status === "pending") {
        // Re-check capacity before confirming. If a competing booking landed
        // between order placement and payment capture, refuse to confirm and
        // flag for merchant review instead of silently overbooking.
        const peakNow = await peakBookedUnits({
          rentalProductId: existing.rentalProductId,
          rentalVariantId: existing.rentalVariantId,
          startDate: existing.startDate,
          endDate: existing.endDate,
          excludeBookingId: existing.id,
        });
        const stillFits = peakNow + existing.unitsRented <= variantTotalUnits;
        await db.rentalBooking.update({
          where: { id: existing.id },
          data: stillFits
            ? {
                status: "confirmed",
                depositStatus: existing.depositAmount > 0 ? "held" : "released",
              }
            : {
                status: "needs_review",
                merchantNotes:
                  existing.merchantNotes ||
                  `[Auto-flagged] Capacity conflict at payment time. ${peakNow} unit(s) already booked but this booking is for ${existing.unitsRented}. Resolve by contacting the customer or adjusting another booking.`,
              },
        });
        if (stillFits) result.bookingsUpgraded++;
        else result.bookingsFlaggedForReview++;
      } else {
        result.skipped++;
      }
      continue;
    }

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);

    // Units: prefer the value the widget recorded - that's the customer's
    // deliberate selection at booking time. We deliberately do NOT trust the
    // Shopify line quantity, because the theme cart's quantity selector lets
    // customers bump it post-booking, which would bypass our overbooking
    // guard. The Cart Transform Function locks future cart qty changes back
    // to the recorded value, but legacy orders may have slipped through.
    const recordedUnits = parseInt(String(mikoData.u ?? mikoData.units ?? ""), 10);
    const lineQuantity = typeof item.quantity === "number" ? item.quantity : 1;
    const units = Math.max(1, isNaN(recordedUnits) ? lineQuantity : recordedUnits);

    // Did the customer pay for more units than they booked? If so, the order
    // total is higher than the booking total - flag for merchant review and
    // refund. Detected when the Shopify line quantity exceeds the recorded
    // booking units.
    const overpaidUnits = !isNaN(recordedUnits) && lineQuantity > recordedUnits
      ? lineQuantity - recordedUnits
      : 0;

    // For variant rentals, fall back to the variant's pricing when the cart
    // properties don't carry numeric amounts. The widget always writes the
    // r/d/pu keys for fresh orders so this path is mostly a safety net for
    // legacy orders.
    let fallbackVariant: { pricePerDay: number; pricePerWeek: number; pricePerMonth: number; depositAmount: number } | null = null;
    if (rentalVariantId) {
      fallbackVariant = await db.rentalVariant.findUnique({
        where: { id: rentalVariantId },
        select: { pricePerDay: true, pricePerWeek: true, pricePerMonth: true, depositAmount: true },
      });
    }
    const calculated = calculateRentalPrice({
      startDate,
      endDate,
      pricePerDay: fallbackVariant?.pricePerDay ?? rentalProduct.pricePerDay,
      pricePerWeek: fallbackVariant?.pricePerWeek ?? rentalProduct.pricePerWeek,
      pricePerMonth: fallbackVariant?.pricePerMonth ?? rentalProduct.pricePerMonth,
      depositAmount: fallbackVariant?.depositAmount ?? rentalProduct.depositAmount,
      units,
    });

    // Use cart amounts when sensible (matches what the customer actually paid)
    // and fall back to calculated values otherwise.
    const propRentalPrice = parseFloat(mikoData.r || mikoData.rentalPrice || "");
    const propDepositAmount = parseFloat(mikoData.d || mikoData.depositAmount || "");
    const propTotalPrice = parseFloat(mikoData.totalPrice || "");
    const rentalPrice =
      !isNaN(propRentalPrice) && propRentalPrice > 0 ? propRentalPrice : calculated.rentalPrice;
    const depositAmount =
      !isNaN(propDepositAmount) && propDepositAmount >= 0 ? propDepositAmount : calculated.depositAmount;
    const totalDue =
      !isNaN(propTotalPrice) && propTotalPrice > 0 ? propTotalPrice : calculated.totalDue;

    const isPaid =
      options.upgradeToConfirmed ||
      ["paid", "partially_paid"].includes(order.financial_status || "");

    // Atomic overbooking check - count peak booked units across the range,
    // excluding any pending booking that's about to be upgraded for this order.
    const existingPending = await db.rentalBooking.findFirst({
      where: {
        shop,
        shopifyOrderId,
        rentalProductId: rentalProduct.id,
        ...(rentalVariantId ? { rentalVariantId } : {}),
        status: "pending",
      },
      select: { id: true },
    });
    const peak = await peakBookedUnits({
      rentalProductId: rentalProduct.id,
      rentalVariantId,
      startDate,
      endDate,
      excludeBookingId: existingPending?.id,
    });
    const wouldOverbook = peak + units > variantTotalUnits;
    const overbookNote = wouldOverbook
      ? `[Auto-flagged] Order requested ${units} unit(s) but ${peak} unit(s) were already booked across ${variantTotalUnits} total. Resolve by contacting the customer or adjusting another booking.`
      : "";

    // Build a combined note if the order quantity didn't match the booking
    // quantity (customer bumped the qty selector in the theme cart after
    // booking) - the customer paid more than the rental amount and likely
    // needs a refund.
    const overpayNote = overpaidUnits > 0
      ? `[Auto-flagged] Customer's cart quantity (${lineQuantity}) exceeded the units they booked (${units}). They paid for ${overpaidUnits} extra unit(s). Refund the difference in Shopify or contact the customer.`
      : "";
    const combinedNote = [overbookNote, overpayNote].filter(Boolean).join("\n\n");
    const needsReview = wouldOverbook || overpaidUnits > 0;

    await db.rentalBooking.create({
      data: {
        shop,
        rentalProductId: rentalProduct.id,
        rentalVariantId,
        shopifyOrderId,
        shopifyOrderName,
        shopifyLineItemId: item.id ? String(item.id) : "",
        customerName,
        customerEmail,
        customerPhone,
        startDate,
        endDate,
        unitsRented: units,
        rentalDays: calculated.rentalDays,
        rentalPrice,
        depositAmount,
        depositStatus: isPaid ? (depositAmount > 0 ? "held" : "released") : "pending",
        totalCharged: totalDue,
        // Overbooked or overpaid orders never silently confirm - they need
        // merchant action.
        status: needsReview ? "needs_review" : isPaid ? "confirmed" : "pending",
        lateFeeCharged: 0,
        merchantNotes: combinedNote,
      },
    });
    if (needsReview) result.bookingsFlaggedForReview++;
    else result.bookingsCreated++;
  }

  return result;
}
