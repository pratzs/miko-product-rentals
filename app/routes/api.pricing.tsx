import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { quoteRental } from "../utils/rental-quote.server";

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

  const quote = await quoteRental({
    shop,
    productId,
    startDate: startParam,
    endDate: endParam,
    units: url.searchParams.get("units"),
    variantId: url.searchParams.get("variantId"),
  });

  if (!quote.ok) {
    return json(quote.body, { status: quote.status, headers: corsHeaders(request) });
  }
  return json(quote.body, { headers: corsHeaders(request) });
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
