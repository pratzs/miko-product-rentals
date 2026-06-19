/**
 * Manages the `miko.is_rental` product metafield on Shopify products.
 *
 * The metafield is what lets our App Embed Block detect rental products on
 * the storefront and conditionally hide the regular price / Add to cart
 * button. Setting it here keeps the storefront experience automatic - the
 * merchant doesn't have to tag products by hand.
 */

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

const NAMESPACE = "miko";
const KEY = "is_rental";

/**
 * Idempotent: creates the `miko.is_rental` metafield definition with
 * storefront PUBLIC_READ access if it doesn't exist. Without a definition
 * granting storefront access, Liquid templates can't read app-owned
 * metafields - so the App Embed Block sees nothing and can't hide prices.
 */
export async function ensureRentalMetafieldDefinition(admin: AdminClient): Promise<void> {
  try {
    const res = await admin.graphql(
      `#graphql
        mutation CreateRentalDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { field message code }
          }
        }`,
      {
        variables: {
          definition: {
            name: "Is rental (Miko)",
            namespace: NAMESPACE,
            key: KEY,
            ownerType: "PRODUCT",
            type: "boolean",
            description: "Set by Miko Product Rentals when a product is enabled as a rental. Used by the storefront embed to hide regular pricing.",
            access: { storefront: "PUBLIC_READ" },
            pin: false,
          },
        },
      },
    );
    const data = (await res.json()) as {
      data?: {
        metafieldDefinitionCreate?: {
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      };
    };
    const errors = data.data?.metafieldDefinitionCreate?.userErrors ?? [];
    // TAKEN is the "definition already exists" code - that's fine and expected.
    const realErrors = errors.filter((e) => e.code !== "TAKEN");
    if (realErrors.length > 0) {
      console.error("[metafield-def] Failed to create rental definition:", realErrors);
    }
  } catch (err) {
    console.error("[metafield-def] Unexpected error creating rental definition:", err);
  }
}

// Tracks whether we've ensured the definition this process - avoids hitting
// the API on every single metafield write.
let definitionEnsured = false;

/**
 * For rental products we want customers to be able to book regardless of the
 * Shopify inventory count - the rental is metered by our own units, not by
 * the underlying SKU stock. Flip every variant's inventoryPolicy to CONTINUE
 * when the product is enabled as a rental so the /cart/add.js call never gets
 * rejected with "sold out".
 *
 * When the product is deactivated we leave the policy alone - merchants may
 * still want to sell it normally, and we don't want to surprise them by
 * changing inventory behaviour on deactivation.
 */
export async function ensureRentalVariantsCanOversell(
  admin: AdminClient,
  productGid: string,
): Promise<void> {
  try {
    // Fetch variants including their inventory item ID (needed for the
    // tracked=false fallback below).
    const res = await admin.graphql(
      `#graphql
        query ProductVariantsForOversell($id: ID!) {
          product(id: $id) {
            variants(first: 100) {
              nodes {
                id
                inventoryPolicy
                inventoryManagement
                inventoryItem { id }
              }
            }
          }
        }`,
      { variables: { id: productGid } },
    );
    const data = (await res.json()) as {
      data?: {
        product?: {
          variants: {
            nodes: Array<{ id: string; inventoryPolicy: string; inventoryManagement: string; inventoryItem: { id: string } }>;
          };
        };
      };
    };
    const variants = data.data?.product?.variants?.nodes ?? [];
    if (variants.length === 0) return;

    // Step 1: set inventoryPolicy → CONTINUE and, for 3rd-party fulfilled
    // variants, also switch inventoryManagement → SHOPIFY. Third-party
    // fulfillment services control their own availability and ignore
    // inventoryPolicy; taking over inventory management lets our CONTINUE
    // policy actually take effect. Fulfillment routing (who ships the order)
    // is driven by fulfillmentServiceId, not inventoryManagement, so orders
    // still go to the right place.
    const bulkRes = await admin.graphql(
      `#graphql
        mutation FlipVariantPoliciesBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id inventoryPolicy inventoryManagement }
            userErrors { field message code }
          }
        }`,
      {
        variables: {
          productId: productGid,
          variants: variants.map((v) => ({
            id: v.id,
            inventoryPolicy: "CONTINUE",
            ...(v.inventoryManagement !== "SHOPIFY" ? { inventoryManagement: "SHOPIFY" } : {}),
          })),
        },
      },
    );
    const bulkData = (await bulkRes.json()) as {
      data?: {
        productVariantsBulkUpdate?: {
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      };
    };
    const errors = bulkData.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (errors.length > 0) {
      console.error(`[inventory-policy] productVariantsBulkUpdate errors on ${productGid}:`, errors);
    }

    // Step 2: set inventoryItem.tracked = false so Shopify never blocks the
    // cart add with "sold out" regardless of inventory management type.
    // inventoryPolicy: CONTINUE works for SHOPIFY-managed variants; for
    // third-party fulfilled variants the policy is ignored and the fulfillment
    // service controls availability — setting tracked=false overrides that and
    // makes the variant always purchasable. Rental availability is managed by
    // the Miko calendar, not by Shopify stock counts.
    for (const v of variants) {
      if (!v.inventoryItem?.id) continue;
      const itemRes = await admin.graphql(
        `#graphql
          mutation SetInventoryUntracked($id: ID!, $input: InventoryItemInput!) {
            inventoryItemUpdate(id: $id, input: $input) {
              inventoryItem { id tracked }
              userErrors { field message }
            }
          }`,
        { variables: { id: v.inventoryItem.id, input: { tracked: false } } },
      );
      const itemData = (await itemRes.json()) as {
        data?: {
          inventoryItemUpdate?: {
            userErrors: Array<{ field: string[]; message: string }>;
          };
        };
      };
      const itemErrors = itemData.data?.inventoryItemUpdate?.userErrors ?? [];
      if (itemErrors.length > 0) {
        console.error(`[inventory-policy] inventoryItemUpdate errors on ${v.inventoryItem.id}:`, itemErrors);
      }
    }
  } catch (err) {
    console.error(`[inventory-policy] Failed to flip variants on ${productGid}:`, err);
  }
}

export async function setRentalMetafield(
  admin: AdminClient,
  productGid: string,
  isRental: boolean,
): Promise<void> {
  if (!definitionEnsured) {
    await ensureRentalMetafieldDefinition(admin);
    definitionEnsured = true;
  }
  try {
    const res = await admin.graphql(
      `#graphql
        mutation SetRentalMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key value }
            userErrors { field message code }
          }
        }`,
      {
        variables: {
          metafields: [
            {
              ownerId: productGid,
              namespace: NAMESPACE,
              key: KEY,
              type: "boolean",
              value: isRental ? "true" : "false",
            },
          ],
        },
      },
    );
    const data = (await res.json()) as {
      data?: {
        metafieldsSet?: { userErrors: Array<{ field: string[]; message: string; code: string }> };
      };
    };
    const errors = data.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length > 0) {
      console.error(`[metafield] Failed to set is_rental on ${productGid}:`, errors);
    }
  } catch (err) {
    // Never fail the parent flow if metafield write errors out - the merchant
    // can still use the app, just without the auto-hide behaviour.
    console.error(`[metafield] Unexpected error setting is_rental on ${productGid}:`, err);
  }
}
