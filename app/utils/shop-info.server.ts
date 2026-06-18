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
