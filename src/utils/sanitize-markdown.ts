import { marked } from 'marked'

const allowedTags = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'
])

export function renderSafeMarkdown(content: string): string {
  if (!content) return ''
  const template = document.createElement('template')
  template.innerHTML = marked.parse(content, { breaks: true, gfm: true }) as string

  function clean(parent: ParentNode): void {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.parentNode?.removeChild(node)
        continue
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const element = node as HTMLElement
      if (!allowedTags.has(element.tagName)) {
        element.remove()
        continue
      }
      const href = element.tagName === 'A' ? element.getAttribute('href') : null
      for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name)
      if (href) {
        try {
          const url = new URL(href, window.location.href)
          if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
            element.setAttribute('href', url.href)
            element.setAttribute('target', '_blank')
            element.setAttribute('rel', 'noopener noreferrer')
          }
        } catch { /* 不渲染不合法链接 */ }
      }
      clean(element)
    }
  }

  clean(template.content)
  return template.innerHTML
}
