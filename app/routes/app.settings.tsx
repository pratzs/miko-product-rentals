import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Select,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useState } from "react";

const CURRENCIES = [
  { label: "USD — US Dollar", value: "USD" },
  { label: "AUD — Australian Dollar", value: "AUD" },
  { label: "NZD — New Zealand Dollar", value: "NZD" },
  { label: "GBP — British Pound", value: "GBP" },
  { label: "EUR — Euro", value: "EUR" },
  { label: "CAD — Canadian Dollar", value: "CAD" },
  { label: "SGD — Singapore Dollar", value: "SGD" },
  { label: "INR — Indian Rupee", value: "INR" },
  { label: "JPY — Japanese Yen", value: "JPY" },
  { label: "MXN — Mexican Peso", value: "MXN" },
  { label: "BRL — Brazilian Real", value: "BRL" },
  { label: "ZAR — South African Rand", value: "ZAR" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const config = await db.shopConfig.findUnique({ where: { shop } });
  if (!config) return json({ config: null });
  return json({ config });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save_late_fees") {
    const gracePeriodDays = parseInt(formData.get("gracePeriodDays") as string) || 0;
    const lateFeePerDay = parseFloat(formData.get("lateFeePerDay") as string) || 0;
    const bufferHours = parseInt(formData.get("bufferHours") as string) || 0;
    const currency = formData.get("currency") as string;

    await db.shopConfig.updateMany({
      where: { shop },
      data: { gracePeriodDays, lateFeePerDay, bufferHours, currency },
    });
    return json({ success: true, message: "Rental settings saved." });
  }

  if (intent === "complete_onboarding") {
    await db.shopConfig.updateMany({
      where: { shop },
      data: { onboardingCompleted: true },
    });
    return json({ success: true, message: "Setup marked as complete." });
  }

  return json({ error: "Unknown action." }, { status: 400 });
};

export default function SettingsPage() {
  const { config } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const [currency, setCurrency] = useState(config?.currency || "USD");
  const [gracePeriodDays, setGracePeriodDays] = useState(String(config?.gracePeriodDays ?? 0));
  const [lateFeePerDay, setLateFeePerDay] = useState(String(config?.lateFeePerDay ?? 0));
  const [bufferHours, setBufferHours] = useState(String(config?.bufferHours ?? 24));

  if (!config) {
    return (
      <Page title="Settings">
        <Banner tone="critical" title="Store configuration not found. Please re-install the app." />
      </Page>
    );
  }

  return (
    <Page
      title="Settings"
      subtitle="Configure how your rental business operates."
    >
      <BlockStack gap="600">
        {actionData && "error" in actionData && (
          <Banner tone="critical" title={actionData.error} />
        )}
        {actionData && "message" in actionData && (
          <Banner tone="success" title={(actionData as any).message} />
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="600">
              {/* Rental behaviour */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Rental settings</Text>
                    <Text as="p" tone="subdued">
                      Control how late fees work and how far in advance bookings are blocked
                      before the calendar shows availability.
                    </Text>
                  </BlockStack>
                  <Divider />

                  <Select
                    label="Currency"
                    options={CURRENCIES}
                    value={currency}
                    onChange={setCurrency}
                    helpText="This is shown on pricing labels and invoices throughout the app."
                  />

                  <Divider />

                  <InlineStack gap="400" wrap>
                    <Box minWidth="180px">
                      <TextField
                        label="Grace period before late fees"
                        type="number"
                        value={gracePeriodDays}
                        onChange={setGracePeriodDays}
                        suffix="days"
                        min={0}
                        autoComplete="off"
                        helpText="How many days past the return date before late fees kick in. Set to 0 for no grace period."
                      />
                    </Box>
                    <Box minWidth="180px">
                      <TextField
                        label="Late fee per day"
                        type="number"
                        value={lateFeePerDay}
                        onChange={setLateFeePerDay}
                        prefix={currency}
                        min={0}
                        step={0.01}
                        autoComplete="off"
                        helpText="Extra charge per day the item is overdue. Set to 0 if you do not want to charge late fees."
                      />
                    </Box>
                    <Box minWidth="180px">
                      <TextField
                        label="Availability buffer"
                        type="number"
                        value={bufferHours}
                        onChange={setBufferHours}
                        suffix="hours"
                        min={0}
                        autoComplete="off"
                        helpText="Block this many hours after a booking ends before the next booking can start. Gives you time to clean and inspect the item."
                      />
                    </Box>
                  </InlineStack>

                  <InlineStack>
                    <Form method="POST">
                      <input type="hidden" name="intent" value="save_late_fees" />
                      <input type="hidden" name="currency" value={currency} />
                      <input type="hidden" name="gracePeriodDays" value={gracePeriodDays} />
                      <input type="hidden" name="lateFeePerDay" value={lateFeePerDay} />
                      <input type="hidden" name="bufferHours" value={bufferHours} />
                      <Button variant="primary" submit loading={saving}>Save rental settings</Button>
                    </Form>
                  </InlineStack>
                </BlockStack>
              </Card>

            </BlockStack>
          </Layout.Section>

          {/* Sidebar */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Setup status</Text>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span">{config.onboardingCompleted ? "✅" : "⬜"}</Text>
                    <Text as="p" tone="subdued">Onboarding complete</Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span">{config.currency ? "✅" : "⬜"}</Text>
                    <Text as="p" tone="subdued">Currency set</Text>
                  </InlineStack>
                </BlockStack>
                {!config.onboardingCompleted && (
                  <Form method="POST">
                    <input type="hidden" name="intent" value="complete_onboarding" />
                    <Button variant="secondary" submit fullWidth loading={saving}>
                      Mark setup as complete
                    </Button>
                  </Form>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
