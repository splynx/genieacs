import test from "node:test";
import assert from "node:assert";
import {
  parseDedupManufacturers,
  shouldDeduplicate,
  shouldPreserveOnEmpty,
} from "../lib/dedup.ts";

// SPL-16009

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
