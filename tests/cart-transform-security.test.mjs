// The Cart Transform Function must only ever charge a price it can trust.
//
// `_miko_data` is a cart line property: the shopper's browser writes it, and
// anyone can write anything into it with a POST to /cart/add.js. The function
// used to charge the `pu` it found there, for any product (security check,
// 11 Nov 2026). It now recomputes the price from the merchant's rates, which
// the app publishes to app-owned metafields.
//
// Every cart in this file goes through BOTH implementations: the deployed
// Rust function (src/main.rs, built natively by `npm run test:cartsecurity`)
// and the JavaScript reference (src/index.js). The assertions are made on the
// Rust result, and the two must agree on every single cart. Configs come from
// the real builders the server uses (app/utils/rental-config.ts) and quotes
// from the real pricing code the storefront uses (app/utils/pricing.ts):
//
//   (i)   the one-cent attack does nothing,
//   (ii)  forged or tampered rental data is never charged,
//   (iii) a genuine booking is charged exactly what it was before,
//   (iv)  a product that is not a rental is never repriced,
//   (v)   quantity changes behave as before,
//   plus the output and input stay inside the Function size limits on a
//   50-line cart.
//
// Run: node tests/cart-transform-security.test.mjs

process.env.TZ = "UTC"; // the server runs in UTC; date-fns day maths is local-time

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { buildSchema, coerceInputValue } from "graphql";
import runReference from "../extensions/miko-cart-transform/src/index.js";

// The deployed function, compiled for this machine (same source as the wasm).
const RUST_BIN = fileURLToPath(new URL("../extensions/miko-cart-transform/target/release/miko-cart-transform", import.meta.url));
if (!existsSync(RUST_BIN)) {
  console.error("Rust function not built. Run: npm run test:cartsecurity (it builds first)");
  process.exit(1);
}
let carts = 0;
const disagreements = [];
// Runs a cart through the Rust function and the JS reference; returns the
// Rust output and records any difference between the two.
const run = (input) => {
  const rust = JSON.parse(execFileSync(RUST_BIN, { input: JSON.stringify(input), maxBuffer: 64 * 1024 * 1024 }).toString());
  const reference = runReference(input);
  carts++;
  if (JSON.stringify(rust) !== JSON.stringify(reference) && disagreements.length < 5) {
    disagreements.push({ input: JSON.stringify(input).slice(0, 600), rust: JSON.stringify(rust).slice(0, 300), reference: JSON.stringify(reference).slice(0, 300) });
  }
  return rust;
};

