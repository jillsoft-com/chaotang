/// <reference types="vitest" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import http from 'node:http'
import https from 'node:https'
import type { Plugin, ViteDevServer } from 'vite'

/**
 * 开发期 LLM CORS 代理
 *
 * 浏览器（含 Electron 开发模式加载 http://localhost:3000）直接 fetch 各家 LLM 端点时，
 * 若服务端未返回 Access-Control-Allow-Origin 头会被同源策略拦截。这里把
 * `/llm-proxy/<encodeURIComponent(绝对URL)>` 的请求由 dev server 以 Node 侧转发到真实地址，
 * 转发请求不经过浏览器 CORS 校验。支持 SSE 流式（原样透传响应头与数据流）。
 * 生产构建（file:// 或静态托管）不加载此中间件，客户端会自动回退为直连。
 */
function llmCorsProxy(): Plugin {
  return {
    name: 'llm-cors-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/llm-proxy/')) return next()

        let target: URL
        try {
          target = new URL(decodeURIComponent(url.slice('/llm-proxy/'.length)))
        } catch {
          res.statusCode = 400
          res.end('Bad proxy target')
          return
        }

        const isHttps = target.protocol === 'https:'
        const lib = isHttps ? https : http
        const headers: Record<string, any> = { ...req.headers }
        // 去除会触发上游拦截或与实际 host 不符的头
        delete headers.origin
        delete headers.referer
        delete headers.connection
        delete headers['sec-fetch-mode']
        delete headers['sec-fetch-site']
        delete headers['sec-fetch-dest']
        headers.host = target.host

        const proxyReq = lib.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers
          },
          (proxyRes) => {
            res.statusCode = proxyRes.statusCode || 502
            for (const [key, value] of Object.entries(proxyRes.headers)) {
              if (value !== undefined) res.setHeader(key, value)
            }
            proxyRes.pipe(res)
          }
        )

        proxyReq.on('error', (err) => {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: { message: `LLM 代理请求失败: ${err.message}` } }))
        })

        req.pipe(proxyReq)
      })
    }
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), llmCorsProxy()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/ddg-proxy': {
        target: 'https://html.duckduckgo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ddg-proxy/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    }
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/services/**/*.ts']
    }
  }
})
