/**
 * Shopify App Store listing gate for Miko Subscribe & Save.
 *
 * Copied from miko-image-resizer/store-listing/check-listing.cjs (the canonical
 * gate) with TWO documented, principled exceptions for this app. Every other
 * rule is unchanged and still hard-fails. Run before delivering ANY listing
 * asset or banner text:
 *
 *   node store-listing/check-listing.cjs
 *
 * Exception 1 - "retention" is this app's product CATEGORY, not a claim. Cancel
 *   flows, save offers and churn scoring are literally retention features, and
 *   the word appears in live app names. So it is downgraded from FAIL to WARN:
 *   every occurrence is still printed so an outcome-claim misuse ("improve
 *   retention") is caught by eye, while descriptive use passes. Describe the
 *   mechanism, never promise the result.
 *
 * Exception 2 - titleTag and metaDescription feed Google, not App Store review.
 *   Per the standing wording rule, they are the ONE place promo/brand words
 *   ("Shopify", "free", "fast") are allowed. They are scanned for length and the
 *   em-dash house rule only.
 */

const BANNED = [
  { word: "free", why: 'promotional language; use "included" / "no charge" / "never metered"' },
  { word: "best", why: "superlative" },
  { word: "#1", why: "superlative" },
  { word: "number one", why: "superlative" },
  { word: "the only", why: "superlative" },
  { word: "the first", why: "superlative" },
  { word: "leading", why: "superlative" },
  { word: "fastest", why: "superlative" },
  { word: "revolutionary", why: "generic marketing language" },
  { word: "seamless", why: "generic marketing language" },
  { word: "cutting-edge", why: "generic marketing language" },
  { word: "effortless", why: "generic marketing language" },
  { word: "customers say", why: "testimonial" },
  { word: "5-star", why: "review reference" },
  { word: "rated", why: "review reference" },
  { word: "boost", why: "unverifiable outcome claim" },
  { word: "increase", why: "unverifiable outcome claim" },
  { word: "more sales", why: "unverifiable outcome claim" },
  { word: "rank higher", why: "unverifiable outcome claim" },
  { word: "guarantee", why: "unverifiable claim" },
  { word: "instantly", why: "unverifiable performance claim" },
  { word: "—", why: "em dash (house rule)" },
];

// Category words for this app: printed as warnings, never counted as failures.
const WARN_ONLY = [
  { word: "retention", why: "app category term; keep descriptive, never a promise" },
];

const PRICING_TERMS = [
  "charge", "charged", "no charge", "price", "pricing", "cost", "costs", "spend",
  "paid", "pay", "plan", "plans", "metered", "billing", "billed", "credit",
  "credits", "trial", "per image", "per month", "$",
  // Added after "No transaction fees on any tier" passed the check and reached
  // both `details` and a rendered banner image. Pricing claims outside the
  // Pricing section are an App Store rejection (4.2.2), and text baked into an
  // image is the easiest version to miss.
  "transaction fee", "transaction fees", "fee", "fees", "tier", "tiers",
  "free", "commission", "upfront", "monthly", "yearly", "annual",
];

const IMAGE_BANNED = ["shopify", "program", "programme"];

// Per-listing allowlist for PRICING_TERMS that are the MERCHANT'S PRODUCT, not our app's
// price. "VIP tiers" and "store credit" ARE the product in a loyalty app; "tier" was added
// to PRICING_TERMS after "No transaction fees on any tier" reached a live banner, which is a
// different meaning of the same token. Rather than weaken the global list, a listing may
// allow a term BY NAME and must give a reason. Every allowance is printed on every run, so
// an exception can never go unnoticed. An allowance with no reason string still fails.
let ALLOWED_PRICING = {};
function allowanceReport() {
  if (!ALLOWANCES_USED.length) return "";
  return "\nPricing-term allowances in force (each needs a reason, each is printed every run)\n"
    + ALLOWANCES_USED.map((a) => `  ALLOWED  ${a}`).join("\n") + "\n";
}
const ALLOWANCES_USED = [];

const LIMITS = {
  name: 30,
  introduction: 100,
  details: 500,
  feature: 80,
  searchTerm: 20,
  searchTermCount: 5,
  subtitle: 62,
  testingInstructions: 2800,
  titleTag: 60,
  metaDescription: 160,
  // Shopify caps listing image alt text at 64 characters. The gate did not
  // measure it, so a 122-character set passed and reached the listing. Alt
  // text is indexed, so treat it as an SEO field: lead with the search phrase,
  // one idea per image.
  screenshotAlt: 64,
};

