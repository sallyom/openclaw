import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { listSecretProviderIntegrationPresets } from "./provider-integrations.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-provider-integrations-"));
  tempDirs.push(dir);
  return dir;
}

function createCandidate(rootDir: string, idHint: string): PluginCandidate {
  return {
    idHint,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "workspace",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret provider integration presets", () => {
  it("materializes plugin manifest exec providers without provider-specific core code", () => {
    const rootDir = makeTempDir();
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
    fs.mkdirSync(path.join(rootDir, "bin"));
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "acme-secrets",
        name: "Acme Secrets",
        secretProviderIntegrations: {
          acme: {
            providerAlias: "acme",
            displayName: "Acme Vault",
            description: "Acme exec resolver",
            source: "exec",
            command: "${node}",
            args: ["./bin/resolve.mjs", "--profile", "work"],
            timeoutMs: 3000,
            noOutputTimeoutMs: 3000,
            maxOutputBytes: 4096,
            passEnv: ["HOME"],
            env: {
              ACME_PROFILE: "work",
            },
            trustedDirs: ["./bin"],
            jsonOnly: false,
            allowSymlinkCommand: true,
          },
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );

    const registry = loadPluginManifestRegistry({
      candidates: [createCandidate(rootDir, "acme-secrets")],
    });

    expect(registry.diagnostics).toEqual([]);
    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "acme",
        pluginId: "acme-secrets",
        providerAlias: "acme",
        displayName: "Acme Vault",
        description: "Acme exec resolver",
        providerConfig: {
          source: "exec",
          command: process.execPath,
          args: [path.join(rootDir, "bin", "resolve.mjs"), "--profile", "work"],
          timeoutMs: 3000,
          noOutputTimeoutMs: 3000,
          maxOutputBytes: 4096,
          passEnv: ["HOME"],
          env: {
            ACME_PROFILE: "work",
          },
          trustedDirs: [path.join(rootDir, "bin")],
          jsonOnly: false,
          allowSymlinkCommand: true,
        },
      },
    ]);
  });

  it("normalizes manifest exec provider options to SecretRef provider schema limits", () => {
    const rootDir = makeTempDir();
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "bounded-secrets",
        secretProviderIntegrations: {
          bounded: {
            source: "exec",
            command: "${node}",
            args: ["ok", "x".repeat(1025)],
            timeoutMs: 120001,
            noOutputTimeoutMs: 1.5,
            maxOutputBytes: 20 * 1024 * 1024 + 1,
            passEnv: ["GOOD_ENV", "bad-env"],
          },
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );

    const registry = loadPluginManifestRegistry({
      candidates: [createCandidate(rootDir, "bounded-secrets")],
    });

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "bounded",
        pluginId: "bounded-secrets",
        providerAlias: "bounded",
        displayName: "bounded",
        providerConfig: {
          source: "exec",
          command: process.execPath,
          args: ["ok"],
          passEnv: ["GOOD_ENV"],
        },
      },
    ]);
  });

  it("skips presets whose provider alias cannot be used as a SecretRef provider", () => {
    const rootDir = makeTempDir();
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "bad-secrets",
        secretProviderIntegrations: {
          bad: {
            providerAlias: "../bad",
            source: "exec",
            command: "${node}",
          },
        },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );

    const registry = loadPluginManifestRegistry({
      candidates: [createCandidate(rootDir, "bad-secrets")],
    });

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });
});
