function includesValue (list, value) {
  return list.map(item => String(item)).includes(String(value))
}

Component({
  properties: {
    options: { type: Array, value: [] },
    value: { type: null, value: '' },
    multiple: { type: Boolean, value: false }
  },
  methods: {
    change (event) {
      const selected = event.currentTarget.dataset.value
      if (this.data.multiple) {
        const current = Array.isArray(this.data.value) ? this.data.value.slice() : []
        const next = includesValue(current, selected)
          ? current.filter(item => String(item) !== String(selected))
          : current.concat(selected)
        this.triggerEvent('change', { value: next })
        return
      }
      this.triggerEvent('change', { value: selected })
    }
  }
})
