const { RingSdk } = require("../sdk/rw-ble-sdk.min.js");
const storage = require("../utils/storage");
const { getWorkoutTypeName, formatWorkoutDuration } = require("../utils/workout");
const cdmsBridge = require("../utils/cdms-bridge");
const deviceSettings = require("../utils/device-settings");
const capabilities = require("../utils/capabilities");

const SCAN_TIMEOUT_MS = 10000;
const HEALTH_MEASUREMENT_TIMEOUT_MS = 120000;

const WX_BLE_MESSAGES = {
  10000: { code: "ADAPTER_NOT_INITIALIZED", message: "蓝牙尚未初始化，请稍后重试" },
  10001: { code: "BLUETOOTH_OFF", message: "手机蓝牙未开启，请开启蓝牙后重试", action: "bluetoothSetting" },
  10002: { code: "DEVICE_NOT_FOUND", message: "未找到设备，请确认设备在附近且未连接其他手机" },
  10003: { code: "CONNECT_FAILED", message: "设备连接失败，请靠近设备后重试" },
  10004: { code: "SERVICE_NOT_FOUND", message: "未发现设备通信服务，请确认设备型号和固件是否兼容" },
  10005: { code: "CHARACTERISTIC_NOT_FOUND", message: "设备通信特征不完整，请确认设备型号和固件是否兼容" },
  10006: { code: "DISCONNECTED", message: "设备连接已断开，请重新连接" },
  10007: { code: "PROPERTY_NOT_SUPPORTED", message: "当前设备不支持此蓝牙操作" },
  10008: { code: "SYSTEM_ERROR", message: "系统蓝牙繁忙，请关闭蓝牙后重新开启再试" },
  10009: { code: "BLE_NOT_SUPPORTED", message: "当前手机或微信版本不支持所需蓝牙能力" },
  10012: { code: "OPERATION_TIMEOUT", message: "蓝牙操作超时，请靠近设备后重试" },
  10013: { code: "INVALID_DATA", message: "蓝牙参数或设备数据无效，请重试" },
};

class BleClientError extends Error {
  constructor(values) {
    super(values.message);
    this.name = "BleClientError";
    Object.assign(this, values);
  }
}

function createBleError(error, stage) {
  if (error instanceof BleClientError) return error;
  const errCode = error && typeof error.errCode === "number" ? error.errCode : undefined;
  const errMsg = error && error.errMsg ? error.errMsg : error && error.message ? error.message : "微信蓝牙接口调用失败";
  const lowerMessage = String(errMsg).toLowerCase();
  const reason = error && error.reason ? error.reason : "";
  let mapped = errCode === undefined ? null : WX_BLE_MESSAGES[errCode];
  if (reason === "PASSWORD_AUTH_FAILED") {
    mapped = { code: "PASSWORD_AUTH_FAILED", message: "设备密码认证失败，请确认设备密码后重试" };
  }
  if (!mapped && (lowerMessage.includes("auth") || lowerMessage.includes("permission") || lowerMessage.includes("authorize"))) {
    mapped = { code: "PERMISSION_DENIED", message: "微信蓝牙权限未开启，请在小程序设置中允许后重试", action: "openSetting" };
  }
  if (!mapped && stage === "connect") {
    mapped = { code: "CONNECT_FAILED", message: "设备连接失败，请确认设备在附近且未连接其他手机" };
  }
  if (!mapped && stage === "initialize") {
    mapped = { code: "SDK_INITIALIZE_FAILED", message: "设备通信初始化失败，请断开设备后重新连接" };
  }
  mapped = mapped || { code: "BLE_OPERATION_FAILED", message: errMsg };
  return new BleClientError({
    code: mapped.code,
    stage,
    reason,
    errCode,
    detail: errMsg,
    message: mapped.message,
    action: mapped.action || "",
    recoverable: mapped.code !== "BLE_NOT_SUPPORTED",
  });
}

function normalizeMac(value) {
  const text = String(value || "").trim().replace(/-/g, ":").toUpperCase();
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(text) ? text : "";
}

function callWx(method, options, stage) {
  return new Promise((resolve, reject) => {
    method(
      Object.assign({}, options, {
        success: resolve,
        fail: (error) => reject(createBleError(error, stage)),
      }),
    );
  });
}

class BleManager {
  constructor() {
    const boundDevice = storage.getBoundDevice();
    this.listeners = new Set();
    this.sdk = null;
    this.activeDeviceId = "";
    this.scanSession = null;
    this.healthSyncPromise = null;
    this.deviceEventUnsubscribe = null;
    this.connectPromise = null;
    this.connectingDeviceId = "";
    this.connectionGeneration = 0;
    this.scanTicker = null;
    this.scanDeviceDebugSignature = "";
    this.healthMeasurementTimer = null;
    this.intentionalDisconnectIds = new Set();
    this.initialized = false;
    this.autoSyncTimer = null;
    this.state = {
      adapterAvailable: false,
      scanning: false,
      scanRemainingSeconds: 0,
      connectionState: "disconnected",
      boundDevice,
      foreignDevice: false,
      devices: [],
      logs: [],
      error: "",
      healthRevision: 0,
      healthSyncing: false,
      healthSyncProgress: 0,
      activeMeasurementType: "",
      realtimeHealth: {},
      realtimeHealthRevision: 0,
      workoutState: { sportType: 0, status: 4, isRunning: false },
      workoutRealtime: { activityTime: 0, steps: 0, distance: 0, calorie: 0, heartRate: 0 },
      workoutReports: [],
      workoutRevision: 0,
      lastHealthSyncAt: boundDevice ? boundDevice.lastHealthSyncAt || 0 : 0,
      healthAlertText: "",
    };
  }

