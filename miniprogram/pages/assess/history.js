const { getHistory, catLevel, mmrcLevel } = require('../../../utils/assess-rules')

function pad (value) { return String(value).padStart(2, '0') }

function formatCreatedAt (timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (isNaN(date.getTime())) return ''
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

Page({
  data: { list: [] },
  onShow () { this.load() },
  load () {
    const list = getHistory().map((item) => Object.assign({}, item, {
      title: item.type === 'CAT' ? 'CAT 问卷' : 'mMRC 分级',
      summary: item.type === 'CAT'
        ? (item.score + ' 分 · ' + item.level)
        : (item.score + ' 级 · ' + item.level),
      timeText: formatCreatedAt(item.createdAt)
    }))
    this.setData({ list })
  },
  openDetail (event) {
    const item = this.data.list[event.currentTarget.dataset.index]
    if (!item) return
    const level = item.type === 'CAT' ? catLevel(item.score) : mmrcLevel(item.score)
    const scoreLine = item.type === 'CAT' ? (item.score + ' 分') : ('mMRC ' + item.score + ' 级')
    wx.showModal({
      title: item.title + '结果解读',
      content: '得分：' + scoreLine + '\n分级：' + level.level + (level.isHighRisk ? '（高风险）' : '') + '\n' + level.advice,
      showCancel: false,
      confirmText: '知道了'
    })
  },
  clearHistory () {
    wx.showModal({
      title: '清空自测历史',
      content: '确定删除全部本地自测记录吗？',
      confirmText: '删除',
      confirmColor: '#cf3f3f',
      success: (result) => {
        if (!result.confirm) return
        try { wx.removeStorageSync('cdms.selfAssess.history') } catch (_) {}
        this.load()
        wx.showToast({ title: '已清空', icon: 'success' })
      }
    })
  }
})
