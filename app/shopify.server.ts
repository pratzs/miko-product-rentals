import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { db } from "./db.server";
import { ensureCartTransformActivated } from "./utils/cart-transform.server";
import { ensureRentalMetafieldDefinition } from "./utils/product-metafields.server";
import { ensureShopName, ensureShopCurrency } from "./utils/shop-info.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionStorage: new PrismaSessionStorage(db) as any,
  distribution: AppDistribution.AppStore,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  billing: {
    starter: {
      trialDays: 14,
      test: process.env.SHOPIFY_BILLING_TEST !== "false",
      lineItems: [{ amount: 19.95, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
    growth: {
      trialDays: 14,
      test: process.env.SHOPIFY_BILLING_TEST !== "false",
      lineItems: [{ amount: 49.95, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
    pro: {
      trialDays: 14,
      test: process.env.SHOPIFY_BILLING_TEST !== "false",
      lineItems: [{ amount: 89.95, currencyCode: "USD", interval: BillingInterval.Every30Days }],
    },
  } as any,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      shopify.registerWebhooks({ session });
      const { admin } = await shopify.unauthenticated.admin(session.shop);
      await ensureCartTransformActivated(admin, session.shop);
      await ensureRentalMetafieldDefinition(admin);
      await ensureShopName(admin, session.shop);
      await ensureShopCurrency(admin, session.shop);
      // Lifecycle emails: capture the owner's contact once, then send the
      // one-off welcome. Both idempotent and best-effort.
      try {
        const { captureMerchantContact, sendWelcomeEmail } = await import("./lifecycle-emails.server");
        await captureMerchantContact(admin, session.shop);
        await sendWelcomeEmail(session.shop);
      } catch (err) {
        console.warn("[afterAuth] lifecycle email step failed:", err);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

// In-process lifecycle-email scheduler (day-7 review requests). Idempotent
// sends guarded by sentAt timestamps; opt-out via DISABLE_IN_PROCESS_CRON.
import { startLifecycleScheduler } from "./lifecycle-emails.server";
startLifecycleScheduler();

