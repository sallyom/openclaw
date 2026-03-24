import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { listGatewayAgentsBasic } from "./agent-list.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { sendInvalidRequest, sendJson, sendMethodNotAllowed } from "./http-common.js";

type OpenAiModelsHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiModelObject = {
  id: string;
  object: "model";
  created: number;
  owned_by: "openclaw";
  permission: [];
  root: string;
  parent: null;
};

function toOpenAiModel(id: string, created: number): OpenAiModelObject {
  return {
    id,
    object: "model",
    created,
    owned_by: "openclaw",
    permission: [],
    root: id,
    parent: null,
  };
}

async function authorizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<boolean> {
  return await authorizeGatewayBearerRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
}

function loadGatewayAgentTargets(): OpenAiModelObject[] {
  const cfg = loadConfig();
  const { defaultId, agents } = listGatewayAgentsBasic(cfg);
  const created = Math.floor(Date.now() / 1000);
  const ids = new Set<string>(["openclaw"]);
  for (const agent of agents) {
    if (agent.id === defaultId) {
      continue;
    }
    ids.add(`openclaw:${agent.id}`);
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b)).map((id) => toOpenAiModel(id, created));
}

function resolveRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).pathname;
}

export async function handleOpenAiModelsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiModelsHttpOptions,
): Promise<boolean> {
  const requestPath = resolveRequestPath(req);
  if (requestPath !== "/v1/models" && !requestPath.startsWith("/v1/models/")) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  if (!(await authorizeRequest(req, res, opts))) {
    return true;
  }

  const models = loadGatewayAgentTargets();
  if (requestPath === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: models,
    });
    return true;
  }

  const encodedId = requestPath.slice("/v1/models/".length);
  if (!encodedId) {
    sendInvalidRequest(res, "Missing model id.");
    return true;
  }

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(encodedId);
  } catch {
    sendInvalidRequest(res, "Invalid model id encoding.");
    return true;
  }

  const normalizedId = decodedId.trim();
  if (normalizedId !== "openclaw" && !/^openclaw:[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalizedId)) {
    sendInvalidRequest(res, "Invalid model id.");
    return true;
  }

  const entry = models.find((item) => item.id === normalizedId);
  if (!entry) {
    sendJson(res, 404, {
      error: {
        message: `Model '${decodedId}' not found.`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  sendJson(res, 200, entry);
  return true;
}
