import { EventEmitter } from "node:events";

export function generateDeviceId(
  deviceIdStruct: Record<string, string>,
): string {
  // Escapes everything except alphanumerics and underscore
  function esc(str): string {
    return str.replace(/[^A-Za-z0-9_]/g, (chr) => {
      const buf = Buffer.from(chr, "utf8");
      let rep = "";
      for (const b of buf) rep += "%" + b.toString(16).toUpperCase();
      return rep;
    });
  }

  // Guaranteeing globally unique id as defined in TR-069
  if (deviceIdStruct["ProductClass"]) {
    return (
      esc(deviceIdStruct["OUI"]) +
      "-" +
      esc(deviceIdStruct["ProductClass"]) +
      "-" +
      esc(deviceIdStruct["SerialNumber"])
    );
  }
  return esc(deviceIdStruct["OUI"]) + "-" + esc(deviceIdStruct["SerialNumber"]);
}

// Source: http://stackoverflow.com/a/6969486
export function escapeRegExp(str: string): string {
  return str.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
}

export function encodeTag(tag: string): string {
  return encodeURIComponent(tag)
    .replace(
      /[!~*'().]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    )
    .replace(/0x(?=[0-9A-Z]{2})/g, "0%78")
    .replace(/%/g, "0x");
}

export function decodeTag(tag: string): string {
  return decodeURIComponent(tag.replace(/0x(?=[0-9A-Z]{2})/g, "%"));
}

export function once(
  emitter: EventEmitter,
  event: string,
  timeout: number,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Event ${event} timed out after ${timeout} ms`));
    }, timeout);

    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

export function setTimeoutPromise(delay: number, ref = true): Promise<void> {
  return new Promise((resolve) => {
    const timerId = setTimeout(resolve, delay);
    if (!ref) timerId.unref();
  });
}

// SPL-16009: parse comma-separated manufacturer list from DEDUPLICATION_MANUFACTURERS config.
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

// SPL-16009: true if the Inform's Manufacturer is present in the dedup list.
// Empty list → feature disabled for all vendors. Match is case-insensitive on trimmed value.
export function shouldDeduplicate(
  manufacturer: string | null | undefined,
  dedupSet: Set<string>,
): boolean {
  if (!manufacturer) return false;
  if (dedupSet.size === 0) return false;
  return dedupSet.has(manufacturer.trim().toUpperCase());
}

// SPL-16009: read-only identity paths that saveDevice must NOT overwrite with an empty string
// when a non-empty value is already stored. Verified against Splynx codebase:
// ProvisioningFlowRaw.php:143 hard-skips Device.DeviceInfo.* and Device.ManagementServer.* in
// provision diff; ACSConfig.php only reads these paths; factory reset / firmware upgrade /
// reboot do not SetParameterValues on them. Protection is therefore safe from false positives.
export const PROTECTED_IDENTITY_PATHS: ReadonlySet<string> = new Set([
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

// SPL-16009: true when a $set on this path should be skipped because it would overwrite a
// stored non-empty string with an empty one. Pure function; _deviceId._* fields are handled
// separately inline in saveDevice (they don't go through this path-string API).
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
