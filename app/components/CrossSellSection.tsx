import { Card, BlockStack, InlineStack, Text, Button, Box } from "@shopify/polaris";
import { ExternalIcon } from "@shopify/polaris-icons";

/**
 * Shared "more from Miko" cross-sell section. Copy this file as-is into
 * any other Miko app's app/components/ folder and drop <CrossSellSection
 * currentApp="..." /> at the bottom of that app's dashboard route.
 *
 * Only list apps that are actually live on the App Store — never link to
 * an app that isn't published yet (Miko Click and Collect is excluded
 * until it has a real apps.shopify.com listing).
 */

type MikoApp = {
  key: string;
  name: string;
  pitch: string;
  color: string;
  icon: string;
  url: string;
};

const MIKO_APPS: MikoApp[] = [
  {
    key: "loyalty",
    name: "Miko Loyalty and Rewards",
    pitch: "Turn one-time buyers into loyal regulars with points and VIP tiers.",
    color: "#F5A62D",
    icon: "/cross-sell/miko-loyalty-icon.png",
    url: "https://apps.shopify.com/trip-loyalty-and-rewards",
  },
  {
    key: "ai",
    name: "Miko AI",
    pitch: "Score customers, predict churn, and automate campaigns.",
    color: "#3FA9F5",
    icon: "/cross-sell/miko-ai-icon.png",
    url: "https://apps.shopify.com/miko-ai",
  },
  {
    key: "b2b",
    name: "Miko B2B Wholesale House",
    pitch: "Manage wholesale discounts and open a dedicated B2B sales channel.",
    color: "#8B6BFF",
    icon: "/cross-sell/miko-b2b-icon.png",
    url: "https://apps.shopify.com/miko-b2b-wholesale-hub",
  },
  {
    key: "rentals",
    name: "Miko Product Rentals",
    pitch: "Turn products into rentals with dates and refundable deposits.",
    color: "#14C6AD",
    icon: "/cross-sell/miko-rentals-icon.png",
    url: "https://apps.shopify.com/miko-product-rentals",
  },
];

export function CrossSellSection({ currentApp }: { currentApp: MikoApp["key"] }) {
  const apps = MIKO_APPS.filter((a) => a.key !== currentApp);
  if (apps.length === 0) return null;

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="050">
          <Text variant="headingMd" as="h2">More from Miko</Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Built by the same team, made to work well together.
          </Text>
        </BlockStack>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "16px",
          }}
        >
          {apps.map((app) => (
            <Box
              key={app.key}
              padding="400"
              borderRadius="300"
              borderWidth="025"
              borderColor="border"
              background="bg-surface"
            >
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      overflow: "hidden",
                      flexShrink: 0,
                      boxShadow: `0 0 0 1px ${app.color}33`,
                    }}
                  >
                    <img
                      src={app.icon}
                      alt=""
                      width={44}
                      height={44}
                      style={{ display: "block", objectFit: "cover" }}
                    />
                  </div>
                  <Text as="h3" variant="headingSm">{app.name}</Text>
                </InlineStack>

                <Text as="p" variant="bodySm" tone="subdued">{app.pitch}</Text>

                <Box>
                  <Button
                    url={app.url}
                    target="_blank"
                    icon={ExternalIcon}
                    variant="secondary"
                    size="slim"
                    fullWidth
                  >
                    View on the App Store
                  </Button>
                </Box>
              </BlockStack>
            </Box>
          ))}
        </div>
      </BlockStack>
    </Card>
  );
}
