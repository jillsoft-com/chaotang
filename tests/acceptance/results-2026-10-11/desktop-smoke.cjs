const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const evidence = __dirname
  const dataDir = path.join(evidence, 'isolated-user-data')
  fs.mkdirSync(dataDir, { recursive: true })
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, APPDATA: dataDir, LOCALAPPDATA: dataDir, NODE_ENV: 'production' },
    timeout: 30000,
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(1000)
    const info = {
      url: win.url(),
      title: await win.title(),
      body: (await win.locator('body').innerText()).slice(0, 5000),
      links: await win.locator('a').allTextContents(),
      buttons: await win.locator('button').allTextContents(),
    }
    await win.screenshot({ path: path.join(evidence, 'desktop-home.png'), fullPage: true })
    await win.locator('button[title="设置"]').click()
    await win.waitForTimeout(500)
    info.settings = {
      url: win.url(),
      body: (await win.locator('body').innerText()).slice(0, 5000),
    }
    await win.screenshot({ path: path.join(evidence, 'desktop-settings.png'), fullPage: true })
    const gepaFile = path.join(evidence, 'gepa-ui-export.json')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, gepaFile)
    await win.getByRole('button', { name: '导出', exact: true }).click()
    await win.getByText('导出成功', { exact: true }).waitFor()
    const exported = JSON.parse(fs.readFileSync(gepaFile, 'utf8'))
    info.gepaExport = { schemaVersion: exported.schemaVersion, patterns: exported.patterns.length }
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, gepaFile)
    await win.getByRole('button', { name: '导入', exact: true }).click()
    await win.getByText(/导入成功：新增/).waitFor()
    info.gepaImport = (await win.getByText(/导入成功：新增/).innerText())
    await win.getByRole('tab', { name: '消息集成' }).click()
    await win.getByPlaceholder('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...').fill('http://127.0.0.1:9760/wecom')
    await win.getByRole('button', { name: '保存配置' }).click()
    await win.getByRole('button', { name: '测试连接' }).click()
    await win.waitForTimeout(800)
    info.messaging = {
      body: (await win.locator('body').innerText()).slice(0, 2600),
      received: await (await fetch('http://127.0.0.1:9760/received')).json(),
    }
    await win.screenshot({ path: path.join(evidence, 'desktop-messaging.png'), fullPage: true })
    await win.getByRole('button', { name: '启动', exact: true }).click()
    await win.getByText('运行中', { exact: true }).waitFor()
    const callback = await fetch('http://127.0.0.1:9527/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'CT_INBOUND_42', from: { user_id: 'acceptance-user' } }),
    })
    await win.waitForTimeout(700)
    info.inbound = { status: callback.status, response: await callback.text(), body: (await win.locator('body').innerText()).slice(0, 2400) }
    await win.getByRole('button', { name: '停止', exact: true }).click()
    await win.evaluate(() => { location.hash = '#/' })
    await win.waitForTimeout(500)
    await win.locator('button[title="历史朝议"]').click()
    await win.waitForTimeout(500)
    info.history = {
      url: win.url(),
      body: (await win.locator('body').innerText()).slice(0, 3000),
    }
    await win.screenshot({ path: path.join(evidence, 'desktop-history.png'), fullPage: true })
    fs.writeFileSync(path.join(evidence, 'desktop-smoke.json'), JSON.stringify(info, null, 2))
    console.log(JSON.stringify(info, null, 2))
  } finally {
    await app.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
