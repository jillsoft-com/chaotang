const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

async function main() {
  const evidence = __dirname
  const sample = 'C:\\Users\\jlj\\AppData\\Local\\Temp\\chaotang-acceptance-D0CHd0'
  const sampleFile = path.join(sample, 'src', 'pricing.cjs')
  const outsideFile = path.join(evidence, 'mock-baseline.json')
  const exportFile = path.join(evidence, 'token-export.json')
  const dataDir = path.join(evidence, 'isolated-user-data-ipc')
  fs.mkdirSync(dataDir, { recursive: true })
  const app = await _electron.launch({
    executablePath: require('electron'), args: ['.'],
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, APPDATA: dataDir, LOCALAPPDATA: dataDir, NODE_ENV: 'production' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const results = {}
    results.noRoot = await win.evaluate(file => window.electronAPI.readFile(file), sampleFile)
    assert.equal(results.noRoot.success, false)

    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, sample)
    results.selectedRoot = await win.evaluate(() => window.electronAPI.showOpenDialog({ properties: ['openDirectory'] }))
    results.inside = await win.evaluate(file => window.electronAPI.readFile(file), sampleFile)
    results.outside = await win.evaluate(file => window.electronAPI.readFile(file), outsideFile)
    assert.equal(results.inside.success, true)
    assert.equal(results.outside.success, false)

    results.noToken = await win.evaluate(file => window.electronAPI.readArbitraryFile(file), outsideFile)
    assert.equal(results.noToken.success, false)
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, outsideFile)
    const open = await win.evaluate(() => window.electronAPI.showOpenDialog({ properties: ['openFile'] }))
    results.readWrongPath = await win.evaluate(({ file, token }) => window.electronAPI.readArbitraryFile(file, token), { file: sampleFile, token: open.fileToken })
    results.readAuthorized = await win.evaluate(({ file, token }) => window.electronAPI.readArbitraryFile(file, token), { file: outsideFile, token: open.fileToken })
    results.readReplay = await win.evaluate(({ file, token }) => window.electronAPI.readArbitraryFile(file, token), { file: outsideFile, token: open.fileToken })
    assert.equal(results.readWrongPath.success, false)
    assert.equal(results.readAuthorized.success, true)
    assert.equal(results.readReplay.success, false)

    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }) })
    results.commandRejected = await win.evaluate(() => window.electronAPI.executeCommand({ command: 'Write-Output CT_APPROVED', cwd: '.' }))
    assert.equal(results.commandRejected.success, false)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
    results.commandApproved = await win.evaluate(() => window.electronAPI.executeCommand({ command: 'Write-Output CT_APPROVED', cwd: '.' }))
    assert.equal(results.commandApproved.success, true)
    assert.match(results.commandApproved.stdout, /CT_APPROVED/)

    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, exportFile)
    const save = await win.evaluate(() => window.electronAPI.showSaveDialog({ title: 'Test export' }))
    results.writeWrongPath = await win.evaluate(({ file, token }) => window.electronAPI.writeArbitraryFile(file, '{}', token), { file: outsideFile, token: save.fileToken })
    results.writeAuthorized = await win.evaluate(({ file, token }) => window.electronAPI.writeArbitraryFile(file, '{"acceptance":true}', token), { file: exportFile, token: save.fileToken })
    results.writeReplay = await win.evaluate(({ file, token }) => window.electronAPI.writeArbitraryFile(file, 'bad', token), { file: exportFile, token: save.fileToken })
    assert.equal(results.writeWrongPath.success, false)
    assert.equal(results.writeAuthorized.success, true)
    assert.equal(results.writeReplay.success, false)
    assert.equal(fs.readFileSync(exportFile, 'utf8'), '{"acceptance":true}')

    // Keep the evidence compact; never persist the file content in the JSON report.
    results.inside.content = `<${results.inside.content.length} characters>`
    results.readAuthorized.content = `<${results.readAuthorized.content.length} characters>`
    fs.writeFileSync(path.join(evidence, 'desktop-ipc.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
  } finally { await app.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
