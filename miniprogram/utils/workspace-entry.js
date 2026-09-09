function getWorkspaceEntries (activeRole) {
  if (activeRole === 'DOCTOR') {
    return [
      { key: 'patients', title: '患者工作台', subtitle: '进入医生 H5 患者列表', type: 'H5', targetPath: '/h5/patients' },
      { key: 'device', title: '设备中心', subtitle: '在小程序中查看设备与同步状态', type: 'NATIVE', url: '/pages/device/device' }
    ]
  }
  if (activeRole === 'PATIENT') {
    return [
      // 健康档案：原生页面聚合本人档案信息与随访记录，不走 H5 handoff/web-view，避免身份切换问题
      { key: 'healthRecord', title: '健康档案', subtitle: '本人档案信息与随访记录', type: 'NATIVE', url: '/pages/health-record/index' },
      { key: 'assess', title: '健康自测', subtitle: 'CAT 问卷与 mMRC 分级自评', type: 'NATIVE', url: '/pages/assess/index' },
      { key: 'checkin', title: '扫一扫签到', subtitle: '扫码完成患者签到', type: 'NATIVE', url: '/pages/scale-checkin/index' },
      { key: 'messages', title: '消息中心', subtitle: '查看随访提醒与系统消息', type: 'NATIVE', url: '/pages/messages/index' },
      { key: 'emergency', title: '紧急求助', subtitle: '一键呼叫建档医生', type: 'NATIVE', url: '/pages/emergency/index' },
      { key: 'device', title: '设备中心', subtitle: '在小程序中连接与同步设备', type: 'NATIVE', url: '/pages/device/device' }
    ]
  }
  return []
}

module.exports = { getWorkspaceEntries }
