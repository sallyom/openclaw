import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { applyGatewayEndpointToSshConfig, buildRemoteCommand, runOpenShellCli } from "./cli.js";
import {
  resolveOpenShellWorkerProfileConfig,
  type ResolvedOpenShellLocalInferenceConfig,
  type ResolvedOpenShellPluginConfig,
  type ResolvedOpenShellWorkerProfileConfig,
} from "./config.js";

const PROVIDER_ID = "openshell";
const PROVISION_TIMEOUT_MS = 300_000;
const PROVISION_POLL_INTERVAL_MS = 1_000;
// OpenShell serializes the authoritative gRPC code and message on stderr. Keep
// this exact so gateway, provider, and policy lookup failures remain fatal.
const SANDBOX_NOT_FOUND_PATTERN =
  /(?:\bstatus:\s*NotFound,\s*message:\s*"sandbox not found"|\bsandbox not found\b)/iu;

type CommandResult = { code: number; stdout: string; stderr: string };
type OpenShellSandboxPhase =
  | "Unspecified"
  | "Provisioning"
  | "Ready"
  | "Error"
  | "Deleting"
  | "Unknown";
type OpenShellWorkerSshEndpoint = Extract<WorkerLease["ssh"], { kind: "proxy-command" }>;
type WorkerLocalInferenceRoute = NonNullable<WorkerLease["inference"]>;
type ProvisionInspection = { status: "absent" } | { status: "ready" } | { status: "failed" };
type OpenShellInferenceRoute = { provider: string; model: string; version: number };
type RunCli = (params: {
  config: ResolvedOpenShellPluginConfig;
  args: string[];
  timeoutMs?: number;
}) => Promise<CommandResult>;

function sandboxName(operationId: string): string {
  // OpenShell workspace routing reserves names to 19 characters.
  return `ocw-${createHash("sha256").update(operationId).digest("hex").slice(0, 15)}`;
}

function profileConfig(profile: WorkerProfile): ResolvedOpenShellWorkerProfileConfig {
  try {
    return resolveOpenShellWorkerProfileConfig(profile);
  } catch (error) {
    throw new WorkerProviderError(
      error instanceof Error ? error.message : "Invalid OpenShell profile",
    );
  }
}

function commandError(action: string, result: CommandResult): Error {
  const detail = redactSensitiveText(result.stderr || result.stdout)
    .replace(/\s+/gu, " ")
    .trim();
  return new Error(
    detail
      ? `OpenShell ${action} failed: ${detail.slice(0, 512)}`
      : `OpenShell ${action} failed with exit code ${result.code}`,
  );
}

function isSandboxNotFound(result: CommandResult): boolean {
  return result.code !== 0 && SANDBOX_NOT_FOUND_PATTERN.test(result.stderr);
}

export function parseOpenShellSandboxPhase(output: string): OpenShellSandboxPhase {
  const match = /^\s*Phase:\s*(Unspecified|Provisioning|Ready|Error|Deleting|Unknown)\s*$/mu.exec(
    stripVTControlCharacters(output),
  );
  if (!match?.[1]) {
    throw new Error("OpenShell sandbox get returned an invalid phase");
  }
  return match[1] as OpenShellSandboxPhase;
}

export function parseOpenShellInferenceRoute(output: string): OpenShellInferenceRoute {
  const normalized = stripVTControlCharacters(output);
  const inferenceHeader = /^Inference:\s*$/mu.exec(normalized);
  const sectionStart = inferenceHeader ? inferenceHeader.index + inferenceHeader[0].length : -1;
  const section =
    sectionStart >= 0 ? normalized.slice(sectionStart).split(/^System inference:\s*$/mu, 1)[0] : "";
  if (!section || /^\s*Not configured\s*$/mu.test(section)) {
    throw new Error("OpenShell inference.local is not configured");
  }
  const provider = /^\s*Provider:\s*(.+?)\s*$/mu.exec(section)?.[1]?.trim();
  const model = /^\s*Model:\s*(.+?)\s*$/mu.exec(section)?.[1]?.trim();
  const versionText = /^\s*Version:\s*(\d+)\s*$/mu.exec(section)?.[1];
  const version = versionText === undefined ? Number.NaN : Number(versionText);
  if (!provider || !model || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("OpenShell inference get returned an invalid inference route");
  }
  return { provider, model, version };
}

function localInferenceBaseUrl(api: ResolvedOpenShellLocalInferenceConfig["api"]): string {
  return api === "anthropic-messages" ? "https://inference.local" : "https://inference.local/v1";
}

