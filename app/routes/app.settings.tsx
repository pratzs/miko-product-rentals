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
  Checkbox,
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

  if (intent === "save_email") {
    const resendApiKey = (formData.get("resendApiKey") as string).trim();
    const senderEmail = (formData.get("senderEmail") as string).trim();
    const senderName = (formData.get("senderName") as string).trim();
    const supportEmail = (formData.get("supportEmail") as string).trim();

    if (!senderEmail || !senderName) {
      return json({ error: "Sender email and name are required." }, { status: 400 });
    }

    await db.shopConfig.updateMany({
      where: { shop },
      data: { resendApiKey, senderEmail, senderName, supportEmail },
    });
    return json({ success: true, message: "Email settings saved." });
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

  const [resendApiKey, setResendApiKey] = useState(config?.resendApiKey || "");
  const [senderEmail, setSenderEmail] = useState(config?.senderEmail || "");
  const [senderName, setSenderName] = useState(config?.senderName || "");
  const [supportEmail, setSupportEmail] = useState(config?.supportEmail || "");

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

              {/* Email settings */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Email notifications</Text>
                    <Text as="p" tone="subdued">
                      Miko Rentals automatically emails your customers when a booking is confirmed,
                      the day before a return is due, and when a booking goes overdue.
                      You need a free Resend account to send these emails.
                    </Text>
                  </BlockStack>
                  <Divider />

                  <TextField
                    label="Resend API key"
                    value={resendApiKey}
                    onChange={setResendApiKey}
                    type="password"
                    autoComplete="off"
                    helpText={
                      <span>
                        Get your free API key at resend.com. Leave blank to disable email notifications.
                      </span>
                    }
                    placeholder="re_xxxxxxxxxxxxxxxxxxxx"
                  />

                  <InlineStack gap="400" wrap>
                    <Box minWidth="220px">
                      <TextField
                        label="Sender email address"
                        value={senderEmail}
                        onChange={setSenderEmail}
                        type="email"
                        autoComplete="off"
                        helpText="The email address your customers see in their inbox. Must be verified in Resend."
                        placeholder="rentals@yourdomain.com"
                      />
                    </Box>
                    <Box minWidth="220px">
                      <TextField
                        label="Sender name"
                        value={senderName}
                        onChange={setSenderName}
                        autoComplete="off"
                        helpText="The display name your customers see — usually your store or business name."
                        placeholder="Acme Rentals"
                      />
                    </Box>
                  </InlineStack>

                  <TextField
                    label="Support email (shown to customers)"
                    value={supportEmail}
                    onChange={setSupportEmail}
                    type="email"
                    autoComplete="off"
                    helpText="Customers can reply to this address if they have questions about their booking."
                    placeholder="hello@yourdomain.com"
                  />

                  <InlineStack>
                    <Form method="POST">
                      <input type="hidden" name="intent" value="save_email" />
                      <input type="hidden" name="resendApiKey" value={resendApiKey} />
                      <input type="hidden" name="senderEmail" value={senderEmail} />
                      <input type="hidden" name="senderName" value={senderName} />
                      <input type="hidden" name="supportEmail" value={supportEmail} />
                      <Button variant="primary" submit loading={saving}>Save email settings</Button>
                    </Form>
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          {/* Sidebar */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">How emails work</Text>
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="start">
                      <Text as="span" fontWeight="bold">1.</Text>
                      <Text as="p" tone="subdued">A customer pays for a rental — they immediately receive a booking confirmation with all the details.</Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="start">
                      <Text as="span" fontWeight="bold">2.</Text>
                      <Text as="p" tone="subdued">The day before the return date, they get a friendly reminder with the return instructions.</Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="start">
                      <Text as="span" fontWeight="bold">3.</Text>
                      <Text as="p" tone="subdued">If the item isn't returned on time, they receive an overdue notice with any applicable late fees.</Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="start">
                      <Text as="span" fontWeight="bold">4.</Text>
                      <Text as="p" tone="subdued">You can also manually trigger a reminder or overdue notice from any booking's detail page.</Text>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Setup status</Text>
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span">{config.onboardingCompleted ? "✅" : "⬜"}</Text>
                      <Text as="p" tone="subdued">Onboarding complete</Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span">{config.resendApiKey ? "✅" : "⬜"}</Text>
                      <Text as="p" tone="subdued">Email configured</Text>
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
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
