// The degraded webhook path must never run for an unsigned or forged request.
// Run: npx tsx scripts/tests/check-webhook-hmac.ts
import { createHmac } from "node:crypto";
import { isValidWebhookHmac } from "../../app/webhook-hmac.server";

const secret = "shpss_test_secret";
const body = JSON.stringify({ shop_id: 1, shop_domain: "victim.myshopify.com" });
const sign = (b: string, s = secret) => createHmac("sha256", s).update(b, "utf8").digest("base64");

const cases: [string, boolean, boolean][] = [
  ["genuine signature", isValidWebhookHmac(body, sign(body), secret), true],
  ["genuine signature, unicode body", isValidWebhookHmac('{"n":"Zo\u00eb \u2603"}', sign('{"n":"Zo\u00eb \u2603"}'), secret), true],
  ["empty body, genuine signature", isValidWebhookHmac("", sign(""), secret), true],
  ["missing header", isValidWebhookHmac(body, null, secret), false],
  ["empty header", isValidWebhookHmac(body, "", secret), false],
  ["garbage header", isValidWebhookHmac(body, "not-a-signature", secret), false],
  ["signature of a different body", isValidWebhookHmac(body, sign("{}"), secret), false],
  ["signature made with another secret", isValidWebhookHmac(body, sign(body, "other"), secret), false],
  ["truncated body (forged shop/redact)", isValidWebhookHmac("", sign(body), secret), false],
  ["missing app secret", isValidWebhookHmac(body, sign(body), ""), false],
  ["hex instead of base64", isValidWebhookHmac(body, createHmac("sha256", secret).update(body).digest("hex"), secret), false],
];

let failed = 0;
for (const [name, got, want] of cases) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
if (failed) {
  console.error(`${failed} webhook HMAC check(s) failed`);
  process.exit(1);
}
console.log(`webhook HMAC: ${cases.length} checks passed`);
