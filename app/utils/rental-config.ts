/**
 * The rental config the Cart Transform Function prices from: its metafield
 * address and its JSON shape. Pure (no database, no Shopify client) so the
 * tests can build the exact payload the server writes and feed it to the
 * function. See rental-config-metafields.server.ts for the why and the sync.
 */

export const RENTAL_CONFIG_NAMESPACE = "$app:miko_rentals";
export const RENTAL_CONFIG_KEY = "config";
export const RENTAL_CONFIG_VERSION = 1;

interface ProductRates {
  isActive: boolean;
  hasVariants: boolean;
  pricePerDay: number;
  pricePerWeek: number;
  pricePerMonth: number;
  depositAmount: number;
  minRentalDays: number;
  maxRentalDays: number;
}

interface VariantRates {
  isActive: boolean;
  pricePerDay: number;
  pricePerWeek: number;
  pricePerMonth: number;
  depositAmount: number;
}

// A rate the function will accept: a finite number, zero or more.
const rate = (n: number) => (typeof n === "number" && isFinite(n) && n >= 0 ? n : 0);
const days = (n: number, fallback: number) =>
  typeof n === "number" && isFinite(n) && n >= 0 ? Math.floor(n) : fallback;

export function buildProductRentalConfig(p: ProductRates) {
  return {
    v: RENTAL_CONFIG_VERSION,
    a: p.isActive === true,
    hv: p.hasVariants === true,
    d: rate(p.pricePerDay),
    w: rate(p.pricePerWeek),
    m: rate(p.pricePerMonth),
    dep: rate(p.depositAmount),
    min: days(p.minRentalDays, 1),
    max: days(p.maxRentalDays, 0),
  };
}

export function buildVariantRentalConfig(v: VariantRates) {
  return {
    v: RENTAL_CONFIG_VERSION,
    a: v.isActive === true,
    d: rate(v.pricePerDay),
    w: rate(v.pricePerWeek),
    m: rate(v.pricePerMonth),
    dep: rate(v.depositAmount),
  };
}
