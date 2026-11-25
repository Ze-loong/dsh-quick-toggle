/**
 * dsh-quick-toggle —— Host 端。
 *
 * 注册 `/toggle` 斜杠命令：
 *   /toggle                 （浏览器端会拦截成弹出列表，点选即可；这里只作兜底帮助）
 *   /toggle list            文字版清单
 *   /toggle <名称>          模糊匹配并切换；匹配到多个时列出编号候选
 *   /toggle <编号>          从上一次的候选列表里按编号切换
 *   /toggle <精确id>        例如 include:agent-compare 或 bundle:dsh-vitals（弹出列表点选时用）
 *   /toggle 按钮 显示|隐藏  控制输入框里的 🔌 按钮
 * 关闭“需确认名单”里的插件时，需要在末尾加“确认”，例如 /toggle oh-my-claude 确认。
 *
 * 插件分两种状态：
 *   - 插件包已启用：每个条目单独开关 → pluginManager.setPluginEnabled(entryId, enabled)；
 *     关掉包里最后一个开着的条目时连包一起停用，否则它的前端按钮/图标会残留
 *   - 插件包已安装但未启用：整包开启 → setBundleEnabled(name, true)，并打开包内条目
 * 都写进 profile 的 cordis.patch.yml（用户补丁层），HMR 下即时生效，不改插件本身文件。
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本插件的包名（用于把自己从列表里排除）。 */
const SELF = 'dsh-quick-toggle'

export const name = SELF

/** 硬依赖：命令注册表 + 官方插件管理服务。 */
export const inject = ['commands', 'pluginManager']

/** 默认的“关闭前需确认”名单：关掉会让对话界面或模型不可用的插件。 */
export const DEFAULT_CONFIRM = ['dsh-oh-my-claude', 'dsh-codex-subscription', 'dsh-claude-style', 'dshmarket', 'billion-context']

/**
 * 加载 schemastery 用于声明 Config。
 * 本插件是 link 安装、真实路径不在 profile 下，裸导入可能解析不到，
 * 因此依次尝试：正常导入 → 从 profile 目录 require。都失败就不声明 Config。
 */
async function loadSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    return mod.default ?? mod
  } catch { /* 继续尝试 profile 目录 */ }
  const dirs = [process.env.DSH_PROFILE_DIR, join(homedir(), '.dsh', 'profiles', 'desktop')].filter(Boolean)
  for (const dir of dirs) {
    try {
      const mod = createRequire(join(dir, 'package.json'))('@deepseek-ai/schemastery')
      return mod.default ?? mod
    } catch { /* 下一个候选 */ }
  }
  return undefined
}

const Schema = await loadSchema()

/** 给字段标 volatile：DSH 设置服务只允许在线修改 volatile 字段，且改动不会让插件重载。 */
const live = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

/** 插件配置（全部可在线修改）。 */
export const Config = Schema
  ? Schema.object({
      showButton: live(Schema.boolean().default(true).description('在输入框工具栏显示 🔌 插件开关按钮')),
      buttonPosition: live(Schema.union([Schema.const('left'), Schema.const('right')]).default('left')
        .description('🔌 按钮放在输入框工具栏的左侧还是右侧')),
      showDisabledBundles: live(Schema.boolean().default(true).description('列表里显示“整包未启用”的插件')),
      showDescription: live(Schema.boolean().default(true).description('列表里显示中文简介')),
      confirmBeforeDisable: live(Schema.array(Schema.string()).default(DEFAULT_CONFIRM)
        .description('关闭前需要确认的插件包名（批量关闭时也会保留）')),
      pinned: live(Schema.array(Schema.string()).default([]).description('常用插件包名，排在列表最前面')),
      batchSnapshot: live(Schema.array(Schema.object({
        entryId: Schema.string(),
        bundle: Schema.string().default(''),
      })).default([]).description('批量关闭前处于开启状态的条目（用于一键恢复，自动维护）')),
    })
  : undefined

/** 读一个配置项：volatile 字段运行时是带 get() 的引用，普通字段直接是值。 */
function readConfig(config, key, fallback) {
  const v = config?.[key]
  const value = v && typeof v === 'object' && !Array.isArray(v) && typeof v.get === 'function' ? v.get() : v
  return value === undefined || value === null ? fallback : value
}

// ───────────── 插件清单（client.js 里有同样一份逻辑，改动时两边同步） ─────────────

