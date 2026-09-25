// GDPR compliance-webhook logic (app/utils/gdpr.server.ts) against a mock
// Prisma client: which rows each webhook touches, with which where-clauses,
// and that no customer PII reaches the console.
//
// Run: node tests/gdpr-webhooks.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { transformSync } from "esbuild";

const SRC = new URL("../app/utils/gdpr.server.ts", import.meta.url);
const { code } = transformSync(readFileSync(SRC, "utf8"), { loader: "ts", format: "esm" });
const gdpr = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// Records every call as [model.method, args]. $transaction supports both the
// array form (ops already recorded) and the interactive form (tx = same mock).
function mockDb(fixtures = {}) {
  const calls = [];
  const model = (name) => new Proxy({}, {
    get: (_, method) => async (args) => {
      calls.push([`${name}.${String(method)}`, args]);
      const f = fixtures[`${name}.${String(method)}`];
      if (typeof f === "function") return f(args);
      if (f !== undefined) return f;
      if (String(method).endsWith("Many") && String(method) !== "findMany") return { count: 0 };
      if (String(method) === "findMany") return [];
      return null;
    },
  });
  const db = { calls };
  for (const m of ["rentalBooking", "emailLog", "emailTemplate", "rentalVariant", "rentalProduct", "blockedDate", "shopConfig", "session"]) db[m] = model(m);
  db.$transaction = async (arg) => (typeof arg === "function" ? arg(db) : Promise.all(arg));
  return db;
}

const SHOP = "demo.myshopify.com";
const EMAIL = "Jane.Doe@Example.com";
const PHONE = "+64211234567";

