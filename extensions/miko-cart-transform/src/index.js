/**
 * Miko Cart Transform Function
 *
 * Runs on every cart and checkout. Finds line items that carry the private
 * `_miko_data` attribute (written by the rental calendar widget) and sets
 * their price to the booked rental total (rental fee + deposit combined).
 * Non-rental items pass through unchanged.
 *
 * WHY `expand` AND NOT `update`
 * `update` (lineUpdate) is the obvious way to override a line price, but
 * Shopify only honours it on Shopify Plus and development stores:
 *   "Only stores on a Shopify Plus plan can use apps with `update`
 *    operations." (CartOperation.update, Cart Transform API schema)
 *   https://shopify.dev/docs/api/functions/latest/cart-transform
 * On Basic, Grow and Advanced the operation is rejected and the shopper is
 * charged the variant's regular price instead of the rental total. That
 * restriction is invisible on a development store, which is why it passed
 * every test we ran.
 *
 * `expand` carries no plan restriction, and Functions in public App Store
 * apps run on every plan:
 *   https://shopify.dev/docs/apps/build/functions ("Stores on any plan can
 *   use public apps that are distributed through the Shopify App Store and
 *   contain functions.")
 * So we expand the rental line into ONE component, the same variant, with a
 * fixed price per unit. This is the pattern Shopify's own gift-wrap example
 * uses to re-price the original item. Component quantities are per unit of
 * the parent line, so the component quantity is 1 and the line total is
 * line.quantity x fixedPricePerUnit.
 *
 * The component keeps `_miko_data` so the orders/create webhook still finds
 * the booking on the order's line item properties.
 *
 * @param {import("../generated/api").RunInput} input
 * @returns {import("../generated/api").FunctionRunResult}
 */
export default function run(input) {
  const operations = [];

  for (const line of input.cart.lines) {
    const raw = line.mikoData?.value;
    if (!raw) continue;

    const variantId = line.merchandise?.id;
    if (!variantId) continue;

    let perUnit = NaN;
    let lockedUnits = NaN;
    try {
      const data = JSON.parse(raw);
      // Compact "pu"/"u" keys (v27+) with legacy "perUnitPrice"/"units"
      // fallback for in-flight orders placed before the format change.
      perUnit = parseFloat(data.pu ?? data.perUnitPrice);
      if (isNaN(perUnit)) perUnit = parseFloat(data.totalPrice);
      lockedUnits = parseInt(data.u ?? data.units, 10);
    } catch {
      continue;
    }
    if (isNaN(perUnit) || perUnit <= 0) continue;
    if (line.quantity < 1) continue;

    // BOOKING TOTAL = the amount the customer agreed to pay at booking time.
    // We lock the LINE TOTAL to this no matter how the customer's cart
    // quantity drifts in the theme cart. We do this by scaling the per-unit
    // price down as quantity goes up so quantity x perUnit always equals
    // the original booking total.
    //
    // Example: customer booked 1 unit at $600. They bump cart qty to 3.
    //   perUnit = 600 / 3 = $200, so 3 x $200 = $600 (unchanged).
    const effectiveLockedUnits = !isNaN(lockedUnits) && lockedUnits >= 1 ? lockedUnits : line.quantity;
    const bookingTotal = effectiveLockedUnits * perUnit;
    const scaledPerUnit = bookingTotal / line.quantity;

    operations.push({
      expand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: variantId,
            quantity: 1,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: scaledPerUnit.toFixed(2),
                },
              },
            },
            attributes: [{ key: "_miko_data", value: raw }],
          },
        ],
      },
    });
  }

  return { operations };
}
