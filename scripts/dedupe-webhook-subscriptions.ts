/* One-off: delete the duplicate SHOP-level webhook subscriptions that the old
   `webhooks: {...}` block + `shopify.registerWebhooks({ session })` in afterAuth
   created. The toml (app-level) subscriptions are the single source of truth
   now; app-level subscriptions do not appear in the webhookSubscriptions query,
   so this can never touch them.

   Safety:
   - DRY RUN by default. Nothing is deleted unless --apply is passed.
   - Only deletes subscriptions whose uri starts with THIS app's
     application_url (read from shopify.app.toml). Anything else on the shop
     (another app, a merchant's own webhook) is listed as "kept".
   - Admin access only via unauthenticated.admin(shop), never the raw stored
     token, so expiring offline tokens are refreshed by the library.
   - A shop whose token cannot be loaded or refreshed (uninstalled) is skipped
     and counted, never retried in a loop.

   Run from the app root, AFTER the code fix and `shopify app deploy` are live
   (otherwise the next install re-creates the duplicates):

     export DATABASE_PUBLIC_URL="$(railway variables -p <project> -s Postgres -e production --json | jq -r .DATABASE_PUBLIC_URL)"
     railway run -p <project> -s <app-service> -e production -- \
       npx vite-node -c scripts/vite-node.config.mjs scripts/dedupe-webhook-subscriptions.ts          # dry run
     ... same command ... scripts/dedupe-webhook-subscriptions.ts --apply                 # delete

   Optional: --shop=<x.myshopify.com> limits the run to one shop (use it as a canary). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const APPLY = process.argv.includes("--apply");
const ONLY_SHOP = process.argv.find((a) => a.startsWith("--shop="))?.slice("--shop=".length);

function applicationUrl(): string {
  const toml = readFileSync(resolve(process.cwd(), "shopify.app.toml"), "utf8");
  const m = toml.match(/^\s*application_url\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("application_url not found in shopify.app.toml (run from the app root)");
  return m[1].replace(/\/+$/, "");
}

type Sub = { id: string; topic: string; uri: string };

const LIST = `#graphql
  query Subs($after: String) {
    webhookSubscriptions(first: 100, after: $after) {
      nodes { id topic uri }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const DELETE = `#graphql
  mutation Del($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }`;

async function main() {
  // Railway's internal DATABASE_URL is not reachable from a laptop; prefer the
  // public URL when provided. Must be set before the Prisma client loads.
  if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

  const appUrl = applicationUrl();
  const { unauthenticated } = await import("../app/shopify.server");
  const dbModule = (await import("../app/db.server")) as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = (dbModule.default ?? dbModule.db) as any;

  const rows: Array<{ shop: string }> = await prisma.session.findMany({
    where: { isOnline: false, ...(ONLY_SHOP ? { shop: ONLY_SHOP } : {}) },
    select: { shop: true },
    distinct: ["shop"],
    orderBy: { shop: "asc" },
  });

  console.log(`[dedupe] ${APPLY ? "APPLY" : "DRY RUN"} app_url=${appUrl} shops=${rows.length}`);

  const totals = { shops: rows.length, noAccess: 0, listFailed: 0, matched: 0, deleted: 0, deleteFailed: 0, kept: 0 };

  for (const { shop } of rows) {
    let admin;
    try {
      ({ admin } = await unauthenticated.admin(shop));
    } catch (err) {
      totals.noAccess += 1;
      console.log(`[dedupe] ${shop}: no admin access (uninstalled or token refresh failed), skipped`);
      continue;
    }

    const subs: Sub[] = [];
    try {
      let after: string | null = null;
      do {
        const res = await admin.graphql(LIST, { variables: { after } });
        const body = (await res.json()) as {
          data?: { webhookSubscriptions?: { nodes: Sub[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
        };
        const conn = body.data?.webhookSubscriptions;
        if (!conn) throw new Error("no webhookSubscriptions in response");
        subs.push(...conn.nodes);
        after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      } while (after);
    } catch (err) {
      totals.listFailed += 1;
      console.log(`[dedupe] ${shop}: list failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const ours = subs.filter((s) => s.uri === appUrl || s.uri.startsWith(appUrl + "/"));
    const others = subs.length - ours.length;
    totals.kept += others;
    totals.matched += ours.length;
    console.log(`[dedupe] ${shop}: ${subs.length} shop-level subscription(s), ${ours.length} ours, ${others} kept`);

    for (const s of ours) {
      if (!APPLY) {
        console.log(`[dedupe]   would delete ${s.id} ${s.topic} ${s.uri}`);
        continue;
      }
      try {
        const res = await admin.graphql(DELETE, { variables: { id: s.id } });
        const body = (await res.json()) as {
          data?: { webhookSubscriptionDelete?: { deletedWebhookSubscriptionId: string | null; userErrors: Array<{ message: string }> } };
        };
        const r = body.data?.webhookSubscriptionDelete;
        if (r?.deletedWebhookSubscriptionId) {
          totals.deleted += 1;
          console.log(`[dedupe]   deleted ${s.id} ${s.topic}`);
        } else {
          totals.deleteFailed += 1;
          console.log(`[dedupe]   FAILED ${s.id} ${s.topic}: ${(r?.userErrors ?? []).map((e) => e.message).join("; ") || "no result"}`);
        }
      } catch (err) {
        totals.deleteFailed += 1;
        console.log(`[dedupe]   FAILED ${s.id} ${s.topic}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`[dedupe] SUMMARY ${JSON.stringify({ mode: APPLY ? "apply" : "dry-run", ...totals })}`);
  await prisma.$disconnect?.();
}

main().catch((err) => {
  console.error("[dedupe] fatal:", err);
  process.exit(1);
});
