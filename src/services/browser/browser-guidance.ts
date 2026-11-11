/**
 * 浏览器行为契约（M4.5）
 *
 * 为什么单独出一个 md，而不是写进角色提示词：
 * - 这套纪律是跟着「浏览器工具」走的，不是跟着某个角色走的。角色有 6 个，
 *   行业预设还会把它们复用成产品经理/后端/测试，把纪律抄进每个 md 早晚对不上。
 * - 同理也绝不能放进 src/prompts/：那个目录被 prompt-config.ts 用
 *   import.meta.glob 扫描并从文件名反推角色 id（getAvailableMinisterIds），
 *   多一个文件就等于凭空多一个「角色」。
 *
 * 内容是 M0~M4 实测出来的事实，不是愿望：遮挡时 Input.* 与截图会静默失效、
 * Runtime.evaluate 照常可用、合成事件 isTrusted=false、弹窗被转成标签页。
 * 改工具语义时请同步改这份 md，否则模型会按过期的世界观操作浏览器。
 */

import browserGuidanceRaw from './browser-guidance.md?raw'

/** 发给模型的浏览器操作契约（去掉首尾空白，正文本身按 Markdown 结构化） */
export const BROWSER_GUIDANCE: string = browserGuidanceRaw.trim()
