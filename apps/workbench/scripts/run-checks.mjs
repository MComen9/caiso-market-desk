import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../.sites-runtime/", import.meta.url), {recursive: true});
for (const file of [
  "test-local-boundary.mjs", "test-oasis.mjs", "test-analytics.mjs", "test-outlook.mjs",
  "test-fundamentals.mjs", "test-gridstatus.mjs", "test-strategy-engine.mjs",
  "test-strategy-adversarial.mjs", "test-strategy-future-zero.mjs", "test-strategy-api.mjs",
]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {cwd: root, stdio: "inherit"});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
