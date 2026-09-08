// 角色入口解析（§6.3 / §8.2）：根据当前 activeRole 决定登录后落地页。
// 入参可能是角色字符串，也可能是整份会话对象；统一规整为字符串后再判定。
function resolveActiveRole (input) {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const nested = input.activeRole || (input.session && input.session.activeRole)
    return typeof nested === 'string' ? nested : ''
  }
  return ''
}

function getRoleEntry (activeRole) {
  const role = resolveActiveRole(activeRole)
  if (role === 'DOCTOR') return { type: 'H5', targetPath: '/h5/patients' }
  if (role === 'PATIENT') return { type: 'HOME' }
  // 未知角色一律回登录页，绝不落入无宿主的 H5 死路（§8.2）。
  return { type: 'LOGIN' }
}

module.exports = { getRoleEntry, resolveActiveRole }