/**
 * 是否受保护（不出现在列表里）：本插件自己、cordis:* 系统插件、DSH 自带的 @deepseek-ai/* 核心。
 * 用户自己装进 profile 的包即使名字是 @deepseek-ai/* 也放行（如 @deepseek-ai/dsh-session-notes）。
 */
function isProtected(moduleName, bundle) {
  if (moduleName === SELF || moduleName.startsWith(SELF + '/')) return true
  if (moduleName.startsWith('cordis:')) return true
  if (moduleName.startsWith('@deepseek-ai/')) return !isUserBundle(bundle)
  return false
}

/** 是否为用户自己安装到 profile 的第三方包。 */
function isUserBundle(bundle) {
  return !!bundle && bundle.availability === 'profile' && !bundle.official
}

/** 模块名 → 包名（`@scope/pkg/sub` → `@scope/pkg`）。 */
export function packageOf(moduleName) {
  const parts = moduleName.split('/')
  return moduleName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 取本地化文本：优先中文，其次英文。 */
function localized(text) {
  if (!text) return undefined
  if (typeof text === 'string') return text
  return text['zh-CN'] ?? text.zh ?? text.en ?? Object.values(text)[0]
}

/** 把一段（可能中英混排的）描述压成一句简短提示：优先中文段、取第一句、超长截断。 */
export function brief(text, max = 42) {
  if (!text) return ''
  const s = String(text).replace(/\s+/g, ' ').trim()
  const parts = s.split(/\s+[·|｜]\s+/).map((p) => p.trim()).filter(Boolean)
  let pick = parts.find((p) => /[一-鿿]/.test(p)) ?? parts[0] ?? s
  const firstCjk = pick.search(/[一-鿿]/)
  if (firstCjk > 12) pick = pick.slice(firstCjk)
  pick = pick.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/)[0] || pick
  return pick.length > max ? pick.slice(0, max - 1) + '…' : pick
}

/** 已装插件的中文简介（按 patchId 或包名查），查不到时用 brief() 自动截取。client.js 里有同一份。 */
const ZH_BRIEF = {
  'dsh-kanban': '人工看板 + AI 执行的工作流',
  'dsh-kanban-workflow': '看板的 AI 工作流执行器',
  '@cerbur/clutch-dsh-worktree': '按 Git worktree 分组显示会话',
  '@goodandready/dsh-cron': '后台定时任务与自动化运行',
  '@kyf-eng/dsh-threads': '主对话把任务派发到子线程会话并回收摘要',
  '@liustack/modlens': '让纯文本模型也能看图',
  '@xxxyz/dsh-mcp-manager': 'MCP 服务与技能管理器',
  'bili-native': '上下文压缩（主体）',
  'bili-compaction-gate': '上下文压缩的触发闸门',
  'dsh-agent-skills': '发现和管理 Claude Code / Codex 等技能',
  'dsh-agents-md': '查看和编辑生效中的 AGENTS.md 指令文件',
  'dsh-answer-highlighter': '给回答做标注和高亮',
  'dsh-bash-terminal-ts': 'Windows 多 Shell 命令工具 + 底部终端',
  'dsh-claude-style': 'Claude Code 桌面版风格主题',
  'dsh-codex-subscription': '用 ChatGPT / Codex 订阅当模型',
  'dsh-context': '上下文构成分析面板与 /context 命令',
  'dsh-free-search': '免费网页搜索',
  'dsh-git-changes': 'Git 变更面板：暂存、提交、对比差异',
  'dsh-nextsteps': '回答后推荐下一步追问',
  'dsh-oh-my-claude': '把本机 Claude Code CLI 接入为模型',
  'dsh-plugin-desktop-notify': '任务完成/待确认时发桌面通知',
  'dsh-plugin-message-edit': '编辑已发消息、分支对话',
  'dsh-plugin-wallpaper-engine': 'Wallpaper Engine 动态壁纸背景',
  'dsh-prompt-manager': '提示词库，可注入会话级系统提示',
  'dsh-vitals': 'CPU / 内存 / 显卡负载监控面板',
  'dsh-windows-mcp': 'Windows 桌面自动化（MCP）',
  'dsh-agent-compare': '多方案对比：并排比较回答、文件或网页',
  'dsh-file-activity': '侧栏文件活动：最近访问与读写统计',
  '@deepseek-ai/dsh-session-notes': '会话笔记：每个会话可记多条笔记、置顶和配色',
}

/** 取一项的简介：手写中文优先，否则自动截取。 */
function briefOf(patchId, pkg, full) {
  return (patchId && ZH_BRIEF[patchId]) || ZH_BRIEF[pkg] || brief(full)
}

