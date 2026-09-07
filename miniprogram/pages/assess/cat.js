const { CAT_QUESTIONS, CAT_OPTIONS, catLevel, addHistory } = require('../../utils/assess-rules')

Page({
  data: {
    questions: [],
    options: [],
    currentIndex: 0,
    answers: [],
    selected: -1,
    finished: false,
    result: null,
    progressText: '第 1/8 题'
  },
  onLoad () {
    this.setData({
      questions: CAT_QUESTIONS,
      options: CAT_OPTIONS,
      answers: new Array(CAT_QUESTIONS.length).fill(-1)
    })
  },
  selectOption (event) {
    const score = Number(event.currentTarget.dataset.score)
    const index = this.data.currentIndex
    const answers = this.data.answers.slice()
    answers[index] = score
    this.setData({ answers, selected: score })
    const nextIndex = index + 1
    if (nextIndex >= CAT_QUESTIONS.length) {
      this.finish(answers)
      return
    }
    setTimeout(() => {
      this.setData({
        currentIndex: nextIndex,
        selected: answers[nextIndex],
        progressText: '第 ' + (nextIndex + 1) + '/' + CAT_QUESTIONS.length + ' 题'
      })
    }, 180)
  },
  prevQuestion () {
    const index = this.data.currentIndex
    if (index <= 0) return
    this.setData({
      currentIndex: index - 1,
      selected: this.data.answers[index - 1],
      progressText: '第 ' + index + '/' + CAT_QUESTIONS.length + ' 题'
    })
  },
  finish (answers) {
    const total = answers.reduce((sum, value) => sum + (value >= 0 ? value : 0), 0)
    const result = catLevel(total)
    addHistory({ type: 'CAT', score: total, level: result.level, isHighRisk: result.isHighRisk, answers: answers.slice() })
    this.setData({ finished: true, result })
  },
  restart () {
    this.setData({
      currentIndex: 0,
      answers: new Array(CAT_QUESTIONS.length).fill(-1),
      selected: -1,
      finished: false,
      result: null,
      progressText: '第 1/' + CAT_QUESTIONS.length + ' 题'
    })
  },
  goHome () { wx.switchTab({ url: '/pages/home/home' }) },
  goHistory () { wx.navigateTo({ url: '/pages/assess/history' }) }
})
