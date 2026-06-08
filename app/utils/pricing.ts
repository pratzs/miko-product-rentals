import { differenceInDays, differenceInWeeks } from "date-fns";

export interface RentalPricingInput {
  startDate: Date;
  endDate: Date;
  pricePerDay: number;
  pricePerWeek: number;  // 0 = not offered
  pricePerMonth: number; // 0 = not offered
  depositAmount: number;
}

export interface RentalPricingResult {
  rentalDays: number;
  rentalPrice: number;
  depositAmount: number;
  totalDue: number;
  breakdown: string; // human-readable explanation
}

/**
 * Calculates the cheapest valid rental price for the selected date range.
 * Uses monthly rate first if available, then weekly, then daily.
 */
export function calculateRentalPrice(input: RentalPricingInput): RentalPricingResult {
  const { startDate, endDate, pricePerDay, pricePerWeek, pricePerMonth, depositAmount } = input;

  const rentalDays = differenceInDays(endDate, startDate);
  if (rentalDays <= 0) {
    return { rentalDays: 0, rentalPrice: 0, depositAmount, totalDue: depositAmount, breakdown: "Invalid date range" };
  }

  let rentalPrice = 0;
  let breakdown = "";

  if (pricePerMonth > 0 && rentalDays >= 30) {
    const fullMonths = Math.floor(rentalDays / 30);
    const remainingDays = rentalDays % 30;
    const monthlyTotal = fullMonths * pricePerMonth;
    const dailyTotal = remainingDays * pricePerDay;
    rentalPrice = monthlyTotal + dailyTotal;
    breakdown = fullMonths > 0 ? `${fullMonths} month${fullMonths > 1 ? "s" : ""}` : "";
    if (remainingDays > 0) breakdown += ` + ${remainingDays} day${remainingDays > 1 ? "s" : ""}`;
  } else if (pricePerWeek > 0 && rentalDays >= 7) {
    const fullWeeks = Math.floor(rentalDays / 7);
    const remainingDays = rentalDays % 7;
    rentalPrice = fullWeeks * pricePerWeek + remainingDays * pricePerDay;
    breakdown = fullWeeks > 0 ? `${fullWeeks} week${fullWeeks > 1 ? "s" : ""}` : "";
    if (remainingDays > 0) breakdown += ` + ${remainingDays} day${remainingDays > 1 ? "s" : ""}`;
  } else {
    rentalPrice = rentalDays * pricePerDay;
    breakdown = `${rentalDays} day${rentalDays > 1 ? "s" : ""}`;
  }

  const totalDue = rentalPrice + depositAmount;

  return { rentalDays, rentalPrice, depositAmount, totalDue, breakdown };
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