/**
 * 读取可开关的插件清单（条目 + 整包未启用的包）。
 * @param {object} manager pluginManager（或浏览器端的等价包装）
 * @param {{showDisabledBundles?: boolean}} [opts] 是否包含整包未启用的插件
 */
export async function readItems(manager, opts = {}) {
  const includeBundles = opts.showDisabledBundles !== false
  const [plugins, bundles] = await Promise.all([manager.listPlugins(), manager.listBundles()])
  const bundleOfEntry = new Map()
  for (const b of bundles) for (const r of b.rows ?? []) if (r.entryId) bundleOfEntry.set(r.entryId, b)

  const items = []
  for (const row of plugins) {
    if (!row || typeof row.moduleName !== 'string' || row.readOnlyReason) continue
    const b = bundleOfEntry.get(row.entryId)
    if (isProtected(row.moduleName, b)) continue
    const full = localized(row.meta?.description) ?? localized(b?.meta?.description) ?? b?.description ?? ''
    const pkg = b?.name ?? packageOf(row.moduleName)
    items.push({
      kind: 'entry',
      id: row.entryId,
      entryId: row.entryId,
      bundle: isUserBundle(b) ? b.name : undefined,
      moduleName: row.moduleName,
      pkg,
      title: localized(row.meta?.title) ?? row.patchId ?? row.moduleName,
      patchId: row.patchId,
      enabled: !!row.enabled,
      failed: row.fiberPhase === 'failed',
      description: briefOf(row.patchId, pkg, full),
      fullDescription: full,
    })
  }
  if (includeBundles) {
    for (const b of bundles) {
      if (!b.installed || b.enabled || !isUserBundle(b) || b.readOnlyReason) continue
      if (isProtected(b.name, b)) continue
      const full = localized(b.meta?.description) ?? b.description ?? ''
      items.push({
        kind: 'bundle',
        id: 'bundle:' + b.name,
        bundle: b.name,
        moduleName: b.name,
        pkg: b.name,
        title: localized(b.meta?.title) ?? b.name,
        enabled: false,
        failed: false,
        description: briefOf(undefined, b.name, full),
        fullDescription: full,
      })
    }
  }
  items.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.title.localeCompare(b.title))
  return items
}

/** 常用插件排到最前（保持各自原有顺序），并标记 pinned。 */
export function sortPinned(items, pinned) {
  const set = new Set(pinned ?? [])
  for (const it of items) it.pinned = set.has(it.pkg)
  return [...items.filter((i) => i.pinned), ...items.filter((i) => !i.pinned)]
}

/** 关闭这一项前是否需要确认（按包名或 patchId 命中名单）。 */
export function needsConfirm(item, list) {
  if (item.kind === 'bundle' || !item.enabled) return false
  return (list ?? []).some((n) => n === item.pkg || n === item.patchId || n === item.moduleName)
}

// ───────────── 可靠执行：发出 → 等真实状态 → 没生效就重试（client.js 有同一份，改动时两边同步） ─────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读取运行时条目（直接按 entryId 查，不经过列表过滤）。 */
async function entryState(manager, entryId) {
  const rows = await manager.listPlugins()
  return rows.find((r) => r.entryId === entryId)
}

/** 反复读取直到 check 成立；超时返回 undefined。 */
async function waitFor(read, check, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    let value
    try { value = await read() } catch { value = undefined }
    if (check(value)) return value === undefined ? true : value
    if (Date.now() >= end) return undefined
    await sleep(300)
  }
}

/** 从 ChangeResult 的 warnings 里挑出“DSH 核心插件在等待某服务”的行。 */
export function corePending(warnings) {
  return (warnings ?? []).filter((w) => /\(@deepseek-ai\/[^)]+\): pending/.test(String(w)))
}

/**
 * 可靠地设置一个条目的开关：条目还没出现就先等（整包刚启用时会晚一点），
 * 发出请求后等运行时状态真正变化，没生效最多重试 6 次。
 * @returns {Promise<{ok:boolean, reason?:string, restart?:boolean, startFailed?:string, warnings:string[]}>}
 */
