import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, useNavigate, Form } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { useRef, useState, type ReactNode } from "react";
import { Banner, Checkbox, Grid, Select, TextField, flag, useCustomEvent } from "../components/polaris";
import { MAIN_WITH_SIDEBAR, TWO_UP } from "../components/layout";
import { useT } from "../i18n/context";

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
  // Explicit select: the loader payload is sent to the browser, so it must
  // carry only what this page shows. The row also holds secrets (the SMTP
  // password, and formerly a copy of the Admin API token) that must never
  // leave the server. The page gets a "password is set" flag instead.
  const row = await db.shopConfig.findUnique({
    where: { shop },
    select: {
      planName: true,
      currency: true,
      gracePeriodDays: true,
      lateFeePerDay: true,
      bufferHours: true,
      onboardingCompleted: true,
      showPoweredBy: true,
      senderName: true,
      replyToEmail: true,
      smtpHost: true,
      smtpPort: true,
      smtpUser: true,
      smtpPass: true,
      smtpFromEmail: true,
      smtpFromName: true,
      smtpSecure: true,
    },
  });
  if (!row) return json({ config: null, planName: "free" as string, shopHandle });
  const { smtpPass: storedSmtpPass, ...safe } = row;
  const config = { ...safe, hasSmtpPass: storedSmtpPass !== "" };
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
    // The stored password is never sent to the browser, so the field arrives
    // empty unless the merchant typed a new one. Empty = keep what is stored.
    const smtpPass = (formData.get("smtpPass") as string) ?? "";
    const smtpFromEmail = (formData.get("smtpFromEmail") as string) ?? "";
    const smtpFromName = (formData.get("smtpFromName") as string) ?? "";
    const smtpSecure = formData.get("smtpSecure") === "true";
    await db.shopConfig.updateMany({
      where: { shop },
      data: {
        smtpHost,
        smtpPort,
        smtpUser,
        ...(smtpPass !== "" ? { smtpPass } : {}),
        smtpFromEmail,
        smtpFromName,
        smtpSecure,
      },
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

/**
 * Password field. Local because the shared TextField adapter has no password
 * type. Controlled like the others; no `name`, the form submits a hidden input.
 */
function PasswordField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useCustomEvent(ref, "input", (e) => {
    onChange(String((e.currentTarget as unknown as { value?: string }).value ?? ""));
  });
  return (
    <s-password-field
      ref={ref as never}
      label={label}
      value={value}
      placeholder={placeholder}
      autocomplete="new-password"
    />
  );
}

/** Card heading plus supporting line, the shape every settings card opens with. */
function CardIntro({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <s-stack direction="block" gap="small-300">
      <s-heading>{heading}</s-heading>
      <s-paragraph color="subdued">{children}</s-paragraph>
    </s-stack>
  );
}

export default function SettingsPage() {
  const { config, planName, shopHandle } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const t = useT();
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
  // Starts empty: the saved password stays on the server. Typing here sets a
  // new one; leaving it empty keeps the saved one.
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFromEmail, setSmtpFromEmail] = useState(config?.smtpFromEmail || "");
  const [smtpFromName, setSmtpFromName] = useState(config?.smtpFromName || "");
  const [smtpSecure, setSmtpSecure] = useState(config?.smtpSecure ?? false);
  const [showPoweredBy, setShowPoweredBy] = useState(config?.showPoweredBy ?? false);

  if (!config) {
    return (
      <s-page heading={t("Settings")} inlineSize="large">
        <Banner tone="critical" title={t("Store configuration not found. Please re-install the app.")} />
      </s-page>
    );
  }

  return (
    <s-page heading={t("Settings")} inlineSize="large">
      <s-stack direction="block" gap="large">
        <s-text color="subdued">{t("Configure how your rental business operates.")}</s-text>
        {actionData && "error" in actionData && (
          <Banner tone="critical" title={actionData.error} />
        )}
        {actionData && "message" in actionData && (
          <Banner tone="success" title={(actionData as any).message} />
        )}

        <Grid columns={MAIN_WITH_SIDEBAR} gap="large">
          <s-stack direction="block" gap="large">
            {/* Rental behavior */}
            <s-section>
              <s-stack direction="block" gap="base">
                <CardIntro heading={t("Rental settings")}>
                  {t("Control how late fees work and how far in advance bookings are blocked before the calendar shows availability.")}
                </CardIntro>
                <s-divider />

                <Select
                  label={t("Currency")}
                  options={CURRENCIES.map((c) => ({ ...c, label: t(c.label) }))}
                  value={currency}
                  onChange={setCurrency}
                  details={t("This is shown on pricing labels and invoices throughout the app.")}
                />

                <s-divider />

                <s-stack direction="inline" gap="base">
                  <s-box minInlineSize="180px">
                    <TextField
                      label={t("Grace period before late fees")}
                      type="number"
                      value={gracePeriodDays}
                      onChange={setGracePeriodDays}
                      suffix={t("days")}
                      min={0}
                      autoComplete="off"
                      details={t("How many days past the return date before late fees kick in. Set to 0 for no grace period.")}
                    />
                  </s-box>
                  <s-box minInlineSize="180px">
                    <TextField
                      label={t("Late fee per day")}
                      type="number"
                      value={lateFeePerDay}
                      onChange={setLateFeePerDay}
                      prefix={currency}
                      min={0}
                      step={0.01}
                      autoComplete="off"
                      details={t("Extra charge per day the item is overdue. Set to 0 if you do not want to charge late fees.")}
                    />
                  </s-box>
                  <s-box minInlineSize="180px">
                    <TextField
                      label={t("Availability buffer")}
                      type="number"
                      value={bufferHours}
                      onChange={setBufferHours}
                      suffix={t("hours")}
                      min={0}
                      autoComplete="off"
                      details={t("Block this many hours after a booking ends before the next booking can start. Gives you time to clean and inspect the item. Bookings are by the day, so this rounds up to whole days. Set to 0 for back to back bookings.")}
                    />
                  </s-box>
                </s-stack>

                <s-box background="subdued" borderRadius="base" padding="small">
                  <s-stack direction="block" gap="small-300">
                    <s-text type="strong">{t("How late fees flow through Miko")}</s-text>
                    <s-paragraph color="subdued">
                      {t("1. A rental's status flips to")} <s-text type="strong">{t("overdue")}</s-text> {t("automatically the day after its return date passes.")}
                    </s-paragraph>
                    <s-paragraph color="subdued">
                      {t("2. The customer gets the")} <s-text type="strong">{t("Overdue Notice")}</s-text> {t("email, which shows your daily late fee rate.")}
                    </s-paragraph>
                    <s-paragraph color="subdued">
                      {t("3. When the item is returned, open the booking and click")} <s-text type="strong">{t("Record late fee")}</s-text>{t(". We calculate it as")} <em>{t("(days overdue minus grace period) times your daily rate")}</em> {t("and save it on the booking.")}
                    </s-paragraph>
                    <s-paragraph color="subdued">
                      {t("4. To actually charge the customer, create a draft order in Shopify, add the late fee as a custom line item, and send the invoice. Miko never auto charges cards so you stay in control of every customer interaction.")}
                    </s-paragraph>
                  </s-stack>
                </s-box>

                <Form method="POST">
                  <input type="hidden" name="intent" value="save_late_fees" />
                  <input type="hidden" name="currency" value={currency} />
                  <input type="hidden" name="gracePeriodDays" value={gracePeriodDays} />
                  <input type="hidden" name="lateFeePerDay" value={lateFeePerDay} />
                  <input type="hidden" name="bufferHours" value={bufferHours} />
                  <s-button variant="primary" type="submit" loading={flag(saving)}>{t("Save rental settings")}</s-button>
                </Form>
              </s-stack>
            </s-section>

            {/* Storefront display rules */}
            <s-section>
              <s-stack direction="block" gap="base">
                <CardIntro heading={t("Storefront display")}>
                  {t("Control how rental products appear to customers across your storefront - hiding the regular price and Add to cart button so customers can only check out through the rental flow.")}
                </CardIntro>
                <s-divider />
                <s-stack direction="block" gap="small">
                  <s-paragraph>
                    {t("These rules are managed through a sitewide app embed. Enable it once in your theme editor and it applies to every rental product automatically - no need to tag products one by one.")}
                  </s-paragraph>
                  <s-paragraph color="subdued">
                    <s-text type="strong">{t("What you can hide:")}</s-text> {t("regular product price on the product page, Add to cart button on the product page, and the price shown on rental cards across collection or search results.")}
                  </s-paragraph>
                  <s-stack direction="inline" gap="small-200">
                    <s-button
                      href={`https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps&activateAppId=2306fcd511592e435b9b26ac07304811%2Frental-display-rules`}
                      target="_blank"
                      variant="primary"
                    >
                      {t("Open theme editor to enable")}
                    </s-button>
                    <s-button
                      href={`https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps`}
                      target="_blank"
                    >
                      {t("See all app embeds")}
                    </s-button>
                  </s-stack>
                  <s-paragraph color="subdued">
                    {t("Tip: once the embed is on, each of the three rules (PDP price, PDP button, collection price) has its own checkbox you can toggle independently.")}
                  </s-paragraph>
                </s-stack>

                <s-divider />

                <s-stack direction="block" gap="small">
                  <s-heading>{t("Widget branding")}</s-heading>
                  {planName === "free" ? (
                    <s-stack direction="block" gap="small">
                      <Checkbox
                        label={t('Hide "Powered by Miko Rentals" credit on the storefront widget')}
                        checked={false}
                        disabled
                        details={t("Available on the Starter plan and above. Free plan keeps the credit visible.")}
                        onChange={() => {}}
                      />
                      <s-box>
                        <s-button variant="primary" onClick={() => navigate("/app/pricing")}>
                          {t("Upgrade to remove the credit")}
                        </s-button>
                      </s-box>
                    </s-stack>
                  ) : (
                    <Form method="POST">
                      <input type="hidden" name="intent" value="save_branding" />
                      <input type="hidden" name="showPoweredBy" value={String(showPoweredBy)} />
                      <s-stack direction="block" gap="small-200">
                        <Checkbox
                          label={t('Hide "Powered by Miko Rentals" credit on the storefront widget')}
                          checked={!showPoweredBy}
                          onChange={(checked) => setShowPoweredBy(!checked)}
                          details={t("Hidden by default on paid plans. Uncheck if you'd like to keep the credit visible.")}
                        />
                        <s-box>
                          <s-button type="submit" loading={flag(saving)}>{t("Save branding")}</s-button>
                        </s-box>
                      </s-stack>
                    </Form>
                  )}
                </s-stack>
              </s-stack>
            </s-section>

            {/* Email identity */}
            <s-section>
              <s-stack direction="block" gap="base">
                <CardIntro heading={t("Email identity")}>
                  {t("Booking confirmations, return reminders, and overdue notices are sent automatically on your behalf. Set how your business appears to customers.")}
                </CardIntro>
                <s-divider />

                <Grid columns={TWO_UP} gap="base">
                  <TextField
                    label={t("Sender name")}
                    value={senderName}
                    onChange={setSenderName}
                    autoComplete="off"
                    details={t("What customers see as the sender in their inbox. Usually your store name.")}
                    placeholder={t("Kiwi Surf Gear")}
                  />
                  <TextField
                    label={t("Reply-to email")}
                    value={replyToEmail}
                    onChange={setReplyToEmail}
                    type="email"
                    autoComplete="off"
                    details={t("Customer replies go here. Leave blank to use the default miko address.")}
                    placeholder="hello@yourdomain.com"
                  />
                </Grid>

                <Form method="POST">
                  <input type="hidden" name="intent" value="save_email" />
                  <input type="hidden" name="senderName" value={senderName} />
                  <input type="hidden" name="replyToEmail" value={replyToEmail} />
                  <s-button variant="primary" type="submit" loading={flag(saving)}>{t("Save")}</s-button>
                </Form>
              </s-stack>
            </s-section>
            {/* BYO SMTP - Starter+ only */}
            {planName !== "free" && (
              <s-section>
                <s-stack direction="block" gap="base">
                  <CardIntro heading={t("Custom email sender (SMTP)")}>
                    {t("Send emails from your own domain using your email provider.")}
                  </CardIntro>
                  <s-divider />
                  <Banner tone="info">
                    {t("Leave blank to use Miko's default sending address (noreply@miko.co.nz). Fill in all fields to send from your own domain.")}
                  </Banner>
                  <s-stack direction="block" gap="base">
                    <Grid columns={TWO_UP} gap="base">
                      <TextField
                        label={t("SMTP host")}
                        value={smtpHost}
                        onChange={setSmtpHost}
                        placeholder="smtp.gmail.com"
                        autoComplete="off"
                      />
                      <TextField
                        label={t("Port")}
                        type="number"
                        value={smtpPort}
                        onChange={setSmtpPort}
                        placeholder="587"
                        autoComplete="off"
                      />
                    </Grid>
                    <Grid columns={TWO_UP} gap="base">
                      <TextField
                        label={t("Username")}
                        value={smtpUser}
                        onChange={setSmtpUser}
                        autoComplete="off"
                      />
                      <PasswordField
                        label={t("Password")}
                        value={smtpPass}
                        onChange={setSmtpPass}
                        placeholder={config.hasSmtpPass ? "••••••••" : undefined}
                      />
                    </Grid>
                    <Grid columns={TWO_UP} gap="base">
                      <TextField
                        label={t("From email")}
                        type="email"
                        value={smtpFromEmail}
                        onChange={setSmtpFromEmail}
                        placeholder="orders@yourdomain.com"
                        autoComplete="off"
                      />
                      <TextField
                        label={t("From name")}
                        value={smtpFromName}
                        onChange={setSmtpFromName}
                        placeholder={t("Kiwi Surf Gear")}
                        autoComplete="off"
                      />
                    </Grid>
                    <Checkbox
                      label={t("Use SSL/TLS (port 465)")}
                      checked={smtpSecure}
                      onChange={setSmtpSecure}
                    />
                  </s-stack>
                  <Form method="POST">
                    <input type="hidden" name="intent" value="save_smtp" />
                    <input type="hidden" name="smtpHost" value={smtpHost} />
                    <input type="hidden" name="smtpPort" value={smtpPort} />
                    <input type="hidden" name="smtpUser" value={smtpUser} />
                    <input type="hidden" name="smtpPass" value={smtpPass} />
                    <input type="hidden" name="smtpFromEmail" value={smtpFromEmail} />
                    <input type="hidden" name="smtpFromName" value={smtpFromName} />
                    <input type="hidden" name="smtpSecure" value={String(smtpSecure)} />
                    <s-button variant="primary" type="submit" loading={flag(saving)}>{t("Save SMTP settings")}</s-button>
                  </Form>
                </s-stack>
              </s-section>
            )}
          </s-stack>

          {/* Sidebar */}
          <s-stack direction="block" gap="base">
            <s-section heading={t("How emails work")}>
              <s-ordered-list>
                <s-list-item>{t("When a customer pays for a rental, they immediately get a booking confirmation with all the details.")}</s-list-item>
                <s-list-item>{t("The day before the return date, they get a friendly reminder with the return instructions.")}</s-list-item>
                <s-list-item>{t("If the item isn't returned on time, they receive an overdue notice with any applicable late fees.")}</s-list-item>
                <s-list-item>{t("You can also manually trigger a reminder or overdue notice from any booking's detail page.")}</s-list-item>
              </s-ordered-list>
            </s-section>

            <s-section heading={t("Setup status")}>
              <s-stack direction="block" gap="small">
                <s-stack direction="block" gap="small-200">
                  {[
                    [config.onboardingCompleted, t("Onboarding complete")],
                    [config.senderName, t("Email identity set")],
                    [config.currency, t("Currency set")],
                  ].map(([done, label], i) => (
                    <s-stack key={i} direction="inline" gap="small-200" alignItems="center">
                      <s-icon
                        type={done ? "check-circle-filled" : "circle"}
                        tone={done ? "success" : "neutral"}
                      />
                      <s-text color="subdued">{label as string}</s-text>
                    </s-stack>
                  ))}
                </s-stack>
                {!config.onboardingCompleted && (
                  <Form method="POST">
                    <input type="hidden" name="intent" value="complete_onboarding" />
                    <s-button variant="secondary" type="submit" inlineSize="fill" loading={flag(saving)}>
                      {t("Mark setup as complete")}
                    </s-button>
                  </Form>
                )}
              </s-stack>
            </s-section>
          </s-stack>
        </Grid>
      </s-stack>
    </s-page>
  );
}
