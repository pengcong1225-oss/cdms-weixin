Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    showLogout: { type: Boolean, value: false }
  },
  methods: {
    back () {
      this.triggerEvent('back')
    },
    logout () {
      this.triggerEvent('logout')
    }
  }
})
