// Email template block types and HTML compilation utilities.

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

// ---------------------------------------------------------------------------
// Block types
// ---------------------------------------------------------------------------

export interface HeaderBlock {
  id: string;
  type: "header";
  logoUrl: string;
  backgroundColor: string;
}

export interface TextBlock {
  id: string;
  type: "text";
  content: string;
  fontSize: number;
  fontWeight: "normal" | "bold";
  textAlign: "left" | "center" | "right";
  color: string;
  paddingTop: number;
  paddingBottom: number;
}

export interface DetailsBlock {
  id: string;
  type: "details";
  title: string;
  backgroundColor: string;
}

export interface ButtonBlock {
  id: string;
  type: "button";
  text: string;
  url: string;
  backgroundColor: string;
  textColor: string;
}

export interface SpacerBlock {
  id: string;
  type: "spacer";
  height: number;
}

export interface DividerBlock {
  id: string;
  type: "divider";
  color: string;
}

export interface HtmlBlock {
  id: string;
  type: "html";
  content: string;
}

export type EmailBlock =
  | HeaderBlock
  | TextBlock
  | DetailsBlock
  | ButtonBlock
  | SpacerBlock
  | DividerBlock
  | HtmlBlock;

export interface BrandSettings {
  logoUrl?: string;
  primaryColor: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Template variables
// ---------------------------------------------------------------------------

export const TEMPLATE_VARIABLES: { label: string; value: string }[] = [
  { label: "Customer Name", value: "{{customer_name}}" },
  { label: "Customer Email", value: "{{customer_email}}" },
  { label: "Product Title", value: "{{product_title}}" },
  { label: "Order #", value: "{{order_name}}" },
  { label: "Start Date", value: "{{start_date}}" },
  { label: "End Date", value: "{{end_date}}" },
  { label: "Rental Days", value: "{{rental_days}}" },
  { label: "Rental Price", value: "{{rental_price}}" },
  { label: "Deposit Amount", value: "{{deposit_amount}}" },
  { label: "Shop Name", value: "{{shop_name}}" },
  { label: "Days Overdue", value: "{{days_overdue}}" },
  { label: "Late Fee/Day", value: "{{late_fee_per_day}}" },
];

// ---------------------------------------------------------------------------
// Default block builders
// ---------------------------------------------------------------------------

export function defaultConfirmationBlocks(): EmailBlock[] {
  return [
    {
      id: uid(),
      type: "header",
      logoUrl: "",
      backgroundColor: "#ffffff",
    } satisfies HeaderBlock,
    {
      id: uid(),
      type: "text",
      content: "Hi {{customer_name}},",
      fontSize: 16,
      fontWeight: "normal",
      textAlign: "left",
      color: "#333333",
      paddingTop: 32,
      paddingBottom: 8,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "text",
      content:
        "**Your booking is confirmed!** We're excited to have you rent with us. Here are the details of your booking:",
      fontSize: 16,
      fontWeight: "normal",
      textAlign: "left",
      color: "#333333",
      paddingTop: 8,
      paddingBottom: 16,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "details",
      title: "Booking Summary",
      backgroundColor: "#f9f9f9",
    } satisfies DetailsBlock,
    {
      id: uid(),
      type: "text",
      content:
        "If you have any questions about your booking, please don't hesitate to get in touch with us.",
      fontSize: 14,
      fontWeight: "normal",
      textAlign: "left",
      color: "#777777",
      paddingTop: 24,
      paddingBottom: 8,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "divider",
      color: "#e5e5e5",
    } satisfies DividerBlock,
    {
      id: uid(),
      type: "text",
      content: "Thanks for choosing {{shop_name}}!",
      fontSize: 13,
      fontWeight: "normal",
      textAlign: "center",
      color: "#999999",
      paddingTop: 16,
      paddingBottom: 24,
    } satisfies TextBlock,
  ];
}

export function defaultReturnReminderBlocks(): EmailBlock[] {
  return [
    {
      id: uid(),
      type: "header",
      logoUrl: "",
      backgroundColor: "#ffffff",
    } satisfies HeaderBlock,
    {
      id: uid(),
      type: "text",
      content: "Hi {{customer_name}},",
      fontSize: 16,
      fontWeight: "normal",
      textAlign: "left",
      color: "#333333",
      paddingTop: 32,
      paddingBottom: 8,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "text",
      content:
        "**Friendly reminder:** Your rental of **{{product_title}}** is due back tomorrow on {{end_date}}.",
      fontSize: 16,
      fontWeight: "normal",
      textAlign: "left",
      color: "#333333",
      paddingTop: 8,
      paddingBottom: 16,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "details",
      title: "Rental Details",
      backgroundColor: "#f9f9f9",
    } satisfies DetailsBlock,
    {
      id: uid(),
      type: "text",
      content:
        "To avoid late fees, please ensure the item is returned by the due date. If you need to extend your rental, please contact us as soon as possible.",
      fontSize: 14,
      fontWeight: "normal",
      textAlign: "left",
      color: "#777777",
      paddingTop: 24,
      paddingBottom: 8,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "divider",
      color: "#e5e5e5",
    } satisfies DividerBlock,
    {
      id: uid(),
      type: "text",
      content: "Thank you - {{shop_name}}",
      fontSize: 13,
      fontWeight: "normal",
      textAlign: "center",
      color: "#999999",
      paddingTop: 16,
      paddingBottom: 24,
    } satisfies TextBlock,
  ];
}

export function defaultOverdueBlocks(): EmailBlock[] {
  return [
    {
      id: uid(),
      type: "header",
      logoUrl: "",
      backgroundColor: "#ffffff",
    } satisfies HeaderBlock,
    {
      id: uid(),
      type: "text",
      content: "Hi {{customer_name}},",
      fontSize: 16,
      fontWeight: "normal",
      textAlign: "left",
      color: "#333333",
      paddingTop: 32,
      paddingBottom: 8,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "text",
      content:
        "**Your rental is overdue.** Your rental of **{{product_title}}** was due back on {{end_date}} and is now {{days_overdue}} day(s) overdue.",
      fontSize: 16,
      fontWeight: "normal",
      textAlign: "left",
      color: "#b91c1c",
      paddingTop: 8,
      paddingBottom: 16,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "details",
      title: "Rental Details",
      backgroundColor: "#fff7f7",
    } satisfies DetailsBlock,
    {
      id: uid(),
      type: "text",
      content:
        "A late fee of **{{late_fee_per_day}} per day** is being applied. Please return the item as soon as possible or contact us to make arrangements.",
      fontSize: 14,
      fontWeight: "normal",
      textAlign: "left",
      color: "#777777",
      paddingTop: 24,
      paddingBottom: 8,
    } satisfies TextBlock,
    {
      id: uid(),
      type: "divider",
      color: "#e5e5e5",
    } satisfies DividerBlock,
    {
      id: uid(),
      type: "text",
      content: "{{shop_name}}",
      fontSize: 13,
      fontWeight: "normal",
      textAlign: "center",
      color: "#999999",
      paddingTop: 16,
      paddingBottom: 24,
    } satisfies TextBlock,
  ];
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderInlineMarkdown(text: string): string {
  // Escape HTML first, then convert **bold** to <strong>
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function renderBlock(block: EmailBlock, brand: BrandSettings): string {
  switch (block.type) {
    case "header": {
      const bg = block.backgroundColor || "#ffffff";
      const content = block.logoUrl
        ? `<img src="${escapeHtml(block.logoUrl)}" alt="${escapeHtml(brand.name)}" style="max-height:60px;max-width:200px;display:block;" />`
        : `<span style="font-size:22px;font-weight:700;color:${escapeHtml(brand.primaryColor)};">${escapeHtml(brand.name)}</span>`;
      return `<tr><td style="background:${escapeHtml(bg)};padding:24px 32px;">${content}</td></tr>`;
    }

    case "text": {
      const align = block.textAlign || "left";
      const weight = block.fontWeight === "bold" ? "700" : "400";
      const fontSize = block.fontSize || 16;
      const color = block.color || "#333333";
      const ptTop = block.paddingTop ?? 16;
      const ptBottom = block.paddingBottom ?? 16;
      const rendered = renderInlineMarkdown(block.content || "");
      return `<tr><td style="padding:${ptTop}px 32px ${ptBottom}px 32px;font-size:${fontSize}px;font-weight:${weight};color:${escapeHtml(color)};text-align:${escapeHtml(align)};line-height:1.6;">${rendered}</td></tr>`;
    }

    case "details": {
      const bg = block.backgroundColor || "#f9f9f9";
      const title = escapeHtml(block.title || "Booking Details");
      const rows = [
        ["Order #", "{{order_name}}"],
        ["Product", "{{product_title}}"],
        ["Start Date", "{{start_date}}"],
        ["End Date", "{{end_date}}"],
        ["Rental Days", "{{rental_days}}"],
        ["Rental Price", "{{rental_price}}"],
        ["Deposit", "{{deposit_amount}}"],
      ];
      const rowsHtml = rows
        .map(
          ([label, value]) =>
            `<tr>
              <td style="padding:8px 16px;font-size:14px;color:#666666;width:40%;border-bottom:1px solid #eeeeee;">${label}</td>
              <td style="padding:8px 16px;font-size:14px;color:#333333;font-weight:600;border-bottom:1px solid #eeeeee;">${value}</td>
            </tr>`,
        )
        .join("");
      return `<tr><td style="padding:16px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${escapeHtml(bg)};border-radius:6px;overflow:hidden;">
          <tr><td colspan="2" style="padding:12px 16px;font-size:15px;font-weight:700;color:#333333;border-bottom:2px solid #eeeeee;">${title}</td></tr>
          ${rowsHtml}
        </table>
      </td></tr>`;
    }

    case "button": {
      const bg = block.backgroundColor || brand.primaryColor;
      const textColor = block.textColor || "#ffffff";
      const text = escapeHtml(block.text || "Click here");
      const url = escapeHtml(block.url || "#");
      return `<tr><td style="padding:16px 32px;text-align:center;">
        <a href="${url}" style="display:inline-block;background:${escapeHtml(bg)};color:${escapeHtml(textColor)};text-decoration:none;padding:12px 28px;border-radius:6px;font-size:15px;font-weight:600;">${text}</a>
      </td></tr>`;
    }

    case "spacer": {
      const h = block.height || 24;
      return `<tr><td style="height:${h}px;line-height:${h}px;">&nbsp;</td></tr>`;
    }

    case "divider": {
      const color = block.color || "#e5e5e5";
      return `<tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid ${escapeHtml(color)};margin:0;" /></td></tr>`;
    }

    case "html": {
      // Raw HTML block - rendered as-is (merchant-controlled content)
      return `<tr><td style="padding:0 32px;">${block.content || ""}</td></tr>`;
    }

    default:
      return "";
  }
}

export function compileBlocksToHtml(
  blocks: EmailBlock[],
  brand: BrandSettings,
  subject: string,
): string {
  const blockRows = blocks.map((b) => renderBlock(b, brand)).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
        ${blockRows}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function substituteVariables(
  html: string,
  vars: Record<string, string>,
): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return key in vars ? vars[key] : `{{${key}}}`;
  });
}

export function getDefaultSubject(type: string): string {
  switch (type) {
    case "confirmation":
      return "Your rental booking is confirmed - {{order_name}}";
    case "return_reminder":
      return "Reminder: {{product_title}} is due back tomorrow";
    case "overdue":
      return "Your rental {{order_name}} is overdue";
    default:
      return "Message from {{shop_name}}";
  }
}
