import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type {
  WorkerLease,
  WorkerLeaseStatus,
  WorkerLocalInferenceRoute,
  WorkerSshTransport,
} from "../../plugins/types.js";
import { normalizeWorkerLocalInferenceRoute, normalizeWorkerSshEndpoint } from "./store.js";

export function inspectionStatus(value: unknown): WorkerLeaseStatus["status"] {
  if (!isRecord(value)) {
    throw new Error("Worker provider returned an invalid inspection result");
  }
  const status = value.status;
  if (
    status !== "active" &&
    status !== "pending" &&
    status !== "failed" &&
    status !== "destroyed" &&
    status !== "unknown"
  ) {
    throw new Error("Worker provider returned an invalid inspection status");
  }
  return status;
}

export function requireWorkerLease(value: unknown): WorkerLease {
  if (
    !isRecord(value) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId.trim() ||
    !isRecord(value.ssh)
  ) {
    throw new Error("Worker provider returned an invalid provision result");
  }
  return {
    leaseId: value.leaseId.trim(),
    ssh: normalizeWorkerSshEndpoint(value.ssh as WorkerSshTransport),
    ...(value.inference === undefined
      ? {}
      : {
          inference: normalizeWorkerLocalInferenceRoute(
            value.inference as WorkerLocalInferenceRoute,
          ),
        }),
  };
}

export function boundedWorkerError(error: unknown): string {
  const redacted = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(redacted || "unknown error", 1_024);
}
