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
  FormLayout,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useState } from "react";

const CURRENCIES = [
  { label: "USD - US Dollar", value: "USD" },
  { label: "AUD - Australian Dollar", value: "AUD" },
  { label: "NZD - New Zealand Dollar", value: "NZD" },
  { label: "GBP - British Pound", value: "GBP" },
  { label: "EUR - Euro", value: "EUR" },
  { label: "CAD - Canadian Dollar", value: "CAD" },
  { label: "SGD - Singapore Dollar", value: "SGD" },
  { label: "INR - Indian Rupee", value: "INR" },
  { label: "JPY - Japanese Yen", value: "JPY" },
  { label: "MXN - Mexican Peso", value: "MXN" },
  { label: "BRL - Brazilian Real", value: "BRL" },
  { label: "ZAR - South African Rand", value: "ZAR" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const config = await db.shopConfig.findUnique({ where: { shop } });
  if (!config) return json({ config: null, planName: "free" as string });
  return json({ config, planName: config.planName ?? "free" });
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
    const senderName = (formData.get("senderName") as string).trim();
    const replyToEmail = (formData.get("replyToEmail") as string).trim();

    await db.shopConfig.updateMany({
      where: { shop },
      data: { senderName, replyToEmail },
    });
    return json({ success: true, message: "Email identity saved." });
  }

  if (intent === "save_smtp") {
    const smtpHost = (formData.get("smtpHost") as string) ?? "";
    const smtpPort = parseInt(formData.get("smtpPort") as string) || 587;
    const smtpUser = (formData.get("smtpUser") as string) ?? "";
    const smtpPass = (formData.get("smtpPass") as string) ?? "";
    const smtpFromEmail = (formData.get("smtpFromEmail") as string) ?? "";
    const smtpFromName = (formData.get("smtpFromName") as string) ?? "";
    const smtpSecure = formData.get("smtpSecure") === "true";
    await db.shopConfig.updateMany({
      where: { shop },
      data: { smtpHost, smtpPort, smtpUser, smtpPass, smtpFromEmail, smtpFromName, smtpSecure },
    });
    return json({ success: true, message: "SMTP settings saved." });
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
  const { config, planName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const [currency, setCurrency] = useState(config?.currency || "USD");
  const [gracePeriodDays, setGracePeriodDays] = useState(String(config?.gracePeriodDays ?? 0));
  const [lateFeePerDay, setLateFeePerDay] = useState(String(config?.lateFeePerDay ?? 0));
  const [bufferHours, setBufferHours] = useState(String(config?.bufferHours ?? 24));

  const [senderName, setSenderName] = useState(config?.senderName || "");
  const [replyToEmail, setReplyToEmail] = useState(config?.replyToEmail || "");

  const [smtpHost, setSmtpHost] = useState(config?.smtpHost || "");
  const [smtpPort, setSmtpPort] = useState(String(config?.smtpPort ?? 587));
  const [smtpUser, setSmtpUser] = useState(config?.smtpUser || "");
  const [smtpPass, setSmtpPass] = useState(config?.smtpPass || "");
  const [smtpFromEmail, setSmtpFromEmail] = useState(config?.smtpFromEmail || "");
  const [smtpFromName, setSmtpFromName] = useState(config?.smtpFromName || "");
  const [smtpSecure, setSmtpSecure] = useState(config?.smtpSecure ?? false);

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

              {/* Email identity */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Email identity</Text>
                    <Text as="p" tone="subdued">
                      Booking confirmations, return reminders, and overdue notices are sent
                      automatically on your behalf. Set how your business appears to customers.
                    </Text>
                  </BlockStack>
                  <Divider />

                  <InlineStack gap="400" wrap>
                    <Box minWidth="220px">
                      <TextField
                        label="Sender name"
                        value={senderName}
                        onChange={setSenderName}
                        autoComplete="off"
                        helpText="What customers see as the sender in their inbox - usually your store name."
                        placeholder="Kiwi Surf Gear"
                      />
                    </Box>
                    <Box minWidth="220px">
                      <TextField
                        label="Reply-to email"
                        value={replyToEmail}
                        onChange={setReplyToEmail}
                        type="email"
                        autoComplete="off"
                        helpText="Customer replies go here. Leave blank to use the default miko address."
                        placeholder="hello@yourdomain.com"
                      />
                    </Box>
                  </InlineStack>

                  <InlineStack>
                    <Form method="POST">
                      <input type="hidden" name="intent" value="save_email" />
                      <input type="hidden" name="senderName" value={senderName} />
                      <input type="hidden" name="replyToEmail" value={replyToEmail} />
                      <Button variant="primary" submit loading={saving}>Save</Button>
                    </Form>
                  </InlineStack>
                </BlockStack>
              </Card>
              {/* BYO SMTP - Starter+ only */}
              {planName !== "free" && (
                <Card>
                  <BlockStack gap="400">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">Custom email sender (SMTP)</Text>
                      <Text as="p" tone="subdued">
                        Send emails from your own domain using your email provider.
                      </Text>
                    </BlockStack>
                    <Divider />
                    <Banner tone="info">
                      Leave blank to use Miko&apos;s default sending address (noreply@miko.co.nz).
                      Fill in all fields to send from your own domain.
                    </Banner>
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField
                          label="SMTP host"
                          value={smtpHost}
                          onChange={setSmtpHost}
                          placeholder="smtp.gmail.com"
                          autoComplete="off"
                        />
                        <TextField
                          label="Port"
                          type="number"
                          value={smtpPort}
                          onChange={setSmtpPort}
                          placeholder="587"
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField
                          label="Username"
                          value={smtpUser}
                          onChange={setSmtpUser}
                          autoComplete="off"
                        />
                        <TextField
                          label="Password"
                          type="password"
                          value={smtpPass}
                          onChange={setSmtpPass}
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField
                          label="From email"
                          type="email"
                          value={smtpFromEmail}
                          onChange={setSmtpFromEmail}
                          placeholder="orders@yourdomain.com"
                          autoComplete="off"
                        />
                        <TextField
                          label="From name"
                          value={smtpFromName}
                          onChange={setSmtpFromName}
                          placeholder="Kiwi Surf Gear"
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                      <Checkbox
                        label="Use SSL/TLS (port 465)"
                        checked={smtpSecure}
                        onChange={setSmtpSecure}
                      />
                    </FormLayout>
                    <InlineStack>
                      <Form method="POST">
                        <input type="hidden" name="intent" value="save_smtp" />
                        <input type="hidden" name="smtpHost" value={smtpHost} />
                        <input type="hidden" name="smtpPort" value={smtpPort} />
                        <input type="hidden" name="smtpUser" value={smtpUser} />
                        <input type="hidden" name="smtpPass" value={smtpPass} />
                        <input type="hidden" name="smtpFromEmail" value={smtpFromEmail} />
                        <input type="hidden" name="smtpFromName" value={smtpFromName} />
                        <input type="hidden" name="smtpSecure" value={String(smtpSecure)} />
                        <Button variant="primary" submit loading={saving}>Save SMTP settings</Button>
                      </Form>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}
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
                      <Text as="p" tone="subdued">A customer pays for a rental - they immediately receive a booking confirmation with all the details.</Text>
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
                      <Text as="span">{config.senderName ? "✅" : "⬜"}</Text>
                      <Text as="p" tone="subdued">Email identity set</Text>
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
