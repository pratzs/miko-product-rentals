/**
 * The one place a rental is quoted: is this product (and variant) rentable,
 * are the dates allowed and free, and what does it cost at the merchant's
 * rates. Used by the public /api/pricing endpoint (the storefront calendar)
 * and by /api/checkout, which must never take a price from its caller.
 *
 * Moved here unchanged from the /api/pricing loader so both callers apply
 * identical rules. The Cart Transform Function
 * (extensions/miko-cart-transform/src/index.js) repeats the price maths and
 * the min/max day limits against the same rates at checkout.
 */
import { db } from "../db.server";
import { calculateRentalPrice } from "./pricing";
import { isRangeAvailable } from "./availability";
import { checkRentalLimit } from "./plans";

export interface RentalQuoteInput {
  shop: string;
  productId: string;
  startDate: string;
  endDate: string;
  units?: number | string | null;
  /** Shopify's numeric variant id or the full gid. */
  variantId?: string | null;
}

// Longest range we will even look at. Availability is walked day by day, so
// an unbounded range from an anonymous caller is a way to stall the server.
export const MAX_QUOTE_RANGE_DAYS = 3660;

export type RentalQuote =
  | { ok: false; status: number; body: Record<string, unknown> & { error: string } }
  | {
      ok: true;
      startDate: Date;
      endDate: Date;
      /** Variant gid, or null when the caller did not name one. */
      variantId: string | null;
      body: {
        available: true;
        rentalDays: number;
        units: number;
        unitsAvailable: number;
        totalUnits: number;
        rentalPrice: number;
        depositAmount: number;
        totalDue: number;
        perUnitPrice: number;
        breakdown: string;
        currency: string;
        rentalNotes: string | null;
        minRentalDays: number;
        maxRentalDays: number;
        hasVariants: boolean;
        showBadge: boolean;
      };
    };

