/**
 * LLM 请求 URL 解析：开发环境走 Vite dev server 的同源代理以规避浏览器 CORS，
 * 生产环境（Electron file:// 或静态托管）保持直连。
 *
 * 判定依据 import.meta.env.DEV —— Vite dev server 运行时为 true，
 * Electron 开发模式同样加载 http://localhost:3000，因此也走代理。
 */
const PROXY_PREFIX = '/llm-proxy/'

export function resolveLlmUrl(url: string): string {
  if (!import.meta.env.DEV) return url
  if (!/^https?:\/\//i.test(url)) return url
  return PROXY_PREFIX + encodeURIComponent(url)
}
