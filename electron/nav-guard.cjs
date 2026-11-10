'use strict'
/**
 * 界面导航守卫判定（纯函数，可单测）
 *
 * main.cjs 里原来直接写在 app.on('web-contents-created') 内部：只允许界面自身的地址，
 * 其余一律 preventDefault，https 还顺手交给系统浏览器。问题是这条守卫会扫到
 * 内嵌浏览器的每个标签页——页面里的链接点击会被吞掉，或者把用户弹出到系统浏览器。
 *
 * 判定拆到这里的理由：这是「内嵌浏览器能不能正常跳转」的唯一开关，
 * 藏在事件监听里既没法单测也容易被后续改动无意覆盖。
 */

const { pathToFileURL } = require('url')
const path = require('path')

/**
 * @param navigationUrl 目标地址
 * @param opts.isEmbedded 该 contents 是否属于内嵌浏览器宿主
 * @param opts.isDev 开发模式
 * @param opts.devOrigin 开发服务器 origin，默认 http://localhost:3000
 * @param opts.distIndex dist/index.html 的绝对路径（生产模式界面地址）
 * @returns {{skip: boolean, allowed: boolean, external: boolean, reason: string}}
 *  - skip：完全不归本守卫管（内嵌标签页），调用方应当直接 return
 *  - allowed：允许在界面里导航
 *  - external：应当改用系统浏览器打开
 */
function decideShellNavigation(navigationUrl, opts) {
  const options = opts || {}
  if (options.isEmbedded) {
    return { skip: true, allowed: true, external: false, reason: 'embedded-tab' }
  }

  let destination = null
  try {
    destination = new URL(navigationUrl)
  } catch {
    // 无效地址：不允许，也不外链
    return { skip: false, allowed: false, external: false, reason: 'invalid-url' }
  }

  if (options.isDev) {
    const devOrigin = options.devOrigin || 'http://localhost:3000'
    if (destination.origin === devOrigin) {
      return { skip: false, allowed: true, external: false, reason: 'dev-server' }
    }
  } else if (destination.protocol === 'file:' && options.distIndex) {
    // 两边都是 URL 编码态再比：路径含空格或中文时 decode 一边就会对不上
    const expected = new URL(pathToFileURL(path.resolve(options.distIndex)).href).pathname
    if (destination.pathname === expected) {
      return { skip: false, allowed: true, external: false, reason: 'app-shell' }
    }
  }

  if (destination.protocol === 'https:' || destination.protocol === 'mailto:') {
    return { skip: false, allowed: false, external: true, reason: 'external-scheme' }
  }

  return { skip: false, allowed: false, external: false, reason: 'not-allowed' }
}

module.exports = { decideShellNavigation }
