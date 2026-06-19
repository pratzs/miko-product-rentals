import { db } from "~/db.server";
import { eachDayOfInterval, format, parseISO, startOfDay } from "date-fns";

/**
 * Returns the dates in the requested range where there is no remaining unit
 * for the requested number of units (default 1). Considers pending,
 * confirmed and active bookings so we never double-book between order
 * placement and payment capture.
 *
 * If shopifyVariantId is provided and the product has variants configured,
 * availability is scoped to that specific variant. Otherwise the product
 * level totalUnits and aggregate booking pool are used (backwards-compatible
 * for single-variant rentals).
 */
export async function getUnavailableDates(
  shop: string,
  shopifyProductId: string,
  fromDate: Date,
  toDate: Date,
  unitsNeeded: number = 1,
  shopifyVariantId?: string,
): Promise<string[]> {
  const rentalProduct = await db.rentalProduct.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (!rentalProduct || !rentalProduct.isActive) return [];

  // Variant resolution: if the product has variants AND a variantId was
  // passed, we count bookings against that variant only and use the
  // variant's totalUnits as the cap.
  let totalUnits = rentalProduct.totalUnits;
  let variantFilter: { rentalVariantId: string } | null = null;
  if (rentalProduct.hasVariants && shopifyVariantId) {
    const variant = await db.rentalVariant.findFirst({
      where: { rentalProductId: rentalProduct.id, shopifyVariantId },
    });
    if (variant) {
      if (!variant.isActive) return []; // variant disabled, treat as all-unavailable upstream
      totalUnits = variant.totalUnits;
      variantFilter = { rentalVariantId: variant.id };
    }
  }

  const overlappingBookings = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      startDate: { lt: toDate },
      endDate: { gt: fromDate },
      ...(variantFilter ?? {}),
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  const allDays = eachDayOfInterval({ start: fromDate, end: toDate });
  const unavailable: string[] = [];

  for (const day of allDays) {
    const bookedUnits = overlappingBookings
      .filter((b) => startOfDay(b.startDate) <= startOfDay(day) && startOfDay(b.endDate) > startOfDay(day))
      .reduce((sum, b) => sum + b.unitsRented, 0);

    if (bookedUnits + unitsNeeded > totalUnits) {
      unavailable.push(format(day, "yyyy-MM-dd"));
    }
  }

  const blockedDates = await db.blockedDate.findMany({
    where: {
      shop,
      blockedDate: { gte: fromDate, lte: toDate },
      OR: [{ shopifyProductId }, { shopifyProductId: null }],
    },
  });

  for (const b of blockedDates) {
    const dateStr = format(b.blockedDate, "yyyy-MM-dd");
    if (!unavailable.includes(dateStr)) unavailable.push(dateStr);
  }

  return unavailable;
}

/**
 * Computes the worst-case (highest) number of units booked on any single
 * day in the range. We can only fulfil a new booking if the new units +
 * peak booked units fits within totalUnits.
 *
 * Walking day-by-day prevents the additive bug where two non-overlapping
 * bookings would falsely sum together and block the new booking.
 */
function peakBookedUnitsAcrossRange(
  bookings: Array<{ startDate: Date; endDate: Date; unitsRented: number }>,
  rangeStart: Date,
  rangeEnd: Date,
): number {
  let peak = 0;
  const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });
  for (const day of days) {
    const onThisDay = bookings
      .filter((b) => startOfDay(b.startDate) <= startOfDay(day) && startOfDay(b.endDate) > startOfDay(day))
      .reduce((sum, b) => sum + b.unitsRented, 0);
    if (onThisDay > peak) peak = onThisDay;
  }
  return peak;
}

/**
 * Checks whether a specific date range has enough available units to
 * fulfill a booking request. Returns the available unit count so the
 * caller can show the user how many they could book.
 *
 * Bookings considered for unit counting include both `confirmed`/`active`
 * (definite holds) AND `pending` (orders placed but not yet paid - we
 * still hold capacity for these or we'd risk overselling between the
 * orders/create webhook firing and the customer paying).
 */
export async function isRangeAvailable(
  shop: string,
  shopifyProductId: string,
  startDate: Date,
  endDate: Date,
  unitsNeeded: number = 1,
  shopifyVariantId?: string,
): Promise<{ available: boolean; unitsAvailable: number; totalUnits: number }> {
  const rentalProduct = await db.rentalProduct.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (!rentalProduct || !rentalProduct.isActive) {
    return { available: false, unitsAvailable: 0, totalUnits: 0 };
  }

  // Variant resolution. When the product has variants and a variantId was
  // passed we scope availability to that specific variant.
  let totalUnits = rentalProduct.totalUnits;
  let variantFilter: { rentalVariantId: string } | null = null;
  if (rentalProduct.hasVariants && shopifyVariantId) {
    const variant = await db.rentalVariant.findFirst({
      where: { rentalProductId: rentalProduct.id, shopifyVariantId },
    });
    if (!variant) {
      return { available: false, unitsAvailable: 0, totalUnits: 0 };
    }
    if (!variant.isActive) {
      return { available: false, unitsAvailable: 0, totalUnits: 0 };
    }
    totalUnits = variant.totalUnits;
    variantFilter = { rentalVariantId: variant.id };
  } else if (rentalProduct.hasVariants && !shopifyVariantId) {
    // Caller didn't pick a variant on a multi-variant product. We can't
    // determine availability without knowing which variant they want.
    return { available: false, unitsAvailable: 0, totalUnits: 0 };
  }

  // Manually blocked dates fully block the range.
  const blockedCount = await db.blockedDate.count({
    where: {
      shop,
      blockedDate: { gte: startDate, lt: endDate },
      OR: [{ shopifyProductId }, { shopifyProductId: null }],
    },
  });
  if (blockedCount > 0) {
    return { available: false, unitsAvailable: 0, totalUnits };
  }

  const overlapping = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
      ...(variantFilter ?? {}),
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  // Peak across the requested range - a single day with N units booked is the
  // limiting factor, not the total across the whole range.
  const peakBooked = peakBookedUnitsAcrossRange(overlapping, startDate, endDate);
  const unitsAvailable = Math.max(0, totalUnits - peakBooked);
  return {
    available: peakBooked + unitsNeeded <= totalUnits,
    unitsAvailable,
    totalUnits,
  };
}
