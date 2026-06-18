import { differenceInDays, differenceInWeeks } from "date-fns";

export interface RentalPricingInput {
  startDate: Date;
  endDate: Date;
  pricePerDay: number;
  pricePerWeek: number;  // 0 = not offered
  pricePerMonth: number; // 0 = not offered
  depositAmount: number;
  units?: number; // how many physical units the customer is renting; defaults to 1
}

export interface RentalPricingResult {
  rentalDays: number;
  units: number;
  rentalPrice: number;   // total rental fee (already multiplied by units)
  depositAmount: number; // total deposit (already multiplied by units)
  totalDue: number;      // rental + deposit
  perUnitPrice: number;  // (rental fee + deposit) for a single unit - used by Cart Transform
  breakdown: string;     // human-readable explanation
}

/**
 * Calculates the cheapest valid rental price for the selected date range.
 * Uses monthly rate first if available, then weekly, then daily.
 *
 * If `units` is provided and > 1, the rental fee and deposit are multiplied
 * by units. `perUnitPrice` is also returned so the Cart Transform Function
 * can set the right fixedPricePerUnit when the cart line quantity = units.
 */
export function calculateRentalPrice(input: RentalPricingInput): RentalPricingResult {
  const { startDate, endDate, pricePerDay, pricePerWeek, pricePerMonth, depositAmount } = input;
  const units = Math.max(1, Math.floor(input.units ?? 1));

  const rentalDays = differenceInDays(endDate, startDate);
  if (rentalDays <= 0) {
    const totalDeposit = depositAmount * units;
    return {
      rentalDays: 0,
      units,
      rentalPrice: 0,
      depositAmount: totalDeposit,
      totalDue: totalDeposit,
      perUnitPrice: depositAmount,
      breakdown: "Invalid date range",
    };
  }

  let perUnitRental = 0;
  let breakdown = "";

  if (pricePerMonth > 0 && rentalDays >= 30) {
    const fullMonths = Math.floor(rentalDays / 30);
    const remainingDays = rentalDays % 30;
    const monthlyTotal = fullMonths * pricePerMonth;
    const dailyTotal = remainingDays * pricePerDay;
    perUnitRental = monthlyTotal + dailyTotal;
    breakdown = fullMonths > 0 ? `${fullMonths} month${fullMonths > 1 ? "s" : ""}` : "";
    if (remainingDays > 0) breakdown += ` + ${remainingDays} day${remainingDays > 1 ? "s" : ""}`;
  } else if (pricePerWeek > 0 && rentalDays >= 7) {
    const fullWeeks = Math.floor(rentalDays / 7);
    const remainingDays = rentalDays % 7;
    perUnitRental = fullWeeks * pricePerWeek + remainingDays * pricePerDay;
    breakdown = fullWeeks > 0 ? `${fullWeeks} week${fullWeeks > 1 ? "s" : ""}` : "";
    if (remainingDays > 0) breakdown += ` + ${remainingDays} day${remainingDays > 1 ? "s" : ""}`;
  } else {
    perUnitRental = rentalDays * pricePerDay;
    breakdown = `${rentalDays} day${rentalDays > 1 ? "s" : ""}`;
  }

  if (units > 1) {
    breakdown = `${units} × (${breakdown})`;
  }

  const rentalPrice = perUnitRental * units;
  const totalDeposit = depositAmount * units;
  const totalDue = rentalPrice + totalDeposit;
  const perUnitPrice = perUnitRental + depositAmount;

  return {
    rentalDays,
    units,
    rentalPrice,
    depositAmount: totalDeposit,
    totalDue,
    perUnitPrice,
    breakdown,
  };
}

/**
 * Formats a currency amount into a human-readable string.
 */
export function formatCurrency(amount: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}
