import { readFileSync, writeFileSync } from 'node:fs'

const icoOutput = 'src-tauri/icons/icon.ico'
const icoSources = [
  { size: 32, path: 'src-tauri/icons/32x32.png' },
  { size: 128, path: 'src-tauri/icons/128x128.png' },
  { size: 256, path: 'src-tauri/icons/icon-256.png' }
]

writeFileSync(
  icoOutput,
  encodeIco(icoSources.map((source) => ({ size: source.size, png: readFileSync(source.path) })))
)

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
