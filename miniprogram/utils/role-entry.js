function getRoleEntry (activeRole) {
  if (activeRole === 'DOCTOR') return { type: 'H5', targetPath: '/h5/patients' }
  if (activeRole === 'PATIENT') return { type: 'HOME' }
  return { type: 'LOGIN' }
}

module.exports = { getRoleEntry }
