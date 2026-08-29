const assert = require('assert')
const scaleBle = require('../miniprogram/services/scale/scaleBle')
const scaleBleWrapper = require('../miniprogram/services/scaleBle')
const { buildUserInfoFrame, buildUnitFrame, buildWorkModeFrame, parseScaleFrame, FrameAssembler } = scaleBle

function bytes (frame) { return Array.from(frame) }

assert.deepStrictEqual(bytes(buildUserInfoFrame({ gender: 1, age: 68, height: 172 })), [0xa9, 0x00, 0x26, 0x04, 0x01, 0x01, 0x44, 0xac, 0x1c, 0x9a])
assert.deepStrictEqual(bytes(buildUnitFrame()), [0xa9, 0x00, 0x26, 0x03, 0x04, 0x00, 0x00, 0x2d, 0x9a])
assert.deepStrictEqual(bytes(buildWorkModeFrame(1)), [0xa9, 0x00, 0x26, 0x02, 0x06, 0x01, 0x2f, 0x9a])

const segment1 = Uint8Array.from([0xa9, 0x00, 0x26, 0x0e, 0x15, 0x01, 0x00, 0xdc, 0x00, 0xb9, 0x00, 0x08, 0x01, 0x5e, 0x05, 0xaa, 0x2d, 0x00, 0x22, 0x9a])
const parsed = parseScaleFrame(segment1)
assert.strictEqual(parsed.type, 0x15)
assert.strictEqual(parsed.segment, 1)
assert.deepStrictEqual(parsed.metrics, [
  { name: 'bodyFat', value: 22, unit: '%' },
  { name: 'subcutaneousFat', value: 18.5, unit: '%' },
  { name: 'visceralFat', value: 8, unit: '' },
  { name: 'muscleRate', value: 35, unit: '%' },
  { name: 'basalMetabolism', value: 1450, unit: 'kcal' },
  { name: 'bodyAge', value: 45, unit: 'years' }
])

const assembler = new FrameAssembler()
assert.deepStrictEqual(assembler.push(segment1.slice(0, 7)), [])
assert.strictEqual(assembler.push(segment1.slice(7)).length, 1)
assert.strictEqual(scaleBleWrapper.ScaleBle, scaleBle.ScaleBle)

console.log('scale ble tests passed')
