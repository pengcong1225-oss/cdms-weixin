const api = require('../../utils/api')

function unwrapData (response) {
  return response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

Page({
  data: { busy: false, doctorName: '', doctorPhone: '' },

  async callDoctor () {
    if (this.data.busy) return
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      wx.reLaunch({ url: '/pages/auth/login' })
      return
    }
    this.setData({ busy: true })
    try {
      // 1) /me 拿 patientId
      const meResponse = await api.cdmsRequest('/api/v1/miniapp/auth/me', 'GET', null, app.globalData.accessToken)
      const me = unwrapData(meResponse)
      const patientId = me && me.patientId
      if (!patientId) throw new Error('未取得患者身份，无法获取医生信息')
      // 2) 患者 360 拿建档医生姓名与电话（后端已保证返回 doctorName/doctorPhone）
      const response = await api.cdmsRequest('/api/v1/patients/' + encodeURIComponent(String(patientId)) + '/360', 'GET', null, app.globalData.accessToken)
      const data = unwrapData(response)
      const orgInfo = data && data.detail && data.detail.orgInfo
      const doctorName = orgInfo && orgInfo.doctorName
      const doctorPhone = orgInfo && orgInfo.doctorPhone
      this.setData({ doctorName: doctorName || '', doctorPhone: doctorPhone || '' })
      if (!doctorPhone) {
        wx.showToast({ title: '暂无医生联系方式，请于工作时间联系医院', icon: 'none' })
        return
      }
      // 3) 确认后拨号
      wx.showModal({
        title: '紧急求助',
        content: doctorName ? '将呼叫医生 ' + doctorName + '（' + doctorPhone + '）？' : '将呼叫建档医生（' + doctorPhone + '）？',
        confirmText: '呼叫',
        confirmColor: '#cf3f3f',
        success: (result) => {
          if (!result.confirm) return
          wx.makePhoneCall({
            phoneNumber: String(doctorPhone),
            fail: () => { wx.showToast({ title: '呼叫失败，请稍后重试', icon: 'none' }) }
          })
        }
      })
    } catch (error) {
      wx.showToast({ title: error.message || '加载医生信息失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  }
})
