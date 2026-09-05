// 健康自测规则与本地历史存取：CAT 问卷 / mMRC 分级。
// 用户最终确认：CAT 高危判定为 score > 16（不是 >= 10）。
const HISTORY_KEY = 'cdms.selfAssess.history'
const HISTORY_LIMIT = 100

// 标准 CAT 八问（0-5 分），question 为“无影响”端，worst 为“影响极大”端
const CAT_QUESTIONS = [
  { id: 'cough', question: '我从不咳嗽', worst: '我总是在咳嗽' },
  { id: 'phlegm', question: '我一点痰也没有', worst: '我有很多很多的痰' },
  { id: 'chest', question: '我没有任何胸闷的感觉', worst: '我有很严重的胸闷感觉' },
  { id: 'climb', question: '当我爬坡或爬一层楼梯时，我并不感到喘不过气来', worst: '当我爬坡或爬一层楼梯时，我感觉喘不过气来' },
  { id: 'home', question: '我在家里的任何活动都不受慢阻肺的影响', worst: '我在家里的任何活动都很受慢阻肺的影响' },
  { id: 'confidence', question: '尽管我有肺病，我还是有信心外出', worst: '因为我有肺病，对于外出我完全没有信心' },
  { id: 'sleep', question: '我的睡眠非常好', worst: '因为我有肺病，我的睡眠非常差' },
  { id: 'energy', question: '我有精力外出', worst: '因为我有肺病，我一点精力都没有' }
]

const CAT_OPTIONS = [0, 1, 2, 3, 4, 5].map(score => ({
  score,
  label: score === 0 ? '0分 无影响' : score === 5 ? '5分 影响极大' : score + '分'
}))

const MMRC_OPTIONS = [
  { grade: 0, label: '0级', text: '仅在剧烈活动时气促' },
  { grade: 1, label: '1级', text: '平地快步或爬小坡时气促' },
  { grade: 2, label: '2级', text: '平地走因气促比同龄人慢或需停下来歇' },
  { grade: 3, label: '3级', text: '平地步行约100米或数分钟后需停下歇' },
  { grade: 4, label: '4级', text: '不能出门/穿衣梳头就气促' }
]

function catLevel (score) {
  const value = Number(score) || 0
  let level = '轻微'
  if (value > 30) level = '极重'
  else if (value > 20) level = '严重'
  else if (value > 10) level = '中等'
  return {
    score: value,
    level,
    range: value <= 10 ? '0-10' : value <= 20 ? '11-20' : value <= 30 ? '21-30' : '31-40',
    isHighRisk: value > 16,
    advice: value > 16
      ? '您的 CAT 得分较高，症状影响明显。建议尽快联系您的医生，不要自行调整用药。'
      : '您的 CAT 得分尚在可控范围，请继续保持规律随访与康复锻炼。'
  }
}

function mmrcLevel (grade) {
  const value = Number(grade) || 0
  return {
    grade: value,
    level: value >= 2 ? '呼吸困难明显' : '轻',
    isHighRisk: value >= 2,
    advice: value >= 2
      ? 'mMRC 2 级及以上提示呼吸困难明显，建议与医生沟通评估治疗方案。'
      : 'mMRC 0-1 级提示气促程度较轻，请坚持规范治疗与随访。'
  }
}

function getHistory () {
  try {
    const list = wx.getStorageSync(HISTORY_KEY)
    return Array.isArray(list) ? list : []
  } catch (_) {
    return []
  }
}

// 每条 {type:'CAT'|'MMRC', score, level, isHighRisk?, answers?, createdAt}，新增在前，上限 100 条
function addHistory (record) {
  const list = getHistory()
  const next = [Object.assign({ createdAt: Date.now() }, record), ...list].slice(0, HISTORY_LIMIT)
  try {
    wx.setStorageSync(HISTORY_KEY, next)
  } catch (_) {
    // 存储不可用时静默失败，不影响答题流程
  }
  return next
}

module.exports = { CAT_QUESTIONS, CAT_OPTIONS, MMRC_OPTIONS, HISTORY_KEY, HISTORY_LIMIT, catLevel, mmrcLevel, getHistory, addHistory }
