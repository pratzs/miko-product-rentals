// Settings → Availability buffer is honoured everywhere availability is
// decided: the storefront calendar (getUnavailableDates), the add-to-cart and
// Sidekick check (isRangeAvailable), and the order webhook / Sync from
// Shopify conflict check (syncBookingsFromOrder). Bundled from app/ with
// esbuild against a fake database, so this tests the code that ships.
//
// Model: bookings are by the day, end date exclusive. After a booking ends,
// its unit stays unavailable for the buffer rounded up to whole days. The
// booking being requested gets the same buffer, so it cannot end right
// before another booking starts either.
//
// Run: node tests/availability-buffer.test.mjs

process.env.TZ = "UTC";

import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "node_modules/.cache/miko-buffer-tests");
mkdirSync(OUT, { recursive: true });

async function load(entry) {
  const outfile = path.join(OUT, entry.replace(/[^a-z0-9]+/gi, "_") + ".mjs");
  await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
    plugins: [{
      name: "fakes",
      setup(b) {
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({ path: "db", namespace: "fake" }));
        b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
          contents: "export const db = new Proxy({}, { get: (_, k) => globalThis.__fake.db[k] });",
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

const SHOP = "kiwi-surf.myshopify.com";
const PRODUCT_GID = "gid://shopify/Product/9001";
const D = (s) => new Date(`${s}T00:00:00.000Z`);
const product = (over = {}) => ({
  id: "rp1", shop: SHOP, shopifyProductId: PRODUCT_GID, shopifyProductTitle: "Surfboard",
  totalUnits: 1, pricePerDay: 25, pricePerWeek: 0, pricePerMonth: 0, depositAmount: 0,
  minRentalDays: 1, maxRentalDays: 0, isActive: true, hasVariants: false, autoReleaseDeposit: true, ...over,
});
// One existing booking: 10 Dec to 12 Dec (holds the 10th and 11th, returned on the 12th).
const EXISTING = { id: "b1", startDate: D("2026-12-10"), endDate: D("2026-12-12"), unitsRented: 1 };

// A fake DB that applies the startDate/endDate range filter the code sends,
// so a too-narrow query would show up as a missed conflict.
const inRange = (b, where) =>
  (!where.startDate?.lt || b.startDate < where.startDate.lt) &&
  (!where.endDate?.gt || b.endDate > where.endDate.gt) &&
  (!where.id?.not || b.id !== where.id.not);
const useDb = ({ bufferHours, bookings = [EXISTING], prod = product(), created = [] }) => {
  globalThis.__fake = { db: {
    shopConfig: { findUnique: async () => (bufferHours == null ? null : { bufferHours }) },
    rentalProduct: { findUnique: async () => prod, findFirst: async () => prod },
    rentalVariant: { findFirst: async () => null, findUnique: async () => null },
    rentalBooking: {
      findMany: async ({ where }) => bookings.filter((b) => inRange(b, where)),
      findFirst: async () => null,
      create: async ({ data }) => { created.push(data); return data; },
    },
    blockedDate: { findMany: async () => [], count: async () => 0 },
  } };
  return created;
};

const av = await load("app/utils/availability.ts");
const orders = await load("app/utils/booking-from-order.server.ts");

console.log("\n1. buffer hours round up to whole days");
check("0 hours, no gap", av.bufferDays(0), 0);
check("missing setting, no gap", av.bufferDays(undefined), 0);
check("1 hour blocks the return day", av.bufferDays(1), 1);
check("24 hours (the default) is one day", av.bufferDays(24), 1);
check("25 hours is two days", av.bufferDays(25), 2);
check("48 hours is two days", av.bufferDays(48), 2);

console.log("\n2. storefront calendar (getUnavailableDates)");
{
  useDb({ bufferHours: 0 });
  check("no buffer: only the booked days, return day free (as before)",
    await av.getUnavailableDates(SHOP, PRODUCT_GID, D("2026-12-08"), D("2026-12-14")),
    ["2026-12-10", "2026-12-11"]);
  useDb({ bufferHours: null });
  check("no shop settings row: same as no buffer",
    await av.getUnavailableDates(SHOP, PRODUCT_GID, D("2026-12-08"), D("2026-12-14")),
    ["2026-12-10", "2026-12-11"]);
  useDb({ bufferHours: 24 });
  check("24h: the return day is blocked, and the day before the booking (a rental there would end into it)",
    await av.getUnavailableDates(SHOP, PRODUCT_GID, D("2026-12-08"), D("2026-12-14")),
    ["2026-12-09", "2026-12-10", "2026-12-11", "2026-12-12"]);
  useDb({ bufferHours: 48 });
  check("48h: two days each side",
    await av.getUnavailableDates(SHOP, PRODUCT_GID, D("2026-12-06"), D("2026-12-16")),
    ["2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-12", "2026-12-13"]);
  useDb({ bufferHours: 24, prod: product({ totalUnits: 2 }) });
  check("24h with a spare unit: nothing blocked",
    await av.getUnavailableDates(SHOP, PRODUCT_GID, D("2026-12-08"), D("2026-12-14")),
    []);
  useDb({ bufferHours: 24, bookings: [{ ...EXISTING, startDate: D("2026-12-15"), endDate: D("2026-12-17") }] });
  check("24h: a booking just past the window still blocks the window's last day",
    await av.getUnavailableDates(SHOP, PRODUCT_GID, D("2026-12-08"), D("2026-12-14")),
    ["2026-12-14"]);
}

console.log("\n3. add to cart and Sidekick (isRangeAvailable)");
{
  const ok = async (s, e) => (await av.isRangeAvailable(SHOP, PRODUCT_GID, D(s), D(e))).available;
  useDb({ bufferHours: 0 });
  check("no buffer: back to back after the booking is allowed (as before)", await ok("2026-12-12", "2026-12-14"), true);
  check("no buffer: back to back before the booking is allowed (as before)", await ok("2026-12-08", "2026-12-10"), true);
  check("no buffer: overlapping is refused (as before)", await ok("2026-12-11", "2026-12-13"), false);
  useDb({ bufferHours: 24 });
  check("24h: starting on the return day is refused", await ok("2026-12-12", "2026-12-14"), false);
  check("24h: starting the day after the return day is allowed", await ok("2026-12-13", "2026-12-15"), true);
  check("24h: ending on the day the booking starts is refused", await ok("2026-12-08", "2026-12-10"), false);
  check("24h: ending a day before it starts is allowed", await ok("2026-12-07", "2026-12-09"), true);
  useDb({ bufferHours: 24, prod: product({ totalUnits: 2 }) });
  check("24h with a spare unit: back to back is allowed", await ok("2026-12-12", "2026-12-14"), true);
}

console.log("\n4. order webhook and Sync from Shopify (syncBookingsFromOrder)");
{
  const order = (s, e) => ({
    id: 777, name: "#2001", financial_status: "paid", email: "a@example.com",
    line_items: [{ id: 1, quantity: 1, variant_id: 4242, product_id: 9001, properties: [{ name: "_miko_data", value: JSON.stringify({ p: "9001", s, e, u: 1 }) }] }],
  });
  const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
  let created = useDb({ bufferHours: 0 });
  await quiet(() => orders.syncBookingsFromOrder(SHOP, order("2026-12-12", "2026-12-14"), { upgradeToConfirmed: false }));
  check("no buffer: back to back order confirms (as before)", created[0]?.status, "confirmed");
  created = useDb({ bufferHours: 24 });
  await quiet(() => orders.syncBookingsFromOrder(SHOP, order("2026-12-12", "2026-12-14"), { upgradeToConfirmed: false }));
  check("24h: an order inside the buffer is held for review", created[0]?.status, "needs_review");
  check("24h: the note says the buffer was counted", /availability buffer/.test(created[0]?.merchantNotes ?? ""), true);
  created = useDb({ bufferHours: 24 });
  await quiet(() => orders.syncBookingsFromOrder(SHOP, order("2026-12-13", "2026-12-15"), { upgradeToConfirmed: false }));
  check("24h: an order clear of the buffer confirms", created[0]?.status, "confirmed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
