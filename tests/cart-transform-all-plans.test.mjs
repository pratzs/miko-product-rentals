// The rental price must reach checkout on EVERY Shopify plan, not just Plus.
//
// Shopify rejects Cart Transform `update` operations outside Shopify Plus and
// development stores, so a function that re-prices with `update` charges
// Basic/Grow/Advanced shoppers the variant's regular price. This test runs the
// shipped function (src/index.js) and checks that:
//   1. it never emits an `update` operation,
//   2. its output is valid against the real Cart Transform schema
//      (schema.graphql, fetched with `shopify app function schema`),
//   3. the amount the shopper pays equals the booking total, including when
//      the cart quantity drifts away from the booked units,
//   4. the booking data survives onto the component line for the webhook.

import { readFileSync } from "node:fs";
import { buildSchema, coerceInputValue } from "graphql";
import run from "../extensions/miko-cart-transform/src/index.js";

const SCHEMA = buildSchema(
  readFileSync(new URL("../extensions/miko-cart-transform/schema.graphql", import.meta.url), "utf8"),
);
const RESULT_TYPE = SCHEMA.getType("FunctionRunResult");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const line = (id, quantity, data) => ({
  id: `gid://shopify/CartLine/${id}`,
  quantity,
  merchandise: { id: `gid://shopify/ProductVariant/${100 + id}` },
  mikoData: data === undefined ? null : { value: typeof data === "string" ? data : JSON.stringify(data) },
});

// What the shopper is charged for one line after the function runs.
// Component quantities are per unit of the parent line (Shopify's gift-wrap
// example expands a quantity-5 line into components of quantity 1).
const charged = (output, cartLine) => {
  const op = output.operations.find((o) => o.expand?.cartLineId === cartLine.id);
  if (!op) return null;
  return op.expand.expandedCartItems.reduce(
    (sum, item) => sum + cartLine.quantity * item.quantity * parseFloat(item.price.adjustment.fixedPricePerUnit.amount),
    0,
  );
};

const cart = [
  line(1, 1, { p: "gid://shopify/Product/1", s: "2026-10-01", e: "2026-10-04", pu: "600.00", u: 1 }),
  line(2, 3, { p: "gid://shopify/Product/2", s: "2026-10-01", e: "2026-10-02", pu: "50.00", u: 3 }),
  line(3, 3, { p: "gid://shopify/Product/3", s: "2026-10-01", e: "2026-10-02", pu: "600.00", u: 1 }), // qty drifted up
  line(4, 2, { perUnitPrice: "80", units: 2 }), // legacy keys
  line(5, 1), // ordinary product, no rental data
  line(6, 1, "not json"),
  line(7, 1, { pu: "0", u: 1 }),
];
const output = run({ cart: { lines: cart } });

console.log("\ncart transform: rental price on every plan");

check("no Plus-only `update` operations", output.operations.filter((o) => "update" in o).length, 0);
check("one expand per valid rental line", output.operations.map((o) => o.expand?.cartLineId), cart.slice(0, 4).map((l) => l.id));

let schemaError = null;
coerceInputValue(output, RESULT_TYPE, (path, _value, error) => { schemaError ??= `${path.join(".")}: ${error.message}`; });
check("output is valid against the real Cart Transform schema", schemaError, null);

check("1 unit booked at 600 is charged 600", charged(output, cart[0]), 600);
check("3 units booked at 50 are charged 150", charged(output, cart[1]), 150);
check("qty bumped 1 -> 3 is still charged the booked 600", charged(output, cart[2]), 600);
check("legacy keys: 2 x 80 is charged 160", charged(output, cart[3]), 160);
check("ordinary product is untouched", charged(output, cart[4]), null);
check("unparseable rental data is untouched", charged(output, cart[5]), null);
check("zero price is untouched", charged(output, cart[6]), null);

const comp = output.operations[0].expand.expandedCartItems[0];
check("component is the same variant", comp.merchandiseId, cart[0].merchandise.id);
check("component keeps _miko_data for the booking webhook", comp.attributes, [{ key: "_miko_data", value: cart[0].mikoData.value }]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
