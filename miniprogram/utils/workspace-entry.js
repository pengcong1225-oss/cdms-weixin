const PUBLIC_SCREENING_URL = 'https://jq.mockr.com.cn/mzf-sq/#/screen'

function getWorkspaceEntries (activeRole) {
  if (activeRole === 'DOCTOR') {
    return [
      { key: 'doctor-workspace', title: '医生工作台', subtitle: '患者管理、随访和设备工作站入口', type: 'NATIVE', url: '/pages/doctor/workspace/index' }
    ]
  }
  if (activeRole === 'PATIENT') {
    return [
      { key: 'patient-workspace', title: '患者工作台', subtitle: '随访、报告和健康服务入口', type: 'NATIVE', url: '/pages/patient/workspace/index' },
      { key: 'device', title: '指环设备', subtitle: '在小程序中连接与同步设备', type: 'NATIVE', url: '/pages/device/device' },
      { key: 'public-questionnaire', title: '建档问卷', subtitle: '复制公开问卷地址', type: 'COPY', copyText: PUBLIC_SCREENING_URL }
    ]
  }
  return []
}

module.exports = { getWorkspaceEntries, PUBLIC_SCREENING_URL }