export async function setEntry(manager, entryId, enabled) {
  let reason = '未知原因'
  let warnings = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cur = await waitFor(() => entryState(manager, entryId), (row) => !!row || !enabled, attempt === 0 ? 4000 : 2000)
    const row = cur === true ? undefined : cur
    if (!row) {
      if (!enabled) return { ok: true, warnings }       // 条目已不存在（整包已停用），视为已关闭
      reason = '插件条目还没出现（插件包可能还在加载）'
      continue
    }
    if (row.enabled === enabled) {
      return { ok: true, warnings, startFailed: enabled && row.fiberPhase === 'failed' ? (row.diagnostic ?? '启动失败') : undefined }
    }
    try {
      const r = await manager.setPluginEnabled(entryId, enabled)
      warnings = r?.warnings ?? []
      if (r?.application === 'overridden') return { ok: false, reason: '被更高优先级的配置覆盖', warnings }
      if (r?.application === 'restart-required') return { ok: true, restart: true, warnings }
      if (r?.application === 'failed' && r.error?.diagnostic) reason = r.error.diagnostic
      else if (r?.application === 'failed') reason = r.error?.code ?? '操作失败'
    } catch (error) {
      // 被拒（例如上一个改动还在应用）：状态不会变，短暂等待后直接重试
      reason = error?.message ?? String(error)
      await sleep(300 * (attempt + 1))
      continue
    }
    const after = await waitFor(() => entryState(manager, entryId),
      (row2) => (row2 ? row2.enabled === enabled : !enabled), 3000)
    if (after) {
      const row2 = after === true ? undefined : after
      return { ok: true, warnings, startFailed: enabled && row2?.fiberPhase === 'failed' ? (row2.diagnostic ?? reason) : undefined }
    }
    await sleep(300 * (attempt + 1))
  }
  return { ok: false, reason, warnings }
}

/** 可靠地设置一个插件包的启用状态（同样等真实状态、失败重试）。 */
export async function setBundle(manager, name, enabled) {
  let reason = '未知原因'
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const bundles = await manager.listBundles()
      const b = bundles.find((x) => x.name === name)
      if (!b) return { ok: false, reason: '找不到这个插件包' }
      if (b.enabled === enabled) return { ok: true }
      const r = await manager.setBundleEnabled(name, enabled)
      if (r?.application === 'restart-required') return { ok: true, restart: true }
      if (r?.application === 'failed') reason = r.error?.diagnostic ?? r.error?.code ?? '操作失败'
    } catch (error) {
      reason = error?.message ?? String(error)
      await sleep(300 * (attempt + 1))
      continue
    }
    const done = await waitFor(async () => (await manager.listBundles()).find((x) => x.name === name),
      (b) => !!b && b.enabled === enabled, 3000)
    if (done) return { ok: true }
    await sleep(300 * (attempt + 1))
  }
  return { ok: false, reason }
}

/**
 * 关闭条目后，如果它所属的包里已经没有开着的条目，就把整个包停用（卸载它的前端部分）。
 */
async function retireBundleIfEmpty(manager, bundle) {
  if (!bundle) return
  const items = await readItems(manager)
  const rows = items.filter((i) => i.kind === 'entry' && i.bundle === bundle)
  if (rows.length > 0 && rows.every((i) => !i.enabled)) await setBundle(manager, bundle, false)
}

/**
 * 关闭一个条目，并检查是否有 DSH 核心插件因此卡住（例如关掉 billion-context 后官方智能体预设会等待它的服务）；
 * 如果有，立即重新打开它。
 * @returns {Promise<{ok:boolean, reason?:string, restart?:boolean, coreDependency?:string}>}
 */
export async function disableEntry(manager, item) {
  const r = await setEntry(manager, item.entryId, false)
  if (!r.ok) return r
  const pending = corePending(r.warnings)
  if (pending.length > 0) {
    // 先重新打开；打开后等待消失，才说明确实是它导致的（避免把早就存在的等待算到它头上）
    const back = await setEntry(manager, item.entryId, true)
    if (corePending(back.warnings).length === 0) {
      const service = /waiting for service: ([^)\s]+)/.exec(pending[0])?.[1]
      return { ok: false, coreDependency: service ?? pending[0], reason: 'DSH 核心功能依赖它' }
    }
    return await setEntry(manager, item.entryId, false)
  }
  return r
}

/**
 * 切换一项并返回给用户看的结果。
 * @returns {Promise<{ok:boolean, level:'ok'|'warn'|'error', text:string, turnedOff?:boolean}>}
 */
