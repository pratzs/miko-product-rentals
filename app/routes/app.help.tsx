import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Divider,
  Badge,
  List,
  Icon,
} from "@shopify/polaris";
import {
  MagicIcon,
  PlayIcon,
  QuestionCircleIcon,
  CodeIcon,
  ClockIcon,
  ChatIcon,
  LockIcon,
  ExternalIcon,
  ProductIcon,
  CalendarIcon,
  EmailIcon,
  StoreIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";

const EXTENSION_HANDLE = "rental-calendar";
const EMBED_HANDLE = "rental-display-rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopHandle = session.shop.replace(".myshopify.com", "");
  const clientId = process.env.SHOPIFY_API_KEY ?? "";
  return json({
    shopHandle,
    themeEditorBlockUrl: `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?template=product&addAppBlockId=${clientId}/${EXTENSION_HANDLE}&target=newAppsSection`,
    themeEditorEmbedUrl: `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps&activateAppId=${clientId}/${EMBED_HANDLE}`,
    appEmbedsUrl: `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps`,
    supportEmail: "hello@tripsterdevelopers.com",
  });
};

interface StepCardProps {
  number: number;
  icon: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  title: string;
  body: React.ReactNode;
  cta?: { label: string; url?: string; onClick?: () => void };
}

function StepCard({ number, icon, title, body, cta }: StepCardProps) {
  return (
    <Box
      padding="500"
      borderRadius="300"
      background="bg-surface"
      borderColor="border"
      borderWidth="025"
    >
      <BlockStack gap="300">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 15,
              boxShadow: "0 2px 8px rgba(99, 102, 241, 0.25)",
              flexShrink: 0,
            }}
          >
            {number}
          </div>
          <div style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon source={icon} tone="subdued" />
          </div>
          <Text as="h3" variant="headingSm">{title}</Text>
        </div>
        <Box paddingInlineStart="800">
          <BlockStack gap="300">
            <Text as="p" tone="subdued">{body}</Text>
            {cta && (
              <InlineStack>
                {cta.url ? (
                  <Button url={cta.url} target="_blank" variant="primary" icon={ExternalIcon}>
                    {cta.label}
                  </Button>
                ) : (
                  <Button onClick={cta.onClick} variant="primary">{cta.label}</Button>
                )}
              </InlineStack>
            )}
          </BlockStack>
        </Box>
      </BlockStack>
    </Box>
  );
}

interface JourneyStepProps {
  number: number;
  title: string;
  body: React.ReactNode;
}

function JourneyStep({ number, title, body }: JourneyStepProps) {
  return (
    <InlineStack gap="400" wrap={false} blockAlign="start">
      <Box minWidth="40px">
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            background: "#f4f3ff",
            color: "#6366f1",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {number}
        </div>
      </Box>
      <BlockStack gap="100">
        <Text as="h3" variant="headingSm">{title}</Text>
        <Text as="p" tone="subdued">{body}</Text>
      </BlockStack>
    </InlineStack>
  );
}

interface SectionHeaderProps {
  icon: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  title: string;
  tone?: "magic" | "success" | "warning" | "critical" | "info" | "subdued";
  iconBg?: string;
}

function SectionHeader({ icon, title, tone = "magic", iconBg = "#f4f3ff" }: SectionHeaderProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <div style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon source={icon} tone={tone} />
        </div>
      </div>
      <Text as="h2" variant="headingMd">{title}</Text>
    </div>
  );
}

interface ScenarioProps {
  question: string;
  answer: React.ReactNode;
}

function Scenario({ question, answer }: ScenarioProps) {
  return (
    <Box paddingBlock="400" paddingInline="100">
      <BlockStack gap="200">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ width: 20, height: 20, marginTop: 2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon source={QuestionCircleIcon} tone="magic" />
          </div>
          <Text as="h3" variant="headingSm">{question}</Text>
        </div>
        <Box paddingInlineStart="600">
          <Text as="p" tone="subdued">{answer}</Text>
        </Box>
      </BlockStack>
    </Box>
  );
}

