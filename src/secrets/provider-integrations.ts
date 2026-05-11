import path from "node:path";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestSecretProviderIntegration } from "../plugins/manifest.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isValidSecretProviderAlias } from "./ref-contract.js";

export type SecretProviderIntegrationPreset = {
  id: string;
  pluginId: string;
  providerAlias: string;
  displayName: string;
  description?: string;
  providerConfig: SecretProviderConfig;
};

const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isPortableAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

function resolveCommand(command: string, pluginRoot: string): string {
  if (command === "${node}") {
    return process.execPath;
  }
  return path.isAbsolute(command) ? command : path.resolve(pluginRoot, command);
}

function resolveArg(arg: string, pluginRoot: string): string {
  return arg.startsWith("./") || arg.startsWith("../") ? path.resolve(pluginRoot, arg) : arg;
}

function resolveTrustedDir(trustedDir: string, pluginRoot: string): string {
  return isPortableAbsolutePath(trustedDir) ? trustedDir : path.resolve(pluginRoot, trustedDir);
}

function materializeExecProviderConfig(
  integration: PluginManifestSecretProviderIntegration,
  pluginRoot: string,
): SecretProviderConfig {
  return {
    source: "exec",
    command: resolveCommand(integration.command, pluginRoot),
    ...(integration.args
      ? { args: integration.args.map((arg) => resolveArg(arg, pluginRoot)) }
      : {}),
    ...(integration.timeoutMs !== undefined ? { timeoutMs: integration.timeoutMs } : {}),
    ...(integration.noOutputTimeoutMs !== undefined
      ? { noOutputTimeoutMs: integration.noOutputTimeoutMs }
      : {}),
    ...(integration.maxOutputBytes !== undefined
      ? { maxOutputBytes: integration.maxOutputBytes }
      : {}),
    ...(integration.jsonOnly === false ? { jsonOnly: false } : {}),
    ...(integration.env ? { env: integration.env } : {}),
    ...(integration.passEnv ? { passEnv: integration.passEnv } : {}),
    ...(integration.trustedDirs
      ? {
          trustedDirs: integration.trustedDirs.map((entry) => resolveTrustedDir(entry, pluginRoot)),
        }
      : {}),
    ...(integration.allowInsecurePath ? { allowInsecurePath: true } : {}),
    ...(integration.allowSymlinkCommand ? { allowSymlinkCommand: true } : {}),
  };
}

function integrationDisplayName(
  record: PluginManifestRecord,
  integrationId: string,
  integration: PluginManifestSecretProviderIntegration,
): string {
  return (
    normalizeOptionalString(integration.displayName) ??
    normalizeOptionalString(record.name) ??
    integrationId
  );
}

export function listSecretProviderIntegrationPresets(params: {
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">;
}): SecretProviderIntegrationPreset[] {
  const presets: SecretProviderIntegrationPreset[] = [];
  for (const record of params.manifestRegistry.plugins) {
    for (const [integrationId, integration] of Object.entries(
      record.secretProviderIntegrations ?? {},
    )) {
      const providerAlias = normalizeOptionalString(integration.providerAlias) ?? integrationId;
      if (!isValidSecretProviderAlias(providerAlias)) {
        continue;
      }
      presets.push({
        id: integrationId,
        pluginId: record.id,
        providerAlias,
        displayName: integrationDisplayName(record, integrationId, integration),
        ...(integration.description ? { description: integration.description } : {}),
        providerConfig: materializeExecProviderConfig(integration, record.rootDir),
      });
    }
  }
  return presets.toSorted((left, right) =>
    `${left.displayName}:${left.providerAlias}`.localeCompare(
      `${right.displayName}:${right.providerAlias}`,
    ),
  );
}
