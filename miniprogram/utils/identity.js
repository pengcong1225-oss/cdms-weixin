// 身份证解析（与 cdmsManager H5 的 screening identity 算法一致）：
// 15/18 位格式 + 18 位校验位 + 出生日期合法性，成功时回填性别与生日。
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']

function normalizeIdCard (value) {
  return String(value == null ? '' : value).replace(/\s/g, '').toUpperCase()
}

function parseIdentityCard (value) {
  const idCard = normalizeIdCard(value)
  if (!/^\d{15}$/.test(idCard) && !/^\d{17}[0-9X]$/.test(idCard)) return null

  if (idCard.length === 18) {
    const sum = idCard.slice(0, 17).split('').reduce((total, digit, index) => {
      return total + Number(digit) * ID_WEIGHTS[index]
    }, 0)
    if (ID_CHECK_CODES[sum % 11] !== idCard[17]) return null
  }

  const dateText = idCard.length === 18 ? idCard.slice(6, 14) : '19' + idCard.slice(6, 12)
  const year = Number(dateText.slice(0, 4))
  const month = Number(dateText.slice(4, 6))
  const day = Number(dateText.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  const today = new Date()
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getTime() > todayUtc) {
    return null
  }

  const genderIndex = idCard.length === 18 ? 16 : 14
  return {
    idCard,
    birthday: dateText.slice(0, 4) + '-' + dateText.slice(4, 6) + '-' + dateText.slice(6, 8),
    gender: Number(idCard[genderIndex]) % 2 === 1 ? 1 : 2
  }
}

module.exports = { normalizeIdCard, parseIdentityCard }