  init() {
    if (this.initialized) return Promise.resolve();
    this.initialized = true;
    // Task A：启动时按当前登录患者比对绑定归属，异患者绑定不复用（不删除绑定记录）。
    this.refreshBoundDeviceOwnership();
    wx.onBluetoothAdapterStateChange((result) => {
      if (!result.discovering) {
        if (this.scanTicker) clearInterval(this.scanTicker);
        this.scanTicker = null;
      }
      this.patch({
        adapterAvailable: result.available,
        scanning: result.discovering,
        scanRemainingSeconds: result.discovering ? this.state.scanRemainingSeconds : 0,
      });
      if (!result.available) this.handleDisconnected("手机蓝牙不可用");
    });
    return this.ensureAdapter();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return Object.assign({}, this.state, {
      devices: this.state.devices.slice(),
      logs: this.state.logs.slice(),
      realtimeHealth: Object.assign({}, this.state.realtimeHealth),
      workoutState: Object.assign({}, this.state.workoutState),
      workoutRealtime: Object.assign({}, this.state.workoutRealtime),
      workoutReports: this.state.workoutReports.slice(),
      connected: this.state.connectionState === "connected",
      sdkReady: this.state.connectionState === "connected" && !!this.sdk,
    });
  }

  getContextRole() {
    try {
      const app = typeof getApp === "function" ? getApp() : null;
      return String(app && app.globalData && app.globalData.activeRole || "");
    } catch (_) { return ""; }
  }

  getContextPatientRef() {
    try {
      const app = typeof getApp === "function" ? getApp() : null;
      return String(app && app.globalData && app.globalData.patientRef || "").trim();
    } catch (_) { return ""; }
  }

  // Task A：当前存储的绑定是否属于其他患者账号（异设备）。
  // 仅 PATIENT 角色且已有 patientRef 时才做归属隔离；医生端 / 未登录 / 旧数据（无 ownerPatientRef）保持现状。
  isBoundDeviceForeignFor(boundDevice) {
    if (!boundDevice || !boundDevice.deviceId) return false;
    if (this.getContextRole() !== "PATIENT") return false;
    if (!this.getContextPatientRef()) return false;
    return !storage.isBoundDeviceOwnedByPatient(boundDevice, this.getContextPatientRef());
  }

  isBoundDeviceForeign() {
    const patientRef = this.getContextPatientRef();
    if (this.getContextRole() === "PATIENT" && patientRef &&
      typeof storage.listBoundDevices === "function" && storage.listBoundDevices(patientRef).length) {
      return false;
    }
    return this.isBoundDeviceForeignFor(storage.getBoundDevice());
  }

  // Task A：按当前登录患者刷新绑定归属状态。
  // 异患者绑定：展示层面置为未绑定（boundDevice=null + foreignDevice=true），
  // 不删除绑定记录、不清健康历史；切回本人登录后再调用即可恢复展示。
  async refreshBoundDeviceOwnership() {
    const storedDevice = storage.getBoundDevice();
    const patientRef = this.getContextPatientRef();
    const patientDevices = this.getContextRole() === "PATIENT" && patientRef &&
      typeof storage.listBoundDevices === "function"
      ? storage.listBoundDevices(patientRef)
      : [];
    const hasKnownPatientScope = this.getContextRole() === "PATIENT" && !!patientRef;
    const activeDevice = this.activeDeviceId && typeof storage.getScopedBoundDevice === "function"
      ? storage.getScopedBoundDevice(this.activeDeviceId, patientRef)
      : null;
    const boundDevice = hasKnownPatientScope
      ? (patientDevices.length ? (activeDevice || patientDevices[patientDevices.length - 1]) : null)
      : storedDevice;
    const foreign = hasKnownPatientScope
      ? !patientDevices.length && !!storedDevice
      : !patientDevices.length && this.isBoundDeviceForeignFor(storedDevice);
    const patch = { foreignDevice: !!foreign };
    if (foreign) {
      if (this.activeDeviceId) this.markIntentionalDisconnect(this.activeDeviceId);
      patch.boundDevice = null;
      patch.connectionState = "disconnected";
      this.disposeRuntime("绑定设备属于其他账号");
      this.activeDeviceId = "";
      this.log("该绑定设备属于其他患者账号，已隐藏（绑定记录未删除，登录本人账号后可恢复）");
    } else {
      patch.boundDevice = boundDevice ? boundDevice : null;
    }
    this.patch(patch);
    return foreign;
  }

  getSdk() {
    return this.sdk;
  }

  async ensureAdapter() {
    try {
      await callWx(wx.openBluetoothAdapter, {}, "adapter");
      this.patch({ adapterAvailable: true, error: "" });
    } catch (error) {
      this.patch({ adapterAvailable: false, error: error.message });
      throw error;
    }
  }

