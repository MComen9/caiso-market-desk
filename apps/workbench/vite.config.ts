import vinext from "vinext";
import { defineConfig } from "vite";
import { configureLocalEnvironment } from "./scripts/local-env.mjs";

// Public sharing is built separately from apps/viewer, without writable APIs.
export default defineConfig(async () => {
  configureLocalEnvironment(process.cwd());
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  return {
    server: {
      host: "127.0.0.1", port: 5173, strictPort: true,
      ...(process.env.CODEX_SANDBOX === "seatbelt"
        ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    plugins: [vinext(), cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      inspectorPort: false,
    })],
  };
});
