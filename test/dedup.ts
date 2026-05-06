import test from "node:test";
import assert from "node:assert";
import {
  parseDedupManufacturers,
  shouldDeduplicate,
  shouldPreserveOnEmpty,
  shouldSkipDeviceIdSet,
} from "../lib/dedup.ts";

void test("parseDedupManufacturers: normalises and dedupes", () => {
  const set = parseDedupManufacturers(" Mercusys , TP-LINK ,, mercusys ");
  assert.deepStrictEqual([...set].sort(), ["MERCUSYS", "TP-LINK"]);
});

void test("parseDedupManufacturers: empty input", () => {
  assert.strictEqual(parseDedupManufacturers("").size, 0);
  assert.strictEqual(parseDedupManufacturers(null).size, 0);
  assert.strictEqual(parseDedupManufacturers(undefined).size, 0);
});

void test("parseDedupManufacturers: filters out whitespace-only entries", () => {
  const set = parseDedupManufacturers("MERCUSYS, ,TP-LINK");
  assert.deepStrictEqual([...set].sort(), ["MERCUSYS", "TP-LINK"]);
});

void test("shouldDeduplicate: case-insensitive match", () => {
  const set = parseDedupManufacturers("MERCUSYS");
  assert.strictEqual(shouldDeduplicate("mercusys", set), true);
  assert.strictEqual(shouldDeduplicate(" Mercusys ", set), true);
  assert.strictEqual(shouldDeduplicate("MERCUSYS", set), true);
});

void test("shouldDeduplicate: non-match and empty inputs", () => {
  const set = parseDedupManufacturers("MERCUSYS");
  assert.strictEqual(shouldDeduplicate("TP-LINK", set), false);
  assert.strictEqual(shouldDeduplicate("", set), false);
  assert.strictEqual(shouldDeduplicate(null, set), false);
  assert.strictEqual(shouldDeduplicate(undefined, set), false);
});

void test("shouldDeduplicate: empty list disables feature", () => {
  const empty = parseDedupManufacturers("");
  assert.strictEqual(shouldDeduplicate("MERCUSYS", empty), false);
});

void test("shouldPreserveOnEmpty: protected path, non-empty → empty", () => {
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.HardwareVersion", "1.0", ""),
    true,
  );
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.ModelName", "MR80X", ""),
    true,
  );
});

void test("shouldPreserveOnEmpty: protected path, non-empty → non-empty", () => {
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.HardwareVersion", "1.0", "2.0"),
    false,
  );
});

void test("shouldPreserveOnEmpty: protected path, no previous value", () => {
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.HardwareVersion", undefined, ""),
    false,
  );
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.HardwareVersion", null, ""),
    false,
  );
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.HardwareVersion", "", ""),
    false,
  );
});

void test("shouldPreserveOnEmpty: non-protected path is never preserved", () => {
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.WiFi.SSID.1.SSID", "MyNet", ""),
    false,
  );
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.Time.NTPServer1", "pool.ntp.org", ""),
    false,
  );
});

void test("shouldPreserveOnEmpty: IGD data-model paths are protected", () => {
  assert.strictEqual(
    shouldPreserveOnEmpty(
      "InternetGatewayDevice.DeviceInfo.SoftwareVersion",
      "1.0",
      "",
    ),
    true,
  );
  assert.strictEqual(
    shouldPreserveOnEmpty(
      "InternetGatewayDevice.DeviceInfo.HardwareVersion",
      "rev-A",
      "",
    ),
    true,
  );
});

void test("shouldPreserveOnEmpty: non-string values are not preserved", () => {
  // Guard against unexpected numeric / object values flowing through the diff tuple.
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.HardwareVersion", 42, ""),
    false,
  );
  assert.strictEqual(
    shouldPreserveOnEmpty("Device.DeviceInfo.HardwareVersion", "1.0", 0),
    false,
  );
});

void test("shouldSkipDeviceIdSet: non-empty old → empty new on protected segment", () => {
  // _deviceId._Manufacturer / _OUI / _ProductClass / _SerialNumber — protected.
  assert.strictEqual(shouldSkipDeviceIdSet(true, "Manufacturer", "", "MERCUSYS"), true);
  assert.strictEqual(shouldSkipDeviceIdSet(true, "OUI", "", "30169D"), true);
  assert.strictEqual(shouldSkipDeviceIdSet(true, "ProductClass", "", "MR80X"), true);
  assert.strictEqual(shouldSkipDeviceIdSet(true, "SerialNumber", "", "AAAA"), true);
});

void test("shouldSkipDeviceIdSet: ID segment is never protected", () => {
  // _id is immutable in MongoDB — special-cased away from the guard.
  assert.strictEqual(shouldSkipDeviceIdSet(true, "ID", "", "30169D-MR80X-AAAA"), false);
});

void test("shouldSkipDeviceIdSet: preserveIdentity off disables the guard", () => {
  assert.strictEqual(shouldSkipDeviceIdSet(false, "Manufacturer", "", "MERCUSYS"), false);
});

void test("shouldSkipDeviceIdSet: non-empty new → no skip", () => {
  // Legitimate update from one non-empty value to another non-empty value.
  assert.strictEqual(shouldSkipDeviceIdSet(true, "OUI", "e005c7", "30169D"), false);
});

void test("shouldSkipDeviceIdSet: no previous value or non-string types → no skip", () => {
  assert.strictEqual(shouldSkipDeviceIdSet(true, "Manufacturer", "", undefined), false);
  assert.strictEqual(shouldSkipDeviceIdSet(true, "Manufacturer", "", null), false);
  assert.strictEqual(shouldSkipDeviceIdSet(true, "Manufacturer", "", ""), false);
  assert.strictEqual(shouldSkipDeviceIdSet(true, "Manufacturer", 0, "MERCUSYS"), false);
  assert.strictEqual(shouldSkipDeviceIdSet(true, "Manufacturer", "", 42), false);
});