  async startScan() {
    await this.stopScan();
    this.patch({ devices: [], scanning: true, scanRemainingSeconds: 10, error: "" });
    this.log("开始搜索附近设备");

    try {
      const scanDeadline = Date.now() + SCAN_TIMEOUT_MS;
      const applyDevices = (devices, source) => {
        const next = devices.map((device) => {
          const macAddress = device.macAddress
            || storage.getDeviceAddress(device.deviceId)
            || normalizeMac(device.deviceId);
          if (macAddress) storage.saveDeviceAddress(device.deviceId, macAddress);
          return Object.assign({}, device, { macAddress });
        });
        const debugSignature = next
          .map((device) => `${device.deviceId}:${device.systemConnected ? 1 : 0}`)
          .join("|");
        if (debugSignature !== this.scanDeviceDebugSignature) {
          this.scanDeviceDebugSignature = debugSignature;
          console.info("[rwsdk-demo][scan] demo-device-state", {
            source,
            count: next.length,
            devices: next.map((device) => ({
              deviceId: device.deviceId,
              name: device.name || "",
              systemConnected: !!device.systemConnected,
            })),
          });
        }
        this.patch({ devices: next });
      };
      this.scanTicker = setInterval(() => {
        this.patch({
          scanRemainingSeconds: Math.max(0, Math.ceil((scanDeadline - Date.now()) / 1000)),
        });
      }, 250);
      let session;
      session = await RingSdk.startScan({
        timeoutMs: SCAN_TIMEOUT_MS,
        debug: (event, detail) => {
          console.info(`[rwsdk-demo][scan] ${event}`, detail);
        },
        onDevices: (devices) => {
          applyDevices(devices, "callback");
        },
      });
      this.scanSession = session;
      // 系统连接设备可能在 startScan() 返回前已完成查询，主动同步一次当前快照。
      applyDevices(session.getDevices(), "initial-snapshot");
      this.patch({ adapterAvailable: true });
      session.finished.then((devices) => {
        if (this.scanSession !== session) return;
        this.scanSession = null;
        if (this.scanTicker) clearInterval(this.scanTicker);
        this.scanTicker = null;
        applyDevices(devices, "finished");
        this.patch({ scanning: false, scanRemainingSeconds: 0 });
        if (!devices.length) {
          const message = "暂未发现设备，请靠近设备并确认未连接其他手机";
          this.patch({ error: message });
          this.log(message);
        }
      });
    } catch (error) {
      await this.stopScan();
      const bleError = createBleError(error, "scan");
      this.patch({ error: bleError.message });
      throw error;
    }
  }

  async stopScan() {
    if (this.scanTicker) clearInterval(this.scanTicker);
    this.scanTicker = null;
    const session = this.scanSession;
    this.scanSession = null;
    if (session) await session.stop();
    else if (this.state.scanning) {
      await new Promise((resolve) => wx.stopBluetoothDevicesDiscovery({ complete: resolve }));
    }
    if (this.state.scanning || this.state.scanRemainingSeconds) {
      this.patch({ scanning: false, scanRemainingSeconds: 0 });
    }
  }

  connect(device) {
    const target = device || this.state.boundDevice;
    if (!target || !target.deviceId) return Promise.reject(new Error("没有可连接的设备"));
    if (this.connectPromise) {
      if (this.connectingDeviceId === target.deviceId) return this.connectPromise;
      return Promise.reject(new BleClientError({
        code: "ALREADY_CONNECTING",
        stage: "connect",
        message: "正在连接其他设备，请稍后再试",
        recoverable: true,
      }));
    }
    const generation = ++this.connectionGeneration;
    this.connectingDeviceId = target.deviceId;
    this.connectPromise = this.performConnect(target, generation).finally(() => {
      this.connectPromise = null;
      this.connectingDeviceId = "";
    });
    return this.connectPromise;
  }

  isConnectionCurrent(target, generation) {
    return this.connectionGeneration === generation &&
      this.connectingDeviceId === target.deviceId &&
      this.activeDeviceId === target.deviceId;
  }

  isConnectionAttemptCurrent(target, generation) {
    return this.connectionGeneration === generation &&
      this.connectingDeviceId === target.deviceId;
  }

  async abortStaleConnection(target, sdk) {
    if (sdk && typeof sdk.disconnect === "function") {
      await sdk.disconnect("连接已失效").catch(() => undefined);
    } else if (target && target.deviceId && wx.closeBLEConnection) {
      await new Promise((resolve) => wx.closeBLEConnection({ deviceId: target.deviceId, complete: resolve }));
    }
    this.disposeRuntime("连接已失效");
    throw new BleClientError({
      code: "CONNECT_CANCELLED",
      stage: "connect",
      message: "连接已失效，请重新连接",
      recoverable: true,
    });
  }

