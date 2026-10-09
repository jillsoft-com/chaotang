const fs = require('fs')
const path = require('path')

function resolveWithinRoot(root, input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('路径不能为空')
  const target = path.resolve(root, input)
  let existing = target
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) throw new Error('路径无效')
    existing = parent
  }
  const realExisting = fs.realpathSync(existing)
  const realTarget = path.resolve(realExisting, path.relative(existing, target))
  const relative = path.relative(root, realTarget)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('只允许访问已选择的工作目录及其子目录')
  }
  return realTarget
}

module.exports = { resolveWithinRoot }
