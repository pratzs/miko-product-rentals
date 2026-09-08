// Rental-only pages must hide EVERY way a theme lets a shopper buy outright,
// and must not take the recommended products' buy buttons with them.
//
// Both halves are extracted from what actually ships: the selector list from
// rental-calendar.liquid, the restore logic from rental-calendar.js. The markup
// below is verbatim from a live Horizon store, Shopify's current default theme,
// where the previous class-based list missed the sticky buy bar entirely and a
// shopper could book a rental with no dates by scrolling.

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const ROOT = new URL("../extensions/rental-calendar/", import.meta.url);
const LIQUID = readFileSync(new URL("blocks/rental-calendar.liquid", ROOT), "utf8");
const JS     = readFileSync(new URL("assets/rental-calendar.js", ROOT), "utf8");

// The rental_only hide list, taken from the shipped Liquid so it cannot drift.
const HIDE_SELECTORS = (() => {
  const start = LIQUID.indexOf("Hide the theme's own price and buy controls");
  const block = LIQUID.slice(start, LIQUID.indexOf("{ display: none !important; }", start));
  return block
    .split("\n").map(l => l.trim())
    .filter(l => l && !l.startsWith("*") && !l.startsWith("/*") && !l.startsWith("Hide"))
    .join(" ").split(",").map(s => s.trim()).filter(Boolean);
})();

function restoreFn(win) {
  const start = JS.indexOf("var RECOMMENDATION_REGIONS");
  const end = JS.indexOf("function watchForRecommendations");
  return new Function("document", `${JS.slice(start, end)}; return restoreRecommendedProductsBuyControls;`)(win.document);
}

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// Verbatim Horizon product page shape: a sticky buy bar OUTSIDE the cart form,
// the main button inside it, Shopify's dynamic checkout button, Miko's own
// button, and a recommendations region that loads in later.
const HTML = `<body>
  <div class="sticky-add-to-cart">
    <button class="sticky-add-to-cart__button add-to-cart-button" type="button">Add to cart</button>
  </div>
  <div class="product-details">
    <form action="/cart/add">
      <input type="hidden" name="id" value="1">
      <button type="submit" name="add" class="button add-to-cart-button">Add to cart</button>
      <div class="shopify-payment-button">
        <button class="shopify-payment-button__button">Buy it now</button>
      </div>
    </form>
    <div id="miko-rental-widget">
      <button id="miko-add-to-cart" class="miko-btn">Add rental to cart</button>
    </div>
  </div>
  <product-recommendations class="product-recommendations">
    <form action="/cart/add">
      <button type="submit" name="add" class="button add-to-cart-button">Add to cart</button>
    </form>
  </product-recommendations>
</body>`;

const dom = new JSDOM(HTML, { url: "https://shop.test/products/kayak" });
const d = dom.window.document;
const covered = (el) => HIDE_SELECTORS.some(s => { try { return el.matches(s); } catch { return false; } });

const sticky   = d.querySelector(".sticky-add-to-cart__button");
const main     = d.querySelector('form[action="/cart/add"] button[type="submit"]');
const buyNow   = d.querySelector(".shopify-payment-button");
const mikoBtn  = d.querySelector("#miko-add-to-cart");
const recBtn   = d.querySelector("product-recommendations button");

console.log("\n[1] Every theme buy control is covered by the hide list");
check("sticky buy bar covered (the bug)", covered(sticky), true);
check("main add to cart covered",         covered(main), true);
check("dynamic checkout covered",         covered(buyNow), true);

console.log("\n[2] Miko's own button is never hidden");
check("miko button not covered", covered(mikoBtn), false);

console.log("\n[3] Recommended products are restored, this product's are not");
{
  const restore = restoreFn(dom.window);
  restore();
  check("recommended product's button restored", recBtn.style.display, "revert");
  check("main product's button left hidden",     main.style.display, "");
  check("sticky bar left hidden",                sticky.style.display, "");
  check("miko button untouched",                 mikoBtn.style.display, "");
}

console.log("\n[4] A recommendations region containing the widget is skipped");
{
  // Guard against a theme nesting the main product inside something whose class
  // matches a recommendation pattern: restoring there would un-hide the very
  // button this feature exists to hide.
  const d2 = new JSDOM(`<body><div class="you-may-like">
    <div id="miko-rental-widget"></div>
    <button class="add-to-cart-button" type="submit" name="add">Add to cart</button>
  </div></body>`, { url: "https://shop.test/products/kayak" });
  restoreFn(d2.window)();
  check("nothing restored inside a region holding the widget",
    d2.window.document.querySelector("button").style.display, "");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
