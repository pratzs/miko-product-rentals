import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { db } from "../db.server";

/**
 * Tiny public endpoint that the Display Rules App Embed pings the FIRST time
 * it loads on a storefront. We stamp ShopConfig.displayRulesSeenAt so the
 * dashboard onboarding can auto-tick the "enable the embed" step without the
 * merchant having to confirm manually.
 *
 * The embed uses sessionStorage to make sure this only fires once per browser
 * session — multiple page loads in the same session don't hit us.
 *
 * Query params: shop=mystore.myshopify.com
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return json({ ok: false }, { status: 400, headers: corsHeaders(request) });
  }

  // Only stamp the first time. After that, idempotent no-op.
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { displayRulesSeenAt: true },
  });
  if (config && !config.displayRulesSeenAt) {
    await db.shopConfig
      .update({ where: { shop }, data: { displayRulesSeenAt: new Date() } })
      .catch(() => {});
  }

  return new Response(null, { status: 204, headers: corsHeaders(request) });
};

export const action = async ({ request }: { request: Request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return json({ error: "Method not allowed" }, { status: 405 });
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
