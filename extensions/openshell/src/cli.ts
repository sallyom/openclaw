import { readFileSync } from "node:fs";
// Openshell plugin module implements cli behavior.
import {
  createSshSandboxSessionFromConfigText,
  runPluginCommandWithTimeout,
  shellEscape,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedOpenShellPluginConfig } from "./config.js";

export {
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
} from "openclaw/plugin-sdk/sandbox";

export type OpenShellExecContext = {
  config: ResolvedOpenShellPluginConfig;
  sandboxName: string;
  timeoutMs?: number;
};

function buildOpenShellBaseArgv(config: ResolvedOpenShellPluginConfig): string[] {
  const argv = [config.command];
  if (config.gateway) {
    argv.push("--gateway", config.gateway);
  }
  if (config.gatewayEndpoint) {
    argv.push("--gateway-endpoint", config.gatewayEndpoint);
  }
  if (config.workspace) {
    argv.push("--workspace", config.workspace);
  }
  return argv;
}

export function buildRemoteCommand(argv: string[]): string {
  return argv.map((entry) => shellEscape(entry)).join(" ");
}

export function applyGatewayEndpointToSshConfig(params: {
  configText: string;
  gatewayEndpoint?: string;
}): string {
  const endpoint = params.gatewayEndpoint?.trim();
  if (!endpoint) {
    return params.configText;
  }
  return params.configText.replace(/^(\s*ProxyCommand\s+)(.*)$/m, (line, prefix, command) => {
    if (!command.includes("ssh-proxy")) {
      return line;
    }
    if (/(^|\s)--server(\s|=)|(^|\s)--gateway-endpoint(\s|=)/.test(command)) {
      return line;
    }
    return `${prefix}${command} --server ${shellEscape(endpoint)}`;
  });
}

export async function runOpenShellCli(params: {
  context: OpenShellExecContext;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  // A parent sandbox workload receives only the restricted delegation token;
  // its full supervisor JWT is intentionally unavailable to plugin code.
  const tokenFile =
    env.OPENSHELL_DELEGATION_TOKEN_FILE?.trim() ?? env.OPENSHELL_SANDBOX_TOKEN_FILE?.trim();
  if (!env.OPENSHELL_SANDBOX_TOKEN && tokenFile) {
    try {
      env.OPENSHELL_SANDBOX_TOKEN = readFileSync(tokenFile, "utf8").trim();
    } catch {
      // Let the CLI report the missing sandbox credentials.
    }
  }
  return await runPluginCommandWithTimeout({
    argv: [...buildOpenShellBaseArgv(params.context.config), ...params.args],
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? params.context.timeoutMs ?? params.context.config.timeoutMs,
    env,
  });
}

export async function createOpenShellSshSession(params: {
  context: OpenShellExecContext;
}): Promise<SshSandboxSession> {
  const result = await runOpenShellCli({
    context: params.context,
    args: ["sandbox", "ssh-config", params.context.sandboxName],
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "openshell sandbox ssh-config failed");
  }
  return await createSshSandboxSessionFromConfigText({
    configText: applyGatewayEndpointToSshConfig({
      configText: result.stdout,
      gatewayEndpoint: params.context.config.gatewayEndpoint,
    }),
  });
}
