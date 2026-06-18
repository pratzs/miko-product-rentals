/**
 * Cart Transform Function activation.
 *
 * Shopify Functions don't run just because they're deployed - the shop has to
 * have a CartTransform record pointing at the function's ID. This module
 * ensures one exists for every shop that installs the app.
 *
 * Called from the afterAuth hook so it runs once per install (and is a no-op
 * on subsequent installs since the existing record gets reused).
 */

import { db } from "~/db.server";

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

async function persistCartTransformId(shop: string, cartTransformId: string): Promise<void> {
  await db.shopConfig
    .updateMany({ where: { shop }, data: { cartTransformId } })
    .catch(() => {});
}

/**
 * Deletes the CartTransform record from Shopify using a raw fetch against the
 * uninstalled-but-still-valid access token. Idempotent - missing records are
 * treated as success.
 */
export async function deleteCartTransformOnUninstall(
  shop: string,
  accessToken: string,
): Promise<void> {
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { cartTransformId: true },
  });
  if (!config?.cartTransformId) return;

  const API_VERSION = "2026-04";
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation DeleteCartTransform($id: ID!) {
          cartTransformDelete(id: $id) {
            deletedId
            userErrors { message }
          }
        }`,
        variables: { id: config.cartTransformId },
      }),
    });
  } catch (e) {
    console.error(`[cart-transform] cleanup failed for ${shop}:`, e);
  }

  await db.shopConfig
    .updateMany({ where: { shop }, data: { cartTransformId: null } })
    .catch(() => {});
}

export type ActivationResult =
  | { status: "already-active" }
  | { status: "activated"; functionId: string }
  | { status: "function-not-found" }
  | { status: "error"; message: string };

export async function ensureCartTransformActivated(
  admin: AdminClient,
  shop: string,
): Promise<ActivationResult> {
  try {
    // 1. Find our function's ID by its handle.
    const functionsRes = await admin.graphql(
      `#graphql
        query GetCartTransformFunction {
          shopifyFunctions(first: 50) {
            nodes {
              id
              apiType
              title
              app { title }
            }
          }
        }`,
    );
    const functionsData = (await functionsRes.json()) as {
      data?: {
        shopifyFunctions?: {
          nodes: Array<{ id: string; apiType: string; title: string; app: { title: string } }>;
        };
      };
    };
    const fn = functionsData.data?.shopifyFunctions?.nodes.find(
      (n) => n.apiType === "cart_transform" && n.title.toLowerCase().includes("miko"),
    );

    if (!fn) {
      console.warn(`[cart-transform] Function not found for shop ${shop}. Skipping activation.`);
      return { status: "function-not-found" };
    }

    // 2. Check if a CartTransform record already exists for this function.
    const existingRes = await admin.graphql(
      `#graphql
        query ExistingCartTransforms {
          cartTransforms(first: 50) {
            nodes {
              id
              functionId
            }
          }
        }`,
    );
    const existingData = (await existingRes.json()) as {
      data?: { cartTransforms?: { nodes: Array<{ id: string; functionId: string }> } };
    };
    const alreadyActive = existingData.data?.cartTransforms?.nodes.some(
      (n) => n.functionId === fn.id,
    );

    if (alreadyActive) {
      // Persist the existing record's id so uninstall can clean it up.
      const existingNode = existingData.data?.cartTransforms?.nodes.find(
        (n) => n.functionId === fn.id,
      );
      if (existingNode?.id) {
        await persistCartTransformId(shop, existingNode.id);
      }
      return { status: "already-active" };
    }

    // 3. Create the CartTransform record - this is what makes Shopify actually
    //    run the function during checkout.
    const createRes = await admin.graphql(
      `#graphql
        mutation CreateCartTransform($functionId: String!) {
          cartTransformCreate(functionId: $functionId) {
            cartTransform { id functionId }
            userErrors { field message code }
          }
        }`,
      { variables: { functionId: fn.id } },
    );
    const createData = (await createRes.json()) as {
      data?: {
        cartTransformCreate?: {
          cartTransform: { id: string } | null;
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      };
    };
    const errors = createData.data?.cartTransformCreate?.userErrors ?? [];
    if (errors.length > 0) {
      const msg = errors.map((e) => `${e.field?.join(".") || ""}: ${e.message}`).join("; ");
      console.error(`[cart-transform] Activation failed for ${shop}:`, errors);
      return { status: "error", message: msg };
    }
    const createdId = createData.data?.cartTransformCreate?.cartTransform?.id;
    if (createdId) await persistCartTransformId(shop, createdId);
    console.log(`[cart-transform] Activated for ${shop} (functionId=${fn.id})`);
    return { status: "activated", functionId: fn.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cart-transform] Unexpected error activating for ${shop}:`, err);
    return { status: "error", message: msg };
  }
}