export function parseOpenShellWorkerSshConfig(configText: string): OpenShellWorkerSshEndpoint {
  let host: string | undefined;
  let user: string | undefined;
  let proxyCommand: string | undefined;
  for (const line of configText.split(/\r?\n/u)) {
    const match = /^\s*(Host|User|ProxyCommand)\s+(.+?)\s*$/iu.exec(line);
    if (!match) {
      continue;
    }
    const value = match[2];
    if (!value) {
      continue;
    }
    switch (match[1]?.toLowerCase()) {
      case "host":
        host = value;
        break;
      case "user":
        user = value;
        break;
      case "proxycommand":
        proxyCommand = value;
        break;
    }
  }
  if (
    !host ||
    !user ||
    !proxyCommand ||
    proxyCommand.includes("\0") ||
    proxyCommand.includes("\r") ||
    proxyCommand.includes("\n")
  ) {
    throw new Error("OpenShell sandbox ssh-config returned an invalid proxy endpoint");
  }
  return { kind: "proxy-command", host, port: 22, user, proxyCommand };
}

export function applyOpenShellDelegationTokenFileToSshConfig(params: {
  configText: string;
  tokenFile: string;
}): string {
  const tokenFile = params.tokenFile.trim();
  if (!tokenFile) {
    throw new WorkerProviderError(
      "OpenShell delegated workers require OPENSHELL_DELEGATION_TOKEN_FILE",
    );
  }
  return params.configText.replace(/^([ \t]*ProxyCommand\s+)(.*)$/m, (line, prefix, command) => {
    if (!command.includes("ssh-proxy")) {
      return line;
    }
    // Persist only the mounted file path. The SSH child reads a fresh token at
    // connection time, so the durable worker lease never contains the JWT.
    return `${prefix}OPENSHELL_SANDBOX_TOKEN=$(cat -- ${buildRemoteCommand([tokenFile])}) ${command}`;
  });
}

