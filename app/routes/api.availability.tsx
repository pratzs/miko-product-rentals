import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "../db.server";
import { getUnavailableDates } from "../utils/availability";
import { addMonths } from "date-fns";

/**
 * Public endpoint - no Shopify auth required.
 * Called from the storefront theme extension to fetch unavailable dates.
 *
 * Query params:
 *   shop          - myshopify domain e.g. example.myshopify.com
 *   productId     - Shopify product GID e.g. gid://shopify/Product/123
 *   from          - ISO date string (defaults to today)
 *   to            - ISO date string (defaults to 3 months from today)
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const productId = url.searchParams.get("productId");

  if (!shop || !productId) {
    return json({ error: "Missing required parameters: shop and productId" }, {
      status: 400,
      headers: corsHeaders(request),
    });
  }

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const unitsParam = url.searchParams.get("units");
  const variantParam = url.searchParams.get("variantId");
  const variantId = variantParam
    ? variantParam.startsWith("gid://")
      ? variantParam
      : `gid://shopify/ProductVariant/${variantParam}`
    : undefined;
  const from = fromParam ? new Date(fromParam) : new Date();
  const to = toParam ? new Date(toParam) : addMonths(new Date(), 3);
  const units = Math.max(1, Math.min(999, parseInt(unitsParam || "1", 10) || 1));

  // Verify the shop exists in our database
  const config = await db.shopConfig.findUnique({ where: { shop } });
  if (!config) {
    return json({ unavailableDates: [] }, { headers: corsHeaders(request) });
  }

  // Record the first time the storefront calendar reaches us, so onboarding
  // can confirm the theme block is live without the merchant telling us.
  if (!config.widgetSeenAt) {
    await db.shopConfig
      .update({ where: { shop }, data: { widgetSeenAt: new Date() } })
      .catch(() => {});
  }

  try {
    const [unavailableDates, productRow] = await Promise.all([
      getUnavailableDates(shop, productId, from, to, units, variantId),
      db.rentalProduct.findUnique({
        where: { shop_shopifyProductId: { shop, shopifyProductId: productId } },
        select: { totalUnits: true, hasVariants: true, id: true },
      }),
    ]);
    // For variant-specific lookups, surface the variant's own unit count so
    // the widget's quantity selector caps correctly.
    let totalUnits = productRow?.totalUnits ?? 1;
    if (productRow?.hasVariants && variantId) {
      const v = await db.rentalVariant.findFirst({
        where: { rentalProductId: productRow.id, shopifyVariantId: variantId },
        select: { totalUnits: true },
      });
      if (v) totalUnits = v.totalUnits;
    }
    const isFree = (config.planName ?? "free") === "free";
    const showBadge = isFree || config.showPoweredBy === true;
    return json(
      {
        unavailableDates,
        totalUnits,
        hasVariants: productRow?.hasVariants ?? false,
        showBadge,
      },
      { headers: corsHeaders(request) },
    );
  } catch {
    return json({ error: "Failed to load availability." }, {
      status: 500,
      headers: corsHeaders(request),
    });
  }
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

// Handle CORS preflight requests
export const action = async ({ request }: { request: Request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return json({ error: "Method not allowed" }, { status: 405 });
};