// Bundle a TypeScript module from the app (and its date-fns import) so plain
// node can load the code that actually ships.
async function loadTs(relativePath) {
  const { outputFiles } = buildSync({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
}
const { calculateRentalPrice } = await loadTs("../app/utils/pricing.ts");
const { buildProductRentalConfig, buildVariantRentalConfig, RENTAL_CONFIG_NAMESPACE, RENTAL_CONFIG_KEY } =
  await loadTs("../app/utils/rental-config.ts");

const SCHEMA = buildSchema(
  readFileSync(new URL("../extensions/miko-cart-transform/schema.graphql", import.meta.url), "utf8"),
);
const RESULT_TYPE = SCHEMA.getType("FunctionRunResult");
const INPUT_QUERY = readFileSync(new URL("../extensions/miko-cart-transform/src/run.graphql", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const RENTAL = { // what the merchant configured in the app (a RentalProduct row)
  isActive: true, hasVariants: false,
  pricePerDay: 25, pricePerWeek: 150, pricePerMonth: 500, depositAmount: 100,
  minRentalDays: 2, maxRentalDays: 60,
};
const meta = (config) => (config === null ? null : { value: typeof config === "string" ? config : JSON.stringify(config) });

let nextId = 1;
// One cart line. `product` / `variant` are the rental config metafields as the
// server would have written them (null = the product is not a rental).
const line = ({ quantity = 1, data, product = null, variant = null, productId = 9001, variantId }) => {
  const id = nextId++;
  return {
    id: `gid://shopify/CartLine/${id}`,
    quantity,
    merchandise: {
      id: `gid://shopify/ProductVariant/${variantId ?? 5000 + id}`,
      rentalConfig: meta(variant),
      product: { id: `gid://shopify/Product/${productId}`, rentalConfig: meta(product) },
    },
    mikoData: data === undefined ? null : { value: typeof data === "string" ? data : JSON.stringify(data) },
  };
};
const runOne = (l) => run({ cart: { lines: [l] } });
// Per-unit amount the function set on a line, or null when it left the line alone.
const unitAmount = (l) => runOne(l).operations[0]?.expand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount ?? null;
// Total the shopper pays for the line, or null when untouched (normal price).
const charged = (l) => {
  const amount = unitAmount(l);
  return amount === null ? null : Math.round(l.quantity * parseFloat(amount) * 100) / 100;
};

// Exactly what the storefront widget writes for a booking it was quoted.
const widgetData = (rates, { start, end, units = 1, productId = 9001 }) => {
  const q = calculateRentalPrice({
    startDate: new Date(start), endDate: new Date(end),
    pricePerDay: rates.pricePerDay, pricePerWeek: rates.pricePerWeek, pricePerMonth: rates.pricePerMonth,
    depositAmount: rates.depositAmount, units,
  });
  return {
    p: String(productId), s: start, e: end, u: units,
    r: q.rentalPrice.toFixed(2), d: q.depositAmount.toFixed(2), pu: q.perUnitPrice.toFixed(2),
  };
};
// The function as deployed before this fix: charge whatever the cart says.
const legacyUnitAmount = (data, quantity) => {
  let perUnit = parseFloat(data.pu ?? data.perUnitPrice);
  if (isNaN(perUnit)) perUnit = parseFloat(data.totalPrice);
  const locked = parseInt(data.u ?? data.units, 10);
  const units = !isNaN(locked) && locked >= 1 ? locked : quantity;
  return ((units * perUnit) / quantity).toFixed(2);
};

const productConfig = buildProductRentalConfig(RENTAL);
const genuine = widgetData(RENTAL, { start: "2026-12-01", end: "2026-12-04" }); // 3 days: 75 + 100 deposit

// ── (i) The one-cent attack ─────────────────────────────────────────────────
console.log("\n(i) one-cent attack");

check("the attack payload on an ordinary product is not repriced",
  charged(line({ data: { pu: "0.01", u: 1 } })), null);
check("the attack payload on a rental product is not repriced (no valid booking in it)",
  charged(line({ data: { pu: "0.01", u: 1 }, product: productConfig })), null);
check("a real booking with pu forged to 0.01 is charged the merchant's price, 175.00",
  unitAmount(line({ data: { ...genuine, pu: "0.01" }, product: productConfig })), "175.00");
check("legacy long keys forged to 0.01 are charged the merchant's price too",
  unitAmount(line({
    data: { productId: "gid://shopify/Product/9001", startDate: "2026-12-01", endDate: "2026-12-04", perUnitPrice: "0.01", totalPrice: "0.01", units: 1 },
    product: productConfig,
  })), "175.00");

// ── (ii) Forged or tampered rental data ─────────────────────────────────────
console.log("\n(ii) forged or tampered rental data");

const tampered = (patch) => line({ data: { ...genuine, ...patch }, product: productConfig });
check("every price field forged: still 175.00",
  unitAmount(tampered({ pu: "1.00", r: "0.50", d: "0.50", perUnitPrice: "1", totalPrice: "1", rentalPrice: "1" })), "175.00");
check("a huge forged price is not charged either",
  unitAmount(tampered({ pu: "999999.00" })), "175.00");
check("negative price: still 175.00", unitAmount(tampered({ pu: "-50" })), "175.00");
check("a forged config smuggled inside _miko_data is ignored",
  unitAmount(tampered({ v: 1, a: true, hv: false, d: 0.01, w: 0, m: 0, dep: 0, min: 1, max: 0 })), "175.00");

check("end date before start date: not repriced", charged(tampered({ s: "2026-12-04", e: "2026-12-01" })), null);
check("zero-length rental: not repriced", charged(tampered({ e: "2026-12-01" })), null);
check("shorter than the merchant's minimum (1 day, minimum 2): not repriced", charged(tampered({ e: "2026-12-02" })), null);
check("longer than the merchant's maximum (61 days, maximum 60): not repriced", charged(tampered({ s: "2026-12-01", e: "2027-01-31" })), null);
check("a year outside 2000-2999: not repriced", charged(tampered({ s: "0000-02-29", e: "0000-03-03" })), null);
check("month 13: not repriced", charged(tampered({ s: "2026-13-01", e: "2026-13-04" })), null);
check("day 32: not repriced", charged(tampered({ s: "2026-12-01", e: "2026-12-32" })), null);
check("30 Feb is read as 2 Mar, exactly as the booking webhook reads it (3 days to 5 Mar)",
  unitAmount(tampered({ s: "2027-02-30", e: "2027-03-05" })), "175.00");
check("a date with a time attached: not repriced", charged(tampered({ s: "2026-12-01T00:00:00Z", e: "2026-12-04T00:00:00Z" })), null);
check("a date in another format: not repriced", charged(tampered({ s: "12/01/2026", e: "12/04/2026" })), null);
check("dates that are not dates: not repriced", charged(tampered({ s: "today", e: "tomorrow" })), null);
check("dates as numbers: not repriced", charged(tampered({ s: 20261201, e: 20261204 })), null);
check("missing dates: not repriced", charged(line({ data: { p: "9001", u: 1, pu: "0.01" }, product: productConfig })), null);

check("rental data naming a DIFFERENT product: not repriced",
  charged(tampered({ p: "777" })), null);
check("rental data with no product id: not repriced",
  charged(line({ data: { s: genuine.s, e: genuine.e, u: 1, pu: "0.01" }, product: productConfig })), null);

check("rental switched off by the merchant: not repriced",
  charged(line({ data: genuine, product: buildProductRentalConfig({ ...RENTAL, isActive: false }) })), null);
check("config metafield that is not JSON: not repriced", charged(line({ data: genuine, product: "{oops" })), null);
check("config of an unknown version: not repriced", charged(line({ data: genuine, product: { ...productConfig, v: 2 } })), null);
check("config with a negative rate: not repriced", charged(line({ data: genuine, product: { ...productConfig, d: -5 } })), null);
check("config with a rate stored as text: not repriced", charged(line({ data: genuine, product: { ...productConfig, d: "25" } })), null);
check("_miko_data that is a JSON array: not repriced", charged(line({ data: "[1,2,3]", product: productConfig })), null);
check("_miko_data that is JSON null: not repriced", charged(line({ data: "null", product: productConfig })), null);

// The booking webhook reads the same property after the order is placed. The
// function must resolve every field the way the webhook does, or a shopper
// could be charged for one booking and have a different one recorded.
check("compact keys say 3 days, legacy keys say 60: priced as the 60 the webhook would book (60 days: 2 months)",
  unitAmount(tampered({ startDate: "2026-12-01", endDate: "2027-01-30" })), "1100.00");
check("compact product id matches, legacy productId names another product: not repriced",
  charged(tampered({ productId: "gid://shopify/Product/777" })), null);
check("duplicate keys: the LAST one counts, as in JSON.parse (60 days charged, not 3)",
  unitAmount(line({ data: JSON.stringify(genuine).replace(/}$/, ',"e":"2027-01-30"}'), product: productConfig })), "1100.00");
check("escape sequences in the rental data: not repriced",
  charged(line({ data: JSON.stringify(genuine).replace('"s":"2026-12-01"', '"s":"2026-12-\\u00301"'), product: productConfig })), null);
check("nested values in the rental data: not repriced", charged(tampered({ extra: { a: 1 } })), null);
check("a number too large to represent: not repriced",
  charged(line({ data: JSON.stringify(genuine).replace(/}$/, ',"x":1e999}'), product: productConfig })), null);
check("dates given as true: not repriced", charged(tampered({ startDate: true })), null);
check("product id as a number is the same product", unitAmount(tampered({ p: 9001 })), "175.00");
check("product id as a fraction: not repriced", charged(tampered({ p: 9001.5 })), null);

// Multi-variant rentals are priced per variant.
const perVariantProduct = buildProductRentalConfig({ ...RENTAL, hasVariants: true });
const variantRates = { isActive: true, pricePerDay: 40, pricePerWeek: 0, pricePerMonth: 0, depositAmount: 0 };
check("multi-variant rental: charged the VARIANT's rate (3 x 40), not the product's",
  unitAmount(line({ data: { ...genuine, pu: "0.01" }, product: perVariantProduct, variant: buildVariantRentalConfig(variantRates) })), "120.00");
check("multi-variant rental, variant has no config: not repriced",
  charged(line({ data: genuine, product: perVariantProduct })), null);
check("multi-variant rental, variant switched off: not repriced",
  charged(line({ data: genuine, product: perVariantProduct, variant: buildVariantRentalConfig({ ...variantRates, isActive: false }) })), null);
check("a variant config alone (product is not a rental) does nothing",
  charged(line({ data: genuine, variant: buildVariantRentalConfig(variantRates) })), null);

// ── (iii) A genuine booking is charged exactly as before ────────────────────
console.log("\n(iii) genuine bookings are charged exactly as before");

check("3 days at 25 plus 100 deposit is 175.00", unitAmount(line({ data: genuine, product: productConfig })), "175.00");
check("the component keeps _miko_data, byte for byte, for the booking webhook",
  runOne(line({ data: genuine, product: productConfig })).operations[0].expand.expandedCartItems[0].attributes,
  [{ key: "_miko_data", value: JSON.stringify(genuine) }]);

// Every combination below is quoted by the real storefront pricing code, sent
// through the function, and compared with what the pre-fix function charged
// for that same cart line. They must agree to the cent, every time.
const RATE_SETS = [
  { pricePerDay: 25, pricePerWeek: 0, pricePerMonth: 0, depositAmount: 0 },
  { pricePerDay: 25, pricePerWeek: 150, pricePerMonth: 500, depositAmount: 100 },
  { pricePerDay: 19.99, pricePerWeek: 99.95, pricePerMonth: 349.5, depositAmount: 50 },
  { pricePerDay: 0.1, pricePerWeek: 0.7, pricePerMonth: 0, depositAmount: 0.2 },
  { pricePerDay: 33.333, pricePerWeek: 0, pricePerMonth: 777.777, depositAmount: 12.345 },
  { pricePerDay: 0, pricePerWeek: 0, pricePerMonth: 0, depositAmount: 75 }, // free rental, deposit only
  { pricePerDay: 1250, pricePerWeek: 7000, pricePerMonth: 25000, depositAmount: 5000 },
  { pricePerDay: 9.99, pricePerWeek: 0, pricePerMonth: 199, depositAmount: 0 },
];
const iso = (dayOffset) => new Date(Date.UTC(2026, 10, 20 + dayOffset)).toISOString().slice(0, 10);
let compared = 0, mismatches = [];
const gridLines = [], gridWant = new Map();
for (const rates of RATE_SETS) {
  const cfg = buildProductRentalConfig({ ...rates, isActive: true, hasVariants: false, minRentalDays: 1, maxRentalDays: 0 });
  for (const startOffset of [0, 41, 100, 467]) { // crosses month ends, new year, a leap day
    for (let days = 1; days <= 120; days++) {
      for (const [units, quantity] of [[1, 1], [3, 3], [2, 5], [4, 1]]) {
        const data = widgetData(rates, { start: iso(startOffset), end: iso(startOffset + days), units });
        const l = line({ quantity, data, product: cfg });
        gridLines.push(l);
        gridWant.set(l.id, { rates, days, units, quantity, want: parseFloat(data.pu) > 0 ? legacyUnitAmount(data, quantity) : null });
      }
    }
  }
}
for (let i = 0; i < gridLines.length; i += 80) { // 80 lines per cart keeps the output realistic
  const chunk = gridLines.slice(i, i + 80);
  const got = new Map(run({ cart: { lines: chunk } }).operations.map((o) => [o.expand.cartLineId, o.expand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount]));
  for (const l of chunk) {
    const expected = gridWant.get(l.id);
    compared++;
    if ((got.get(l.id) ?? null) !== expected.want && mismatches.length < 5) mismatches.push({ ...expected, got: got.get(l.id) ?? null });
  }
}
check(`${compared} genuine bookings: new function = pre-fix function, to the cent`, mismatches, []);
check("that grid really ran", compared, RATE_SETS.length * 4 * 120 * 4);

// ── (iv) Non-rental products are never repriced ─────────────────────────────
console.log("\n(iv) non-rental products");

check("ordinary product, no rental data: untouched", charged(line({})), null);
check("ordinary product carrying a complete, genuine-looking booking: untouched",
  charged(line({ data: genuine })), null);
check("ordinary product, rental data claims a rental product's id: untouched",
  charged(line({ data: genuine, productId: 4242 })), null);
check("ordinary product with every key an attacker might try: untouched",
  charged(line({ data: { ...genuine, pu: "0.01", perUnitPrice: "0.01", totalPrice: "0.01", isRental: true, is_rental: true } })), null);
check("a whole cart of ordinary products with rental data: zero operations",
  run({ cart: { lines: Array.from({ length: 10 }, () => line({ data: { ...genuine, pu: "0.01" } })) } }).operations, []);

// ── (v) Quantity changes behave as before ───────────────────────────────────
console.log("\n(v) quantity changes");

const threeUnits = widgetData(RENTAL, { start: "2026-12-01", end: "2026-12-04", units: 3 });
check("3 units booked, cart quantity 3: 3 x 175 = 525", charged(line({ quantity: 3, data: threeUnits, product: productConfig })), 525);
check("1 unit booked, cart quantity bumped to 3: still 175 in total",
  charged(line({ quantity: 3, data: genuine, product: productConfig })), 174.99); // 58.33 x 3, same rounding as before
check("  ...and that is the pre-fix per-unit amount",
  unitAmount(line({ quantity: 3, data: genuine, product: productConfig })), legacyUnitAmount(genuine, 3));
check("1 unit booked, cart quantity bumped to 5: 35.00 each, 175 in total",
  charged(line({ quantity: 5, data: genuine, product: productConfig })), 175);
check("3 units booked, cart quantity dropped to 1: still charged for the 3 booked",
  charged(line({ quantity: 1, data: threeUnits, product: productConfig })), 525);
const noUnits = { ...genuine }; delete noUnits.u;
check("no units recorded: the cart quantity is the units (2 x 175)",
  charged(line({ quantity: 2, data: noUnits, product: productConfig })), 350);
check("units recorded as null: the cart quantity is the units",
  charged(line({ quantity: 2, data: { ...genuine, u: null }, product: productConfig })), 350);
check("units as a digit string count the same (legacy carts)",
  charged(line({ quantity: 3, data: { ...genuine, u: "3" }, product: productConfig })), 525);
// Tampered units are refused outright rather than guessed at.
for (const [label, u] of [["text", "lots"], ["zero", 0], ["negative", -2], ["a fraction", 1.5], ["over 999", 1000], ["true", true], ["\"2abc\"", "2abc"]]) {
  check(`units given as ${label}: not repriced`, charged(line({ quantity: 2, data: { ...genuine, u }, product: productConfig })), null);
}

// ── Function limits and wiring ──────────────────────────────────────────────
console.log("\nlimits and wiring");

const big = { cart: { lines: Array.from({ length: 50 }, (_, i) => line({ quantity: 1 + (i % 3), data: widgetData(RENTAL, { start: "2026-12-01", end: iso(13 + (i % 20)), units: 1 + (i % 3) }), product: perVariantProduct, variant: buildVariantRentalConfig(variantRates) })) } };
const bigOut = run(big);
check("50 rental lines: 50 operations", bigOut.operations.length, 50);
check("50 rental lines: output under the 40 kB Function output limit", JSON.stringify(bigOut).length < 40000, true);
check("50 rental lines: input under the 128 kB Function input limit", JSON.stringify(big).length < 128000, true);
let schemaError = null;
coerceInputValue(bigOut, RESULT_TYPE, (path, _value, error) => { schemaError ??= `${path.join(".")}: ${error.message}`; });
check("output is valid against the real Cart Transform schema", schemaError, null);
check("no Plus-only `update` operations", bigOut.operations.filter((o) => "update" in o).length, 0);

// The function reads the same metafield address the server writes.
check("input query reads the namespace and key the server writes",
  (INPUT_QUERY.match(new RegExp(`metafield\\(namespace: "${RENTAL_CONFIG_NAMESPACE.replace("$", "\\$")}", key: "${RENTAL_CONFIG_KEY}"\\)`, "g")) || []).length, 2);
check("the config lives in an app-reserved namespace (only the app can write it)",
  RENTAL_CONFIG_NAMESPACE.startsWith("$app:"), true);
check("input query no longer needs anything but ids, quantity, config and _miko_data",
  /cost|price|amount/i.test(INPUT_QUERY), false);

check(`the Rust function and the JS reference agreed on all ${carts} carts in this file`, disagreements, []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
