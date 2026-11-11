import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useState, type ReactNode } from "react";
import { Banner, Grid, ProgressBar, flag } from "../components/polaris";
import { TWO_UP } from "../components/layout";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { PLANS, checkRentalLimit, getPlan } from "../utils/plans";
import { useT } from "../i18n/context";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await db.shopConfig.findUnique({ where: { shop } });
  const planName = config?.planName ?? "free";

  const isTest = process.env.SHOPIFY_BILLING_TEST !== "false";

  // Check active subscription with Shopify billing
  let activeSubscription: string | null = null;
  try {
    const billingCheck = await billing.check({
      plans: ["starter", "growth", "pro"],
      isTest,
    });
    if (billingCheck.hasActivePayment) {
      activeSubscription = billingCheck.appSubscriptions?.[0]?.name ?? null;
    }
  } catch {
    // No active subscription - that's fine
  }

  const limitCheck = await checkRentalLimit(shop, planName, db);

  return json({
    currentPlan: planName,
    activeSubscription,
    plans: PLANS,
    usage: {
      current: limitCheck.current,
      limit: limitCheck.limit,
      resetDate: limitCheck.resetDate?.toISOString() ?? null,
    },
  });
};

// action is a no-op - subscribe/cancel are handled via fetch() + Bearer token in the component.
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  return json({ ok: true });
};