  async performConnect(target, generation) {
    if (
      this.state.connectionState === "connected" &&
      this.activeDeviceId === target.deviceId
    ) {
      return this.state.boundDevice;
    }

    await this.stopScan();
    if (!this.isConnectionAttemptCurrent(target, generation)) return this.abortStaleConnection(target);
    const previousDeviceId = this.activeDeviceId;
    if (previousDeviceId && previousDeviceId !== target.deviceId) {
      this.markIntentionalDisconnect(previousDeviceId);
      if (this.sdk) await this.sdk.disconnect("切换连接设备").catch(() => undefined);
      else await new Promise((resolve) => wx.closeBLEConnection({ deviceId: previousDeviceId, complete: resolve }));
      if (!this.isConnectionAttemptCurrent(target, generation)) return this.abortStaleConnection(target);
    }
    this.disposeRuntime("开始新连接");
    this.activeDeviceId = target.deviceId;
    this.patch({ connectionState: "connecting", error: "" });
    this.log(`正在连接 ${target.name || target.deviceId}`);

    try {
      const app = typeof getApp === "function" ? getApp() : null;
      const devicePassword = app?.globalData?.devicePassword;
      if (devicePassword) RingSdk.prepareAutoPassword(String(devicePassword));
      const sdk = await RingSdk.connect(target.deviceId, {
        onConnectionStateChange: ({ deviceId, connected }) => {
          if (connected || deviceId !== this.activeDeviceId) return;
          if (this.intentionalDisconnectIds.has(deviceId)) {
            this.intentionalDisconnectIds.delete(deviceId);
            return;
          }
          this.handleDisconnected("设备连接已断开");
        },
        onStage: (stage) => {
          if (stage === "initializing") {
            this.patch({ connectionState: "initializing" });
            this.log("连接成功，正在初始化设备");
          }
        },
        debug: (event, detail) => {
          console.info(`[rwsdk-demo][sdk] ${event}`, detail);
          if (event === "support-menu" && detail && detail.ppgMonitoring) {
            const ppg = detail.ppgMonitoring;
            this.log(
              `功能表 payload[37]=${ppg.rawHex}，PPG(bit0)=${ppg.bit0 ? 1 : 0}，体温(bit1)=${ppg.temperatureBit1 ? 1 : 0}`,
            );
            if (detail.passwordAuth) {
              this.log(
                `密码认证功能位 payload[44]=${detail.passwordAuth.rawHex}，Auth(bit0)=${detail.passwordAuth.bit0 ? 1 : 0}`,
              );
            }
            if (detail.healthData) {
              this.log(
                `健康功能表 总开关[83]=${detail.healthData.allSwitch.rawByte}，血糖[92]=${detail.healthData.bloodSugar.rawByte}，体温[94]=${detail.healthData.temperature.rawByte}`,
              );
            }
          }
        },
      });
      if (!this.isConnectionCurrent(target, generation)) return this.abortStaleConnection(target, sdk);
      this.sdk = sdk;
      this.deviceEventUnsubscribe = this.sdk.onDeviceEvent((event) => this.handleDeviceEvent(event));
      const supportMenu = this.sdk.supportMenu;

      const results = await Promise.all([
        this.sdk.readPower().catch(() => null),
        this.sdk.readFirmwareVersion().catch(() => null),
        this.sdk.readBleAddress().catch(() => ""),
      ]);
      if (!this.isConnectionCurrent(target, generation)) return this.abortStaleConnection(target, this.sdk);
      const power = results[0];
      const firmware = results[1];
      const macAddress = results[2];
      const previousBoundDevice = this.state.boundDevice
        && this.state.boundDevice.deviceId === target.deviceId
        ? this.state.boundDevice
        : null;
      const boundDevice = {
        deviceId: target.deviceId,
        macAddress: macAddress
          || normalizeMac(target.macAddress)
          || (previousBoundDevice && previousBoundDevice.macAddress)
          || storage.getDeviceAddress(target.deviceId)
          || normalizeMac(target.deviceId),
        name: target.name || target.localName || "RW 智能戒指",
        localName: target.localName || "",
        supportMenu,
        powerLevel: power ? power.level : null,
        firmware: firmware || null,
        boundAt: previousBoundDevice && previousBoundDevice.boundAt
          ? previousBoundDevice.boundAt
          : Date.now(),
        lastConnectedAt: Date.now(),
        lastHealthSyncAt: previousBoundDevice && previousBoundDevice.lastHealthSyncAt
          ? previousBoundDevice.lastHealthSyncAt
          : 0,
      };
      if (boundDevice.macAddress) storage.saveDeviceAddress(boundDevice.deviceId, boundDevice.macAddress);
      storage.saveBoundDevice(boundDevice);
      const connectedState = {
        boundDevice,
        connectionState: "connected",
        error: "",
      };
      if (!previousBoundDevice) connectedState.workoutReports = [];
      this.patch(connectedState);
      this.log("设备初始化完成");
      // 连接成功后重放已持久化的指环设置（失败静默，不影响连接）
      this.replayDeviceSettings(boundDevice.deviceId).catch((error) => {
        console.warn("[CDMS BLE] 设备设置重放失败", error && error.message ? error.message : error);
      });
      return boundDevice;
    } catch (error) {
      const bleError = createBleError(
        error,
        error && error.stage
          ? error.stage
          : this.state.connectionState === "initializing" ? "initialize" : "connect",
      );
      const platformCode = bleError.errCode === undefined ? "" : `/${bleError.errCode}`;
      this.log(`连接失败 [${bleError.code}${platformCode}]：${bleError.detail || bleError.message}`);
      this.disposeRuntime(bleError.message);
      this.patch({ connectionState: "disconnected", error: bleError.message });
      throw bleError;
    }
  }

  async reconnect() {
    return this.connect(this.state.boundDevice);
  }

  /**
   * 定时同步（一期）：前台期间按 intervalMinutes 周期静默同步全部健康数据。
   * 注意 syncAllHealthData 内部已包含 cdmsBridge.enqueueAndFlush（与首页下拉同步同一链路），
   * 因此这里直接复用，不重复上传，避免产生重复批次。
   */
  scheduleAutoSync(intervalMinutes) {
    this.stopAutoSync();
    // 未显式传值时，从当前绑定设备的本地配置读取同步间隔（取不到/非法回落到默认 15）
    let minutes = intervalMinutes;
    if (minutes === undefined || minutes === null) {
      const bound = this.state.boundDevice;
      minutes = deviceSettings.getSyncIntervalMinutes(bound && bound.deviceId);
    }
    const intervalMs = Math.max(1, Number(minutes) || deviceSettings.DEFAULT_SYNC_INTERVAL_MINUTES) * 60 * 1000;
    this.autoSyncTimer = setInterval(() => {
      this.safeAutoSync();
    }, intervalMs);
  }

  // 读取当前绑定设备的同步间隔（分钟），非设备场景/取不到时回落默认 15
  getSyncIntervalMinutes(deviceId) {
    return deviceSettings.getSyncIntervalMinutes(deviceId || (this.state.boundDevice && this.state.boundDevice.deviceId));
  }

  stopAutoSync() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // 静默自动同步：未连接 / 未绑定 / 正在同步时不触发，出错静默记录
  async safeAutoSync() {
    if (!this.state.connected || !this.state.boundDevice || this.state.healthSyncing) return;
    try {
      await this.syncAllHealthData();
    } catch (error) {
      console.warn("[CDMS BLE] 自动同步失败", error && error.message ? error.message : error);
    }
  }

