/**
 * In-process scheduler that keeps the `$app:miko_rentals.config` metafields
 * (the rates the Cart Transform Function prices rentals from) in step with the
 * database for EVERY installed shop, with nobody opening the app.
 *
 * It matters because the function charges the variant's normal price for a
 * rental line whose config metafield is missing. So:
 *   - first run, one minute after boot: the backfill for shops that set their
 *     rentals up before the function read metafields. This is what makes
 *     "deploy the server first, then the function" safe.
 *   - every 6 hours after that: heals any single write that failed.
 *
 * Singleton, non-overlapping, unref'd, opt-out via DISABLE_IN_PROCESS_CRON
 * (same contract as the lifecycle-email scheduler). The same pass can be run
 * on demand, with a report, by POSTing to /api/cron/rental-config.
 */
import { syncAllShopsRentalConfig } from "./utils/rental-config-metafields.server";

type GetAdmin = Parameters<typeof syncAllShopsRentalConfig>[0];

const FIRST_RUN_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __mikoRentalConfigScheduler: { running: boolean } | undefined;
}

async function tick(getAdmin: GetAdmin) {
  const state = globalThis.__mikoRentalConfigScheduler;
  if (!state || state.running) return;
  state.running = true;
  try {
    const report = await syncAllShopsRentalConfig(getAdmin);
    const failed = report.results.filter((r) => r.errors.length > 0);
    console.log(
      `[rental-config/tick] ${report.shopsFullySynced}/${report.shops} shops fully synced` +
        (failed.length ? `; NOT synced: ${failed.map((r) => r.shop).join(", ")}` : ""),
    );
  } catch (err) {
    console.error("[rental-config/tick]", err);
  } finally {
    state.running = false;
  }
}

export function startRentalConfigScheduler(getAdmin: GetAdmin) {
  if (process.env.DISABLE_IN_PROCESS_CRON === "true") return;
  if (globalThis.__mikoRentalConfigScheduler) return;
  globalThis.__mikoRentalConfigScheduler = { running: false };
  const first = setTimeout(() => void tick(getAdmin), FIRST_RUN_DELAY_MS);
  if (typeof first.unref === "function") first.unref();
  const timer = setInterval(() => void tick(getAdmin), INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
