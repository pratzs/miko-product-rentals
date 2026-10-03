/**
 * App Store review probes (2 Oct 2026, req 2.1.3): malformed shop/host must get 400, never 500.
 * Genuine admin values (taken from real review traffic) must pass untouched.
 */
process.env.SHOPIFY_API_KEY ||= "test"; process.env.SHOPIFY_API_SECRET ||= "test";
process.env.SHOPIFY_APP_URL ||= "https://example.com"; process.env.SCOPES ||= "read_products";
const { rejectMalformedEmbeddedParams } = await import("../../app/embedded-guard.server");
let pass = 0, fail = 0;
const check = (name: string, ok: boolean) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`); };
const probeStatus = (qs: string): number => {
  try { rejectMalformedEmbeddedParams(new Request(`https://app.example.com/app?${qs}`)); return 0; }
  catch (e) { return e instanceof Response ? e.status : -1; }
};
const realHost = "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYXBwLXJldmlldy1mZDU1YjE0NC1yMTI1MTUxLWEwLXByaW1hcnk";
const legacyHost = Buffer.from("my-store.myshopify.com/admin").toString("base64").replace(/=+$/, "");
check("real admin host from review traffic passes", probeStatus(`shop=app-review-fd55b144-r125151-a0-primary.myshopify.com&host=${realHost}`) === 0);
check("legacy myshopify.com/admin host passes", probeStatus(`shop=my-store.myshopify.com&host=${legacyHost}`) === 0);
check("no params at all passes (auth decides)", probeStatus("") === 0);
check("probe: numeric host gets 400", probeStatus("shop=cross-shop-missing-81f62cce81ba.myshopify.com&host=9998162819999999999") === 400);
check("probe: second numeric host gets 400", probeStatus("shop=cross-shop-missing-7c164825135b.myshopify.com&host=9997164825135999999") === 400);
check("bad shop domain gets 400", probeStatus("shop=evil.example.com") === 400);
check("host pointing elsewhere gets 400", probeStatus(`host=${Buffer.from("evil.example.com/admin").toString("base64")}`) === 400);
check("garbage host gets 400, never throws a TypeError", probeStatus("host=%%%garbage") === 400);
console.log(`host-guard: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
export {};
