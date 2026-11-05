/**
 * Accidental-publication guard, not user authentication or proxy security.
 * Run on loopback. Shared writable deployment requires real identity controls.
 */
export function isLocalWorkbenchUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
}

export function localWorkbenchGuard(request) {
  if (isLocalWorkbenchUrl(request.url)) return null;
  return Response.json({ok: false, error: {
    code: "LOCAL_DEVELOPMENT_ONLY",
    message: "This writable research workbench is configured for loopback-only development. Use the separate read-only viewer for sharing.",
  }}, {status: 403, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}});
}
