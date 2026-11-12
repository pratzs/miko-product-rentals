// Server-side halves of the November 2026 security fix, against the code that
// ships (bundled from app/ with esbuild; only the database and the Shopify
// client are replaced with recording fakes).
//
//   1. Rental rates are published to the app-owned metafields the Cart
//      Transform Function prices from, in the shape the function reads.
//   2. The order webhook never records shopper-written amounts, never books a
//      product other than the one ordered, and holds for review anything
//      checkout would not have charged as a rental.
//   3. /api/checkout computes the price itself and ignores the caller's.
//   4. The settings and emails pages never send secrets to the browser.
//
// Run: node tests/server-security.test.mjs

process.env.TZ = "UTC";

import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import runReference from "../extensions/miko-cart-transform/src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "node_modules/.cache/miko-security-tests");
mkdirSync(OUT, { recursive: true });

// Bundle one app module. db.server and shopify.server resolve to fakes that
// read from globalThis.__fake, so each test swaps behaviour by assignment.
async function load(entry) {
  const outfile = path.join(OUT, entry.replace(/[^a-z0-9]+/gi, "_") + ".mjs");
  await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
    loader: { ".css": "empty" },
    plugins: [{
      name: "fakes",
      setup(b) {
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({ path: "db", namespace: "fake" }));
        b.onResolve({ filter: /(^|\/)shopify\.server$/ }, () => ({ path: "shopify", namespace: "fake" }));
        b.onResolve({ filter: /\.css\?url$/ }, () => ({ path: "css", namespace: "fake" }));
        b.onLoad({ filter: /.*/, namespace: "fake" }, (args) => ({
          contents: args.path === "db"
            ? "export const db = new Proxy({}, { get: (_, k) => globalThis.__fake.db[k] }); export const upsertShopConfig = (a) => globalThis.__fake.db.shopConfig.upsert(a);"
            : args.path === "shopify"
              ? "export const authenticate = { admin: (r) => globalThis.__fake.authenticateAdmin(r) }; export const unauthenticated = { admin: (s) => globalThis.__fake.unauthenticatedAdmin(s) };"
              : "export default '';",
          loader: "js",
        }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const silence = async (fn) => {
  const { warn, error, log } = console;
  console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, { warn, error, log }); }
};

// ── Shared fixtures ─────────────────────────────────────────────────────────
const SHOP = "kiwi-surf.myshopify.com";
const PRODUCT_GID = "gid://shopify/Product/9001";
const rentalProduct = (over = {}) => ({
  id: "rp1", shop: SHOP, shopifyProductId: PRODUCT_GID, shopifyProductTitle: "Surfboard",
  totalUnits: 5, pricePerDay: 25, pricePerWeek: 150, pricePerMonth: 500, depositAmount: 100,
  minRentalDays: 2, maxRentalDays: 60, isActive: true, hasVariants: false, rentalNotes: "", variants: [], ...over,
});
// A fake Admin GraphQL client that records every call.
const fakeAdmin = (respond) => {
  const calls = [];
  return {
    calls,
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables });
      return { json: async () => respond(query, options?.variables, calls.length) };
    },
  };
};

