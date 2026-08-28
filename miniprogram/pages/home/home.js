const bleManager = require("../../services/bleManager");
const { getHealthCards } = require("../../utils/capabilities");
const { formatTime } = require("../../utils/format");
const api = require("../../utils/api");
const { ensureSession } = require("../../utils/auth-guard");
const { getWorkspaceEntries } = require("../../utils/workspace-entry");

function openNativeUrl (url) {
  const tabPages = ['/pages/home/home', '/pages/device/device']
  if (tabPages.includes(url)) {
    wx.switchTab({ url })
    return
  }
  wx.navigateTo({ url })
}

Page({
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

  async onLoad() {
    const app = getApp()
    const session = await this.ensureRestoredSession()
    if (!session) return
    const activeRole = app.globalData.activeRole || ''
    this.setData({ activeRole, workspaceEntries: getWorkspaceEntries(activeRole) })
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

  async onShow() {
    const app = getApp()
    const session = await this.ensureRestoredSession()
    if (!session) return
    const state = bleManager.snapshot();
    this.setData({ healthCards: getHealthCards(state.boundDevice, state.realtimeHealth) });
  },

  async ensureRestoredSession() {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl) return app.globalData
    try {
      return await ensureSession({ redirect: false })
    } catch (error) {
      if (error?.reauthRequired || !app.globalData.refreshToken) {
        wx.reLaunch({ url: '/pages/auth/login' })
      } else {
        wx.showToast({ title: error.message || '登录状态恢复失败', icon: 'none' })
      }
      return null
    }
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
        const entries = getWorkspaceEntries(app.globalData.activeRole)
        this.setData({
          activeRole: app.globalData.activeRole,
          workspaceEntries: entries
        })
        const nativeEntry = entries.find(item => item.type === 'NATIVE' && item.url)
        if (session.activeRole === 'DOCTOR' && nativeEntry) {
          wx.reLaunch({ url: nativeEntry.url })
          return
        }
        wx.showToast({ title: '身份已切换', icon: 'success' })
      } catch (error) { wx.showToast({ title: error.message || '切换失败', icon: 'none' }) }
    }})
  },

  async openWorkspaceEntry (event) {
    const entry = (this.data.workspaceEntries || []).find(item => item.key === event.currentTarget.dataset.key)
    if (!entry) return
    if (entry.type === 'NATIVE') {
      openNativeUrl(entry.url)
      return
    }
    if (entry.type === 'COPY' && entry.copyText) {
      wx.setClipboardData({
        data: entry.copyText,
        success: () => wx.showToast({ title: '问卷地址已复制', icon: 'success' })
      })
      return
    }
    wx.showToast({ title: '功能准备中', icon: 'none' })
  }
});
