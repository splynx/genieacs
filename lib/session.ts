import * as device from "./device.ts";
import * as sandbox from "./sandbox.ts";
import * as localCache from "./cwmp/local-cache.ts";
import * as defaultProvisions from "./default-provisions.ts";
import { estimateGpnCount } from "./gpn-heuristic.ts";
import Path from "./common/path.ts";
import PathSet from "./common/path-set.ts";
import VersionedMap from "./versioned-map.ts";
import InstanceSet from "./instance-set.ts";
import {
  Attributes,
  SessionContext,
  DeviceData,
  VirtualParameterDeclaration,
  AttributeTimestamps,
  AttributeValues,
  Fault,
  Declaration,
  Clear,
  CpeResponse,
  CpeFault,
  AcsRequest,
  AcsResponse,
  InformRequest,
  TransferCompleteRequest,
  Operation,
  ScriptResult,
  Expression,
  GetParameterValues,
  GetParameterAttributes,
  GetParameterNames,
  SetParameterValues,
  SetParameterAttributes,
  AddObject,
  DeleteObject,
  Download,
  Reboot,
  FactoryReset,
  AddObjectResponse,
  GetParameterValuesResponse,
} from "./types.ts";
import { getRequestOrigin } from "./forwarded.ts";
import * as logger from "./logger.ts";
import { encodeTag } from "./util.ts";
import { Ignore } from "./ignore";

const VALID_PARAM_TYPES = new Set([
  "xsd:int",
  "xsd:unsignedInt",
  "xsd:boolean",
  "xsd:string",
  "xsd:dateTime",
  "xsd:base64",
  "xsd:hexBinary",
]);

function initDeviceData(): DeviceData {
  return {
    paths: new PathSet(),
    timestamps: new VersionedMap(),
    attributes: new VersionedMap(),
    trackers: new Map(),
    changes: new Set(),
  };
}

export function init(
  deviceId: string,
  cwmpVersion: string,
  timeout: number,
): SessionContext {
  const timestamp = Date.now();
  const sessionContext: SessionContext = {
    timestamp: timestamp,
    deviceId: deviceId,
    deviceData: initDeviceData(),
    cwmpVersion: cwmpVersion,
    timeout: timeout,
    provisions: [],
    channels: {},
    virtualParameters: [],
    revisions: [0],
    rpcCount: 0,
    iteration: 0,
    cycle: 0,
    extensionsCache: {},
    declarations: [],
    state: 0,
    authState: 0,
  };

  return sessionContext;
}

function generateRpcId(sessionContext: SessionContext): string {
  return (
    sessionContext.timestamp.toString(16) +
    ("0" + sessionContext.cycle.toString(16)).slice(-2) +
    ("0" + sessionContext.rpcCount.toString(16)).slice(-2)
  );
}

export function configContextCallback(
  sessionContext: SessionContext,
  exp: Expression,
): Expression {
  if (!Array.isArray(exp)) return exp;
  if (exp[0] === "PARAM" && typeof exp[1] === "string") {
    let name = exp[1];
    if (name === "id") name = "DeviceID.ID";
    else if (name === "serialNumber") name = "DeviceID.SerialNumber";
    else if (name === "productClass") name = "DeviceID.ProductClass";
    else if (name === "oui") name = "DeviceID.OUI";
    else if (name === "remoteAddress")
      return getRequestOrigin(sessionContext.httpRequest).remoteAddress;

    const deviceData = sessionContext.deviceData;
    const paths = deviceData.paths;
    const path = paths.get(Path.parse(name));
    if (path) {
      const attrs = deviceData.attributes.get(path, 1);
      if (attrs?.value?.[1]) return attrs.value[1][0];
    }
  } else if (exp[0] === "FUNC") {
    if (exp[1] === "REMOTE_ADDRESS")
      return getRequestOrigin(sessionContext.httpRequest).remoteAddress;
  }
  return exp;
}

export async function inform(
  sessionContext: SessionContext,
  rpcReq: InformRequest,
): Promise<AcsResponse> {
  const timestamp = sessionContext.timestamp + sessionContext.iteration + 1;
  const params: [Path, number, Attributes][] = [
    [
      Path.parse("DeviceID.Manufacturer"),
      timestamp,
      {
        object: [timestamp, 0],
        writable: [timestamp, 0],
        value: [timestamp, [rpcReq.deviceId.Manufacturer, "xsd:string"]],
      },
    ],

    [
      Path.parse("DeviceID.OUI"),
      timestamp,
      {
        object: [timestamp, 0],
        writable: [timestamp, 0],
        value: [timestamp, [rpcReq.deviceId.OUI, "xsd:string"]],
      },
    ],

    [
      Path.parse("DeviceID.ProductClass"),
      timestamp,
      {
        object: [timestamp, 0],
        writable: [timestamp, 0],
        value: [timestamp, [rpcReq.deviceId.ProductClass, "xsd:string"]],
      },
    ],

    [
      Path.parse("DeviceID.SerialNumber"),
      timestamp,
      {
        object: [timestamp, 0],
        writable: [timestamp, 0],
        value: [timestamp, [rpcReq.deviceId.SerialNumber, "xsd:string"]],
      },
    ],
  ];

  for (const p of rpcReq.parameterList) {
    const path = p[0];
    params.push([
      path,
      timestamp,
      {
        object: [timestamp, 0],
        value: [timestamp, p.slice(1) as [string | number | boolean, string]],
      },
    ]);
  }

  params.push([
    Path.parse("Events.Inform"),
    timestamp,
    {
      object: [timestamp, 0],
      writable: [timestamp, 0],
      value: [timestamp, [sessionContext.timestamp, "xsd:dateTime"]],
    },
  ]);

  for (const e of rpcReq.event) {
    params.push([
      Path.parse(`Events.${encodeTag(e.replace(/\s+/g, "_"))}`),
      timestamp,
      {
        object: [timestamp, 0],
        writable: [timestamp, 0],
        value: [timestamp, [sessionContext.timestamp, "xsd:dateTime"]],
      },
    ]);
  }

  if (sessionContext.new) {
    params.push([
      Path.parse("DeviceID.ID"),
      timestamp,
      {
        object: [timestamp, 0],
        writable: [timestamp, 0],
        value: [timestamp, [sessionContext.deviceId, "xsd:string"]],
      },
    ]);
    params.push([
      Path.parse("Events.Registered"),
      timestamp,
      {
        object: [timestamp, 0],
        writable: [timestamp, 0],
        value: [timestamp, [sessionContext.timestamp, "xsd:dateTime"]],
      },
    ]);
  }

  sessionContext.deviceData.timestamps.revision = 1;
  sessionContext.deviceData.attributes.revision = 1;

  let toClear = null;
  for (const p of params) {
    // Don't need to clear wildcards for Events
    if (p[0].segments[0] === "Events") {
      device.set(sessionContext.deviceData, p[0], p[1], p[2]);
    } else {
      toClear = device.set(
        sessionContext.deviceData,
        p[0],
        p[1],
        p[2],
        toClear,
      );
    }
  }

  if (toClear) {
    for (const c of toClear)
      device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
  }

  return { name: "InformResponse" };
}

export async function transferComplete(
  sessionContext: SessionContext,
  rpcReq: TransferCompleteRequest,
): Promise<{ acsResponse: AcsResponse; operation: Operation; fault: Fault }> {
  const revision =
    (sessionContext.revisions[sessionContext.revisions.length - 1] || 0) + 1;
  sessionContext.deviceData.timestamps.revision = revision;
  sessionContext.deviceData.attributes.revision = revision;
  const commandKey = rpcReq.commandKey;
  const operation = sessionContext.operations[commandKey];

  if (!operation) {
    return {
      acsResponse: { name: "TransferCompleteResponse" },
      operation: null,
      fault: null,
    };
  }

  const instance = operation.args.instance;

  delete sessionContext.operations[commandKey];
  if (!sessionContext.operationsTouched) sessionContext.operationsTouched = {};
  sessionContext.operationsTouched[commandKey] = 1;

  if (rpcReq.faultStruct?.faultCode !== "0") {
    revertDownloadParameters(sessionContext, operation.args.instance);

    const fault: Fault = {
      code: `cwmp.${rpcReq.faultStruct.faultCode}`,
      message: rpcReq.faultStruct.faultString,
      detail: rpcReq.faultStruct,
      timestamp: operation.timestamp,
    };

    return {
      acsResponse: { name: "TransferCompleteResponse" },
      operation: operation,
      fault: fault,
    };
  }

  let toClear = null;
  const timestamp = sessionContext.timestamp + sessionContext.iteration + 1;

  let p;

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.LastDownload`),
  );
  toClear = device.set(
    sessionContext.deviceData,
    p,
    timestamp,
    { value: [timestamp, [operation.timestamp, "xsd:dateTime"]] },
    toClear,
  );

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.LastFileType`),
  );
  toClear = device.set(
    sessionContext.deviceData,
    p,
    timestamp,
    { value: [timestamp, [operation.args.fileType, "xsd:string"]] },
    toClear,
  );

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.LastFileName`),
  );
  toClear = device.set(
    sessionContext.deviceData,
    p,
    timestamp,
    { value: [timestamp, [operation.args.fileName, "xsd:string"]] },
    toClear,
  );

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.LastTargetFileName`),
  );
  toClear = device.set(
    sessionContext.deviceData,
    p,
    timestamp,
    { value: [timestamp, [operation.args.targetFileName, "xsd:string"]] },
    toClear,
  );

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.StartTime`),
  );
  toClear = device.set(
    sessionContext.deviceData,
    p,
    timestamp,
    { value: [timestamp, [+rpcReq.startTime, "xsd:dateTime"]] },
    toClear,
  );

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.CompleteTime`),
  );
  toClear = device.set(
    sessionContext.deviceData,
    p,
    timestamp,
    { value: [timestamp, [+rpcReq.completeTime, "xsd:dateTime"]] },
    toClear,
  );

  if (toClear) {
    for (const c of toClear)
      device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
  }

  return {
    acsResponse: { name: "TransferCompleteResponse" },
    operation: operation,
    fault: null,
  };
}

