import { db as prisma } from "./db.server";

/**
 * Plan granted free to Partner development stores.
 *
 * Shopify's "Free for partners and developers" flag on a Managed Pricing plan
 * only takes effect once the merchant actually selects that plan on Shopify's
 * hosted pricing page. Someone who installs and opens the app without going
 * there has no subscription at all, so our own gates decide, and they land on
 * the free tier with the real product locked. This closes that gap, and it is
 * the ONLY mechanism available on the apps still using legacy billing, which
 * have no such flag to tick.
 */
export const DEV_STORE_PLAN = "pro";

/**
 * Structural type. Deliberately not `AdminApiContext` from the SDK: these apps
 * pin slightly different SDK versions, and all this needs is `.graphql`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AdminLike = {
  // `any` on purpose. The SDK's GraphQLClient has a generic, strongly typed
  // `options` parameter, and a narrower structural type here (options?: unknown)
  // is not assignable from it: parameter types are contravariant. All this
  // function needs is "something with .graphql that returns a response".
  graphql: (query: any, options?: any) => Promise<{ json: () => Promise<any> }>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Is this shop a Partner development store?
 *
 * `partnerDevelopment` is a non-null Boolean on ShopPlan and needs no access
 * scope beyond the default shop read.
 *
 * Returns null, never false, when the lookup fails. A transient API error must
 * not read as "not a dev store", because that would silently downgrade an
 * affiliate mid-evaluation. Every caller keeps its cached value on null.
 */
export async function fetchIsDevelopmentStore(admin: AdminLike): Promise<boolean | null> {
  try {
    const response = await admin.graphql(
      `#graphql
      query ShopPlanKind {
        shop { plan { partnerDevelopment publicDisplayName } }
      }`,
    );
    // Shopify returns GraphQL errors with HTTP 200, so this is the only place a
    // scope or field problem surfaces at all.
    const data = (await response.json()) as {
      data?: { shop?: { plan?: { partnerDevelopment?: unknown; publicDisplayName?: string } } };
      errors?: unknown;
    };
    if (data?.errors) {
      console.error("[fetchIsDevelopmentStore] GraphQL errors:", JSON.stringify(data.errors));
      return null;
    }
    const plan = data?.data?.shop?.plan;
    if (plan == null || typeof plan.partnerDevelopment !== "boolean") {
      console.error("[fetchIsDevelopmentStore] unexpected shape:", JSON.stringify(data).slice(0, 300));
      return null;
    }
    return plan.partnerDevelopment;
  } catch (err) {
    console.error("[fetchIsDevelopmentStore] lookup failed -- keeping cached value:", err);
    return null;
  }
}

/**
 * Settle the development-store grant for a shop.
 *
 * Call this from afterAuth (the grant path) and from the app loader (the lapse
 * path). It never touches a shop holding a real subscription: `hasSubscription`
 * is passed in by the caller, which already knows.
 *
 * Returns the plan name that should now be in force, or null to leave it alone.
 */
export async function settleDevStoreGrant(
  admin: AdminLike,
  shop: string,
  opts: { hasSubscription: boolean; currentPlan: string; cachedIsDev: boolean },
): Promise<string | null> {
  const isDev = await fetchIsDevelopmentStore(admin);
  if (isDev === null) return null; // lookup failed: keep whatever is cached

  if (isDev !== opts.cachedIsDev) {
    await prisma.shopConfig.update({ where: { shop }, data: { isDevelopmentStore: isDev } });
  }

  // A paying shop is never repriced by this.
  if (opts.hasSubscription) return null;

  if (isDev) {
    return opts.currentPlan === DEV_STORE_PLAN ? null : DEV_STORE_PLAN;
  }
  // Not (or no longer) a dev store, and holding the grant: lapse to free.
  if (opts.cachedIsDev && opts.currentPlan === DEV_STORE_PLAN) return "free";
  return null;
}
