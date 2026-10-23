const runtimeConfig = require('../../config/runtime')

// 建档问卷是 cdmsManager 既有 H5（慢阻肺筛查问卷），小程序这边只做 web-view 承载。
// 安全约束：只允许打开受信任的问卷域名，且必须是 https —— 避免 web-view 变成任意网页容器。
const ARCHIVE_HOSTS = ['jq.mockr.com.cn', 'mzf.jiaqiaokeji.com']
// 小程序基础库没有标准 URL 构造器，这里用正则拆 https 地址（比 new URL 兼容）。
const HTTPS_URL = /^https:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/

// 小程序框架通常已对 query 解码一次；开发者工具/分享链接仍可能带编码值，
// 这里按需再解一次（与 app.applyBridgeQuery 同一口径，避免二次解码破坏地址）。
function decodeMaybe (value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    return /%3A|%2F|%25/i.test(text) ? decodeURIComponent(text) : text
  } catch (_) {
    return text
  }
}

function resolveArchiveUrl (override) {
  const candidate = decodeMaybe(override) || String(runtimeConfig.archiveQuestionnaireUrl || '').trim()
  if (!candidate) throw new Error('未配置建档问卷地址')
  const matched = HTTPS_URL.exec(candidate)
  if (!matched) throw new Error('建档问卷地址必须使用 https')
  // host 可能带端口（如 jq.mockr.com.cn:443），比对时只取主机名。
  const hostname = matched[1].split(':')[0].toLowerCase()
  if (ARCHIVE_HOSTS.indexOf(hostname) < 0) throw new Error('建档问卷域名不在允许范围内')
  return candidate
}

Page({
  data: { src: '', error: '' },

  onLoad (query) {
    this.finishedHintShown = false
    this.entered = false
    try {
      this.setData({ src: resolveArchiveUrl(query && query.url), error: '' })
    } catch (error) {
      this.setData({ src: '', error: (error && error.message) || '建档问卷地址无效' })
    }
  },

  // web-view 里的 H5 无法直接回传「已提交」，用返回时机做一次性轻提示：
  // 首次 onShow 是进入本页，之后再次 onShow 才是从问卷返回。
  onShow () {
    if (!this.data.src) return
    if (!this.entered) {
      this.entered = true
      return
    }
    if (this.finishedHintShown) return
    this.finishedHintShown = true
    wx.showModal({
      title: '填写完成了吗？',
      content: '如已提交建档问卷，可直接返回登录页，用患者姓名和 11 位手机号登录。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