// ════ 1. Rental config metafields ═══════════════════════════════════════════
console.log("\n1. rental rates are published where the function reads them");
{
  const mod = await load("app/utils/rental-config-metafields.server.ts");
  const isDefinition = (q) => q.includes("metafieldDefinitionCreate");
  const okResponse = (q, v) => isDefinition(q)
    ? { data: { metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ field: null, message: "taken", code: "TAKEN" }] } } }
    : { data: { metafieldsSet: { metafields: v.metafields.map((_, i) => ({ id: `m${i}` })), userErrors: [] } } };
  // Only the metafieldsSet calls (definitions are ensured first, once per shop).
  const writes = (admin) => admin.calls.filter((c) => !isDefinition(c.query));

  // single-variant product
  let admin = fakeAdmin(okResponse);
  globalThis.__fake = { db: { rentalProduct: { findUnique: async () => rentalProduct() } } };
  let result = await mod.syncRentalProductConfig(admin, "rp1");
  const definitions = admin.calls.filter((c) => isDefinition(c.query)).map((c) => c.variables.definition);
  check("definitions are registered first, for products and variants, hidden from the storefront",
    definitions.map((d) => [d.ownerType, d.namespace, d.key, d.type, d.access.storefront]),
    [["PRODUCT", "$app:miko_rentals", "config", "json", "NONE"], ["PRODUCTVARIANT", "$app:miko_rentals", "config", "json", "NONE"]]);
  const sent = writes(admin)[0].variables.metafields;
  check("one metafield, on the product", sent.map((m) => m.ownerId), [PRODUCT_GID]);
  check("app-reserved namespace, key and type", [sent[0].namespace, sent[0].key, sent[0].type], ["$app:miko_rentals", "config", "json"]);
  check("value is the config the function reads", JSON.parse(sent[0].value), { v: 1, a: true, hv: false, d: 25, w: 150, m: 500, dep: 100, min: 2, max: 60 });
  check("reported as written", result, { ok: true, written: 1, errors: [] });

  // the function, fed exactly what was sent to Shopify, charges the rates
  const priced = runReference({ cart: { lines: [{ id: "l", quantity: 1, merchandise: { id: "v", rentalConfig: null, product: { id: PRODUCT_GID, rentalConfig: { value: sent[0].value } } }, mikoData: { value: JSON.stringify({ p: "9001", s: "2026-12-01", e: "2026-12-04", u: 1, pu: "0.01" }) } }] } });
  check("function + that metafield = merchant's price (175.00), not the cart's 0.01", priced.operations[0]?.expand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount, "175.00");

  // multi-variant product: 30 variants -> product + 30 variants, in calls of at most 25
  const variants = Array.from({ length: 30 }, (_, i) => ({ shopifyVariantId: `gid://shopify/ProductVariant/${i}`, isActive: i !== 3, pricePerDay: 10 + i, pricePerWeek: 0, pricePerMonth: 0, depositAmount: 5 }));
  admin = fakeAdmin(okResponse);
  globalThis.__fake = { db: { rentalProduct: { findUnique: async () => rentalProduct({ hasVariants: true, variants }) } } };
  result = await mod.syncRentalProductConfig(admin, "rp1");
  check("31 metafields in calls of at most 25", writes(admin).map((c) => c.variables.metafields.length), [25, 6]);
  check("definitions are not re-sent for a shop already done", admin.calls.filter((c) => isDefinition(c.query)).length, 0);
  const all = writes(admin).flatMap((c) => c.variables.metafields);
  check("product config says it is priced per variant", JSON.parse(all[0].value).hv, true);
  check("each variant carries its own rate", JSON.parse(all.find((m) => m.ownerId.endsWith("/7")).value), { v: 1, a: true, d: 17, w: 0, m: 0, dep: 5 });
  check("a variant the merchant switched off is published as off", JSON.parse(all.find((m) => m.ownerId.endsWith("/3")).value).a, false);
  check("all 31 written", result.written, 31);

  // one stale variant must not block the rest (metafieldsSet is atomic)
  admin = fakeAdmin((q, v) => !isDefinition(q) && v.metafields.some((m) => m.ownerId.endsWith("/1"))
    ? { data: { metafieldsSet: { metafields: [], userErrors: [{ field: null, message: "Owner does not exist", code: "INVALID" }] } } }
    : okResponse(q, v));
  globalThis.__fake = { db: { rentalProduct: { findUnique: async () => rentalProduct({ hasVariants: true, variants: variants.slice(0, 3) }) } } };
  result = await silence(() => mod.syncRentalProductConfig(admin, "rp1"));
  check("a deleted variant fails alone: the product and other variants still land", [result.ok, result.written, result.errors.length], [false, 3, 1]);

  // a thrown API error never escapes
  globalThis.__fake = { db: { rentalProduct: { findUnique: async () => rentalProduct() } } };
  result = await silence(() => mod.syncRentalProductConfig({ graphql: async () => { throw new Error("502"); } }, "rp1"));
  check("an API failure is reported, not thrown", [result.ok, result.written], [false, 0]);

  // deleting a rental switches checkout pricing off
  admin = fakeAdmin(okResponse);
  await mod.clearRentalProductConfig(admin, PRODUCT_GID);
  check("deleted rental: config published as inactive", JSON.parse(writes(admin)[0].variables.metafields[0].value).a, false);

  // shop-wide backfill stamps the shop only when everything landed
  const stamped = [];
  globalThis.__fake = { db: {
    rentalProduct: { findMany: async () => [{ id: "rp1" }, { id: "rp2" }], findUnique: async () => rentalProduct() },
    shopConfig: { updateMany: async (a) => { stamped.push(a.where.shop); return {}; } },
  } };
  const summary = await mod.syncShopRentalConfig(fakeAdmin(okResponse), SHOP);
  check("shop backfill: both products synced and the shop stamped", [summary.products, summary.productsSynced, summary.errors, stamped], [2, 2, [], [SHOP]]);
  stamped.length = 0;
  const partial = await silence(() => mod.syncShopRentalConfig({ graphql: async () => { throw new Error("502"); } }, SHOP));
  check("shop backfill that failed is NOT stamped as synced", [partial.productsSynced, stamped], [0, []]);
}