  /**
   * 连接成功后重放已持久化的设置（仅 key 存在时下发，避免覆盖用户未设置项）。
   * 每个下发单独 try/catch，失败静默，不影响连接。
   */
  async replayDeviceSettings(deviceId) {
    const sdk = this.sdk;
    if (!sdk || !deviceId) return;
    const saved = deviceSettings.load(deviceId);
    if (!saved || typeof saved !== "object") return;
    const typeMap = deviceSettings.MONITORING_TYPE_MAP || {};
    // 任何监测项的 enabled=false 都不重放：重连设备绝不自动关闭采集（关闭必须由用户在设备页显式操作）。
    let replayedAny = false;
    for (const key of Object.keys(typeMap)) {
      const value = saved[key];
      if (!value || typeof value !== "object") continue;
      if (!value.enabled) continue;
      try {
        await sdk.setMonitoring(typeMap[key], {
          enabled: true,
          startHour: value.startHour,
          startMinute: value.startMinute,
          endHour: value.endHour,
          endMinute: value.endMinute,
          intervalMinutes: value.intervalMinutes,
        });
        replayedAny = true;
      } catch (error) {
        console.warn(`[CDMS BLE] 重放 ${key} 失败`, error && error.message ? error.message : error);
      }
    }
    // 新绑定/无任何监测配置：默认开启全天心率+血氧（30 分钟），保证设备开箱即有监测数据。
    const hasMonitoringConfig = Object.keys(typeMap).some((key) => saved[key] && typeof saved[key] === "object");
    if (!replayedAny && !hasMonitoringConfig) {
      try {
        await sdk.setMonitoring("heartRate", { enabled: true, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, intervalMinutes: 30 });
        await sdk.setMonitoring("bloodOxygen", { enabled: true, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, intervalMinutes: 30 });
        deviceSettings.save(deviceId, {
          heartRateMonitoring: { enabled: true, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, intervalMinutes: 30 },
          bloodOxygenMonitoring: { enabled: true, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, intervalMinutes: 30 }
        });
        this.log("未检测到监测配置，已默认开启全天心率/血氧监测（30 分钟）");
      } catch (error) {
        console.warn("[CDMS BLE] 默认监测开启失败", error && error.message ? error.message : error);
      }
    }
    if (saved.heartRateAlert && typeof saved.heartRateAlert === "object") {
      try {
        await sdk.setHeartRateAlert(
          !!saved.heartRateAlert.enabled,
          saved.heartRateAlert.high,
          saved.heartRateAlert.low
        );
      } catch (error) {
        console.warn("[CDMS BLE] 重放 heartRateAlert 失败", error && error.message ? error.message : error);
      }
    }
    if (saved.bloodOxygenAlert && typeof saved.bloodOxygenAlert === "object") {
      try {
        await sdk.setBloodOxygenAlert(
          !!saved.bloodOxygenAlert.enabled,
          saved.bloodOxygenAlert.low
        );
      } catch (error) {
        console.warn("[CDMS BLE] 重放 bloodOxygenAlert 失败", error && error.message ? error.message : error);
      }
    }
  }

  /**
   * 回读设备真实设置并写回本地存储（仅读取已持久化的 key）。
   * SDK getter 见 sdk/index.d.ts：getMonitoring(type) / getHeartRateAlert() / getBloodOxygenAlert()。
   * 若 SDK 版本不支持 getter，会走 try/catch 静默跳过，仅保留持久化 + 重放。
   */
  async readDeviceSettings(deviceId) {
    const sdk = this.sdk;
    if (!sdk || !deviceId) return {};
    const saved = deviceSettings.load(deviceId) || {};
    const updated = {};
    const typeMap = deviceSettings.MONITORING_TYPE_MAP || {};
    for (const key of Object.keys(typeMap)) {
      if (!saved[key]) continue;
      if (typeof sdk.getMonitoring !== "function") break;
      try {
        const info = await sdk.getMonitoring(typeMap[key]);
        if (info && typeof info === "object") {
          updated[key] = {
            enabled: !!info.enabled,
            startHour: info.startHour,
            startMinute: info.startMinute,
            endHour: info.endHour,
            endMinute: info.endMinute,
            intervalMinutes: info.intervalMinutes,
          };
        }
      } catch (error) {
        console.warn(`[CDMS BLE] 回读 ${key} 失败`, error && error.message ? error.message : error);
      }
    }
    try {
      if (saved.heartRateAlert && typeof sdk.getHeartRateAlert === "function") {
        const info = await sdk.getHeartRateAlert();
        if (info && typeof info === "object") {
          updated.heartRateAlert = { enabled: !!info.enabled, high: info.upperValue, low: info.lowerValue };
        }
      }
    } catch (error) {
      console.warn("[CDMS BLE] 回读 heartRateAlert 失败", error && error.message ? error.message : error);
    }
    try {
      if (saved.bloodOxygenAlert && typeof sdk.getBloodOxygenAlert === "function") {
        const info = await sdk.getBloodOxygenAlert();
        if (info && typeof info === "object") {
          updated.bloodOxygenAlert = { enabled: !!info.enabled, low: info.lowerValue };
        }
      }
    } catch (error) {
      console.warn("[CDMS BLE] 回读 bloodOxygenAlert 失败", error && error.message ? error.message : error);
    }
    if (Object.keys(updated).length) deviceSettings.save(deviceId, updated);
    return Object.assign({}, saved, updated);
  }

