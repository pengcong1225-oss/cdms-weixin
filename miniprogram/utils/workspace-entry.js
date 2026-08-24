function getWorkspaceEntries (activeRole) {
  if (activeRole === 'DOCTOR') {
    return [
      { key: 'patients', title: '患者工作台', subtitle: '进入医生 H5 患者列表', type: 'H5', targetPath: '/' },
      { key: 'device', title: '设备中心', subtitle: '在小程序中查看设备与同步状态', type: 'NATIVE', url: '/pages/device/device' }
    ]
  }
  if (activeRole === 'PATIENT') {
    return [
      { key: 'followups', title: '随访记录', subtitle: '查看本人随访与健康报告', type: 'H5', targetPath: '/history' },
      { key: 'device', title: '设备中心', subtitle: '在小程序中连接与同步设备', type: 'NATIVE', url: '/pages/device/device' }
    ]
  }
  return []
}

module.exports = { getWorkspaceEntries }
