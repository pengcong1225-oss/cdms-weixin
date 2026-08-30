function includesValue (list, value) {
  return list.map(item => String(item)).includes(String(value))
}

function selectedMap (options, value, multiple) {
  const values = multiple ? (Array.isArray(value) ? value : []) : [value]
  return (Array.isArray(options) ? options : []).reduce((result, option) => {
    result[option.value] = includesValue(values, option.value)
    return result
  }, {})
}

Component({
  properties: {
    options: { type: Array, value: [] },
    value: { type: null, value: '' },
    multiple: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false }
  },
  data: {
    selectedMap: {}
  },
  observers: {
    'options, value, multiple': function (options, value, multiple) {
      this.setData({ selectedMap: selectedMap(options, value, multiple) })
    }
  },
  methods: {
    change (event) {
      if (this.data.disabled) return
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
