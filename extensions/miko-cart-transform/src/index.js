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
export function run(input) {
  const operations = [];

  for (const line of input.cart.lines) {
    const totalPriceProp = line.attributes.find(
      (a) => a.key === "_miko_total_price"
    );
    if (!totalPriceProp?.value) continue;

    const amount = parseFloat(totalPriceProp.value);
    if (isNaN(amount) || amount <= 0) continue;

    operations.push({
      expand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: line.merchandise.id,
            quantity: line.quantity,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: amount.toFixed(2),
                },
              },
            },
          },
        ],
      },
    });
  }

  return { operations };
}
