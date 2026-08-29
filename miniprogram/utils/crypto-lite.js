function toBytes (value) {
  const text = String(value === null || value === undefined ? '' : value)
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(text))
  }
  try {
    const util = require('util')
    if (util && typeof util.TextEncoder === 'function') {
      return Array.from(new util.TextEncoder().encode(text))
    }
  } catch (_) {}
  const encoded = unescape(encodeURIComponent(text))
  const bytes = new Array(encoded.length)
  for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index) & 0xff
  return bytes
}

function bytesToHex (bytes) {
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function rightRotate (value, amount) {
  return (value >>> amount) | (value << (32 - amount))
}

function sha256BytesFromBytes (inputBytes) {
  const bytes = inputBytes.slice()
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while ((bytes.length % 64) !== 56) bytes.push(0)
  for (let shift = 7; shift >= 0; shift -= 1) {
    bytes.push((bitLength >>> (shift * 8)) & 0xff)
  }

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array(64)
    for (let index = 0; index < 16; index += 1) {
      const position = offset + (index * 4)
      w[index] = (
        (bytes[position] << 24) |
        (bytes[position + 1] << 16) |
        (bytes[position + 2] << 8) |
        bytes[position + 3]
      ) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(w[index - 15], 7) ^ rightRotate(w[index - 15], 18) ^ (w[index - 15] >>> 3)
      const s1 = rightRotate(w[index - 2], 17) ^ rightRotate(w[index - 2], 19) ^ (w[index - 2] >>> 10)
      w[index] = (((w[index - 16] + s0) >>> 0) + ((w[index - 7] + s1) >>> 0)) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (((((h + s1) >>> 0) + ((ch + k[index]) >>> 0)) >>> 0) + w[index]) >>> 0
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  const out = []
  hash.forEach(word => {
    out.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff)
  })
  return out
}

function sha256Hex (value) {
  try {
    const crypto = require('crypto')
    return crypto.createHash('sha256').update(String(value === null || value === undefined ? '' : value), 'utf8').digest('hex')
  } catch (_) {
    return bytesToHex(sha256BytesFromBytes(toBytes(value)))
  }
}

function hmacSha256Hex (secret, message) {
  try {
    const crypto = require('crypto')
    return crypto.createHmac('sha256', String(secret === null || secret === undefined ? '' : secret))
      .update(String(message === null || message === undefined ? '' : message), 'utf8')
      .digest('hex')
  } catch (_) {
    let key = toBytes(secret)
    if (key.length > 64) key = sha256BytesFromBytes(key)
    while (key.length < 64) key.push(0)
    const outer = key.map(byte => byte ^ 0x5c)
    const inner = key.map(byte => byte ^ 0x36)
    const innerHash = sha256BytesFromBytes(inner.concat(toBytes(message)))
    return bytesToHex(sha256BytesFromBytes(outer.concat(innerHash)))
  }
}

module.exports = { hmacSha256Hex, sha256Hex, toBytes }
