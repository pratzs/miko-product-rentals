/**
 * Miko Cart Transform Function: REFERENCE IMPLEMENTATION (not deployed)
 *
 * The function Shopify runs is the Rust port in src/main.rs. JavaScript on
 * Shopify Functions is interpreted and spent about 230,000 instructions per
 * rental line once the price had to be recomputed here, so a cart of 50
 * rental lines went over the 11 million instruction cap (when that happens
 * Shopify discards the whole output). The Rust build does the same work in a
 * small fraction of that.
 *
 * This file stays as the readable definition of the logic. main.rs is a line
 * for line port, and tests/cart-transform-parity.test.mjs runs thousands of
 * carts through both and requires identical output. Change them together.
 *
 * Runs on every cart and checkout. Finds line items that carry the private
 * `_miko_data` attribute (written by the rental calendar widget) and sets
 * their price to the rental total (rental fee + deposit combined).
 * Everything else passes through unchanged.
 *
 * WHERE THE PRICE COMES FROM (security, Nov 2026)
 * `_miko_data` is a cart line property, so the shopper's browser writes it and
 * a shopper can put anything in it with a plain POST to /cart/add.js. This
 * function used to charge the `pu` figure from that property, for any product,
 * which let anyone name their own price for anything in the store.
 *
 * It no longer reads a price from the cart at all. The only things taken from
 * `_miko_data` are the booking CHOICES a shopper is allowed to make: which
 * dates and how many units. The price is recomputed here from the merchant's
 * own rates, which the app writes to app-owned metafields
 * (`$app:miko_rentals.config`) on the product and on each variant. Only the
 * app can write that namespace through the Admin API; nothing in the
 * storefront or the cart can.
 *
 * A line is repriced only when ALL of these hold, otherwise no operation is
 * emitted and the shopper pays the variant's normal price (never a figure
 * from the cart):
 *   1. the product carries an active rental config metafield,
 *   2. for multi-variant rentals, the variant carries an active config too,
 *   3. `_miko_data` names this same product (so the booking webhook records
 *      the booking against the product that was actually paid for),
 *   4. the dates are plain YYYY-MM-DD dates, end after start, and the length
 *      is inside the merchant's minimum and maximum rental days,
 *   5. the units are absent or a whole number from 1 to 999,
 *   6. the computed price is above zero.
 *
 * READ `_miko_data` EXACTLY THE WAY THE BOOKING WEBHOOK DOES
 * app/utils/booking-from-order.server.ts reads the same property after the
 * order is placed and records the booking from it. If this function and the
 * webhook ever resolved a field differently, a shopper could be charged for
 * one thing and booked for another (for example: compact keys saying one
 * day, legacy keys saying sixty). So the key precedence below is the
 * webhook's (legacy long keys win over compact ones), and any value whose
 * meaning is not unambiguous is refused rather than interpreted.
 *
 * The maths mirrors app/utils/pricing.ts (calculateRentalPrice) and the
 * checks in app/utils/rental-quote.server.ts exactly, so a genuine booking is
 * charged the same amount the widget quoted. tests/cart-transform-security.test.mjs
 * compares the two over a grid of rates and durations.
 *
 * WHY `expand` AND NOT `update`
 * `update` (lineUpdate) is the obvious way to override a line price, but
 * Shopify only honours it on Shopify Plus and development stores:
 *   "Only stores on a Shopify Plus plan can use apps with `update`
 *    operations." (CartOperation.update, Cart Transform API schema)
 *   https://shopify.dev/docs/api/functions/latest/cart-transform
 * On Basic, Grow and Advanced the operation is rejected and the shopper is
 * charged the variant's regular price instead of the rental total. That
 * restriction is invisible on a development store, which is why it passed
 * every test we ran.
 *
 * `expand` carries no plan restriction, and Functions in public App Store
 * apps run on every plan:
 *   https://shopify.dev/docs/apps/build/functions ("Stores on any plan can
 *   use public apps that are distributed through the Shopify App Store and
 *   contain functions.")
 * So we expand the rental line into ONE component, the same variant, with a
 * fixed price per unit. This is the pattern Shopify's own gift-wrap example
 * uses to re-price the original item. Component quantities are per unit of
 * the parent line, so the component quantity is 1 and the line total is
 * line.quantity x fixedPricePerUnit.
 *
 * The component keeps `_miko_data` so the orders/create webhook still finds
 * the booking on the order's line item properties.
 *
 * @param {{ cart: { lines: Array<any> } }} input  the shape src/run.graphql asks for
 * @returns {{ operations: Array<any> }}
 */
