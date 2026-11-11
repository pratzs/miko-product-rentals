import { useEffect, useState } from "react";

/**
 * "Ask Sidekick" launcher (Sidekick Launch API, `shopify.sidekick.launch`).
 *
 * Rules this file exists to enforce (Shopify's Launch API docs and the App
 * Store content policy):
 *  - Hidden unless `shopify.sidekick.isEnabled()` resolves true. Nothing
 *    renders and nothing can throw where the API is missing (older mobile
 *    apps, stores without Sidekick, non-embedded load, server render).
 *  - `launch` is only ever called from a merchant's click, never on load or
 *    on a timer.
 *  - Prompts are plain questions about the merchant's own data that one of
 *    this app's read-only Sidekick tools answers: no URLs, no request to change
 *    anything, nothing that steers Sidekick.
 *  - A failed launch is never retried automatically: an error that is not a
 *    "sidekick.launch:" validation error may already have been sent.
 */

type SidekickApi = {
  isEnabled?: () => Promise<boolean>;
  launch?: (req: { message: string }) => Promise<{ id: string }>;
};

function getSidekick(): SidekickApi | undefined {
  if (typeof window === "undefined") return undefined;
  // @shopify/app-bridge-types does not include shopify.sidekick yet.
  return (window as unknown as { shopify?: { sidekick?: SidekickApi } }).shopify?.sidekick;
}

export function useSidekickAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    const sk = getSidekick();
    if (!sk || typeof sk.isEnabled !== "function" || typeof sk.launch !== "function") return;
    Promise.resolve()
      .then(() => sk.isEnabled!())
      .then((on) => {
        if (alive) setAvailable(on === true);
      })
      .catch(() => {
        if (alive) setAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return available;
}

export async function askSidekick(
  message: string,
  errors: { rejected: string; failed: string },
): Promise<void> {
  const sk = getSidekick();
  if (!sk?.launch) return;
  try {
    await sk.launch({ message });
  } catch (err) {
    const text = err instanceof Error ? err.message : "";
    const toast = (
      window as unknown as {
        shopify?: { toast?: { show: (m: string, o?: { isError?: boolean }) => void } };
      }
    ).shopify?.toast;
    toast?.show(text.startsWith("sidekick.launch:") ? errors.rejected : errors.failed, {
      isError: true,
    });
  }
}

/**
 * The button itself. Renders nothing until Sidekick says it is available.
 * `slot` lets it sit in `s-page`'s secondary-actions slot.
 */
export function AskSidekickButton({
  label,
  prompt,
  errors,
  slot,
}: {
  label: string;
  prompt: string;
  errors: { rejected: string; failed: string };
  slot?: Lowercase<string>;
}) {
  const available = useSidekickAvailable();
  if (!available) return null;
  return (
    <s-button slot={slot} icon="magic" onClick={() => void askSidekick(prompt, errors)}>
      {label}
    </s-button>
  );
}
