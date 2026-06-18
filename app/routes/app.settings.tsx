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
  { label: "US Dollar (USD)", value: "USD" },
  { label: "Australian Dollar (AUD)", value: "AUD" },
  { label: "New Zealand Dollar (NZD)", value: "NZD" },
  { label: "British Pound (GBP)", value: "GBP" },
  { label: "Euro (EUR)", value: "EUR" },
  { label: "Canadian Dollar (CAD)", value: "CAD" },
  { label: "Singapore Dollar (SGD)", value: "SGD" },
  { label: "Indian Rupee (INR)", value: "INR" },
  { label: "Japanese Yen (JPY)", value: "JPY" },
  { label: "Mexican Peso (MXN)", value: "MXN" },
  { label: "Brazilian Real (BRL)", value: "BRL" },
  { label: "South African Rand (ZAR)", value: "ZAR" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const shopHandle = shop.replace(".myshopify.com", "");
  const config = await db.shopConfig.findUnique({ where: { shop } });
  if (!config) return json({ config: null, planName: "free" as string, shopHandle });
  return json({ config, planName: config.planName ?? "free", shopHandle });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save_branding") {
    const showPoweredBy = formData.get("showPoweredBy") === "true";
    await db.shopConfig.updateMany({
      where: { shop },
      data: { showPoweredBy },
    });
    return json({ success: true, message: "Branding preference saved." });
  }

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
  const { config, planName, shopHandle } = useLoaderData<typeof loader>();
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
  const [showPoweredBy, setShowPoweredBy] = useState(config?.showPoweredBy ?? false);

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

                  <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" fontWeight="semibold">How late fees flow through Miko</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        1. A rental's status flips to <strong>overdue</strong> automatically the day after its return date passes.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        2. The customer gets the <strong>Overdue Notice</strong> email, which shows your daily late fee rate.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        3. When the item is returned, open the booking and click <strong>Record late fee</strong>. We calculate it as <em>(days overdue minus grace period) times your daily rate</em> and save it on the booking.
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        4. To actually charge the customer, create a draft order in Shopify, add the late fee as a custom line item, and send the invoice. Miko never auto charges cards so you stay in control of every customer interaction.
                      </Text>
                    </BlockStack>
                  </Box>

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

              {/* Storefront display rules */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Storefront display</Text>
                    <Text as="p" tone="subdued">
                      Control how rental products appear to customers across your storefront -
                      hiding the regular price and Add to cart button so customers can only check
                      out through the rental flow.
                    </Text>
                  </BlockStack>
                  <Divider />
                  <BlockStack gap="300">
                    <Text as="p" variant="bodyMd">
                      These rules are managed through a sitewide app embed. Enable it once in your
                      theme editor and it applies to every rental product automatically - no need to
                      tag products one by one.
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      <strong>What you can hide:</strong> regular product price on the product page,
                      Add to cart button on the product page, and the price shown on rental cards
                      across collection or search results.
                    </Text>
                    <InlineStack gap="200">
                      <Button
                        url={`https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps&activateAppId=2306fcd511592e435b9b26ac07304811%2Frental-display-rules`}
                        target="_blank"
                        variant="primary"
                      >
                        Open theme editor to enable
                      </Button>
                      <Button
                        url={`https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps`}
                        target="_blank"
                      >
                        See all app embeds
                      </Button>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Tip: once the embed is on, each of the three rules (PDP price, PDP button,
                      collection price) has its own checkbox you can toggle independently.
                    </Text>
                  </BlockStack>

                  <Divider />

                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">Widget branding</Text>
                    {planName === "free" ? (
                      <BlockStack gap="300">
                        <Checkbox
                          label='Hide "Powered by Miko Rentals" credit on the storefront widget'
                          checked={false}
                          disabled
                          helpText="Available on the Starter plan and above. Free plan keeps the credit visible."
                          onChange={() => {}}
                        />
                        <Box>
                          <Button url="/app/pricing" variant="primary">
                            Upgrade to remove the credit
                          </Button>
                        </Box>
                      </BlockStack>
                    ) : (
                      <Form method="POST">
                        <input type="hidden" name="intent" value="save_branding" />
                        <input type="hidden" name="showPoweredBy" value={String(showPoweredBy)} />
                        <BlockStack gap="200">
                          <Checkbox
                            label='Hide "Powered by Miko Rentals" credit on the storefront widget'
                            checked={!showPoweredBy}
                            onChange={(checked) => setShowPoweredBy(!checked)}
                            helpText="Hidden by default on paid plans. Uncheck if you'd like to keep the credit visible."
                          />
                          <InlineStack>
                            <Button submit loading={saving}>Save branding</Button>
                          </InlineStack>
                        </BlockStack>
                      </Form>
                    )}
                  </BlockStack>
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
                        helpText="What customers see as the sender in their inbox. Usually your store name."
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
                      <Text as="p" tone="subdued">When a customer pays for a rental, they immediately get a booking confirmation with all the details.</Text>
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
