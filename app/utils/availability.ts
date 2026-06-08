import { db } from "~/db.server";
import { eachDayOfInterval, format, parseISO, startOfDay } from "date-fns";

/**
 * Returns the number of units available for a given product on each day
 * within the requested range. A unit is considered unavailable if it has
 * a confirmed/active booking that overlaps with that day.
 */
export async function getUnavailableDates(
  shop: string,
  shopifyProductId: string,
  fromDate: Date,
  toDate: Date,
): Promise<string[]> {
  const rentalProduct = await db.rentalProduct.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (!rentalProduct || !rentalProduct.isActive) return [];

  // All confirmed/active bookings that overlap the requested range.
  const overlappingBookings = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["confirmed", "active"] },
      startDate: { lt: toDate },
      endDate: { gt: fromDate },
    },
  });

  // For each day in the range, count booked units. If fully booked, mark unavailable.
  const allDays = eachDayOfInterval({ start: fromDate, end: toDate });
  const unavailable: string[] = [];

  for (const day of allDays) {
    const bookedUnits = overlappingBookings.filter((b) => {
      return startOfDay(b.startDate) <= startOfDay(day) && startOfDay(b.endDate) > startOfDay(day);
    }).reduce((sum, b) => sum + b.unitsRented, 0);

    if (bookedUnits >= rentalProduct.totalUnits) {
      unavailable.push(format(day, "yyyy-MM-dd"));
    }
  }

  // Also include manually blocked dates.
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
 * fulfill a booking request. Returns true if the booking can proceed.
 */
export async function isRangeAvailable(
  shop: string,
  shopifyProductId: string,
  startDate: Date,
  endDate: Date,
  unitsNeeded: number = 1,
): Promise<boolean> {
  const rentalProduct = await db.rentalProduct.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId } },
  });

  if (!rentalProduct || !rentalProduct.isActive) return false;

  // Check for any manually blocked dates in the range.
  const blockedCount = await db.blockedDate.count({
    where: {
      shop,
      blockedDate: { gte: startDate, lt: endDate },
      OR: [{ shopifyProductId }, { shopifyProductId: null }],
    },
  });

  if (blockedCount > 0) return false;

  // Sum of units booked in any booking that overlaps this range.
  const overlapping = await db.rentalBooking.findMany({
    where: {
      rentalProductId: rentalProduct.id,
      status: { in: ["confirmed", "active"] },
      startDate: { lt: endDate },
      endDate: { gt: startDate },
    },
  });

  const maxOverlapUnits = overlapping.reduce((sum, b) => sum + b.unitsRented, 0);
  return maxOverlapUnits + unitsNeeded <= rentalProduct.totalUnits;
}
