import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const outputs = [
  ['frontend/public/icon.png', 1024],
  ['src-tauri/icons/icon.png', 1024],
  ['src-tauri/icons/icon-512.png', 512],
  ['src-tauri/icons/icon-256.png', 256],
  ['src-tauri/icons/128x128@2x.png', 256],
  ['src-tauri/icons/128x128.png', 128],
  ['src-tauri/icons/32x32.png', 32]
]

const colors = {
  bg0: hex('#111827'),
  bg1: hex('#06131d'),
  panel: hex('#0b1220'),
  panelStroke: hex('#24344f'),
  prompt0: hex('#70f2a4'),
  prompt1: hex('#54d6ff'),
  cursor: hex('#d9f6ff'),
  ai: hex('#8d7cff')
}

for (const [path, size] of outputs) {
  writeFileSync(path, encodePng(size, size, render(size)))
}

function render(size) {
  const data = new Uint8Array(size * size * 4)
  const unit = 1024 / size
  const aa = 1.2 * unit

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) * unit
      const py = (y + 0.5) * unit
      let dst = [0, 0, 0, 0]

      const bgAlpha = cover(-roundedRectSdf(px, py, 0, 0, 1024, 1024, 220), aa)
      dst = over(dst, [...lerpColor(colors.bg0, colors.bg1, (px + py) / 2048), bgAlpha])

      const panelSdf = roundedRectSdf(px, py, 170, 210, 684, 604, 92)
      dst = over(dst, [...colors.panel, cover(-panelSdf, aa)])
      dst = over(dst, [...colors.panelStroke, cover(Math.abs(panelSdf) - 14, aa)])

      dst = drawLine(dst, px, py, [319, 403], [462, 512], 76, lerpColor(colors.prompt0, colors.prompt1, 0.35), aa)
      dst = drawLine(dst, px, py, [462, 512], [319, 621], 76, lerpColor(colors.prompt0, colors.prompt1, 0.65), aa)
      dst = drawLine(dst, px, py, [524, 636], [718, 636], 76, colors.cursor, aa)

      dst = drawCircleStroke(dst, px, py, [708, 358], 54, 28, colors.ai, aa)
      dst = drawCircleFill(dst, px, py, [708, 358], 15, colors.ai, aa)
      dst = drawLine(dst, px, py, [708, 412], [708, 488], 24, colors.ai, aa)
      dst = drawLine(dst, px, py, [648, 448], [768, 448], 24, colors.ai, aa)

      const offset = (y * size + x) * 4
      data[offset] = Math.round(dst[0])
      data[offset + 1] = Math.round(dst[1])
      data[offset + 2] = Math.round(dst[2])
      data[offset + 3] = Math.round(dst[3] * 255)
    }
  }

  return data
}

function drawLine(dst, px, py, a, b, width, color, aa) {
  const alpha = cover(width / 2 - distanceToSegment(px, py, a, b), aa)
  return over(dst, [...color, alpha])
}

function drawCircleFill(dst, px, py, center, radius, color, aa) {
  const alpha = cover(radius - distance(px, py, center[0], center[1]), aa)
  return over(dst, [...color, alpha])
}

function drawCircleStroke(dst, px, py, center, radius, width, color, aa) {
  const alpha = cover(width / 2 - Math.abs(distance(px, py, center[0], center[1]) - radius), aa)
  return over(dst, [...color, alpha])
}

function roundedRectSdf(px, py, x, y, w, h, r) {
  const cx = x + w / 2
  const cy = y + h / 2
  const qx = Math.abs(px - cx) - (w / 2 - r)
  const qy = Math.abs(py - cy) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function distanceToSegment(px, py, a, b) {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const wx = px - a[0]
  const wy = py - a[1]
  const c = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1)
  return distance(px, py, a[0] + c * vx, a[1] + c * vy)
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2)
}

function cover(value, aa) {
  return clamp(value / aa + 0.5, 0, 1)
}

function over(dst, src) {
  const srcA = src[3]
  const dstA = dst[3]
  const outA = srcA + dstA * (1 - srcA)
  if (outA <= 0) return [0, 0, 0, 0]
  return [
    (src[0] * srcA + dst[0] * dstA * (1 - srcA)) / outA,
    (src[1] * srcA + dst[1] * dstA * (1 - srcA)) / outA,
    (src[2] * srcA + dst[2] * dstA * (1 - srcA)) / outA,
    outA
  ]
}

function lerpColor(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ]
}

function hex(value) {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ]
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    rgba.copy?.(raw, row + 1, y * width * 4, (y + 1) * width * 4)
    if (!rgba.copy) {
      raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), row + 1)
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type)
  return Buffer.concat([u32(data.length), typeBuffer, data, u32(crc32(Buffer.concat([typeBuffer, data])))])
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0)
  return buffer
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
