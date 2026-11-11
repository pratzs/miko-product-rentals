/**
 * "Would checkout have priced this order line as a rental?"
 *
 * The Cart Transform Function only reprices a line whose rental data passes
 * its rules (active rental, right product, plain dates inside the merchant's
 * limits, sane units). A line that fails them is charged the variant's normal
 * price. The order webhook reads the same `_miko_data` afterwards, and must
 * not record a normal, confirmed rental booking for a line that checkout
 * never charged as one.
 *
 * Rather than restate those rules here (three copies would drift), this runs
 * the function's own reference implementation on a one-line cart rebuilt from
 * the order line and the merchant's current settings. Same code, same answer.
 */
import runCartTransform from "../../extensions/miko-cart-transform/src/index.js";
import { buildProductRentalConfig, buildVariantRentalConfig } from "./rental-config";

type ProductSettings = Parameters<typeof buildProductRentalConfig>[0];
type VariantSettings = Parameters<typeof buildVariantRentalConfig>[0];

export function checkoutWouldPriceAsRental(args: {
  /** The raw `_miko_data` property value from the order line. */
  rawRentalData: string;
  lineQuantity: number;
  /** gid of the product that was actually ordered on the line. */
  lineProductGid: string;
  /** gid of the variant that was actually ordered, when the payload has it. */
  lineVariantGid: string | null;
  product: ProductSettings;
  /** The RentalVariant row for the ordered variant, if there is one. */
  variant: VariantSettings | null;
}): boolean {
  const output = (runCartTransform as (input: unknown) => { operations: unknown[] })({
    cart: {
      lines: [
        {
          id: "gid://shopify/CartLine/order-line",
          quantity: Math.max(1, Math.floor(args.lineQuantity) || 1),
          merchandise: {
            id: args.lineVariantGid || "gid://shopify/ProductVariant/unknown",
            rentalConfig: args.variant
              ? { value: JSON.stringify(buildVariantRentalConfig(args.variant)) }
              : null,
            product: {
              id: args.lineProductGid,
              rentalConfig: { value: JSON.stringify(buildProductRentalConfig(args.product)) },
            },
          },
          mikoData: { value: args.rawRentalData },
        },
      ],
    },
  });
  return output.operations.length === 1;
}