export async function toggleItem(manager, item) {
  if (item.kind === 'bundle') {
    // 整包开启，并把包里被单独关掉的条目（例如插件市场整包关闭时写的 disabled: true）一并打开
    const b = await setBundle(manager, item.bundle, true)
    if (!b.ok) return { ok: false, level: 'error', text: `开启「${item.title}」失败：${b.reason}` }
    if (b.restart) return { ok: true, level: 'warn', text: `已开启「${item.title}」，需要重启 DSH 才能生效` }
    const bundles = await manager.listBundles()
    const rows = (bundles.find((x) => x.name === item.bundle)?.rows ?? [])
    const problems = []
    for (const row of rows) {
      const entryId = row.entryId ?? 'include:' + row.rowId
      const r = await setEntry(manager, entryId, true)
      if (!r.ok) problems.push(`${row.rowId}：${r.reason}`)
      else if (r.startFailed) problems.push(`${row.rowId} 启动失败：${r.startFailed}（重启 DSH 通常可解决）`)
    }
    if (problems.length) return { ok: false, level: 'warn', text: `已开启「${item.title}」，但有问题：\n${problems.join('\n')}` }
    return { ok: true, level: 'ok', text: `已开启「${item.title}」，已即时生效` }
  }

  if (item.enabled) {
    const r = await disableEntry(manager, item)
    if (r.coreDependency) {
      return { ok: false, level: 'warn', text: `「${item.title}」被 DSH 核心功能依赖（${r.coreDependency}），关掉会让核心功能卡住，已自动重新打开。` }
    }
    if (!r.ok) return { ok: false, level: 'error', text: `关闭「${item.title}」失败：${r.reason}` }
    if (r.restart) return { ok: true, level: 'warn', text: `已关闭「${item.title}」，需要重启 DSH 才能生效` }
    try { await retireBundleIfEmpty(manager, item.bundle) } catch { /* 前端残留可刷新页面 */ }
    return { ok: true, level: 'ok', text: `已关闭「${item.title}」，已即时生效`, turnedOff: true }
  }

  const r = await setEntry(manager, item.entryId, true)
  if (!r.ok) return { ok: false, level: 'error', text: `开启「${item.title}」失败：${r.reason}` }
  if (r.restart) return { ok: true, level: 'warn', text: `已开启「${item.title}」，需要重启 DSH 才能生效` }
  if (r.startFailed) return { ok: false, level: 'warn', text: `已开启「${item.title}」，但启动失败：${r.startFailed}（重启 DSH 通常可解决）` }
  return { ok: true, level: 'ok', text: `已开启「${item.title}」，已即时生效` }
}

// ───────────── 批量关闭 / 恢复 ─────────────

/** 批量关闭会关掉哪些：所有开着的条目，“关闭前需确认”名单里的除外。 */
export async function batchTargets(manager, keepList) {
  const items = await readItems(manager)
  return items.filter((i) => i.kind === 'entry' && i.enabled && !needsConfirm(i, keepList))
}

/**
 * 批量关闭：逐个可靠关闭（核心依赖的会自动重新打开并跳过），最后把关空的包整包停用（卸载前端）。
 * @returns {Promise<{off:object[], kept:Array<{item:object, why:string}>, failed:Array<{item:object, why:string}>, restart:object[]}>}
 */
export async function batchDisable(manager, targets) {
  const off = []
  const kept = []
  const failed = []
  const restart = []
  for (const t of targets) {
    const r = await disableEntry(manager, t)
    if (r.coreDependency) kept.push({ item: t, why: `DSH 核心依赖（${r.coreDependency}）` })
    else if (!r.ok) failed.push({ item: t, why: r.reason })
    else if (r.restart) restart.push(t)
    else off.push(t)
  }
  const bundles = [...new Set(off.map((t) => t.bundle).filter(Boolean))]
  for (const name of bundles) {
    try { await retireBundleIfEmpty(manager, name) } catch { /* 前端残留可刷新页面 */ }
  }
  return { off, kept, failed, restart }
}

/**
 * 按快照恢复：先把被整包停用的包重新启用，再逐个打开快照里的条目（会等条目出现）。
 * @param {Array<{entryId:string, bundle?:string}>} snapshot
 * @returns {Promise<{on:string[], failed:Array<{entryId:string, why:string}>, startFailed:Array<{entryId:string, why:string}>}>}
 */
export async function batchRestore(manager, snapshot) {
  const on = []
  const failed = []
  const startFailed = []
  const wanted = [...new Set(snapshot.map((s) => s.bundle).filter(Boolean))]
  const bundleProblems = new Map()
  for (const name of wanted) {
    const r = await setBundle(manager, name, true)
    if (!r.ok) bundleProblems.set(name, r.reason)
  }
  for (const s of snapshot) {
    if (s.bundle && bundleProblems.has(s.bundle)) {
      failed.push({ entryId: s.entryId, why: `插件包未能启用：${bundleProblems.get(s.bundle)}` })
      continue
    }
    const r = await setEntry(manager, s.entryId, true)
    if (!r.ok) failed.push({ entryId: s.entryId, why: r.reason })
    else if (r.startFailed) { startFailed.push({ entryId: s.entryId, why: r.startFailed }); on.push(s.entryId) }
    else on.push(s.entryId)
  }
  return { on, failed, startFailed }
}

