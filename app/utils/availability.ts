import { db } from "~/db.server";
import { eachDayOfInterval, format, parseISO, startOfDay } from "date-fns";

/**
 * Returns the dates in the requested range where there is no remaining unit
 * for the requested number of units (default 1). Considers pending,
 * confirmed and active bookings so we never double-book between order
 * placement and payment capture.
 */
export async function getUnavailableDates(
  shop: string,
  shopifyProductId: string,
  fromDate: Date,
  toDate: Date,
  unitsNeeded: number = 1,
): Promise<string[]> {
  const rentalProduct = await db.rentalProduct.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (!rentalProduct || !rentalProduct.isActive) return [];

  const overlappingBookings = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      startDate: { lt: toDate },
      endDate: { gt: fromDate },
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  const allDays = eachDayOfInterval({ start: fromDate, end: toDate });
  const unavailable: string[] = [];

  for (const day of allDays) {
    const bookedUnits = overlappingBookings
      .filter((b) => startOfDay(b.startDate) <= startOfDay(day) && startOfDay(b.endDate) > startOfDay(day))
      .reduce((sum, b) => sum + b.unitsRented, 0);

    if (bookedUnits + unitsNeeded > rentalProduct.totalUnits) {
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
): Promise<{ available: boolean; unitsAvailable: number; totalUnits: number }> {
  const rentalProduct = await db.rentalProduct.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (!rentalProduct || !rentalProduct.isActive) {
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
    return { available: false, unitsAvailable: 0, totalUnits: rentalProduct.totalUnits };
  }

  const overlapping = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["pending", "confirmed", "active", "needs_review"] },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
    },
    select: { startDate: true, endDate: true, unitsRented: true },
  });

  // Peak across the requested range - a single day with N units booked is the
  // limiting factor, not the total across the whole range.
  const peakBooked = peakBookedUnitsAcrossRange(overlapping, startDate, endDate);
  const unitsAvailable = Math.max(0, rentalProduct.totalUnits - peakBooked);
  return {
    available: peakBooked + unitsNeeded <= rentalProduct.totalUnits,
    unitsAvailable,
    totalUnits: rentalProduct.totalUnits,
  };
}