// Capture console so we can assert no PII is printed.
const printed = [];
for (const k of ["log", "error", "warn", "info"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { printed.push(a.map(String).join(" ")); orig(...a); };
}

console.log("orderIdForms");
check("numeric and gid, deduped, junk dropped", gdpr.orderIdForms([123, "gid://shopify/Order/123", "", null, "abc", 456]),
  ["123", "gid://shopify/Order/123", "456", "gid://shopify/Order/456"]);

console.log("bookingMatchWhere never puts an empty clause in the OR");
check("no email, no orders -> null", gdpr.bookingMatchWhere(SHOP, "", []), null);
check("orders only", gdpr.bookingMatchWhere(SHOP, "", ["1"]), { shop: SHOP, OR: [{ shopifyOrderId: { in: ["1"] } }] });
check("email only is case-insensitive", gdpr.bookingMatchWhere(SHOP, EMAIL, []),
  { shop: SHOP, OR: [{ customerEmail: { equals: EMAIL, mode: "insensitive" } }] });
check("no shop -> null", gdpr.bookingMatchWhere("", EMAIL, ["1"]), null);

console.log("customers/redact");
{
  const db = mockDb({ "rentalBooking.findMany": [{ id: "b1" }, { id: "b2" }], "emailLog.deleteMany": { count: 3 }, "rentalBooking.updateMany": { count: 2 } });
  const r = await gdpr.redactCustomer(db, SHOP, { customer: { id: 9, email: ` ${EMAIL} `, phone: PHONE }, orders_to_redact: [1001] });
  check("result counts", r, { bookingsRedacted: 2, emailLogsDeleted: 3 });
  check("call order", db.calls.map((c) => c[0]), ["rentalBooking.findMany", "emailLog.deleteMany", "rentalBooking.updateMany"]);
  check("booking match: email (insensitive) OR order id forms, shop scoped", db.calls[0][1].where,
    { shop: SHOP, OR: [{ customerEmail: { equals: EMAIL, mode: "insensitive" } }, { shopifyOrderId: { in: ["1001", "gid://shopify/Order/1001"] } }] });
  check("email logs deleted by booking id OR recipient email", db.calls[1][1].where,
    { shop: SHOP, OR: [{ bookingId: { in: ["b1", "b2"] } }, { recipientEmail: { equals: EMAIL, mode: "insensitive" } }] });
  check("bookings anonymised incl. phone and notes", db.calls[2][1],
    { where: { shop: SHOP, id: { in: ["b1", "b2"] } }, data: { customerName: "Redacted", customerEmail: "", customerPhone: "", merchantNotes: "" } });
}
{
  const db = mockDb();
  const r = await gdpr.redactCustomer(db, SHOP, { customer: { id: 9, email: "" }, orders_to_redact: [] });
  check("empty payload touches nothing", [r, db.calls.length], [{ bookingsRedacted: 0, emailLogsDeleted: 0 }, 0]);
}
{
  const db = mockDb();
  await gdpr.redactCustomer(db, SHOP, { customer: { id: 9, email: EMAIL } });
  check("no bookings: still deletes logs sent to the address, no update", db.calls.map((c) => c[0]), ["rentalBooking.findMany", "emailLog.deleteMany"]);
}

console.log("shop/redact");
{
  const db = mockDb();
  await gdpr.redactShop(db, SHOP);
  check("every shop-scoped model, FK order", db.calls.map((c) => c[0]), [
    "emailLog.deleteMany", "emailTemplate.deleteMany", "rentalBooking.deleteMany", "rentalVariant.deleteMany",
    "rentalProduct.deleteMany", "blockedDate.deleteMany", "shopConfig.deleteMany", "session.deleteMany"]);
  check("all scoped by shop", db.calls.every((c) => JSON.stringify(c[1]) === JSON.stringify({ where: { shop: SHOP } })), true);
  const models = [...readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8").matchAll(/model (\w+) \{([^}]*)\}/g)]
    .filter((m) => /^\s+shop\s+String/m.test(m[2])).map((m) => m[1][0].toLowerCase() + m[1].slice(1) + ".deleteMany").sort();
  check("covers every schema model with a shop column", db.calls.map((c) => c[0]).sort(), models);
  let threw = false; try { await gdpr.redactShop(mockDb(), ""); } catch { threw = true; }
  check("refuses an empty shop", threw, true);
}

console.log("customers/data_request");
{
  const booking = { id: "b1", customerEmail: EMAIL, customerPhone: PHONE, customerName: "Jane Doe" };
  const log = { id: "l1", bookingId: "b1", recipientEmail: EMAIL };
  const db = mockDb({
    "rentalBooking.findMany": [booking], "emailLog.findMany": [log],
    "shopConfig.findUnique": { replyToEmail: "", merchantEmail: "owner@shop.test" },
  });
  const sent = [];
  const r = await gdpr.handleDataRequest(db, SHOP, { customer: { id: 9, email: EMAIL, phone: PHONE }, orders_requested: [1001], data_request: { id: 77 } },
    async (msg) => { sent.push(msg); return { error: null }; });
  check("result", r, { status: "sent", bookings: 1, emailLogs: 1 });
  check("bookings matched by email + order ids", db.calls[0][1].where,
    { shop: SHOP, OR: [{ customerEmail: { equals: EMAIL, mode: "insensitive" } }, { shopifyOrderId: { in: ["1001", "gid://shopify/Order/1001"] } }] });
  check("email logs matched by booking id + address", db.calls[1][1].where,
    { shop: SHOP, OR: [{ bookingId: { in: ["b1"] } }, { recipientEmail: { equals: EMAIL, mode: "insensitive" } }] });
  check("sent to merchant owner email", sent[0].to, "owner@shop.test");
  const attached = JSON.parse(Buffer.from(sent[0].attachments[0].content, "base64").toString("utf8"));
  check("attachment holds bookings (with phone) and email logs", [attached.rentalBookings[0].customerPhone, attached.emailsSentToCustomer[0].id], [PHONE, "l1"]);
  check("subject and body carry no customer email", [sent[0].subject.includes(EMAIL), sent[0].html.includes(EMAIL)], [false, false]);
  const audit = db.calls.find((c) => c[0] === "emailLog.create")[1].data;
  check("audit row written without customer PII", [audit.type, audit.status, audit.bookingId, JSON.stringify(audit).includes(EMAIL)], ["gdpr_data_request", "sent", "", false]);
}
{
  const db = mockDb({ "shopConfig.findUnique": null, "session.findFirst": null });
  const r = await gdpr.handleDataRequest(db, SHOP, { customer: { id: 9, email: EMAIL } }, null);
  check("no recipient / no Resend: audit row status not_sent", [r.status, db.calls.find((c) => c[0] === "emailLog.create")[1].data.status], ["not_sent", "not_sent"]);
}
{
  const db = mockDb({ "shopConfig.findUnique": { replyToEmail: "hello@shop.test", merchantEmail: "owner@shop.test" } });
  const sent = [];
  await gdpr.handleDataRequest(db, SHOP, { customer: { id: 9, email: EMAIL } }, async (m) => { sent.push(m); return { error: { message: "x" } }; });
  check("replyToEmail preferred; send error recorded as failed", [sent[0].to, db.calls.find((c) => c[0] === "emailLog.create")[1].data.status], ["hello@shop.test", "failed"]);
}

console.log("route handlers");
{
  const routes = ["customers.data_request", "customers.redact", "shop.redact"].map((n) =>
    readFileSync(new URL(`../app/routes/webhooks.${n}.tsx`, import.meta.url), "utf8"));
  const logLines = routes.join("\n").split("\n").filter((l) => /console\.(log|error|warn|info)/.test(l) || /^\s+`\[webhook\]/.test(l));
  // Every interpolation in a log line must be one of these PII-free values.
  const ALLOWED = /^(topic|shop|result\.\w+|safeErr\(err\)|JSON\.stringify\(counts\))$/;
  const bad = logLines.flatMap((l) => [...l.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim())).filter((x) => !ALLOWED.test(x));
  check("route log lines only interpolate topic/shop/counts/error code", bad, []);
  check("route log lines never pass a raw error or payload argument", logLines.filter((l) => /,\s*(err|error|payload|data)\s*\)/.test(l)), []);
  check("gdpr.server.ts has no console calls", /console\./.test(readFileSync(SRC, "utf8")), false);
}
check("nothing printed contained the customer email or phone", printed.filter((p) => p.includes(EMAIL) || p.includes(PHONE) || p.toLowerCase().includes(EMAIL.toLowerCase())), []);

console.log(`\n${fail ? "FAIL" : "PASS"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
