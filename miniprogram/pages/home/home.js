const bleManager = require("../../services/bleManager");
const { getHealthCards } = require("../../utils/capabilities");
const { formatTime } = require("../../utils/format");
const api = require("../../utils/api");
const { getRoleEntry } = require("../../utils/role-entry");
const { getWorkspaceEntries } = require("../../utils/workspace-entry");

// 业务入口图标（与 workspace-entry.js 中 PATIENT/DOCTOR 的 key 对应）
const WORKSPACE_ICONS = {
  profile: "档",
  followups: "随",
  assess: "测",
  checkin: "扫",
  messages: "信",
  emergency: "急",
  patients: "患",
  device: "设",
};

// tabBar 页面使用 switchTab，其余原生页面使用 navigateTo
const TAB_PAGES = ["/pages/home/home", "/pages/device/device"];

// 距上次同步超过 15 分钟即在 onShow 时触发一次自动同步
const AUTO_SYNC_STALE_MS = 15 * 60 * 1000;

function unwrapData (response) {
  return response && typeof response === "object" && Object.prototype.hasOwnProperty.call(response, "data")
    ? response.data
    : response;
}

Page({
  workspaceOpening: false,
  data: {
    boundDevice: null,
    connectionState: "disconnected",
    healthCards: [],
    connected: false,
    healthSyncing: false,
    healthSyncProgress: 0,
    lastSyncText: "下拉同步全部健康数据",
    cdmsQueue: 0,
    cdmsStatus: "",
    activeRole: "",
    workspaceEntries: [],
    messagesUnread: 0
  },

  onLoad() {
    const app = getApp()
    const activeRole = app.globalData.activeRole || ''
    this.setData({
      activeRole,
      workspaceEntries: getWorkspaceEntries(activeRole).map((item) => Object.assign({}, item, {
        icon: WORKSPACE_ICONS[item.key] || "随",
      })),
    })
    if (getRoleEntry(app.globalData.activeRole).type === 'H5') {
      this.redirectDoctorWorkspace()
      return
    }
    if (app.globalData.cdmsBaseUrl && !app.globalData.accessToken) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    this.unsubscribe = bleManager.subscribe((state) => {
      this.setData({
        boundDevice: state.boundDevice,
        connectionState: state.connectionState,
        connected: state.connected,
        healthCards: getHealthCards(state.boundDevice, state.realtimeHealth),
        healthSyncing: state.healthSyncing,
        healthSyncProgress: state.healthSyncProgress,
        cdmsQueue: api.readQueue().length,
        lastSyncText: state.healthSyncing
          ? `正在同步 ${state.healthSyncProgress}%`
          : state.boundDevice && state.boundDevice.lastHealthSyncAt
            ? `上次同步 ${formatTime(state.boundDevice.lastHealthSyncAt)}`
            : "下拉同步全部健康数据"
      });
    });
  },

  onShow() {
    const app = getApp()
    if (getRoleEntry(app.globalData.activeRole).type === 'H5') {
      this.redirectDoctorWorkspace()
      return
    }
    if (app.globalData.cdmsBaseUrl && !app.globalData.accessToken) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    const state = bleManager.snapshot();
    this.setData({ healthCards: getHealthCards(state.boundDevice, state.realtimeHealth) });
    // 消息未读数角标
    this.refreshUnreadCount();
    // 定时同步：前台期间按 15 分钟周期静默同步
    bleManager.scheduleAutoSync();
    const bound = state.boundDevice;
    if (bound && !state.healthSyncing) {
      const lastAt = bound.lastHealthSyncAt || state.lastHealthSyncAt || 0;
      if (!lastAt || Date.now() - lastAt > AUTO_SYNC_STALE_MS) {
        bleManager.safeAutoSync().catch(() => {});
      }
    }
  },

  onHide() {
    bleManager.stopAutoSync();
  },

  onUnload() {
    bleManager.stopAutoSync();
    if (this.unsubscribe) this.unsubscribe();
  },

  async refreshUnreadCount () {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) return
    try {
      const response = await api.cdmsRequest('/api/v1/messages/unread-count', 'GET', null, app.globalData.accessToken)
      const data = unwrapData(response)
      const count = data && typeof data.count === 'number' ? data.count : 0
      this.setData({ messagesUnread: count > 0 ? count : 0 })
    } catch (error) {
      console.warn('[CDMS] 未读消息数获取失败', error)
    }
  },

  async onPullDownRefresh() {
    const state = bleManager.snapshot();
    if (!state.boundDevice) {
      wx.stopPullDownRefresh();
      wx.showToast({ title: "请先绑定设备", icon: "none" });
      return;
    }
    try {
      if (!state.connected) await bleManager.reconnect();
      const result = await bleManager.syncAllHealthData();
      const latestState = bleManager.snapshot();
      this.setData({ healthCards: getHealthCards(latestState.boundDevice, latestState.realtimeHealth) });
      wx.showToast({
        title: result.uploadError
          ? "已保存本地，待上传"
          : result.failedTypes.length
            ? `同步完成，${result.failedTypes.length}项失败`
            : "同步完成",
        icon: result.uploadError || result.failedTypes.length ? "none" : "success",
      });
      this.setData({
        cdmsQueue: api.readQueue().length,
        cdmsStatus: result.uploadError ? "IoT 暂不可用，数据已保留在待上传队列" : "已同步到 CDMS"
      });
    } catch (error) {
      wx.showToast({ title: error.message || "同步失败", icon: "none" });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  openSearch() {
    wx.navigateTo({ url: "/pages/search/search" });
  },

  openDevice() {
    wx.switchTab({ url: "/pages/device/device" });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录，当前设备连接会断开。',
      confirmText: '退出',
      confirmColor: '#0c9b6c',
      success: async (result) => {
        if (!result.confirm) return
        const app = getApp()
        try {
          await api.logout()
        } catch (error) {
          // 网络异常时仍然清理本地会话，避免用户被卡在当前账号。
          console.warn('[CDMS] logout request failed', error)
        }
        try {
          await bleManager.disconnectForLogout()
        } catch (error) {
          console.warn('[CDMS BLE] disconnect on logout failed', error)
        }
        app.clearAuth()
        wx.reLaunch({ url: '/pages/auth/login' })
      }
    })
  },

  openHistory(event) {
    const type = event.currentTarget.dataset.type;
    if (type === "workout") {
      wx.navigateTo({ url: "/pages/workout/workout" });
      return;
    }
    wx.navigateTo({ url: `/pages/history/history?type=${type}` });
  },

  async openCdmsWorkspace () {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    const targetPath = app.globalData.activeRole === 'DOCTOR' ? '/h5/patients' : '/h5/followups'
    try {
      const response = await api.createHandoff(targetPath)
      const handoff = response?.data || response
      if (!handoff?.handoffUrl) throw new Error('未取得 H5 安全地址')
      wx.navigateTo({ url: `/pages/h5/index?url=${encodeURIComponent(handoff.handoffUrl)}` })
    } catch (error) {
      wx.showToast({ title: error.message || '打开业务工作台失败', icon: 'none' })
    }
  },

  async openWorkspaceEntry (event) {
    const entry = (this.data.workspaceEntries || []).find(item => item.key === event.currentTarget.dataset.key)
    if (!entry) return
    if (entry.type === 'NATIVE') {
      if (TAB_PAGES.includes(entry.url)) wx.switchTab({ url: entry.url })
      else wx.navigateTo({ url: entry.url })
      return
    }
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    try {
      // 个人档案：先用 /me 拿 patientId，再拼接 360 档案地址（其余 H5 入口保持原 targetPath）
      let targetPath = entry.targetPath
      if (entry.key === 'profile') {
        const meResponse = await api.cdmsRequest('/api/v1/miniapp/auth/me', 'GET', null, app.globalData.accessToken)
        const me = unwrapData(meResponse)
        const patientId = me && me.patientId
        if (!patientId) throw new Error('未取得患者档案信息')
        targetPath = `/patient/${patientId}/360`
      }
      if (!targetPath) throw new Error('该入口暂不可用')
      const response = await api.createHandoff(targetPath)
      const handoff = response?.data || response
      if (!handoff?.handoffUrl) throw new Error('未取得 H5 安全地址')
      wx.navigateTo({ url: `/pages/h5/index?url=${encodeURIComponent(handoff.handoffUrl)}` })
    } catch (error) {
      wx.showToast({ title: error.message || '打开业务入口失败', icon: 'none' })
    }
  },

  async redirectDoctorWorkspace () {
    if (this.workspaceOpening) return
    const app = getApp()
    if (!app.globalData.accessToken || !app.globalData.cdmsBaseUrl) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    this.workspaceOpening = true
    try {
      const response = await api.createHandoff('/h5/patients')
      const handoff = response?.data || response
      if (!handoff?.handoffUrl) throw new Error('未取得医生工作台地址')
      wx.redirectTo({ url: `/pages/h5/index?url=${encodeURIComponent(handoff.handoffUrl)}` })
    } catch (error) {
      this.workspaceOpening = false
      wx.showToast({ title: error.message || '打开医生工作台失败', icon: 'none' })
    }
  }
});
