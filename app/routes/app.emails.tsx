import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useNavigate,
  Form,
  useFetcher,
} from "@remix-run/react";
import { useState, useCallback } from "react";
import { Banner, DropZone, Grid, TextField, flag } from "../components/polaris";
import { MAIN_WITH_SIDEBAR } from "../components/layout";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  defaultConfirmationBlocks,
  defaultReturnReminderBlocks,
  defaultOverdueBlocks,
  getDefaultSubject,
  compileBlocksToHtml,
  type BrandSettings,
} from "../utils/email-templates";
import { useT } from "../i18n/context";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, templates] = await Promise.all([
    // Explicit select: this is sent to the browser, and the full row holds
    // secrets (SMTP password). Only the brand fields this page renders.
    db.shopConfig.findUnique({
      where: { shop },
      select: {
        brandLogoUrl: true,
        brandPrimaryColor: true,
        brandName: true,
        shopName: true,
        senderName: true,
      },
    }),
    db.emailTemplate.findMany({
      where: { shop },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return json({ config, templates });
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save_brand") {
    const brandLogoUrl = (formData.get("brandLogoUrl") as string | null) || null;
    const brandPrimaryColor =
      (formData.get("brandPrimaryColor") as string) || "#1a1a1a";
    const brandName = (formData.get("brandName") as string | null) || null;
    const senderName =
      (formData.get("senderName") as string | null) || null;

    await db.shopConfig.update({
      where: { shop },
      data: {
        brandLogoUrl: brandLogoUrl ?? undefined,
        brandPrimaryColor,
        brandName: brandName ?? undefined,
        senderName: senderName ?? undefined,
      },
    });
    return json({ success: true, message: "Brand settings saved." });
  }

  if (intent === "toggle_template") {
    const id = formData.get("id") as string;
    const template = await db.emailTemplate.findFirst({
      where: { id, shop },
    });
    if (!template) return json({ error: "Template not found." }, { status: 404 });
    await db.emailTemplate.update({
      where: { id },
      data: { isActive: !template.isActive },
    });
    return json({ success: true });
  }

  if (intent === "delete_template") {
    const id = formData.get("id") as string;
    const template = await db.emailTemplate.findFirst({
      where: { id, shop, type: "custom" },
    });
    if (!template) return json({ error: "Template not found." }, { status: 404 });
    await db.emailTemplate.delete({ where: { id } });
    return json({ success: true });
  }

  if (intent === "create_default") {
    const type = formData.get("type") as string;
    const typeLabels: Record<string, string> = {
      confirmation: "Booking Confirmation",
      return_reminder: "Return Reminder",
      overdue: "Overdue Notice",
    };
    const blockFns: Record<string, () => ReturnType<typeof defaultConfirmationBlocks>> = {
      confirmation: defaultConfirmationBlocks,
      return_reminder: defaultReturnReminderBlocks,
      overdue: defaultOverdueBlocks,
    };
    const blocks = blockFns[type]?.() ?? defaultConfirmationBlocks();
    const subject = getDefaultSubject(type);

    const config = await db.shopConfig.findUnique({ where: { shop } });
    const { humanizeShopHandle } = await import("../utils/shop-info.server");
    const resolvedName =
      (config?.brandName && config.brandName.trim()) ||
      (config?.shopName && config.shopName.trim()) ||
      humanizeShopHandle(shop);
    const brand: BrandSettings = {
      logoUrl: config?.brandLogoUrl ?? undefined,
      primaryColor: config?.brandPrimaryColor ?? "#1a1a1a",
      name: resolvedName,
    };
    const html = compileBlocksToHtml(blocks, brand, subject);

    const tmpl = await db.emailTemplate.create({
      data: {
        shop,
        type,
        name: typeLabels[type] ?? type,
        subject,
        blocks: blocks as object[],
        html,
        isActive: true,
      },
    });
    return redirect(`/app/emails/${tmpl.id}`);
  }

  return json({ error: "Unknown intent." }, { status: 400 });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUILT_IN_TYPES = [
  {
    type: "confirmation",
    label: "Booking Confirmation",
    description: "Sent automatically when a booking is paid and confirmed.",
    icon: "email",
  },
  {
    type: "return_reminder",
    label: "Return Reminder",
    description: "Sent the day before the rental is due back.",
    icon: "clock",
  },
  {
    type: "overdue",
    label: "Overdue Notice",
    description: "Sent when a rental passes its return date without being returned.",
    icon: "alert-triangle",
  },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EmailsPage() {
  const { config, templates } =
    useLoaderData<typeof loader>();
  const t = useT();
  const navigate = useNavigate();
  const brandFetcher = useFetcher<typeof action>();
  const actionFetcher = useFetcher<typeof action>();

  const [brandName, setBrandName] = useState(config?.brandName ?? "");
  const [brandPrimaryColor, setBrandPrimaryColor] = useState(
    config?.brandPrimaryColor ?? "#1a1a1a",
  );
  const [senderName, setEmailSenderName] = useState(
    config?.senderName ?? "",
  );
  const [logoPreview, setLogoPreview] = useState<string>(
    config?.brandLogoUrl ?? "",
  );
  const [logoBase64, setLogoBase64] = useState<string>(
    config?.brandLogoUrl ?? "",
  );

  // s-drop-zone filters by `accept` itself and passes only accepted files.
  const handleDropZoneDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      setLogoPreview(result);
      setLogoBase64(result);
    };
    reader.readAsDataURL(file);
  }, []);

  const customTemplates = templates.filter((t) => t.type === "custom");

  const savingBrand = brandFetcher.state !== "idle";
  const brandActionData = brandFetcher.data;

  return (
    <s-page heading={t("Email Templates")} inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/emails/new")}>
        {t("Add template")}
      </s-button>
      <s-stack direction="block" gap="large">
        <s-text color="subdued">{t("Customize the emails sent to your customers.")}</s-text>
        {brandActionData && "message" in brandActionData && (
          <Banner tone="success" title={(brandActionData as { message: string }).message} />
        )}
        {brandActionData && "error" in brandActionData && (
          <Banner tone="critical" title={(brandActionData as { error: string }).error} />
        )}

        <Grid columns={MAIN_WITH_SIDEBAR} gap="base">
          {/* Main content */}
          <s-stack direction="block" gap="large">
            {/* Automated emails */}
            <s-stack direction="block" gap="small">
              <s-heading>{t("Automated emails")}</s-heading>

              {BUILT_IN_TYPES.map(({ type, label, description, icon }) => {
                const tmpl = templates.find((t) => t.type === type);
                return (
                  <s-section key={type}>
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                      <s-stack direction="inline" gap="small" alignItems="start">
                        <s-icon type={icon} />
                        <s-stack direction="block" gap="small-300">
                          <s-text type="strong">{t(label)}</s-text>
                          <s-text color="subdued">{tmpl ? tmpl.subject : t(description)}</s-text>
                        </s-stack>
                      </s-stack>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        {tmpl && (
                          <s-badge tone={tmpl.isActive ? "success" : "auto"}>
                            {tmpl.isActive ? t("Active") : t("Inactive")}
                          </s-badge>
                        )}
                        {tmpl ? (
                          <s-button onClick={() => navigate(`/app/emails/${tmpl.id}`)}>{t("Edit")}</s-button>
                        ) : (
                          <Form method="post">
                            <input type="hidden" name="intent" value="create_default" />
                            <input type="hidden" name="type" value={type} />
                            <s-button type="submit">{t("Set up")}</s-button>
                          </Form>
                        )}
                      </s-stack>
                    </s-stack>
                  </s-section>
                );
              })}
            </s-stack>

            <s-divider />

            {/* Custom templates */}
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-heading>{t("Custom templates")}</s-heading>
                <s-button onClick={() => navigate("/app/emails/new")}>{t("Add template")}</s-button>
              </s-stack>

              {customTemplates.length === 0 ? (
                <s-section>
                  <s-empty-state heading={t("No custom templates yet")}>
                    <s-icon slot="graphic" type="email" />
                    <s-text slot="subheading">
                      {t("Create custom templates for special occasions or one-off communications.")}
                    </s-text>
                  </s-empty-state>
                </s-section>
              ) : (
                customTemplates.map((tmpl) => (
                  <s-section key={tmpl.id}>
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                      <s-stack direction="block" gap="small-300">
                        <s-text type="strong">{tmpl.name}</s-text>
                        <s-text color="subdued">{tmpl.subject}</s-text>
                      </s-stack>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-badge tone={tmpl.isActive ? "success" : "auto"}>
                          {tmpl.isActive ? t("Active") : t("Inactive")}
                        </s-badge>
                        <s-button onClick={() => navigate(`/app/emails/${tmpl.id}`)}>{t("Edit")}</s-button>
                        <actionFetcher.Form method="post">
                          <input type="hidden" name="intent" value="delete_template" />
                          <input type="hidden" name="id" value={tmpl.id} />
                          <s-button
                            tone="critical"
                            type="submit"
                            loading={flag(actionFetcher.state !== "idle")}
                          >
                            {t("Delete")}
                          </s-button>
                        </actionFetcher.Form>
                      </s-stack>
                    </s-stack>
                  </s-section>
                ))
              )}
            </s-stack>
          </s-stack>

          {/* Brand settings sidebar */}
          <s-section heading={t("Brand settings")}>
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                {t("These settings are applied to all your email templates.")}
              </s-text>
              <s-divider />

              <brandFetcher.Form method="post">
                <input type="hidden" name="intent" value="save_brand" />
                <input type="hidden" name="brandLogoUrl" value={logoBase64} />
                {/* The fields below are controlled web components with no
                    `name`; these hidden inputs carry the same values the
                    old named Polaris React fields submitted. */}
                <input type="hidden" name="brandName" value={brandName} />
                <input type="hidden" name="brandPrimaryColor" value={brandPrimaryColor} />
                <input type="hidden" name="senderName" value={senderName} />
                <s-stack direction="block" gap="base">
                  {/* Logo upload */}
                  <s-stack direction="block" gap="small-200">
                    <s-text>{t("Logo")}</s-text>
                    {logoPreview && (
                      <s-thumbnail src={logoPreview} alt={t("Brand logo preview")} size="large" />
                    )}
                    <DropZone
                      label={t("Add logo")}
                      accept="image/*"
                      onDrop={handleDropZoneDrop}
                    />
                    <s-text color="subdued">
                      {t("Shown in the email header. Recommended: 200×60px PNG.")}
                    </s-text>
                  </s-stack>

                  <TextField
                    label={t("Brand name")}
                    value={brandName}
                    onChange={setBrandName}
                    autoComplete="off"
                    details={t("Shown in emails when no logo is uploaded.")}
                  />

                  <TextField
                    label={t("Primary color")}
                    value={brandPrimaryColor}
                    onChange={setBrandPrimaryColor}
                    autoComplete="off"
                    details={t("Used for buttons and accents. Hex code e.g. #1a1a1a")}
                  />

                  <TextField
                    label={t("Sender name")}
                    value={senderName}
                    onChange={setEmailSenderName}
                    autoComplete="off"
                    details={t("Appears as the 'From' name in the customer's inbox.")}
                  />

                  <s-button
                    variant="primary"
                    type="submit"
                    loading={flag(savingBrand)}
                    inlineSize="fill"
                  >
                    {t("Save brand settings")}
                  </s-button>
                </s-stack>
              </brandFetcher.Form>
            </s-stack>
          </s-section>
        </Grid>
      </s-stack>
    </s-page>
  );
}
