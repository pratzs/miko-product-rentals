// Minimal vite-node config for one-off scripts: only the "~" -> app/ alias the
// app code uses (tsconfig paths). Deliberately NOT vite.config.ts, which loads
// the Remix plugin. Usage: npx vite-node -c scripts/vite-node.config.mjs scripts/<x>.ts
import { fileURLToPath } from "node:url";
export default {
  resolve: { alias: { "~": fileURLToPath(new URL("../app", import.meta.url)) } },
};
