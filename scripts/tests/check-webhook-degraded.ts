// End-to-end check of authenticateWebhookSafe's degraded branch.
// A request whose body read fails, or that is unsigned, must be rejected;
// a genuinely signed delivery that the library cannot finish (no usable
// token / database down) must still reach the handler with session undefined.
// Run: npx tsx scripts/tests/check-webhook-degraded.ts
import { createHmac } from "node:crypto";

process.env.SHOPIFY_API_KEY ||= "test_key";
process.env.SHOPIFY_API_SECRET = "shpss_test_secret";
process.env.SHOPIFY_APP_URL ||= "https://example.test";
process.env.SCOPES ||= "read_products";
// Nothing listens here, so every session lookup fails: the same shape as an
// expired token on an uninstalled shop (a non-Response error after the HMAC).
process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:9/none?connect_timeout=1";

const url = "https://example.test/webhooks/shop/redact";
const body = JSON.stringify({ shop_id: 1, shop_domain: "victim.myshopify.com" });
const sign = (b: string) =>
  createHmac("sha256", process.env.SHOPIFY_API_SECRET!).update(b, "utf8").digest("base64");
const headers = (hmac?: string) => {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "x-shopify-shop-domain": "victim.myshopify.com",
    "x-shopify-topic": "shop/redact",
    "x-shopify-api-version": "2026-04",
    "x-shopify-webhook-id": "w1",
  };
  if (hmac !== undefined) h["x-shopify-hmac-sha256"] = hmac;
  return h;
};
const brokenBody = () =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"shop_id":'));
      c.error(new Error("aborted"));
    },
  });

async function outcome(req: Request, fn: (r: Request) => Promise<any>) {
  try {
    const ctx = await fn(req);
    return `context:${ctx.shop}:${ctx.session === undefined ? "nosession" : "session"}:${JSON.stringify(ctx.payload)}`;
  } catch (e) {
    return e instanceof Response ? `response:${e.status}` : `error:${(e as Error).message}`;
  }
}

async function main() {
  const { authenticateWebhookSafe } = await import("../../app/webhook-auth.server");
  const results: [string, string, (s: string) => boolean][] = [
    [
      "forged, body read fails, no signature",
      await outcome(new Request(url, { method: "POST", headers: headers(), body: brokenBody(), duplex: "half" } as any), authenticateWebhookSafe),
      (s) => s.startsWith("response:4"),
    ],
    [
      "forged, body read fails, signature of the full body",
      await outcome(new Request(url, { method: "POST", headers: headers(sign(body)), body: brokenBody(), duplex: "half" } as any), authenticateWebhookSafe),
      (s) => s.startsWith("response:4"),
    ],
    [
      "unsigned complete body",
      await outcome(new Request(url, { method: "POST", headers: headers(), body }), authenticateWebhookSafe),
      (s) => s.startsWith("response:4"),
    ],
    [
      "wrong signature",
      await outcome(new Request(url, { method: "POST", headers: headers(sign("{}")), body }), authenticateWebhookSafe),
      (s) => s === "response:401",
    ],
    [
      "genuine signed delivery, token/database unusable",
      await outcome(new Request(url, { method: "POST", headers: headers(sign(body)), body }), authenticateWebhookSafe),
      (s) => s === `context:victim.myshopify.com:nosession:${body}`,
    ],
  ];
  let failed = 0;
  for (const [name, got, ok] of results) {
    const pass = ok(got);
    if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name} -> ${got}`);
  }
  process.exit(failed ? 1 : 0);
}
main();
