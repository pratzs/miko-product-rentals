// PARITY: the deployed Rust function (src/main.rs) against its JavaScript
// reference (src/index.js), on thousands of generated carts, most of them
// hostile.
//
// Why it matters beyond "the port is right": the order webhook decides whether
// a line was charged as a rental by running the JS reference
// (app/utils/checkout-pricing-check.ts). If the Rust build ever priced a line
// the reference refuses, or the other way round, a booking could be recorded
// for money that was never charged. They must agree on every input.
//
// The generator is seeded, so a failure is reproducible. One class of input is
// left out on purpose: a JS string holding a lone surrogate cannot be encoded
// as UTF-8, so it can never reach the function at all.
//
// Run: npm run test:cartsecurity   (builds the native binary first)

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import runReference from "../extensions/miko-cart-transform/src/index.js";

const RUST_BIN = fileURLToPath(new URL("../extensions/miko-cart-transform/target/release/miko-cart-transform", import.meta.url));
if (!existsSync(RUST_BIN)) {
  console.error("Rust function not built. Run: npm run test:cartsecurity (it builds first)");
  process.exit(1);
}

// mulberry32: small seeded generator.
let seed = 0x5eed2026;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const pad = (n, w) => String(n).padStart(w, "0");
const goodDate = () => `${int(2025, 2028)}-${pad(int(1, 12), 2)}-${pad(int(1, 31), 2)}`;
const anyDate = () => pick([
  goodDate, goodDate, goodDate, goodDate,
  () => `${int(0, 9999)}-${pad(int(0, 14), 2)}-${pad(int(0, 33), 2)}`,
  () => `${pad(int(0, 9999), 4)}-${pad(int(1, 12), 2)}-${pad(int(1, 31), 2)}`,
  () => goodDate() + pick(["T00:00:00Z", " ", "Z", "T12:00"]),
  () => goodDate().replace(/-/g, pick(["/", ".", "", " "])),
  () => pick(["", "today", "2026-1-5", "2026-12-1", " 2026-12-01", "2026-12-0١", "２０２６-12-01", "+026-12-01", "2026-+1-01", "0x1F-12-01", "1e3-12-01"]),
  () => pick([null, 0, 1, 20261201, true, false, 1.5]),
])();
const anyUnits = () => pick([
  () => int(1, 5), () => int(1, 5), () => int(1, 5), () => String(int(1, 12)),
  () => pick([0, -1, 1.5, 999, 1000, 1e21, -0, 2.0, 1e2, 9007199254740993]),
  () => pick(["", "0", "01", "007", "1000", "2abc", " 2", "2 ", "+2", "-2", "1e1", "２", "0x2"]),
  () => pick([null, true, false]),
])();
const PRODUCT = 8100000000001;
const anyProductRef = () => pick([
  () => String(PRODUCT), () => String(PRODUCT), () => String(PRODUCT), () => PRODUCT,
  () => `gid://shopify/Product/${PRODUCT}`,
  () => pick(["", "0", "777", ` ${PRODUCT}`, `${PRODUCT} `, `0${PRODUCT}`, `${PRODUCT}.0`, "gid://shopify/Product/", `gid://shopify/Product/${PRODUCT}/x`, `Product/${PRODUCT}`]),
  () => pick([0, 777, PRODUCT + 0.5, -PRODUCT, 9007199254740993, 1e21, null, true, false]),
])();
const anyRate = () => pick([
  () => int(0, 300), () => int(1, 300), () => Math.round(rnd() * 50000) / 100, () => rnd() * 300,
  () => pick([0, 0.1, 0.01, 19.99, 33.333, 1e9, 1e9 + 1, 1e-7, 123456.789]),
  () => pick([-1, "25", null, true, 1e300]),
])();

const okRate = () => pick([() => int(0, 300), () => int(1, 300), () => Math.round(rnd() * 50000) / 100, () => rnd() * 300, () => pick([0.1, 0.01, 19.99, 33.333, 123456.789])])();

