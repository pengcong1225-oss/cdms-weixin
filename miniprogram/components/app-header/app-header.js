Component({
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    showLogout: { type: Boolean, value: false },
    showSearch: { type: Boolean, value: false },
    showMessages: { type: Boolean, value: false },
    iconActions: { type: Boolean, value: false },
    compact: { type: Boolean, value: false }
  },
  methods: {
    back () {
      this.triggerEvent('back')
    },
    logout () {
      this.triggerEvent('logout')
    },
    search () {
      this.triggerEvent('search')
    },
    messages () {
      this.triggerEvent('messages')
    }
  }
})
