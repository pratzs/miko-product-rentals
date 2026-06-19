/**
 * Syncs the Shopify variant list onto our RentalVariant table for a given
 * rental product. Idempotent: safe to call on every save / activate.
 *
 * Behaviour:
 *  - For products with only one variant named "Default Title", we set
 *    hasVariants=false on the parent and create no RentalVariant rows.
 *    The widget treats these as single-variant rentals just like before.
 *  - For products with 2+ variants (or any single variant whose title is
 *    something other than "Default Title", which means the merchant has set
 *    up at least one variant option), we set hasVariants=true, create a
 *    RentalVariant row for each, and seed its pricing/units from the
 *    parent RentalProduct's existing fields so the merchant has a sensible
 *    starting point they can adjust per-variant.
 *  - Variants that have been deleted in Shopify are removed from our table
 *    so stale rows don't show up in the admin or block availability.
 */
import { db } from "../db.server";

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

interface ShopifyVariant {
  id: string;
  title: string;
}

export async function syncRentalProductVariants(
  admin: AdminClient,
  rentalProductId: string,
): Promise<{ hasVariants: boolean; variants: ShopifyVariant[] }> {
  const product = await db.rentalProduct.findUnique({ where: { id: rentalProductId } });
  if (!product) return { hasVariants: false, variants: [] };

  const res = await admin.graphql(
    `#graphql
      query ProductVariantsForRental($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            nodes { id title }
          }
        }
      }`,
    { variables: { id: product.shopifyProductId } },
  );
  const data = (await res.json()) as {
    data?: { product?: { variants: { nodes: Array<ShopifyVariant> } } };
  };
  const variants = data.data?.product?.variants?.nodes ?? [];

  // A single "Default Title" variant means the product has no real variants
  // configured in Shopify. We treat that as a single-variant rental and
  // skip the variant table entirely.
  const isSingleDefault =
    variants.length === 1 && variants[0].title === "Default Title";
  const hasVariants = !isSingleDefault && variants.length > 0;

  if (!hasVariants) {
    // Clean up any RentalVariant rows that may have been created earlier (in
    // case the merchant removed variants in Shopify).
    await db.rentalVariant.deleteMany({ where: { rentalProductId } });
    await db.rentalProduct.update({
      where: { id: rentalProductId },
      data: { hasVariants: false },
    });
    return { hasVariants: false, variants };
  }

  const incomingIds = new Set(variants.map((v) => v.id));
  const existing = await db.rentalVariant.findMany({ where: { rentalProductId } });
  const existingByVariantId = new Map(existing.map((v) => [v.shopifyVariantId, v]));

  // Delete RentalVariants that no longer exist in Shopify.
  const toDelete = existing.filter((v) => !incomingIds.has(v.shopifyVariantId));
  if (toDelete.length > 0) {
    await db.rentalVariant.deleteMany({
      where: { id: { in: toDelete.map((v) => v.id) } },
    });
  }

  // Upsert each Shopify variant. New variants inherit pricing from the
  // parent RentalProduct so the merchant sees reasonable defaults.
  for (const sv of variants) {
    const ex = existingByVariantId.get(sv.id);
    if (ex) {
      // Keep merchant-entered config, only refresh the title.
      if (ex.shopifyVariantTitle !== sv.title) {
        await db.rentalVariant.update({
          where: { id: ex.id },
          data: { shopifyVariantTitle: sv.title },
        });
      }
    } else {
      await db.rentalVariant.create({
        data: {
          shop: product.shop,
          rentalProductId: product.id,
          shopifyVariantId: sv.id,
          shopifyVariantTitle: sv.title,
          totalUnits: product.totalUnits,
          pricePerDay: product.pricePerDay,
          pricePerWeek: product.pricePerWeek,
          pricePerMonth: product.pricePerMonth,
          depositAmount: product.depositAmount,
          isActive: true,
        },
      });
    }
  }

  await db.rentalProduct.update({
    where: { id: rentalProductId },
    data: { hasVariants: true },
  });

  return { hasVariants: true, variants };
}