export async function quoteRental(input: RentalQuoteInput): Promise<RentalQuote> {
  const { shop, productId } = input;
  const startDate = new Date(input.startDate);
  const endDate = new Date(input.endDate);
  const units = Math.max(1, Math.min(999, parseInt(String(input.units ?? "1"), 10) || 1));

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { ok: false, status: 400, body: { error: "Invalid date format." } };
  }

  if (endDate <= startDate) {
    return { ok: false, status: 400, body: { error: "End date must be after start date." } };
  }

  if (endDate.getTime() - startDate.getTime() > MAX_QUOTE_RANGE_DAYS * 86_400_000) {
    return { ok: false, status: 400, body: { error: "Invalid date format." } };
  }

  const variantParam = input.variantId ? String(input.variantId) : null;
  // Storefront sends Shopify's numeric variant id (e.g. 12345). We accept
  // either that or a full gid:// form. Normalize to gid form for lookup.
  const variantId = variantParam
    ? variantParam.startsWith("gid://")
      ? variantParam
      : `gid://shopify/ProductVariant/${variantParam}`
    : null;

  const product = await db.rentalProduct.findFirst({
    where: { shop, shopifyProductId: productId, isActive: true },
  });

  if (!product) {
    return { ok: false, status: 404, body: { error: "Product not found or not available for rental." } };
  }

  // For multi-variant rentals, the storefront must tell us which variant the
  // customer picked so we can quote the right price and capacity.
  let variantConfig: {
    pricePerDay: number;
    pricePerWeek: number;
    pricePerMonth: number;
    depositAmount: number;
    totalUnits: number;
  } | null = null;
  if (product.hasVariants) {
    if (!variantId) {
      return { ok: false, status: 400, body: { error: "Please choose a variant before booking." } };
    }
    const variant = await db.rentalVariant.findFirst({
      where: { rentalProductId: product.id, shopifyVariantId: variantId },
    });
    if (!variant || !variant.isActive) {
      return { ok: false, status: 404, body: { error: "This variant is not available for rental." } };
    }
    if (variant.pricePerDay <= 0 && variant.depositAmount <= 0) {
      return { ok: false, status: 400, body: { error: "This variant does not have a rental price set yet." } };
    }
    variantConfig = {
      pricePerDay: variant.pricePerDay,
      pricePerWeek: variant.pricePerWeek,
      pricePerMonth: variant.pricePerMonth,
      depositAmount: variant.depositAmount,
      totalUnits: variant.totalUnits,
    };
  }
  const pricing_pricePerDay = variantConfig?.pricePerDay ?? product.pricePerDay;
  const pricing_pricePerWeek = variantConfig?.pricePerWeek ?? product.pricePerWeek;
  const pricing_pricePerMonth = variantConfig?.pricePerMonth ?? product.pricePerMonth;
  const pricing_deposit = variantConfig?.depositAmount ?? product.depositAmount;
  const pricing_totalUnits = variantConfig?.totalUnits ?? product.totalUnits;

  // Respect the merchant's plan limit. When they are at their cap we stop
  // quoting new bookings so the storefront never takes an order the app cannot
  // record. The merchant sees an upgrade prompt in their dashboard.
  const shopConfig = await db.shopConfig.findUnique({ where: { shop } });
  const planLimit = await checkRentalLimit(shop, shopConfig?.planName ?? "free", db);
  if (!planLimit.allowed) {
    return { ok: false, status: 403, body: { error: "Online booking is temporarily unavailable for this item. Please contact us to arrange your rental." } };
  }

  // Check duration limits
  const rentalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  if (rentalDays < product.minRentalDays) {
    return { ok: false, status: 400, body: {
      error: `Minimum rental is ${product.minRentalDays} day${product.minRentalDays !== 1 ? "s" : ""}.`,
      minRentalDays: product.minRentalDays,
    } };
  }

  if (product.maxRentalDays > 0 && rentalDays > product.maxRentalDays) {
    return { ok: false, status: 400, body: {
      error: `Maximum rental is ${product.maxRentalDays} day${product.maxRentalDays !== 1 ? "s" : ""}.`,
      maxRentalDays: product.maxRentalDays,
    } };
  }

  if (units > pricing_totalUnits) {
    return { ok: false, status: 400, body: {
      error: `Only ${pricing_totalUnits} unit${pricing_totalUnits === 1 ? "" : "s"} ${pricing_totalUnits === 1 ? "is" : "are"} available. Please reduce the quantity.`,
      maxUnits: pricing_totalUnits,
    } };
  }

  const { available, unitsAvailable } = await isRangeAvailable(
    shop,
    productId,
    startDate,
    endDate,
    units,
    variantId || undefined,
  );

  if (!available) {
    return { ok: false, status: 409, body: {
      error: unitsAvailable === 0
        ? "These dates are fully booked. Please choose different dates."
        : `Only ${unitsAvailable} unit${unitsAvailable === 1 ? "" : "s"} available for these dates. Reduce quantity or pick different dates.`,
      unitsAvailable,
    } };
  }

  const pricing = calculateRentalPrice({
    startDate,
    endDate,
    pricePerDay: pricing_pricePerDay,
    pricePerWeek: pricing_pricePerWeek,
    pricePerMonth: pricing_pricePerMonth,
    depositAmount: pricing_deposit,
    units,
  });

  return {
    ok: true,
    startDate,
    endDate,
    variantId,
    body: {
    available: true,
    rentalDays: pricing.rentalDays,
    units: pricing.units,
    unitsAvailable,
    totalUnits: pricing_totalUnits,
    rentalPrice: pricing.rentalPrice,
    depositAmount: pricing.depositAmount,
    totalDue: pricing.totalDue,
    perUnitPrice: pricing.perUnitPrice,
    breakdown: pricing.breakdown,
    currency: shopConfig?.currency || "USD",
    rentalNotes: product.rentalNotes || null,
    minRentalDays: product.minRentalDays,
    maxRentalDays: product.maxRentalDays,
    hasVariants: product.hasVariants,
    showBadge: (shopConfig?.planName ?? "free") === "free" || shopConfig?.showPoweredBy === true,
  },
  };
}
