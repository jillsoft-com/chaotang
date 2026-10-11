const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const evidence = __dirname
  const dataDir = path.join(evidence, 'isolated-user-data-no-model')
  fs.mkdirSync(dataDir, { recursive: true })
  const app = await _electron.launch({
    executablePath: require('electron'), args: ['.'],
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, APPDATA: dataDir, LOCALAPPDATA: dataDir, NODE_ENV: 'production' },
  })
  try {
    const win = await app.firstWindow()
    const blockedRequests = []
    await win.route(/^https?:\/\//, route => {
      blockedRequests.push(route.request().url())
      return route.abort()
    })
    await win.locator('textarea').first().fill('CT_NO_MODEL_42：请讨论此事')
    await win.locator('textarea').first().press('Enter')
    await win.waitForTimeout(3000)
    const result = { url: win.url(), body: (await win.locator('body').innerText()).slice(0, 5000), blockedRequests }
    await win.screenshot({ path: path.join(evidence, 'no-model.png'), fullPage: true })
    fs.writeFileSync(path.join(evidence, 'no-model.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally { await app.close() }
  const app2 = await _electron.launch({
    executablePath: require('electron'), args: ['.'],
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, APPDATA: dataDir, LOCALAPPDATA: dataDir, NODE_ENV: 'production' },
  })
  try {
    const win2 = await app2.firstWindow()
    await win2.waitForTimeout(500)
    const restarted = { body: (await win2.locator('body').innerText()).slice(0, 2500) }
    fs.writeFileSync(path.join(evidence, 'no-model-restart.json'), JSON.stringify(restarted, null, 2))
    await win2.screenshot({ path: path.join(evidence, 'no-model-restart.png'), fullPage: true })
    console.log('Restart:', JSON.stringify(restarted, null, 2))
  } finally { await app2.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
