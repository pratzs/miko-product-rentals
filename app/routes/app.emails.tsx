import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  Form,
  useFetcher,
} from "@remix-run/react";
import { useState, useCallback, useRef } from "react";
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
  Badge,
  Divider,
  FormLayout,
  DropZone,
  Thumbnail,
  Icon,
  EmptyState,
} from "@shopify/polaris";
import {
  EmailIcon,
  ClockIcon,
  AlertTriangleIcon,
} from "@shopify/polaris-icons";
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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, templates] = await Promise.all([
    db.shopConfig.findUnique({ where: { shop } }),
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
    const brand: BrandSettings = {
      logoUrl: config?.brandLogoUrl ?? undefined,
      primaryColor: config?.brandPrimaryColor ?? "#1a1a1a",
      name: config?.brandName ?? shop,
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
    icon: EmailIcon,
  },
  {
    type: "return_reminder",
    label: "Return Reminder",
    description: "Sent the day before the rental is due back.",
    icon: ClockIcon,
  },
  {
    type: "overdue",
    label: "Overdue Notice",
    description: "Sent when a rental passes its return date without being returned.",
    icon: AlertTriangleIcon,
  },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EmailsPage() {
  const { config, templates } =
    useLoaderData<typeof loader>();
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
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleDropZoneDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        setLogoPreview(result);
        setLogoBase64(result);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  const customTemplates = templates.filter((t) => t.type === "custom");

  const savingBrand = brandFetcher.state !== "idle";
  const brandActionData = brandFetcher.data;

  return (
    <Page
      title="Email Templates"
      subtitle="Customise the emails sent to your customers."
      primaryAction={{
        content: "Add template",
        url: "/app/emails/new",
      }}
    >
      <BlockStack gap="600">
        {brandActionData && "message" in brandActionData && (
          <Banner tone="success" title={(brandActionData as { message: string }).message} />
        )}
        {brandActionData && "error" in brandActionData && (
          <Banner tone="critical" title={(brandActionData as { error: string }).error} />
        )}

        <Layout>
          {/* Main content */}
          <Layout.Section>
            <BlockStack gap="500">
              {/* Automated emails */}
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Automated emails
                </Text>

                {BUILT_IN_TYPES.map(({ type, label, description, icon }) => {
                  const tmpl = templates.find((t) => t.type === type);
                  return (
                    <Card key={type}>
                      <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
                        <InlineStack gap="300" blockAlign="start">
                          <Icon source={icon} />
                          <BlockStack gap="100">
                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                              {label}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {tmpl ? tmpl.subject : description}
                            </Text>
                          </BlockStack>
                        </InlineStack>
                        <InlineStack gap="200" blockAlign="center">
                          {tmpl && (
                            <Badge tone={tmpl.isActive ? "success" : undefined}>
                              {tmpl.isActive ? "Active" : "Inactive"}
                            </Badge>
                          )}
                          {tmpl ? (
                            <Button url={`/app/emails/${tmpl.id}`}>Edit</Button>
                          ) : (
                            <Form method="post">
                              <input type="hidden" name="intent" value="create_default" />
                              <input type="hidden" name="type" value={type} />
                              <Button submit>Set up</Button>
                            </Form>
                          )}
                        </InlineStack>
                      </InlineStack>
                    </Card>
                  );
                })}
              </BlockStack>

              <Divider />

              {/* Custom templates */}
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Custom templates
                  </Text>
                  <Button url="/app/emails/new">Add template</Button>
                </InlineStack>

                {customTemplates.length === 0 ? (
                  <Card>
                    <EmptyState
                      heading="No custom templates yet"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <Text as="p">
                        Create custom templates for special occasions or
                        one-off communications.
                      </Text>
                    </EmptyState>
                  </Card>
                ) : (
                  customTemplates.map((tmpl) => (
                    <Card key={tmpl.id}>
                      <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {tmpl.name}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {tmpl.subject}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={tmpl.isActive ? "success" : undefined}>
                            {tmpl.isActive ? "Active" : "Inactive"}
                          </Badge>
                          <Button url={`/app/emails/${tmpl.id}`}>Edit</Button>
                          <actionFetcher.Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="delete_template"
                            />
                            <input type="hidden" name="id" value={tmpl.id} />
                            <Button
                              tone="critical"
                              submit
                              loading={actionFetcher.state !== "idle"}
                            >
                              Delete
                            </Button>
                          </actionFetcher.Form>
                        </InlineStack>
                      </InlineStack>
                    </Card>
                  ))
                )}
              </BlockStack>
            </BlockStack>
          </Layout.Section>

          {/* Brand settings sidebar */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Brand settings
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  These settings are applied to all your email templates.
                </Text>
                <Divider />

                <brandFetcher.Form method="post">
                  <input type="hidden" name="intent" value="save_brand" />
                  <input
                    type="hidden"
                    name="brandLogoUrl"
                    value={logoBase64}
                  />
                  <FormLayout>
                    {/* Logo upload */}
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        Logo
                      </Text>
                      {logoPreview && (
                        <Thumbnail
                          source={logoPreview}
                          alt="Brand logo preview"
                          size="large"
                        />
                      )}
                      <DropZone
                        accept="image/*"
                        type="image"
                        allowMultiple={false}
                        onDrop={handleDropZoneDrop}
                      >
                        <DropZone.FileUpload
                          actionTitle="Add logo"
                          actionHint="or drop an image to upload"
                        />
                      </DropZone>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Shown in the email header. Recommended: 200×60px PNG.
                      </Text>
                    </BlockStack>

                    <TextField
                      label="Brand name"
                      name="brandName"
                      value={brandName}
                      onChange={setBrandName}
                      autoComplete="off"
                      helpText="Shown in emails when no logo is uploaded."
                    />

                    <TextField
                      label="Primary colour"
                      name="brandPrimaryColor"
                      value={brandPrimaryColor}
                      onChange={setBrandPrimaryColor}
                      autoComplete="off"
                      helpText="Used for buttons and accents. Hex code e.g. #1a1a1a"
                    />

                    <TextField
                      label="Sender name"
                      name="senderName"
                      value={senderName}
                      onChange={setEmailSenderName}
                      autoComplete="off"
                      helpText="Appears as the 'From' name in the customer's inbox."
                    />

                    <Button
                      variant="primary"
                      submit
                      loading={savingBrand}
                      fullWidth
                    >
                      Save brand settings
                    </Button>
                  </FormLayout>
                </brandFetcher.Form>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
