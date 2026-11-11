/**
 * Publishes each rental's rates to app-owned metafields so the Cart Transform
 * Function can price a rental line from MERCHANT data instead of from the
 * cart.
 *
 * Why: the function has no network and no database. The only inputs it gets
 * are the cart (shopper-writable, so never to be trusted for a price) and
 * metafields. The rates therefore have to live in a metafield, and it has to
 * be one a shopper cannot write. `$app:miko_rentals` is an app-reserved
 * namespace: only this app can write it through the Admin API.
 *   https://shopify.dev/docs/apps/build/custom-data/ownership
 *   https://shopify.dev/docs/apps/build/functions/input-queries/metafields-for-input-queries
 *
 * The values are rates, not secrets. Liquid can read any metafield, which is
 * fine: these are the same prices the storefront calendar shows.
 *
 * Shape (version 1), kept tiny because it is repeated on every cart line the
 * function reads:
 *   product:  { v:1, a, hv, d, w, m, dep, min, max }
 *   variant:  { v:1, a, d, w, m, dep }
 *     a   = active (isActive)
 *     hv  = product is priced per variant (hasVariants)
 *     d/w/m = price per day / week / month, dep = deposit
 *     min/max = rental length limits in days (max 0 = no maximum)
 *
 * THE DATABASE STAYS THE SOURCE OF TRUTH. Every place that changes a
 * RentalProduct or RentalVariant must call syncRentalProductConfig afterwards.
 * A daily in-process pass (and every app load) re-syncs the whole shop, so a
 * write that failed here heals itself.
 *
 * extensions/miko-cart-transform/src/index.js is the reader. If this shape
 * changes, bump `v` and teach the function the new version FIRST (it ignores
 * versions it does not know, which means "charge the normal price").
 */
import { db } from "../db.server";
import {
  RENTAL_CONFIG_KEY,
  RENTAL_CONFIG_NAMESPACE,
  buildProductRentalConfig,
  buildVariantRentalConfig,
} from "./rental-config";

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

// metafieldsSet takes at most 25 metafields per call.
// https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet
const METAFIELDS_PER_CALL = 25;

// Shops whose metafield definitions were ensured by this process.
const definitionsEnsured = new Set<string>();

/**
 * Registers the `$app:miko_rentals.config` definition on products and on
 * variants. Idempotent ("TAKEN" = already there).
 *
 * Needed before the first write: on the Miko B2B app, metafieldsSet on a
 * variant in an `$app:` namespace was rejected for every variant until a
 * definition existed (Admin API 2026-04, see ensureVariantPriceMetafieldDef
 * there). Merchants can see the value in the admin but not edit it, and it is
 * not exposed to the Storefront API.
 */
export async function ensureRentalConfigDefinitions(admin: AdminClient, shop: string): Promise<void> {
  if (definitionsEnsured.has(shop)) return;
  let allGood = true;
  for (const ownerType of ["PRODUCT", "PRODUCTVARIANT"]) {
    try {
      const res = await admin.graphql(
        `#graphql
          mutation EnsureRentalConfigDefinition($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
              createdDefinition { id }
              userErrors { field message code }
            }
          }`,
        {
          variables: {
            definition: {
              name: "Rental rates (Miko)",
              namespace: RENTAL_CONFIG_NAMESPACE,
              key: RENTAL_CONFIG_KEY,
              ownerType,
              type: "json",
              description:
                "Set by Miko Product Rentals. The rental rates checkout uses to price a booking. Change rates in the app, not here.",
              access: { admin: "MERCHANT_READ", storefront: "NONE" },
              pin: false,
            },
          },
        },
      );
      const data = (await res.json()) as {
        data?: { metafieldDefinitionCreate?: { userErrors: Array<{ message: string; code: string | null }> } };
      };
      const realErrors = (data.data?.metafieldDefinitionCreate?.userErrors ?? []).filter(
        (e) => e.code !== "TAKEN" && e.code !== "TAKEN_FOR_SAME_NAMESPACE_AND_KEY",
      );
      if (realErrors.length > 0) {
        allGood = false;
        console.error(`[rental-config] definition (${ownerType}) for ${shop}:`, realErrors);
      }
    } catch (err) {
      allGood = false;
      console.error(`[rental-config] definition (${ownerType}) for ${shop} failed:`, err);
    }
  }
  // Only remember success, so a failed attempt is retried on the next sync.
  if (allGood) definitionsEnsured.add(shop);
}

export interface RentalConfigSyncResult {
  ok: boolean;
  written: number;
  errors: string[];
}

