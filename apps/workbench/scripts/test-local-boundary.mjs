import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLocalWorkbenchUrl, localWorkbenchGuard } from "../worker/local-access.mjs";

for (const value of ["http://localhost:5173/", "http://127.0.0.1:5173/api/strategy", "http://[::1]:5173/"]) {
  assert.equal(isLocalWorkbenchUrl(value), true, value);
  assert.equal(localWorkbenchGuard(new Request(value)), null);
}
for (const value of ["https://example.com/", "https://localhost.example/", "https://127.0.0.1.example/", "http://0.0.0.0:5173/", "file:///tmp/a", "invalid", "http://user:pass@localhost/"]) {
  assert.equal(isLocalWorkbenchUrl(value), false, value);
}
const denied = localWorkbenchGuard(new Request("https://shared.example/api/strategy", {
  method: "POST", headers: {"host": "localhost", "x-forwarded-host": "localhost", "origin": "https://shared.example"}, body: "{}",
}));
assert.equal(denied.status, 403);
assert.equal((await denied.json()).error.code, "LOCAL_DEVELOPMENT_ONLY");
for (const flags of [["--remote"], ["-r"], ["--host", "0.0.0.0"], ["--tunnel"], ["--config", "other.json"], ["--local=false"]]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run-local.mjs", import.meta.url)), "start", ...flags], {encoding: "utf8"});
  assert.equal(result.status, 1, flags.join(" "));
  assert.match(result.stderr, /overrides are disabled/, flags.join(" "));
}
console.log("PASS: loopback publication guard rejects remote URLs and ignores forwarding headers; it is not user authentication.");
