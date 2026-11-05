import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configureLocalEnvironment } from "./local-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
configureLocalEnvironment(root);
const [command, ...extra] = process.argv.slice(2);
let port = "5173";
let help = [];
if (extra.length) {
  if (extra.length === 1 && extra[0] === "--help") help = ["--help"];
  else if (["dev", "start"].includes(command)
    && extra.length === 2 && extra[0] === "--port"
    && /^\d+$/.test(extra[1]) && Number(extra[1]) >= 1024 && Number(extra[1]) <= 65535) port = extra[1];
  else throw new Error("Only --help and an explicit local --port (1024–65535) are supported. Remote, tunnel, host and config overrides are disabled.");
}
const invocations = {
  dev: ["vite/bin/vite.js", "dev", "--host", "127.0.0.1", "--port", port, "--strictPort"],
  build: ["vite/bin/vite.js", "build"],
  start: ["wrangler/bin/wrangler.js", "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state", "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0"],
  "db:init": ["wrangler/bin/wrangler.js", "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", ".wrangler/state"],
};
if (!Object.hasOwn(invocations, command)) throw new Error("Expected dev, build, start or db:init.");
const [binary, ...args] = invocations[command];
const child = spawn(process.execPath, [fileURLToPath(new URL(`../node_modules/${binary}`, import.meta.url)), ...args, ...help], {cwd: root, stdio: "inherit", env: process.env});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
