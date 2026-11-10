/**
 * 界面导航守卫判定测试（内嵌浏览器 M2）
 *
 * 这条判定决定两件事：界面自己的地址能不能导航出去、内嵌浏览器的页面会不会被误杀。
 * 原来它埋在 main.cjs 的事件监听里无法测试，而「内嵌页面点链接没反应」正是
 * M3 最难自查的故障形态，所以拆成纯函数后必须先钉住。
 */

import { describe, it, expect } from 'vitest'
import path from 'path'
import { pathToFileURL } from 'url'
// @ts-ignore - 主进程 CommonJS 模块
import guard from '../../electron/nav-guard.cjs'

const DIST = path.join('D:', 'Workspace', 'ChaoTang', 'dist', 'index.html')
const SHELL_URL = pathToFileURL(DIST).href

describe('内嵌标签页豁免', () => {
  it('宿主标记的页面完全不由本守卫决定', () => {
    const d = guard.decideShellNavigation('https://www.wikipedia.org', { isEmbedded: true, isDev: false, distIndex: DIST })
    expect(d).toEqual({ skip: true, allowed: true, external: false, reason: 'embedded-tab' })
  })

  it('本地站点的内嵌页面同样跳过（否则链接点击会被吞）', () => {
    const d = guard.decideShellNavigation('http://127.0.0.1:8080/page2.html', { isEmbedded: true, isDev: true })
    expect(d.skip).toBe(true)
  })
})

describe('开发模式', () => {
  const opts = { isDev: true, devOrigin: 'http://localhost:3000' }

  it('vite 服务地址放行', () => {
    expect(guard.decideShellNavigation('http://localhost:3000/#/settings', opts)).toMatchObject({
      skip: false, allowed: true, external: false, reason: 'dev-server'
    })
  })

  it('非界面 origin 的 https 交给系统浏览器并阻止界面导航', () => {
    expect(guard.decideShellNavigation('https://example.com', opts)).toMatchObject({
      allowed: false, external: true, reason: 'external-scheme'
    })
  })

  it('明文 http 外链不自动打开（只允许 https 与 mailto）', () => {
    expect(guard.decideShellNavigation('http://evil.test/x', opts)).toMatchObject({
      allowed: false, external: false, reason: 'not-allowed'
    })
  })

  it('端口不同的 localhost 不放行', () => {
    expect(guard.decideShellNavigation('http://localhost:3001/', opts).allowed).toBe(false)
  })
})

describe('生产模式', () => {
  const opts = { isDev: false, distIndex: DIST }

  it('应用壳自身的 file 地址放行', () => {
    expect(guard.decideShellNavigation(SHELL_URL, opts)).toMatchObject({ allowed: true, reason: 'app-shell' })
  })

  it('用户机器上其它 file 地址禁止', () => {
    const other = pathToFileURL(path.join('C:', 'Users', 'me', 'Desktop', 'note.html')).href
    expect(guard.decideShellNavigation(other, opts).allowed).toBe(false)
  })

  it('路径含空格与中文时仍能匹配壳自身地址', () => {
    const spaced = path.join('C:', 'Program Files', '朝堂 App', 'dist', 'index.html')
    const spacedOpts = { isDev: false, distIndex: spaced }
    expect(guard.decideShellNavigation(pathToFileURL(spaced).href, spacedOpts).allowed).toBe(true)
    // 差一个字符也不能放行，避免任意本地文件被界面加载
    expect(guard.decideShellNavigation(pathToFileURL(spaced).href + '?x=1', {
      isDev: false,
      distIndex: path.join('C:', 'Program Files', '朝堂', 'dist', 'index.html')
    }).allowed).toBe(false)
  })

  it('mailto 走系统浏览器', () => {
    expect(guard.decideShellNavigation('mailto:someone@example.com', opts)).toMatchObject({
      allowed: false, external: true
    })
  })

  it('缺少 distIndex 配置时不把 file 地址当壳', () => {
    expect(guard.decideShellNavigation(SHELL_URL, { isDev: false }).allowed).toBe(false)
  })
})

describe('异常输入', () => {
  it('非法 URL 一律禁止且不外链', () => {
    for (const bad of ['javascript:alert(1)', 'not a url', '', undefined]) {
      const d = guard.decideShellNavigation(bad as string, { isDev: false, distIndex: DIST })
      expect(d).toMatchObject({ skip: false, allowed: false, external: false })
    }
  })
})