  async disconnect(deviceRef, expectedGeneration) {
    const requestedDeviceId = String(deviceRef || "").trim();
    if (requestedDeviceId && requestedDeviceId !== String(this.activeDeviceId || "").trim()) return;
    if (expectedGeneration != null && expectedGeneration !== this.connectionGeneration) return;
    if (this.connectPromise || this.connectingDeviceId) this.connectionGeneration += 1;
    const deviceId = this.activeDeviceId;
    const sdk = this.sdk;
    if (deviceId) this.markIntentionalDisconnect(deviceId);
    if (sdk) await sdk.disconnect("用户断开连接").catch(() => undefined);
    else if (deviceId) await new Promise((resolve) => wx.closeBLEConnection({ deviceId, complete: resolve }));
    this.disposeRuntime("用户断开连接");
    this.patch({ connectionState: "disconnected" });
  }

  // 退出登录只断开本地连接，保留患者的设备绑定；主动“解除绑定”仍走 unbind()。
  async disconnectForLogout() {
    await this.disconnect();
  }

  async unbind(deviceRef) {
    const requestedDeviceId = String(deviceRef || "").trim();
    const previous = this.state.boundDevice;
    const activeDeviceId = String(this.activeDeviceId || "").trim();
    const connectingDeviceId = String(this.connectingDeviceId || "").trim();
    if ((this.connectPromise || connectingDeviceId) && !requestedDeviceId) {
      throw new Error("连接进行中，请明确指定要解绑的设备");
    }
    if (requestedDeviceId && connectingDeviceId === requestedDeviceId) this.connectionGeneration += 1;
    const targetDeviceId = requestedDeviceId ||
      (previous && previous.deviceId ? String(previous.deviceId).trim() : "") ||
      activeDeviceId;
    if (!targetDeviceId) throw new Error("没有可解绑的设备");
    const targetWasActive = activeDeviceId === targetDeviceId;
    const targetWasBound = !!(previous && previous.deviceId === targetDeviceId);
    // An explicit non-active target must not disconnect the currently active
    // device: unbind is scoped to exactly the requested business binding.
    if (targetWasActive) await this.disconnect();
    try {
      await cdmsBridge.releaseWearableSession(targetDeviceId);
    } catch (error) {
      // 本地解绑必须完成；服务端释放失败会被记录，后续重新绑定时由会话校验再次修复。
      this.log(`服务端设备解绑未完成：${error && error.message ? error.message : "请求失败"}`);
    }
    if (typeof storage.clearBoundDevice === "function") {
      storage.clearBoundDevice(targetDeviceId, this.getContextPatientRef());
    }
    const patch = {
      error: "",
    };
    if (targetWasActive) {
      this.activeDeviceId = "";
      Object.assign(patch, {
        boundDevice: null,
        healthSyncing: false,
        healthSyncProgress: 0,
        lastHealthSyncAt: 0,
        workoutState: { sportType: 0, status: 4, isRunning: false },
        workoutRealtime: { activityTime: 0, steps: 0, distance: 0, calorie: 0, heartRate: 0 },
        workoutReports: [],
        workoutRevision: this.state.workoutRevision + 1,
      });
    } else if (targetWasBound) {
      const replacement = activeDeviceId && typeof storage.getScopedBoundDevice === "function"
        ? storage.getScopedBoundDevice(activeDeviceId, this.getContextPatientRef())
        : null;
      patch.boundDevice = replacement || null;
    }
    this.patch(patch);
  }

  async refreshPower() {
    if (!this.sdk) throw new Error("设备未连接");
    const power = await this.sdk.readPower();
    this.updateBoundDevice({ powerLevel: power.level });
    return power;
  }

  async syncTime() {
    if (!this.sdk) throw new Error("设备未连接");
    await this.sdk.setTime();
  }

  async findDevice() {
    if (!this.sdk) throw new Error("设备未连接");
    await this.sdk.findDevice();
  }

  async getWorkoutState() {
    if (!this.sdk || this.state.connectionState !== "connected") throw new Error("请先连接设备");
    const workoutState = await this.sdk.getWorkoutState();
    this.patch({
      workoutState,
      workoutRevision: this.state.workoutRevision + 1,
    });
    return workoutState;
  }

  async controlWorkout(sportType, status) {
    if (!this.sdk || this.state.connectionState !== "connected") throw new Error("请先连接设备");
    if (![1, 2, 3, 4].includes(status)) throw new Error("无效的运动控制状态");
    await this.sdk.controlWorkout(sportType, status);
    const workoutState = {
      sportType,
      status,
      isRunning: status >= 1 && status <= 3,
    };
    const values = {
      workoutState,
      workoutRevision: this.state.workoutRevision + 1,
    };
    if (status === 1) {
      values.workoutRealtime = { activityTime: 0, steps: 0, distance: 0, calorie: 0, heartRate: 0 };
    }
    this.patch(values);
    this.log(`${getWorkoutTypeName(sportType)}${status === 1 ? "开始" : status === 2 ? "继续" : status === 3 ? "暂停" : "结束"}`);
    return workoutState;
  }

  async setWorkoutRealtimePush(enabled) {
    if (!this.sdk || this.state.connectionState !== "connected") throw new Error("请先连接设备");
    await this.sdk.setWorkoutRealtimePush(enabled);
  }

  async syncWorkoutReports() {
    if (!this.sdk || this.state.connectionState !== "connected") throw new Error("请先连接设备");
    const reports = await this.sdk.getWorkoutReports();
    const records = reports.map((report) => ({
      id: `workout-${report.startTime}`,
      type: "workout",
      measuredAt: report.endTime || report.startTime,
      value: formatWorkoutDuration(report.exerciseTime),
      unit: "",
      summary: `${getWorkoutTypeName(report.workModel)} · ${report.step} 步 · ${(report.distance / 1000).toFixed(2)} km`,
      detail: report,
    }));
    if (records.length) this.patch({ workoutReports: records });
    this.log(`多运动报告同步完成，共 ${records.length} 条`);
    return records;
  }