export default function run(input) {
  const operations = [];

  for (const line of input.cart.lines) {
    const raw = line.mikoData?.value;
    if (!raw) continue;

    const variant = line.merchandise;
    const variantId = variant?.id;
    if (!variantId) continue;
    if (line.quantity < 1) continue;

    // 1. Merchant config. No active config on the product = not a rental =
    //    never repriced, whatever the line's attributes say.
    const productConfig = parseConfig(variant.product?.rentalConfig?.value);
    if (!productConfig) continue;

    // 2. Multi-variant rentals are priced per variant, and a variant the
    //    merchant has not enabled is not rentable (same as /api/pricing).
    let rates = productConfig;
    if (productConfig.hv === true) {
      rates = parseConfig(variant.rentalConfig?.value);
      if (!rates) continue;
    }

    const data = parseRentalData(raw);
    if (!data) continue;

    // 3. The booking must be for the product on this line. Webhook:
    //    `mikoData.productId || (mikoData.p ? gid + mikoData.p : "")`.
    const claimedProduct = firstTruthy(data.productId, data.p);
    if (claimedProduct === REFUSE) continue;
    const claimedGid =
      claimedProduct.from === 0 ? claimedProduct.text : claimedProduct.from === 1 ? PRODUCT_GID + claimedProduct.text : "";
    if (claimedGid !== variant.product.id) continue;

    // 4. Dates. Webhook: `mikoData.startDate || mikoData.s`, same for end.
    const start = firstTruthy(data.startDate, data.s);
    const end = firstTruthy(data.endDate, data.e);
    if (start === REFUSE || end === REFUSE) continue;
    const startDay = dayNumber(start.text);
    const endDay = dayNumber(end.text);
    if (startDay === null || endDay === null) continue;
    const rentalDays = endDay - startDay;
    if (rentalDays < 1) continue;
    if (rentalDays < productConfig.min) continue;
    if (productConfig.max > 0 && rentalDays > productConfig.max) continue;

    // 5. Units. Webhook: `mikoData.u ?? mikoData.units`, and the cart
    //    quantity when neither is recorded.
    const recorded = data.u ?? data.units;
    let units = line.quantity;
    if (recorded !== undefined && recorded !== null) {
      units = wholeUnits(recorded);
      if (units === null) continue;
    }

    // 6. Price for ONE unit, from merchant rates only. Rounded to cents the
    //    same way the widget rounded the `pu` it used to send
    //    (perUnitPrice.toFixed(2), then parseFloat here), so every later step
    //    works on the identical number and charges the identical amount.
    const perUnit = parseFloat(perUnitPrice(rates, rentalDays).toFixed(2));
    if (!(perUnit > 0) || perUnit > MAX_AMOUNT) continue;

    // BOOKING TOTAL = units booked x the per-unit price. We lock the LINE
    // TOTAL to this no matter how the customer's cart quantity drifts in the
    // theme cart, by scaling the per-unit price down as quantity goes up so
    // quantity x perUnit always equals the booking total.
    //
    // Example: customer booked 1 unit at $600. They bump cart qty to 3.
    //   perUnit = 600 / 3 = $200, so 3 x $200 = $600 (unchanged).
    const bookingTotal = units * perUnit;
    const scaledPerUnit = bookingTotal / line.quantity;

    operations.push({
      expand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: variantId,
            quantity: 1,
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: scaledPerUnit.toFixed(2),
                },
              },
            },
            attributes: [{ key: "_miko_data", value: raw }],
          },
        ],
      },
    });
  }

  return { operations };
}

const PRODUCT_GID = "gid://shopify/Product/";
// Far above any real rental, far below where cents stop being exact.
const MAX_AMOUNT = 1e9;
const REFUSE = Symbol("refuse");

/**
 * Rental fee plus deposit for one unit. Line for line the same arithmetic as
 * calculateRentalPrice in app/utils/pricing.ts: monthly rate first when
 * offered and the rental is 30+ days, then weekly at 7+ days, else daily,
 * with leftover days at the daily rate.
 */
function perUnitPrice(rates, rentalDays) {
  const perDay = rates.d;
  const perWeek = rates.w;
  const perMonth = rates.m;
  let perUnitRental;
  if (perMonth > 0 && rentalDays >= 30) {
    const fullMonths = Math.floor(rentalDays / 30);
    const remainingDays = rentalDays % 30;
    perUnitRental = fullMonths * perMonth + remainingDays * perDay;
  } else if (perWeek > 0 && rentalDays >= 7) {
    const fullWeeks = Math.floor(rentalDays / 7);
    const remainingDays = rentalDays % 7;
    perUnitRental = fullWeeks * perWeek + remainingDays * perDay;
  } else {
    perUnitRental = rentalDays * perDay;
  }
  return perUnitRental + rates.dep;
}

