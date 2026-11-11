import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Shopify's webhook signature ourselves: base64 HMAC-SHA256 of the raw
 * body with the app's client secret, compared in constant time.
 *
 * Kept free of app imports so it can be unit tested without env or a database.
 */
export function isValidWebhookHmac(
  rawBody: string,
  hmacHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!hmacHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