export function createOpenShellWorkerProvider(
  dependencies: {
    now?: () => number;
    runCli?: RunCli;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): WorkerProvider {
  const runCli: RunCli =
    dependencies.runCli ??
    (async ({ config, args, timeoutMs }) =>
      await runOpenShellCli({
        context: { config, sandboxName: "worker-provider", timeoutMs },
        args,
        timeoutMs,
      }));
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const get = async (config: ResolvedOpenShellPluginConfig, name: string) =>
    await runCli({ config, args: ["sandbox", "get", name] });

  const inspectProvision = async (
    config: ResolvedOpenShellWorkerProfileConfig,
    name: string,
    deadlineMs: number,
  ): Promise<ProvisionInspection> => {
    while (true) {
      const result = await get(config, name);
      if (isSandboxNotFound(result)) {
        return { status: "absent" };
      }
      if (result.code !== 0) {
        throw commandError("sandbox get", result);
      }
      const phase = parseOpenShellSandboxPhase(result.stdout);
      if (phase === "Ready") {
        return { status: "ready" };
      }
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        return { status: "failed" };
      }
      await sleep(Math.min(PROVISION_POLL_INTERVAL_MS, remainingMs));
    }
  };

  const endpoint = async (
    config: ResolvedOpenShellPluginConfig,
    name: string,
    delegationTokenFile?: string,
  ): Promise<OpenShellWorkerSshEndpoint> => {
    const result = await runCli({ config, args: ["sandbox", "ssh-config", name] });
    if (result.code !== 0) {
      throw commandError("sandbox ssh-config", result);
    }
    return parseOpenShellWorkerSshConfig(
      delegationTokenFile
        ? applyOpenShellDelegationTokenFileToSshConfig({
            configText: applyGatewayEndpointToSshConfig({
              configText: result.stdout,
              gatewayEndpoint: config.gatewayEndpoint,
            }),
            tokenFile: delegationTokenFile,
          })
        : applyGatewayEndpointToSshConfig({
            configText: result.stdout,
            gatewayEndpoint: config.gatewayEndpoint,
          }),
    );
  };

  const inferenceRoute = async (
    config: ResolvedOpenShellWorkerProfileConfig,
  ): Promise<WorkerLocalInferenceRoute | undefined> => {
    const expected = config.inference;
    if (!expected) {
      return undefined;
    }
    const result = await runCli({ config, args: ["inference", "get"] });
    if (result.code !== 0) {
      throw commandError("inference get", result);
    }
    const actual = parseOpenShellInferenceRoute(result.stdout);
    if (actual.provider !== expected.provider || actual.model !== expected.model) {
      throw new WorkerProviderError(
        `OpenShell inference.local route mismatch: expected ${expected.provider}/${expected.model}, found ${actual.provider}/${actual.model}`,
      );
    }
    return {
      mode: "local",
      api: expected.api,
      baseUrl: localInferenceBaseUrl(expected.api),
      provider: expected.openclawProvider,
      model: expected.model,
      routeVersion: actual.version,
    };
  };

  return {
    id: PROVIDER_ID,
    async provision(profile, operationId): Promise<WorkerLease> {
      const config = profileConfig(profile);
      const name = sandboxName(operationId);
      const parentSandboxId = process.env.OPENSHELL_SANDBOX_ID?.trim();
      const delegationTokenFile = parentSandboxId
        ? process.env.OPENSHELL_DELEGATION_TOKEN_FILE?.trim()
        : undefined;
      if (parentSandboxId && !delegationTokenFile) {
        throw new WorkerProviderError(
          "OpenShell delegated workers require OPENSHELL_DELEGATION_TOKEN_FILE",
        );
      }
      if (parentSandboxId && !config.gatewayEndpoint) {
        throw new WorkerProviderError(
          "OpenShell delegated workers require settings.gatewayEndpoint",
        );
      }
      const initialSsh = parentSandboxId ? undefined : await endpoint(config, name);
      const deadlineMs = now() + Math.max(config.timeoutMs, PROVISION_TIMEOUT_MS);
      const initial = await inspectProvision(config, name, deadlineMs);
      if (initial.status === "ready") {
        const ssh = initialSsh ?? (await endpoint(config, name, delegationTokenFile));
        let inference: WorkerLocalInferenceRoute | undefined;
        try {
          inference = await inferenceRoute(config);
        } catch (error) {
          // A lost create response leaves only this deterministic name to recover.
          // Do not terminalize its durable operation with an untracked sandbox.
          const cleanup = await runCli({ config, args: ["sandbox", "delete", name] });
          if (cleanup.code !== 0) {
            throw commandError("sandbox delete failed lease", cleanup);
          }
          throw error;
        }
        return { leaseId: name, ssh, ...(inference ? { inference } : {}) };
      }
      if (initial.status === "failed") {
        const cleanup = await runCli({ config, args: ["sandbox", "delete", name] });
        if (cleanup.code !== 0) {
          throw commandError("sandbox delete failed lease", cleanup);
        }
        throw new Error("OpenShell operation sandbox did not become ready");
      }

      const inference = await inferenceRoute(config);
      let createFailure: unknown;
      try {
        const createArgs = parentSandboxId
          ? [
              "sandbox",
              "create",
              "--name",
              name,
              "--parent-sandbox-id",
              parentSandboxId,
              "--keep",
              "--",
              "true",
            ]
          : [
              "sandbox",
              "create",
              "--name",
              name,
              "--from",
              config.from,
              ...(config.policy ? ["--policy", config.policy] : []),
              ...(config.gpu ? ["--gpu"] : []),
              ...(config.autoProviders ? ["--auto-providers"] : ["--no-auto-providers"]),
              ...config.providers.flatMap((provider) => ["--provider", provider]),
              "--keep",
              "--",
              "true",
            ];
        const result = await runCli({
          config,
          args: createArgs,
          timeoutMs: Math.max(config.timeoutMs, PROVISION_TIMEOUT_MS),
        });
        if (result.code !== 0) {
          createFailure = commandError("sandbox create", result);
        }
      } catch (error) {
        createFailure = error;
      }

      // The create response may be lost after remote allocation. Always inspect
      // the deterministic name before deciding whether the operation failed.
      const created = await inspectProvision(config, name, deadlineMs);
      if (created.status === "ready") {
        const ssh = initialSsh ?? (await endpoint(config, name, delegationTokenFile));
        return { leaseId: name, ssh, ...(inference ? { inference } : {}) };
      }
      if (created.status === "failed") {
        const cleanup = await runCli({ config, args: ["sandbox", "delete", name] });
        if (cleanup.code !== 0) {
          throw commandError("sandbox delete failed lease", cleanup);
        }
        throw createFailure ?? new Error("OpenShell sandbox create entered Error phase");
      }
      throw createFailure ?? new Error("OpenShell sandbox create did not allocate a sandbox");
    },
    async inspect({ leaseId, profile }) {
      const config = profileConfig(profile);
      const result = await get(config, leaseId);
      if (result.code === 0) {
        const phase = parseOpenShellSandboxPhase(result.stdout);
        if (phase === "Ready") {
          return { status: "active" };
        }
        if (phase === "Error") {
          return { status: "failed" };
        }
        return { status: "pending" };
      }
      if (isSandboxNotFound(result)) {
        return { status: "unknown" };
      }
      throw commandError("sandbox get", result);
    },
    async destroy({ leaseId, profile }) {
      const config = profileConfig(profile);
      const result = await runCli({ config, args: ["sandbox", "delete", leaseId] });
      if (result.code === 0 || isSandboxNotFound(result)) {
        return;
      }
      throw commandError("sandbox delete", result);
    },
  };
}
