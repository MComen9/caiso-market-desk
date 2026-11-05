import handler from "vinext/server/fetch-handler";
import { localWorkbenchGuard } from "./local-access.mjs";

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const denied = localWorkbenchGuard(request);
    if (denied) return denied;
    return handler.fetch(request, env, ctx);
  },
};
