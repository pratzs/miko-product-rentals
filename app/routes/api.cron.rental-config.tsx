import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createHash, timingSafeEqual } from "node:crypto";
import { unauthenticated } from "../shopify.server";
import { syncAllShopsRentalConfig } from "../utils/rental-config-metafields.server";

/**
 * On-demand run of the rental-config sync for every installed shop, with a
 * per-shop report. Use it straight after a server deploy to confirm every
 * shop's rental rates are in Shopify BEFORE the Cart Transform Function that
 * prices from them is deployed:
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://<app-host>/api/cron/rental-config
 *
 * `shopsFullySynced` must equal `shops`, and every result must have an empty
 * `errors` list. The same pass also runs by itself (see
 * app/rental-config-scheduler.server.ts).
 *
 * Fails CLOSED: with no CRON_SECRET configured the endpoint is off.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return json({ error: "Not configured" }, { status: 503 });
  }
  const given = request.headers.get("Authorization") || "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const report = await syncAllShopsRentalConfig(
    async (shop) => (await unauthenticated.admin(shop)).admin,
  );
  return json({ ok: report.shopsFullySynced === report.shops, ...report });
};
