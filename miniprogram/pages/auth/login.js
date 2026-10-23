const api = require('../../utils/api')
const { getRoleEntry } = require('../../utils/role-entry')
const { isPrivacyAgreed, rememberPrivacyAgreed, forgetPrivacyAgreed } = require('../../utils/privacy')

Page({
  data: { mode: 'doctor', username: '', password: '', realName: '', phone: '', loading: false, restoring: false, roleSelectionRequired: false, roles: [], privacyAgreed: false },
  onLoad (query) {
    const app = getApp()
    if (query?.cdmsBaseUrl) app.globalData.cdmsBaseUrl = query.cdmsBaseUrl
    // 2026-10-22：首次同意过且政策版本未变 → 自动勾选（政策原文「首次使用并勾选同意」）。
    this.syncPrivacyAgreed()
  },
  onShow () {
    // 从《隐私政策》页点「我已阅读并同意」返回后，这里重读 storage → 自动勾选。
    this.syncPrivacyAgreed()
    // 冷启动（如杀掉微信进程后重进）总是落在入口页=本页；
    // 本地会话仍有效时静默重签并直接进入，避免"登录态失效"的假象。
    this.tryRestoreSession()
  },
  // 从 storage 同步患者同意状态（记录版本 === 当前政策版本才算同意）。
  syncPrivacyAgreed () {
    this.setData({ privacyAgreed: isPrivacyAgreed() })
  },
  // 原生 checkbox 必须走 checkbox-group 的 bindchange（受控）：
  // 只有 change 事件能保证「原生勾选态 ↔ data ↔ storage」三者一致；
  // 用 bindtap 会出现「原生已切换、data 没变」或「data 变了、原生没同步」。
  onPrivacyChange (event) {
    const values = event && event.detail ? event.detail.value : []
    const agreed = Array.isArray(values) && values.includes('agree')
    this.setData({ privacyAgreed: agreed })
    if (agreed) rememberPrivacyAgreed()
    else forgetPrivacyAgreed()
  },
  // 便捷切换（非原生入口/测试用）：勾选写同意记录，取消即撤回（清记录）。
  togglePrivacyAgree () {
    const next = !this.data.privacyAgreed
    this.setData({ privacyAgreed: next })
    if (next) rememberPrivacyAgreed()
    else forgetPrivacyAgreed()
  },
  // 打开《隐私政策》全文页。
  openPrivacy () {
    wx.navigateTo({ url: '/pages/privacy/index' })
  },
  // 未建档患者入口：复用 cdmsManager 既有 H5 建档问卷（提交即创建患者档案）。
  // 未登录也可进入 —— 问卷侧按机构签发一次性 token，不依赖小程序会话。
  openArchive () {
    if (this.data.loading) return
    wx.navigateTo({
      url: '/pages/archive/index',
      fail: () => { wx.showToast({ title: '打开建档问卷失败，请稍后重试', icon: 'none' }) }
    })
  },
  async tryRestoreSession () {
    if (this.restoreAttempted) return
    const app = getApp()
    const auth = app?.globalData || {}
    if (!String(auth.refreshToken || '').trim()) return
    if (auth.activeRole !== 'PATIENT' && auth.activeRole !== 'DOCTOR') return
    this.restoreAttempted = true
    this.setData({ restoring: true })
    try {
      await api.refreshAccessToken()
      await this.enterRole({ activeRole: app.globalData.activeRole })
    } catch (error) {
      // 仅 401（refresh 过期/账号失效）清除会话；网络失败保留会话，用户仍可手动登录。
      if (error && error.statusCode === 401) {
        try { require('../../utils/auth-guard').purgeSession(app) } catch (_) { /* noop */ }
      }
      this.setData({ restoring: false })
    }
  },
  selectMode (event) { this.setData({ mode: event.currentTarget.dataset.mode, roleSelectionRequired: false, roles: [] }) },
  onUsername (e) { this.setData({ username: e.detail.value }) },
  onPassword (e) { this.setData({ password: e.detail.value }) },
  onRealName (e) { this.setData({ realName: e.detail.value }) },
  onPhone (e) { this.setData({ phone: e.detail.value }) },
  async login () {
    // 2026-10-22 患者隐私政策：必须在任何接口调用之前校验 —— 未勾选只提示、不发请求。
    if (this.data.mode === 'patient' && !this.data.privacyAgreed) {
      wx.showToast({ title: '请先阅读并同意《隐私政策》', icon: 'none' }); return
    }
    if (this.data.mode === 'doctor' && (!this.data.username.trim() || !this.data.password)) {
      wx.showToast({ title: '请输入医生账号和密码', icon: 'none' }); return
    }
    if (this.data.mode === 'patient') {
      const realName = String(this.data.realName || '').trim()
      if (realName.length < 2 || !/^1\d{10}$/.test(String(this.data.phone || ''))) {
        wx.showToast({ title: '请输入患者姓名和已建档的 11 位手机号', icon: 'none' }); return
      }
    }
    this.setData({ loading: true })
    try {
      const response = this.data.mode === 'doctor'
        ? await api.loginDoctor({ username: this.data.username, password: this.data.password })
        : await api.loginPatient({ realName: String(this.data.realName || '').trim(), phone: this.data.phone })
      const session = response?.data || response
      const app = getApp()
      app.saveAuth(session)
      if (session.roleSelectionRequired) {
        this.setData({ roleSelectionRequired: true, roles: session.roles || [] })
      } else {
        await this.enterRole(session)
      }
    } catch (error) {
      wx.showToast({ title: error.message || '登录失败', icon: 'none' })
    } finally { this.setData({ loading: false }) }
  },
  async selectRole (event) {
    const roleType = event.currentTarget.dataset.role
    try {
      const response = await api.switchRole(roleType)
      const session = response?.data || response
      getApp().saveAuth(session)
      await this.enterRole(session)
    } catch (error) { wx.showToast({ title: error.message || '角色切换失败', icon: 'none' }) }
  },
  async enterRole (session) {
    const entry = getRoleEntry(session?.activeRole)
    if (entry.type === 'H5') {
      const response = await api.createHandoff(entry.targetPath)
      const handoff = response?.data || response
      if (!handoff?.handoffUrl) throw new Error('未取得医生工作台地址')
      wx.redirectTo({ url: `/pages/h5/index?url=${encodeURIComponent(handoff.handoffUrl)}` })
      return
    }
    if (entry.type === 'HOME') {
      wx.reLaunch({ url: '/pages/home/home' })
      return
    }
    wx.reLaunch({ url: '/pages/auth/login' })
  }
})
