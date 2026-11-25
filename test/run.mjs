// dsh-quick-toggle 自测：node test/run.mjs
// 用“有状态 + 刁难”的模拟插件管理服务驱动 Host 端命令，再加载浏览器端做冒烟测试。
// 模拟内容：补丁层记住 disabled、整包停用后条目消失、整包启用后条目延迟出现、
// 随机拒绝请求、关掉某插件会让核心预设 pending、某插件开启后启动失败。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`) } catch (error) { console.log(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1 }
}

// ───────── 合成的插件包清单 ─────────
function makeBundles() {
  const user = (name, rows, enabled = true) => ({ name, availability: 'profile', official: false, installed: true, enabled, description: `${name} description`, rows: rows.map((rowId) => ({ rowId, moduleName: name })) })
  return [
    { name: '@deepseek-ai/dsh-base', availability: 'installation', official: false, installed: false, enabled: true, rows: [{ rowId: 'llm', moduleName: '@deepseek-ai/dsh-llm' }] },
    user('dsh-quick-toggle', ['quick-toggle']),
    user('pkg-kanban', ['kanban', 'kanban-workflow']),
    user('pkg-notes', ['notes']),
    user('pkg-theme', ['theme']),
    user('pkg-compaction', ['compaction-native', 'compaction-gate']),
    user('pkg-flaky', ['flaky']),
    user('pkg-sleeping', ['sleeping'], false),
    user('@deepseek-ai/dsh-session-notes', ['session-notes'], false),
  ]
}

function makeManager({ rejectRate = 0, seed = 7 } = {}) {
  const bundles = makeBundles()
  const disabled = new Set()
  const appearAt = new Map()
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const maybeReject = () => { if (rand() < rejectRate) throw new Error('profile busy: another change is being applied') }
  const coreWarn = () => (disabled.has('include:compaction-gate') || !bundles.find((b) => b.name === 'pkg-compaction').enabled)
    ? ['preset-standard (@deepseek-ai/dsh-agent-preset): pending (waiting for service: compactionPolicy)'] : []
  const pm = {
    calls: [],
    listBundles: async () => bundles.map((b) => ({ ...b, rows: b.rows.map((r) => ({ ...r, entryId: b.enabled ? 'include:' + r.rowId : undefined })) })),
    listPlugins: async () => bundles.filter((b) => b.enabled && (appearAt.get(b.name) ?? 0) <= Date.now()).flatMap((b) => b.rows.map((r) => {
      const id = 'include:' + r.rowId
      const on = !disabled.has(id)
      const failed = on && r.rowId === 'flaky' && pm.flakyBroken
      return { entryId: id, moduleName: r.moduleName, patchId: r.rowId, enabled: on, fiberPhase: on ? (failed ? 'failed' : 'active') : null, ...(failed ? { diagnostic: 'command "flaky" is already registered' } : {}) }
    })),
    setPluginEnabled: async (id, en) => {
      maybeReject()
      pm.calls.push(`entry ${id}=${en}`)
      if (!(await pm.listPlugins()).some((p) => p.entryId === id)) return { application: 'failed', error: { code: 'unknown-plugin' } }
      en ? disabled.delete(id) : disabled.add(id)
      return { application: 'applied', warnings: coreWarn() }
    },
    setBundleEnabled: async (name, en) => {
      maybeReject()
      pm.calls.push(`bundle ${name}=${en}`)
      const b = bundles.find((x) => x.name === name)
      b.enabled = en
      if (en) appearAt.set(name, Date.now() + 500)
      return { application: 'applied', warnings: coreWarn() }
    },
  }
  return pm
}

async function makeHost(pm, initial = {}) {
  const host = await import(pathToFileURL(join(root, 'index.js')).href)
  const cfg = {}
  const vol = (k, v) => { cfg[k] = { get: () => v } }
  vol('confirmBeforeDisable', ['pkg-theme']); vol('pinned', []); vol('batchSnapshot', []); vol('showButton', true)
  for (const [k, v] of Object.entries(initial)) vol(k, v)
  const settings = { describe: () => [{ ns: 'quick-toggle' }], update: async (ns, patch) => { for (const [k, v] of Object.entries(patch)) vol(k, v) } }
  let handler
  host.apply({ commands: { register: (d) => { handler = d.handler } }, pluginManager: pm, get: (n) => (n === 'settings' ? settings : undefined) }, cfg)
  const run = async (line, sessionId = 's1') => (await handler({ rawInput: line, agent: { id: sessionId } }))
  return { host, cfg, run }
}

const onNow = async (pm) => (await pm.listPlugins()).filter((p) => p.enabled).map((p) => p.patchId).sort()

console.log('Host')
await test('列表：排除自己和官方核心，放行用户自装的 @deepseek-ai/* 包', async () => {
  const pm = makeManager()
  const { run } = await makeHost(pm)
  const r = await run('list')
  assert.match(r.text, /kanban/)
  assert.match(r.text, /session-notes/)
  assert.doesNotMatch(r.text, /quick-toggle/)
  assert.doesNotMatch(r.text, /dsh-llm/)
})