// ════ 2. Order webhook ══════════════════════════════════════════════════════
console.log("\n2. the order webhook does not trust shopper-written rental data");
{
  const mod = await load("app/utils/booking-from-order.server.ts");
  const created = [];
  const useDb = (product, variant = null) => {
    created.length = 0;
    globalThis.__fake = { db: {
      shopConfig: { findUnique: async () => null },
      rentalProduct: { findFirst: async ({ where }) => (product && where.shopifyProductId === product.shopifyProductId ? product : null) },
      rentalVariant: { findFirst: async () => variant, findUnique: async () => variant },
      rentalBooking: { findFirst: async () => null, findMany: async () => [], create: async ({ data }) => { created.push(data); return data; } },
    } };
  };
  const order = (properties, line = {}) => ({
    id: 555, name: "#1001", financial_status: "paid", email: "a@example.com",
    line_items: [{ id: 1, quantity: 1, variant_id: 4242, product_id: 9001, properties, ...line }],
  });
  const data = (over = {}) => [{ name: "_miko_data", value: JSON.stringify({ p: "9001", s: "2026-12-01", e: "2026-12-04", u: 1, r: "75.00", d: "100.00", pu: "175.00", ...over }) }];
  const book = async (o) => { created.length = 0; await silence(() => mod.syncBookingsFromOrder(SHOP, o, { upgradeToConfirmed: false })); return created[0] ?? null; };
  const summary = (b) => b && [b.status, b.rentalPrice, b.depositAmount, b.totalCharged, b.unitsRented, b.rentalDays];

  useDb(rentalProduct());
  check("genuine order: confirmed, at the amounts the customer paid", summary(await book(order(data()))), ["confirmed", 75, 100, 175, 1, 3]);
  check("genuine order: no review note", created[0].merchantNotes, "");

  useDb(rentalProduct());
  let b = await book(order(data({ r: "0.01", d: "9999.00", pu: "0.01" })));
  check("forged amounts: the booking records the merchant's rates, never the forged figures", summary(b), ["needs_review", 75, 100, 175, 1, 3]);
  check("forged amounts: held for review with an explanation", b.merchantNotes.includes("[Auto-flagged]"), true);
  check("forged deposit cannot become the refundable deposit", b.depositAmount, 100);

  useDb(rentalProduct());
  check("rental data naming a different product than the one ordered: no booking",
    await book(order(data(), { product_id: 4444 })), null);

  useDb(rentalProduct());
  b = await book(order(data({ e: "2026-12-02" }))); // 1 day, minimum is 2
  check("dates shorter than the minimum (checkout charges the normal price): held for review", b?.status, "needs_review");

  useDb(rentalProduct({ isActive: false }));
  check("rental switched off: held for review", (await book(order(data())))?.status, "needs_review");

  useDb(rentalProduct());
  check("units checkout would refuse: held for review", (await book(order(data({ u: "2abc" }))))?.status, "needs_review");

  useDb(rentalProduct());
  b = await book(order([
    { name: "_miko_rental_product_id", value: PRODUCT_GID }, { name: "_miko_start_date", value: "2026-12-01" },
    { name: "_miko_end_date", value: "2026-12-04" }, { name: "_miko_rental_price", value: "0.01" }, { name: "_miko_deposit_amount", value: "0" },
  ]));
  check("old six-property format (checkout never prices it): held for review, at the merchant's rates", summary(b), ["needs_review", 75, 100, 175, 1, 3]);

  useDb(rentalProduct());
  check("absurd date range: no booking, no crash", await book(order(data({ s: "0001-01-01", e: "9999-12-31" }))), null);
  useDb(rentalProduct());
  check("unparseable dates: no booking, no crash", await book(order(data({ s: "soon", e: "later" }))), null);

  const variant = { id: "rv1", totalUnits: 2, isActive: true, pricePerDay: 40, pricePerWeek: 0, pricePerMonth: 0, depositAmount: 0 };
  useDb(rentalProduct({ hasVariants: true }), variant);
  check("multi-variant rental: booked at the variant's rate (3 x 40)", summary(await book(order(data({ r: "120.00", d: "0.00", pu: "120.00" })))), ["confirmed", 120, 0, 120, 1, 3]);
  useDb(rentalProduct({ hasVariants: true }), { ...variant, isActive: false });
  check("multi-variant rental, variant switched off: held for review", (await book(order(data())))?.status, "needs_review");

  // What the webhook reads and what checkout charges must be the same booking.
  // For every date the function accepts, the webhook's own date maths (V8 +
  // date-fns) must give the same number of rental days.
  useDb(rentalProduct({ pricePerDay: 1, pricePerWeek: 0, pricePerMonth: 0, depositAmount: 0, minRentalDays: 1, maxRentalDays: 0 }));
  const config = { value: JSON.stringify({ v: 1, a: true, hv: false, d: 1, w: 0, m: 0, dep: 0, min: 1, max: 0 }) };
  let agreed = 0; const disagreed = [];
  for (const year of ["2000", "2023", "2024", "2025", "2026", "2027", "2028", "2100"]) {
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d += (d < 27 ? 13 : 1)) {
      const s = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      for (const length of [1, 3, 45]) {
        const endDate = new Date(new Date(s).getTime() + length * 86400000);
        if (isNaN(endDate.getTime()) || endDate.getUTCFullYear() > 9999) continue;
        const e = endDate.toISOString().slice(0, 10);
        const raw = JSON.stringify({ p: "9001", s, e, u: 1 });
        const op = runReference({ cart: { lines: [{ id: "l", quantity: 1, merchandise: { id: "v", rentalConfig: null, product: { id: PRODUCT_GID, rentalConfig: config } }, mikoData: { value: raw } }] } }).operations[0];
        const chargedDays = op ? parseFloat(op.expand.expandedCartItems[0].price.adjustment.fixedPricePerUnit.amount) : null;
        const booked = await book(order([{ name: "_miko_data", value: raw }]));
        if (chargedDays !== null && booked && chargedDays === booked.rentalDays) agreed++;
        else if (disagreed.length < 5) disagreed.push({ s, e, chargedDays, bookedDays: booked?.rentalDays ?? null });
      }
    }
  }
  check(`charged days = booked days on ${agreed} date pairs (month ends, 30 Feb style roll-overs, leap years)`, disagreed, []);
  check("that sweep really ran", agreed > 1500, true);
}

