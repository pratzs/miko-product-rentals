/**
 * Shared booking creation logic used by both the orders/create webhook
 * (which creates pending bookings) and the orders/paid webhook (which
 * upgrades them to confirmed). Also used by the manual "sync orders"
 * admin action.
 */
import { db } from "~/db.server";
import { calculateRentalPrice } from "./pricing";
import { bufferDays, getBufferHours, heldOverlapWhere, peakHeldUnits } from "./availability";
import { checkoutWouldPriceAsRental } from "./checkout-pricing-check";

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
    product_id?: string | number | null;
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
 * on this product that overlaps the new range, day by day, including the
 * availability buffer after each booking ends (Settings → Availability
 * buffer). Returns the peak already-held units on any single day the new
 * booking would hold its unit. If peak + unitsNeeded exceeds totalUnits,
 * accepting the new booking would overbook.
 *
 * Excludes the booking we're about to upgrade so re-running orders/paid
 * doesn't double-count the same booking.
 */
async function peakBookedUnits(opts: {
  rentalProductId: string;
  rentalVariantId?: string | null;
  startDate: Date;
  endDate: Date;
  bufferDays: number;
  excludeBookingId?: string;
}): Promise<number> {
  const overlapping = await db.rentalBooking.findMany({
    where: {
      rentalProductId: opts.rentalProductId,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      ...heldOverlapWhere(opts.startDate, opts.endDate, opts.bufferDays),
      ...(opts.rentalVariantId ? { rentalVariantId: opts.rentalVariantId } : {}),
      ...(opts.excludeBookingId ? { id: { not: opts.excludeBookingId } } : {}),
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  return peakHeldUnits(overlapping, opts.startDate, opts.endDate, opts.bufferDays);
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
  const buffer = bufferDays(await getBufferHours(shop));
  const bufferNote = buffer > 0 ? " (counting your availability buffer between bookings)" : "";

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

    // `_miko_data` is a cart line property, so the shopper's browser wrote it.
    // The product it names must be the product that was actually ordered on
    // this line. Otherwise a shopper could pay for one item and have the
    // booking (and its availability hold and deposit) recorded against
    // another. The Cart Transform Function applies the same rule before it
    // prices a line.
    if (
      item.product_id != null &&
      `gid://shopify/Product/${item.product_id}` !== shopifyProductGid
    ) {
      console.warn(
        `[booking-from-order] ${shop} order ${shopifyOrderName}: rental data names ${shopifyProductGid} but the line is product ${item.product_id}. Skipped.`,
      );
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
    const lineVariantGid = item.variant_id ? `gid://shopify/ProductVariant/${item.variant_id}` : null;
    let lineVariant: {
      id: string;
      totalUnits: number;
      isActive: boolean;
      pricePerDay: number;
      pricePerWeek: number;
      pricePerMonth: number;
      depositAmount: number;
    } | null = null;
    if (rentalProduct.hasVariants && lineVariantGid) {
      lineVariant = await db.rentalVariant.findFirst({
        where: { rentalProductId: rentalProduct.id, shopifyVariantId: lineVariantGid },
        select: {
          id: true,
          totalUnits: true,
          isActive: true,
          pricePerDay: true,
          pricePerWeek: true,
          pricePerMonth: true,
          depositAmount: true,
        },
      });
      if (lineVariant && lineVariant.isActive) {
        rentalVariantId = lineVariant.id;
        variantTotalUnits = lineVariant.totalUnits;
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
          bufferDays: buffer,
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
                  `[Auto-flagged] Capacity conflict at payment time. ${peakNow} unit(s) already booked${bufferNote} but this booking is for ${existing.unitsRented}. Resolve by contacting the customer or adjusting another booking.`,
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
    // The dates are shopper-written too. Garbage or an absurd range must not
    // crash the webhook or drive the day-by-day capacity loops below.
    const spanDays = (endDate.getTime() - startDate.getTime()) / 86_400_000;
    if (isNaN(spanDays) || spanDays <= 0 || spanDays > 3660) {
      console.warn(
        `[booking-from-order] ${shop} order ${shopifyOrderName}: unusable rental dates. Skipped.`,
      );
      result.skipped++;
      continue;
    }

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

    // Price the booking from the merchant's rates: the variant's own rates
    // for a multi-variant rental, the product's otherwise.
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

    // The amounts ALWAYS come from the merchant's own rates, never from the
    // cart properties. `r`/`d`/`pu` are written by the shopper's browser, so a
    // forged value here used to become the booking's recorded price and, worse,
    // the deposit figure a later refund is based on. The Cart Transform
    // Function charges from the same rates, so for a genuine booking these are
    // the numbers the customer paid.
    const rentalPrice = calculated.rentalPrice;
    const depositAmount = calculated.depositAmount;
    const totalDue = calculated.totalDue;

    // If the properties claim different amounts, something is off: forged
    // data, or the merchant changed the rates between the customer picking
    // dates and paying. Either way a person should look, so the booking is
    // held for review instead of confirming silently.
    const propRentalPrice = parseFloat(mikoData.r || mikoData.rentalPrice || "");
    const propDepositAmount = parseFloat(mikoData.d || mikoData.depositAmount || "");
    const differs = (claimed: number, actual: number) =>
      !isNaN(claimed) && Math.abs(claimed - actual) > 0.011;
    const amountsMismatch =
      differs(propRentalPrice, rentalPrice) || differs(propDepositAmount, depositAmount);
    const mismatchNote = amountsMismatch
      ? `[Auto-flagged] The rental data on this order claims a rental fee of ${isNaN(propRentalPrice) ? "n/a" : propRentalPrice.toFixed(2)} and a deposit of ${isNaN(propDepositAmount) ? "n/a" : propDepositAmount.toFixed(2)}, but this product's rates give ${rentalPrice.toFixed(2)} and ${depositAmount.toFixed(2)}. This booking uses the rates. Check what the customer paid on the Shopify order before confirming or refunding.`
      : "";

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
      bufferDays: buffer,
      excludeBookingId: existingPending?.id,
    });
    const wouldOverbook = peak + units > variantTotalUnits;
    const overbookNote = wouldOverbook
      ? `[Auto-flagged] Order requested ${units} unit(s) but ${peak} unit(s) were already booked${bufferNote} across ${variantTotalUnits} total. Resolve by contacting the customer or adjusting another booking.`
      : "";

    // Build a combined note if the order quantity didn't match the booking
    // quantity (customer bumped the qty selector in the theme cart after
    // booking) - the customer paid more than the rental amount and likely
    // needs a refund.
    const overpayNote = overpaidUnits > 0
      ? `[Auto-flagged] Customer's cart quantity (${lineQuantity}) exceeded the units they booked (${units}). They paid for ${overpaidUnits} extra unit(s). Refund the difference in Shopify or contact the customer.`
      : "";
    // Checkout only charges the rental price for a line whose rental data
    // passes the Cart Transform Function's rules. Anything else was charged
    // the variant's normal price, so it must not become a normal confirmed
    // booking: a shopper could otherwise attach made-up rental data to any
    // purchase and walk away with a "paid" booking. Lines in the old
    // six-property format (no `_miko_data`) are never priced by checkout.
    const pricedAtCheckout =
      rawData !== "" &&
      checkoutWouldPriceAsRental({
        rawRentalData: rawData,
        lineQuantity,
        lineProductGid:
          item.product_id != null ? `gid://shopify/Product/${item.product_id}` : shopifyProductGid,
        lineVariantGid,
        product: rentalProduct,
        variant: lineVariant,
      });
    const unpricedNote = pricedAtCheckout
      ? ""
      : "[Auto-flagged] The rental details on this order line do not pass the checks checkout uses to charge the rental price (active rental, matching product, valid dates within the minimum and maximum rental length, valid units), so checkout may have charged the regular product price instead. Check what the customer paid on the Shopify order before treating this as a booking.";

    const combinedNote = [overbookNote, overpayNote, mismatchNote, unpricedNote].filter(Boolean).join("\n\n");
    const needsReview = wouldOverbook || overpaidUnits > 0 || amountsMismatch || !pricedAtCheckout;

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
