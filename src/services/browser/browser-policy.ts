/**
 * 浏览器安全策略 — 域名白名单与导航确认
 *
 * 与既有产品决策的关系：
 * 本地命令与文件操作是「全局免确认」的（安全边界由主进程工作目录授权承担）。
 * 浏览器访问的是外网，风险模型不同，因此这里单独提供一层策略，
 * 但**默认全部关闭**，与免确认决策不冲突：用户不主动开启就一切照旧。
 *
 * 校验分两处：
 * - 渲染进程：面板与 Agent 工具执行前判定，用于弹窗确认与提示文案；
 * - 主进程：navigate 兜底拦截（防止渲染层被绕过），策略由本模块 syncPolicyToMain 下发。
 */

import { reactive } from 'vue'
import { appStorage } from '@/services/storage'

const STORAGE_KEY = 'browser_policy'

export interface BrowserPolicy {
  /** 开启域名白名单：仅允许访问白名单内站点 */
  allowlistEnabled: boolean
  /** 白名单域名（支持裸域与子域，如 example.com 放行 a.example.com） */
  allowlist: string[]
  /** 每次导航前人工确认（仅 Electron 桌面版面板内生效） */
  confirmNavigation: boolean
}

export const DEFAULT_BROWSER_POLICY: BrowserPolicy = {
  allowlistEnabled: false,
  allowlist: [],
  confirmNavigation: false
}

/** 响应式策略：设置页与浏览器面板共享同一份 */
export const browserPolicy = reactive<BrowserPolicy>({
  ...DEFAULT_BROWSER_POLICY,
  allowlist: []
})

/** 归一化用户填写的域名：去掉协议、路径、端口与大小写 */
export function normalizeHost(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

/** 取 URL 的主机名；解析失败返回空串 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 白名单是否放行该 URL（未开启白名单时一律放行） */
export function isUrlAllowed(policy: BrowserPolicy, url: string): boolean {
  if (!policy.allowlistEnabled) return true
  const host = hostOf(url)
  if (!host) return false
  return policy.allowlist
    .map(normalizeHost)
    .filter(Boolean)
    .some(pattern => host === pattern || host.endsWith(`.${pattern}`))
}

/** 解析后的白名单列表（供 UI 展示与主进程下发） */
export function cleanAllowlist(policy: BrowserPolicy): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of policy.allowlist || []) {
    const host = normalizeHost(item)
    if (host && !seen.has(host)) {
      seen.add(host)
      out.push(host)
    }
  }
  return out
}

/** 从本地存储载入策略（存储后端未就绪时保持默认值，不抛错） */
export function loadBrowserPolicy(): BrowserPolicy {
  try {
    const raw = appStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BrowserPolicy>
      Object.assign(browserPolicy, {
        allowlistEnabled: !!parsed.allowlistEnabled,
        allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist.map(normalizeHost).filter(Boolean) : [],
        confirmNavigation: !!parsed.confirmNavigation
      })
    }
  } catch {
    Object.assign(browserPolicy, DEFAULT_BROWSER_POLICY, { allowlist: [] })
  }
  return { ...browserPolicy, allowlist: [...browserPolicy.allowlist] }
}

/** 写回本地存储并同步到主进程 */
export function saveBrowserPolicy(): void {
  browserPolicy.allowlist = cleanAllowlist(browserPolicy)
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify({ ...browserPolicy }))
  } catch {
    // 存储后端尚未初始化：本次仅内存生效
  }
  void syncPolicyToMain()
}

/** 下发策略到主进程（主进程 navigate 兜底拦截依赖它） */
export async function syncPolicyToMain(): Promise<void> {
  if (!window.electronAPI?.browserAction) return
  try {
    await window.electronAPI.browserAction({
      action: 'set-policy',
      params: { allowlistEnabled: browserPolicy.allowlistEnabled, allowlist: cleanAllowlist(browserPolicy) }
    })
  } catch {
    // 主进程未支持该 action 时忽略：渲染层仍会做一层校验
  }
}

/**
 * 应用启动时调用：载入策略并下发主进程。
 * 主进程的浏览器实例是按需创建的，策略必须先于首次 navigate 到位。
 */
export function initBrowserPolicy(): void {
  loadBrowserPolicy()
  void syncPolicyToMain()
}

// ============ 导航人工确认 ============

/** 确认回调：由 UI 层注册（服务层不直接依赖 element-plus） */
export type BrowserConfirmHandler = (question: string, detail: string) => Promise<boolean>

let confirmHandler: BrowserConfirmHandler | null = null

export function setBrowserConfirmHandler(handler: BrowserConfirmHandler | null): void {
  confirmHandler = handler
}

/**
 * 导航前确认：策略未开启或未注册回调时直接放行。
 * @param source agent=模型发起 / manual=用户在面板发起
 */
export async function confirmNavigation(url: string, source: 'agent' | 'manual'): Promise<boolean> {
  if (!browserPolicy.confirmNavigation) return true
  if (!confirmHandler) return true
  const who = source === 'agent' ? 'Agent 即将访问' : '即将访问'
  const allowed = isUrlAllowed(browserPolicy, url)
  const detail = allowed
    ? `${who}：\n${url}`
    : `${who}：\n${url}\n\n⚠️ 该域名不在白名单内，且白名单策略已开启。`
  return confirmHandler(allowed ? '🌐 浏览器导航确认' : '🌐 白名单外站点确认', detail)
}
