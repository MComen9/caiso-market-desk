import { cp, mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../data/published/", import.meta.url));
const destination = fileURLToPath(new URL("../public/data/", import.meta.url));
try {
  await stat(new URL("../../../data/published/forecast-lab/v4/report.json", import.meta.url));
} catch {
  throw new Error("Missing repository data/published snapshot. Restore the versioned data before starting the workbench.");
}
await mkdir(fileURLToPath(new URL("../public/", import.meta.url)), {recursive: true});
await rm(destination, {recursive: true, force: true});
await cp(source, destination, {recursive: true});
console.log("Synchronized repository data/published to the ignored local public/data directory.");