// ───────────── 模糊匹配 ─────────────

function isSubsequence(needle, hay) {
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i += 1
  return i === needle.length
}

/** 按名称模糊匹配：完全相等 > 包含 > 子序列，返回最高一档的全部结果。 */
export function fuzzyMatch(items, query) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const fields = (it) => [it.moduleName, it.pkg, it.patchId, it.title]
    .filter(Boolean).map((s) => String(s).toLowerCase())
  const tiers = [(f) => f === q, (f) => f.includes(q), (f) => isSubsequence(q, f)]
  for (const test of tiers) {
    const hits = items.filter((it) => fields(it).some(test))
    if (hits.length > 0) return hits
  }
  return []
}

// ───────────── 文案 ─────────────

function stateText(it) {
  if (it.kind === 'bundle') return '⚪ 关（整包未启用）'
  return it.enabled ? '🟢 开' : '⚪ 关'
}

/** `/toggle list` 的文本：按插件包分组。 */
function renderList(items, showDescription) {
  if (items.length === 0) return '当前 profile 里没有可开关的第三方插件。'
  const groups = new Map()
  for (const it of items) {
    if (!groups.has(it.pkg)) groups.set(it.pkg, [])
    groups.get(it.pkg).push(it)
  }
  const on = items.filter((i) => i.enabled).length
  const lines = [`第三方插件共 ${items.length} 个（开 ${on} / 关 ${items.length - on}）：`, '']
  for (const [pkg, list] of groups) {
    lines.push(`📦 ${pkg}`)
    for (const it of list) {
      const failed = it.failed ? '（加载失败）' : ''
      const desc = showDescription && it.description ? ` —— ${it.description}` : ''
      lines.push(`- ${stateText(it)}  ${it.pinned ? '⭐ ' : ''}${it.title}${failed}${desc}`)
    }
    lines.push('')
  }
  lines.push('提示：只输入 /toggle 回车，会弹出可点选的列表。')
  return lines.join('\n')
}

const USAGE = [
  '用法：',
  '- /toggle：弹出插件列表，点一下即可开/关',
  '- /toggle list：以文字列出所有第三方插件和开/关状态',
  '- /toggle <名称>：按名称切换（支持模糊匹配）',
  '- /toggle 按钮 显示 / 隐藏：控制输入框里的 🔌 按钮',
  '- /toggle 常用 <名称>：加入/移出常用（排在列表最前）',
  '- /toggle 全部关闭：关闭所有第三方插件（“关闭前需确认”名单除外），用于排查问题',
  '- /toggle 恢复：恢复到批量关闭之前的状态',
].join('\n')

// ───────────── 插件入口 ─────────────

/**
 * @param {any} ctx Host 插件上下文
 * @param {any} config 本插件配置（volatile 字段，读取用 readConfig）
 */
