/**
 * Fetches the shop's real display name from Shopify (e.g. "Kiwi Surf Gear")
 * and caches it on ShopConfig.shopName. We use it as the email header
 * fallback when the merchant hasn't uploaded a logo or set a brand name,
 * so customers never see "app-testing-abc.myshopify.com" at the top of
 * their booking emails.
 */
import { db } from "~/db.server";

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export async function ensureShopName(admin: AdminClient, shop: string): Promise<void> {
  try {
    const existing = await db.shopConfig.findUnique({
      where: { shop },
      select: { shopName: true },
    });
    if (existing?.shopName) return;

    const res = await admin.graphql(`#graphql
      query ShopName { shop { name } }
    `);
    const data = (await res.json()) as { data?: { shop?: { name: string } } };
    const name = data.data?.shop?.name?.trim();
    if (!name) return;

    await db.shopConfig
      .updateMany({ where: { shop }, data: { shopName: name } })
      .catch(() => {});
  } catch (err) {
    console.error(`[shop-info] failed to fetch shop name for ${shop}:`, err);
  }
}

/**
 * Fetches the shop's real base currency from Shopify and seeds it onto
 * ShopConfig.currency on install. Without this, currency defaults to "USD"
 * for every shop until a merchant happens to visit Settings and change it,
 * so a NZD/GBP/EUR shop would show every rental price, deposit, and email
 * amount labeled with the wrong currency symbol until then. Only seeds once
 * (skips if the merchant has already set a non-default value) so it never
 * overwrites an explicit choice.
 */
export async function ensureShopCurrency(admin: AdminClient, shop: string): Promise<void> {
  try {
    const existing = await db.shopConfig.findUnique({
      where: { shop },
      select: { currency: true },
    });
    if (existing?.currency && existing.currency !== "USD") return;

    const res = await admin.graphql(`#graphql
      query ShopCurrency { shop { currencyCode } }
    `);
    const data = (await res.json()) as { data?: { shop?: { currencyCode: string } } };
    const currencyCode = data.data?.shop?.currencyCode?.trim();
    if (!currencyCode) return;

    await db.shopConfig
      .updateMany({ where: { shop }, data: { currency: currencyCode } })
      .catch(() => {});
  } catch (err) {
    console.error(`[shop-info] failed to fetch shop currency for ${shop}:`, err);
  }
}

/**
 * Humanises a myshopify subdomain as a last-resort fallback. Strips the
 * suffix and converts dashes to spaces with title casing - so
 * "kiwi-surf-gear.myshopify.com" reads as "Kiwi Surf Gear".
 */
export function humanizeShopHandle(shop: string): string {
  const handle = shop.replace(/\.myshopify\.com$/i, "");
  return handle
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
