const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { resolveWithinRoot } = require('../electron/workspace-access.cjs')

test('only selected directory and children are accessible', () => {
  const base = fs.mkdtempSync(path.join(process.cwd(), '.tmp-security-test-'))
  try {
    const root = path.join(base, 'project')
    const sibling = path.join(base, 'project-private')
    fs.mkdirSync(root)
    fs.mkdirSync(sibling)
    fs.mkdirSync(path.join(root, 'src'))
    const realRoot = fs.realpathSync(root)

    assert.equal(resolveWithinRoot(realRoot, 'src/new.txt'), path.join(realRoot, 'src', 'new.txt'))
    assert.throws(() => resolveWithinRoot(realRoot, '../project-private/secret.txt'))
    assert.throws(() => resolveWithinRoot(realRoot, sibling))
    assert.throws(() => resolveWithinRoot(realRoot, ''))

    const link = path.join(root, 'outside-link')
    try {
      fs.symlinkSync(sibling, link, 'dir')
      assert.throws(() => resolveWithinRoot(realRoot, path.join(link, 'secret.txt')))
    } catch (error) {
      if (error?.code !== 'EPERM') throw error
    }
  } finally {
    const relative = path.relative(process.cwd(), base)
    assert.ok(relative.startsWith('.tmp-security-test-') && !relative.includes(path.sep))
    fs.rmSync(base, { recursive: true, force: true })
  }
})