function parseObject(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parses `_miko_data`, refusing anything outside the plain shape the widget
 * writes: a JSON object of strings and numbers.
 *
 * These refusals exist so that every JSON parser that ever reads this value
 * (JSON.parse here and in the webhook, serde_json in main.rs) is guaranteed
 * to see the same thing. The widget's own output never trips them.
 *   - no backslash anywhere: escape sequences are where parsers differ
 *     (a lone "\ud800" is fine for JSON.parse and an error for serde_json),
 *   - no nested arrays or objects: nothing here needs them, and deep nesting
 *     hits different limits in different parsers,
 *   - no number too large to be a finite double (1e999).
 */
function parseRentalData(raw) {
  if (raw.indexOf("\\") !== -1) return null;
  const data = parseObject(raw);
  if (!data) return null;
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (value !== null && typeof value === "object") return null;
    if (typeof value === "number" && !isFinite(value)) return null;
  }
  return data;
}

/**
 * Reads a `$app:miko_rentals.config` metafield (written by
 * app/utils/rental-config-metafields.server.ts). Returns null unless it is a
 * version 1 config that is switched on, every rate is a finite number that is
 * zero or more, and the day limits are whole numbers. An unknown version
 * fails closed (no repricing).
 */
function parseConfig(raw) {
  const config = parseObject(raw);
  if (!config || config.v !== 1 || config.a !== true) return null;
  if (!isRate(config.d) || !isRate(config.w) || !isRate(config.m) || !isRate(config.dep)) return null;
  if (config.hv !== undefined && typeof config.hv !== "boolean") return null;
  const min = config.min === undefined ? 1 : config.min;
  const max = config.max === undefined ? 0 : config.max;
  if (!isDayCount(min) || !isDayCount(max)) return null;
  return { hv: config.hv === true, d: config.d, w: config.w, m: config.m, dep: config.dep, min, max };
}

function isRate(value) {
  return typeof value === "number" && isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
}

function isDayCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000;
}

/**
 * JavaScript's `a || b` over two JSON values, but only for the shapes whose
 * meaning is beyond doubt. Returns { from: 0 | 1 | -1, text } (which operand
 * won, -1 = neither) or REFUSE.
 *   - a non-empty string wins as itself,
 *   - a whole number from 1 to 2^53 wins as its decimal digits (what string
 *     concatenation in the webhook produces),
 *   - absent, null, "", 0 and false are falsy and fall through,
 *   - anything else (true, fractions, huge numbers, arrays, objects) is truthy
 *     in JavaScript but has no sensible meaning here: REFUSE.
 */
function firstTruthy(a, b) {
  const operands = [a, b];
  for (let i = 0; i < 2; i++) {
    const value = operands[i];
    if (value === undefined || value === null || value === "" || value === 0 || value === false) continue;
    if (typeof value === "string") return { from: i, text: value };
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9007199254740992) {
      return { from: i, text: String(value) };
    }
    return REFUSE;
  }
  return { from: -1, text: "" };
}

/**
 * Units recorded in `_miko_data`: a whole number from 1 to 999 (the storefront
 * quote never offers more), as a JSON number or as a string of digits. The
 * webhook does parseInt on it; for exactly these shapes parseInt gives the
 * same number, and for everything else we refuse instead of guessing.
 */
function wholeUnits(value) {
  let n = null;
  if (typeof value === "number" && Number.isInteger(value)) n = value;
  else if (typeof value === "string" && value.length >= 1 && value.length <= 3) {
    n = digits(value, 0, value.length);
  }
  return n !== null && n >= 1 && n <= 999 ? n : null;
}

/**
 * "YYYY-MM-DD", exactly ten characters, to a day count, so end - start is the
 * number of rental days. Year 2000-2999 (date libraries disagree about years
 * before 100, and no rental is booked there), month 01-12, day 01-31. A day past the end of a
 * short month rolls into the next one (30 Feb = 2 Mar), because that is what
 * `new Date("2027-02-30")` does in the webhook and the two must agree. No
 * Date object: plain integer arithmetic has no parser and no timezone to
 * disagree about.
 */
function dayNumber(value) {
  if (typeof value !== "string" || value.length !== 10) return null;
  if (value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45) return null;
  const year = digits(value, 0, 4);
  const month = digits(value, 5, 7);
  const day = digits(value, 8, 10);
  if (year < 2000 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Day number of the 1st of the month (Howard Hinnant's days-from-civil,
  // valid for the whole Gregorian calendar), plus the day of the month.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5);
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra + (day - 1);
}

/** Digits of text[from, to) as a number, or -1 when any is not 0-9. */
function digits(text, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return -1;
    n = n * 10 + c;
  }
  return n;
}
