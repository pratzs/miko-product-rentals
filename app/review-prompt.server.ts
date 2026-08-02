import { db } from "./db.server";
import { isAffiliatedShop } from "./lifecycle-emails.server";

/** The shop has real value from the app: at least one real booking has come
 * through the storefront calendar (cancelled bookings do not count). */
export async function hasReachedReviewMilestone(shop: string): Promise<boolean> {
  const count = await db.rentalBooking.count({
    where: { shop, status: { not: "cancelled" } },
  });
  return count > 0;
}

/** Show the review banner only after the first-value milestone, and never
 * again once the merchant has interacted with it (clicked through or
 * declined). One ask, no nagging. */
export async function shouldShowReviewPrompt(shop: string): Promise<boolean> {
  // Never prompt our own stores or clients. Shopify unpublished all three of
  // our genuine reviews in July 2026 because they came from our own clients,
  // and their detection was correct; repeat breaches escalate to delisting.
  if (isAffiliatedShop(shop)) return false;
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { reviewPromptDismissedAt: true },
  });
  if (!config || config.reviewPromptDismissedAt !== null) return false;
  return hasReachedReviewMilestone(shop);
}

export async function dismissReviewPrompt(shop: string): Promise<void> {
  await db.shopConfig.update({
    where: { shop },
    data: { reviewPromptDismissedAt: new Date() },
  });
}