function revertDownloadParameters(
  sessionContext: SessionContext,
  instance,
): void {
  const timestamp = sessionContext.timestamp + sessionContext.iteration + 1;

  let p;

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.LastDownload`),
  );

  const lastDownload = sessionContext.deviceData.attributes.get(p);

  p = sessionContext.deviceData.paths.add(
    Path.parse(`Downloads.${instance}.Download`),
  );

  const toClear = device.set(sessionContext.deviceData, p, timestamp, {
    value: [timestamp, [lastDownload?.value[1]?.[0] || 0, "xsd:dateTime"]],
  });

  if (toClear) {
    for (const c of toClear)
      device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
  }
}

export async function timeoutOperations(
  sessionContext: SessionContext,
): Promise<{ faults: Fault[]; operations: Operation[] }> {
  const revision =
    (sessionContext.revisions[sessionContext.revisions.length - 1] || 0) + 1;
  sessionContext.deviceData.timestamps.revision = revision;
  sessionContext.deviceData.attributes.revision = revision;
  const faults = [];
  const operations = [];

  for (const [commandKey, operation] of Object.entries(
    sessionContext.operations,
  )) {
    if (operation.name !== "Download")
      throw new Error(`Unknown operation name ${operation.name}`);

    const DOWNLOAD_TIMEOUT =
      +localCache.getConfig(
        sessionContext.cacheSnapshot,
        "cwmp.downloadTimeout",
        {},
        sessionContext.timestamp,
        (e) => configContextCallback(sessionContext, e),
      ) * 1000;

    if (sessionContext.timestamp < operation.timestamp + DOWNLOAD_TIMEOUT)
      continue;

    logger.accessWarn({
      sessionContext: sessionContext,
      message: "Download operation timed out",
      commandKey: commandKey,
    });

    const SUCCESS_ON_TIMEOUT = +localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.downloadSuccessOnTimeout",
      {},
      sessionContext.timestamp,
      (e) => configContextCallback(sessionContext, e),
    );

    if (SUCCESS_ON_TIMEOUT) {
      const r = {
        name: "TransferComplete" as const,
        commandKey: commandKey,
        startTime: 0,
        completeTime: 0,
      };

      // Call transferComplete code and ignore the response
      await transferComplete(sessionContext, r);
      continue;
    }

    delete sessionContext.operations[commandKey];
    if (!sessionContext.operationsTouched)
      sessionContext.operationsTouched = {};
    sessionContext.operationsTouched[commandKey] = 1;

    faults.push({
      code: "timeout",
      message: "Download operation timed out",
      timestamp: operation.timestamp,
    });

    operations.push(operation);

    revertDownloadParameters(sessionContext, operation.args.instance);
  }

  return { faults, operations };
}

export function addProvisions(
  sessionContext: SessionContext,
  channel: string,
  provisions: [string, ...Expression[]][],
): void {
  // Multiply by two because every iteration is two
  // phases: read and update
  const MAX_ITERATIONS =
    +localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.maxCommitIterations",
      {},
      sessionContext.timestamp,
      (e) => configContextCallback(sessionContext, e),
    ) * 2;

  delete sessionContext.syncState;
  delete sessionContext.rpcRequest;
  sessionContext.declarations = [];
  sessionContext.provisionsRet = [];

  if (sessionContext.revisions[sessionContext.revisions.length - 1] > 0) {
    sessionContext.deviceData.timestamps.collapse(1);
    sessionContext.deviceData.attributes.collapse(1);
    sessionContext.revisions = [0];
    sessionContext.extensionsCache = {};
  }

  if (sessionContext.iteration !== sessionContext.cycle * MAX_ITERATIONS) {
    sessionContext.cycle += 1;
    sessionContext.rpcCount = 0;
    sessionContext.iteration = sessionContext.cycle * MAX_ITERATIONS;
  }

  sessionContext.channels[channel] |= 0;

  for (const provision of provisions) {
    const channels = [channel];
    // Remove duplicate provisions
    const provisionStr = JSON.stringify(provision);
    for (const [j, p] of sessionContext.provisions.entries()) {
      if (JSON.stringify(p) === provisionStr) {
        sessionContext.provisions.splice(j, 1);
        for (const c of Object.keys(sessionContext.channels)) {
          if (sessionContext.channels[c] & (1 << j)) channels.push(c);
          const a = sessionContext.channels[c] >> (j + 1);
          sessionContext.channels[c] &= (1 << j) - 1;
          sessionContext.channels[c] |= a << j;
        }
      }
    }

    for (const c of channels)
      sessionContext.channels[c] |= 1 << sessionContext.provisions.length;

    sessionContext.provisions.push(provision);
  }
}

export function clearProvisions(sessionContext: SessionContext): void {
  // Multiply by two because every iteration is two
  // phases: read and update
  const MAX_ITERATIONS =
    +localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.maxCommitIterations",
      {},
      sessionContext.timestamp,
      (e) => configContextCallback(sessionContext, e),
    ) * 2;

  if (sessionContext.revisions[sessionContext.revisions.length - 1] > 0) {
    sessionContext.deviceData.timestamps.collapse(1);
    sessionContext.deviceData.attributes.collapse(1);
  }

  if (sessionContext.iteration !== sessionContext.cycle * MAX_ITERATIONS) {
    sessionContext.cycle += 1;
    sessionContext.rpcCount = 0;
    sessionContext.iteration = sessionContext.cycle * MAX_ITERATIONS;
  }

  delete sessionContext.syncState;
  delete sessionContext.rpcRequest;
  sessionContext.provisions = [];
  sessionContext.virtualParameters = [];
  sessionContext.channels = {};
  sessionContext.declarations = [];
  sessionContext.provisionsRet = [];
  sessionContext.revisions = [0];
  sessionContext.extensionsCache = {};
}

async function runProvisions(
  sessionContext: SessionContext,
  provisions: any[][],
  startRevision: number,
  endRevision: number,
): Promise<ScriptResult> {
  const allProvisions = localCache.getProvisions(sessionContext.cacheSnapshot);

  const res = await Promise.all(
    provisions.map(async (provision) => {
      if (!allProvisions[provision[0]]) {
        if (defaultProvisions[provision[0]]) {
          const dec = [];
          let done = true;
          let fault = null;
          try {
            done = defaultProvisions[provision[0]](
              sessionContext,
              provision,
              dec,
              startRevision,
              endRevision,
            );
          } catch (err) {
            fault = {
              code: `script.${err.name}`,
              message: err.message,
              detail: {
                name: err.name,
                message: err.message,
                stack: `${err.name}: ${err.message}\n    at ${provision[0]}`,
              },
            };
          }
          return {
            fault: fault,
            clear: null,
            declare: dec,
            done: done,
            returnValue: null,
          };
        }
        return null;
      }

      return sandbox.run(
        allProvisions[provision[0]].script,
        { args: provision.slice(1) },
        sessionContext,
        startRevision,
        endRevision,
      );
    }),
  );

  let done = true;
  let allDeclarations = [];
  let allClear = [];
  let fault;

  for (const r of res) {
    if (!r) continue;
    done = done && r.done;
    if (r.declare) allDeclarations = allDeclarations.concat(r.declare);
    if (r.clear) allClear = allClear.concat(r.clear);
    fault = r.fault || fault;
  }

  if (done) for (const d of allDeclarations) d.defer = false;

  return {
    fault: fault,
    clear: allClear,
    declare: allDeclarations,
    done: done,
    returnValue: null,
  };
}

async function runVirtualParameters(
  sessionContext: SessionContext,
  provisions: any[][],
  startRevision: number,
  endRevision: number,
): Promise<ScriptResult> {
  const allVirtualParameters = localCache.getVirtualParameters(
    sessionContext.cacheSnapshot,
  );

  const res = await Promise.all(
    provisions.map(async (provision) => {
      const globals = {
        args: provision.slice(1),
      };

      const r = await sandbox.run(
        allVirtualParameters[provision[0]].script,
        globals,
        sessionContext,
        startRevision,
        endRevision,
      );

      if (r.done && !r.fault) {
        if (!r.returnValue) {
          r.fault = {
            code: "script",
            message: "Invalid virtual parameter return value",
          };
          return r;
        }

        const ret: {
          writable?: boolean;
          value?: [string | number | boolean, string?];
        } = {};

        if (r.returnValue.writable != null) {
          ret.writable = !!r.returnValue.writable;
        } else if (
          provision[1].writable != null ||
          provision[2].writable != null
        ) {
          r.fault = {
            code: "script",
            message: `Virtual parameter '${provision[0]}' must provide 'writable' attribute`,
          };
          return r;
        }

        if (r.returnValue.value != null) {
          let v: string | number | boolean, t: string;

          if (Array.isArray(r.returnValue.value)) [v, t] = r.returnValue.value;
          else v = r.returnValue.value;

          if (!t) {
            if (typeof v === "number") t = "xsd:int";
            else if (typeof v === "boolean") t = "xsd:boolean";
            else if ((v as any) instanceof Date) t = "xsd:datetime";
            else t = "xsd:string";
          }

          if (v == null || !VALID_PARAM_TYPES.has(t)) {
            r.fault = {
              code: "script",
              message: "Invalid virtual parameter value attribute",
            };
            return r;
          }

          ret.value = device.sanitizeParameterValue([v, t]);
        } else if (provision[1].value != null || provision[2].value != null) {
          r.fault = {
            code: "script",
            message: `Virtual parameter '${provision[0]}' must provide 'value' attribute`,
          };
          return r;
        }

        r.returnValue = ret;
      }
      return r;
    }),
  );

  let done = true;
  const virtualParameterUpdates = [];
  let allDeclarations = [];
  let allClear = [];
  let fault;

  for (const r of res) {
    if (!r) {
      virtualParameterUpdates.push(null);
      continue;
    }

    done = done && r.done;
    if (r.declare) allDeclarations = allDeclarations.concat(r.declare);
    if (r.clear) allClear = allClear.concat(r.clear);
    virtualParameterUpdates.push(r.returnValue);
    fault = r.fault || fault;
  }

  if (done) for (const d of allDeclarations) d.defer = false;

  return {
    fault: fault,
    clear: allClear,
    declare: allDeclarations,
    done: done,
    returnValue: done ? virtualParameterUpdates : null,
  };
}

function runDeclarations(
  sessionContext: SessionContext,
  declarations: Declaration[],
): VirtualParameterDeclaration[] {
  if (!sessionContext.syncState) {
    sessionContext.syncState = {
      refreshAttributes: {
        exist: new Set(),
        object: new Set(),
        writable: new Set(),
        value: new Set(),
        notification: new Set(),
        accessList: new Set(),
      },
      spv: new Map(),
      spa: new Map(),
      gpn: new Set<Path>(),
      gpnPatterns: new Map(),
      tags: new Map(),
      virtualParameterDeclarations: [],
      instancesToDelete: new Map(),
      instancesToCreate: new Map(),
      downloadsToDelete: new Set(),
      downloadsToCreate: new InstanceSet(),
      downloadsValues: new Map(),
      downloadsDownload: new Map(),
      reboot: 0,
      factoryReset: 0,
    };
  }

  const allDeclareTimestamps = new Map<Path, number>();
  const allDeclareAttributeTimestamps = new Map<Path, AttributeTimestamps>();
  const allDeclareAttributeValues = new Map<Path, AttributeValues>();

  const allVirtualParameters = localCache.getVirtualParameters(
    sessionContext.cacheSnapshot,
  );

  function mergeAttributeTimestamps(p: Path, attrs: AttributeTimestamps): void {
    let cur = allDeclareAttributeTimestamps.get(p);
    if (!cur) {
      allDeclareAttributeTimestamps.set(p, attrs);
    } else {
      cur = Object.assign({}, cur);
      for (const [k, v] of Object.entries(attrs))
        cur[k] = Math.max(v, cur[k] || 0);
      allDeclareAttributeTimestamps.set(p, cur);
    }
  }

  function mergeAttributeValues(
    p: Path,
    attrs: AttributeValues,
    defer: boolean,
  ): void {
    let cur = allDeclareAttributeValues.get(p);
    if (!cur) {
      if (!defer) allDeclareAttributeValues.set(p, attrs);
    } else {
      cur = Object.assign({}, cur, attrs);
      allDeclareAttributeValues.set(p, cur);
    }
  }

  for (const declaration of declarations) {
    let path = declaration.path;
    let unpacked: Path[];

    // Can't run declarations on root
    if (!path.length) continue;

    if (
      (path.alias | path.wildcard) & 1 ||
      path.segments[0] === "VirtualParameters"
    ) {
      sessionContext.deviceData.paths.add(Path.parse("VirtualParameters"));
      if ((path.alias | path.wildcard) & 2) {
        sessionContext.deviceData.paths.add(Path.parse("VirtualParameters.*"));
        for (const k of Object.keys(allVirtualParameters)) {
          sessionContext.deviceData.paths.add(
            Path.parse(`VirtualParameters.${k}`),
          );
        }
      }
    }

    if ((path.alias | path.wildcard) & 1 || path.segments[0] === "Reboot")
      sessionContext.deviceData.paths.add(Path.parse("Reboot"));

    if ((path.alias | path.wildcard) & 1 || path.segments[0] === "FactoryReset")
      sessionContext.deviceData.paths.add(Path.parse("FactoryReset"));

    if (path.alias) {
      const aliasDecs = device.getAliasDeclarations(
        path,
        declaration.pathGet || 1,
      );
      for (const ad of aliasDecs) {
        const p = sessionContext.deviceData.paths.add(ad.path);
        allDeclareTimestamps.set(
          p,
          Math.max(ad.pathGet || 1, allDeclareTimestamps.get(p) || 0),
        );
        let attrTrackers;
        if (ad.attrGet) {
          attrTrackers = Object.keys(ad.attrGet);
          mergeAttributeTimestamps(p, ad.attrGet);
        }

        device.track(
          sessionContext.deviceData,
          p,
          "prerequisite",
          attrTrackers,
        );
      }

      unpacked = device.unpack(sessionContext.deviceData, path);
      for (const u of unpacked) {
        allDeclareTimestamps.set(
          u,
          Math.max(declaration.pathGet || 1, allDeclareTimestamps.get(u) || 0),
        );
        if (declaration.attrGet)
          mergeAttributeTimestamps(u, declaration.attrGet);
      }
    } else {
      path = sessionContext.deviceData.paths.add(path);
      allDeclareTimestamps.set(
        path,
        Math.max(declaration.pathGet || 1, allDeclareTimestamps.get(path) || 0),
      );
      if (declaration.attrGet)
        mergeAttributeTimestamps(path, declaration.attrGet);
      device.track(sessionContext.deviceData, path, "prerequisite");
    }

    if (declaration.attrSet) {
      if (path.alias | path.wildcard) {
        if (!unpacked)
          unpacked = device.unpack(sessionContext.deviceData, path);

        for (const u of unpacked) {
          mergeAttributeValues(u, declaration.attrSet, declaration.defer);
          // Ensure writable attr is available
          mergeAttributeTimestamps(u, { writable: 1 });
        }
      } else {
        mergeAttributeValues(path, declaration.attrSet, declaration.defer);
        // Ensure writable attr is available
        mergeAttributeTimestamps(path, { writable: 1 });
      }
    }

    if (declaration.pathSet != null) {
      let minInstances, maxInstances;
      if (Array.isArray(declaration.pathSet)) {
        minInstances = declaration.pathSet[0];
        maxInstances = declaration.pathSet[1];
      } else {
        minInstances = maxInstances = declaration.pathSet;
      }

      let parent = path.slice(0, -1);

      let keys;
      if (Array.isArray(path.segments[path.length - 1])) {
        keys = {};
        for (const [p, v] of path.segments[path.length - 1])
          keys[p.toString()] = v;
      } else if (path.segments[path.length - 1] === "*") {
        keys = {};
      }

      if (!parent.wildcard && !parent.alias) {
        parent = sessionContext.deviceData.paths.add(parent);
        if (!unpacked)
          unpacked = device.unpack(sessionContext.deviceData, path);

        // Ensure writable attr is available
        mergeAttributeTimestamps(parent, { writable: 1 });
        for (const u of unpacked) mergeAttributeTimestamps(u, { writable: 1 });

        processInstances(
          sessionContext,
          parent,
          unpacked,
          keys,
          minInstances,
          maxInstances,
          declaration.defer,
        );
      } else {
        const parentsUnpacked = device.unpack(
          sessionContext.deviceData,
          parent,
        );
        for (const par of parentsUnpacked) {
          const up = device.unpack(
            sessionContext.deviceData,
            par.concat(path.slice(-1)),
          );

          // Ensure writable attr is available
          mergeAttributeTimestamps(par, { writable: 1 });
          for (const u of up) mergeAttributeTimestamps(u, { writable: 1 });

          processInstances(
            sessionContext,
            par,
            up,
            keys,
            minInstances,
            maxInstances,
            declaration.defer,
          );
        }
      }
    }
  }

  return processDeclarations(
    sessionContext,
    allDeclareTimestamps,
    allDeclareAttributeTimestamps,
    allDeclareAttributeValues,
  );
}

export async function rpcRequest(
  sessionContext: SessionContext,
  _declarations: Declaration[],
): Promise<{ fault: Fault; rpcId: string; rpc: AcsRequest }> {
  if (sessionContext.rpcRequest != null) {
    return {
      fault: null,
      rpcId: generateRpcId(sessionContext),
      rpc: sessionContext.rpcRequest,
    };
  }

  if (
    !sessionContext.virtualParameters.length &&
    !sessionContext.declarations.length &&
    !_declarations?.length &&
    !sessionContext.provisions.length
  )
    return { fault: null, rpcId: null, rpc: null };

  if (
    sessionContext.declarations.length <=
    sessionContext.virtualParameters.length
  ) {
    const inception = sessionContext.declarations.length;
    const revision = (sessionContext.revisions[inception] || 0) + 1;
    sessionContext.deviceData.timestamps.revision = revision;
    sessionContext.deviceData.attributes.revision = revision;

    let run: typeof runProvisions, provisions;
    if (inception === 0) {
      run = runProvisions;
      provisions = sessionContext.provisions;
    } else {
      run = runVirtualParameters;
      provisions = sessionContext.virtualParameters[inception - 1];
    }

    const {
      fault,
      clear: toClear,
      declare: decs,
      done: done,
      returnValue: ret,
    } = await run(
      sessionContext,
      provisions,
      sessionContext.revisions[inception - 1] || 0,
      sessionContext.revisions[inception],
    );

    if (fault) {
      fault.timestamp = sessionContext.timestamp;
      return { fault: fault, rpcId: null, rpc: null };
    }

    // Enforce max clear timestamp
    for (const c of toClear) {
      if (c[1] > sessionContext.timestamp) c[1] = sessionContext.timestamp;

      if (c[2]) {
        for (const [k, v] of Object.entries(c[2]))
          if (v > sessionContext.timestamp) c[2][k] = sessionContext.timestamp;
      }
    }

    sessionContext.declarations.push(decs);
    sessionContext.provisionsRet[inception] = inception ? ret : done;

    for (const d of decs) {
      // Enforce max timestamp
      if (d.pathGet > sessionContext.timestamp)
        d.pathGet = sessionContext.timestamp;

      if (d.attrGet) {
        for (const [k, v] of Object.entries(d.attrGet)) {
          if (v > sessionContext.timestamp)
            d.attrGet[k] = sessionContext.timestamp;
        }
      }
    }

    if (toClear) {
      for (const c of toClear)
        device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
    }

    return rpcRequest(sessionContext, _declarations);
  }

  if (_declarations?.length) {
    delete sessionContext.syncState;
    if (!sessionContext.declarations[0]) sessionContext.declarations[0] = [];
    sessionContext.declarations[0] =
      sessionContext.declarations[0].concat(_declarations);
    return rpcRequest(sessionContext, null);
  }

  const MAX_RPCCOUNT = +localCache.getConfig(
    sessionContext.cacheSnapshot,
    "cwmp.maxRpcCount",
    {},
    sessionContext.timestamp,
    (e) => configContextCallback(sessionContext, e)
  );

  if (sessionContext.rpcCount >= MAX_RPCCOUNT) {
    return {
      fault: {
        code: "too_many_rpcs",
        message: "Too many RPC requests",
        timestamp: sessionContext.timestamp,
      },
      rpcId: null,
      rpc: null,
    };
  }

  if (sessionContext.revisions.length >= 8) {
    return {
      fault: {
        code: "deeply_nested_vparams",
        message:
          "Virtual parameters are referencing other virtual parameters in a deeply nested manner",
        timestamp: sessionContext.timestamp,
      },
      rpcId: null,
      rpc: null,
    };
  }

  if (sessionContext.cycle >= 255) {
    return {
      fault: {
        code: "too_many_cycles",
        message: "Too many provision cycles",
        timestamp: sessionContext.timestamp,
      },
      rpcId: null,
      rpc: null,
    };
  }

  // Multiply by two because every iteration is two
  // phases: read and update
  const MAX_ITERATIONS =
    +localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.maxCommitIterations",
      {},
      sessionContext.timestamp,
      (e) => configContextCallback(sessionContext, e),
    ) * 2;

  if (sessionContext.iteration >= MAX_ITERATIONS * (sessionContext.cycle + 1)) {
    return {
      fault: {
        code: "too_many_commits",
        message: "Too many commit iterations",
        timestamp: sessionContext.timestamp,
      },
      rpcId: null,
      rpc: null,
    };
  }

  if (
    !(
      sessionContext.syncState &&
      sessionContext.syncState.virtualParameterDeclarations &&
      sessionContext.syncState.virtualParameterDeclarations.length >=
        sessionContext.declarations.length
    )
  ) {
    const inception =
      sessionContext.syncState &&
      sessionContext.syncState.virtualParameterDeclarations
        ? sessionContext.syncState.virtualParameterDeclarations.length
        : 0;

    // Avoid unnecessary increment of iteration when using vparams
    if (inception === sessionContext.declarations.length - 1)
      sessionContext.iteration += 2;

    let vpd = runDeclarations(
      sessionContext,
      sessionContext.declarations[inception],
    );
    const timestamp = sessionContext.timestamp + sessionContext.iteration;

    let toClear;

    const allVirtualParameters = localCache.getVirtualParameters(
      sessionContext.cacheSnapshot,
    );

    vpd = vpd.filter((declaration) => {
      if (Object.keys(allVirtualParameters).length) {
        if (declaration[0].length === 1) {
          // Avoid setting on every inform as "exist" timestamp
          // is not saved in DB
          if (!sessionContext.deviceData.attributes.has(declaration[0])) {
            toClear = device.set(
              sessionContext.deviceData,
              declaration[0],
              timestamp,
              { object: [timestamp, 1], writable: [timestamp, 0] },
              toClear,
            );
          }

          return false;
        } else if (declaration[0].length === 2) {
          if (declaration[0].segments[1] === "*") {
            for (const k of Object.keys(allVirtualParameters)) {
              toClear = device.set(
                sessionContext.deviceData,
                Path.parse(`VirtualParameters.${k}`),
                timestamp,
                {
                  object: [timestamp, 0],
                },
                toClear,
              );
            }
            toClear = device.set(
              sessionContext.deviceData,
              declaration[0],
              timestamp,
              null,
              toClear,
            );
            return false;
          } else if (
            allVirtualParameters[declaration[0].segments[1] as string]
          ) {
            // Avoid setting on every inform as "exist" timestamp
            // is not saved in DB
            if (!sessionContext.deviceData.attributes.has(declaration[0])) {
              toClear = device.set(
                sessionContext.deviceData,
                declaration[0],
                timestamp,
                { object: [timestamp, 0] },
                toClear,
              );
            }

            return true;
          }
        }
      }

      for (const p of sessionContext.deviceData.paths.find(
        declaration[0],
        false,
        true,
      )) {
        if (sessionContext.deviceData.attributes.has(p)) {
          if (!toClear) toClear = [];
          toClear.push([declaration[0], timestamp]);
          break;
        }
      }
      return false;
    });

    if (toClear) {
      for (const c of toClear)
        device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
    }

    sessionContext.syncState.virtualParameterDeclarations[inception] = vpd;
    return rpcRequest(sessionContext, null);
  }

  if (!sessionContext.syncState) return { fault: null, rpcId: null, rpc: null };

  const inception = sessionContext.declarations.length - 1;

  let provisions = generateGetVirtualParameterProvisions(
    sessionContext,
    sessionContext.syncState.virtualParameterDeclarations[inception],
  );

  if (!provisions) {
    sessionContext.rpcRequest = generateGetRpcRequest(sessionContext);
    if (!sessionContext.rpcRequest) {
      // Only check after read stage is complete to minimize reprocessing of
      // declarations especially during initial discovery of data model
      if (sessionContext.deviceData.changes.has("prerequisite")) {
        delete sessionContext.syncState;
        device.clearTrackers(sessionContext.deviceData, "prerequisite");
        return rpcRequest(sessionContext, null);
      }

      let toClear;
      const timestamp = sessionContext.timestamp + sessionContext.iteration + 1;

      // Update tags
      for (const [p, v] of sessionContext.syncState.tags) {
        const c = sessionContext.deviceData.attributes.get(p);
        if (v && !c) {
          toClear = device.set(
            sessionContext.deviceData,
            p,
            timestamp,
            {
              object: [timestamp, 0],
              writable: [timestamp, 1],
              value: [timestamp, [true, "xsd:boolean"]],
            },
            toClear,
          );
        } else if (c && !v) {
          toClear = device.set(
            sessionContext.deviceData,
            p,
            timestamp,
            null,
            toClear,
          );
        }
      }

      // Downloads
      let index;
      for (const instance of sessionContext.syncState.downloadsToCreate) {
        if (index == null) {
          index = 0;
          for (const p of sessionContext.deviceData.paths.find(
            Path.parse("Downloads.*"),
            false,
            true,
          )) {
            if (
              +p.segments[1] > index &&
              sessionContext.deviceData.attributes.has(p)
            )
              index = +p.segments[1];
          }
        }

        ++index;

        toClear = device.set(
          sessionContext.deviceData,
          Path.parse("Downloads"),
          timestamp,
          { object: [timestamp, 1], writable: [timestamp, 1] },
          toClear,
        );

        toClear = device.set(
          sessionContext.deviceData,
          Path.parse(`Downloads.${index}`),
          timestamp,
          { object: [timestamp, 1], writable: [timestamp, 1] },
          toClear,
        );

        const params = {
          FileType: {
            writable: 1,
            value: [instance.FileType || "", "xsd:string"],
          },
          FileName: {
            writable: 1,
            value: [instance.FileName || "", "xsd:string"],
          },
          TargetFileName: {
            writable: 1,
            value: [instance.TargetFileName || "", "xsd:string"],
          },
          Download: {
            writable: 1,
            value: [instance.Download || 0, "xsd:dateTime"],
          },
          LastFileType: { writable: 0, value: ["", "xsd:string"] },
          LastFileName: { writable: 0, value: ["", "xsd:string"] },
          LastTargetFileName: { writable: 0, value: ["", "xsd:string"] },
          LastDownload: { writable: 0, value: [0, "xsd:dateTime"] },
          StartTime: { writable: 0, value: [0, "xsd:dateTime"] },
          CompleteTime: { writable: 0, value: [0, "xsd:dateTime"] },
        };

        for (const [k, v] of Object.entries(params)) {
          toClear = device.set(
            sessionContext.deviceData,
            Path.parse(`Downloads.${index}.${k}`),
            timestamp,
            {
              object: [timestamp, 0],
              writable: [timestamp, v.writable as 0 | 1],
              value: [
                timestamp,
                v.value as [string | number | boolean, string],
              ],
            },
            toClear,
          );
        }

        toClear = device.set(
          sessionContext.deviceData,
          Path.parse(`Downloads.${index}.*`),
          timestamp,
          null,
          toClear,
        );
      }

      sessionContext.syncState.downloadsToCreate.clear();

      for (const instance of sessionContext.syncState.downloadsToDelete) {
        toClear = device.set(
          sessionContext.deviceData,
          instance,
          timestamp,
          null,
          toClear,
        );
        for (const p of sessionContext.syncState.downloadsValues.keys()) {
          if (p.segments[1] === instance.segments[1])
            sessionContext.syncState.downloadsValues.delete(p);
        }
      }

      sessionContext.syncState.downloadsToDelete.clear();

      for (const [p, v] of sessionContext.syncState.downloadsValues) {
        const attrs = sessionContext.deviceData.attributes.get(p);
        if (attrs) {
          if (attrs.writable?.[1] && attrs.value) {
            const val = device.sanitizeParameterValue([v, attrs.value[1][1]]);
            if (val[0] !== attrs.value[1][0]) {
              toClear = device.set(
                sessionContext.deviceData,
                p,
                timestamp,
                { value: [timestamp, val] },
                toClear,
              );
            }
          }
        }
      }

      if (toClear || sessionContext.deviceData.changes.has("prerequisite")) {
        if (toClear) {
          for (const c of toClear)
            device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
        }
        return rpcRequest(sessionContext, null);
      }

      provisions = generateSetVirtualParameterProvisions(
        sessionContext,
        sessionContext.syncState.virtualParameterDeclarations[inception],
      );
      if (!provisions)
        sessionContext.rpcRequest = generateSetRpcRequest(sessionContext);
    }
  }

  if (provisions) {
    sessionContext.virtualParameters.push(provisions);
    sessionContext.revisions.push(sessionContext.revisions[inception]);
    return rpcRequest(sessionContext, null);
  }

  if (sessionContext.rpcRequest) {
    return {
      fault: null,
      rpcId: generateRpcId(sessionContext),
      rpc: sessionContext.rpcRequest,
    };
  }

  ++sessionContext.revisions[inception];
  sessionContext.declarations.pop();
  sessionContext.syncState.virtualParameterDeclarations.pop();

  const ret = sessionContext.provisionsRet.splice(inception)[0];
  if (!ret) return rpcRequest(sessionContext, null);

  sessionContext.revisions.pop();
  const rev =
    sessionContext.revisions[sessionContext.revisions.length - 1] || 0;
  sessionContext.deviceData.timestamps.collapse(rev + 1);
  sessionContext.deviceData.attributes.collapse(rev + 1);
  sessionContext.deviceData.timestamps.revision = rev + 1;
  sessionContext.deviceData.attributes.revision = rev + 1;

  for (const k of Object.keys(sessionContext.extensionsCache)) {
    if (rev < Number(k.split(":", 1)[0]))
      delete sessionContext.extensionsCache[k];
  }

  const vparams = sessionContext.virtualParameters.pop();
  if (!vparams) return { fault: null, rpcId: null, rpc: null };

  const timestamp = sessionContext.timestamp + sessionContext.iteration;
  let toClear;
  for (const [i, vpu] of ret.entries()) {
    for (const [k, v] of Object.entries(vpu))
      vpu[k] = [timestamp + (vparams[i][2][k] != null ? 1 : 0), v];

    toClear = device.set(
      sessionContext.deviceData,
      Path.parse(`VirtualParameters.${vparams[i][0]}`),
      timestamp,
      vpu,
      toClear,
    );
  }

  if (toClear) {
    for (const c of toClear)
      device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
  }

  return rpcRequest(sessionContext, null);
}

function generateGetRpcRequest(
  sessionContext: SessionContext,
): GetParameterNames | GetParameterValues | GetParameterAttributes {
  const syncState = sessionContext.syncState;
  if (!syncState) return null;

  for (const path of syncState.refreshAttributes.exist) {
    let found = false;
    for (const p of sessionContext.deviceData.paths.find(
      path,
      false,
      true,
      99,
    )) {
      if (
        syncState.refreshAttributes.value.has(p) ||
        syncState.refreshAttributes.object.has(p) ||
        syncState.refreshAttributes.writable.has(p) ||
        syncState.refreshAttributes.notification.has(p) ||
        syncState.refreshAttributes.accessList.has(p) ||
        syncState.gpn.has(p)
      ) {
        found = true;
        break;
      }
    }

    if (!found) {
      const p = sessionContext.deviceData.paths.add(path.slice(0, -1));
      syncState.gpn.add(p);
      const f = 1 << p.length;
      syncState.gpnPatterns.set(p, f | syncState.gpnPatterns.get(p));
    }
  }
  syncState.refreshAttributes.exist.clear();

  for (const path of syncState.refreshAttributes.object) {
    let found = false;
    for (const p of sessionContext.deviceData.paths.find(
      path,
      false,
      true,
      99,
    )) {
      if (
        syncState.refreshAttributes.value.has(p) ||
        (p.length > path.length &&
          (syncState.refreshAttributes.object.has(p) ||
            syncState.refreshAttributes.writable.has(p) ||
            syncState.refreshAttributes.notification.has(p) ||
            syncState.refreshAttributes.accessList.has(p)))
      ) {
        found = true;
        break;
      }
    }

    if (!found) {
      const p = sessionContext.deviceData.paths.add(path.slice(0, -1));
      syncState.gpn.add(p);
      const f = 1 << p.length;
      syncState.gpnPatterns.set(p, f | syncState.gpnPatterns.get(p));
    }
  }
  syncState.refreshAttributes.object.clear();

  for (const path of syncState.refreshAttributes.writable) {
    const p = sessionContext.deviceData.paths.add(path.slice(0, -1));
    syncState.gpn.add(p);
    const f = 1 << p.length;
    syncState.gpnPatterns.set(p, f | syncState.gpnPatterns.get(p));
  }
  syncState.refreshAttributes.writable.clear();

  if (syncState.gpn.size) {
    const GPN_NEXT_LEVEL = localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.gpnNextLevel",
      {},
      sessionContext.timestamp,
      (e) => configContextCallback(sessionContext, e),
    ) as number;

    const paths = Array.from(syncState.gpn.keys()).sort(
      (a, b) => b.length - a.length,
    );
    let path = paths.pop();

    // Skip root GPN workaround
    if (path && !path.length) {
      const SKIP_ROOT_GPN = !!localCache.getConfig(
        sessionContext.cacheSnapshot,
        "cwmp.skipRootGpn",
        {},
        sessionContext.timestamp,
        (e) => configContextCallback(sessionContext, e),
      );

      if (SKIP_ROOT_GPN) path = paths.pop();
    }

    while (
      path &&
      path.length &&
      !sessionContext.deviceData.attributes.has(path)
    ) {
      syncState.gpn.delete(path);
      path = paths.pop();
    }

    if (path) {
      let nextLevel: boolean;
      let est = 0;
      if (path.length >= GPN_NEXT_LEVEL) {
        const patterns: [Path, number][] = [[path, 0]];
        for (const p of sessionContext.deviceData.paths.find(
          path,
          true,
          false,
          99,
        )) {
          const v = syncState.gpnPatterns.get(p);
          if (v) patterns.push([p, (v >> path.length) << path.length]);
        }
        est = estimateGpnCount(patterns);
      }

      if (est < Math.pow(2, Math.max(0, 8 - path.length))) {
        nextLevel = true;
        syncState.gpn.delete(path);
      } else {
        nextLevel = false;
        for (const p of sessionContext.deviceData.paths.find(
          path,
          false,
          true,
          99,
        ))
          syncState.gpn.delete(p);
      }

      return {
        name: "GetParameterNames",
        parameterPath: path.length ? path.toString() + "." : "",
        nextLevel: nextLevel,
      };
    }
  }

  if (syncState.refreshAttributes.value.size) {
    const GPV_BATCH_SIZE = localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.gpvBatchSize",
      {},
      sessionContext.timestamp,
      (e) => configContextCallback(sessionContext, e),
    ) as number;

    const parameterNames: string[] = [];
    for (const path of syncState.refreshAttributes.value) {
      syncState.refreshAttributes.value.delete(path);
      // Need to check in case param is deleted or changed to object
      const attrs = sessionContext.deviceData.attributes.get(path);
      if (attrs?.object?.[1] === 0) {
        parameterNames.push(path.toString());
        if (parameterNames.length >= GPV_BATCH_SIZE) break;
      }
    }

    if (parameterNames.length) {
      return {
        name: "GetParameterValues",
        parameterNames: parameterNames,
      };
    }
  }

  if (
    syncState.refreshAttributes.notification.size ||
    syncState.refreshAttributes.accessList.size
  ) {
    const GPV_BATCH_SIZE = localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.gpvBatchSize",
      {},
      sessionContext.timestamp,
      (e) => configContextCallback(sessionContext, e),
    ) as number;

    const parameterNames: string[] = [];
    for (const path of syncState.refreshAttributes.notification) {
      syncState.refreshAttributes.notification.delete(path);
      syncState.refreshAttributes.accessList.delete(path);
      // Need to check in case param is deleted
      const attrs = sessionContext.deviceData.attributes.get(path);
      if (attrs) {
        parameterNames.push(path.toString());
        if (parameterNames.length >= GPV_BATCH_SIZE) break;
      }
    }

    if (parameterNames.length < GPV_BATCH_SIZE) {
      for (const path of syncState.refreshAttributes.accessList) {
        syncState.refreshAttributes.accessList.delete(path);
        const attrs = sessionContext.deviceData.attributes.get(path);
        if (attrs) {
          parameterNames.push(path.toString());
          if (parameterNames.length >= GPV_BATCH_SIZE) break;
        }
      }
    }

    if (parameterNames.length) {
      return {
        name: "GetParameterAttributes",
        parameterNames: parameterNames,
      };
    }
  }

  return null;
}

function compareAccessLists(list1: string[], list2: string[]): boolean {
  if (list1.length !== list2.length) return false;
  for (const [i, v] of list1.entries()) if (v !== list2[i]) return false;
  return true;
}

function generateSetRpcRequest(
  sessionContext: SessionContext,
): (
  | SetParameterValues
  | SetParameterAttributes
  | AddObject
  | DeleteObject
  | FactoryReset
  | Reboot
  | Download
) & { next?: string } {
  const syncState = sessionContext.syncState;
  if (!syncState) return null;

  const deviceData = sessionContext.deviceData;

  const SKIP_WRITABLE_CHECK = !!localCache.getConfig(
    sessionContext.cacheSnapshot,
    "cwmp.skipWritableCheck",
    {},
    sessionContext.timestamp,
    (e) => configContextCallback(sessionContext, e),
  );

  const canWrite = (attrs: Attributes): boolean =>
    SKIP_WRITABLE_CHECK || (attrs.writable && !!attrs.writable[1]);

  // Delete instance
  for (const instances of syncState.instancesToDelete.values()) {
    for (const instance of instances) {
      const attrs = sessionContext.deviceData.attributes.get(instance);
      if (attrs && canWrite(attrs)) {
        instances.delete(instance);
        return {
          name: "DeleteObject",
          objectName: instance.toString() + ".",
        };
      }
    }
  }

  // Create instance
  for (const [param, instances] of syncState.instancesToCreate) {
    const attrs = sessionContext.deviceData.attributes.get(param);
    if (attrs && canWrite(attrs)) {
      const instance = instances.values().next().value;
      if (instance) {
        instances.delete(instance);
        return {
          name: "AddObject",
          objectName: param.toString() + ".",
          instanceValues: instance,
          next: "getInstanceKeys",
        };
      }
    }
  }

  // Set values
  const GPV_BATCH_SIZE = localCache.getConfig(
    sessionContext.cacheSnapshot,
    "cwmp.gpvBatchSize",
    {},
    sessionContext.timestamp,
    (e) => configContextCallback(sessionContext, e),
  ) as number;

  const DATETIME_MILLISECONDS = !!localCache.getConfig(
    sessionContext.cacheSnapshot,
    "cwmp.datetimeMilliseconds",
    {},
    sessionContext.timestamp,
    (e) => configContextCallback(sessionContext, e),
  );

  const BOOLEAN_LITERAL = !!localCache.getConfig(
    sessionContext.cacheSnapshot,
    "cwmp.booleanLiteral",
    {},
    sessionContext.timestamp,
    (e) => configContextCallback(sessionContext, e),
  );

  const parameterValues: [string, string | number | boolean, string][] = [];
  for (const [k, v] of syncState.spv) {
    syncState.spv.delete(k);
    const attrs = sessionContext.deviceData.attributes.get(k);
    const curVal = attrs.value?.[1];
    if (curVal && canWrite(attrs)) {
      const val = v.slice() as [string | number | boolean, string];
      if (!val[1]) val[1] = curVal[1];
      device.sanitizeParameterValue(val);

      // Strip milliseconds
      if (
        val[1] === "xsd:dateTime" &&
        !DATETIME_MILLISECONDS &&
        typeof val[0] === "number"
      )
        val[0] -= val[0] % 1000;

      if (val[0] !== curVal[0] || val[1] !== curVal[1])
        parameterValues.push([k.toString(), val[0], val[1]]);

      if (parameterValues.length >= GPV_BATCH_SIZE) break;
    }
  }

  if (parameterValues.length) {
    return {
      name: "SetParameterValues",
      parameterList: parameterValues,
      DATETIME_MILLISECONDS: DATETIME_MILLISECONDS,
      BOOLEAN_LITERAL: BOOLEAN_LITERAL,
    };
  }

  // Set attributes
  const parameterAttributes: [string, number, string[]][] = [];
  for (const [k, v] of syncState.spa) {
    syncState.spa.delete(k);
    const attrs = sessionContext.deviceData.attributes.get(k);

    if (
      v.notification != null &&
      (!attrs.notification || v.notification === attrs.notification[1])
    )
      v.notification = null;

    if (
      v.accessList != null &&
      (!attrs.accessList ||
        compareAccessLists(v.accessList, attrs.accessList[1]))
    )
      v.accessList = null;

    if (v.notification != null || v.accessList != null)
      parameterAttributes.push([k.toString(), v.notification, v.accessList]);

    if (parameterAttributes.length >= GPV_BATCH_SIZE) break;
  }

  if (parameterAttributes.length) {
    return {
      name: "SetParameterAttributes",
      parameterList: parameterAttributes,
    };
  }

  // Downloads
  for (const [p, t] of syncState.downloadsDownload) {
    if (!(t > 0 && t <= sessionContext.timestamp)) continue;
    const attrs = deviceData.attributes.get(p);
    const t2 = attrs?.value?.[1]?.[0] as number;
    if (!(t <= t2)) {
      const fileTypeAttrs = deviceData.attributes.get(
        deviceData.paths.get(p.slice(0, -1).concat(Path.parse("FileType"))),
      );
      const fileNameAttrs = deviceData.attributes.get(
        deviceData.paths.get(p.slice(0, -1).concat(Path.parse("FileName"))),
      );
      const targetFileNameAttrs = deviceData.attributes.get(
        deviceData.paths.get(
          p.slice(0, -1).concat(Path.parse("TargetFileName")),
        ),
      );

      return {
        name: "Download",
        commandKey: generateRpcId(sessionContext),
        instance: p.segments[1] as string,
        fileType: fileTypeAttrs?.value?.[1][0] as string,
        fileName: fileNameAttrs?.value?.[1][0] as string,
        targetFileName: targetFileNameAttrs?.value?.[1][0] as string,
      };
    }
  }

  // Reboot
  if (syncState.reboot > 0 && syncState.reboot <= sessionContext.timestamp) {
    const p = sessionContext.deviceData.paths.get(Path.parse("Reboot"));
    const attrs = p ? sessionContext.deviceData.attributes.get(p) : null;
    const t = attrs?.value?.[1][0] as number;
    if (!(t >= syncState.reboot)) {
      delete syncState.reboot;
      return { name: "Reboot" };
    }
  }

  // Factory reset
  if (
    syncState.factoryReset > 0 &&
    syncState.factoryReset <= sessionContext.timestamp
  ) {
    const p = sessionContext.deviceData.paths.get(Path.parse("FactoryReset"));
    const attrs = p ? sessionContext.deviceData.attributes.get(p) : null;
    const t = attrs?.value?.[1][0] as number;
    if (!(t >= syncState.factoryReset)) {
      delete syncState.factoryReset;
      return { name: "FactoryReset" };
    }
  }

  return null;
}

function generateGetVirtualParameterProvisions(
  sessionContext: SessionContext,
  virtualParameterDeclarations: VirtualParameterDeclaration[],
): [
  string,
  AttributeTimestamps,
  AttributeValues,
  AttributeTimestamps,
  AttributeValues,
][] {
  let provisions;
  if (virtualParameterDeclarations) {
    for (const declaration of virtualParameterDeclarations) {
      if (declaration[1]) {
        const currentTimestamps = {};
        const currentValues = {};
        const dec = {};
        const attrs =
          sessionContext.deviceData.attributes.get(declaration[0]) || {};

        for (const [k, v] of Object.entries(declaration[1])) {
          if (k !== "value" && k !== "writable") continue;
          if (!attrs[k] || v > attrs[k][0]) dec[k] = v;
        }

        for (const [k, v] of Object.entries(attrs)) {
          currentTimestamps[k] = v[0];
          currentValues[k] = v[1];
        }

        if (Object.keys(dec).length) {
          if (!provisions) provisions = [];
          provisions.push([
            declaration[0].segments[1],
            dec,
            {},
            currentTimestamps,
            currentValues,
          ]);
        }
      }
    }
  }
  return provisions;
}

function generateSetVirtualParameterProvisions(
  sessionContext: SessionContext,
  virtualParameterDeclarations: VirtualParameterDeclaration[],
): [
  string,
  AttributeTimestamps,
  AttributeValues,
  AttributeTimestamps,
  AttributeValues,
][] {
  let provisions;
  if (virtualParameterDeclarations) {
    for (const declaration of virtualParameterDeclarations) {
      if (declaration[2]?.value != null) {
        const attrs = sessionContext.deviceData.attributes.get(declaration[0]);
        if (
          attrs &&
          attrs.writable &&
          attrs.writable[1] &&
          attrs.value &&
          attrs.value[1] != null
        ) {
          const val = declaration[2].value.slice() as [
            string | number | boolean,
            string,
          ];
          if (val[1] == null) val[1] = attrs.value[1][1];

          device.sanitizeParameterValue(val);

          if (val[0] !== attrs.value[1][0] || val[1] !== attrs.value[1][1]) {
            if (!provisions) provisions = [];
            const currentTimestamps = {};
            const currentValues = {};
            for (const [k, v] of Object.entries(attrs)) {
              currentTimestamps[k] = v[0];
              currentValues[k] = v[1];
            }

            provisions.push([
              declaration[0].segments[1],
              {},
              { value: val },
              currentTimestamps,
              currentValues,
            ]);
          }
        }
      }
    }
  }

  return provisions;
}

function processDeclarations(
  sessionContext: SessionContext,
  allDeclareTimestamps,
  allDeclareAttributeTimestamps: Map<Path, AttributeTimestamps>,
  allDeclareAttributeValues: Map<Path, AttributeValues>,
): VirtualParameterDeclaration[] {
  const deviceData = sessionContext.deviceData;
  const syncState = sessionContext.syncState;

  const root = sessionContext.deviceData.paths.add(Path.parse(""));
  const paths = deviceData.paths.find(root, false, true, 99);
  paths.sort((a, b): number =>
    a.wildcard === b.wildcard ? a.length - b.length : a.wildcard - b.wildcard,
  );

  const virtualParameterDeclarations = [] as VirtualParameterDeclaration[];

  function func(
    leafParam: Path,
    leafIsObject: number,
    leafTimestamp: number,
    _paths: Path[],
  ): void {
    const currentPath = _paths[0];
    const children = new Map<string, Path[]>();
    let declareTimestamp = 0;
    let declareAttributeTimestamps;
    let declareAttributeValues;

    let currentTimestamp = 0;
    let currentAttributes;
    if (currentPath.wildcard === 0)
      currentAttributes = deviceData.attributes.get(currentPath);

    for (const path of _paths) {
      if (path.length > currentPath.length) {
        const fragment = path.segments[currentPath.length] as string;
        let child = children.get(fragment);
        if (!child) {
          if (path.length > currentPath.length + 1) {
            // This is to ensure we don't descend more than one step at a time
            const p = path.slice(0, currentPath.length + 1);
            child = [p];
          } else {
            child = [];
          }
          children.set(fragment, child);
        }
        child.push(path);
        continue;
      }

      currentTimestamp = Math.max(
        currentTimestamp,
        deviceData.timestamps.get(path) || 0,
      );
      declareTimestamp = Math.max(
        declareTimestamp,
        allDeclareTimestamps.get(path) || 0,
      );

      if (currentPath.wildcard === 0) {
        const attrs = allDeclareAttributeTimestamps.get(path);
        if (attrs) {
          if (declareAttributeTimestamps) {
            declareAttributeTimestamps = Object.assign(
              {},
              declareAttributeTimestamps,
            );
            for (const [k, v] of Object.entries(attrs)) {
              declareAttributeTimestamps[k] = Math.max(
                v,
                declareAttributeTimestamps[k] || 0,
              );
            }
          } else {
            declareAttributeTimestamps = attrs;
          }
        }

        declareAttributeValues =
          allDeclareAttributeValues.get(path) || declareAttributeValues;
      }
    }

    if (currentAttributes) {
      leafParam = currentPath;
      leafIsObject = currentAttributes.object?.[1];
      // Possible V8 bug causes null === 0
      if (leafIsObject != null && leafIsObject === 0)
        leafTimestamp = Math.max(leafTimestamp, currentAttributes.object[0]);
    } else {
      leafTimestamp = Math.max(leafTimestamp, currentTimestamp);
    }

    switch (
      currentPath.segments[0] !== "*"
        ? currentPath.segments[0]
        : leafParam.segments[0]
    ) {
      case "Reboot":
        if (currentPath.length === 1) {
          if (declareAttributeValues?.value)
            syncState.reboot = +new Date(declareAttributeValues.value[0]);
        }
        break;
      case "FactoryReset":
        if (currentPath.length === 1) {
          if (declareAttributeValues?.value)
            syncState.factoryReset = +new Date(declareAttributeValues.value[0]);
        }
        break;
      case "Tags":
        if (
          currentPath.length === 2 &&
          currentPath.wildcard === 0 &&
          declareAttributeValues &&
          declareAttributeValues.value
        ) {
          syncState.tags.set(
            currentPath,
            device.sanitizeParameterValue([
              declareAttributeValues.value[0],
              "xsd:boolean",
            ])[0] as boolean,
          );
        }

        break;
      case "Events":
      case "DeviceID":
        // Do nothing
        break;
      case "Downloads":
        if (
          currentPath.length === 3 &&
          currentPath.wildcard === 0 &&
          declareAttributeValues &&
          declareAttributeValues.value
        ) {
          if (currentPath.segments[2] === "Download") {
            syncState.downloadsDownload.set(
              currentPath,
              declareAttributeValues.value[0],
            );
          } else {
            syncState.downloadsValues.set(
              currentPath,
              declareAttributeValues.value[0],
            );
          }
        }
        break;
      case "VirtualParameters":
        if (currentPath.length <= 2) {
          let d;
          if (!(declareTimestamp <= currentTimestamp)) d = [currentPath];

          if (currentPath.wildcard === 0) {
            if (declareAttributeTimestamps) {
              for (const [attrName, attrTimestamp] of Object.entries(
                declareAttributeTimestamps,
              )) {
                if (
                  !(
                    currentAttributes &&
                    currentAttributes[attrName] &&
                    attrTimestamp <= currentAttributes[attrName][0]
                  )
                ) {
                  if (!d) d = [currentPath];
                  if (!d[1]) d[1] = {};
                  d[1][attrName] = attrTimestamp;
                }
              }
            }

            if (declareAttributeValues) {
              if (!d) d = [currentPath];
              d[2] = declareAttributeValues;
            }
          }

          if (d) virtualParameterDeclarations.push(d);
        }
        break;
      default:
        if (
          declareTimestamp > currentTimestamp &&
          declareTimestamp > leafTimestamp
        ) {
          if (currentPath === leafParam) {
            syncState.refreshAttributes.exist.add(leafParam);
          } else if (leafIsObject) {
            syncState.gpn.add(leafParam);
            if (leafTimestamp > 0) {
              const f = 1 << leafParam.length;
              syncState.gpnPatterns.set(
                leafParam,
                f | syncState.gpnPatterns.get(leafParam),
              );
            } else {
              const f =
                ((1 << currentPath.length) - 1) ^ ((1 << leafParam.length) - 1);
              syncState.gpnPatterns.set(
                currentPath,
                f | syncState.gpnPatterns.get(currentPath),
              );
            }
          } else {
            syncState.refreshAttributes.object.add(leafParam);
            if (leafIsObject == null) {
              const f =
                ((1 << syncState.gpnPatterns.size) - 1) ^
                ((1 << leafParam.length) - 1);
              syncState.gpnPatterns.set(
                currentPath,
                f | syncState.gpnPatterns.get(currentPath),
              );
            }
          }
        }

        if (currentAttributes) {
          if (declareAttributeTimestamps) {
            for (const [attrName, attrTimestamp] of Object.entries(
              declareAttributeTimestamps,
            )) {
              if (
                !(
                  currentAttributes[attrName] &&
                  attrTimestamp <= currentAttributes[attrName][0]
                )
              ) {
                if (attrName === "value") {
                  if (
                    !(
                      currentAttributes.object &&
                      currentAttributes.object[1] != null
                    )
                  )
                    syncState.refreshAttributes.object.add(currentPath);
                  else if (currentAttributes.object[1] === 0)
                    syncState.refreshAttributes.value.add(currentPath);
                } else if (attrName in syncState.refreshAttributes) {
                  syncState.refreshAttributes[attrName].add(currentPath);
                }
              }
            }
          }
          if (declareAttributeValues) {
            if (declareAttributeValues.value != null)
              syncState.spv.set(currentPath, declareAttributeValues.value);

            if (declareAttributeValues.notification != null) {
              const spa = syncState.spa.get(currentPath);
              if (spa) {
                spa.notification = declareAttributeValues.notification;
              } else {
                syncState.spa.set(currentPath, {
                  notification: declareAttributeValues.notification,
                  accessList: null,
                });
              }
            }

            if (declareAttributeValues.accessList != null) {
              const spa = syncState.spa.get(currentPath);
              if (spa) {
                spa.accessList = declareAttributeValues.accessList;
              } else {
                syncState.spa.set(currentPath, {
                  notification: null,
                  accessList: declareAttributeValues.accessList,
                });
              }
            }
          }
        }
    }

    for (let [fragment, child] of children) {
      // This fine expression avoids duplicate visits, don't ask.
      if (
        ((currentPath.wildcard ^ child[0].wildcard) &
          ((1 << currentPath.length) - 1)) >>
          leafParam.length ===
        0
      ) {
        if (fragment !== "*") {
          const wildcardChild = children.get("*");
          if (wildcardChild) child = child.concat(wildcardChild);
        }
        func(leafParam, leafIsObject, leafTimestamp, child);
      }
    }
  }

  if (
    allDeclareTimestamps.size ||
    allDeclareAttributeTimestamps.size ||
    allDeclareAttributeValues.size
  )
    func(root, 1, 0, paths);

  return virtualParameterDeclarations;
}

function processInstances(
  sessionContext: SessionContext,
  parent: Path,
  parameters: Path[],
  keys: Record<string, string>,
  minInstances: number,
  maxInstances: number,
  defer: boolean,
): void {
  parent = sessionContext.deviceData.paths.add(parent);
  let instancesToCreate: InstanceSet, instancesToDelete: Set<Path>;
  if (parent.segments[0] === "Downloads") {
    if (parent.length !== 1) return;
    instancesToDelete = sessionContext.syncState.downloadsToDelete;
    instancesToCreate = sessionContext.syncState.downloadsToCreate;
  } else {
    instancesToDelete = sessionContext.syncState.instancesToDelete.get(parent);
    if (instancesToDelete == null) {
      instancesToDelete = new Set();
      sessionContext.syncState.instancesToDelete.set(parent, instancesToDelete);
    }

    instancesToCreate = sessionContext.syncState.instancesToCreate.get(parent);
    if (instancesToCreate == null) {
      instancesToCreate = new InstanceSet();
      sessionContext.syncState.instancesToCreate.set(parent, instancesToCreate);
    }
  }

  if (defer && instancesToCreate.size === 0 && instancesToDelete.size === 0)
    return;

  let counter = 0;
  for (const p of parameters) {
    ++counter;
    if (counter > maxInstances) instancesToDelete.add(p);
    else if (counter <= minInstances) instancesToDelete.delete(p);
  }

  // Key is null if deleting a particular instance rather than use alias
  if (!keys) return;

  for (const inst of instancesToCreate.superset(keys)) {
    ++counter;
    if (counter > maxInstances) instancesToCreate.delete(inst);
  }

  for (const inst of instancesToCreate.subset(keys)) {
    ++counter;
    if (counter <= minInstances) {
      instancesToCreate.delete(inst);
      instancesToCreate.add(JSON.parse(JSON.stringify(keys)));
    }
  }

  while (counter < minInstances) {
    ++counter;
    instancesToCreate.add(JSON.parse(JSON.stringify(keys)));
  }
}

export async function rpcResponse(
  sessionContext: SessionContext,
  id: string,
  _rpcRes: CpeResponse,
): Promise<Fault> {
  function invalidResponse(message: string): Fault {
    return {
      code: "invalid_response",
      message: message,
    };
  }

  if (id !== generateRpcId(sessionContext))
    return invalidResponse("Request ID not recognized");

  ++sessionContext.rpcCount;

  const rpcRes = _rpcRes;
  const rpcReq: typeof sessionContext.rpcRequest & { next?: string } =
    sessionContext.rpcRequest;

  if (!rpcReq.next) {
    sessionContext.rpcRequest = null;
  } else if (rpcReq.next === "getInstanceKeys") {
    const parameterNames = [];
    const instanceValues: Record<string, string> = {};
    const req = rpcReq as AddObject;
    const res = rpcRes as AddObjectResponse;
    for (const [k, v] of Object.entries(req.instanceValues)) {
      const n = `${req.objectName}${res.instanceNumber}.${k}`;
      parameterNames.push(n);
      instanceValues[n] = v;
    }

    if (!parameterNames.length) {
      sessionContext.rpcRequest = null;
    } else {
      const r: GetParameterValues & {
        next: "setInstanceKeys";
        instanceValues: Record<string, string>;
      } = {
        name: "GetParameterValues",
        parameterNames: parameterNames,
        next: "setInstanceKeys",
        instanceValues: instanceValues,
      };
      sessionContext.rpcRequest = r;
    }
  } else if (rpcReq.next === "setInstanceKeys") {
    const req = rpcReq as GetParameterValues & {
      instanceValues: Record<string, string>;
    };
    const res = rpcRes as GetParameterValuesResponse;
    const parameterList: [string, string | number | boolean, string][] = [];
    for (const p of res.parameterList) {
      if (p[1] !== req.instanceValues[p[0].toString()]) {
        const v = device.sanitizeParameterValue([
          req.instanceValues[p[0].toString()],
          p[2] as string,
        ]);
        parameterList.push([p[0].toString(), v[0], v[1]]);
      }
    }

    if (!parameterList.length) {
      sessionContext.rpcRequest = null;
    } else {
      const DATETIME_MILLISECONDS = !!localCache.getConfig(
        sessionContext.cacheSnapshot,
        "cwmp.datetimeMilliseconds",
        {},
        sessionContext.timestamp,
        (e) => configContextCallback(sessionContext, e),
      );

      const BOOLEAN_LITERAL = !!localCache.getConfig(
        sessionContext.cacheSnapshot,
        "cwmp.booleanLiteral",
        {},
        sessionContext.timestamp,
        (e) => configContextCallback(sessionContext, e),
      );

      const r: SetParameterValues = {
        name: "SetParameterValues",
        parameterList: parameterList,
        DATETIME_MILLISECONDS: DATETIME_MILLISECONDS,
        BOOLEAN_LITERAL: BOOLEAN_LITERAL,
      };
      sessionContext.rpcRequest = r;
    }
  }

  const timestamp = sessionContext.timestamp + sessionContext.iteration;

  const revision =
    (sessionContext.revisions[sessionContext.revisions.length - 1] || 0) + 1;
  sessionContext.deviceData.timestamps.revision = revision;
  sessionContext.deviceData.attributes.revision = revision;

  let toClear: Clear[];

  if (rpcRes.name === "GetParameterValuesResponse") {
    if (rpcReq.name !== "GetParameterValues")
      return invalidResponse("Response name does not match request name");

    const requested = new Set(rpcReq.parameterNames);

    for (const [path, value, type] of rpcRes.parameterList) {
      if (!requested.delete(path.toString())) {
        logger.accessWarn({
          sessionContext: sessionContext,
          message: "Unexpected parameter in response",
          parameter: path.toString(),
        });
        continue;
      }
      toClear = device.set(
        sessionContext.deviceData,
        path,
        timestamp,
        {
          object: [timestamp, 0],
          value: [timestamp, [value, type]],
        },
        toClear,
      );
    }

    if (requested.size) {
      for (const p of requested) {
        logger.accessWarn({
          sessionContext: sessionContext,
          message: "Missing parameter in response",
          parameter: p,
        });
        toClear = device.set(
          sessionContext.deviceData,
          Path.parse(p),
          timestamp,
          {
            object: [timestamp, 0],
            value: [timestamp, ["", "xsd:string"]],
          },
          toClear,
        );
      }
    }
  } else if (rpcRes.name === "GetParameterAttributesResponse") {
    if (rpcReq.name !== "GetParameterAttributes")
      throw new Error("Response name does not match request name");

    const requested = new Set(rpcReq.parameterNames);

    for (const [path, notification, accessList] of rpcRes.parameterList) {
      if (!requested.delete(path.toString())) {
        logger.accessWarn({
          sessionContext: sessionContext,
          message: "Unexpected parameter in response",
          parameter: path.toString(),
        });
        continue;
      }
      toClear = device.set(
        sessionContext.deviceData,
        path,
        timestamp,
        {
          notification: [timestamp, notification],
          accessList: [timestamp, accessList],
        },
        toClear,
      );
    }

    if (requested.size) {
      for (const p of requested) {
        logger.accessWarn({
          sessionContext: sessionContext,
          message: "Missing parameter in response",
          parameter: p,
        });
        toClear = device.set(
          sessionContext.deviceData,
          Path.parse(p),
          timestamp,
          {
            notification: [timestamp, 0],
            accessList: [timestamp, []],
          },
          toClear,
        );
      }
    }
  } else if (rpcRes.name === "GetParameterNamesResponse") {
    if (rpcReq.name !== "GetParameterNames")
      return invalidResponse("Response name does not match request name");

    let root: Path;
    if (rpcReq.parameterPath.endsWith("."))
      root = Path.parse(rpcReq.parameterPath.slice(0, -1));
    else root = Path.parse(rpcReq.parameterPath);

    // Sort to help fill in missing params
    rpcRes.parameterList.sort((a, b) => {
      const pa = a[0];
      const pb = b[0];
      const l = Math.min(pa.length, pb.length);
      for (let i = 0; i < l; ++i) {
        if (pa.segments[i] > pb.segments[i]) return 1;
        if (pa.segments[i] < pb.segments[i]) return -1;
      }
      return pa.length - pb.length;
    });

    // Fill in missing unreported parent params
    for (let idx = 1; idx < rpcRes.parameterList.length; ++idx) {
      const prev = rpcRes.parameterList[idx - 1][0];
      const cur = rpcRes.parameterList[idx][0];
      let offset = 0;
      for (let i = cur.length - 2; i >= 0; --i) {
        if (i < prev.length && prev.segments[i] === cur.segments[i]) {
          // Set object to true in case CPE didn't indicate that it's an object
          if (i === prev.length - 1) rpcRes.parameterList[idx - 1][1] = true;
          break;
        }
        // TODO consider showing a warning
        rpcRes.parameterList.splice(idx, 0, [cur.slice(0, i + 1), true, true]);
        ++offset;
      }
      idx += offset;
    }

    if (!root.length) {
      for (const n of [
        "DeviceID",
        "Events",
        "Tags",
        "Reboot",
        "FactoryReset",
        "VirtualParameters",
        "Downloads",
      ]) {
        const p = sessionContext.deviceData.paths.get(Path.parse(n));
        if (p && sessionContext.deviceData.attributes.has(p))
          sessionContext.deviceData.timestamps.set(p, timestamp);
      }
    }

    const wildcardPath = Path.parse("*");
    const wildcardParams: Path[] = [root.concat(wildcardPath)];

    for (const [path, object, writable] of rpcRes.parameterList) {
      if (Ignore(path.toString())) continue;
      if (
        !path.toString().startsWith(rpcReq.parameterPath) &&
        !(`${path.toString()}.` === rpcReq.parameterPath && !rpcReq.nextLevel)
      ) {
        logger.accessWarn({
          sessionContext: sessionContext,
          message: "Unexpected parameter in response",
          parameter: path.toString(),
        });
        continue;
      }
      if (object && !rpcReq.nextLevel)
        wildcardParams.push(path.concat(wildcardPath));

      toClear = device.set(
        sessionContext.deviceData,
        path,
        timestamp,
        {
          object: [timestamp, object ? 1 : 0],
          writable: [timestamp, writable ? 1 : 0],
        },
        toClear,
      );
    }

    for (const path of wildcardParams) {
      toClear = device.set(
        sessionContext.deviceData,
        path,
        timestamp,
        null,
        toClear,
      );
    }
  } else if (rpcRes.name === "SetParameterValuesResponse") {
    if (rpcReq.name !== "SetParameterValues")
      return invalidResponse("Response name does not match request name");

    for (const p of rpcReq.parameterList) {
      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(p[0]),
        timestamp + 1,
        {
          object: [timestamp + 1, 0],
          value: [
            timestamp + 1,
            p.slice(1) as [string | number | boolean, string],
          ],
        },
        toClear,
      );
    }
  } else if (rpcRes.name === "SetParameterAttributesResponse") {
    if (rpcReq.name !== "SetParameterAttributes")
      return invalidResponse("Response name does not match request name");

    for (const p of rpcReq.parameterList) {
      let attrs;

      if (p[1] != null && p[2] != null) {
        attrs = {
          notification: [timestamp + 1, p[1]],
          accessList: [timestamp + 1, p[2]],
        };
      } else if (p[1] != null) {
        attrs = {
          notification: [timestamp + 1, p[1]],
        };
      } else if (p[2] != null) {
        attrs = {
          accessList: [timestamp + 1, p[2]],
        };
      }

      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(p[0]),
        timestamp + 1,
        attrs,
        toClear,
      );
    }
  } else if (rpcRes.name === "AddObjectResponse") {
    if (rpcReq.name !== "AddObject")
      return invalidResponse("Response name does not match request name");

    toClear = device.set(
      sessionContext.deviceData,
      Path.parse(rpcReq.objectName + rpcRes.instanceNumber),
      timestamp + 1,
      { object: [timestamp + 1, 1] },
      toClear,
    );
  } else if (rpcRes.name === "DeleteObjectResponse") {
    if (rpcReq.name !== "DeleteObject")
      return invalidResponse("Response name does not match request name");

    toClear = device.set(
      sessionContext.deviceData,
      Path.parse(rpcReq.objectName.slice(0, -1)),
      timestamp + 1,
      null,
      toClear,
    );
  } else if (rpcRes.name === "RebootResponse") {
    if (rpcReq.name !== "Reboot")
      return invalidResponse("Response name does not match request name");

    toClear = device.set(
      sessionContext.deviceData,
      Path.parse("Reboot"),
      timestamp + 1,
      { value: [timestamp + 1, [sessionContext.timestamp, "xsd:dateTime"]] },
      toClear,
    );
  } else if (rpcRes.name === "FactoryResetResponse") {
    if (rpcReq.name !== "FactoryReset")
      return invalidResponse("Response name does not match request name");

    toClear = device.set(
      sessionContext.deviceData,
      Path.parse("FactoryReset"),
      timestamp + 1,
      { value: [timestamp + 1, [sessionContext.timestamp, "xsd:dateTime"]] },
      toClear,
    );
  } else if (rpcRes.name === "DownloadResponse") {
    if (rpcReq.name !== "Download")
      return invalidResponse("Response name does not match request name");

    toClear = device.set(
      sessionContext.deviceData,
      Path.parse(`Downloads.${rpcReq.instance}.Download`),
      timestamp + 1,
      { value: [timestamp + 1, [sessionContext.timestamp, "xsd:dateTime"]] },
      toClear,
    );

    if (rpcRes.status === 0) {
      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(`Downloads.${rpcReq.instance}.LastDownload`),
        timestamp + 1,
        {
          value: [timestamp + 1, [sessionContext.timestamp, "xsd:dateTime"]],
        },
        toClear,
      );

      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(`Downloads.${rpcReq.instance}.LastFileType`),
        timestamp + 1,
        { value: [timestamp + 1, [rpcReq.fileType, "xsd:string"]] },
        toClear,
      );

      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(`Downloads.${rpcReq.instance}.LastFileName`),
        timestamp + 1,
        { value: [timestamp + 1, [rpcReq.fileType, "xsd:string"]] },
        toClear,
      );

      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(`Downloads.${rpcReq.instance}.LastTargetFileName`),
        timestamp + 1,
        { value: [timestamp + 1, [rpcReq.fileType, "xsd:string"]] },
        toClear,
      );

      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(`Downloads.${rpcReq.instance}.StartTime`),
        timestamp + 1,
        { value: [timestamp + 1, [+rpcRes.startTime, "xsd:dateTime"]] },
        toClear,
      );

      toClear = device.set(
        sessionContext.deviceData,
        Path.parse(`Downloads.${rpcReq.instance}.CompleteTime`),
        timestamp + 1,
        { value: [timestamp + 1, [+rpcRes.completeTime, "xsd:dateTime"]] },
        toClear,
      );
    } else {
      const operation = {
        name: "Download",
        timestamp: sessionContext.timestamp,
        provisions: sessionContext.provisions,
        channels: sessionContext.channels,
        retries: {},
        args: {
          instance: rpcReq.instance,
          fileType: rpcReq.fileType,
          fileName: rpcReq.fileName,
          targetFileName: rpcReq.targetFileName,
        },
      };

      for (const channel of Object.keys(sessionContext.channels)) {
        if (sessionContext.retries[channel] != null)
          operation.retries[channel] = sessionContext.retries[channel];
      }

      sessionContext.operations[rpcReq.commandKey] = operation;
      if (!sessionContext.operationsTouched)
        sessionContext.operationsTouched = {};
      sessionContext.operationsTouched[rpcReq.commandKey] = 1;
    }
  } else {
    return invalidResponse("Response name not recognized");
  }

  if (toClear) {
    for (const c of toClear)
      device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
  }

  return null;
}

export async function rpcFault(
  sessionContext: SessionContext,
  id: string,
  faultResponse: CpeFault,
): Promise<Fault> {
  const rpcReq = sessionContext.rpcRequest;
  delete sessionContext.syncState;
  delete sessionContext.rpcRequest;
  ++sessionContext.rpcCount;

  // Recover from invalid parameter name faults
  if (faultResponse.detail.faultCode === "9005") {
    const timestamp = sessionContext.timestamp + sessionContext.iteration + 1;
    const revision =
      (sessionContext.revisions[sessionContext.revisions.length - 1] || 0) + 1;
    sessionContext.deviceData.timestamps.revision = revision;
    sessionContext.deviceData.attributes.revision = revision;

    let toClear: Clear[];
    if (rpcReq.name === "GetParameterNames") {
      if (rpcReq.parameterPath) {
        toClear = [
          [Path.parse(rpcReq.parameterPath.replace(/\.$/, "")), timestamp],
        ];
      }
    } else if (rpcReq.name === "GetParameterValues") {
      toClear = rpcReq.parameterNames.map(
        (p) => [Path.parse(p.replace(/\.$/, "")), timestamp] as Clear,
      );
    } else if (rpcReq.name === "SetParameterValues") {
      toClear = (
        rpcReq.parameterList as [string, string | number | boolean, string][]
      ).map((p) => [Path.parse(p[0].replace(/\.$/, "")), timestamp] as Clear);
    } else if (rpcReq.name === "AddObject") {
      toClear = [[Path.parse(rpcReq.objectName.replace(/\.$/, "")), timestamp]];
    } else if (rpcReq.name === "DeleteObject") {
      toClear = [[Path.parse(rpcReq.objectName.replace(/\.$/, "")), timestamp]];
    } else if (rpcReq.name === "GetParameterAttributes") {
      toClear = rpcReq.parameterNames.map(
        (p) => [Path.parse(p.replace(/\.$/, "")), timestamp] as Clear,
      );
    } else if (rpcReq.name === "SetParameterAttributes") {
      toClear = (rpcReq.parameterList as [string, number, string[]][]).map(
        (p) => [Path.parse(p[0].replace(/\.$/, "")), timestamp] as Clear,
      );
    }

    if (toClear) {
      for (const c of toClear)
        device.clear(sessionContext.deviceData, c[0], c[1], c[2], c[3]);
      return null;
    }
  }

  const fault: Fault = {
    code: `cwmp.${faultResponse.detail.faultCode}`,
    message: faultResponse.detail.faultString,
    detail: faultResponse.detail,
  };

  return fault;
}

export async function deserialize(
  sessionContextString: string,
): Promise<SessionContext> {
  const sessionContext = JSON.parse(sessionContextString) as SessionContext;

  for (const decs of sessionContext.declarations)
    for (const d of decs) d.path = Path.parse(d.path as unknown as string);

  const deviceData = initDeviceData();
  for (const r of sessionContext.deviceData as unknown as any[]) {
    const path = deviceData.paths.add(Path.parse(r[0]));

    if (r[1]) deviceData.trackers.set(path, r[1]);

    if (r[2]) {
      deviceData.timestamps.setRevisions(path, r[2]);
      if (r[3]) deviceData.attributes.setRevisions(path, r[3]);
    }
  }

  sessionContext.deviceData = deviceData;
  // Ensure cache is populated
  await localCache.getRevision();

  return sessionContext;
}

export async function serialize(
  sessionContext: SessionContext,
): Promise<string> {
  const deviceData = [];

  for (const path of sessionContext.deviceData.paths.find(
    Path.parse(""),
    false,
    false,
    99,
  )) {
    const e = [
      path.toString(),
      sessionContext.deviceData.trackers.get(path) || null,
      sessionContext.deviceData.timestamps.getRevisions(path) || null,
      sessionContext.deviceData.attributes.getRevisions(path) || null,
    ];
    deviceData.push(e);
  }

  const declarations = sessionContext.declarations.map((decs) => {
    return decs.map((d) => Object.assign({}, d, { path: d.path.toString() }));
  });

  const jsonSessionContext = Object.assign({}, sessionContext, {
    deviceData: deviceData,
    declarations: declarations,
    syncState: null,
    toLoad: null,
    httpRequest: null,
    httpResponse: null,
  });

  const sessionContextString = JSON.stringify(jsonSessionContext);

  return sessionContextString;
}
