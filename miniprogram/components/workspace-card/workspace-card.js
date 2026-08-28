Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    icon: { type: String, value: '' },
    disabled: { type: Boolean, value: false }
  },
  methods: {
    select () {
      if (this.data.disabled) return
      this.triggerEvent('select')
    }
  }
})