export function apply(ctx, config) {
  /** 每个会话上一次模糊匹配出的候选 id，供 /toggle <编号> 使用（按会话分开，互不串）。 */
  const candidatesBySession = new Map()
  const opt = (key, fallback) => readConfig(config, key, fallback)

  /** 串行执行：同一时间只跑一个 /toggle，避免批量操作和单个开关互相打架。 */
  let queue = Promise.resolve()
  const serial = (fn) => {
    const run = queue.then(fn, fn)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 写本插件配置（只改 volatile 字段，不会让插件重载）。 */
  const writeConfig = async (patch) => {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') throw new Error('设置服务不可用')
    const view = settings.describe().find((v) => v.ns === 'quick-toggle' || v.ns === 'include:quick-toggle')
    await settings.update(view ? view.ns : 'quick-toggle', patch)
  }

  /** /toggle 按钮 显示|隐藏 */
  const setButton = async (word) => {
    const current = opt('showButton', true) !== false
    let show
    if (/^(显示|开|开启|on|show|true)$/i.test(word)) show = true
    else if (/^(隐藏|关|关闭|off|hide|false)$/i.test(word)) show = false
    else if (word === '') show = !current
    else return { kind: 'error', text: '用法：/toggle 按钮 显示  或  /toggle 按钮 隐藏' }
    if (show === current) return { kind: 'success', text: `输入框的 🔌 按钮当前已经是${show ? '显示' : '隐藏'}状态。` }
    await writeConfig({ showButton: show })
    return { kind: 'success', text: `已${show ? '显示' : '隐藏'}输入框的 🔌 按钮（几秒内或切回窗口时生效）。` }
  }

  /** /toggle 全部关闭：先预览，带“确认”才执行。 */
  const runBatchDisable = async (confirmed) => {
    const keep = opt('confirmBeforeDisable', DEFAULT_CONFIRM)
    const targets = await batchTargets(ctx.pluginManager, keep)
    if (targets.length === 0) return { kind: 'success', text: '没有可以批量关闭的插件（“关闭前需确认”名单里的会保留）。' }
    if (!confirmed) {
      const names = targets.map((t) => t.title).join('、')
      return {
        kind: 'success',
        text: `将关闭 ${targets.length} 个插件：${names}\n保留“关闭前需确认”名单：${keep.join('、') || '（空）'}\n之后可用 /toggle 恢复 一键还原。确定执行请输入：/toggle 全部关闭 确认`,
      }
    }
    // 先写快照（与已有快照合并，连续批量关闭也能还原到最初状态）
    const old = opt('batchSnapshot', [])
    const merged = [...old]
    for (const t of targets) if (!merged.some((s) => s.entryId === t.entryId)) merged.push({ entryId: t.entryId, bundle: t.bundle ?? '' })
    await writeConfig({ batchSnapshot: merged })
    const { off, kept, failed, restart } = await batchDisable(ctx.pluginManager, targets)
    // 没关掉 / 被自动保留的，从快照里拿掉，免得恢复时误开
    const notOff = new Set([...kept, ...failed].map((x) => x.item.entryId))
    if (notOff.size) await writeConfig({ batchSnapshot: merged.filter((s) => !notOff.has(s.entryId) || old.some((o) => o.entryId === s.entryId)) })
    const lines = [`已批量关闭 ${off.length} 个插件。用 /toggle 恢复 可还原。`]
    if (restart.length) lines.push(`另有 ${restart.length} 个已保存，需要重启 DSH 才会真正关闭：${restart.map((t) => t.title).join('、')}`)
    if (kept.length) lines.push(`自动保留 ${kept.length} 个（${kept.map((k) => `${k.item.title}：${k.why}`).join('；')}），建议加入“关闭前需确认”名单`)
    if (failed.length) lines.push(`未能关闭：${failed.map((f) => `${f.item.title}（${f.why}）`).join('、')}`)
    lines.push('界面上残留的按钮或图标，在 /toggle 列表底部点「🔄 刷新页面」即可。')
    return { kind: failed.length ? 'error' : 'success', text: lines.join('\n') }
  }

  /** /toggle 恢复：按快照还原，成功的从快照里移除，失败的保留以便再次恢复。 */
  const runBatchRestore = async () => {
    const snapshot = opt('batchSnapshot', [])
    if (!snapshot.length) return { kind: 'success', text: '没有需要恢复的批量关闭记录。' }
    const { on, failed, startFailed } = await batchRestore(ctx.pluginManager, snapshot)
    const failedIds = new Set(failed.map((f) => f.entryId))
    await writeConfig({ batchSnapshot: snapshot.filter((s) => failedIds.has(s.entryId)) })
    const short = (id) => id.replace(/^include:/, '')
    const lines = [`已恢复 ${on.length} 个插件。`]
    if (startFailed.length) {
      lines.push(`其中 ${startFailed.length} 个已打开但启动失败，重启 DSH 通常可解决：${startFailed.map((s) => `${short(s.entryId)}（${s.why}）`).join('、')}`)
    }
    if (failed.length) lines.push(`未能恢复：${failed.map((f) => `${short(f.entryId)}（${f.why}）`).join('、')}（记录已保留，可再次 /toggle 恢复）`)
    lines.push('界面有缺失时，在 /toggle 列表底部点「🔄 刷新页面」。')
    return { kind: failed.length ? 'error' : 'success', text: lines.join('\n') }
  }

  /** /toggle 常用 <名称>：把插件所属的包加入/移出常用。 */
  const togglePin = async (query) => {
    const all = await readItems(ctx.pluginManager)
    const hits = fuzzyMatch(all, query)
    const pkgs = [...new Set(hits.map((h) => h.pkg))]
    if (pkgs.length === 0) return { kind: 'error', text: `没有找到匹配「${query}」的插件。` }
    if (pkgs.length > 1) return { kind: 'error', text: `「${query}」匹配到多个插件包：${pkgs.join('、')}，请写得更具体一些。` }
    const pinned = [...opt('pinned', [])]
    const pkg = pkgs[0]
    const has = pinned.includes(pkg)
    await writeConfig({ pinned: has ? pinned.filter((p) => p !== pkg) : [...pinned, pkg] })
    return { kind: 'success', text: has ? `已把 ${pkg} 移出常用。` : `已把 ${pkg} 加入常用，会排在列表最前面。` }
  }

  const run = async (item, confirmed) => {
    if (!confirmed && needsConfirm(item, opt('confirmBeforeDisable', DEFAULT_CONFIRM))) {
      return {
        kind: 'error',
        text: `「${item.title}」在“关闭前需确认”名单里，关掉可能影响对话或界面。确定要关闭请输入：/toggle ${item.id} 确认`,
      }
    }
    const r = await toggleItem(ctx.pluginManager, item)
    const tail = r.turnedOff ? '\n如果界面上还残留它的按钮或图标，在 /toggle 列表底部点「🔄 刷新页面」即可。' : ''
    return { kind: r.ok ? 'success' : 'error', text: r.text + tail }
  }

  ctx.commands.register({
    name: 'toggle',
    description: '快捷开关第三方插件（直接回车弹出列表）',
    input: { hint: 'list | 插件名' },
    handler: (invocation) => serial(() => handle(invocation)),
  })

  /** /toggle 的实际处理逻辑。 */
  async function handle({ rawInput, agent }) {
      const sessionKey = agent?.id ?? '_'
      let lastCandidates = candidatesBySession.get(sessionKey) ?? []
      const remember = (ids) => {
        lastCandidates = ids
        if (ids.length) candidatesBySession.set(sessionKey, ids)
        else candidatesBySession.delete(sessionKey)
      }
      let arg = (rawInput ?? '').trim()
      try {
        if (arg === '' || arg === 'help' || arg === '帮助') return { kind: 'success', text: USAGE }

        const btn = /^(按钮|button)\s*(.*)$/i.exec(arg)
        if (btn) return await setButton(btn[2].trim())

        // 末尾的“确认 / confirm / !”表示已确认（受保护插件、批量关闭）
        let confirmed = false
        const conf = /\s+(确认|confirm|!)$/i.exec(arg)
        if (conf) { confirmed = true; arg = arg.slice(0, conf.index).trim() }

        if (/^(全部关闭|关闭全部|批量关闭|disable-all)$/i.test(arg)) return await runBatchDisable(confirmed)
        if (/^(恢复|restore)$/i.test(arg)) return await runBatchRestore()

        const pin = /^(常用|pin)\s+(.+)$/i.exec(arg)
        if (pin) return await togglePin(pin[2].trim())

        const items = sortPinned(
          await readItems(ctx.pluginManager, { showDisabledBundles: opt('showDisabledBundles', true) }),
          opt('pinned', []),
        )
        if (arg === 'list' || arg === 'ls' || arg === '列表') {
          return { kind: 'success', text: renderList(items, opt('showDescription', true)) }
        }

        // 精确 id（弹出列表点选时传来的）；即使列表隐藏了整包未启用的插件，也按全量清单查
        const all = items.some((i) => i.id === arg) ? items : await readItems(ctx.pluginManager)
        const exact = all.find((i) => i.id === arg)
        if (exact) { remember([]); return await run(exact, confirmed) }

        const num = /^#?(\d+)$/.exec(arg)
        if (num && lastCandidates.length > 0) {
          const id = lastCandidates[Number(num[1]) - 1]
          if (id === undefined) return { kind: 'error', text: `编号超出范围：请输入 1～${lastCandidates.length}。` }
          const item = all.find((i) => i.id === id)
          if (!item) return { kind: 'error', text: '该候选插件已不存在，请重新 /toggle <名称>。' }
          remember([])
          return await run(item, confirmed)
        }

        const hits = fuzzyMatch(items, arg)
        if (hits.length === 0) {
          return { kind: 'error', text: `没有找到匹配「${arg}」的第三方插件。直接输入 /toggle 回车可弹出列表。` }
        }
        if (hits.length === 1) { remember([]); return await run(hits[0], confirmed) }
        remember(hits.map((i) => i.id))
        const lines = [`「${arg}」匹配到 ${hits.length} 个插件，请输入 /toggle <编号> 选择：`, '']
        hits.forEach((it, i) => lines.push(`${i + 1}. ${stateText(it)}  ${it.title}（${it.moduleName}）`))
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `执行失败：${error?.message ?? String(error)}` }
      }
  }
}