  async setHealthMeasurement(type, measurementCode, enabled) {
    if (!this.sdk || this.state.connectionState !== "connected") throw new Error("请先连接设备");
    const activeType = this.state.activeMeasurementType;
    if (enabled && activeType && activeType !== type) {
      throw new Error(`请先结束正在进行的${activeType}检测`);
    }
    if (!enabled && activeType && activeType !== type) {
      throw new Error(`当前正在进行的是${activeType}检测`);
    }
    await this.sdk.setHealthMeasurement(measurementCode, enabled);
    this.clearHealthMeasurementTimer();
    const statePatch = { activeMeasurementType: enabled ? type : "" };
    if (enabled && this.state.realtimeHealth[type]) {
      const realtimeHealth = Object.assign({}, this.state.realtimeHealth);
      delete realtimeHealth[type];
      statePatch.realtimeHealth = realtimeHealth;
      statePatch.realtimeHealthRevision = this.state.realtimeHealthRevision + 1;
    }
    this.patch(statePatch);
    if (enabled) this.startHealthMeasurementTimer(type, measurementCode);
    this.log(`${enabled ? "开始" : "结束"}${type}实时检测`);
  }

  startHealthMeasurementTimer(type, measurementCode) {
    this.clearHealthMeasurementTimer();
    this.healthMeasurementTimer = setTimeout(() => {
      this.healthMeasurementTimer = null;
      if (this.state.activeMeasurementType !== type) return;

      // 先把停止命令排入队列，再释放 UI 状态；随后启动的新测量会排在停止命令之后。
      const stopPromise = this.sdk && this.state.connectionState === "connected"
        ? this.sdk.setHealthMeasurement(measurementCode, false)
        : null;
      if (stopPromise) {
        stopPromise.catch((error) => {
          this.log(`${type}实时检测超时停止失败：${error.message || error}`);
        });
      }
      this.patch({ activeMeasurementType: "" });
      this.log(`${type}实时检测超过 120 秒未完成，已自动释放`);
      if (wx.showToast) {
        wx.showToast({ title: "实时检测超时，已自动结束", icon: "none", duration: 2500 });
      }
    }, HEALTH_MEASUREMENT_TIMEOUT_MS);
  }

  clearHealthMeasurementTimer() {
    if (this.healthMeasurementTimer) clearTimeout(this.healthMeasurementTimer);
    this.healthMeasurementTimer = null;
  }

  async getMonitoring(type) {
    if (!this.sdk || this.state.connectionState !== "connected") throw new Error("请先连接设备");
    return this.sdk.getMonitoring(type);
  }

  async setMonitoring(type, schedule) {
    if (!this.sdk || this.state.connectionState !== "connected") throw new Error("请先连接设备");
    await this.sdk.setMonitoring(type, schedule);
    this.log(`${type}全天监测已${schedule.enabled ? `开启，间隔 ${schedule.intervalMinutes} 分钟` : "关闭"}`);
  }

  syncAllHealthData() {
    if (this.healthSyncPromise) return this.healthSyncPromise;
    if (!this.sdk || this.state.connectionState !== "connected") {
      return Promise.reject(new Error("请先连接设备"));
    }
    if (!this.state.boundDevice) return Promise.reject(new Error("尚未绑定设备"));

    const deviceId = this.state.boundDevice.deviceId;
    const syncGeneration = this.connectionGeneration;
    const sdk = this.sdk;
    const isCurrent = () => this.connectionGeneration === syncGeneration &&
      this.activeDeviceId === deviceId && this.sdk === sdk &&
      this.state.boundDevice && this.state.boundDevice.deviceId === deviceId;
    this.patch({ healthSyncing: true, healthSyncProgress: 0, error: "" });
    this.log("开始同步全部健康数据");
    this.healthSyncPromise = sdk.syncAllHealthData({
      onProgress: (progress) => {
        if (isCurrent()) this.patch({ healthSyncProgress: progress.percent });
      },
    }).then(async (result) => {
      if (!isCurrent()) return { recordCount: 0, failedTypes: [], uploadError: new Error("健康同步上下文已失效"), result, healthAlertText: "" };
      let recordCount = 0;
      Object.keys(result.records).forEach((type) => {
        const records = result.records[type] || [];
        if (!records.length) return;
        storage.saveHealthRecords(deviceId, type, records);
        recordCount += records.length;
      });
      const lastHealthSyncAt = Date.now();
      this.updateBoundDevice({ lastHealthSyncAt });
      this.patch({
        healthRevision: this.state.healthRevision + 1,
        lastHealthSyncAt,
        healthSyncProgress: 100,
      });
      const failedTypes = Object.keys(result.errors);
      this.log(
        failedTypes.length
          ? `健康数据同步完成，${failedTypes.length} 项失败`
          : `健康数据同步完成，共 ${recordCount} 条`,
      );
      let uploadError = null;
      try {
        await cdmsBridge.enqueueAndFlush({
          deviceRef: deviceId,
          recordsByType: result.records,
        });
        if (!isCurrent()) return { recordCount: 0, failedTypes: [], uploadError: new Error("健康同步上下文已失效"), result, healthAlertText: "" };
        this.log(`CDMS 数据上传完成，共 ${recordCount} 条`);
      } catch (error) {
        if (!isCurrent()) return { recordCount: 0, failedTypes: [], uploadError: new Error("健康同步上下文已失效"), result, healthAlertText: "" };
        uploadError = error;
        this.log(`CDMS 数据暂未上传：${error.message || error}`);
      }
      // 本地预警提醒：基于本次同步最新心率/血氧记录与本地阈值判断，仅在确有超阈值时提醒
      const alert = capabilities.evaluateHealthAlerts(result.records, deviceSettings.load(deviceId));
      const healthAlertText = alert.text || "";
      this.patch({ healthAlertText });
      if (healthAlertText && wx.showToast) {
        wx.showToast({ title: healthAlertText, icon: "none", duration: 2500 });
      }
      return { recordCount, failedTypes, uploadError, result, healthAlertText };
    }).finally(() => {
      if (isCurrent()) {
        this.healthSyncPromise = null;
        this.patch({ healthSyncing: false });
      }
    });
    return this.healthSyncPromise;
  }

