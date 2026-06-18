var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// extensions/miko-cart-transform/src/index.js
var src_exports = {};
__export(src_exports, {
  default: () => run
});
function run(input) {
  const operations = [];
  for (const line of input.cart.lines) {
    const raw = line.mikoData?.value;
    if (!raw) continue;
    let perUnit = NaN;
    let lockedUnits = NaN;
    try {
      const data = JSON.parse(raw);
      perUnit = parseFloat(data.pu ?? data.perUnitPrice);
      if (isNaN(perUnit)) perUnit = parseFloat(data.totalPrice);
      lockedUnits = parseInt(data.u ?? data.units, 10);
    } catch {
      continue;
    }
    if (isNaN(perUnit) || perUnit <= 0) continue;
    if (line.quantity < 1) continue;
    const effectiveLockedUnits = !isNaN(lockedUnits) && lockedUnits >= 1 ? lockedUnits : line.quantity;
    const bookingTotal = effectiveLockedUnits * perUnit;
    const scaledPerUnit = bookingTotal / line.quantity;
    operations.push({
      update: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: {
              amount: scaledPerUnit.toFixed(2)
            }
          }
        }
      }
    });
  }
  return { operations };
}

// extensions/miko-cart-transform/node_modules/@shopify/shopify_function/run.ts
function run_default(userfunction) {
  try {
    ShopifyFunction;
  } catch (e) {
    throw new Error(
      "ShopifyFunction is not defined. Please rebuild your function using the latest version of Shopify CLI."
    );
  }
  const input_obj = ShopifyFunction.readInput();
  const output_obj = userfunction(input_obj);
  ShopifyFunction.writeOutput(output_obj);
}

// extensions/miko-cart-transform/node_modules/@shopify/shopify_function/index.ts
run_default(src_exports?.default);