// ════ 3. /api/checkout ══════════════════════════════════════════════════════
console.log("\n3. /api/checkout prices the draft order itself");
{
  const mod = await load("app/routes/api.checkout.tsx");
  let admin, adminShops;
  const setup = ({ product = rentalProduct(), variantOwner = PRODUCT_GID, bookings = [] } = {}) => {
    adminShops = [];
    admin = fakeAdmin((query) => query.includes("productVariant(")
      ? { data: { productVariant: variantOwner ? { id: "v", product: { id: variantOwner } } : null } }
      : { data: { draftOrderCreate: { draftOrder: { id: "d1", invoiceUrl: "https://kiwi-surf.myshopify.com/invoice/1", status: "OPEN" }, userErrors: [] } } });
    globalThis.__fake = {
      db: {
        rentalProduct: { findFirst: async ({ where }) => (product && where.shop === SHOP && where.shopifyProductId === product.shopifyProductId && (!where.isActive || product.isActive) ? product : null), findUnique: async () => product },
        rentalVariant: { findFirst: async () => null },
        shopConfig: { findUnique: async () => ({ planName: "pro", currency: "NZD" }) },
        rentalBooking: { findMany: async () => bookings, count: async () => 0 },
        blockedDate: { findMany: async () => [], count: async () => 0 },
      },
      unauthenticatedAdmin: async (shop) => { adminShops.push(shop); if (shop !== SHOP) throw new Error("no session"); return { admin }; },
    };
  };
  let ip = 0;
  const post = async (body) => {
    const res = await silence(() => mod.action({ request: new Request("https://app.example/api/checkout", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": `10.0.0.${++ip}` }, body: JSON.stringify(body) }) }));
    return { status: res.status, body: await res.json() };
  };
  const genuine = { shop: SHOP, productId: PRODUCT_GID, variantId: "4242", startDate: "2026-12-01", endDate: "2026-12-04", units: 2 };
  const draftLine = () => admin.calls.find((c) => c.query.includes("draftOrderCreate"))?.variables.input.lineItems[0];

  setup();
  let r = await post({ ...genuine, perUnitPrice: 0.01, rentalPrice: 0.01, depositAmount: 0, totalDue: 0.02, currency: "USD", rentalPriceDisplay: "FREE", depositDisplay: "None", startDisplay: "whenever" });
  check("request with forged prices still succeeds", [r.status, r.body.checkoutUrl], [200, "https://kiwi-surf.myshopify.com/invoice/1"]);
  check("draft order unit price is the merchant's rate (3 x 25 + 100), not the caller's 0.01", draftLine().originalUnitPrice, "175.00");
  check("quantity is the units quoted", draftLine().quantity, 2);
  const attrs = Object.fromEntries(draftLine().customAttributes.map((a) => [a.key, a.value]));
  check("order line text is written by the server, not the caller", [attrs["Rental price"], attrs["Deposit"], attrs["Rental start"], attrs["Rental duration"]], ["NZ$150.00", "NZ$200.00", "1 December 2026", "3 days"]);
  check("_miko_data on the draft carries the server's amounts", JSON.parse(attrs._miko_data), { p: "9001", s: "2026-12-01", e: "2026-12-04", u: 2, r: "150.00", d: "200.00", pu: "175.00" });

  setup({ variantOwner: "gid://shopify/Product/31337" });
  r = await post(genuine);
  check("variant that belongs to another product: refused, no draft order", [r.status, draftLine() ?? null], [404, null]);

  setup({ variantOwner: null });
  r = await post(genuine);
  check("variant that does not exist: refused, no draft order", [r.status, draftLine() ?? null], [404, null]);

  setup({ product: null });
  r = await post(genuine);
  check("product that is not a rental of this shop: refused before any Shopify call", [r.status, adminShops], [404, []]);

  setup({ product: rentalProduct({ isActive: false }) });
  r = await post(genuine);
  check("inactive rental: refused before any Shopify call", [r.status, adminShops], [404, []]);

  setup();
  r = await post({ ...genuine, endDate: "2026-12-02" });
  check("below the merchant's minimum rental length: refused", [r.status, adminShops], [400, []]);

  setup({ bookings: [{ startDate: new Date("2026-11-30"), endDate: new Date("2026-12-10"), unitsRented: 5 }] });
  r = await post(genuine);
  check("dates already fully booked: refused", [r.status, adminShops], [409, []]);

  setup();
  r = await post({ ...genuine, units: 50 });
  check("more units than the merchant owns: refused", [r.status, adminShops], [400, []]);

  setup();
  for (const [label, patch] of [
    ["shop that is not a myshopify domain", { shop: "evil.example.com" }],
    ["shop with a path smuggled in", { shop: "kiwi-surf.myshopify.com/admin" }],
    ["missing product id", { productId: undefined }],
    ["product id that is not a product gid", { productId: "gid://shopify/Customer/1" }],
    ["variant id that is not an id", { variantId: "4242; DROP" }],
    ["date that is not a plain date", { startDate: "2026-12-01T00:00:00Z" }],
  ]) {
    r = await post({ ...genuine, ...patch });
    check(`${label}: 400, nothing looked up`, [r.status, adminShops], [400, []]);
  }

  setup();
  r = await post({ ...genuine, shop: "someone-else.myshopify.com" });
  check("shop where the product is not a rental: refused, no token used", [r.status, adminShops], [404, []]);

  // rate limit: 5 per minute per caller per shop
  setup();
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const res = await silence(() => mod.action({ request: new Request("https://app.example/api/checkout", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(genuine) }) }));
    statuses.push(res.status);
  }
  check("one caller is limited to 5 draft orders a minute", statuses, [200, 200, 200, 200, 200, 429, 429]);
}

// ════ 4. Secrets stay on the server ═════════════════════════════════════════
console.log("\n4. no secret reaches the browser");
{
  // The real row, with secrets in it. The fake honours `select` like Prisma.
  const ROW = { id: "c1", shop: SHOP, accessToken: "shpat_SECRET_TOKEN", planName: "pro", currency: "NZD", gracePeriodDays: 1, lateFeePerDay: 5, bufferHours: 24, onboardingCompleted: true, showPoweredBy: false, senderName: "Kiwi Surf", replyToEmail: "o@kiwi.nz", smtpHost: "smtp.kiwi.nz", smtpPort: 587, smtpUser: "mailer", smtpPass: "SMTP_SECRET_PASSWORD", smtpFromEmail: "o@kiwi.nz", smtpFromName: "Kiwi", smtpSecure: false, brandLogoUrl: null, brandPrimaryColor: "#000", brandName: "Kiwi", shopName: "Kiwi Surf Gear", merchantEmail: "owner@kiwi.nz" };
  const updates = [];
  const selecting = (row) => async ({ select } = {}) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);
  const useRow = (row) => {
    updates.length = 0;
    globalThis.__fake = {
      authenticateAdmin: async () => ({ session: { shop: SHOP, accessToken: "shpat_SESSION" }, admin: {} }),
      db: { shopConfig: { findUnique: selecting(row), updateMany: async (a) => { updates.push(a.data); return {}; } }, emailTemplate: { findMany: async () => [] } },
    };
  };
  const req = (form) => new Request("https://app.example/app/settings", form ? { method: "POST", body: new URLSearchParams(form) } : undefined);

  const settings = await load("app/routes/app.settings.tsx");
  useRow(ROW);
  let payload = await (await settings.loader({ request: req() })).text();
  check("settings loader: SMTP password is not in the payload", payload.includes("SMTP_SECRET_PASSWORD"), false);
  check("settings loader: Admin API token is not in the payload", payload.includes("shpat_"), false);
  check("settings loader: says a password is set", JSON.parse(payload).config.hasSmtpPass, true);
  check("settings loader: the fields the page shows are still there", [JSON.parse(payload).config.smtpHost, JSON.parse(payload).config.smtpUser, JSON.parse(payload).config.currency], ["smtp.kiwi.nz", "mailer", "NZD"]);
  useRow({ ...ROW, smtpPass: "" });
  check("settings loader: says so when no password is set", JSON.parse(await (await settings.loader({ request: req() })).text()).config.hasSmtpPass, false);

  useRow(ROW);
  const smtpForm = { intent: "save_smtp", smtpHost: "smtp.new.nz", smtpPort: "465", smtpUser: "mailer", smtpFromEmail: "o@kiwi.nz", smtpFromName: "Kiwi", smtpSecure: "true" };
  await settings.action({ request: req({ ...smtpForm, smtpPass: "" }) });
  check("saving SMTP settings with the password left empty keeps the stored password", "smtpPass" in updates[0], false);
  check("  ...and still saves the other fields", [updates[0].smtpHost, updates[0].smtpPort, updates[0].smtpSecure], ["smtp.new.nz", 465, true]);
  useRow(ROW);
  await settings.action({ request: req({ ...smtpForm, smtpPass: "brand-new" }) });
  check("typing a new password replaces it", updates[0].smtpPass, "brand-new");

  const emails = await load("app/routes/app.emails.tsx");
  useRow(ROW);
  payload = await (await emails.loader({ request: req() })).text();
  check("emails loader: no SMTP password, no token, no merchant email", ["SMTP_SECRET_PASSWORD", "shpat_", "owner@kiwi.nz"].map((x) => payload.includes(x)), [false, false, false]);
  check("emails loader: brand fields still there", JSON.parse(payload).config.shopName, "Kiwi Surf Gear");

  const appRoute = readFileSync(path.join(ROOT, "app/routes/app.tsx"), "utf8");
  check("app loader no longer copies the session's access token into ShopConfig", /accessToken:\s*session\.accessToken/.test(appRoute), false);
  const settingsSrc = readFileSync(path.join(ROOT, "app/routes/app.settings.tsx"), "utf8");
  check("settings page never seeds the password field from the server", /useState\(config\?\.smtpPass/.test(settingsSrc), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
