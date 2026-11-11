// Miko Cart Transform Function, purchase.cart-transform.run
//
// Rust port of src/index.js, which stays in the repo as the readable
// reference. The logic is a line for line equivalent; read the long comment
// at the top of index.js for WHAT it does and WHY (in short: a rental line's
// price is recomputed here from the merchant's rates in app-owned metafields,
// and nothing about the price is ever taken from the shopper-writable
// `_miko_data` cart property).
//
// WHY RUST: JavaScript on Shopify Functions is interpreted. Once the price had
// to be recomputed in the function, the JS build spent about 230,000
// instructions per rental line, and a cart of 50 rental lines went over the 11
// million cap. Going over the cap makes Shopify discard the whole output.
//
// Shopify Functions are WASI commands: JSON arrives on stdin, JSON leaves on
// stdout. We implement that contract directly.
//
// tests/cart-transform-parity.test.mjs runs thousands of carts through this
// binary and through index.js and requires identical output. Change the two
// together.

use serde::Deserialize;
use serde_json::Value;
use std::borrow::Cow;
use std::io::{self, Read, Write};

const PRODUCT_GID: &str = "gid://shopify/Product/";
/// Far above any real rental, far below where cents stop being exact.
const MAX_AMOUNT: f64 = 1e9;
/// 2^53: the largest whole number JavaScript prints digit for digit.
const MAX_SAFE_ID: f64 = 9007199254740992.0;

// ── Input (the shape requested by src/run.graphql) ──────────────────────────

#[derive(Deserialize)]
struct Input<'a> {
    #[serde(borrow)]
    cart: Cart<'a>,
}

#[derive(Deserialize)]
struct Cart<'a> {
    #[serde(borrow)]
    lines: Vec<Line<'a>>,
}

#[derive(Deserialize)]
struct Line<'a> {
    #[serde(borrow)]
    id: Cow<'a, str>,
    quantity: i64,
    #[serde(borrow, default)]
    merchandise: Option<Merchandise<'a>>,
    #[serde(borrow, default, rename = "mikoData")]
    miko_data: Option<Text<'a>>,
}

#[derive(Deserialize)]
struct Merchandise<'a> {
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, default, rename = "rentalConfig")]
    rental_config: Option<Text<'a>>,
    #[serde(borrow, default)]
    product: Option<Product<'a>>,
}

#[derive(Deserialize)]
struct Product<'a> {
    #[serde(borrow)]
    id: Cow<'a, str>,
    #[serde(borrow, default, rename = "rentalConfig")]
    rental_config: Option<Text<'a>>,
}

/// `{ value }` of a cart line attribute or a metafield.
#[derive(Deserialize)]
struct Text<'a> {
    #[serde(borrow, default)]
    value: Option<Cow<'a, str>>,
}

// ── Entry points ────────────────────────────────────────────────────────────

/// Shopify invokes this named wasm export once per cart evaluation (it is the
/// `export = "run"` declared in shopify.extension.toml).
#[no_mangle]
pub extern "C" fn run() {
    execute();
}

/// Also runnable as a plain command, which is how the parity test against the
/// JavaScript reference drives it locally.
fn main() {
    execute();
}

