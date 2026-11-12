import { db } from "~/db.server";
import { addDays, eachDayOfInterval, format, startOfDay, subDays } from "date-fns";

/**
 * Settings → Rental settings → Availability buffer, in hours. After a booking
 * ends its unit stays unavailable for this long (cleaning, checks, transit).
 */
export async function getBufferHours(shop: string): Promise<number> {
  const config = await db.shopConfig.findUnique({ where: { shop }, select: { bufferHours: true } });
  return Math.max(0, config?.bufferHours ?? 0);
}

/**
 * Bookings are by the day, so the buffer is rounded up to whole days:
 * 1 to 24 hours keeps the unit unavailable on the return day, 25 to 48 hours
 * on the return day and the day after, and so on. 0 means no gap.
 */
export function bufferDays(bufferHours: number | null | undefined): number {
  const h = Number(bufferHours) || 0;
  return h > 0 ? Math.ceil(h / 24) : 0;
}

/**
 * The first day a booking's unit is free again: the end day plus the buffer.
 * With no buffer this is the end day itself, as it always was.
 */
export function heldUntil(endDate: Date, buffer: number): Date {
  return addDays(startOfDay(endDate), buffer);
}

type HeldBooking = { startDate: Date; endDate: Date; unitsRented: number };

/** Units held on one day, counting each booking's buffer after it ends. */
export function unitsHeldOnDay(bookings: HeldBooking[], day: Date, buffer: number): number {
  const d = startOfDay(day);
  return bookings
    .filter((b) => startOfDay(b.startDate) <= d && heldUntil(b.endDate, buffer) > d)
    .reduce((sum, b) => sum + b.unitsRented, 0);
}

/**
 * Computes the worst-case (highest) number of units held on any single day a
 * new booking from rangeStart to rangeEnd would hold its unit. The new
 * booking holds it for the buffer after it ends too, so it cannot end right
 * before another booking starts without leaving the same gap.
 *
 * Walking day-by-day prevents the additive bug where two non-overlapping
 * bookings would falsely sum together and block the new booking.
 */
export function peakHeldUnits(
  bookings: HeldBooking[],
  rangeStart: Date,
  rangeEnd: Date,
  buffer: number,
): number {
  let peak = 0;
  const first = startOfDay(rangeStart);
  // Days the new booking holds its unit: its start day up to (not including)
  // the day it is free again. A booking always holds at least its start day.
  const last = subDays(heldUntil(rangeEnd, buffer), 1);
  const days = eachDayOfInterval({ start: first, end: last < first ? first : last });
  for (const day of days) {
    const onThisDay = unitsHeldOnDay(bookings, day, buffer);
    if (onThisDay > peak) peak = onThisDay;
  }
  return peak;
}

/**
 * Database filter for bookings that can matter to a new booking from
 * rangeStart to rangeEnd once the buffer is counted on both sides.
 */
export function heldOverlapWhere(rangeStart: Date, rangeEnd: Date, buffer: number) {
  return {
    startDate: { lt: addDays(rangeEnd, buffer) },
    endDate: { gt: subDays(rangeStart, buffer) },
  };
}

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

  const buffer = bufferDays(await getBufferHours(shop));

  const overlappingBookings = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      ...(buffer > 0
        ? heldOverlapWhere(fromDate, addDays(toDate, 1), buffer)
        : { startDate: { lt: toDate }, endDate: { gt: fromDate } }),
      ...(variantFilter ?? {}),
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  const allDays = eachDayOfInterval({ start: fromDate, end: toDate });
  const unavailable: string[] = [];

  for (const day of allDays) {
    // The shortest booking that uses this day holds its unit from this day
    // until the buffer after it ends, so every one of those days must fit.
    const bookedUnits = peakHeldUnits(overlappingBookings, day, addDays(day, 1), buffer);

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

  const buffer = bufferDays(await getBufferHours(shop));

  const overlapping = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      ...heldOverlapWhere(startDate, endDate, buffer),
      ...(variantFilter ?? {}),
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  // Peak across the requested range plus its buffer - a single day with N
  // units held is the limiting factor, not the total across the whole range.
  const peakBooked = peakHeldUnits(overlapping, startDate, endDate, buffer);
  const unitsAvailable = Math.max(0, totalUnits - peakBooked);
  return {
    available: peakBooked + unitsNeeded <= totalUnits,
    unitsAvailable,
    totalUnits,
  };
}
