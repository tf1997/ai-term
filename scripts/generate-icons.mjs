import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const sourceIcon = 'src-tauri/icons/icon.png'
const icoOutput = 'src-tauri/icons/icon.ico'
const pngOutputs = [
  { size: 1024, path: 'frontend/public/icon.png' },
  { size: 512, path: 'src-tauri/icons/icon-512.png' },
  { size: 256, path: 'src-tauri/icons/icon-256.png' },
  { size: 256, path: 'src-tauri/icons/128x128@2x.png' },
  { size: 128, path: 'src-tauri/icons/128x128.png' },
  { size: 32, path: 'src-tauri/icons/32x32.png' }
]
const icoSizes = [32, 128, 256]
const buildAll = process.argv.includes('--all')

if (buildAll) {
  for (const output of pngOutputs) {
    resizePng(sourceIcon, output.path, output.size)
  }
}

const tempDir = mkdtempSync(join(tmpdir(), 'ai-term-icons-'))
try {
  const icoImages = icoSizes.map((size) => {
    const path = join(tempDir, `icon-${size}.png`)
    resizePng(sourceIcon, path, size)
    return { size, png: readFileSync(path) }
  })
  writeFileSync(icoOutput, encodeIco(icoImages))
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

function resizePng(source, target, size) {
  if (source === target && size === 1024) return
  if (size === 1024) {
    copyFileSync(source, target)
    return
  }

  const result = spawnSync('sips', ['-z', String(size), String(size), source, '--out', target], {
    stdio: 'pipe'
  })
  if (result.status !== 0) {
    const stderr = result.stderr.toString().trim()
    throw new Error(stderr || `sips failed while generating ${target}`)
  }
}

function encodeIco(images) {
  const headerSize = 6
  const entrySize = 16
  let offset = headerSize + images.length * entrySize
  const entries = []

  for (const image of images) {
    const entry = Buffer.alloc(entrySize)
    entry[0] = image.size >= 256 ? 0 : image.size
    entry[1] = image.size >= 256 ? 0 : image.size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.png.length
  }

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}
