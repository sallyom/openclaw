import { describe, expect, it, vi } from "vitest";
import {
  createOpenShellWorkerProvider,
  applyOpenShellDelegationTokenFileToSshConfig,
  parseOpenShellInferenceRoute,
  parseOpenShellSandboxPhase,
  parseOpenShellWorkerSshConfig,
} from "./worker-provider.js";

const SSH_CONFIG = `Host openshell-demo
  User sandbox
  StrictHostKeyChecking no
  ProxyCommand /usr/local/bin/openshell ssh-proxy --gateway-name local --name demo
`;
const SANDBOX_NOT_FOUND =
  'status: NotFound, message: "sandbox not found", details: [], metadata: MetadataMap { headers: {} }';
const INFERENCE_ROUTE = `\u001B[1m\u001B[36mInference:\u001B[39m\u001B[0m

  \u001B[2mProvider:\u001B[0m team-anthropic
  \u001B[2mModel:\u001B[0m claude-sonnet-4-5
  \u001B[2mVersion:\u001B[0m 7
  \u001B[2mTimeout:\u001B[0m 60s

`;

describe("OpenShell worker provider", () => {
  it("parses the provider-authenticated SSH proxy endpoint", () => {
    expect(parseOpenShellWorkerSshConfig(SSH_CONFIG)).toEqual({
      kind: "proxy-command",
      host: "openshell-demo",
      port: 22,
      user: "sandbox",
      proxyCommand: "/usr/local/bin/openshell ssh-proxy --gateway-name local --name demo",
    });
  });

  it("resolves the delegated sandbox token from its mounted file at SSH connection time", () => {
    expect(
      applyOpenShellDelegationTokenFileToSshConfig({
        configText: SSH_CONFIG,
        tokenFile: "/run/openshell-delegation/token",
      }),
    ).toContain(
      "ProxyCommand OPENSHELL_SANDBOX_TOKEN=$(cat -- '/run/openshell-delegation/token') /usr/local/bin/openshell ssh-proxy",
    );
  });

  it("parses the ANSI-formatted phase field from sandbox get", () => {
    expect(
      parseOpenShellSandboxPhase(
        "\u001B[1m\u001B[36mSandbox:\u001B[39m\u001B[0m\n\n  \u001B[2mPhase:\u001B[0m Ready\n",
      ),
    ).toBe("Ready");
  });

  it("parses the ANSI-formatted workspace inference route", () => {
    expect(parseOpenShellInferenceRoute(INFERENCE_ROUTE)).toEqual({
      provider: "team-anthropic",
      model: "claude-sonnet-4-5",
      version: 7,
    });
  });

  it("validates and advertises a configured inference.local route", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Ready\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: INFERENCE_ROUTE, stderr: "" });
    const provider = createOpenShellWorkerProvider({ runCli });

    await expect(
      provider.provision(
        {
          inference: {
            mode: "local",
            provider: "team-anthropic",
            openclawProvider: "anthropic",
            model: "claude-sonnet-4-5",
            api: "anthropic-messages",
          },
        },
        "local-inference",
      ),
    ).resolves.toMatchObject({
      inference: {
        mode: "local",
        api: "anthropic-messages",
        baseUrl: "https://inference.local",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        routeVersion: 7,
      },
    });
    expect(runCli.mock.calls[2]?.[0].args).toEqual(["inference", "get"]);
  });

  it("rejects inference.local route drift before allocating a sandbox", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: SANDBOX_NOT_FOUND })
      .mockResolvedValueOnce({
        code: 0,
        stdout: INFERENCE_ROUTE.replace("claude-sonnet-4-5", "claude-opus-4-1"),
        stderr: "",
      });
    const provider = createOpenShellWorkerProvider({ runCli });

    await expect(
      provider.provision(
        {
          inference: {
            mode: "local",
            provider: "team-anthropic",
            openclawProvider: "anthropic",
            model: "claude-sonnet-4-5",
            api: "anthropic-messages",
          },
        },
        "route-drift",
      ),
    ).rejects.toThrow("inference.local route mismatch");
    expect(runCli.mock.calls.some(([call]) => call.args[1] === "create")).toBe(false);
  });

  it("deletes an untracked deterministic sandbox when local inference drift rejects adoption", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Ready\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: INFERENCE_ROUTE.replace("claude-sonnet-4-5", "claude-opus-4-1"),
        stderr: "",
      })
      .mockResolvedValueOnce({ code: 0, stdout: "deleted", stderr: "" });
    const provider = createOpenShellWorkerProvider({ runCli });

    await expect(
      provider.provision(
        {
          inference: {
            mode: "local",
            provider: "team-anthropic",
            openclawProvider: "anthropic",
            model: "claude-sonnet-4-5",
            api: "anthropic-messages",
          },
        },
        "lost-create-route-drift",
      ),
    ).rejects.toThrow("inference.local route mismatch");
    expect(runCli.mock.calls[3]?.[0].args).toEqual(["sandbox", "delete", expect.any(String)]);
  });

  it("creates one deterministic sandbox and returns its SSH proxy", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: SANDBOX_NOT_FOUND })
      .mockResolvedValueOnce({ code: 0, stdout: "created", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Ready\n", stderr: "" });
    const provider = createOpenShellWorkerProvider({ runCli });

    const lease = await provider.provision(
      { gateway: "local", providers: ["anthropic"], autoProviders: false },
      "provision:session-1",
    );

    expect(lease.leaseId).toMatch(/^ocw-[a-f0-9]{15}$/u);
    expect(runCli.mock.calls[2]?.[0].args).toEqual([
      "sandbox",
      "create",
      "--name",
      lease.leaseId,
      "--from",
      "openclaw",
      "--no-auto-providers",
      "--provider",
      "anthropic",
      "--keep",
      "--",
      "true",
    ]);
    expect(lease.ssh).toMatchObject({ kind: "proxy-command", host: "openshell-demo" });
  });

  it("uses the Gateway delegation token file for a delegated worker proxy", async () => {
    const parentSandboxId = process.env.OPENSHELL_SANDBOX_ID;
    const tokenFile = process.env.OPENSHELL_DELEGATION_TOKEN_FILE;
    process.env.OPENSHELL_SANDBOX_ID = "gateway-sandbox";
    process.env.OPENSHELL_DELEGATION_TOKEN_FILE = "/run/openshell-delegation/token";
    try {
      const runCli = vi
        .fn()
        .mockResolvedValueOnce({ code: 1, stdout: "", stderr: SANDBOX_NOT_FOUND })
        .mockResolvedValueOnce({ code: 0, stdout: "created", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Ready\n", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" });
      const provider = createOpenShellWorkerProvider({ runCli });

      const lease = await provider.provision(
        { gatewayEndpoint: "https://openshell-gateway.example.com" },
        "delegated-provision",
      );

      expect(runCli.mock.calls[1]?.[0].args).toContain("--parent-sandbox-id");
      expect(runCli.mock.calls[1]?.[0].args).toContain("gateway-sandbox");
      expect(runCli.mock.calls[1]?.[0].args).not.toContain("--from");
      expect(runCli.mock.calls[1]?.[0].args).not.toContain("--policy");
      expect(runCli.mock.calls[1]?.[0].args).not.toContain("--provider");
      expect(lease.ssh).toMatchObject({
        kind: "proxy-command",
        proxyCommand: expect.stringContaining(
          "OPENSHELL_SANDBOX_TOKEN=$(cat -- '/run/openshell-delegation/token')",
        ),
      });
      if (lease.ssh.kind !== "proxy-command") {
        throw new Error("expected proxy-command SSH transport");
      }
      expect(lease.ssh.proxyCommand).not.toContain("eyJ");
    } finally {
      if (parentSandboxId === undefined) {
        delete process.env.OPENSHELL_SANDBOX_ID;
      } else {
        process.env.OPENSHELL_SANDBOX_ID = parentSandboxId;
      }
      if (tokenFile === undefined) {
        delete process.env.OPENSHELL_DELEGATION_TOKEN_FILE;
      } else {
        process.env.OPENSHELL_DELEGATION_TOKEN_FILE = tokenFile;
      }
    }
  });

  it("requires an explicit Gateway endpoint for delegated workers", async () => {
    const parentSandboxId = process.env.OPENSHELL_SANDBOX_ID;
    const tokenFile = process.env.OPENSHELL_DELEGATION_TOKEN_FILE;
    process.env.OPENSHELL_SANDBOX_ID = "gateway-sandbox";
    process.env.OPENSHELL_DELEGATION_TOKEN_FILE = "/run/openshell-delegation/token";
    try {
      const runCli = vi.fn();
      const provider = createOpenShellWorkerProvider({ runCli });

      await expect(provider.provision({}, "missing-gateway-endpoint")).rejects.toThrow(
        "OpenShell delegated workers require settings.gatewayEndpoint",
      );
      expect(runCli).not.toHaveBeenCalled();
    } finally {
      if (parentSandboxId === undefined) {
        delete process.env.OPENSHELL_SANDBOX_ID;
      } else {
        process.env.OPENSHELL_SANDBOX_ID = parentSandboxId;
      }
      if (tokenFile === undefined) {
        delete process.env.OPENSHELL_DELEGATION_TOKEN_FILE;
      } else {
        process.env.OPENSHELL_DELEGATION_TOKEN_FILE = tokenFile;
      }
    }
  });

  it("adopts an existing operation sandbox without creating another", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Ready\n", stderr: "" });
    const provider = createOpenShellWorkerProvider({ runCli });

    await provider.provision({}, "same-operation");

    expect(runCli).toHaveBeenCalledTimes(2);
    expect(runCli.mock.calls.some(([call]) => call.args[1] === "create")).toBe(false);
  });

  it("resolves the endpoint before allocating a sandbox", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "gateway unavailable" });
    const provider = createOpenShellWorkerProvider({ runCli });

    await expect(provider.provision({}, "failed-endpoint")).rejects.toThrow(
      "OpenShell sandbox ssh-config failed",
    );
    expect(runCli).toHaveBeenCalledOnce();
    expect(runCli.mock.calls[0]?.[0].args.slice(0, 2)).toEqual(["sandbox", "ssh-config"]);
  });

  it.each(["Provisioning", "Deleting"])(
    "cleans up an operation sandbox stuck in phase %s",
    async (phase) => {
      const runCli = vi
        .fn()
        .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: `  Phase: ${phase}\n`, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "deleted", stderr: "" });
      const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(300_001);
      const provider = createOpenShellWorkerProvider({ runCli, now, sleep: async () => {} });

      await expect(provider.provision({}, "not-ready")).rejects.toThrow(
        "OpenShell operation sandbox did not become ready",
      );
      expect(runCli.mock.calls.some(([call]) => call.args[1] === "create")).toBe(false);
      expect(runCli.mock.calls[2]?.[0].args[1]).toBe("delete");
    },
  );

  it("cleans up an operation sandbox that remains in Error for the provisioning grace", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Error\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "deleted", stderr: "" });
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(300_001);
    const provider = createOpenShellWorkerProvider({ runCli, now, sleep: async () => {} });

    await expect(provider.provision({}, "failed-operation")).rejects.toThrow(
      "OpenShell operation sandbox did not become ready",
    );
    expect(runCli.mock.calls[2]?.[0].args[1]).toBe("delete");
  });

  it("adopts an allocation when the create response is lost", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: SANDBOX_NOT_FOUND })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "connection lost" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Ready\n", stderr: "" });
    const provider = createOpenShellWorkerProvider({ runCli });

    await expect(provider.provision({}, "lost-create-response")).resolves.toMatchObject({
      ssh: { kind: "proxy-command" },
    });
  });

  it("waits for a created sandbox to become Ready", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: SSH_CONFIG, stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: SANDBOX_NOT_FOUND })
      .mockResolvedValueOnce({ code: 0, stdout: "created", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Provisioning\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "  Phase: Ready\n", stderr: "" });
    const sleep = vi.fn(async () => {});
    const provider = createOpenShellWorkerProvider({ runCli, now: () => 0, sleep });

    await expect(provider.provision({}, "wait-ready")).resolves.toMatchObject({
      ssh: { kind: "proxy-command" },
    });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("maps authoritative absence and makes destroy idempotent", async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: SANDBOX_NOT_FOUND })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: SANDBOX_NOT_FOUND });
    const provider = createOpenShellWorkerProvider({ runCli });

    await expect(provider.inspect({ leaseId: "missing", profile: {} })).resolves.toEqual({
      status: "unknown",
    });
    await expect(provider.destroy({ leaseId: "missing", profile: {} })).resolves.toBeUndefined();
  });

  it.each([
    ["Ready", "active"],
    ["Provisioning", "pending"],
    ["Deleting", "pending"],
    ["Error", "failed"],
  ] as const)("maps OpenShell phase %s to %s", async (phase, status) => {
    const provider = createOpenShellWorkerProvider({
      runCli: vi
        .fn()
        .mockResolvedValue({ code: 0, stdout: `Sandbox:\n\n  Phase: ${phase}\n`, stderr: "" }),
    });

    await expect(provider.inspect({ leaseId: "worker", profile: {} })).resolves.toEqual({ status });
  });

  it.each([
    "gateway not found",
    "policy does not exist",
    'status: NotFound, message: "provider not found"',
  ])("propagates unrelated lookup failure: %s", async (stderr) => {
    const provider = createOpenShellWorkerProvider({
      runCli: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr }),
    });

    await expect(provider.inspect({ leaseId: "worker", profile: {} })).rejects.toThrow(
      "OpenShell sandbox get failed",
    );
  });

  it("propagates a failed delete even when its text contains not found", async () => {
    const provider = createOpenShellWorkerProvider({
      runCli: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "gateway not found" }),
    });

    await expect(provider.destroy({ leaseId: "worker", profile: {} })).rejects.toThrow(
      "OpenShell sandbox delete failed",
    );
  });
});
