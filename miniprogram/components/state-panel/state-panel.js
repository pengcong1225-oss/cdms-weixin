Component({
  properties: {
    state: { type: String, value: 'empty' },
    title: { type: String, value: '' },
    message: { type: String, value: '' },
    actionText: { type: String, value: '' }
  },
  methods: {
    action () {
      this.triggerEvent('action')
    }
  }
})
