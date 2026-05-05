// SPL-16009: All deduplication logic concentrated here so upstream files only
// need a thin hook (one or two lines per integration point). Goal: when the fork
// rebases onto a newer upstream version, our diff into upstream files stays small
// and easy to re-apply.
//
// Three public surfaces:
//   1. resolveDedup() — used by cwmp.ts during Inform session init
//   2. shouldSkipDeviceIdSet() / shouldPreserveOnEmpty() — used by cwmp/db.ts in saveDevice
//   3. helpers (parseDedupManufacturers, shouldDeduplicate) — exported for test coverage

import * as config from "./config.ts";
import { collections } from "./db/db.ts";

// Read-only identity paths that saveDevice must NOT overwrite with an empty string
// when a non-empty value is already stored. Verified against Splynx codebase:
// ProvisioningFlowRaw.php hard-skips Device.DeviceInfo.* and Device.ManagementServer.*
// in provision diff; ACSConfig only reads these paths; factory reset / firmware upgrade /
// reboot do not SetParameterValues on them. Protection is therefore safe.
const PROTECTED_IDENTITY_PATHS: ReadonlySet<string> = new Set([
  // TR-069 Device:2.0 data model
  "Device.DeviceInfo.Manufacturer",
  "Device.DeviceInfo.ManufacturerOUI",
  "Device.DeviceInfo.ModelName",
  "Device.DeviceInfo.ProductClass",
  "Device.DeviceInfo.SerialNumber",
  "Device.DeviceInfo.HardwareVersion",
  "Device.DeviceInfo.SoftwareVersion",
  // TR-069 InternetGatewayDevice:1.0 data model
  "InternetGatewayDevice.DeviceInfo.Manufacturer",
  "InternetGatewayDevice.DeviceInfo.ManufacturerOUI",
  "InternetGatewayDevice.DeviceInfo.ModelName",
  "InternetGatewayDevice.DeviceInfo.ProductClass",
  "InternetGatewayDevice.DeviceInfo.SerialNumber",
  "InternetGatewayDevice.DeviceInfo.HardwareVersion",
  "InternetGatewayDevice.DeviceInfo.SoftwareVersion",
]);

// Parse comma-separated manufacturer list from DEDUPLICATION_MANUFACTURERS config.
// Returns a case-insensitive Set of trimmed uppercase names; empty input → empty Set.
export function parseDedupManufacturers(
  raw: string | null | undefined,
): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0),
  );
}

// True iff the Inform's Manufacturer is present in the dedup list.
// Empty list → feature disabled for all vendors. Match is case-insensitive on trimmed value.
export function shouldDeduplicate(
  manufacturer: string | null | undefined,
  dedupSet: Set<string>,
): boolean {
  if (!manufacturer) return false;
  if (dedupSet.size === 0) return false;
  return dedupSet.has(manufacturer.trim().toUpperCase());
}

// True when a $set on this path should be skipped because it would overwrite a
// stored non-empty string with an empty one. Used by saveDevice value-case branch.
export function shouldPreserveOnEmpty(
  path: string,
  oldValue: unknown,
  newValue: unknown,
): boolean {
  if (!PROTECTED_IDENTITY_PATHS.has(path)) return false;
  if (typeof newValue !== "string" || newValue !== "") return false;
  if (typeof oldValue !== "string" || oldValue === "") return false;
  return true;
}

// True when a DeviceID-branch $set should be skipped (same rule as shouldPreserveOnEmpty
// but for the inline _deviceId._* writes in saveDevice that don't use a path string).
// `_id` itself is excluded because it's immutable in MongoDB anyway.
// `segment` is typed `unknown` to accept Path.segments[*] (string | Alias) without coupling.
export function shouldSkipDeviceIdSet(
  preserveIdentity: boolean,
  segment: unknown,
  newValue: unknown,
  oldValue: unknown,
): boolean {
  if (!preserveIdentity) return false;
  if (segment === "ID") return false;
  if (typeof newValue !== "string" || newValue !== "") return false;
  if (typeof oldValue !== "string" || oldValue === "") return false;
  return true;
}

// Secondary device lookup used when DEDUPLICATION_MANUFACTURERS gates an incoming
// Inform whose computed _id differs from any existing document. Returns the existing
// document's _id so the caller can reuse it as the session deviceId — the normal upsert
// path then refreshes _deviceId.* subfields in place instead of creating a duplicate.
async function findDeviceIdBySerialAndManufacturer(
  manufacturer: string,
  serialNumber: string,
): Promise<string | null> {
  const doc = await collections.devices.findOne(
    {
      "_deviceId._Manufacturer": manufacturer,
      "_deviceId._SerialNumber": serialNumber,
    },
    { projection: { _id: 1 } },
  );
  return doc ? (doc._id as string) : null;
}

export type DedupResolution = {
  // What to use as session.deviceId. Equal to computedDeviceId when no remap.
  effectiveDeviceId: string;
  // True iff manufacturer is in DEDUPLICATION_MANUFACTURERS — drives saveDevice protection.
  flagged: boolean;
  // Non-null when the Inform should be rejected (empty Manufacturer/SerialNumber on a
  // flagged manufacturer). Caller passes this to clientError().
  rejectReason: string | null;
  // Non-null when an existing device was matched by SN+Manufacturer (logged for observability).
  remappedFrom: string | null;
};

// Decides effective deviceId + reject status for an incoming Inform. Pure orchestration —
// no logging or HTTP side effects (caller handles those at the cwmp.ts layer).
//
//   const dedup = await resolveDedup(rpc.cpeRequest.deviceId, computedDeviceId);
//   if (dedup.rejectReason) return clientError(...);
//   if (dedup.remappedFrom) logger.accessInfo(...);
//   const sc = session.init(dedup.effectiveDeviceId, ...);
//   sc.preserveIdentity = dedup.flagged;
export async function resolveDedup(
  informDeviceId: Record<string, string>,
  computedDeviceId: string,
): Promise<DedupResolution> {
  const dedupSet = parseDedupManufacturers(
    String(config.get("DEDUPLICATION_MANUFACTURERS") ?? ""),
  );
  const flagged = shouldDeduplicate(informDeviceId.Manufacturer, dedupSet);

  if (!flagged) {
    return {
      effectiveDeviceId: computedDeviceId,
      flagged: false,
      rejectReason: null,
      remappedFrom: null,
    };
  }

  const manufacturer = informDeviceId.Manufacturer?.trim() ?? "";
  const serialNumber = informDeviceId.SerialNumber?.trim() ?? "";

  if (!manufacturer || !serialNumber) {
    return {
      effectiveDeviceId: computedDeviceId,
      flagged: true,
      rejectReason: "empty manufacturer or serial number",
      remappedFrom: null,
    };
  }

  const existingId = await findDeviceIdBySerialAndManufacturer(
    manufacturer,
    serialNumber,
  );
  if (existingId && existingId !== computedDeviceId) {
    return {
      effectiveDeviceId: existingId,
      flagged: true,
      rejectReason: null,
      remappedFrom: computedDeviceId,
    };
  }

  return {
    effectiveDeviceId: computedDeviceId,
    flagged: true,
    rejectReason: null,
    remappedFrom: null,
  };
}