fn execute() {
    let mut raw = String::new();
    let mut out = String::from("{\"operations\":[");
    if io::stdin().read_to_string(&mut raw).is_ok() {
        if let Ok(input) = serde_json::from_str::<Input>(&raw) {
            let mut first = true;
            for line in &input.cart.lines {
                if let Some(amount) = price_line(line) {
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    write_operation(&mut out, line, &amount);
                }
            }
        }
    }
    out.push_str("]}");
    let mut stdout = io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

/// One `expand` operation: the rental line becomes ONE component, the same
/// variant, at a fixed price per unit. `expand` (not `update`) because Shopify
/// only honours `update` on Plus and development stores. The component keeps
/// `_miko_data` so the orders/create webhook still finds the booking.
fn write_operation(out: &mut String, line: &Line, amount: &str) {
    let variant_id = line
        .merchandise
        .as_ref()
        .and_then(|m| m.id.as_deref())
        .unwrap_or("");
    let raw = line
        .miko_data
        .as_ref()
        .and_then(|a| a.value.as_deref())
        .unwrap_or("");
    out.push_str("{\"expand\":{\"cartLineId\":");
    push_json_string(out, &line.id);
    out.push_str(",\"expandedCartItems\":[{\"merchandiseId\":");
    push_json_string(out, variant_id);
    out.push_str(",\"quantity\":1,\"price\":{\"adjustment\":{\"fixedPricePerUnit\":{\"amount\":\"");
    out.push_str(amount);
    out.push_str("\"}}},\"attributes\":[{\"key\":\"_miko_data\",\"value\":");
    push_json_string(out, raw);
    out.push_str("}]}]}}");
}

fn push_json_string(out: &mut String, text: &str) {
    match serde_json::to_string(text) {
        Ok(encoded) => out.push_str(&encoded),
        Err(_) => out.push_str("\"\""),
    }
}

// ── The pricing decision (mirrors `run` in index.js step for step) ──────────

/// The fixed price per unit to charge for this line, or None to leave the line
/// alone (the shopper then pays the variant's normal price).
fn price_line(line: &Line) -> Option<String> {
    let raw = line.miko_data.as_ref()?.value.as_deref()?;
    if raw.is_empty() {
        return None;
    }
    let variant = line.merchandise.as_ref()?;
    if variant.id.as_deref().unwrap_or("").is_empty() {
        return None;
    }
    if line.quantity < 1 {
        return None;
    }

    // 1. Merchant config. No active config on the product = not a rental =
    //    never repriced, whatever the line's attributes say.
    let product = variant.product.as_ref()?;
    let product_config = parse_config(product.rental_config.as_ref()?.value.as_deref()?)?;

    // 2. Multi-variant rentals are priced per variant, and a variant the
    //    merchant has not enabled is not rentable.
    let rates = if product_config.hv {
        parse_config(variant.rental_config.as_ref()?.value.as_deref()?)?
    } else {
        product_config
    };

    // `_miko_data` must be the plain shape the widget writes: a JSON object
    // of strings and numbers, with no backslash escapes and no nesting. See
    // parseRentalData in index.js for why (every parser that reads this value
    // must be guaranteed to see the same thing). A number too large for a
    // double is already a parse error in serde_json.
    if raw.contains('\\') {
        return None;
    }
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let data = parsed.as_object()?;
    if data.values().any(|v| v.is_array() || v.is_object()) {
        return None;
    }

    // 3. The booking must be for the product on this line. Webhook:
    //    `mikoData.productId || (mikoData.p ? gid + mikoData.p : "")`.
    let (from, text) = first_truthy(data.get("productId"), data.get("p"))?;
    let claimed_matches = match from {
        0 => text == product.id,
        1 => product
            .id
            .strip_prefix(PRODUCT_GID)
            .map_or(false, |tail| tail == text),
        _ => false,
    };
    if !claimed_matches {
        return None;
    }

    // 4. Dates. Webhook: `mikoData.startDate || mikoData.s`, same for end.
    let (_, start) = first_truthy(data.get("startDate"), data.get("s"))?;
    let (_, end) = first_truthy(data.get("endDate"), data.get("e"))?;
    let rental_days = day_number(&end)? - day_number(&start)?;
    if rental_days < 1 {
        return None;
    }
    if rental_days < product_config.min {
        return None;
    }
    if product_config.max > 0 && rental_days > product_config.max {
        return None;
    }

    // 5. Units. Webhook: `mikoData.u ?? mikoData.units`, and the cart quantity
    //    when neither is recorded.
    let recorded = match data.get("u") {
        Some(v) if !v.is_null() => Some(v),
        _ => match data.get("units") {
            Some(v) if !v.is_null() => Some(v),
            _ => None,
        },
    };
    let units = match recorded {
        Some(v) => whole_units(v)?,
        None => line.quantity,
    };

    // 6. Price for ONE unit, from merchant rates only, rounded to cents the
    //    way the widget rounded the `pu` it used to send.
    let unrounded = per_unit_price(&rates, rental_days);
    if !unrounded.is_finite() || unrounded >= 1e15 {
        return None;
    }
    let per_unit = cents_half_up(unrounded) as f64 / 100.0;
    if !(per_unit > 0.0) || per_unit > MAX_AMOUNT {
        return None;
    }

    // Lock the LINE TOTAL to units x per-unit price however the cart quantity
    // drifts: scale the per-unit price by units / quantity.
    let booking_total = units as f64 * per_unit;
    let scaled_per_unit = booking_total / line.quantity as f64;
    Some(to_fixed_2(scaled_per_unit))
}

#[derive(Clone, Copy)]
struct Config {
    hv: bool,
    d: f64,
    w: f64,
    m: f64,
    dep: f64,
    min: i64,
    max: i64,
}

/// Reads a `$app:miko_rentals.config` metafield. None unless it is a version 1
/// config that is switched on, every rate is a finite number that is zero or
/// more, and the day limits are whole numbers. An unknown version fails
/// closed (no repricing).
fn parse_config(raw: &str) -> Option<Config> {
    if raw.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let config = parsed.as_object()?;
    if config.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    if config.get("a") != Some(&Value::Bool(true)) {
        return None;
    }
    let hv = match config.get("hv") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    let min = match config.get("min") {
        None => 1,
        Some(v) => day_count(v)?,
    };
    let max = match config.get("max") {
        None => 0,
        Some(v) => day_count(v)?,
    };
    Some(Config {
        hv,
        d: rate(config.get("d"))?,
        w: rate(config.get("w"))?,
        m: rate(config.get("m"))?,
        dep: rate(config.get("dep"))?,
        min,
        max,
    })
}

fn rate(value: Option<&Value>) -> Option<f64> {
    let n = match value? {
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    if n.is_finite() && n >= 0.0 && n <= MAX_AMOUNT {
        Some(n)
    } else {
        None
    }
}

fn day_count(value: &Value) -> Option<i64> {
    let n = match value {
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    if n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= 100000.0 {
        Some(n as i64)
    } else {
        None
    }
}

/// JavaScript's `a || b` over two JSON values, but only for the shapes whose
/// meaning is beyond doubt. Returns (which operand won: 0, 1, or -1 for
/// neither, its text), or None to refuse the line.
///   - a non-empty string wins as itself,
///   - a whole number from 1 to 2^53 wins as its decimal digits,
///   - absent, null, "", 0 and false are falsy and fall through,
///   - anything else is truthy in JavaScript but meaningless here: refuse.
fn first_truthy<'v>(a: Option<&'v Value>, b: Option<&'v Value>) -> Option<(i8, Cow<'v, str>)> {
    for (index, value) in [a, b].into_iter().enumerate() {
        match value {
            None | Some(Value::Null) | Some(Value::Bool(false)) => continue,
            Some(Value::String(s)) => {
                if s.is_empty() {
                    continue;
                }
                return Some((index as i8, Cow::Borrowed(s.as_str())));
            }
            Some(Value::Number(n)) => {
                let f = n.as_f64()?;
                if f == 0.0 {
                    continue;
                }
                if f.fract() == 0.0 && f >= 1.0 && f <= MAX_SAFE_ID {
                    return Some((index as i8, Cow::Owned((f as u64).to_string())));
                }
                return None;
            }
            Some(_) => return None,
        }
    }
    Some((-1, Cow::Borrowed("")))
}

/// Units recorded in `_miko_data`: a whole number from 1 to 999, as a JSON
/// number or as a string of one to three digits. Anything else is refused.
fn whole_units(value: &Value) -> Option<i64> {
    let n = match value {
        Value::Number(n) => {
            let f = n.as_f64()?;
            if !(f.is_finite() && f.fract() == 0.0 && f >= 1.0 && f <= 999.0) {
                return None;
            }
            f as i64
        }
        Value::String(s) => {
            let bytes = s.as_bytes();
            if bytes.is_empty() || bytes.len() > 3 {
                return None;
            }
            digits(bytes)?
        }
        _ => return None,
    };
    if (1..=999).contains(&n) {
        Some(n)
    } else {
        None
    }
}

/// "YYYY-MM-DD", exactly ten characters, to a day count. Year 2000-2999,
/// month 01-12, day 01-31; a day past the end of a short month rolls into the next one, the
/// same as `new Date("2027-02-30")` in the webhook.
fn day_number(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year = digits(&b[0..4])?;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    if !(2000..=2999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Day number of the 1st of the month (Howard Hinnant's days-from-civil),
    // plus the day of the month.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146097 + day_of_era + (day - 1))
}

/// ASCII digits to a number, or None when any byte is not 0-9.
fn digits(bytes: &[u8]) -> Option<i64> {
    let mut n: i64 = 0;
    for &c in bytes {
        if !c.is_ascii_digit() {
            return None;
        }
        n = n * 10 + (c - b'0') as i64;
    }
    Some(n)
}

/// Rental fee plus deposit for one unit. The same arithmetic, in the same
/// order, as calculateRentalPrice in app/utils/pricing.ts: monthly rate first
/// when offered and the rental is 30+ days, then weekly at 7+ days, else
/// daily, with leftover days at the daily rate.
fn per_unit_price(rates: &Config, rental_days: i64) -> f64 {
    let per_unit_rental = if rates.m > 0.0 && rental_days >= 30 {
        (rental_days / 30) as f64 * rates.m + (rental_days % 30) as f64 * rates.d
    } else if rates.w > 0.0 && rental_days >= 7 {
        (rental_days / 7) as f64 * rates.w + (rental_days % 7) as f64 * rates.d
    } else {
        rental_days as f64 * rates.d
    };
    per_unit_rental + rates.dep
}

/// x * 100 rounded to the nearest whole number, halves up, computed on the
/// EXACT binary value of x. This is precisely what JavaScript's
/// Number.prototype.toFixed(2) does, so amounts match the JS reference (and
/// the function this replaces) to the cent. `x` must be finite, zero or more,
/// and below 1e15.
fn cents_half_up(x: f64) -> u128 {
    let bits = x.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    // x = mantissa * 2^power
    let (mantissa, power) = if exponent == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1u64 << 52), exponent - 1075)
    };
    let scaled = mantissa as u128 * 100;
    if power >= 0 {
        scaled << power
    } else {
        let shift = (-power) as u32;
        if shift > 120 {
            0
        } else {
            (scaled + (1u128 << (shift - 1))) >> shift
        }
    }
}

/// JavaScript's `x.toFixed(2)` for a finite x that is zero or more.
fn to_fixed_2(x: f64) -> String {
    let cents = cents_half_up(x);
    format!("{}.{:02}", cents / 100, cents % 100)
}
