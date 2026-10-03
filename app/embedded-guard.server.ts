/**
 * Malformed embedded params must never crash a page with a 500.
 *
 * Shopify's App Store review runs automated probes (e.g. shop=cross-shop-missing-*.myshopify.com
 * with host=9998162819999999999). The library base64-decodes `host` and calls new URL() on the
 * result, which throws "TypeError: Invalid URL" and every /app page answered 500 (flagged in
 * review, 2 Oct 2026, requirement 2.1.3). A request whose shop or host is not a genuine Shopify
 * value is a bad request: answer 400 before the library sees it. Genuine admin values pass through
 * untouched, so normal merchant sessions are unaffected.
 */
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const HOST_RE = /^(admin\.shopify\.com\/store\/[a-z0-9][a-z0-9-]*|[a-z0-9][a-z0-9-]*\.myshopify\.com\/admin)\/?$/i;

function decodeHost(host: string): string | null {
  try {
    const b64 = host.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function rejectMalformedEmbeddedParams(request: Request): void {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");
  const bad =
    (shop !== null && !SHOP_RE.test(shop)) ||
    (host !== null && !HOST_RE.test(decodeHost(host) ?? ""));
  if (bad) {
    throw new Response("Bad request: invalid shop or host parameter.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

