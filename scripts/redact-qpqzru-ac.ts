/* One-off recovery for qpqzru-ac.myshopify.com (uninstalled 28 Sep 2026 04:37 UTC).

   Its app/uninstalled and shop/redact webhooks both failed 9/9 attempts with a
   silent 500 (expired offline token refresh inside authenticate.webhook, see
   Apps/_reports/webhook-errors-2026-10-01.md cause #2), so neither the
   uninstall cleanup nor the GDPR shop redaction ever ran, and Shopify will not
   redeliver. This script runs exactly what those two handlers do:

     1. app/uninstalled: ShopConfig.subscriptionCancelledAt = now, planName = "free";
        delete the shop's Session rows. (The CartTransform delete needs a live
        token and is skipped: the store is uninstalled, so it is gone with it.
        The "sorry to see you go" email is NOT sent: it is three days late and
        is a message on our behalf.)
     2. shop/redact: redactShop(db, shop) from app/utils/gdpr.server.ts, one
        transaction deleting EmailLog, EmailTemplate, RentalBooking,
        RentalVariant, RentalProduct, BlockedDate, ShopConfig, Session.

   DRY RUN by default: prints the row count per table that would be deleted and
   changes nothing. Pass --apply to execute. Every run (dry or apply) appends
   one JSON audit line (shop, mode, counts, timestamp; no customer data) to
   $AUDIT_LOG, default ./redact-qpqzru-ac.audit.log, and prints it.

   Guard: refuses to run if the shop looks REINSTALLED (any Session whose
   expiry is after the uninstall time), because then this would wipe a live
   merchant.

   Run from the Rentals app root AFTER the webhook fix is deployed:

     export DATABASE_PUBLIC_URL="$(railway variables -p <project> -s Postgres -e production --json | jq -r .DATABASE_PUBLIC_URL)"
     railway run -p <project> -s miko-product-rentals -e production -- \
       npx vite-node -c scripts/vite-node.config.mjs scripts/redact-qpqzru-ac.ts            # dry run
     ... same command ... scripts/redact-qpqzru-ac.ts --apply                   # execute */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const SHOP = "qpqzru-ac.myshopify.com";
const UNINSTALLED_AT = new Date("2026-09-28T04:37:00Z");
const APPLY = process.argv.includes("--apply");
const AUDIT_LOG = process.env.AUDIT_LOG || resolve(process.cwd(), "redact-qpqzru-ac.audit.log");

async function main() {
  // Railway's internal DATABASE_URL is not reachable from a laptop; prefer the
  // public URL when provided. Must be set before the Prisma client loads.
  if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

  const { db } = await import("../app/db.server");
  const { redactShop } = await import("../app/utils/gdpr.server");

  const sessions = await db.session.findMany({
    where: { shop: SHOP },
    select: { id: true, isOnline: true, expires: true },
  });
  const reinstalled = sessions.filter((s) => s.expires && s.expires > UNINSTALLED_AT);
  if (reinstalled.length > 0) {
    console.error(
      `[redact] ABORT: ${reinstalled.length} session(s) for ${SHOP} expire after the uninstall ` +
        `(${UNINSTALLED_AT.toISOString()}), so the shop may have reinstalled. Nothing changed.`,
    );
    process.exit(2);
  }

  const before = {
    emailLogs: await db.emailLog.count({ where: { shop: SHOP } }),
    emailTemplates: await db.emailTemplate.count({ where: { shop: SHOP } }),
    bookings: await db.rentalBooking.count({ where: { shop: SHOP } }),
    variants: await db.rentalVariant.count({ where: { shop: SHOP } }),
    products: await db.rentalProduct.count({ where: { shop: SHOP } }),
    blockedDates: await db.blockedDate.count({ where: { shop: SHOP } }),
    shopConfigs: await db.shopConfig.count({ where: { shop: SHOP } }),
    sessions: sessions.length,
  };
  const cfg = await db.shopConfig.findUnique({
    where: { shop: SHOP },
    select: { planName: true, subscriptionCancelledAt: true },
  });

  console.log(`[redact] ${APPLY ? "APPLY" : "DRY RUN"} for ${SHOP}`);
  console.log(`[redact] sessions: ${sessions.map((s) => `${s.id} online=${s.isOnline} expires=${s.expires?.toISOString() ?? "null"}`).join(", ") || "none"}`);
  console.log(`[redact] ShopConfig: ${cfg ? `planName=${cfg.planName} subscriptionCancelledAt=${cfg.subscriptionCancelledAt?.toISOString() ?? "NULL"}` : "none"}`);
  console.log(`[redact] step 1 (app/uninstalled): would set subscriptionCancelledAt=now, planName=free on ${before.shopConfigs} ShopConfig row(s); delete ${before.sessions} Session row(s)`);
  console.log(`[redact] step 2 (shop/redact) rows that would be deleted per table: ${JSON.stringify(before)}`);

  let uninstall: { shopConfigsUpdated: number; sessionsDeleted: number } | null = null;
  let redacted: Record<string, number> | null = null;

  if (APPLY) {
    const upd = await db.shopConfig.updateMany({
      where: { shop: SHOP },
      data: { subscriptionCancelledAt: new Date(), planName: "free" },
    });
    const del = await db.session.deleteMany({ where: { shop: SHOP } });
    uninstall = { shopConfigsUpdated: upd.count, sessionsDeleted: del.count };
    console.log(`[redact] step 1 done: ${JSON.stringify(uninstall)}`);

    redacted = await redactShop(db, SHOP);
    console.log(`[redact] step 2 done, deleted: ${JSON.stringify(redacted)}`);
  }

  const audit = {
    at: new Date().toISOString(),
    script: "scripts/redact-qpqzru-ac.ts",
    shop: SHOP,
    mode: APPLY ? "apply" : "dry-run",
    reason: "app/uninstalled + shop/redact webhooks failed 9/9 on 28-30 Sep 2026 (expired offline token refresh)",
    before,
    uninstall,
    redacted,
  };
  appendFileSync(AUDIT_LOG, JSON.stringify(audit) + "\n");
  console.log(`[redact] audit line appended to ${AUDIT_LOG}`);
  console.log(JSON.stringify(audit));

  await db.$disconnect();
}

main().catch((err) => {
  console.error("[redact] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
