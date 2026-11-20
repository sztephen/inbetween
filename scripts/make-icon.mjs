// Draws the app icon (build/icon.png, 1024px) with no dependencies: a keyframe diamond between
// two ghosted ones (an in-between) on a dark rounded square. Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const N = 1024
const px = new Uint8Array(N * N * 4)
const mix = (a, b, t) => a + (b - a) * t
// signed distance to a rounded square centred at (cx, cy)
const sdRound = (x, y, cx, cy, half, r) => {
  const dx = Math.abs(x - cx) - (half - r), dy = Math.abs(y - cy) - (half - r)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
}
// rounded diamond = rounded square rotated 45 degrees
const sdDiamond = (x, y, cx, cy, half, r) => {
  const u = (x - cx + (y - cy)) * Math.SQRT1_2, v = (y - cy - (x - cx)) * Math.SQRT1_2
  return sdRound(u, v, 0, 0, half, r)
}
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d))
const blend = (i, r, g, b, a) => {
  const ia = px[i + 3] / 255
  const oa = a + ia * (1 - a)
  if (oa <= 0) return
  px[i] = (r * a + px[i] * ia * (1 - a)) / oa
  px[i + 1] = (g * a + px[i + 1] * ia * (1 - a)) / oa
  px[i + 2] = (b * a + px[i + 2] * ia * (1 - a)) / oa
  px[i + 3] = oa * 255
}
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = (y * N + x) * 4
  const t = y / N
  blend(i, mix(0x2a, 0x16, t), mix(0x2e, 0x18, t), mix(0x3a, 0x20, t), cover(sdRound(x + 0.5, y + 0.5, 512, 512, 412, 190)))
  blend(i, 0xff, 0x7a, 0x5c, 0.55 * cover(sdDiamond(x + 0.5, y + 0.5, 318, 512, 92, 22)))
  blend(i, 0x6f, 0x9b, 0xff, 0.55 * cover(sdDiamond(x + 0.5, y + 0.5, 706, 512, 92, 22)))
  blend(i, 0xf4, 0xf5, 0xf8, cover(sdDiamond(x + 0.5, y + 0.5, 512, 512, 128, 30)))
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, sum])
}
const raw = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) Buffer.from(px.buffer, y * N * 4, N * 4).copy(raw, y * (N * 4 + 1) + 1)
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0)
ihdr.writeUInt32BE(N, 4)
ihdr.set([8, 6, 0, 0, 0], 8)
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]))
console.log(`wrote ${out}`)