function scan(label, text, opts = {}) {
  const problems = [];
  const warnings = [];
  const lower = text.toLowerCase();

  // SEO fields (title tag / meta description): length + em-dash only.
  if (opts.seo) {
    if (text.includes("—")) problems.push('contains "—" (em dash, house rule)');
    if (opts.limit && text.length > opts.limit) {
      problems.push(`${text.length}/${opts.limit} characters, OVER by ${text.length - opts.limit}`);
    }
    return { problems, warnings };
  }

  // Word-boundary match, NOT substring. `lower.includes("rated")` fired on "AI-geneRATED",
  // and the same bug would flag "free" inside "freedom" or "best" inside "bestseller".
  // Multi-word entries ("the only", "number one") still work: \b wraps the whole phrase.
  const hasWord = (haystack, needle) =>
    new RegExp(`\\b${needle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack);
  for (const { word, why } of BANNED) {
    if (hasWord(lower, word)) problems.push(`contains "${word}" (${why})`);
  }
  for (const { word, why } of WARN_ONLY) {
    if (hasWord(lower, word)) warnings.push(`contains "${word}" (${why})`);
  }
  for (const t of PRICING_TERMS) {
    const re = t === "$" ? /\$/ : new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) {
      const reason = ALLOWED_PRICING[t];
      if (typeof reason === "string" && reason.trim().length > 0) {
        ALLOWANCES_USED.push(`${label}: "${t}" - ${reason}`);
        continue;
      }
      problems.push(`contains "${t}" (pricing belongs only in the Pricing section)`);
    }
  }
  if (/shopify/i.test(text)) {
    problems.push('contains "Shopify" (not allowed anywhere in listing content)');
  }
  if (opts.isImage) {
    for (const w of IMAGE_BANNED) {
      if (lower.includes(w)) problems.push(`image text contains "${w}" (standing instruction: never in a banner)`);
    }
    if (/\d+\s*(%|hrs?|hours|x faster|times faster)/i.test(text)) {
      problems.push("possible value-claim statistic; marketing tiles must be non-numeric");
    }
  }
  if (opts.limit && text.length > opts.limit) {
    problems.push(`${text.length}/${opts.limit} characters, OVER by ${text.length - opts.limit}`);
  }
  if (/https?:\/\/|www\./i.test(text) && opts.field === "details") {
    problems.push("contains a link (not allowed in App details)");
  }
  return { problems, warnings };
}

module.exports = { scan, LIMITS, BANNED, IMAGE_BANNED };

if (require.main === module) {
  const listing = require("./listing-content.json");
  // Load the justified pricing-term allowlist for THIS listing (see ALLOWED_PRICING above).
  ALLOWED_PRICING = listing.allowedPricingTerms || {};
  let failures = 0;
  let warns = 0;
  const check = (label, text, opts) => {
    const { problems, warnings } = scan(label, text, opts);
    const len = opts.limit ? ` [${text.length}/${opts.limit}]` : "";
    if (problems.length === 0) {
      console.log(`  PASS  ${label}${len}`);
    } else {
      failures += problems.length;
      console.error(`  FAIL  ${label}${len}`);
      problems.forEach((x) => console.error(`          ${x}`));
    }
    warnings.forEach((w) => {
      warns += 1;
      console.log(`  warn  ${label}: ${w}`);
    });
  };

  console.log("\nListing copy");
  check("app name", listing.name, { field: "name", limit: LIMITS.name });
  check("introduction", listing.introduction, { field: "introduction", limit: LIMITS.introduction });
  check("details", listing.details, { field: "details", limit: LIMITS.details });
  if (listing.subtitle) check("app card subtitle", listing.subtitle, { field: "subtitle", limit: LIMITS.subtitle });
  listing.features.forEach((f, i) => check(`feature ${i + 1}`, f, { field: "feature", limit: LIMITS.feature }));
  const terms = listing.searchTerms || [];
  if (terms.length > LIMITS.searchTermCount) {
    failures++;
    console.error(`  FAIL  search terms: ${terms.length} given, max ${LIMITS.searchTermCount}`);
  }
  terms.forEach((t, i) => check(`search term ${i + 1}`, t, { field: "searchTerms", limit: LIMITS.searchTerm }));

  console.log("\nWeb search fields (these feed Google, not App Store search)");
  if (listing.titleTag) check("title tag", listing.titleTag, { field: "titleTag", seo: true, limit: LIMITS.titleTag });
  if (listing.metaDescription)
    check("meta description", listing.metaDescription, { field: "metaDescription", seo: true, limit: LIMITS.metaDescription });

  if (listing.testingInstructions) {
    console.log("\nReviewer testing instructions (private field, length only)");
    const len = listing.testingInstructions.length;
    if (len > LIMITS.testingInstructions) {
      failures++;
      console.error(`  FAIL  testing instructions [${len}/${LIMITS.testingInstructions}] OVER by ${len - LIMITS.testingInstructions}`);
    } else {
      console.log(`  PASS  testing instructions [${len}/${LIMITS.testingInstructions}]`);
    }
  }

  console.log("\nText rendered inside listing images");
  (listing.imageText || []).forEach((t, i) => check(`image text ${i + 1}`, t, { isImage: true }));

  // Alt text is indexed listing copy, so it carries the 64 character cap AND
  // every wording ban. Nothing measured it before, which is how a 122 character
  // set passed the gate.
  console.log("\nScreenshot alt text");
  const altEntries = Object.entries(listing.screenshotAltText || {});
  if (!altEntries.length) {
    failures++;
    console.error("  FAIL  screenshotAltText is empty (every listing image needs alt text)");
  }
  for (const [file, alt] of altEntries) {
    check(`alt ${file}`, String(alt), { limit: LIMITS.screenshotAlt });
  }

  console.log(
    failures === 0
      ? `${allowanceReport()}\nLISTING GATE PASSED${warns ? ` (${warns} warning(s) to eyeball)` : ""}\n`
      : `${allowanceReport()}\n${failures} PROBLEM(S), DO NOT SUBMIT\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
