import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import type { ComponentProps, ReactNode } from "react";
import { Banner, Grid } from "../components/polaris";
import { MAIN_WITH_SIDEBAR } from "../components/layout";
import { authenticate } from "../shopify.server";
import { useT } from "../i18n/context";

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

type IconName = ComponentProps<"s-icon">["type"];

/** Numbered square used by the quick start and journey lists. */
function StepNumber({ n, round }: { n: number; round?: boolean }) {
  return (
    <s-box
      inlineSize={round ? "32px" : "28px"}
      blockSize={round ? "32px" : "28px"}
      background="subdued"
      borderRadius={round ? "large-200" : "base"}
    >
      <s-stack direction="block" alignItems="center" justifyContent="center" blockSize="100%">
        <s-text type="strong">{n}</s-text>
      </s-stack>
    </s-box>
  );
}

interface StepCardProps {
  number: number;
  icon: IconName;
  title: string;
  body: ReactNode;
  cta?: { label: string; url?: string; onClick?: () => void };
}

function StepCard({ number, icon, title, body, cta }: StepCardProps) {
  return (
    <s-box padding="base" borderRadius="large" border="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <StepNumber n={number} />
          <s-icon type={icon} color="subdued" />
          <s-heading>{title}</s-heading>
        </s-stack>
        <s-box paddingInlineStart="large-200">
          <s-stack direction="block" gap="small">
            <s-paragraph color="subdued">{body}</s-paragraph>
            {cta && (
              <s-box>
                {cta.url ? (
                  <s-button href={cta.url} target="_blank" variant="primary" icon="external">
                    {cta.label}
                  </s-button>
                ) : (
                  <s-button onClick={cta.onClick} variant="primary">{cta.label}</s-button>
                )}
              </s-box>
            )}
          </s-stack>
        </s-box>
      </s-stack>
    </s-box>
  );
}

interface JourneyStepProps {
  number: number;
  title: string;
  body: ReactNode;
}

function JourneyStep({ number, title, body }: JourneyStepProps) {
  return (
    // Fixed two-column grid: the number column must never wrap above the text.
    <s-grid gridTemplateColumns="40px 1fr" gap="base" alignItems="start">
      <StepNumber n={number} round />
      <s-stack direction="block" gap="small-300">
        <s-heading>{title}</s-heading>
        <s-paragraph color="subdued">{body}</s-paragraph>
      </s-stack>
    </s-grid>
  );
}

interface SectionHeaderProps {
  icon: IconName;
  title: string;
}

/** Native admin section heading: a neutral icon chip and the title. */
function SectionHeader({ icon, title }: SectionHeaderProps) {
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-box background="subdued" borderRadius="base" padding="small-300">
        <s-icon type={icon} color="subdued" />
      </s-box>
      <s-heading>{title}</s-heading>
    </s-stack>
  );
}

interface ScenarioProps {
  question: string;
  answer: ReactNode;
}

