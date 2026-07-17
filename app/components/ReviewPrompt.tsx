import { useFetcher } from "@remix-run/react";
import { Banner } from "@shopify/polaris";

/** One-time App Store review ask, shown only after the shop's first-value
 * milestone (see review-prompt.server.ts). Any interaction, clicking through,
 * declining, or dismissing, hides it permanently via the dashboard action. */
export function ReviewPrompt({
  reviewUrl,
  title,
  message,
}: {
  reviewUrl: string;
  title: string;
  message: string;
}) {
  const fetcher = useFetcher();
  const dismiss = () =>
    fetcher.submit({ intent: "review_prompt_dismiss" }, { method: "post" });

  // Hide immediately on any interaction, without waiting for the loader to
  // revalidate, so the banner never flashes back.
  if (fetcher.state !== "idle" || fetcher.data) return null;

  return (
    <Banner
      title={title}
      tone="success"
      action={{
        content: "Leave a review",
        onAction: () => {
          window.open(reviewUrl, "_blank", "noopener,noreferrer");
          dismiss();
        },
      }}
      secondaryAction={{ content: "No thanks", onAction: dismiss }}
      onDismiss={dismiss}
    >
      <p>{message}</p>
    </Banner>
  );
}
