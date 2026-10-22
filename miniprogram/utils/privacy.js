// 患者《隐私政策》同意记录（2026-10-22 需求）。
// 政策原文：「您首次使用本小程序并勾选同意，即视为您已充分阅读、理解并接受本政策全部内容」
// → 首次同意后记住；政策版本升级（PRIVACY_VERSION 变化）时必须重新同意。
const PRIVACY_VERSION = '2026-10'
const PRIVACY_STORAGE_KEY = 'jq_privacy_agreed_version'

function readAgreedVersion () {
  try {
    const value = wx.getStorageSync(PRIVACY_STORAGE_KEY)
    return String(value || '')
  } catch (_) {
    return ''
  }
}

// 只有「记录版本 === 当前版本」才算已同意；旧版本（政策已更新）必须重新勾选。
function isPrivacyAgreed () {
  return readAgreedVersion() === PRIVACY_VERSION
}

// 只有同意才写 storage（未勾选不写）。
function rememberPrivacyAgreed () {
  try { wx.setStorageSync(PRIVACY_STORAGE_KEY, PRIVACY_VERSION) } catch (_) { /* best-effort */ }
}

// 撤回同意 = 清掉记录；登录页返回后不会再自动勾选。
function forgetPrivacyAgreed () {
  try {
    if (typeof wx.removeStorageSync === 'function') wx.removeStorageSync(PRIVACY_STORAGE_KEY)
    else wx.setStorageSync(PRIVACY_STORAGE_KEY, '')
  } catch (_) { /* best-effort */ }
}

module.exports = {
  PRIVACY_VERSION,
  PRIVACY_STORAGE_KEY,
  readAgreedVersion,
  isPrivacyAgreed,
  rememberPrivacyAgreed,
  forgetPrivacyAgreed
}
