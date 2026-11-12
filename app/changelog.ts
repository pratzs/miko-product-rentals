// What's new: the merchant-facing record of shipped changes, newest first.
//
// Same shape as the other Miko apps' app/changelog.ts. This is a plain data
// file (no Prisma/Shopify imports) so any page or email that shows it later
// reads the exact same list. Every entry is something that actually shipped;
// this is not a roadmap.
//
// English only for now: entries are dated historical records, not core UI.

export interface ChangelogEntry {
  /** ISO date (UTC) the change went live. Also the sort key, so keep it
   *  accurate to the actual release date. */
  date: string;
  title: string;
  body: string;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    // Placeholder on purpose: the release lead sets the real go-live date.
    date: "2026-11-12",
    title: "The new Shopify admin look, and Ask Sidekick on Bookings",
    body: "Every screen in Product Rentals now uses Shopify's own admin components, so the app matches the new Shopify admin look and keeps up with it as Shopify updates the admin. Your dashboard, products, bookings, calendar, emails, analytics and settings all work exactly as before. On the Bookings page, stores with Sidekick get an Ask Sidekick button that asks which rentals are overdue, who has them and how late each one is. Sidekick also answers questions about your rentals faster. This update includes security improvements. Your Availability buffer in Settings now works: after a booking ends, the item stays unavailable for that many hours (rounded up to whole days) so you have time to clean and check it, and a new booking can't end too close to the next one either. It starts at 0 hours, so your bookings work exactly as before until you set one. Bookings you already have are not changed. The product setting \"Automatically mark deposit as released when the booking is marked as returned\" now works too: turn it off and the deposit stays held when you mark the item returned, so you can check it first and then refund or keep the deposit from the booking. A booking that needs review now tells you the real reason, and Help explains all three reasons a booking can be held.",
  },
];