await test('模糊匹配多个时给编号，编号按会话隔离', async () => {
  const pm = makeManager()
  const { run } = await makeHost(pm)
  const exact = await run('kanban', 's1')                // 完全等于某条目 id → 只命中它
  assert.match(exact.text, /已关闭「kanban」/)
  await run('kanban', 's1')                              // 再开回来
  const r = await run('kan', 's1')
  assert.match(r.text, /匹配到 2 个/)
  const other = await run('2', 's2')
  assert.equal(other.kind, 'error')                      // 另一个会话没有候选
  const pick = await run('2', 's1')
  assert.match(pick.text, /已关闭「kanban-workflow」/)
})

await test('“关闭前需确认”名单：不带确认会被拦下', async () => {
  const pm = makeManager()
  const { run } = await makeHost(pm)
  const r = await run('theme')
  assert.equal(r.kind, 'error')
  assert.equal(pm.calls.length, 0)
  const ok = await run('theme 确认')
  assert.match(ok.text, /已关闭「theme」/)
})

await test('关掉包里最后一个条目会连包一起停用；整包开启会打开全部条目', async () => {
  const pm = makeManager()
  const { run } = await makeHost(pm)
  await run('notes')
  assert.ok(pm.calls.includes('bundle pkg-notes=false'))
  const r = await run('bundle:pkg-notes')
  assert.match(r.text, /已开启/)
  assert.ok((await onNow(pm)).includes('notes'))
})

await test('核心依赖保护：关掉后核心预设 pending 会自动重新打开', async () => {
  const pm = makeManager()
  const { run } = await makeHost(pm)
  const r = await run('compaction-gate')
  assert.match(r.text, /核心功能依赖/)
  assert.ok((await onNow(pm)).includes('compaction-gate'))
})

await test('批量关闭→恢复：40% 随机拒绝下仍能完整往返', async () => {
  const pm = makeManager({ rejectRate: 0.4 })
  const { run, cfg } = await makeHost(pm)
  const before = await onNow(pm)
  const preview = await run('全部关闭')
  assert.match(preview.text, /确定执行请输入/)
  const off = await run('全部关闭 确认')
  assert.match(off.text, /自动保留 1 个/)              // compaction-gate 被识别为核心依赖
  assert.ok((await onNow(pm)).includes('theme'))       // 确认名单里的保留
  assert.ok(cfg.batchSnapshot.get().length > 0)
  const back = await run('恢复')
  assert.equal(back.kind, 'success', back.text)
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(await onNow(pm), before)
  assert.equal(cfg.batchSnapshot.get().length, 0)
})

await test('开启后启动失败会单独报告', async () => {
  const pm = makeManager()
  const { run } = await makeHost(pm)
  await run('flaky')
  pm.flakyBroken = true
  const r = await run('flaky')
  assert.match(r.text, /启动失败/)
})

await test('常用：加入后排在列表最前', async () => {
  const pm = makeManager()
  const { run, cfg } = await makeHost(pm)
  await run('常用 notes')
  assert.deepEqual(cfg.pinned.get(), ['pkg-notes'])
  const r = await run('list')
  assert.match(r.text.split('\n')[2], /pkg-notes/)
})

console.log('Client')
await test('浏览器端加载：注册按钮、配置面板和 /toggle 弹出列表', async () => {
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } }, addEventListener() {}, removeEventListener() {}, location: { reload() {} }, localStorage: { getItem: () => null, setItem() {} } }
  globalThis.document = { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {} }) }
  new Function(readFileSync(join(root, 'client.js'), 'utf8'))()
  assert.equal(loaded.id, 'dsh-quick-toggle')
  const react = { createElement: () => ({}), useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect() {}, useRef: () => ({}), useCallback: (f) => f, Fragment: 'F' }
  const mod = loaded.factory((n) => { if (n === 'react') return react; throw new Error(n) })
  const pm = makeManager()
  const ok = (value) => ({ ok: true, value })
  const lines = []
  const sessions = { binding: () => ({ session: { command: async (l) => { lines.push(l); return ok({ matched: true }) } } }) }
  let deco
  const slots = []
  mod.apply({
    effect: (f) => f(), get: () => undefined,
    slots: { inject: (n, cb) => cb(), register: (o) => slots.push(o.name) },
    inject: (d, cb) => cb({
      remote: {
        pluginManager: { listPlugins: async () => ok(await pm.listPlugins()), listBundles: async () => ok(await pm.listBundles()) },
        settings: { describe: async () => ok({ namespaces: [{ ns: 'quick-toggle', value: { pinned: ['pkg-notes'], confirmBeforeDisable: ['pkg-theme'] } }] }), update: async () => ok({}) },
      },
      get: (n) => (n === 'commandUi' ? { decorate: (x) => { deco = x; return () => {} } } : n === 'sessions' ? sessions : undefined),
      effect: (f) => f(),
    }),
  })
  assert.deepEqual(slots.sort(), ['conversation.input.left', 'conversation.input.right', 'plugins.bundle.config'])
  const opts = await deco.ui.options({ sessionId: 's' })
  assert.equal(opts[0].group.label, '⭐ 常用')
  assert.ok(opts.find((o) => o.id === 'include:theme').confirmation)
  await deco.ui.onSelect(opts.find((o) => o.id === 'include:kanban'), { sessionId: 's' })
  assert.deepEqual(lines, ['/toggle include:kanban 确认'])
})

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
