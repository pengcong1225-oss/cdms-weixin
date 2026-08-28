function maskName (name) {
  const text = String(name || '')
  if (text.length <= 1) return text || '未命名患者'
  return `${text.slice(0, 1)}*`
}

Component({
  properties: {
    patient: { type: Object, value: null },
    masked: { type: Boolean, value: true }
  },
  data: {
    displayName: '未命名患者'
  },
  observers: {
    'patient, masked': function (patient, masked) {
      const name = patient?.name || patient?.patientName || ''
      this.setData({ displayName: masked ? maskName(name) : (name || '未命名患者') })
    }
  },
  methods: {
    select () {
      this.triggerEvent('select')
    }
  }
})