function Scenario({ question, answer }: ScenarioProps) {
  return (
    <s-box paddingBlock="base" paddingInline="small-300">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small" alignItems="start">
          <s-icon type="question-circle" color="subdued" />
          <s-heading>{question}</s-heading>
        </s-stack>
        <s-box paddingInlineStart="large">
          <s-paragraph color="subdued">{answer}</s-paragraph>
        </s-box>
      </s-stack>
    </s-box>
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
  const t = useT();

  // Shopify embeds the admin app in an iframe, which blocks mailto: from
  // navigating to a system handler. window.top.location escapes the iframe
  // so the merchant's actual mail client opens. We fall back to window.open
  // for non-iframe contexts (local dev, standalone).
  function openMailto(subject: string, body?: string) {
    // mailto URIs expect RFC 3986 percent-encoding. URLSearchParams uses
    // application/x-www-form-urlencoded which turns spaces into "+" and
    // some mail clients show the "+" literally instead of decoding it.
    // encodeURIComponent gives us proper %20 for spaces.
    const parts = [`subject=${encodeURIComponent(subject)}`];
    if (body) parts.push(`body=${encodeURIComponent(body)}`);
    const href = `mailto:${supportEmail}?${parts.join("&")}`;
    try {
      const top = window.top || window;
      top.location.href = href;
    } catch {
      window.open(href, "_blank");
    }
  }


  return (
    <s-page heading={t("Help center")} inlineSize="large">
      <s-stack direction="block" gap="large">
        <s-text color="subdued">{t("Everything you need to launch and run rentals with confidence.")}</s-text>

        <s-section>
          <s-stack direction="block" gap="small-200">
            <s-heading>{t("Full documentation")}</s-heading>
            <s-paragraph color="subdued">
              {t("Every feature, step by step, with a troubleshooting guide. Opens in a new tab.")}
            </s-paragraph>
            <s-box>
              <s-button onClick={() => window.open("https://miko.co.nz/docs/rentals/", "_blank")}>
                {t("Open the documentation")}
              </s-button>
            </s-box>
          </s-stack>
        </s-section>

        <Grid columns={MAIN_WITH_SIDEBAR} gap="large">
          <s-stack direction="block" gap="large">
            {/* Hero: the brand navy header, as on the dashboard. Brand block,
                drawn with our own classes; it does not restyle with Polaris. */}
            <div className="miko-gradient-bg" style={{ borderRadius: 12, padding: "24px 28px" }}>
              <div style={{ position: "relative", zIndex: 1 }}>
                <s-stack direction="block" gap="base">
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 10,
                        background: "rgba(255,255,255,0.12)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        color: "#ffffff",
                      }}
                    >
                      <s-icon type="magic" />
                    </div>
                    <s-stack direction="block" gap="small-300">
                      <s-heading>
                        <span style={{ color: "#ffffff" }}>{t("Welcome to Miko")}</span>
                      </s-heading>
                      <s-paragraph>
                        <span style={{ color: "rgba(255,255,255,0.85)" }}>
                          {t("Get your first rental product live in about 5 minutes. We will walk you through every step.")}
                        </span>
                      </s-paragraph>
                    </s-stack>
                  </div>
                  <s-stack direction="inline" gap="small-200">
                    <s-button variant="primary" icon="product" onClick={() => navigate("/app/products")}>
                      {t("Add your first rental")}
                    </s-button>
                    <s-button icon="external" href={themeEditorBlockUrl} target="_blank">
                      {t("Open theme editor")}
                    </s-button>
                    <s-button icon="email" onClick={() => openMailto(t("Miko support request"))}>
                      {t("Email support")}
                    </s-button>
                  </s-stack>
                </s-stack>
              </div>
            </div>

            {/* Quick Start */}
            <s-section>
              <s-stack direction="block" gap="large">
                <s-stack direction="inline" gap="small" justifyContent="space-between" alignItems="center">
                  <s-stack direction="block" gap="small-200">
                    <SectionHeader icon="check-circle" title={t("Quick start")} />
                    <s-paragraph color="subdued">
                      {t("Follow these in order. The dashboard checklist ticks each one off as you go.")}
                    </s-paragraph>
                  </s-stack>
                  <s-badge tone="info">{t("5 steps")}</s-badge>
                </s-stack>
                <s-stack direction="block" gap="small">
                  <StepCard
                    number={1}
                    icon="product"
                    title={t("Add your first rental product")}
                    body={t("Pick any product from your Shopify store and turn on rentals for it. Its normal listing stays the same. You are just adding a rental option on top.")}
                    cta={{ label: t("Manage products"), onClick: () => navigate("/app/products") }}
                  />
                  <StepCard
                    number={2}
                    icon="store"
                    title={t("Set your rental pricing and units")}
                    body={
                      <>
                        {t("Enter at least a")} <s-text type="strong">{t("daily price")}</s-text>{t(". Weekly and monthly rates are optional and we will automatically apply the best one for the customer's chosen dates. Set")} <s-text type="strong">{t("Total units available")}</s-text> {t("to how many of this item you have on hand to rent out.")}
                      </>
                    }
                    cta={{ label: t("Open products"), onClick: () => navigate("/app/products") }}
                  />
                  <StepCard
                    number={3}
                    icon="calendar"
                    title={t("Add the booking calendar to your product page")}
                    body={t("Open your theme editor and drop the Miko Rental Calendar block onto your product template. As soon as a customer views the product, we automatically detect that the calendar is live.")}
                    cta={{ label: t("Open theme editor"), url: themeEditorBlockUrl }}
                  />
                  <StepCard
                    number={4}
                    icon="code"
                    title={t("Turn on the display rules (recommended)")}
                    body={t("Enable the Miko Rental Display Rules app embed. It hides the normal price and Add to cart button on rental products so customers can only check out through the rental flow. It also adds a Rental badge on your collection pages.")}
                    cta={{ label: t("Enable app embed"), url: themeEditorEmbedUrl }}
                  />
                  <StepCard
                    number={5}
                    icon="email"
                    title={t("Set your email sender name")}
                    body={t("Customers receive booking confirmations, return reminders, and overdue notices from Miko. The sender name is what shows up in their inbox, usually your store name.")}
                    cta={{ label: t("Email settings"), onClick: () => navigate("/app/settings") }}
                  />
                </s-stack>
              </s-stack>
            </s-section>

            {/* How it works */}
            <s-section>
              <s-stack direction="block" gap="base">
                <SectionHeader icon="play" title={t("How a rental flows through Miko")} />
                <s-paragraph color="subdued">
                  {t("Here is what happens from the moment a customer picks their dates to the day the item is back on your shelf.")}
                </s-paragraph>
                <s-box paddingBlockStart="small-200">
                  <s-stack direction="block" gap="base">
                    <JourneyStep
                      number={1}
                      title={t("Customer picks their dates")}
                      body={t("The booking widget on your product page checks availability, calculates the rental fee and deposit, and shows the total before checkout.")}
                    />
                    <JourneyStep
                      number={2}
                      title={t("Customer clicks Book now")}
                      body={t("The item is added to the standard Shopify cart with the rental dates and price attached. We override the cart price so the customer pays the rental amount, not the product's regular price.")}
                    />
                    <JourneyStep
                      number={3}
                      title={t("Order placed")}
                      body={t("A pending booking appears in your dashboard right away, even before payment is captured. This is handy for Cash on Delivery or Net payment terms.")}
                    />
                    <JourneyStep
                      number={4}
                      title={t("Payment captured")}
                      body={t("The booking automatically moves to Confirmed and the customer receives a booking confirmation email.")}
                    />
                    <JourneyStep
                      number={5}
                      title={t("Rental day arrives")}
                      body={t("Miko flips the booking to Out on rental and sends a friendly return reminder the day before the return date.")}
                    />
                    <JourneyStep
                      number={6}
                      title={t("Item comes back")}
                      body={t("Open the booking and click Mark as returned. If you enabled auto release of deposits, the deposit is released. Otherwise click Refund deposit and Miko sends the money back through Shopify to the customer's original payment method.")}
                    />
                    <JourneyStep
                      number={7}
                      title={t("Late returns")}
                      body={t("If the return date passes, the booking moves to Overdue and the customer gets an overdue notice showing your late fee rate. When the item is back, click Record late fee and create a draft order in Shopify to collect.")}
                    />
                  </s-stack>
                </s-box>
              </s-stack>
            </s-section>

            {/* Common scenarios */}
            <s-section>
              <s-stack direction="block" gap="base">
                <SectionHeader icon="question-circle" title={t("Common questions")} />
                <s-paragraph color="subdued">
                  {t("Real situations you may run into and the quickest way to handle each one.")}
                </s-paragraph>
                <s-divider />

                <Scenario
                  question={t("An order came in but I don't see a booking for it")}
                  answer={
                    <>
                      {t("Open the")} <s-text type="strong">{t("Bookings")}</s-text> {t("page and click")} <s-text type="strong">{t("Sync from Shopify")}</s-text> {t("at the top. It pulls in the last 50 orders and creates bookings for any that have rental info but were missed (usually because of a brief webhook outage). New orders going forward show up automatically.")}
                    </>
                  }
                />
                <s-divider />

                <Scenario
                  question={t("A booking is flagged as Needs review")}
                  answer={
                    <>
                      {t("That means an order came in for dates where you would be overbooked. For example, you have 2 units, both are already rented for those dates, and a third customer paid. Open the booking, contact the customer, and either refund or move their dates. The booking still holds inventory until you cancel it, so handle it before the rental day.")}
                    </>
                  }
                />
                <s-divider />

                <Scenario
                  question={t("The product page still shows the regular price")}
                  answer={
                    <>
                      {t("Two quick checks. First, go to")} <s-text type="strong">{t("Rental Products")}</s-text> {t("and click")} <s-text type="strong">{t("Sync with storefront")}</s-text> {t("so the rental flag is written to your product. Second, confirm the Miko Rental Display Rules app embed is turned on in the theme editor. Then do a hard refresh of the product page (")}<s-text type="strong">{t("Cmd + Shift + R")}</s-text> {t("on Mac or")} <s-text type="strong">{t("Ctrl + Shift + R")}</s-text> {t("on Windows) to clear the cached version.")}
                    </>
                  }
                />
                <s-divider />

                <Scenario
                  question={t("The customer's deposit needs to be refunded")}
                  answer={
                    <>
                      {t("Open the booking, scroll to")} <s-text type="strong">{t("Deposit management")}</s-text>{t(", and click")} <s-text type="strong">{t("Refund deposit to customer")}</s-text>{t(". We use Shopify's standard refund flow so the customer gets the money back on their original payment method, and Shopify automatically sends them a refund email.")}
                    </>
                  }
                />
                <s-divider />

                <Scenario
                  question={t("The customer damaged the item or did not return it")}
                  answer={
                    <>
                      {t("Open the booking, scroll to")} <s-text type="strong">{t("Deposit management")}</s-text>{t(", and click")} <s-text type="strong">{t("Mark forfeited")}</s-text>{t(". The deposit stays with you and the customer is not refunded. If you need to charge more than the deposit, create a draft order in Shopify for the extra amount and send them an invoice.")}
                    </>
                  }
                />
                <s-divider />

                <Scenario
                  question={t("I want to block out certain dates (holidays, maintenance)")}
                  answer={
                    <>
                      {t("Open the product, scroll to")} <s-text type="strong">{t("Blocked dates")}</s-text>{t(", and add the dates you want to keep unavailable. Customers will not be able to pick those dates in the calendar.")}
                    </>
                  }
                />
                <s-divider />

                <Scenario
                  question={t("I changed my plan but rentals are still being blocked at the limit")}
                  answer={
                    <>
                      {t("Plan changes apply right away, but if your monthly usage already passed the new plan's limit, it stays blocked until the next calendar month. The")} <s-text type="strong">{t("Awaiting payment")}</s-text> {t("count on your dashboard shows where you stand.")}
                    </>
                  }
                />
                <s-divider />

                <Scenario
                  question={t("I uninstalled and reinstalled the app")}
                  answer={
                    <>
                      {t("No worries, your products, bookings, settings, and email templates are all kept. Shopify cancels paid subscriptions on uninstall, so you will be on the Free plan until you reactivate from")} <s-text type="strong">{t("Pricing")}</s-text>{t(". The cart price override is set back up automatically when you reinstall.")}
                    </>
                  }
                />
              </s-stack>
            </s-section>

            {/* Multi-unit + overbooking */}
            <s-section>
              <s-stack direction="block" gap="base">
                <SectionHeader icon="alert-circle" title={t("Multi unit rentals and overbooking protection")} />
                <s-paragraph>
                  {t("Set")} <s-text type="strong">{t("Total units available")}</s-text> {t("on each product to how many physical copies you have on hand. When a product has more than one unit, customers see a quantity picker on the storefront, and the calendar only blocks dates when every unit is booked.")}
                </s-paragraph>
                <s-paragraph>{t("We protect you from overbooking in two places:")}</s-paragraph>
                <s-unordered-list>
                  <s-list-item>
                    {t("The booking widget checks availability before the customer can pay and shows a clear warning if not enough units are free for their dates.")}
                  </s-list-item>
                  <s-list-item>
                    {t("The order webhook checks again at order creation and at payment. If two customers race for the last unit, the second booking is created as")} <s-text type="strong">{t("Needs review")}</s-text> {t("instead of silently overbooking. A banner on your dashboard tells you what to do.")}
                  </s-list-item>
                </s-unordered-list>
              </s-stack>
            </s-section>

            {/* Theme compatibility */}
            <s-section>
              <s-stack direction="block" gap="base">
                <SectionHeader icon="code" title={t("Works on every modern Shopify theme")} />
                <s-paragraph>
                  {t("Our display rules embed works automatically on every Shopify built theme (Dawn, Horizon, Sense, Refresh, Studio, Craft, Origin, and the rest) and the vast majority of third party themes. No setup needed beyond turning the embed on.")}
                </s-paragraph>
                <Banner tone="info" title={t("On a heavily customized theme?")}>
                  <s-paragraph>
                    {t("If the Rental badge does not appear or the price is still showing on rental cards, paste this snippet into your theme's main CSS file. Go to")} <s-text type="strong">{t("Online Store, then Themes, then Edit code, then assets/base.css")}</s-text> {t("(or whatever stylesheet your theme uses) and replace")} <code>.your-card-class</code> {t("with the wrapper class your theme actually uses.")}
                  </s-paragraph>
                </Banner>
                <s-box background="subdued" borderRadius="base" padding="base" border="base">
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
                </s-box>
                <s-paragraph color="subdued">
                  {t("Not sure what your class names are? Right click any product card on your storefront and choose")} <s-text type="strong">{t("Inspect")}</s-text>{t(". The wrapping element's")} <code>class</code> {t("attribute is what goes in place of")} <code>.your-card-class</code>{t(". The visible price element's class goes in place of")} <code>.your-price-class</code>.
                </s-paragraph>
                <Banner
                  tone="success"
                  title={t("Don't want to touch code?")}
                  action={{
                    content: t("Get a custom snippet"),
                    onAction: () =>
                      openMailto(
                        t("Custom theme CSS help"),
                        t("Hi Miko team,\n\nMy store URL: \nMy theme: \n\nThe Rental badge / price hide is not working on my collection pages. Could you send me a CSS snippet that works for my theme?\n\nThanks!"),
                      ),
                  }}
                >
                  <s-paragraph>
                    {t("Send us your store URL and we will send back a ready to paste snippet tailored to your theme. Usually within one business day.")}
                  </s-paragraph>
                </Banner>
              </s-stack>
            </s-section>

            {/* Late fees */}
            <s-section>
              <s-stack direction="block" gap="base">
                <SectionHeader icon="clock" title={t("How late fees work")} />
                <s-paragraph>
                  {t("Set the")} <s-text type="strong">{t("Late fee per day")}</s-text> {t("and a")} <s-text type="strong">{t("Grace period")}</s-text> {t("in Settings. After a rental's return date passes, Miko automatically marks it as Overdue and sends the customer an overdue notice showing your late fee rate.")}
                </s-paragraph>
                <s-paragraph>
                  {t("When the item is back, open the booking and click")} <s-text type="strong">{t("Record late fee")}</s-text>{t(". We calculate it as (days overdue minus your grace period) times your daily rate and save it on the booking. We do not auto charge the card. To collect, create a draft order in Shopify with a custom line item and send the invoice. This keeps you in control of any goodwill exceptions you want to make.")}
                </s-paragraph>
              </s-stack>
            </s-section>
          </s-stack>

          {/* Sidebar */}
          <s-stack direction="block" gap="base">
            <s-section>
              <s-stack direction="block" gap="small">
                <SectionHeader icon="external" title={t("Quick links")} />
                <s-stack direction="block" gap="small-200">
                  <s-button href={themeEditorBlockUrl} target="_blank" inlineSize="fill" icon="calendar">
                    {t("Add calendar block")}
                  </s-button>
                  <s-button href={themeEditorEmbedUrl} target="_blank" inlineSize="fill" icon="code">
                    {t("Enable display rules")}
                  </s-button>
                  <s-button href={appEmbedsUrl} target="_blank" inlineSize="fill" variant="tertiary">
                    {t("All app embeds")}
                  </s-button>
                </s-stack>
              </s-stack>
            </s-section>

            <s-section>
              <s-stack direction="block" gap="small">
                <SectionHeader icon="chat" title={t("Talk to a human")} />
                <s-paragraph color="subdued">
                  {t("Stuck on something? Email our team and we will get back to you within one business day.")}
                </s-paragraph>
                <s-button onClick={() => openMailto(t("Miko support request"))} inlineSize="fill" variant="primary" icon="email">
                  {t("Email our team")}
                </s-button>
              </s-stack>
            </s-section>

            <s-section>
              <s-stack direction="block" gap="small">
                <SectionHeader icon="magic" title={t("Beyond rentals?")} />
                <s-paragraph color="subdued">
                  {t("Want to use Miko for event bookings, equipment hire, studio time, or any other date based booking? Tell us your use case and we will see if we can help.")}
                </s-paragraph>
                <s-button
                  onClick={() =>
                    openMailto(
                      t("Use case beyond rentals"),
                      t("Hi Miko team,\n\nI run a store on Shopify and I'm interested in using Miko for:\n\n(Describe your use case here, e.g. event bookings, equipment hire, studio time, appointments...)\n\nIs this something you can help with?\n\nThanks!"),
                    )
                  }
                  inlineSize="fill"
                  icon="email"
                >
                  {t("Share your use case")}
                </s-button>
              </s-stack>
            </s-section>

            <s-section>
              <s-stack direction="block" gap="small">
                <SectionHeader icon="lock" title={t("Privacy and your data")} />
                <s-paragraph color="subdued">
                  {t("Miko only stores the data you create through the app: rental products, bookings, settings, and email templates. Customer data is limited to the name, email, and phone attached to orders.")}
                </s-paragraph>
                <s-paragraph color="subdued">
                  {t("When you uninstall, your sessions are deleted right away and a 48 hour retention window lets you reinstall without losing anything. After that, your shop's data is fully deleted.")}
                </s-paragraph>
              </s-stack>
            </s-section>
          </s-stack>
        </Grid>
      </s-stack>
    </s-page>
  );
}
