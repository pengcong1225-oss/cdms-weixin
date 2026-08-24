const bleManager = require("../../services/bleManager");
const { getHealthCards } = require("../../utils/capabilities");
const { formatTime } = require("../../utils/format");
const api = require("../../utils/api");
const { getRoleEntry } = require("../../utils/role-entry");
const { getWorkspaceEntries } = require("../../utils/workspace-entry");

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
    workspaceEntries: []
  },

  onLoad() {
    const app = getApp()
    const activeRole = app.globalData.activeRole || ''
    this.setData({ activeRole, workspaceEntries: getWorkspaceEntries(activeRole) })
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
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe();
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
          await bleManager.unbind()
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

  async switchRole () {
    const app = getApp()
    const roles = app.globalData.roles || []
    if (!roles.length) return
    const labels = roles.map(role => role.roleType === 'DOCTOR' ? '医生' : '患者')
    wx.showActionSheet({ itemList: labels, success: async result => {
      const role = roles[result.tapIndex]
      if (!role || role.roleType === app.globalData.activeRole) return
      try {
        const response = await api.switchRole(role.roleType)
        const session = response?.data || response
        app.saveAuth(session)
        if (getRoleEntry(session.activeRole).type === 'H5') {
          await this.redirectDoctorWorkspace()
          return
        }
        this.setData({
          activeRole: app.globalData.activeRole,
          workspaceEntries: getWorkspaceEntries(app.globalData.activeRole)
        })
        wx.showToast({ title: '身份已切换', icon: 'success' })
      } catch (error) { wx.showToast({ title: error.message || '切换失败', icon: 'none' }) }
    }})
  },

  async openCdmsWorkspace () {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    const targetPath = app.globalData.activeRole === 'DOCTOR' ? '/' : '/history'
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
      wx.switchTab({ url: entry.url })
      return
    }
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    try {
      const response = await api.createHandoff(entry.targetPath)
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
      const response = await api.createHandoff('/')
      const handoff = response?.data || response
      if (!handoff?.handoffUrl) throw new Error('未取得医生工作台地址')
      wx.redirectTo({ url: `/pages/h5/index?url=${encodeURIComponent(handoff.handoffUrl)}` })
    } catch (error) {
      this.workspaceOpening = false
      wx.showToast({ title: error.message || '打开医生工作台失败', icon: 'none' })
    }
  }
});