  /** 健康解析模块得到业务数据后统一从这里写入，首页与历史页会立即刷新。 */
  saveHealthRecord(type, record) {
    if (!this.state.boundDevice) throw new Error("尚未绑定设备");
    const saved = storage.saveHealthRecord(
      this.state.boundDevice.deviceId,
      type,
      record,
    );
    this.patch({ healthRevision: this.state.healthRevision + 1 });
    return saved;
  }

  updateBoundDevice(values) {
    if (!this.state.boundDevice) return;
    const boundDevice = Object.assign({}, this.state.boundDevice, values);
    storage.saveBoundDevice(boundDevice);
    this.patch({ boundDevice });
  }

  handleDeviceEvent(event) {
    if (!event) return;
    if (event.type === "power") {
      this.updateBoundDevice({ powerLevel: event.level });
      return;
    }
    if (event.type === "health" && this.state.boundDevice) {
      const records = event.records || [];
      if (records.length) {
        const latest = records.reduce((result, record) => (
          !result || record.measuredAt >= result.measuredAt ? record : result
        ), null);
        const realtimeHealth = Object.assign({}, this.state.realtimeHealth, {
          [event.healthType]: latest,
        });
        this.patch({
          realtimeHealth,
          realtimeHealthRevision: this.state.realtimeHealthRevision + 1,
        });
        this.log(`收到${event.healthType}实时数据 ${records.length} 条`);
      }
      return;
    }
    if (event.type === "healthStatus" && event.completed) {
      this.clearHealthMeasurementTimer();
      this.patch({ activeMeasurementType: "" });
      this.log("实时健康检测已结束");
      return;
    }
    if (event.type === "workoutState") {
      this.patch({
        workoutState: event.state,
        workoutRevision: this.state.workoutRevision + 1,
      });
      return;
    }
    if (event.type === "workoutData") {
      this.patch({
        workoutRealtime: event.data,
        workoutRevision: this.state.workoutRevision + 1,
      });
    }
  }

  handleDisconnected(reason) {
    if (this.state.connectionState === "disconnected") return;
    this.disposeRuntime(reason);
    this.patch({ connectionState: "disconnected", error: reason });
    this.log(reason);
    if (wx.showToast) wx.showToast({ title: reason, icon: "none", duration: 2500 });
  }

  markIntentionalDisconnect(deviceId) {
    if (!deviceId) return;
    this.intentionalDisconnectIds.add(deviceId);
    setTimeout(() => this.intentionalDisconnectIds.delete(deviceId), 2000);
  }

  presentError(error, title = "蓝牙操作失败") {
    const bleError = createBleError(error, error && error.stage ? error.stage : "unknown");
    const canOpenBluetooth = bleError.action === "bluetoothSetting" && wx.openSystemBluetoothSetting;
    const canOpenSetting = bleError.action === "openSetting" && wx.openSetting;
    wx.showModal({
      title,
      content: bleError.message,
      showCancel: !!(canOpenBluetooth || canOpenSetting),
      confirmText: canOpenBluetooth ? "去开蓝牙" : canOpenSetting ? "去授权" : "知道了",
      success: (result) => {
        if (!result.confirm) return;
        if (canOpenBluetooth) wx.openSystemBluetoothSetting({});
        else if (canOpenSetting) wx.openSetting({});
      },
    });
  }

  disposeRuntime(reason) {
    if (this.sdk) this.sdk.dispose(reason);
    this.sdk = null;
    this.healthSyncPromise = null;
    this.clearHealthMeasurementTimer();
    if (this.deviceEventUnsubscribe) this.deviceEventUnsubscribe();
    this.deviceEventUnsubscribe = null;
    if (this.state.activeMeasurementType || Object.keys(this.state.realtimeHealth).length) {
      this.patch({
        activeMeasurementType: "",
        realtimeHealth: {},
        realtimeHealthRevision: this.state.realtimeHealthRevision + 1,
      });
    }
    if (this.state.healthSyncing) {
      this.patch({ healthSyncing: false, healthSyncProgress: 0 });
    }
    if (this.state.workoutRealtime.activityTime || this.state.workoutRealtime.steps) {
      this.patch({
        workoutRealtime: { activityTime: 0, steps: 0, distance: 0, calorie: 0, heartRate: 0 },
        workoutRevision: this.state.workoutRevision + 1,
      });
    }
  }

  log(message) {
    const line = `${new Date().toLocaleTimeString()} ${message}`;
    console.log("[rwsdk-demo]", line);
    this.patch({ logs: [line, ...this.state.logs].slice(0, 100) });
  }

  patch(values) {
    this.state = Object.assign({}, this.state, values);
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (_) {
        // 页面监听互相隔离。
      }
    });
  }
}

module.exports = new BleManager();
