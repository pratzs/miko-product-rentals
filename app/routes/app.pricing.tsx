import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Badge,
  Divider,
  ProgressBar,
  List,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { PLANS, checkRentalLimit, getPlan } from "../utils/plans";

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
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentPlanDetails = getPlan(currentPlan);

  async function handleSubscribe(plan: string) {
    setLoading(plan);
    try {
      const tokenPromise = shopify.idToken();
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("App Bridge token timeout - please refresh the page.")), 8000),
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
      setError(err instanceof Error ? err.message : "Something went wrong. Please refresh and try again.");
    } finally {
      setLoading(null);
    }
  }

  async function handleCancel() {
    const confirmed = window.confirm(
      "Downgrade to the Free plan? You can upgrade again any time.",
    );
    if (!confirmed) return;
    setLoading("cancel");
    try {
      const tokenPromise = shopify.idToken();
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("App Bridge token timeout - please refresh the page.")), 8000),
      );
      const token = await Promise.race([tokenPromise, timeout]);
      await fetch("/app/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      window.location.reload();
    } catch (err) {
      console.error("[billing] cancel failed:", err);
      setError(err instanceof Error ? err.message : "Something went wrong. Please refresh and try again.");
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

  return (
    <Page
      title="Plans & Pricing"
      subtitle="Choose the plan that fits your rental business."
    >
      <BlockStack gap="600">
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            <Text as="p">{error}</Text>
          </Banner>
        )}

        {currentPlan !== "free" && (
          <Banner tone="success">
            <Text as="p">
              You&apos;re on the <strong>{currentPlanDetails.name}</strong> plan -{" "}
              {currentPlanDetails.rentalLimit} rentals/month.{" "}
              {usage.resetDate
                ? `Resets on ${new Date(usage.resetDate).toLocaleDateString("en-NZ", { day: "numeric", month: "long" })}.`
                : ""}
            </Text>
          </Banner>
        )}

        <Layout>
          {/* Row 1: Free + Starter */}
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    Free
                  </Text>
                  <Text as="p" variant="headingXl">
                    $0
                  </Text>
                  <Text as="p" tone="subdued">
                    Forever free
                  </Text>
                </BlockStack>
                <Divider />
                <List type="bullet">
                  {planFeatures.free.map((f) => (
                    <List.Item key={f}>{f}</List.Item>
                  ))}
                </List>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    {usage.current} of {plans.free.rentalLimit} lifetime rentals used
                  </Text>
                  <ProgressBar
                    progress={Math.min(
                      100,
                      currentPlan === "free"
                        ? (usage.current / plans.free.rentalLimit) * 100
                        : 0,
                    )}
                    tone="highlight"
                    size="small"
                  />
                </BlockStack>
                {currentPlan === "free" ? (
                  <Button disabled>Current plan</Button>
                ) : (
                  <Button variant="secondary" loading={loading === "cancel"} onClick={handleCancel}>
                    Downgrade to Free
                  </Button>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    Starter
                  </Text>
                  <Text as="p" variant="headingXl">
                    $19.95
                  </Text>
                  <Text as="p" tone="subdued">
                    per month
                  </Text>
                </BlockStack>
                <Divider />
                <List type="bullet">
                  {planFeatures.starter.map((f) => (
                    <List.Item key={f}>{f}</List.Item>
                  ))}
                </List>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    {currentPlan === "starter" ? usage.current : 0} of{" "}
                    {plans.starter.rentalLimit} rentals this month
                  </Text>
                  <ProgressBar
                    progress={Math.min(
                      100,
                      currentPlan === "starter"
                        ? (usage.current / plans.starter.rentalLimit) * 100
                        : 0,
                    )}
                    tone="highlight"
                    size="small"
                  />
                </BlockStack>
                {currentPlan === "starter" ? (
                  <Button disabled>Current plan</Button>
                ) : (
                  <Button variant="primary" loading={loading === "starter"} disabled={submitting} onClick={() => handleSubscribe("starter")}>
                    {currentPlan === "free" ? "Upgrade to Starter" : "Switch to Starter"}
                  </Button>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Row 2: Growth + Pro */}
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingLg">
                    Growth
                  </Text>
                  {popularPlan === "growth" && (
                    <Badge tone="attention">Popular</Badge>
                  )}
                </InlineStack>
                <BlockStack gap="100">
                  <Text as="p" variant="headingXl">
                    $49.95
                  </Text>
                  <Text as="p" tone="subdued">
                    per month
                  </Text>
                </BlockStack>
                <Divider />
                <List type="bullet">
                  {planFeatures.growth.map((f) =>
                    f.includes("coming soon") ? (
                      <List.Item key={f}>
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span">{f.replace(" (coming soon)", "")}</Text>
                          <Badge tone="new">Coming soon</Badge>
                        </InlineStack>
                      </List.Item>
                    ) : (
                      <List.Item key={f}>{f}</List.Item>
                    ),
                  )}
                </List>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    {currentPlan === "growth" ? usage.current : 0} of{" "}
                    {plans.growth.rentalLimit} rentals this month
                  </Text>
                  <ProgressBar
                    progress={Math.min(
                      100,
                      currentPlan === "growth"
                        ? (usage.current / plans.growth.rentalLimit) * 100
                        : 0,
                    )}
                    tone="highlight"
                    size="small"
                  />
                </BlockStack>
                {currentPlan === "growth" ? (
                  <Button disabled>Current plan</Button>
                ) : (
                  <Button variant="primary" loading={loading === "growth"} disabled={submitting} onClick={() => handleSubscribe("growth")}>
                    {currentPlan === "pro" ? "Switch to Growth" : "Upgrade to Growth"}
                  </Button>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    Pro
                  </Text>
                  <Text as="p" variant="headingXl">
                    $89.95
                  </Text>
                  <Text as="p" tone="subdued">
                    per month
                  </Text>
                </BlockStack>
                <Divider />
                <List type="bullet">
                  {planFeatures.pro.map((f) =>
                    f.includes("coming soon") ? (
                      <List.Item key={f}>
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span">{f.replace(" (coming soon)", "")}</Text>
                          <Badge tone="new">Coming soon</Badge>
                        </InlineStack>
                      </List.Item>
                    ) : (
                      <List.Item key={f}>{f}</List.Item>
                    ),
                  )}
                </List>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued">
                    {currentPlan === "pro" ? usage.current : 0} of{" "}
                    {plans.pro.rentalLimit} rentals this month
                  </Text>
                  <ProgressBar
                    progress={Math.min(
                      100,
                      currentPlan === "pro"
                        ? (usage.current / plans.pro.rentalLimit) * 100
                        : 0,
                    )}
                    tone="highlight"
                    size="small"
                  />
                </BlockStack>
                {currentPlan === "pro" ? (
                  <Button disabled>Current plan</Button>
                ) : (
                  <Button variant="primary" loading={loading === "pro"} disabled={submitting} onClick={() => handleSubscribe("pro")}>
                    Upgrade to Pro
                  </Button>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

      </BlockStack>
    </Page>
  );
}
