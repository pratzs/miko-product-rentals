import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "../db.server";
import { calculateRentalPrice } from "../utils/pricing";
import { isRangeAvailable } from "../utils/availability";
import { checkRentalLimit } from "../utils/plans";

/**
 * Public endpoint - no Shopify auth required.
 * Called from the storefront to calculate rental price for a chosen date range.
 *
 * Query params:
 *   shop          - myshopify domain
 *   productId     - Shopify product GID
 *   startDate     - ISO date string
 *   endDate       - ISO date string
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const productId = url.searchParams.get("productId");
  const startParam = url.searchParams.get("startDate");
  const endParam = url.searchParams.get("endDate");

  if (!shop || !productId || !startParam || !endParam) {
    return json(
      { error: "Missing required parameters: shop, productId, startDate, endDate" },
      { status: 400, headers: corsHeaders(request) }
    );
  }

  const startDate = new Date(startParam);
  const endDate = new Date(endParam);
  const unitsParam = url.searchParams.get("units");
  const units = Math.max(1, Math.min(999, parseInt(unitsParam || "1", 10) || 1));

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return json({ error: "Invalid date format." }, { status: 400, headers: corsHeaders(request) });
  }

  if (endDate <= startDate) {
    return json({ error: "End date must be after start date." }, { status: 400, headers: corsHeaders(request) });
  }

  const product = await db.rentalProduct.findFirst({
    where: { shop, shopifyProductId: productId, isActive: true },
  });

  if (!product) {
    return json({ error: "Product not found or not available for rental." }, {
      status: 404,
      headers: corsHeaders(request),
    });
  }

  // Respect the merchant's plan limit. When they are at their cap we stop
  // quoting new bookings so the storefront never takes an order the app cannot
  // record. The merchant sees an upgrade prompt in their dashboard.
  const shopConfig = await db.shopConfig.findUnique({ where: { shop } });
  const planLimit = await checkRentalLimit(shop, shopConfig?.planName ?? "free", db);
  if (!planLimit.allowed) {
    return json({ error: "Online booking is temporarily unavailable for this item. Please contact us to arrange your rental." }, {
      status: 403,
      headers: corsHeaders(request),
    });
  }

  // Check duration limits
  const rentalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  if (rentalDays < product.minRentalDays) {
    return json({
      error: `Minimum rental is ${product.minRentalDays} day${product.minRentalDays !== 1 ? "s" : ""}.`,
      minRentalDays: product.minRentalDays,
    }, { status: 400, headers: corsHeaders(request) });
  }

  if (product.maxRentalDays > 0 && rentalDays > product.maxRentalDays) {
    return json({
      error: `Maximum rental is ${product.maxRentalDays} day${product.maxRentalDays !== 1 ? "s" : ""}.`,
      maxRentalDays: product.maxRentalDays,
    }, { status: 400, headers: corsHeaders(request) });
  }

  if (units > product.totalUnits) {
    return json({
      error: `Only ${product.totalUnits} unit${product.totalUnits === 1 ? "" : "s"} of this product ${product.totalUnits === 1 ? "is" : "are"} available. Please reduce the quantity.`,
      maxUnits: product.totalUnits,
    }, { status: 400, headers: corsHeaders(request) });
  }

  const { available, unitsAvailable } = await isRangeAvailable(
    shop,
    productId,
    startDate,
    endDate,
    units,
  );

  if (!available) {
    return json({
      error: unitsAvailable === 0
        ? "These dates are fully booked. Please choose different dates."
        : `Only ${unitsAvailable} unit${unitsAvailable === 1 ? "" : "s"} available for these dates. Reduce quantity or pick different dates.`,
      unitsAvailable,
    }, { status: 409, headers: corsHeaders(request) });
  }

  const pricing = calculateRentalPrice({
    startDate,
    endDate,
    pricePerDay: product.pricePerDay,
    pricePerWeek: product.pricePerWeek,
    pricePerMonth: product.pricePerMonth,
    depositAmount: product.depositAmount,
    units,
  });

  return json({
    available: true,
    rentalDays: pricing.rentalDays,
    units: pricing.units,
    unitsAvailable,
    totalUnits: product.totalUnits,
    rentalPrice: pricing.rentalPrice,
    depositAmount: pricing.depositAmount,
    totalDue: pricing.totalDue,
    perUnitPrice: pricing.perUnitPrice,
    breakdown: pricing.breakdown,
    currency: shopConfig?.currency || "USD",
    rentalNotes: product.rentalNotes || null,
    minRentalDays: product.minRentalDays,
    maxRentalDays: product.maxRentalDays,
    showBadge: (shopConfig?.planName ?? "free") === "free" || shopConfig?.showPoweredBy === true,
  }, { headers: corsHeaders(request) });
};

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

export const action = async ({ request }: { request: Request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return json({ error: "Method not allowed" }, { status: 405 });
};
