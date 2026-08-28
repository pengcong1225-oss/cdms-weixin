Component({
  properties: {
    primaryText: { type: String, value: '' },
    secondaryText: { type: String, value: '' },
    loading: { type: Boolean, value: false }
  },
  methods: {
    primary () {
      if (this.data.loading) return
      this.triggerEvent('primary')
    },
    secondary () {
      if (this.data.loading) return
      this.triggerEvent('secondary')
    }
  }
})
