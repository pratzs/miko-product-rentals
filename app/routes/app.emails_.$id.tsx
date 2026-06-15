import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  useState,
  useCallback,
  useEffect,
  useRef,
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
  Box,
  Icon,
  Tabs,
  Tag,
  Popover,
  ActionList,
  Select,
  RangeSlider,
  Divider,
  FormLayout,
  Badge,
  Spinner,
} from "@shopify/polaris";
import {
  DragHandleIcon,
  EditIcon,
  DeleteIcon,
} from "@shopify/polaris-icons";
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
  const brand: BrandSettings = {
    logoUrl: config?.brandLogoUrl ?? undefined,
    primaryColor: config?.brandPrimaryColor ?? "#1a1a1a",
    name: config?.brandName ?? shop,
  };

  if (id === "new") {
    return json({ template: null, brand, shop, merchantEmail: null });
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
    const brand: BrandSettings = {
      logoUrl: config?.brandLogoUrl ?? undefined,
      primaryColor: config?.brandPrimaryColor ?? "#1a1a1a",
      name: config?.brandName ?? shop,
    };

    let blocks: EmailBlock[];
    try {
      blocks = JSON.parse(blocksJson) as EmailBlock[];
    } catch {
      blocks = defaultConfirmationBlocks();
    }

    const compiledHtml = compileBlocksToHtml(blocks, brand, subject);
    const testVars: Record<string, string> = {
      customer_name: "Jane Smith",
      customer_email: toEmail,
      product_title: "Sample Product",
      order_name: "#1001",
      start_date: "June 20, 2025",
      end_date: "June 25, 2025",
      rental_days: "5",
      rental_price: "$99.00",
      deposit_amount: "$50.00",
      shop_name: config?.brandName ?? shop,
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

function blockPreview(block: EmailBlock): string {
  switch (block.type) {
    case "header":
      return block.logoUrl ? "With logo" : "Text logo";
    case "text":
      return block.content.replace(/\*\*/g, "").slice(0, 60) + (block.content.length > 60 ? "…" : "");
    case "details":
      return block.title || "Booking summary table";
    case "button":
      return block.text || "Button";
    case "spacer":
      return `${block.height}px gap`;
    case "divider":
      return "Horizontal rule";
    case "html":
      return "Raw HTML";
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
}

function SortableBlockRow({
  block,
  isSelected,
  onSelect,
  onDelete,
}: SortableBlockRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: block.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Box
        padding="300"
        borderBlockEndWidth="025"
        borderColor="border"
        background={isSelected ? "bg-surface-selected" : undefined}
      >
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <InlineStack gap="200" blockAlign="center">
            <div
              {...attributes}
              {...listeners}
              style={{ cursor: "grab", display: "flex", alignItems: "center" }}
            >
              <Icon source={DragHandleIcon} tone="subdued" />
            </div>
            <BlockStack gap="050">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {blockTypeLabel(block.type)}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {blockPreview(block)}
              </Text>
            </BlockStack>
          </InlineStack>
          <InlineStack gap="100">
            <Button
              icon={EditIcon}
              onClick={() => onSelect(block.id)}
              variant="plain"
              accessibilityLabel="Edit block"
            />
            <Button
              icon={DeleteIcon}
              onClick={() => onDelete(block.id)}
              variant="plain"
              tone="critical"
              accessibilityLabel="Delete block"
            />
          </InlineStack>
        </InlineStack>
      </Box>
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function update(key: string, value: unknown) {
    onChange({ ...(block as unknown as Record<string, unknown>), [key]: value } as unknown as EmailBlock);
  }

  const fontWeightOptions = [
    { label: "Normal", value: "normal" },
    { label: "Bold", value: "bold" },
  ];

  const textAlignOptions = [
    { label: "Left", value: "left" },
    { label: "Center", value: "center" },
    { label: "Right", value: "right" },
  ];

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd">
          Edit {blockTypeLabel(block.type)} block
        </Text>

        {block.type === "header" && (
          <FormLayout>
            <TextField
              label="Logo URL"
              value={block.logoUrl}
              onChange={(v) => update("logoUrl", v)}
              autoComplete="off"
              helpText="Leave blank to show brand name text instead."
            />
            <TextField
              label="Background colour"
              value={block.backgroundColor}
              onChange={(v) => update("backgroundColor", v)}
              autoComplete="off"
              helpText="Hex code e.g. #ffffff"
            />
          </FormLayout>
        )}

        {block.type === "text" && (
          <FormLayout>
            <TextField
              label="Content"
              value={block.content}
              onChange={(v) => update("content", v)}
              multiline={4}
              autoComplete="off"
              helpText="Use **text** for bold. Use {{variable}} placeholders."
            />
            <RangeSlider
              label={`Font size: ${block.fontSize}px`}
              min={12}
              max={32}
              value={block.fontSize}
              onChange={(v) => update("fontSize", v as number)}
            />
            <Select
              label="Font weight"
              options={fontWeightOptions}
              value={block.fontWeight}
              onChange={(v) =>
                update("fontWeight", v as "normal" | "bold")
              }
            />
            <Select
              label="Text alignment"
              options={textAlignOptions}
              value={block.textAlign}
              onChange={(v) =>
                update("textAlign", v as "left" | "center" | "right")
              }
            />
            <TextField
              label="Colour"
              value={block.color}
              onChange={(v) => update("color", v)}
              autoComplete="off"
              helpText="Hex code e.g. #333333"
            />
            <RangeSlider
              label={`Padding top: ${block.paddingTop}px`}
              min={0}
              max={80}
              value={block.paddingTop}
              onChange={(v) => update("paddingTop", v as number)}
            />
            <RangeSlider
              label={`Padding bottom: ${block.paddingBottom}px`}
              min={0}
              max={80}
              value={block.paddingBottom}
              onChange={(v) => update("paddingBottom", v as number)}
            />
          </FormLayout>
        )}

        {block.type === "details" && (
          <FormLayout>
            <TextField
              label="Section title"
              value={block.title}
              onChange={(v) => update("title", v)}
              autoComplete="off"
            />
            <TextField
              label="Background colour"
              value={block.backgroundColor}
              onChange={(v) => update("backgroundColor", v)}
              autoComplete="off"
              helpText="Hex code e.g. #f9f9f9"
            />
          </FormLayout>
        )}

        {block.type === "button" && (
          <FormLayout>
            <TextField
              label="Button text"
              value={block.text}
              onChange={(v) => update("text", v)}
              autoComplete="off"
            />
            <TextField
              label="URL"
              value={block.url}
              onChange={(v) => update("url", v)}
              autoComplete="off"
              placeholder="https://yourstore.com"
            />
            <TextField
              label="Background colour"
              value={block.backgroundColor}
              onChange={(v) => update("backgroundColor", v)}
              autoComplete="off"
              helpText="Hex code e.g. #1a1a1a"
            />
            <TextField
              label="Text colour"
              value={block.textColor}
              onChange={(v) => update("textColor", v)}
              autoComplete="off"
              helpText="Hex code e.g. #ffffff"
            />
          </FormLayout>
        )}

        {block.type === "spacer" && (
          <RangeSlider
            label={`Height: ${block.height}px`}
            min={8}
            max={80}
            value={block.height}
            onChange={(v) => update("height", v as number)}
          />
        )}

        {block.type === "divider" && (
          <TextField
            label="Colour"
            value={block.color}
            onChange={(v) => update("color", v)}
            autoComplete="off"
            helpText="Hex code e.g. #e5e5e5"
          />
        )}

        {block.type === "html" && (
          <TextField
            label="HTML content"
            value={block.content}
            onChange={(v) => update("content", v)}
            multiline={10}
            autoComplete="off"
            helpText="Raw HTML is rendered as-is. Use with caution."
          />
        )}

        <Divider />
        <InlineStack gap="300">
          <Button onClick={onClose} variant="secondary">
            Done
          </Button>
          <Button
            tone="critical"
            onClick={() => onDelete(block.id)}
            variant="plain"
          >
            Remove block
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
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
  const { template, brand, merchantEmail } = useLoaderData<typeof loader>();
  const saveFetcher = useFetcher<typeof action>();
  const testFetcher = useFetcher<typeof action>();

  // Determine initial values
  const getInitialBlocks = (): EmailBlock[] => {
    if (template) return template.blocks as unknown as EmailBlock[];
    return defaultConfirmationBlocks();
  };

  const [blocks, setBlocks] = useState<EmailBlock[]>(getInitialBlocks);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [templateName, setTemplateName] = useState(template?.name ?? "New Template");
  const [subject, setSubject] = useState(
    template?.subject ?? getDefaultSubject("confirmation"),
  );
  const [templateType, setTemplateType] = useState(template?.type ?? "custom");
  const [addBlockOpen, setAddBlockOpen] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [testEmail, setTestEmail] = useState(merchantEmail ?? "");
  const [showTestEmailField, setShowTestEmailField] = useState(false);

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

  const tabs = [
    { id: "visual", content: "Visual editor" },
    { id: "html", content: "HTML" },
  ];

  return (
    <Page
      title={templateName || "New template"}
      backAction={{ content: "Email Templates", url: "/app/emails" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: isSubmitting,
      }}
      secondaryActions={[
        {
          content: "Send test",
          onAction: handleSendTest,
          loading: isSendingTest,
        },
      ]}
    >
      <BlockStack gap="500">
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
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">Send a test email</Text>
              <InlineStack gap="300" blockAlign="end">
                <Box minWidth="280px">
                  <TextField
                    label="Send to"
                    value={testEmail}
                    onChange={setTestEmail}
                    type="email"
                    autoComplete="email"
                    placeholder="your@email.com"
                  />
                </Box>
                <Button
                  variant="primary"
                  onClick={handleSendTest}
                  loading={isSendingTest}
                >
                  Send now
                </Button>
                <Button onClick={() => setShowTestEmailField(false)}>Cancel</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        <Layout>
          {/* Editor area */}
          <Layout.Section>
            <BlockStack gap="400">
              {/* Template details */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Template details</Text>
                  <FormLayout>
                    <TextField
                      label="Template name"
                      value={templateName}
                      onChange={(v) => { setTemplateName(v); setIsDirty(true); }}
                      autoComplete="off"
                    />
                    <Select
                      label="Email type"
                      options={TYPE_OPTIONS}
                      value={templateType}
                      onChange={(v) => { setTemplateType(v); setIsDirty(true); }}
                      helpText="Controls when this template is used for automated sends."
                    />
                    <TextField
                      label="Subject line"
                      value={subject}
                      onChange={(v) => { setSubject(v); setIsDirty(true); }}
                      autoComplete="off"
                      helpText="Supports {{variable}} placeholders."
                    />

                    {/* Variable chips */}
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Click a variable to copy it to your clipboard.
                      </Text>
                      <InlineStack gap="200" wrap>
                        {TEMPLATE_VARIABLES.map((v) => (
                          <Tag
                            key={v.value}
                            onClick={() => {
                              navigator.clipboard
                                .writeText(v.value)
                                .catch(() => {});
                            }}
                          >
                            {v.label}
                          </Tag>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  </FormLayout>
                </BlockStack>
              </Card>

              {/* Block editor */}
              <Card padding="0">
                <Tabs
                  tabs={tabs}
                  selected={activeTab}
                  onSelect={setActiveTab}
                  fitted
                />

                {activeTab === 0 && (
                  <Box padding="0">
                    {blocks.length === 0 ? (
                      <Box padding="600">
                        <BlockStack gap="300" inlineAlign="center">
                          <Text as="p" tone="subdued" alignment="center">
                            No blocks yet. Add your first block below.
                          </Text>
                        </BlockStack>
                      </Box>
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
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    )}

                    <Box padding="400" borderBlockStartWidth="025" borderColor="border">
                      <Popover
                        active={addBlockOpen}
                        onClose={() => setAddBlockOpen(false)}
                        activator={
                          <Button
                            onClick={() => setAddBlockOpen(true)}
                            fullWidth
                          >
                            + Add block
                          </Button>
                        }
                      >
                        <ActionList
                          items={ADD_BLOCK_TYPES.map((type) => ({
                            content: blockTypeLabel(type),
                            onAction: () => handleAddBlock(type),
                          }))}
                        />
                      </Popover>
                    </Box>
                  </Box>
                )}

                {activeTab === 1 && (
                  <Box padding="400">
                    <BlockStack gap="300">
                      <InlineStack align="end">
                        <Button
                          onClick={() => {
                            navigator.clipboard
                              .writeText(compiledHtml())
                              .catch(() => {});
                          }}
                        >
                          Copy HTML
                        </Button>
                      </InlineStack>
                      <TextField
                        label="Compiled HTML"
                        labelHidden
                        value={compiledHtml()}
                        multiline={20}
                        autoComplete="off"
                        readOnly
                        monospaced
                      />
                    </BlockStack>
                  </Box>
                )}
              </Card>
            </BlockStack>
          </Layout.Section>

          {/* Block settings panel */}
          {selectedBlock && (
            <Layout.Section variant="oneThird">
              <BlockEditor
                block={selectedBlock}
                onChange={handleBlockChange}
                onClose={() => setSelectedBlockId(null)}
                onDelete={(id) => {
                  handleDeleteBlock(id);
                  setSelectedBlockId(null);
                }}
              />
            </Layout.Section>
          )}
        </Layout>
      </BlockStack>
    </Page>
  );
}