export default function HelpPage() {
  const {
    themeEditorBlockUrl,
    themeEditorEmbedUrl,
    appEmbedsUrl,
    supportEmail,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  // Shopify embeds the admin app in an iframe, which blocks mailto: from
  // navigating to a system handler. window.top.location escapes the iframe
  // so the merchant's actual mail client opens. We fall back to window.open
  // for non-iframe contexts (local dev, standalone).
  function openMailto(subject: string, body?: string) {
    const params = new URLSearchParams();
    params.set("subject", subject);
    if (body) params.set("body", body);
    const href = `mailto:${supportEmail}?${params.toString()}`;
    try {
      const top = window.top || window;
      top.location.href = href;
    } catch {
      window.open(href, "_blank");
    }
  }

  return (
    <Page
      title="Help center"
      subtitle="Everything you need to launch and run rentals with confidence."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="600">
            {/* Hero */}
            <Box
              padding="600"
              borderRadius="400"
              background="bg-surface"
              borderColor="border"
              borderWidth="025"
            >
              <div
                style={{
                  background: "linear-gradient(135deg, #f4f3ff 0%, #ede9fe 50%, #f0f9ff 100%)",
                  borderRadius: 12,
                  padding: 24,
                  margin: -8,
                }}
              >
                <BlockStack gap="400">
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 12,
                        background: "#ffffff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: "0 2px 8px rgba(99, 102, 241, 0.15)",
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Icon source={MagicIcon} tone="magic" />
                      </div>
                    </div>
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingLg">Welcome to Miko</Text>
                      <Text as="p" tone="subdued">
                        Get your first rental product live in about 5 minutes. We will walk you through every step.
                      </Text>
                    </BlockStack>
                  </div>
                  <InlineStack gap="200" wrap>
                    <Button
                      variant="primary"
                      icon={ProductIcon}
                      onClick={() => navigate("/app/products")}
                    >
                      Add your first rental
                    </Button>
                    <Button
                      icon={ExternalIcon}
                      url={themeEditorBlockUrl}
                      target="_blank"
                    >
                      Open theme editor
                    </Button>
                    <Button
                      icon={EmailIcon}
                      onClick={() => openMailto("Miko support request")}
                      variant="plain"
                    >
                      Email support
                    </Button>
                  </InlineStack>
                </BlockStack>
              </div>
            </Box>

            {/* Quick Start */}
            <Card>
              <BlockStack gap="500">
                <InlineStack gap="300" align="space-between" blockAlign="center">
                  <BlockStack gap="200">
                    <SectionHeader icon={CheckCircleIcon} title="Quick start" tone="success" iconBg="#ecfdf5" />
                    <Text as="p" tone="subdued">
                      Follow these in order. The dashboard checklist ticks each one off as you go.
                    </Text>
                  </BlockStack>
                  <Badge tone="info">5 steps</Badge>
                </InlineStack>
                <BlockStack gap="300">
                  <StepCard
                    number={1}
                    icon={ProductIcon}
                    title="Add your first rental product"
                    body="Pick any product from your Shopify store and turn on rentals for it. Its normal listing stays the same. You are just adding a rental option on top."
                    cta={{ label: "Manage products", onClick: () => navigate("/app/products") }}
                  />
                  <StepCard
                    number={2}
                    icon={StoreIcon}
                    title="Set your rental pricing and units"
                    body={
                      <>
                        Enter at least a <strong>daily price</strong>. Weekly and monthly rates are optional and we will automatically apply the best one for the customer's chosen dates. Set <strong>Total units available</strong> to how many of this item you have on hand to rent out.
                      </>
                    }
                    cta={{ label: "Open products", onClick: () => navigate("/app/products") }}
                  />
                  <StepCard
                    number={3}
                    icon={CalendarIcon}
                    title="Add the booking calendar to your product page"
                    body="Open your theme editor and drop the Miko Rental Calendar block onto your product template. As soon as a customer views the product, we automatically detect that the calendar is live."
                    cta={{ label: "Open theme editor", url: themeEditorBlockUrl }}
                  />
                  <StepCard
                    number={4}
                    icon={CodeIcon}
                    title="Turn on the display rules (recommended)"
                    body="Enable the Miko Rental Display Rules app embed. It hides the normal price and Add to cart button on rental products so customers can only check out through the rental flow. It also adds a Rental badge on your collection pages."
                    cta={{ label: "Enable app embed", url: themeEditorEmbedUrl }}
                  />
                  <StepCard
                    number={5}
                    icon={EmailIcon}
                    title="Set your email sender name"
                    body="Customers receive booking confirmations, return reminders, and overdue notices from Miko. The sender name is what shows up in their inbox, usually your store name."
                    cta={{ label: "Email settings", onClick: () => navigate("/app/settings") }}
                  />
                </BlockStack>
              </BlockStack>
            </Card>

            {/* How it works */}
            <Card>
              <BlockStack gap="400">
                <SectionHeader icon={PlayIcon} title="How a rental flows through Miko" />
                <Text as="p" tone="subdued">
                  Here is what happens from the moment a customer picks their dates to the day the item is back on your shelf.
                </Text>
                <Box paddingBlockStart="200">
                  <BlockStack gap="400">
                    <JourneyStep
                      number={1}
                      title="Customer picks their dates"
                      body="The booking widget on your product page checks availability, calculates the rental fee and deposit, and shows the total before checkout."
                    />
                    <JourneyStep
                      number={2}
                      title="Customer clicks Book now"
                      body="The item is added to the standard Shopify cart with the rental dates and price attached. We override the cart price so the customer pays the rental amount, not the product's regular price."
                    />
                    <JourneyStep
                      number={3}
                      title="Order placed"
                      body="A pending booking appears in your dashboard right away, even before payment is captured. This is handy for Cash on Delivery or Net payment terms."
                    />
                    <JourneyStep
                      number={4}
                      title="Payment captured"
                      body="The booking automatically moves to Confirmed and the customer receives a booking confirmation email."
                    />
                    <JourneyStep
                      number={5}
                      title="Rental day arrives"
                      body="Miko flips the booking to Out on rental and sends a friendly return reminder the day before the return date."
                    />
                    <JourneyStep
                      number={6}
                      title="Item comes back"
                      body="Open the booking and click Mark as returned. If you enabled auto release of deposits, the deposit is released. Otherwise click Refund deposit and Miko sends the money back through Shopify to the customer's original payment method."
                    />
                    <JourneyStep
                      number={7}
                      title="Late returns"
                      body="If the return date passes, the booking moves to Overdue and the customer gets an overdue notice showing your late fee rate. When the item is back, click Record late fee and create a draft order in Shopify to collect."
                    />
                  </BlockStack>
                </Box>
              </BlockStack>
            </Card>

            {/* Common scenarios */}
            <Card>
              <BlockStack gap="400">
                <SectionHeader icon={QuestionCircleIcon} title="Common questions" />
                <Text as="p" tone="subdued">
                  Real situations you may run into and the quickest way to handle each one.
                </Text>
                <Divider />

                <Scenario
                  question="An order came in but I don't see a booking for it"
                  answer={
                    <>
                      Open the <strong>Bookings</strong> page and click <strong>Sync from Shopify</strong> at the top. It pulls in the last 50 orders and creates bookings for any that have rental info but were missed (usually because of a brief webhook outage). New orders going forward show up automatically.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="A booking is flagged as Needs review"
                  answer={
                    <>
                      That means an order came in for dates where you would be overbooked. For example, you have 2 units, both are already rented for those dates, and a third customer paid. Open the booking, contact the customer, and either refund or move their dates. The booking still holds inventory until you cancel it, so handle it before the rental day.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="The product page still shows the regular price"
                  answer={
                    <>
                      Two quick checks. First, go to <strong>Rental Products</strong> and click <strong>Sync with storefront</strong> so the rental flag is written to your product. Second, confirm the Miko Rental Display Rules app embed is turned on in the theme editor. Then do a hard refresh of the product page (<strong>Cmd + Shift + R</strong> on Mac or <strong>Ctrl + Shift + R</strong> on Windows) to clear the cached version.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="The customer's deposit needs to be refunded"
                  answer={
                    <>
                      Open the booking, scroll to <strong>Deposit management</strong>, and click <strong>Refund deposit to customer</strong>. We use Shopify's standard refund flow so the customer gets the money back on their original payment method, and Shopify automatically sends them a refund email.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="The customer damaged the item or did not return it"
                  answer={
                    <>
                      Open the booking, scroll to <strong>Deposit management</strong>, and click <strong>Mark forfeited</strong>. The deposit stays with you and the customer is not refunded. If you need to charge more than the deposit, create a draft order in Shopify for the extra amount and send them an invoice.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="I want to block out certain dates (holidays, maintenance)"
                  answer={
                    <>
                      Open the product, scroll to <strong>Blocked dates</strong>, and add the dates you want to keep unavailable. Customers will not be able to pick those dates in the calendar.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="I changed my plan but rentals are still being blocked at the limit"
                  answer={
                    <>
                      Plan changes apply right away, but if your monthly usage already passed the new plan's limit, it stays blocked until the next calendar month. The <strong>Awaiting payment</strong> count on your dashboard shows where you stand.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="I uninstalled and reinstalled the app"
                  answer={
                    <>
                      No worries, your products, bookings, settings, and email templates are all kept. Shopify cancels paid subscriptions on uninstall, so you will be on the Free plan until you reactivate from <strong>Pricing</strong>. The cart price override is set back up automatically when you reinstall.
                    </>
                  }
                />
              </BlockStack>
            </Card>

            {/* Multi-unit + overbooking */}
            <Card>
              <BlockStack gap="400">
                <SectionHeader icon={AlertCircleIcon} title="Multi unit rentals and overbooking protection" tone="warning" iconBg="#fffbeb" />
                <Text as="p">
                  Set <strong>Total units available</strong> on each product to how many physical copies you have on hand. When a product has more than one unit, customers see a quantity picker on the storefront, and the calendar only blocks dates when every unit is booked.
                </Text>
                <Text as="p">We protect you from overbooking in two places:</Text>
                <List type="bullet">
                  <List.Item>
                    The booking widget checks availability before the customer can pay and shows a clear warning if not enough units are free for their dates.
                  </List.Item>
                  <List.Item>
                    The order webhook checks again at order creation and at payment. If two customers race for the last unit, the second booking is created as <strong>Needs review</strong> instead of silently overbooking. A banner on your dashboard tells you what to do.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>

            {/* Theme compatibility */}
            <Card>
              <BlockStack gap="400">
                <SectionHeader icon={CodeIcon} title="Works on every modern Shopify theme" />
                <Text as="p">
                  Our display rules embed works automatically on every Shopify built theme (Dawn, Horizon, Sense, Refresh, Studio, Craft, Origin, and the rest) and the vast majority of third party themes. No setup needed beyond turning the embed on.
                </Text>
                <Box
                  background="bg-surface-info"
                  padding="400"
                  borderRadius="300"
                  borderColor="border-info"
                  borderWidth="025"
                >
                  <BlockStack gap="200">
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Icon source={AlertCircleIcon} tone="info" />
                      </div>
                      <Text as="h3" variant="headingSm">On a heavily customized theme?</Text>
                    </div>
                    <Text as="p" tone="subdued">
                      If the Rental badge does not appear or the price is still showing on rental cards, paste this snippet into your theme's main CSS file. Go to <strong>Online Store, then Themes, then Edit code, then assets/base.css</strong> (or whatever stylesheet your theme uses) and replace <code>.your-card-class</code> with the wrapper class your theme actually uses.
                    </Text>
                  </BlockStack>
                </Box>
                <Box
                  background="bg-surface-secondary"
                  borderRadius="200"
                  padding="400"
                  borderColor="border"
                  borderWidth="025"
                >
                  <pre style={{ margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", whiteSpace: "pre-wrap", lineHeight: "1.6" }}>
{`/* Miko fallback for custom themes */
.your-card-class[data-miko-rental-card] {
  position: relative;
}
.your-card-class[data-miko-rental-card] .your-price-class {
  display: none !important;
}
.your-card-class[data-miko-rental-card] .miko-rental-badge {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
  padding: 5px 10px;
  background: #0e1b3a;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-radius: 4px;
}`}
                  </pre>
                </Box>
                <Text as="p" tone="subdued">
                  Not sure what your class names are? Right click any product card on your storefront and choose <strong>Inspect</strong>. The wrapping element's <code>class</code> attribute is what goes in place of <code>.your-card-class</code>. The visible price element's class goes in place of <code>.your-price-class</code>.
                </Text>
                <Box
                  background="bg-surface-success"
                  padding="400"
                  borderRadius="300"
                  borderColor="border-success"
                  borderWidth="025"
                >
                  <InlineStack gap="400" align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">Don't want to touch code?</Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Send us your store URL and we will send back a ready to paste snippet tailored to your theme. Usually within one business day.
                      </Text>
                    </BlockStack>
                    <Button
                      onClick={() =>
                        openMailto(
                          "Custom theme CSS help",
                          "Hi Miko team,\n\nMy store URL: \nMy theme: \n\nThe Rental badge / price hide is not working on my collection pages. Could you send me a CSS snippet that works for my theme?\n\nThanks!",
                        )
                      }
                      variant="primary"
                      icon={EmailIcon}
                    >
                      Get a custom snippet
                    </Button>
                  </InlineStack>
                </Box>
              </BlockStack>
            </Card>

            {/* Late fees */}
            <Card>
              <BlockStack gap="400">
                <SectionHeader icon={ClockIcon} title="How late fees work" tone="critical" iconBg="#fef2f2" />
                <Text as="p">
                  Set the <strong>Late fee per day</strong> and a <strong>Grace period</strong> in Settings. After a rental's return date passes, Miko automatically marks it as Overdue and sends the customer an overdue notice showing your late fee rate.
                </Text>
                <Text as="p">
                  When the item is back, open the booking and click <strong>Record late fee</strong>. We calculate it as (days overdue minus your grace period) times your daily rate and save it on the booking. We do not auto charge the card. To collect, create a draft order in Shopify with a custom line item and send the invoice. This keeps you in control of any goodwill exceptions you want to make.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <SectionHeader icon={ExternalIcon} title="Quick links" />
                <BlockStack gap="200">
                  <Button url={themeEditorBlockUrl} target="_blank" fullWidth icon={CalendarIcon}>
                    Add calendar block
                  </Button>
                  <Button url={themeEditorEmbedUrl} target="_blank" fullWidth icon={CodeIcon}>
                    Enable display rules
                  </Button>
                  <Button url={appEmbedsUrl} target="_blank" fullWidth variant="plain">
                    All app embeds
                  </Button>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeader icon={ChatIcon} title="Talk to a human" tone="success" iconBg="#ecfdf5" />
                <Text as="p" tone="subdued">
                  Stuck on something? Email our team and we will get back to you within one business day.
                </Text>
                <Button onClick={() => openMailto("Miko support request")} fullWidth variant="primary" icon={EmailIcon}>
                  Email our team
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeader icon={MagicIcon} title="Beyond rentals?" />
                <Text as="p" tone="subdued">
                  Want to use Miko for event bookings, equipment hire, studio time, or any other date based booking? Tell us your use case and we will see if we can help.
                </Text>
                <Button
                  onClick={() =>
                    openMailto(
                      "Use case beyond rentals",
                      "Hi Miko team,\n\nI run a store on Shopify and I'm interested in using Miko for:\n\n(Describe your use case here, e.g. event bookings, equipment hire, studio time, appointments...)\n\nIs this something you can help with?\n\nThanks!",
                    )
                  }
                  fullWidth
                  icon={EmailIcon}
                >
                  Share your use case
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeader icon={LockIcon} title="Privacy and your data" tone="subdued" iconBg="#f3f4f6" />
                <Text as="p" tone="subdued">
                  Miko only stores the data you create through the app: rental products, bookings, settings, and email templates. Customer data is limited to the name, email, and phone attached to orders.
                </Text>
                <Text as="p" tone="subdued">
                  When you uninstall, your sessions are deleted right away and a 48 hour retention window lets you reinstall without losing anything. After that, your shop's data is fully deleted.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