export default function PricingPage() {
  const { currentPlan, plans, usage } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const t = useT();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentPlanDetails = getPlan(currentPlan);

  async function handleSubscribe(plan: string) {
    setLoading(plan);
    try {
      const tokenPromise = shopify.idToken();
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(t("This is taking longer than expected. Please refresh the page and try again."))), 8000),
      );
      const token = await Promise.race([tokenPromise, timeout]);
      const resp = await fetch(`/app/subscribe?plan=${plan}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const reauthUrl = resp.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url");
      if (reauthUrl) {
        if (window.top) window.top.location.href = reauthUrl;
        else window.location.href = reauthUrl;
      }
    } catch (err) {
      console.error("[billing] subscribe failed:", err);
      setError(err instanceof Error ? err.message : t("Something went wrong. Please refresh and try again."));
    } finally {
      setLoading(null);
    }
  }

  async function handleCancel() {
    const confirmed = window.confirm(
      t("Downgrade to the Free plan? You can upgrade again any time."),
    );
    if (!confirmed) return;
    setLoading("cancel");
    try {
      const tokenPromise = shopify.idToken();
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(t("This is taking longer than expected. Please refresh the page and try again."))), 8000),
      );
      const token = await Promise.race([tokenPromise, timeout]);
      await fetch("/app/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      window.location.reload();
    } catch (err) {
      console.error("[billing] cancel failed:", err);
      setError(err instanceof Error ? err.message : t("Something went wrong. Please refresh and try again."));
    } finally {
      setLoading(null);
    }
  }

  const submitting = loading !== null;

  const planFeatures: Record<string, string[]> = {
    free: [
      "Up to 10 total rentals (lifetime)",
      "All core rental features",
      "Rental calendar & availability",
      '"Product Rentals Pro" badge on storefront',
    ],
    starter: [
      "Up to 50 rentals per month",
      "Automated email notifications",
      "Remove PRB storefront branding",
      "BYO SMTP (send from your own domain)",
    ],
    growth: [
      "Up to 200 rentals per month",
      "Everything in Starter",
      "SMS notifications (coming soon)",
      "Subscription rental products (coming soon)",
    ],
    pro: [
      "Up to 500 rentals per month",
      "Everything in Growth",
      "Insurance & damage protection (coming soon)",
      "Priority support",
    ],
  };

  const popularPlan = "growth";

  // One plan card. Every value and button below is passed in per plan exactly
  // as the Polaris React version had it; only the drawing is shared.
  const featureList = (features: string[]) => (
    <s-unordered-list>
      {features.map((f) =>
        f.includes("coming soon") ? (
          <s-list-item key={f}>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text>{t(f.replace(" (coming soon)", ""))}</s-text>
              <s-badge tone="neutral">{t("Coming soon")}</s-badge>
            </s-stack>
          </s-list-item>
        ) : (
          <s-list-item key={f}>{t(f)}</s-list-item>
        ),
      )}
    </s-unordered-list>
  );

  const planCard = ({
    name,
    price,
    cadence,
    badge,
    features,
    usageLine,
    progress,
    action,
  }: {
    name: string;
    price: string;
    cadence: string;
    badge?: ReactNode;
    features: string[];
    usageLine: string;
    progress: number;
    action: ReactNode;
  }) => (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-heading>{name}</s-heading>
            {badge}
          </s-stack>
          <s-text fontSize="large-100" fontWeight="bold">{price}</s-text>
          <s-text color="subdued">{cadence}</s-text>
        </s-stack>
        <s-divider />
        {featureList(features)}
        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">{usageLine}</s-text>
          <ProgressBar progress={Math.min(100, progress)} label={usageLine} />
        </s-stack>
        <s-box>{action}</s-box>
      </s-stack>
    </s-section>
  );

  const currentPlanButton = <s-button disabled>{t("Current plan")}</s-button>;

  return (
    <s-page heading={t("Plans & Pricing")} inlineSize="large">
      <s-stack direction="block" gap="large">
        <s-text color="subdued">{t("Choose the plan that fits your rental business.")}</s-text>
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            <s-paragraph>{error}</s-paragraph>
          </Banner>
        )}

        {currentPlan !== "free" && (
          <Banner tone="success">
            <s-paragraph>
              {t("You're on the {plan} plan: {limit} rentals/month.", {
                plan: t(currentPlanDetails.name),
                limit: currentPlanDetails.rentalLimit,
              })}{" "}
              {usage.resetDate
                ? t("Resets on {date}.", { date: new Date(usage.resetDate).toLocaleDateString("en-NZ", { day: "numeric", month: "long" }) })
                : ""}
            </s-paragraph>
          </Banner>
        )}

        <Grid columns={TWO_UP} gap="base">
          {/* Row 1: Free + Starter */}
          {planCard({
            name: t("Free"),
            price: "$0",
            cadence: t("Forever free"),
            features: planFeatures.free,
            usageLine: t("{used} of {limit} lifetime rentals used", { used: usage.current, limit: plans.free.rentalLimit }),
            progress: currentPlan === "free" ? (usage.current / plans.free.rentalLimit) * 100 : 0,
            action:
              currentPlan === "free" ? (
                currentPlanButton
              ) : (
                <s-button variant="secondary" loading={flag(loading === "cancel")} onClick={handleCancel}>
                  {t("Downgrade to Free")}
                </s-button>
              ),
          })}

          {planCard({
            name: t("Starter"),
            price: "$19.95",
            cadence: t("per month"),
            features: planFeatures.starter,
            usageLine: t("{used} of {limit} rentals this month", { used: currentPlan === "starter" ? usage.current : 0, limit: plans.starter.rentalLimit }),
            progress: currentPlan === "starter" ? (usage.current / plans.starter.rentalLimit) * 100 : 0,
            action:
              currentPlan === "starter" ? (
                currentPlanButton
              ) : (
                <s-button variant="primary" loading={flag(loading === "starter")} disabled={flag(submitting)} onClick={() => handleSubscribe("starter")}>
                  {currentPlan === "free" ? t("Upgrade to Starter") : t("Switch to Starter")}
                </s-button>
              ),
          })}

          {/* Row 2: Growth + Pro */}
          {planCard({
            name: t("Growth"),
            price: "$49.95",
            cadence: t("per month"),
            badge: popularPlan === "growth" ? <s-badge tone="caution">{t("Popular")}</s-badge> : undefined,
            features: planFeatures.growth,
            usageLine: t("{used} of {limit} rentals this month", { used: currentPlan === "growth" ? usage.current : 0, limit: plans.growth.rentalLimit }),
            progress: currentPlan === "growth" ? (usage.current / plans.growth.rentalLimit) * 100 : 0,
            action:
              currentPlan === "growth" ? (
                currentPlanButton
              ) : (
                <s-button variant="primary" loading={flag(loading === "growth")} disabled={flag(submitting)} onClick={() => handleSubscribe("growth")}>
                  {currentPlan === "pro" ? t("Switch to Growth") : t("Upgrade to Growth")}
                </s-button>
              ),
          })}

          {planCard({
            name: t("Pro"),
            price: "$89.95",
            cadence: t("per month"),
            features: planFeatures.pro,
            usageLine: t("{used} of {limit} rentals this month", { used: currentPlan === "pro" ? usage.current : 0, limit: plans.pro.rentalLimit }),
            progress: currentPlan === "pro" ? (usage.current / plans.pro.rentalLimit) * 100 : 0,
            action:
              currentPlan === "pro" ? (
                currentPlanButton
              ) : (
                <s-button variant="primary" loading={flag(loading === "pro")} disabled={flag(submitting)} onClick={() => handleSubscribe("pro")}>
                  {t("Upgrade to Pro")}
                </s-button>
              ),
          })}
        </Grid>
      </s-stack>
    </s-page>
  );
}
