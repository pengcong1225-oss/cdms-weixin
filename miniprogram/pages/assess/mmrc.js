const { MMRC_OPTIONS, mmrcLevel, addHistory } = require('../../../utils/assess-rules')

Page({
  data: { options: [], selected: -1, finished: false, result: null },
  onLoad () {
    this.setData({ options: MMRC_OPTIONS })
  },
  selectOption (event) {
    const grade = Number(event.currentTarget.dataset.grade)
    this.setData({ selected: grade })
    const result = mmrcLevel(grade)
    addHistory({ type: 'MMRC', score: grade, level: result.level, isHighRisk: result.isHighRisk })
    this.setData({ finished: true, result })
  },
  restart () { this.setData({ selected: -1, finished: false, result: null }) },
  goHome () { wx.switchTab({ url: '/pages/home/home' }) },
  goHistory () { wx.navigateTo({ url: '/pages/assess/history' }) }
})