// Every line starts as a genuine booking (valid config, valid data) and then
// takes zero, one or a few mutations, so both outcomes get heavy coverage and
// each refusal rule is hit on an otherwise valid line.
const makeLine = (i) => {
  const hv = chance(0.4);
  const product = { v: 1, a: true, hv, d: okRate(), w: pick([0, okRate()]), m: pick([0, okRate()]), dep: pick([0, okRate()]), min: pick([1, 1, 1, 2, 3]), max: pick([0, 0, 60, 365]) };
  const variant = { v: 1, a: true, d: okRate(), w: pick([0, okRate()]), m: pick([0, okRate()]), dep: pick([0, okRate()]) };
  const startOffset = int(0, 500), length = pick([1, 2, 3, 5, 7, 10, 14, 29, 30, 31, 45, 60, 61, 90]);
  const iso = (o) => new Date(Date.UTC(2026, 0, 1 + o)).toISOString().slice(0, 10);
  const quantity = pick([1, 1, 1, 2, 3, 5, 7, 12]);
  const data = { p: String(PRODUCT), s: iso(startOffset), e: iso(startOffset + length), u: pick([quantity, quantity, int(1, 5)]), r: "75.00", d: "100.00", pu: pick(["175.00", "0.01"]) };
  const state = { product: JSON.stringify(product), variant: hv || chance(0.3) ? JSON.stringify(variant) : null, data, raw: null, quantity, productId: PRODUCT, merchandise: undefined, lineId: `gid://shopify/CartLine/${i}`, variantId: `gid://shopify/ProductVariant/${47000000000000 + i}` };

  // A config that an earlier mutation already broke is left as it is.
  const editable = (json) => { try { const c = JSON.parse(json); return c && typeof c === "object" && !Array.isArray(c) ? c : null; } catch { return null; } };
  const MUTATIONS = [
    // rental data fields
    (t) => { t.data.p = anyProductRef(); },
    (t) => { t.data.productId = anyProductRef(); },
    (t) => { delete t.data.p; },
    (t) => { t.data.s = anyDate(); },
    (t) => { t.data.e = anyDate(); },
    (t) => { t.data.startDate = anyDate(); },
    (t) => { t.data.endDate = anyDate(); },
    (t) => { [t.data.s, t.data.e] = [t.data.e, t.data.s]; },
    (t) => { delete t.data[pick(["s", "e"])]; },
    (t) => { t.data.u = anyUnits(); },
    (t) => { t.data.units = anyUnits(); },
    (t) => { delete t.data.u; },
    (t) => { t.data.extra = pick([[1], { a: 1 }, [], {}, null, "x", 1]); },
    (t) => { t.data.note = pick(["é", "日本語", "😀", "\u2028", "plain"]); },
    // the raw string itself
    (t) => { t.rawSet = true; t.raw = JSON.stringify(t.data).replace(/}$/, `,"e":${JSON.stringify(anyDate())}}`); },
    (t) => { t.rawSet = true; t.raw = JSON.stringify(t.data).replace(/}$/, `,"s":${JSON.stringify(anyDate())}}`); },
    (t) => { t.rawSet = true; t.raw = JSON.stringify(t.data).replace(/}$/, `,"u":${pick(["1e999", "-1e999", "1E400", "0.0", "-0", "1e-999", "00", "01", "1.", ".5", "+1", "NaN", "Infinity", "2", "2.0", "2e0", "1e2"])}}`); },
    (t) => { t.rawSet = true; t.raw = JSON.stringify(t.data).replace(/}$/, `,"x":${pick(["1e999", "1e-999", "123456789012345678901234567890", "-0.0", "1E5"])}}`); },
    (t) => { t.rawSet = true; t.raw = JSON.stringify(t.data).replace('"s":"2', pick(['"s":"\\u0032', '"s":"\\ud800', '"\\u0073":"2', '"s":"\\/2'])); },
    (t) => { t.rawSet = true; const r = JSON.stringify(t.data); t.raw = pick([r.slice(0, -1), r + " ", " " + r, "\ufeff" + r, r + r, "[" + r + "]", "{}", "[]", "nul", "true", "0", '"x"', r.replace(/"/g, "'"), r + "\n", r.replace("{", "{ \t\r\n"), r.replace(/,/g, " , ").replace(/:/g, " : ")]); },
    (t) => { t.rawSet = true; t.raw = "[".repeat(200) + "]".repeat(200); },
    (t) => { t.rawSet = true; t.raw = JSON.stringify(t.data).replace(/}$/, ',"x":' + '{"a":'.repeat(150) + "1" + "}".repeat(150) + "}"); },
    (t) => { t.rawSet = true; t.raw = pick(["", null]); },
    // merchant config
    (t) => { t.product = pick([null, "", "{", "[]", "null", "1", '{"v":1}', '{"v":"1","a":true,"d":1,"w":0,"m":0,"dep":0}']); },
    (t) => { const c = editable(t.product); if (!c) return; c[pick(["d", "w", "m", "dep"])] = anyRate(); t.product = JSON.stringify(c); },
    (t) => { const c = editable(t.product); if (!c) return; c.v = pick([1.0, 2, "1", 0, null]); t.product = JSON.stringify(c); },
    (t) => { const c = editable(t.product); if (!c) return; c.a = pick([false, 1, "true", null]); t.product = JSON.stringify(c); },
    (t) => { const c = editable(t.product); if (!c) return; c.hv = pick([true, false, null, 1, "true"]); t.product = JSON.stringify(c); },
    (t) => { const c = editable(t.product); if (!c) return; delete c.hv; t.product = JSON.stringify(c); },
    (t) => { const c = editable(t.product); if (!c) return; c.min = pick([0, 2, 7, 1.5, -1, "1", null, 100000, 100001]); t.product = JSON.stringify(c); },
    (t) => { const c = editable(t.product); if (!c) return; c.max = pick([1, 2, 30, 2.5, "0", null, -1]); t.product = JSON.stringify(c); },
    (t) => { const c = editable(t.product); if (!c) return; delete c[pick(["min", "max"])]; t.product = JSON.stringify(c); },
    (t) => { t.variant = pick([null, "", "{", "[]"]); },
    (t) => { t.variant = JSON.stringify({ ...variant, a: pick([false, 1, null]) }); },
    (t) => { t.variant = JSON.stringify({ ...variant, [pick(["d", "w", "m", "dep"])]: anyRate() }); },
    (t) => { t.variant = JSON.stringify({ ...variant, v: 2 }); },
    // the line
    (t) => { t.productId = 777; },
    (t) => { t.quantity = pick([1, 2, 3, 100, 999]); },
    (t) => { t.merchandise = {}; },
    (t) => { t.variantId = pick(["", null]); },
    (t) => { t.lineId += '"\\\n\u00e9'; },
  ];
  const count = pick([0, 0, 0, 1, 1, 1, 1, 2, 2, 3]);
  for (let k = 0; k < count; k++) pick(MUTATIONS)(state);

  return {
    id: state.lineId,
    quantity: state.quantity,
    merchandise: state.merchandise ?? {
      id: state.variantId,
      rentalConfig: state.variant === null ? null : { value: state.variant },
      product: { id: `gid://shopify/Product/${state.productId}`, rentalConfig: state.product === null ? null : { value: state.product } },
    },
    mikoData: { value: state.rawSet ? state.raw : JSON.stringify(state.data) },
  };
};

const TOTAL_LINES = 40000, PER_CART = 80;
let lines = 0, cartsRun = 0, priced = 0, refused = 0;
const failures = [];
for (let c = 0; c < TOTAL_LINES / PER_CART; c++) {
  const input = { cart: { lines: Array.from({ length: PER_CART }, (_, i) => makeLine(c * PER_CART + i)) } };
  const reference = runReference(input);
  const rustRaw = execFileSync(RUST_BIN, { input: JSON.stringify(input), maxBuffer: 64 * 1024 * 1024 }).toString();
  cartsRun++; lines += PER_CART; priced += reference.operations.length; refused += PER_CART - reference.operations.length;
  if (rustRaw !== JSON.stringify(reference)) {
    // Narrow it down to the first line that differs.
    for (const l of input.cart.lines) {
      const one = { cart: { lines: [l] } };
      const a = execFileSync(RUST_BIN, { input: JSON.stringify(one) }).toString();
      const b = JSON.stringify(runReference(one));
      if (a !== b) { failures.push({ line: JSON.stringify(l), rust: a, reference: b }); break; }
    }
    if (failures.length >= 3) break;
  }
}

console.log("\ncart transform: Rust function vs JS reference");
for (const f of failures) console.log(`  FAIL   outputs differ\n         line      ${f.line}\n         rust      ${f.rust}\n         reference ${f.reference}`);
const ok = failures.length === 0 && priced > 2000 && refused > 2000;
console.log(`  ${ok ? "ok  " : "FAIL"}   ${lines} generated lines in ${cartsRun} carts: byte-identical output (${priced} priced, ${refused} refused)`);
if (!(priced > 2000 && refused > 2000)) console.log("  FAIL   the generator must exercise both outcomes heavily");
console.log(`\n${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
if (!ok) process.exit(1);
