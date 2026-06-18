/**
 * Miko Cart Transform Function
 *
 * Runs on every checkout. Finds line items that have the private
 * `_miko_total_price` attribute (set by the rental calendar widget)
 * and replaces their price with the rental total (rental fee + deposit
 * combined). Non-rental items pass through unchanged.
 *
 * Using `expand` with a single item is the Shopify-supported way to
 * override a line item price in a Cart Transform Function.
 *
 * @param {import("../generated/api").RunInput} input
 * @returns {import("../generated/api").FunctionRunResult}
 */
export default function run(input) {
  const operations = [];

  for (const line of input.cart.lines) {
    const raw = line.mikoData?.value;
    if (!raw) continue;

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
    // price down as quantity goes up so quantity × perUnit always equals
    // the original booking total.
    //
    // Example: customer booked 1 unit at $600. They bump cart qty to 3.
    //   perUnit = 600 / 3 = $200, so 3 × $200 = $600 (unchanged).
    //
    // This guarantees the customer can never be charged more than they
    // booked, even if Cart Transform Functions can't strictly clamp the
    // cart quantity itself.
    const effectiveLockedUnits = !isNaN(lockedUnits) && lockedUnits >= 1 ? lockedUnits : line.quantity;
    const bookingTotal = effectiveLockedUnits * perUnit;
    const scaledPerUnit = bookingTotal / line.quantity;

    operations.push({
      update: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: {
              amount: scaledPerUnit.toFixed(2),
            },
          },
        },
      },
    });
  }

  return { operations };
}
