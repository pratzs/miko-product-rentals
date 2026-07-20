## What this app does

Miko Product Rentals lets a Shopify store rent products out for a date range
instead of selling them. Each rentable product has a number of units, per-day
and per-week pricing, and an optional deposit. Every customer rental is a
**booking** with a start date, end date, and a status: pending, confirmed,
active (out now), returned, overdue, or cancelled.

## When to use these tools

- "What's overdue / late / not returned?" → `list_overdue_rentals`
- "What's out right now / due back soon?" → `list_active_rentals`
- "What's coming up / booked next?" → `list_upcoming_bookings`
- "Is the [product] free on [dates]?" → `check_availability`
- "What has [customer] rented?" → `find_customer_bookings`
- "What do I rent out / how is [product] priced?" → `list_rental_products`
- "How much rental revenue this month / deposits held?" → `get_rental_revenue`

## Overdue rentals matter most

Each overdue result is real gear a customer still has past its due date. Report
them plainly with the customer, their contact, and how late they are, so the
merchant can chase it. Do not promise a late fee was charged or waived.

## check_availability

Pass the product name as `query`, and optional `from` and `to` dates in
YYYY-MM-DD. With no dates it checks the next seven days. The result's `_meta`
gives `available`, `unitsAvailable`, and `totalUnits`. If `productFound` is
false, the product name did not match a rentable product; say so and offer to
list the rental catalogue, rather than claiming it is unavailable.

## Reading the results

- Bookings carry `order`, `customer`, `startDate`/`endDate` (or `dueBack`/`wasDue`),
  `units`, and `status`. Counts like `totalOverdue`, `totalActive`, `totalUpcoming`
  are the real totals; the listed rows are capped at ten, so quote the total.
- `get_rental_revenue` reports `rentalRevenue` and `totalCharged` for bookings
  created since the start of this month, plus `depositsHeld` across all time.

## When a question is outside these tools

These tools cover bookings, availability, the rental catalogue, and rental
revenue. They do NOT edit bookings, issue refunds, charge late fees, change
availability, or read live Shopify order data beyond what is stored on the
booking. For those, tell the merchant the action lives in the Miko Product
Rentals app and point them there. Never invent numbers or claim an action was
taken.

## Empty results

An empty result set means nothing matched, not that something is broken. No
overdue rentals is good news; say so. Zero bookings for a customer, or an empty
catalogue, are valid answers too.
