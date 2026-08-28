function getRoleEntry (activeRole) {
  if (activeRole === 'DOCTOR') return { type: 'H5', targetPath: '/h5/patients' }
  if (activeRole === 'PATIENT') return { type: 'HOME' }
  return { type: 'LOGIN' }
}

function canEnterRole (session) {
  const activeRole = session?.activeRole
  if (activeRole !== 'DOCTOR' && activeRole !== 'PATIENT') return false
  const roles = Array.isArray(session.roles) ? session.roles : []
  if (!roles.length) return true
  return roles.some(role => role && role.roleType === activeRole)
}

module.exports = { getRoleEntry, canEnterRole }
