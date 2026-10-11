---
id: acceptance_echo
name: 验收回声
description: 返回固定验收标记，供本地插件链路测试
icon: 🔎
category: system
bindTo: [chancellor]
tools:
  - name: acceptance_echo
    description: 返回输入文字及固定标记 CT_PLUGIN_OK
    parameters:
      type: object
      properties:
        input:
          type: string
          description: 任意测试文字
      required: [input]
handler: |
  async function acceptance_echo(args) {
    return { marker: 'CT_PLUGIN_OK', echo: String(args.input) }
  }
---

仅供朝堂本机验收使用。
