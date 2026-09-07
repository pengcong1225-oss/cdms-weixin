function getWorkspaceEntries (activeRole) {
  if (activeRole === 'DOCTOR') {
    return [
      { key: 'patients', title: '患者工作台', subtitle: '进入医生 H5 患者列表', type: 'H5', targetPath: '/h5/patients' },
      { key: 'device', title: '设备中心', subtitle: '在小程序中查看设备与同步状态', type: 'NATIVE', url: '/pages/device/device' }
    ]
  }
  if (activeRole === 'PATIENT') {
    return [
      // targetPath 在打开时根据 /me 返回的 patientId 动态拼接，故定义中留空
      { key: 'profile', title: '个人档案', subtitle: '查看病历、用药与随访档案', type: 'H5', targetPath: '' },
      { key: 'followups', title: '随访记录', subtitle: '查看本人随访与健康报告', type: 'H5', targetPath: '/h5/followups' },
      // 健康监测：与个人档案一致，targetPath 在打开时根据 /me 返回的 patientId 动态拼接，故定义中留空
      { key: 'mymonitoring', title: '健康监测', subtitle: '查看本人指环监测与预警', type: 'H5', targetPath: '' },
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
