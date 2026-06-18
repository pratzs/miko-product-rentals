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
  Banner,
  Badge,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

const APP_HANDLE = "miko-product-rentals";
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
    supportEmail: "support@miko.co.nz",
  });
};

interface StepProps {
  number: number;
  title: string;
  body: React.ReactNode;
  cta?: { label: string; url?: string; onClick?: () => void };
}

function Step({ number, title, body, cta }: StepProps) {
  return (
    <Box paddingBlock="300">
      <InlineStack gap="400" wrap={false} blockAlign="start">
        <Box minWidth="32px">
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              background: "#eef2ff",
              color: "#4338ca",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            {number}
          </div>
        </Box>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">{title}</Text>
          <Text as="p" tone="subdued">{body}</Text>
          {cta && (
            <InlineStack>
              {cta.url ? (
                <Button url={cta.url} target="_blank">{cta.label}</Button>
              ) : (
                <Button onClick={cta.onClick}>{cta.label}</Button>
              )}
            </InlineStack>
          )}
        </BlockStack>
      </InlineStack>
    </Box>
  );
}

interface ScenarioProps {
  question: string;
  answer: React.ReactNode;
}

function Scenario({ question, answer }: ScenarioProps) {
  return (
    <Box paddingBlock="300">
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">{question}</Text>
        <Text as="p" tone="subdued">{answer}</Text>
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

  return (
    <Page
      title="Help & how-to"
      subtitle="Everything you need to run rentals smoothly."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="600">
            {/* Quick Start */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">Quick start - get your first rental live in 5 minutes</Text>
                    <Badge tone="info">5 steps</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Follow these in order. The dashboard checklist will tick each one off as you go.
                  </Text>
                </BlockStack>
                <Divider />

                <Step
                  number={1}
                  title="Add your first rental product"
                  body="Pick any product from your Shopify store and enable it for rentals. Its normal listing stays exactly the same - you're just adding a rental layer on top."
                  cta={{ label: "Add a product", onClick: () => navigate("/app/products/new") }}
                />
                <Divider />

                <Step
                  number={2}
                  title="Set the rental price and units"
                  body={
                    <>
                      Enter at least a <strong>daily price</strong>. Weekly and monthly are optional - we'll pick the cheapest valid rate for the customer's chosen dates automatically. Set <strong>Total units available</strong> to how many physical copies of this item you have to rent out.
                    </>
                  }
                  cta={{ label: "Manage products", onClick: () => navigate("/app/products") }}
                />
                <Divider />

                <Step
                  number={3}
                  title="Add the booking calendar to your product page"
                  body="Open the theme editor and drop the Miko Rental Calendar block onto your product template. Once a customer views the product, we'll auto-detect the block is live."
                  cta={{ label: "Open theme editor", url: themeEditorBlockUrl }}
                />
                <Divider />

                <Step
                  number={4}
                  title="Hide regular price + Add to cart for rental products (recommended)"
                  body="Turn on the Miko Rental Display Rules app embed. It uses a metafield to hide the standard price and buy buttons on any product you've marked as a rental - so customers can only check out via the rental flow."
                  cta={{ label: "Enable app embed", url: themeEditorEmbedUrl }}
                />
                <Divider />

                <Step
                  number={5}
                  title="Set your sender name"
                  body="Customers will receive booking confirmation, return reminder, and overdue emails. The sender name shows in their inbox - usually your store name."
                  cta={{ label: "Email identity", onClick: () => navigate("/app/settings") }}
                />
              </BlockStack>
            </Card>

            {/* How it works */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">How rentals flow through Miko</Text>
                <Divider />
                <BlockStack gap="300">
                  <Text as="p">
                    <strong>1. Customer picks dates on your product page.</strong> The widget calls our API to confirm units are available, calculates the rental fee + deposit, and shows the total at checkout.
                  </Text>
                  <Text as="p">
                    <strong>2. Customer clicks Book now.</strong> The item is added to the standard Shopify cart with the dates and per-unit price as line item properties. A <em>Cart Transform Function</em> overrides the price in checkout so the customer pays the rental amount, not the product's list price.
                  </Text>
                  <Text as="p">
                    <strong>3. Order placed.</strong> A pending booking appears in your dashboard immediately - even before payment is captured. Useful for Cash on Delivery / Net 45 flows.
                  </Text>
                  <Text as="p">
                    <strong>4. Payment captured.</strong> The booking auto-upgrades to <em>Confirmed</em> and the customer receives the booking confirmation email.
                  </Text>
                  <Text as="p">
                    <strong>5. Rental day arrives.</strong> The daily cron flips the booking to <em>Out on rental</em> and sends a return reminder the day before the return date.
                  </Text>
                  <Text as="p">
                    <strong>6. Item returned.</strong> Open the booking and click <em>Mark as returned</em>. If you've enabled auto-release of deposits, we'll mark it released for you. Otherwise click <em>Refund deposit to customer</em> and we'll process a Shopify refund to their original payment method.
                  </Text>
                  <Text as="p">
                    <strong>7. Late returns.</strong> The cron flips active bookings to <em>Overdue</em> after the return date passes and sends an overdue notice with your late fee rate. When the item is back, click <em>Record late fee</em> on the booking and create a draft order in Shopify to charge them.
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Common scenarios */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">What to do when...</Text>
                  <Text as="p" tone="subdued">Common situations and the quickest way to handle them.</Text>
                </BlockStack>
                <Divider />

                <Scenario
                  question="An order came in but I don't see a booking"
                  answer={
                    <>
                      Open the <strong>Bookings</strong> page and click <strong>Sync from Shopify</strong> at the top. It pulls the last 50 orders and creates bookings for any that have rental data but were missed (typically because of webhook downtime). New orders going forward show up automatically.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="A booking is flagged as Needs review"
                  answer={
                    <>
                      That means an order came in for dates where you'd be overbooked - e.g. you have 2 units and 2 are already rented for those dates, and a 3rd customer paid. Open the booking, contact the customer, and either refund or shift their dates. The booking still holds inventory until you cancel it, so deal with it before the rental day.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="The product page still shows the regular price"
                  answer={
                    <>
                      Two things to check. First, in <strong>Rental Products</strong> click <strong>Sync with storefront</strong> - this writes the rental metafield Shopify needs. Second, confirm the Miko Rental Display Rules app embed is enabled in your theme editor. Hard-refresh the product page (Cmd+Shift+R) afterwards.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="The customer's deposit needs to be refunded"
                  answer={
                    <>
                      Open the booking → in the <strong>Deposit management</strong> section click <strong>Refund X to customer</strong>. We call Shopify's refund API directly so the customer gets the money back on their original payment method, and they're notified by Shopify's standard refund email.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="The customer damaged the item or didn't return it"
                  answer={
                    <>
                      Open the booking → in the <strong>Deposit management</strong> section click <strong>Mark forfeited</strong>. The deposit stays with you and the customer's not refunded. For anything beyond the deposit, create a draft order in Shopify and send them an invoice.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="I want to block certain dates (holidays, maintenance)"
                  answer={
                    <>
                      Open the product → scroll to <strong>Blocked dates</strong> and add the dates you want unavailable. Customers won't be able to pick those dates in the calendar.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="I changed my plan but rentals are still being rejected at the limit"
                  answer={
                    <>
                      Plan changes are reflected immediately, but if your monthly usage already exceeded the new plan's limit it stays blocked until the next calendar month. The dashboard's <strong>Awaiting payment</strong> count helps you see this.
                    </>
                  }
                />
                <Divider />

                <Scenario
                  question="I uninstalled and reinstalled the app"
                  answer={
                    <>
                      Your products, bookings, settings, and email templates are all preserved. Your previous paid subscription was cancelled by Shopify on uninstall - you'll be on the Free plan until you reactivate from <strong>Pricing</strong>. The Cart Transform Function is recreated automatically during reinstall.
                    </>
                  }
                />
              </BlockStack>
            </Card>

            {/* Multi-unit + overbooking explainer */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Multi-unit rentals and overbooking protection</Text>
                <Divider />
                <Text as="p">
                  Set <strong>Total units available</strong> on each product to how many physical copies you have to rent out. When a product has more than one unit, customers see a quantity picker on the storefront and the calendar only blocks dates when <em>every</em> unit is booked.
                </Text>
                <Text as="p">
                  We protect you from overbooking in two places:
                </Text>
                <List type="bullet">
                  <List.Item>
                    The booking widget checks unit availability before the customer can pay - it shows a "Only X units available for these dates" warning if needed.
                  </List.Item>
                  <List.Item>
                    The webhook handler re-checks at order creation and at payment. If a race with another customer would push you over capacity, the booking is created as <strong>Needs review</strong> instead of silently overbooking. You'll see a banner on the dashboard until you resolve it.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>

            {/* Late fees */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Theme compatibility</Text>
                <Divider />
                <Text as="p">
                  Our app embed (<strong>Miko Rental Display Rules</strong>) auto-hides the regular price and injects a <strong>Rental</strong> badge on rental product cards across your storefront. It works out of the box on every Shopify-built theme (Dawn, Horizon, Sense, Refresh, Studio, Craft, Origin, and the rest) and the vast majority of third-party themes.
                </Text>
                <Text as="p">
                  If you're on a heavily customized theme and the badge doesn't appear or the price isn't hidden on rental cards, paste this snippet into your theme's CSS file (<strong>Online Store → Themes → Edit code → assets/base.css</strong> or your theme's main stylesheet). Replace <code>.your-card-class</code> with the wrapper class your theme uses for each product card:
                </Text>
                <Box
                  background="bg-surface-secondary"
                  borderRadius="200"
                  padding="300"
                  borderColor="border"
                  borderWidth="025"
                >
                  <pre style={{ margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", whiteSpace: "pre-wrap", lineHeight: "1.5" }}>
{`/* Miko - custom-theme fallback for rental product cards */
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
                  Not sure what your card / price class names are? Right-click a product card on your storefront → <strong>Inspect</strong>. The wrapping element's <code>class</code> attribute is what goes in place of <code>.your-card-class</code>; the visible price element's class goes in <code>.your-price-class</code>.
                </Text>
                <Text as="p" tone="subdued">
                  If you'd rather not touch code, email support and we'll send you a snippet tailored to your theme.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">How late fees work</Text>
                <Divider />
                <BlockStack gap="200">
                  <Text as="p">
                    Set the <strong>Late fee per day</strong> and <strong>Grace period</strong> in Settings. After a rental's return date passes, the daily cron auto-flips it to <em>Overdue</em> and sends an overdue notice showing your rate.
                  </Text>
                  <Text as="p">
                    When the item is returned, open the booking and click <strong>Record late fee</strong>. We calculate <em>(days overdue - grace) × rate</em> and store it on the booking. We don't auto-charge the customer's card - to collect, create a draft order in Shopify with a custom line item and send the invoice. This keeps you in control of any goodwill exceptions.
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Sidebar */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Direct links</Text>
                <BlockStack gap="200">
                  <Button url={themeEditorBlockUrl} target="_blank" fullWidth>
                    Add calendar block
                  </Button>
                  <Button url={themeEditorEmbedUrl} target="_blank" fullWidth>
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
                <Text as="h2" variant="headingMd">Need a human?</Text>
                <Text as="p" tone="subdued">
                  Reach our team and we'll get back within one business day.
                </Text>
                <Button url={`mailto:${supportEmail}`} external fullWidth variant="primary">
                  Email support
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Privacy & data</Text>
                <Text as="p" tone="subdued">
                  We only store the data you create through the app: rental products, bookings, settings, and email templates. Customer data is limited to the name, email, and phone attached to orders.
                </Text>
                <Text as="p" tone="subdued">
                  When you uninstall, your sessions are deleted immediately and a 48-hour data retention window lets you reinstall without losing anything. After that, GDPR webhooks fully delete your shop's data.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
