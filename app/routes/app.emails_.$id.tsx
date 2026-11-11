import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  useState,
  useCallback,
} from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { addDays, format } from "date-fns";
import {
  Banner,
  Button,
  Grid,
  RangeSlider,
  Select,
  TextField,
  AppLink,
  flag,
} from "../components/polaris";
import { TWO_UP } from "../components/layout";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  compileBlocksToHtml,
  substituteVariables,
  defaultConfirmationBlocks,
  defaultReturnReminderBlocks,
  defaultOverdueBlocks,
  getDefaultSubject,
  TEMPLATE_VARIABLES,
  PREVIEW_SAMPLE_VARS,
  type EmailBlock,
  type HeaderBlock,
  type TextBlock,
  type DetailsBlock,
  type ButtonBlock,
  type SpacerBlock,
  type DividerBlock,
  type HtmlBlock,
  type BrandSettings,
} from "../utils/email-templates";
import { useT } from "../i18n/context";

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id as string;

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

  // Override generic preview sample values with the shop's real settings so the
  // preview matches what customers will actually receive.
  const currency = config?.currency || "USD";
  function fmt(amount: number) {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
    } catch {
      return `${currency} ${amount.toFixed(2)}`;
    }
  }
  const previewOverrides: Record<string, string> = {
    shop_name: resolvedName,
    late_fee_per_day: fmt(config?.lateFeePerDay ?? 0),
  };

  if (id === "new") {
    return json({ template: null, brand, shop, merchantEmail: null, previewOverrides });
  }

  const template = await db.emailTemplate.findFirst({ where: { id, shop } });
  if (!template) {
    throw new Response("Not found", { status: 404 });
  }

  // Try to get merchant email from session (may not always be available)
  const sessionRow = await db.session.findFirst({
    where: { shop, email: { not: null } },
    select: { email: true },
  });

  return json({
    template,
    brand,
    shop,
    merchantEmail: sessionRow?.email ?? null,
    previewOverrides,
  });
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id as string;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save") {
    const name = (formData.get("name") as string).trim();
    const subject = (formData.get("subject") as string).trim();
    const type = (formData.get("type") as string) || "custom";
    const blocksJson = formData.get("blocks") as string;
    const html = formData.get("html") as string;

    let blocks: EmailBlock[];
    try {
      blocks = JSON.parse(blocksJson) as EmailBlock[];
    } catch {
      return json({ error: "Invalid blocks JSON." }, { status: 400 });
    }

    if (id === "new") {
      const tmpl = await db.emailTemplate.create({
        data: {
          shop,
          type,
          name,
          subject,
          blocks: blocks as object[],
          html,
          isActive: true,
        },
      });
      return redirect(`/app/emails/${tmpl.id}?saved=1`);
    } else {
      const existing = await db.emailTemplate.findFirst({ where: { id, shop } });
      if (!existing) return json({ error: "Not found." }, { status: 404 });
      await db.emailTemplate.update({
        where: { id },
        data: { name, subject, type, blocks: blocks as object[], html },
      });
      return json({ success: true, message: "Template saved." });
    }
  }

  if (intent === "send_test") {
    const blocksJson = formData.get("blocks") as string;
    const subject = (formData.get("subject") as string) || "Test email";
    const toEmail = formData.get("toEmail") as string;
    const html = formData.get("html") as string;

    if (!toEmail) {
      return json({ error: "No recipient email found." }, { status: 400 });
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      return json(
        { error: "RESEND_API_KEY is not configured. Cannot send test email." },
        { status: 400 },
      );
    }

    const config = await db.shopConfig.findUnique({ where: { shop } });
    const { humanizeShopHandle } = await import("../utils/shop-info.server");
    const resolvedTestName =
      (config?.brandName && config.brandName.trim()) ||
      (config?.shopName && config.shopName.trim()) ||
      humanizeShopHandle(shop);
    const brand: BrandSettings = {
      logoUrl: config?.brandLogoUrl ?? undefined,
      primaryColor: config?.brandPrimaryColor ?? "#1a1a1a",
      name: resolvedTestName,
    };

    let blocks: EmailBlock[];
    try {
      blocks = JSON.parse(blocksJson) as EmailBlock[];
    } catch {
      blocks = defaultConfirmationBlocks();
    }

    const compiledHtml = compileBlocksToHtml(blocks, brand, subject);
    const sampleStart = addDays(new Date(), 7);
    const sampleEnd = addDays(sampleStart, 5);
    const testVars: Record<string, string> = {
      customer_name: "Jane Smith",
      customer_email: toEmail,
      product_title: "Sample Product",
      order_name: "#1001",
      start_date: format(sampleStart, "PPP"),
      end_date: format(sampleEnd, "PPP"),
      rental_days: "5",
      rental_price: "$99.00",
      deposit_amount: "$50.00",
      shop_name: resolvedTestName,
      days_overdue: "2",
      late_fee_per_day: "$10.00",
    };
    const finalHtml =
      html ||
      substituteVariables(compiledHtml, testVars);
    const finalSubject = substituteVariables(subject, testVars);

    try {
      const { Resend } = await import("resend");
      const resend = new Resend(resendKey);
      const fromName =
        config?.senderName || config?.brandName || process.env.MIKO_SENDER_NAME || "Miko Rentals";
      const fromEmail = process.env.MIKO_SENDER_EMAIL ?? "noreply@miko.co.nz";
      const replyTo = config?.replyToEmail || process.env.MIKO_REPLY_TO || fromEmail;
      const { error } = await resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        replyTo: replyTo,
        to: toEmail,
        subject: `[TEST] ${finalSubject}`,
        html: finalHtml,
      });
      if (error) return json({ error: error.message }, { status: 500 });
      return json({ success: true, message: `Test email sent to ${toEmail}.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to send test email.";
      return json({ error: msg }, { status: 500 });
    }
  }

  return json({ error: "Unknown intent." }, { status: 400 });
};

// ---------------------------------------------------------------------------
// Block type label/preview helpers
// ---------------------------------------------------------------------------

function blockTypeLabel(type: EmailBlock["type"]): string {
  const labels: Record<EmailBlock["type"], string> = {
    header: "Header / Logo",
    text: "Text",
    details: "Booking Details",
    button: "Button",
    spacer: "Spacer",
    divider: "Divider",
    html: "Custom HTML",
  };
  return labels[type] ?? type;
}

function blockPreview(
  block: EmailBlock,
  t: (key: string, vars?: Record<string, string | number>) => string,
  brand?: BrandSettings,
): string {
  switch (block.type) {
    case "header":
      if (block.logoUrl) return t("Custom logo (overrides brand)");
      if (brand?.logoUrl) return t("Brand logo");
      return t("Brand name (no logo set)");
    case "text":
      return block.content.replace(/\*\*/g, "").slice(0, 60) + (block.content.length > 60 ? "…" : "");
    case "details":
      return block.title || t("Booking summary table");
    case "button":
      return block.text || t("Button");
    case "spacer":
      return t("{n}px gap", { n: block.height });
    case "divider":
      return t("Horizontal rule");
    case "html":
      return t("Raw HTML");
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Default new block builders
// ---------------------------------------------------------------------------

function newBlock(type: EmailBlock["type"]): EmailBlock {
  const id = uid();
  switch (type) {
    case "header":
      return { id, type, logoUrl: "", backgroundColor: "#ffffff" } satisfies HeaderBlock;
    case "text":
      return {
        id, type, content: "Your text here.", fontSize: 16,
        fontWeight: "normal", textAlign: "left", color: "#333333",
        paddingTop: 16, paddingBottom: 16,
      } satisfies TextBlock;
    case "details":
      return { id, type, title: "Booking Details", backgroundColor: "#f9f9f9" } satisfies DetailsBlock;
    case "button":
      return {
        id, type, text: "View booking",
        url: "#", backgroundColor: "#1a1a1a", textColor: "#ffffff",
      } satisfies ButtonBlock;
    case "spacer":
      return { id, type, height: 24 } satisfies SpacerBlock;
    case "divider":
      return { id, type, color: "#e5e5e5" } satisfies DividerBlock;
    case "html":
      return { id, type, content: "<p>Custom HTML</p>" } satisfies HtmlBlock;
  }
}

// ---------------------------------------------------------------------------
// SortableBlockRow
// ---------------------------------------------------------------------------

interface SortableBlockRowProps {
  block: EmailBlock;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  brand: BrandSettings;
}

function SortableBlockRow({
  block,
  isSelected,
  onSelect,
  onDelete,
  brand,
}: SortableBlockRowProps) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: block.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <s-box padding="small" background={isSelected ? "strong" : undefined}>
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <div
              {...attributes}
              {...listeners}
              style={{ cursor: "grab", display: "flex", alignItems: "center" }}
            >
              <s-icon type="drag-handle" tone="neutral" />
            </div>
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">{t(blockTypeLabel(block.type))}</s-text>
              <s-text color="subdued">{blockPreview(block, t, brand)}</s-text>
            </s-stack>
          </s-stack>
          <s-stack direction="inline" gap="small-300">
            <s-button
              icon="edit"
              variant="tertiary"
              onClick={() => onSelect(block.id)}
              accessibilityLabel={t("Edit block")}
            />
            <s-button
              icon="delete"
              variant="tertiary"
              tone="critical"
              onClick={() => onDelete(block.id)}
              accessibilityLabel={t("Delete block")}
            />
          </s-stack>
        </s-stack>
      </s-box>
      <s-divider />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block editor panel
// ---------------------------------------------------------------------------

interface BlockEditorProps {
  block: EmailBlock;
  onChange: (updated: EmailBlock) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
}

function BlockEditor({ block, onChange, onClose, onDelete }: BlockEditorProps) {
  const t = useT();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function update(key: string, value: unknown) {
    onChange({ ...(block as unknown as Record<string, unknown>), [key]: value } as unknown as EmailBlock);
  }

  const fontWeightOptions = [
    { label: t("Normal"), value: "normal" },
    { label: t("Bold"), value: "bold" },
  ];

  const textAlignOptions = [
    { label: t("Left"), value: "left" },
    { label: t("Center"), value: "center" },
    { label: t("Right"), value: "right" },
  ];

  return (
    <s-section heading={t("Edit {block} block", { block: t(blockTypeLabel(block.type)) })}>
      <s-stack direction="block" gap="base">
        {block.type === "header" && (
          <s-stack direction="block" gap="base">
            <TextField
              label={t("Logo URL (overrides brand logo)")}
              value={block.logoUrl}
              onChange={(v) => update("logoUrl", v)}
              autoComplete="off"
              details={t("Leave blank to use the logo from Brand settings (recommended). Only set this if you want a different logo just for this template.")}
            />
            <TextField
              label={t("Background color")}
              value={block.backgroundColor}
              onChange={(v) => update("backgroundColor", v)}
              autoComplete="off"
              details={t("Hex code e.g. #ffffff")}
            />
          </s-stack>
        )}

        {block.type === "text" && (
          <s-stack direction="block" gap="base">
            <TextField
              label={t("Content")}
              value={block.content}
              onChange={(v) => update("content", v)}
              multiline={4}
              autoComplete="off"
              details={t("Use **text** for bold. Use {{variable}} placeholders.")}
            />
            <RangeSlider
              label={t("Font size: {n}px", { n: block.fontSize })}
              min={12}
              max={32}
              value={block.fontSize}
              onChange={(v) => update("fontSize", v as number)}
            />
            <Select
              label={t("Font weight")}
              options={fontWeightOptions}
              value={block.fontWeight}
              onChange={(v) =>
                update("fontWeight", v as "normal" | "bold")
              }
            />
            <Select
              label={t("Text alignment")}
              options={textAlignOptions}
              value={block.textAlign}
              onChange={(v) =>
                update("textAlign", v as "left" | "center" | "right")
              }
            />
            <TextField
              label={t("Color")}
              value={block.color}
              onChange={(v) => update("color", v)}
              autoComplete="off"
              details={t("Hex code e.g. #333333")}
            />
            <RangeSlider
              label={t("Padding top: {n}px", { n: block.paddingTop })}
              min={0}
              max={80}
              value={block.paddingTop}
              onChange={(v) => update("paddingTop", v as number)}
            />
            <RangeSlider
              label={t("Padding bottom: {n}px", { n: block.paddingBottom })}
              min={0}
              max={80}
              value={block.paddingBottom}
              onChange={(v) => update("paddingBottom", v as number)}
            />
          </s-stack>
        )}

        {block.type === "details" && (
          <s-stack direction="block" gap="base">
            <TextField
              label={t("Section title")}
              value={block.title}
              onChange={(v) => update("title", v)}
              autoComplete="off"
            />
            <TextField
              label={t("Background color")}
              value={block.backgroundColor}
              onChange={(v) => update("backgroundColor", v)}
              autoComplete="off"
              details={t("Hex code e.g. #f9f9f9")}
            />
          </s-stack>
        )}

        {block.type === "button" && (
          <s-stack direction="block" gap="base">
            <TextField
              label={t("Button text")}
              value={block.text}
              onChange={(v) => update("text", v)}
              autoComplete="off"
            />
            <TextField
              label={t("URL")}
              value={block.url}
              onChange={(v) => update("url", v)}
              autoComplete="off"
              placeholder="https://yourstore.com"
            />
            <TextField
              label={t("Background color")}
              value={block.backgroundColor}
              onChange={(v) => update("backgroundColor", v)}
              autoComplete="off"
              details={t("Hex code e.g. #1a1a1a")}
            />
            <TextField
              label={t("Text color")}
              value={block.textColor}
              onChange={(v) => update("textColor", v)}
              autoComplete="off"
              details={t("Hex code e.g. #ffffff")}
            />
          </s-stack>
        )}

        {block.type === "spacer" && (
          <RangeSlider
            label={t("Height: {n}px", { n: block.height })}
            min={8}
            max={80}
            value={block.height}
            onChange={(v) => update("height", v as number)}
          />
        )}

        {block.type === "divider" && (
          <TextField
            label={t("Color")}
            value={block.color}
            onChange={(v) => update("color", v)}
            autoComplete="off"
            details={t("Hex code e.g. #e5e5e5")}
          />
        )}

        {block.type === "html" && (
          <TextField
            label={t("HTML content")}
            value={block.content}
            onChange={(v) => update("content", v)}
            multiline={10}
            autoComplete="off"
            details={t("Raw HTML is rendered as-is. Use with caution.")}
          />
        )}

        <s-divider />
        <s-stack direction="inline" gap="small">
          <s-button onClick={onClose} variant="secondary">
            {t("Done")}
          </s-button>
          <s-button
            tone="critical"
            onClick={() => onDelete(block.id)}
            variant="tertiary"
          >
            {t("Remove block")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Live preview pane
// ---------------------------------------------------------------------------

interface EmailPreviewProps {
  html: string;
  subject: string;
  fromName: string;
  toEmail: string;
  device: "desktop" | "mobile";
  onDeviceChange: (d: "desktop" | "mobile") => void;
  previewOverrides: Record<string, string>;
}

function EmailPreview({
  html,
  subject,
  fromName,
  toEmail,
  device,
  onDeviceChange,
  previewOverrides,
}: EmailPreviewProps) {
  const t = useT();
  const sampleVars = { ...PREVIEW_SAMPLE_VARS, ...previewOverrides };
  const renderedSubject = substituteVariables(subject, sampleVars);
  const renderedHtml = substituteVariables(html, sampleVars);
  const iframeWidth = device === "mobile" ? 380 : "100%";

  return (
    <s-section padding="none" accessibilityLabel={t("Live preview")}>
      <s-box padding="small">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{t("Live preview")}</s-text>
            <s-badge tone="info">{t("Sample data")}</s-badge>
          </s-stack>
          <s-stack direction="inline" gap="small-300">
            <s-press-button
              pressed={flag(device === "desktop")}
              onClick={() => onDeviceChange("desktop")}
            >
              {t("Desktop")}
            </s-press-button>
            <s-press-button
              pressed={flag(device === "mobile")}
              onClick={() => onDeviceChange("mobile")}
            >
              {t("Mobile")}
            </s-press-button>
          </s-stack>
        </s-stack>
      </s-box>
      <s-divider />

      {/* Mock inbox header showing what the customer's email client will display */}
      <s-box padding="small" background="subdued">
        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-text type="strong">{fromName}</s-text>
            <s-text color="subdued">{t("now")}</s-text>
          </s-stack>
          <s-text fontWeight="medium">{renderedSubject || t("(no subject)")}</s-text>
          <s-text color="subdued">
            {t("to")} {toEmail || "customer@example.com"}
          </s-text>
        </s-stack>
      </s-box>
      <s-divider />

      {/* The actual email rendered in an isolated iframe so its styles don't
          collide with the admin and so we get an accurate visual
          representation. The light grey backdrop stands in for an email
          client's reading pane; the email itself is the merchant's design. */}
      <s-box padding="small" background="subdued">
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            background: "#f4f4f4",
            borderRadius: 6,
            padding: 8,
          }}
        >
          <iframe
            title={t("Email preview")}
            srcDoc={renderedHtml}
            style={{
              width: iframeWidth,
              maxWidth: "100%",
              height: 640,
              border: "1px solid rgba(0, 0, 0, 0.1)",
              borderRadius: 4,
              background: "#ffffff",
              transition: "width 0.2s ease",
            }}
            sandbox=""
          />
        </div>
      </s-box>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Main editor component
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = [
  { label: "Booking Confirmation", value: "confirmation" },
  { label: "Return Reminder", value: "return_reminder" },
  { label: "Overdue Notice", value: "overdue" },
  { label: "Custom", value: "custom" },
];

const ADD_BLOCK_TYPES: EmailBlock["type"][] = [
  "header",
  "text",
  "details",
  "button",
  "spacer",
  "divider",
  "html",
];

export default function EmailEditorPage() {
  const { template, brand, merchantEmail, previewOverrides } = useLoaderData<typeof loader>();
  const t = useT();
  const navigate = useNavigate();
  const saveFetcher = useFetcher<typeof action>();
  const testFetcher = useFetcher<typeof action>();

  // Determine initial values
  const getInitialBlocks = (): EmailBlock[] => {
    if (template) return template.blocks as unknown as EmailBlock[];
    return defaultConfirmationBlocks();
  };

  const [blocks, setBlocks] = useState<EmailBlock[]>(getInitialBlocks);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState(template?.name ?? "New Template");
  const [subject, setSubject] = useState(
    template?.subject ?? getDefaultSubject("confirmation"),
  );
  const [templateType, setTemplateType] = useState(template?.type ?? "custom");
  const [addBlockOpen, setAddBlockOpen] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [testEmail, setTestEmail] = useState(merchantEmail ?? "");
  const [showTestEmailField, setShowTestEmailField] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [showHtmlSource, setShowHtmlSource] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor));

  const selectedBlock = blocks.find((b) => b.id === selectedBlockId) ?? null;

  const compiledHtml = useCallback(() => {
    return compileBlocksToHtml(blocks, brand, subject);
  }, [blocks, brand, subject]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        setBlocks((prev) => {
          const oldIndex = prev.findIndex((b) => b.id === active.id);
          const newIndex = prev.findIndex((b) => b.id === over.id);
          return arrayMove(prev, oldIndex, newIndex);
        });
        setIsDirty(true);
      }
    },
    [],
  );

  const handleAddBlock = useCallback(
    (type: EmailBlock["type"]) => {
      setBlocks((prev) => [...prev, newBlock(type)]);
      setAddBlockOpen(false);
      setIsDirty(true);
    },
    [],
  );

  const handleDeleteBlock = useCallback((id: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    setSelectedBlockId((prev) => (prev === id ? null : prev));
    setIsDirty(true);
  }, []);

  const handleBlockChange = useCallback((updated: EmailBlock) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === updated.id ? updated : b)),
    );
    setIsDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    const html = compiledHtml();
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("name", templateName);
    formData.append("subject", subject);
    formData.append("type", templateType);
    formData.append("blocks", JSON.stringify(blocks));
    formData.append("html", html);
    saveFetcher.submit(formData, { method: "post" });
    setIsDirty(false);
  }, [compiledHtml, templateName, subject, templateType, blocks, saveFetcher]);

  const handleSendTest = useCallback(() => {
    if (!showTestEmailField) {
      setShowTestEmailField(true);
      return;
    }
    const html = compiledHtml();
    const formData = new FormData();
    formData.append("intent", "send_test");
    formData.append("subject", subject);
    formData.append("blocks", JSON.stringify(blocks));
    formData.append("html", html);
    formData.append("toEmail", testEmail);
    testFetcher.submit(formData, { method: "post" });
    setShowTestEmailField(false);
  }, [showTestEmailField, compiledHtml, subject, blocks, testEmail, testFetcher]);

  const isSubmitting = saveFetcher.state !== "idle";
  const isSendingTest = testFetcher.state !== "idle";

  const saveActionData = saveFetcher.data;
  const testActionData = testFetcher.data;

  return (
    <s-page heading={templateName || t("New template")} inlineSize="large">
      <AppLink slot="breadcrumb-actions" to="/app/emails" navigate={navigate}>
        {t("Email Templates")}
      </AppLink>
      <s-button
        slot="primary-action"
        variant="primary"
        loading={flag(isSubmitting)}
        onClick={handleSave}
      >
        {t("Save")}
      </s-button>
      <s-button slot="secondary-actions" loading={flag(isSendingTest)} onClick={handleSendTest}>
        {t("Send test")}
      </s-button>
      <s-stack direction="block" gap="large">
        {saveActionData && "error" in saveActionData && (
          <Banner tone="critical" title={(saveActionData as { error: string }).error} />
        )}
        {saveActionData && "message" in saveActionData && (
          <Banner tone="success" title={(saveActionData as { message: string }).message} />
        )}
        {testActionData && "error" in testActionData && (
          <Banner tone="critical" title={(testActionData as { error: string }).error} />
        )}
        {testActionData && "message" in testActionData && (
          <Banner tone="success" title={(testActionData as { message: string }).message} />
        )}

        {showTestEmailField && (
          <s-section>
            <s-stack direction="block" gap="small">
              <s-text>{t("Send a test email")}</s-text>
              <s-stack direction="inline" gap="small" alignItems="end">
                <s-box minInlineSize="280px">
                  <TextField
                    label={t("Send to")}
                    value={testEmail}
                    onChange={setTestEmail}
                    type="email"
                    autoComplete="email"
                    placeholder="your@email.com"
                  />
                </s-box>
                <s-button
                  variant="primary"
                  onClick={handleSendTest}
                  loading={flag(isSendingTest)}
                >
                  {t("Send now")}
                </s-button>
                <s-button onClick={() => setShowTestEmailField(false)}>{t("Cancel")}</s-button>
              </s-stack>
            </s-stack>
          </s-section>
        )}

        <Grid columns={TWO_UP} gap="base">
          {/* Editor area */}
          <s-stack direction="block" gap="base">
            {/* Template details */}
            <s-section heading={t("Template details")}>
              <s-stack direction="block" gap="base">
                <TextField
                  label={t("Template name")}
                  value={templateName}
                  onChange={(v) => { setTemplateName(v); setIsDirty(true); }}
                  autoComplete="off"
                />
                <Select
                  label={t("Email type")}
                  options={TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
                  value={templateType}
                  onChange={(v) => { setTemplateType(v); setIsDirty(true); }}
                  details={t("Controls when this template is used for automated sends.")}
                />
                <TextField
                  label={t("Subject line")}
                  value={subject}
                  onChange={(v) => { setSubject(v); setIsDirty(true); }}
                  autoComplete="off"
                  details={t("Supports {{variable}} placeholders.")}
                />

                {/* Variable chips */}
                <s-stack direction="block" gap="small-200">
                  <s-text color="subdued">
                    {t("Click a variable to copy it to your clipboard.")}
                  </s-text>
                  <s-stack direction="inline" gap="small-200">
                    {TEMPLATE_VARIABLES.map((v) => (
                      <s-clickable-chip
                        key={v.value}
                        onClick={() => {
                          navigator.clipboard
                            .writeText(v.value)
                            .catch(() => {});
                        }}
                      >
                        {t(v.label)}
                      </s-clickable-chip>
                    ))}
                  </s-stack>
                </s-stack>
              </s-stack>
            </s-section>

            {/* Block list */}
            <s-section padding="none" accessibilityLabel={t("Email content")}>
              <s-box padding="base">
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                  <s-heading>{t("Email content")}</s-heading>
                  <s-button
                    variant="tertiary"
                    onClick={() => setShowHtmlSource((v) => !v)}
                  >
                    {showHtmlSource ? t("Hide HTML") : t("View HTML source")}
                  </s-button>
                </s-stack>
              </s-box>
              <s-divider />

              {blocks.length === 0 ? (
                <s-box padding="large">
                  <s-paragraph color="subdued">
                    {t("No blocks yet. Add your first block below.")}
                  </s-paragraph>
                </s-box>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={blocks.map((b) => b.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {blocks.map((block) => (
                      <SortableBlockRow
                        key={block.id}
                        block={block}
                        isSelected={selectedBlockId === block.id}
                        onSelect={setSelectedBlockId}
                        onDelete={handleDeleteBlock}
                        brand={brand}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              )}

              <s-box padding="base">
                {/* Popover + ActionList became a button that opens an s-menu.
                    Menu items use the adapter Button (listener bound on the
                    element) so the click survives the menu's own rendering. */}
                <s-button commandFor="add-block-menu" inlineSize="fill">
                  {t("+ Add block")}
                </s-button>
                <s-menu id="add-block-menu" accessibilityLabel={t("+ Add block")}>
                  {ADD_BLOCK_TYPES.map((type) => (
                    <Button key={type} onClick={() => handleAddBlock(type)}>
                      {t(blockTypeLabel(type))}
                    </Button>
                  ))}
                </s-menu>
              </s-box>
            </s-section>

            {/* Block settings - shown inline below the list when a block is selected */}
            {selectedBlock && (
              <BlockEditor
                block={selectedBlock}
                onChange={handleBlockChange}
                onClose={() => setSelectedBlockId(null)}
                onDelete={(id) => {
                  handleDeleteBlock(id);
                  setSelectedBlockId(null);
                }}
              />
            )}

            {/* HTML source - shown on demand */}
            {showHtmlSource && (
              <s-section>
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" justifyContent="space-between">
                    <s-heading>{t("Compiled HTML")}</s-heading>
                    <s-button
                      onClick={() => {
                        navigator.clipboard
                          .writeText(compiledHtml())
                          .catch(() => {});
                      }}
                    >
                      {t("Copy")}
                    </s-button>
                  </s-stack>
                  <TextField
                    label={t("Compiled HTML")}
                    labelHidden
                    value={compiledHtml()}
                    onChange={() => {}}
                    multiline={12}
                    autoComplete="off"
                    readOnly
                  />
                </s-stack>
              </s-section>
            )}
          </s-stack>

          {/* Live preview pane - sits to the right, sticky on scroll */}
          <div style={{ position: "sticky", top: 16 }}>
            <EmailPreview
              html={compiledHtml()}
              subject={subject}
              fromName={brand.name || t("Your Shop")}
              toEmail={PREVIEW_SAMPLE_VARS.customer_email}
              device={previewDevice}
              onDeviceChange={setPreviewDevice}
              previewOverrides={previewOverrides}
            />
          </div>
        </Grid>
      </s-stack>
    </s-page>
  );
}
