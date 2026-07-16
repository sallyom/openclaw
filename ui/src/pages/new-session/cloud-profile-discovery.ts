import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestCloudProfiles } from "./cloud-target.ts";
import type { DraftCloudProfileCatalog } from "./discovery.ts";

export const CLOUD_PROFILE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const;

export function selectProfiles(
  catalog: DraftCloudProfileCatalog,
  client: { recoveryScopeReady?: boolean } | null,
  recoveryScope: string,
) {
  const unsupported =
    catalog.profiles.length > 0 && client?.recoveryScopeReady === true && !recoveryScope;
  return { profiles: unsupported ? [] : catalog.profiles, unsupported };
}

export function discoverCloudProfiles(
  client: Pick<GatewayBrowserClient, "request">,
  admin: boolean,
): Promise<DraftCloudProfileCatalog> {
  return admin ? requestCloudProfiles(client) : Promise.resolve({ profiles: [] });
}
