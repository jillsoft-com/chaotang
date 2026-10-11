const port = Number(process.argv[2] || 9527)
const url = `http://127.0.0.1:${port}/`
const payload = {
  content: 'CT_INBOUND_42：请讨论技术社区渠道是否值得继续投放',
  from: { user_id: 'acceptance-user', user_name: '验收测试员' }
}

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
}).then(async response => {
  console.log(`HTTP ${response.status}: ${await response.text()}`)
}).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
