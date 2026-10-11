const http = require('node:http')

const port = Number(process.env.CHAOTANG_TEST_PORT || 9760)
const received = []
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>朝堂浏览器验收页</title>
<h1>朝堂浏览器验收页</h1><label for="code">验收码</label>
<input id="code" value=""><button id="submit" type="button">核验</button>
<p id="result">尚未核验</p>
<script>document.querySelector('#submit').onclick=()=>{document.querySelector('#result').textContent=document.querySelector('#code').value==='CT-42'?'验收通过':'验收失败'}</script></html>`

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, received: received.length }))
    return
  }
  if (req.method === 'GET' && req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  if (req.method === 'GET' && req.url === '/received') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(received, null, 2))
    return
  }
  if (req.method === 'POST' && req.url === '/wecom') {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        const message = JSON.parse(body)
        received.push({ at: new Date().toISOString(), message })
        console.log('收到模拟企微消息:', JSON.stringify(message))
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
      } catch {
        res.writeHead(400)
        res.end('Bad JSON')
      }
    })
    return
  }
  res.writeHead(404)
  res.end('Not Found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`浏览器验收页: http://127.0.0.1:${port}/page`)
  console.log(`模拟企微 Webhook: http://127.0.0.1:${port}/wecom`)
  console.log(`已收消息: http://127.0.0.1:${port}/received`)
  console.log('按 Ctrl+C 停止。')
})
