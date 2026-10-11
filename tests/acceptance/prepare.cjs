const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const fixture = path.join(__dirname, 'fixture-project')
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'chaotang-acceptance-'))
fs.cpSync(fixture, target, { recursive: true })
fs.mkdirSync(path.join(target, 'sample-plugin'))
fs.copyFileSync(
  path.join(__dirname, 'sample-plugin', 'SKILL.md'),
  path.join(target, 'sample-plugin', 'SKILL.md')
)

// 生成带有确定答案的 PNG，免受系统字体和图片库差异影响。
const width = 320
const height = 120
const rgba = Buffer.alloc(width * height * 4, 255)
function rect(x, y, w, h, color) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * width + px) * 4
      rgba[i] = color[0]
      rgba[i + 1] = color[1]
      rgba[i + 2] = color[2]
    }
  }
}

rect(10, 10, 45, 100, [220, 30, 40])
rect(265, 10, 45, 100, [30, 70, 220])
const glyphs = {
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '3': ['11111', '00001', '00001', '01111', '00001', '00001', '11111'],
  '9': ['11111', '10001', '10001', '11111', '00001', '00001', '11111'],
  '2': ['11111', '00001', '00001', '11111', '10000', '10000', '11111']
}
const digits = '7392'
const scale = 7
const startX = 65
const startY = 35
for (let n = 0; n < digits.length; n++) {
  const glyph = glyphs[digits[n]]
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col] === '1') {
        rect(startX + n * 47 + col * scale, startY + row * scale, scale, scale, [0, 0, 0])
      }
    }
  }
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([size, body, checksum])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(width, 0)
ihdr.writeUInt32BE(height, 4)
ihdr[8] = 8
ihdr[9] = 6
const raw = Buffer.alloc(height * (1 + width * 4))
for (let y = 0; y < height; y++) {
  rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
}
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])
fs.writeFileSync(path.join(target, 'vision-card.png'), png)

console.log(`测试工作目录: ${target}`)
console.log(`图片样本: ${path.join(target, 'vision-card.png')}`)
console.log('初始代码故意包含一个折扣计算错误；请选择此目录作为朝堂工作目录。')
