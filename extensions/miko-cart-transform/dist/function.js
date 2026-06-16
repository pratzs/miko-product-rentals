var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// extensions/miko-cart-transform/src/index.js
var src_exports = {};
__export(src_exports, {
  run: () => run
});
function run(input) {
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
                  amount: amount.toFixed(2)
                }
              }
            }
          }
        ]
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