async function setConfigMetafields(
  admin: AdminClient,
  entries: Array<{ ownerId: string; value: unknown }>,
): Promise<RentalConfigSyncResult> {
  const result: RentalConfigSyncResult = { ok: true, written: 0, errors: [] };
  for (let i = 0; i < entries.length; i += METAFIELDS_PER_CALL) {
    const chunk = entries.slice(i, i + METAFIELDS_PER_CALL);
    try {
      const res = await admin.graphql(
        `#graphql
          mutation SetRentalConfig($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id }
              userErrors { field message code }
            }
          }`,
        {
          variables: {
            metafields: chunk.map((e) => ({
              ownerId: e.ownerId,
              namespace: RENTAL_CONFIG_NAMESPACE,
              key: RENTAL_CONFIG_KEY,
              type: "json",
              value: JSON.stringify(e.value),
            })),
          },
        },
      );
      const data = (await res.json()) as {
        data?: {
          metafieldsSet?: {
            metafields: Array<{ id: string }> | null;
            userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
          };
        };
        errors?: unknown;
      };
      const userErrors = data.data?.metafieldsSet?.userErrors ?? [];
      const saved = data.data?.metafieldsSet?.metafields?.length ?? 0;
      if (userErrors.length > 0 || data.errors || saved !== chunk.length) {
        // metafieldsSet is atomic: one bad owner (a variant deleted in
        // Shopify, say) rejects the whole call. Report it, do not count it.
        result.ok = false;
        result.errors.push(
          userErrors.map((e) => `${e.code ?? "ERROR"}: ${e.message}`).join("; ") ||
            (data.errors ? JSON.stringify(data.errors).slice(0, 300) : `saved ${saved} of ${chunk.length}`),
        );
      } else {
        result.written += saved;
      }
    } catch (err) {
      result.ok = false;
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}

/**
 * Writes the current rates for one rental product (and its variants, when it
 * is priced per variant) to Shopify. Idempotent. Never throws: a failure is
 * logged and returned so the calling page still saves, and the daily pass
 * retries it.
 */
export async function syncRentalProductConfig(
  admin: AdminClient,
  rentalProductId: string,
): Promise<RentalConfigSyncResult> {
  try {
    const product = await db.rentalProduct.findUnique({
      where: { id: rentalProductId },
      include: { variants: true },
    });
    if (!product) return { ok: true, written: 0, errors: [] };

    await ensureRentalConfigDefinitions(admin, product.shop);

    const entries: Array<{ ownerId: string; value: unknown }> = [
      { ownerId: product.shopifyProductId, value: buildProductRentalConfig(product) },
    ];
    if (product.hasVariants) {
      for (const v of product.variants) {
        entries.push({ ownerId: v.shopifyVariantId, value: buildVariantRentalConfig(v) });
      }
    }

    let result = await setConfigMetafields(admin, entries);
    if (!result.ok && entries.length > 1) {
      // One stale variant must not leave the whole product unpriced at
      // checkout. Retry one owner at a time so the good ones land.
      result = { ok: true, written: 0, errors: [] };
      for (const entry of entries) {
        const one = await setConfigMetafields(admin, [entry]);
        result.written += one.written;
        if (!one.ok) {
          result.ok = false;
          result.errors.push(...one.errors.map((e) => `${entry.ownerId}: ${e}`));
        }
      }
    }
    if (!result.ok) {
      console.error(
        `[rental-config] sync failed for ${product.shop} ${product.shopifyProductId}:`,
        result.errors,
      );
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rental-config] unexpected error syncing ${rentalProductId}:`, err);
    return { ok: false, written: 0, errors: [message] };
  }
}

/**
 * Switches a product's rental pricing off at checkout. Used when the
 * RentalProduct row is deleted, so a cart that still carries rental data for
 * it is charged the normal price instead of rates that no longer exist.
 */
export async function clearRentalProductConfig(
  admin: AdminClient,
  shopifyProductId: string,
): Promise<RentalConfigSyncResult> {
  const result = await setConfigMetafields(admin, [
    {
      ownerId: shopifyProductId,
      value: buildProductRentalConfig({
        isActive: false,
        hasVariants: false,
        pricePerDay: 0,
        pricePerWeek: 0,
        pricePerMonth: 0,
        depositAmount: 0,
        minRentalDays: 1,
        maxRentalDays: 0,
      }),
    },
  ]);
  if (!result.ok) {
    console.error(`[rental-config] clear failed for ${shopifyProductId}:`, result.errors);
  }
  return result;
}

export interface ShopRentalConfigSyncResult {
  shop: string;
  products: number;
  productsSynced: number;
  metafieldsWritten: number;
  errors: string[];
}

/**
 * Re-syncs every rental product of one shop and stamps
 * ShopConfig.rentalConfigSyncedAt when all of them landed. This is the
 * backfill for shops that set their rentals up before the function started
 * reading metafields, and the self-heal for any single write that failed.
 */
export async function syncShopRentalConfig(
  admin: AdminClient,
  shop: string,
): Promise<ShopRentalConfigSyncResult> {
  const products = await db.rentalProduct.findMany({ where: { shop }, select: { id: true } });
  const summary: ShopRentalConfigSyncResult = {
    shop,
    products: products.length,
    productsSynced: 0,
    metafieldsWritten: 0,
    errors: [],
  };
  for (const p of products) {
    const r = await syncRentalProductConfig(admin, p.id);
    summary.metafieldsWritten += r.written;
    if (r.ok) summary.productsSynced++;
    else summary.errors.push(...r.errors);
  }
  if (summary.productsSynced === summary.products) {
    await db.shopConfig
      .updateMany({ where: { shop }, data: { rentalConfigSyncedAt: new Date() } })
      .catch(() => {});
  }
  return summary;
}

/**
 * Re-syncs every installed shop that has at least one rental product. Shops
 * are done one after another so a large fleet never bursts the Admin API.
 * `getAdmin` is injected (unauthenticated.admin in production) so this module
 * does not import shopify.server and stays testable.
 */
export async function syncAllShopsRentalConfig(
  getAdmin: (shop: string) => Promise<AdminClient>,
): Promise<{ shops: number; shopsFullySynced: number; results: ShopRentalConfigSyncResult[] }> {
  const rows = await db.rentalProduct.findMany({
    where: { shopConfig: { uninstalledAt: null } },
    select: { shop: true },
    distinct: ["shop"],
  });
  const results: ShopRentalConfigSyncResult[] = [];
  for (const { shop } of rows) {
    try {
      const admin = await getAdmin(shop);
      results.push(await syncShopRentalConfig(admin, shop));
    } catch (err) {
      // No usable offline session (for example the shop uninstalled and the
      // webhook was missed). The function is not running there either.
      results.push({
        shop,
        products: 0,
        productsSynced: 0,
        metafieldsWritten: 0,
        errors: [`no admin session: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }
  return {
    shops: results.length,
    shopsFullySynced: results.filter((r) => r.errors.length === 0).length,
    results,
  };
}
