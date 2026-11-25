// dsh-quick-toggle —— 浏览器端（Client 插件模块）。
//
// 入口：
// 1. 输入 `/toggle` 回车 → 输入框上方弹出可搜索的插件列表，点一项即切换
//    （commandUi.decorate + popupSelect，与官方 /permission 同机制；选中后交给 Host 执行 `/toggle <id>`）。
//    列表最后一组「设置（本插件）」可以隐藏/显示按钮、换按钮位置、刷新页面。
// 2. 输入框工具栏的 🔌 按钮（左侧或右侧）→ 下拉开关列表，就地显示结果。
// 3. 插件页 → 已安装 → 本插件详情页里的配置面板（slot `plugins.bundle.config`）。
// 配置写入本插件的 config（volatile 字段，改动即时生效、不重载插件）。
window.__ModuleLoader__.load({
  id: 'dsh-quick-toggle',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch (e) { ReactDOM = null; }
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    /** 本插件包名与配置条目 id。 */
    const SELF = 'dsh-quick-toggle';
    const ENTRY_ID = 'quick-toggle';

    /** 默认配置（与 index.js 的 Config 默认值一致）。 */
    const DEFAULT_CONFIRM = ['dsh-oh-my-claude', 'dsh-codex-subscription', 'dsh-claude-style', 'dshmarket', 'billion-context'];
    const DEFAULTS = {
      showButton: true,
      buttonPosition: 'left',
      showDisabledBundles: true,
      showDescription: true,
      confirmBeforeDisable: DEFAULT_CONFIRM,
      pinned: [],
      batchSnapshot: [],
    };

    /** 运行期拿到的服务引用（由 apply 填充）。 */
    const runtime = { ctx: null, manager: null, settings: null, sessions: null };

    // ───────────── remote 调用（返回 { ok, value } / { ok:false, error } 信封） ─────────────

    function getRemote(name, cached) {
      if (cached) return cached;
      try { return runtime.ctx && runtime.ctx.get(name); } catch (e) { return undefined; }
    }

    function unwrap(result) {
      if (result && result.ok === true) return result.value;
      if (result && result.ok === false) throw new Error((result.error && result.error.message) || 'remote call failed');
      return result;
    }

    /** 把 remote.pluginManager 包装成和 Host 端一样“直接返回值”的接口。 */
    function managerFacade() {
      const m = getRemote('remote.pluginManager', runtime.manager);
      if (!m) throw new Error('插件管理服务不可用');
      return {
        listPlugins: async () => unwrap(await m.listPlugins()),
        listBundles: async () => unwrap(await m.listBundles()),
        setPluginEnabled: async (id, en) => unwrap(await m.setPluginEnabled(id, en)),
        setBundleEnabled: async (name, en) => unwrap(await m.setBundleEnabled(name, en)),
      };
    }

    // ───────────── 配置：读取、缓存、写入、订阅 ─────────────

    let configCache = { ...DEFAULTS };
    const configListeners = new Set();

    function publishConfig(next) {
      configCache = next;
      for (const fn of configListeners) { try { fn(next); } catch (e) { /* 忽略 */ } }
    }

    async function readOwnSettingsView() {
      const settings = getRemote('remote.settings', runtime.settings);
      if (!settings || typeof settings.describe !== 'function') return undefined;
      const value = unwrap(await settings.describe());
      const views = (value && value.namespaces) || [];
      return views.find((v) => v.ns === ENTRY_ID || v.ns === 'include:' + ENTRY_ID);
    }

    /** 从设置服务读取最新配置并广播；读不到时保留默认值。同一时间只发一个请求。 */
    let refreshing = null;
    function refreshConfig() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          const view = await readOwnSettingsView();
          const value = (view && view.value) || {};
          const next = { ...DEFAULTS };
          for (const key of Object.keys(DEFAULTS)) if (value[key] !== undefined && value[key] !== null) next[key] = value[key];
          if (JSON.stringify(next) !== JSON.stringify(configCache)) publishConfig(next);
        } catch (e) { /* 读失败时保持现状 */ }
        return configCache;
      })().finally(() => { refreshing = null; });
      return refreshing;
    }

    /** 全局共用一个轮询：有组件在用配置时每 10 秒、窗口获得焦点时各读一次。 */
    let pollUsers = 0;
    let pollTimer = null;
    const onFocus = () => { refreshConfig(); };
    function startPolling() {
      pollUsers += 1;
      if (pollUsers === 1) {
        pollTimer = setInterval(refreshConfig, 10000);
        window.addEventListener('focus', onFocus);
      }
    }
    function stopPolling() {
      pollUsers = Math.max(0, pollUsers - 1);
      if (pollUsers === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        window.removeEventListener('focus', onFocus);
      }
    }

    /** 写配置（合并进本插件的 config），成功后立即广播。 */
    async function writeConfig(patch) {
      const settings = getRemote('remote.settings', runtime.settings);
      if (!settings || typeof settings.update !== 'function') throw new Error('设置服务不可用');
      const view = await readOwnSettingsView();
      unwrap(await settings.update(view ? view.ns : ENTRY_ID, patch, undefined));
      publishConfig({ ...configCache, ...patch });
    }

    /** React 钩子：订阅配置变化（读取由全局轮询负责）。 */
    function useConfig() {
      const [cfg, setCfg] = useState(configCache);
      useEffect(() => {
        let alive = true;
        const on = (next) => { if (alive) setCfg(next); };
        configListeners.add(on);
        startPolling();
        refreshConfig();
        return () => { alive = false; configListeners.delete(on); stopPolling(); };
      }, []);
      return cfg;
    }

    function reloadPage() {
      try { window.location.reload(); } catch (e) { /* 忽略 */ }
    }

    // ───────────── 插件清单（与 index.js 同一份逻辑，改动时两边同步） ─────────────

    function isProtected(moduleName, bundle) {
      if (moduleName === SELF || moduleName.startsWith(SELF + '/')) return true;
      if (moduleName.startsWith('cordis:')) return true;
      if (moduleName.startsWith('@deepseek-ai/')) return !isUserBundle(bundle);
      return false;
    }

    function isUserBundle(bundle) {
      return !!bundle && bundle.availability === 'profile' && !bundle.official;
    }

    function packageOf(moduleName) {
      const parts = moduleName.split('/');
      return moduleName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    }

    function localized(text) {
      if (!text) return undefined;
      if (typeof text === 'string') return text;
      return text['zh-CN'] || text.zh || text.en || Object.values(text)[0];
    }

    function brief(text, max) {
      max = max || 42;
      if (!text) return '';
      const s = String(text).replace(/\s+/g, ' ').trim();
      const parts = s.split(/\s+[·|｜]\s+/).map((p) => p.trim()).filter(Boolean);
      let pick = parts.find((p) => /[一-鿿]/.test(p)) || parts[0] || s;
      const firstCjk = pick.search(/[一-鿿]/);
      if (firstCjk > 12) pick = pick.slice(firstCjk);
      pick = pick.split(/(?<=[。！？!?])\s*|(?<=\.)\s+/)[0] || pick;
      return pick.length > max ? pick.slice(0, max - 1) + '…' : pick;
    }

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
    };

    function briefOf(patchId, pkg, full) {
      return (patchId && ZH_BRIEF[patchId]) || ZH_BRIEF[pkg] || brief(full);
    }

    async function readItems(manager, opts) {
      const includeBundles = !opts || opts.showDisabledBundles !== false;
      const [plugins, bundles] = await Promise.all([manager.listPlugins(), manager.listBundles()]);
      const bundleOfEntry = new Map();
      for (const b of bundles) for (const r of (b.rows || [])) if (r.entryId) bundleOfEntry.set(r.entryId, b);
      const items = [];
      for (const row of plugins) {
        if (!row || typeof row.moduleName !== 'string' || row.readOnlyReason) continue;
        const b = bundleOfEntry.get(row.entryId);
        if (isProtected(row.moduleName, b)) continue;
        const full = localized(row.meta && row.meta.description) || localized(b && b.meta && b.meta.description) || (b && b.description) || '';
        const pkg = (b && b.name) || packageOf(row.moduleName);
        items.push({
          kind: 'entry', id: row.entryId, entryId: row.entryId, moduleName: row.moduleName, pkg,
          bundle: isUserBundle(b) ? b.name : undefined,
          title: localized(row.meta && row.meta.title) || row.patchId || row.moduleName,
          patchId: row.patchId, enabled: !!row.enabled, failed: row.fiberPhase === 'failed',
          description: briefOf(row.patchId, pkg, full), fullDescription: full,
        });
      }
      if (includeBundles) {
        for (const b of bundles) {
          if (!b.installed || b.enabled || !isUserBundle(b) || b.readOnlyReason) continue;
          if (isProtected(b.name, b)) continue;
          const full = localized(b.meta && b.meta.description) || b.description || '';
          items.push({
            kind: 'bundle', id: 'bundle:' + b.name, bundle: b.name, moduleName: b.name, pkg: b.name,
            title: localized(b.meta && b.meta.title) || b.name, enabled: false, failed: false,
            description: briefOf(undefined, b.name, full), fullDescription: full,
          });
        }
      }
      items.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.title.localeCompare(b.title));
      return items;
    }

    /** 常用插件排到最前，并标记 pinned（与 index.js 一致）。 */
    function sortPinned(items, pinned) {
      const set = new Set(pinned || []);
      for (const it of items) it.pinned = set.has(it.pkg);
      return items.filter((i) => i.pinned).concat(items.filter((i) => !i.pinned));
    }

    /** 加入/移出常用（按包名）。 */
    function togglePinned(pkg) {
      const pinned = (configCache.pinned || []).slice();
      const next = pinned.includes(pkg) ? pinned.filter((p) => p !== pkg) : pinned.concat(pkg);
      return writeConfig({ pinned: next });
    }

    /** 在当前会话里执行一条 /toggle 命令（批量操作交给 Host，结果会出现在对话里）。 */
    async function runCommand(sessionId, line) {
      const sessions = runtime.sessions;
      const binding = sessionId && sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined;
      const live = binding && binding.session;
      if (!live || typeof live.command !== 'function') throw new Error('当前会话还没准备好，请在对话里输入 ' + line);
      const result = await live.command(line);
      if (result && result.ok === false) throw new Error((result.error && result.error.message) || 'command failed');
    }

    function needsConfirm(item, list) {
      if (item.kind === 'bundle' || !item.enabled) return false;
      return (list || []).some((n) => n === item.pkg || n === item.patchId || n === item.moduleName);
    }

    // ───────────── 可靠执行（与 index.js 同一份逻辑，改动时两边同步） ─────────────

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function entryState(manager, entryId) {
      const rows = await manager.listPlugins();
      return rows.find((r) => r.entryId === entryId);
    }

    async function waitFor(read, check, timeoutMs) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        let value;
        try { value = await read(); } catch (e) { value = undefined; }
        if (check(value)) return value === undefined ? true : value;
        if (Date.now() >= end) return undefined;
        await sleep(300);
      }
    }

    function corePending(warnings) {
      return (warnings || []).filter((w) => /\(@deepseek-ai\/[^)]+\): pending/.test(String(w)));
    }

    async function setEntry(manager, entryId, enabled) {
      let reason = '未知原因';
      let warnings = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const cur = await waitFor(() => entryState(manager, entryId), (row) => !!row || !enabled, attempt === 0 ? 4000 : 2000);
        const row = cur === true ? undefined : cur;
        if (!row) {
          if (!enabled) return { ok: true, warnings };
          reason = '插件条目还没出现（插件包可能还在加载）';
          continue;
        }
        if (row.enabled === enabled) {
          return { ok: true, warnings, startFailed: enabled && row.fiberPhase === 'failed' ? (row.diagnostic || '启动失败') : undefined };
        }
        try {
          const r = await manager.setPluginEnabled(entryId, enabled);
          warnings = (r && r.warnings) || [];
          if (r && r.application === 'overridden') return { ok: false, reason: '被更高优先级的配置覆盖', warnings };
          if (r && r.application === 'restart-required') return { ok: true, restart: true, warnings };
          if (r && r.application === 'failed') reason = (r.error && (r.error.diagnostic || r.error.code)) || '操作失败';
        } catch (e) {
          // 被拒：状态不会变，短暂等待后直接重试
          reason = (e && e.message) || String(e);
          await sleep(300 * (attempt + 1));
          continue;
        }
        const after = await waitFor(() => entryState(manager, entryId),
          (row2) => (row2 ? row2.enabled === enabled : !enabled), 3000);
        if (after) {
          const row2 = after === true ? undefined : after;
          return { ok: true, warnings, startFailed: enabled && row2 && row2.fiberPhase === 'failed' ? (row2.diagnostic || reason) : undefined };
        }
        await sleep(300 * (attempt + 1));
      }
      return { ok: false, reason, warnings };
    }

    async function setBundle(manager, name, enabled) {
      let reason = '未知原因';
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const bundles = await manager.listBundles();
          const b = bundles.find((x) => x.name === name);
          if (!b) return { ok: false, reason: '找不到这个插件包' };
          if (b.enabled === enabled) return { ok: true };
          const r = await manager.setBundleEnabled(name, enabled);
          if (r && r.application === 'restart-required') return { ok: true, restart: true };
          if (r && r.application === 'failed') reason = (r.error && (r.error.diagnostic || r.error.code)) || '操作失败';
        } catch (e) {
          reason = (e && e.message) || String(e);
          await sleep(300 * (attempt + 1));
          continue;
        }
        const done = await waitFor(async () => (await manager.listBundles()).find((x) => x.name === name),
          (b) => !!b && b.enabled === enabled, 3000);
        if (done) return { ok: true };
        await sleep(300 * (attempt + 1));
      }
      return { ok: false, reason };
    }

    async function retireBundleIfEmpty(manager, bundle) {
      if (!bundle) return;
      const items = await readItems(manager);
      const rows = items.filter((i) => i.kind === 'entry' && i.bundle === bundle);
      if (rows.length > 0 && rows.every((i) => !i.enabled)) await setBundle(manager, bundle, false);
    }

    async function disableEntry(manager, item) {
      const r = await setEntry(manager, item.entryId, false);
      if (!r.ok) return r;
      const pending = corePending(r.warnings);
      if (pending.length > 0) {
        const back = await setEntry(manager, item.entryId, true);
        if (corePending(back.warnings).length === 0) {
          const m = /waiting for service: ([^)\s]+)/.exec(pending[0]);
          return { ok: false, coreDependency: (m && m[1]) || pending[0], reason: 'DSH 核心功能依赖它' };
        }
        return await setEntry(manager, item.entryId, false);
      }
      return r;
    }

    /** 切换一项并返回给用户看的结果。 */
    async function toggleItem(manager, item) {
      if (item.kind === 'bundle') {
        const b = await setBundle(manager, item.bundle, true);
        if (!b.ok) return { ok: false, level: 'error', text: `开启「${item.title}」失败：${b.reason}` };
        if (b.restart) return { ok: true, level: 'warn', text: `已开启「${item.title}」，需要重启 DSH 才能生效` };
        const bundles = await manager.listBundles();
        const found = bundles.find((x) => x.name === item.bundle);
        const problems = [];
        for (const row of (found && found.rows) || []) {
          const r = await setEntry(manager, row.entryId || 'include:' + row.rowId, true);
          if (!r.ok) problems.push(`${row.rowId}：${r.reason}`);
          else if (r.startFailed) problems.push(`${row.rowId} 启动失败：${r.startFailed}（重启 DSH 通常可解决）`);
        }
        if (problems.length) return { ok: false, level: 'warn', text: `已开启「${item.title}」，但有问题：${problems.join('；')}` };
        return { ok: true, level: 'ok', text: `已开启「${item.title}」，已即时生效` };
      }
      if (item.enabled) {
        const r = await disableEntry(manager, item);
        if (r.coreDependency) {
          return { ok: false, level: 'warn', text: `「${item.title}」被 DSH 核心功能依赖（${r.coreDependency}），已自动重新打开` };
        }
        if (!r.ok) return { ok: false, level: 'error', text: `关闭「${item.title}」失败：${r.reason}` };
        if (r.restart) return { ok: true, level: 'warn', text: `已关闭「${item.title}」，需要重启 DSH 才能生效` };
        try { await retireBundleIfEmpty(manager, item.bundle); } catch (e) { /* 前端残留可刷新页面 */ }
        return { ok: true, level: 'ok', text: `已关闭「${item.title}」，已即时生效`, turnedOff: true };
      }
      const r = await setEntry(manager, item.entryId, true);
      if (!r.ok) return { ok: false, level: 'error', text: `开启「${item.title}」失败：${r.reason}` };
      if (r.restart) return { ok: true, level: 'warn', text: `已开启「${item.title}」，需要重启 DSH 才能生效` };
      if (r.startFailed) return { ok: false, level: 'warn', text: `已开启「${item.title}」，但启动失败：${r.startFailed}（重启 DSH 通常可解决）` };
      return { ok: true, level: 'ok', text: `已开启「${item.title}」，已即时生效` };
    }

    // ───────────── 样式 ─────────────

    const STYLE = `
.dqt-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;font-size:15px;line-height:1;color:var(--dsw-alias-label-secondary);}
.dqt-btn:hover,.dqt-btn[data-open="1"]{background:var(--dsw-alias-bg-layer-2);}
.dqt-pop{position:fixed;z-index:2147483000;width:380px;max-height:min(62vh,560px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);font-size:13px;overflow:hidden;}
.dqt-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dqt-title{font-weight:600;flex:none;}
.dqt-count{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;}
.dqt-search{flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:12px;outline:none;}
.dqt-search:focus{border-color:var(--dsw-alias-brand-primary);}
.dqt-body{overflow-y:auto;padding:4px 0 6px;}
.dqt-group{padding:8px 12px 2px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dqt-row{display:flex;align-items:center;gap:10px;padding:6px 12px;cursor:pointer;}
.dqt-row:hover{background:var(--dsw-alias-bg-layer-2);}
.dqt-row[data-busy="1"]{opacity:.55;cursor:progress;}
.dqt-name{flex:1;min-width:0;}
.dqt-name-main{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dqt-name-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
.dqt-tag{font-size:10px;margin-left:6px;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}
.dqt-failed{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}
.dqt-lock{font-size:10px;margin-left:4px;}
.dqt-switch{position:relative;flex:none;width:32px;height:18px;border-radius:9px;background:var(--dsw-alias-state-idle-primary,#bbb);transition:background .15s;}
.dqt-switch[data-on="1"]{background:var(--dsw-alias-brand-primary);}
.dqt-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s;}
.dqt-switch[data-on="1"]::after{transform:translateX(14px);}
.dqt-msg{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;}
.dqt-msg[data-level="ok"]{color:var(--dsw-alias-state-success-primary);}
.dqt-msg[data-level="warn"]{color:var(--dsw-alias-state-warn-primary);}
.dqt-msg[data-level="error"]{color:var(--dsw-alias-state-error-primary);}
.dqt-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);}
.dqt-link{flex:none;border:none;background:transparent;padding:2px 4px;border-radius:4px;cursor:pointer;font-size:11px;color:var(--dsw-alias-brand-primary);}
.dqt-link:hover{background:var(--dsw-alias-bg-layer-2);}
.dqt-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dqt-tabs{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:2px;}
.dqt-tab{border:none;background:transparent;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary);}
.dqt-tab[data-on="1"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08);}
.dqt-star{flex:none;border:none;background:transparent;cursor:pointer;font-size:13px;line-height:1;padding:2px;border-radius:4px;color:var(--dsw-alias-label-secondary);opacity:.45;}
.dqt-row:hover .dqt-star,.dqt-star[data-on="1"]{opacity:1;}
.dqt-star[data-on="1"]{color:var(--dsw-alias-state-warn-primary);}
.dqt-star:hover{background:var(--dsw-alias-bg-layer-1);}
.dqt-empty{padding:16px 12px;color:var(--dsw-alias-label-secondary);text-align:center;}
.dqt-cfg{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary);}
.dqt-cfg-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}
.dqt-cfg-text{flex:1;min-width:0;}
.dqt-cfg-hint{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px;}
.dqt-cfg select,.dqt-cfg textarea{font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 6px;}
.dqt-cfg textarea{width:100%;min-height:72px;box-sizing:border-box;resize:vertical;}
.dqt-cfg-err{color:var(--dsw-alias-state-error-primary);font-size:12px;}
`;

    // ───────────── 🔌 按钮的下拉面板 ─────────────

    /** 记住上次选的筛选（只是本机的小偏好，读写失败也无妨）。 */
    function loadFilter() {
      try { return window.localStorage.getItem('dsh-quick-toggle:filter') || 'all'; } catch (e) { return 'all'; }
    }
    function saveFilter(v) {
      try { window.localStorage.setItem('dsh-quick-toggle:filter', v); } catch (e) { /* 忽略 */ }
    }

    function Popover({ anchor, onClose, sessionId }) {
      const cfg = useConfig();
      const [items, setItems] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(null);
      const [msg, setMsg] = useState(null);
      const [query, setQuery] = useState('');
      const [filter, setFilterState] = useState(loadFilter);
      const setFilter = (v) => { setFilterState(v); saveFilter(v); };
      // 等待第二次点击确认的项（不用 window.confirm：部分桌面环境会拦截原生对话框）
      const [armed, setArmedState] = useState(null);
      const armTimer = useRef(null);
      const setArmed = (id) => {
        if (armTimer.current) clearTimeout(armTimer.current);
        setArmedState(id);
        if (id) armTimer.current = setTimeout(() => setArmedState(null), 6000);
      };
      useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
      const popRef = useRef(null);

      const reload = useCallback(() => {
        let manager;
        try { manager = managerFacade(); } catch (e) { setError(e.message); return Promise.resolve(); }
        return readItems(manager).then((r) => { setItems(r); setError(null); }, (e) => setError(e.message || String(e)));
      }, []);

      useEffect(() => { reload(); }, [reload]);

      useEffect(() => {
        const onDown = (ev) => {
          if (popRef.current && popRef.current.contains(ev.target)) return;
          if (anchor && anchor.contains(ev.target)) return;
          onClose();
        };
        const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [anchor, onClose]);

      const toggle = async (item) => {
        if (busy) return;
        if (needsConfirm(item, cfg.confirmBeforeDisable) && armed !== item.id) {
          setArmed(item.id);
          setMsg({ level: 'warn', text: `「${item.title}」在“关闭前需确认”名单里，关掉可能影响对话或界面。再点一次确认关闭。` });
          return;
        }
        setArmed(null);
        setBusy(item.id);
        setMsg(null);
        try {
          setMsg(await toggleItem(managerFacade(), item));
        } catch (e) {
          setMsg({ level: 'error', text: `切换「${item.title}」失败：${e.message || e}` });
        } finally {
          await reload();
          setBusy(null);
        }
      };

      const rect = anchor ? anchor.getBoundingClientRect() : { left: 16, right: 16, top: window.innerHeight - 60 };
      const width = 380;
      // 按钮在右侧时面板右对齐，在左侧时左对齐
      const preferLeft = cfg.buttonPosition === 'right' ? rect.right - width : rect.left;
      const left = Math.max(8, Math.min(preferLeft, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - rect.top + 8);

      /** 批量操作：交给 Host 执行，结果会出现在对话里。 */
      const batch = async (line, confirmText) => {
        if (busy) return;
        if (confirmText && armed !== '__batch') {
          setArmed('__batch');
          setMsg({ level: 'warn', text: confirmText });
          return;
        }
        setArmed(null);
        setBusy('__batch');
        setMsg({ level: 'warn', text: '执行中…' });
        try {
          await runCommand(sessionId, line);
          await refreshConfig();
          setMsg({ level: 'ok', text: '已执行，详细结果见对话。界面有残留时点「刷新页面」。', turnedOff: true });
        } catch (e) {
          setMsg({ level: 'error', text: e.message || String(e) });
        } finally {
          await reload();
          setBusy(null);
        }
      };

      const q = query.trim().toLowerCase();
      const shown = sortPinned((items || []).filter((it) => cfg.showDisabledBundles || it.kind !== 'bundle'), cfg.pinned);
      const visible = shown.filter((it) => (filter === 'all' || (filter === 'on' ? it.enabled : !it.enabled))
        && (!q || [it.moduleName, it.patchId, it.title, it.fullDescription].filter(Boolean).some((s) => String(s).toLowerCase().includes(q))));
      // 常用的放进同一组“⭐ 常用”，其余按包分组
      const groups = new Map();
      for (const it of visible) {
        const key = it.pinned ? '⭐ 常用' : it.pkg;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      const onCount = shown.filter((i) => i.enabled).length;
      const keep = cfg.confirmBeforeDisable || [];
      const batchCount = shown.filter((i) => i.kind === 'entry' && i.enabled && !needsConfirm(i, keep)).length;
      const snapshotCount = (cfg.batchSnapshot || []).length;

      let body;
      if (error) body = h('div', { className: 'dqt-empty' }, '读取插件列表失败：' + error);
      else if (!items) body = h('div', { className: 'dqt-empty' }, '加载中…');
      else if (visible.length === 0) body = h('div', { className: 'dqt-empty' }, shown.length === 0 ? '没有可开关的第三方插件' : '没有匹配的插件');
      else {
        body = [];
        for (const [pkg, list] of groups) {
          if (list.length > 1 || pkg === '⭐ 常用') body.push(h('div', { key: 'g:' + pkg, className: 'dqt-group', title: pkg }, pkg));
          for (const it of list) {
            const locked = needsConfirm(it, cfg.confirmBeforeDisable);
            body.push(h('div', {
              key: it.id, className: 'dqt-row', 'data-busy': busy === it.id ? '1' : '0',
              title: `${it.moduleName}\n${it.fullDescription || ''}\n点击${it.enabled ? '关闭' : '开启'}${locked ? '（需确认）' : ''}`.trim(),
              onClick: () => toggle(it),
            },
              h('div', { className: 'dqt-name' },
                h('div', { className: 'dqt-name-main' }, it.title,
                  locked ? h('span', { className: 'dqt-lock', title: '关闭前需确认' }, '🔒') : null,
                  armed === it.id ? h('span', { className: 'dqt-tag dqt-failed' }, '再点一次确认关闭') : null,
                  it.kind === 'bundle' ? h('span', { className: 'dqt-tag' }, '整包未启用') : null,
                  it.failed ? h('span', { className: 'dqt-tag dqt-failed' }, '加载失败') : null),
                cfg.showDescription ? h('div', { className: 'dqt-name-sub' }, it.description || it.moduleName) : null),
              h('button', {
                type: 'button', className: 'dqt-star', 'data-on': it.pinned ? '1' : '0',
                title: it.pinned ? '移出常用' : '加入常用（排到最前面）',
                onClick: (ev) => {
                  ev.stopPropagation();
                  togglePinned(it.pkg).catch((e) => setMsg({ level: 'error', text: '设置常用失败：' + (e.message || e) }));
                },
              }, it.pinned ? '★' : '☆'),
              h('span', { className: 'dqt-switch', 'data-on': it.enabled ? '1' : '0', role: 'switch', 'aria-checked': !!it.enabled })));
          }
        }
      }

      const pop = h('div', { ref: popRef, className: 'dqt-pop', style: { left, bottom } },
        h('div', { className: 'dqt-head' },
          h('span', { className: 'dqt-title' }, '插件开关'),
          items ? h('span', { className: 'dqt-count' }, `开 ${onCount}/${shown.length}`) : null,
          h('input', {
            className: 'dqt-search', placeholder: '搜索插件…', value: query, autoFocus: true,
            onChange: (ev) => setQuery(ev.target.value),
          })),
        h('div', { className: 'dqt-bar' },
          h('div', { className: 'dqt-tabs' },
            [['all', '全部'], ['on', '已开启'], ['off', '已关闭']].map(([k, label]) =>
              h('button', { key: k, type: 'button', className: 'dqt-tab', 'data-on': filter === k ? '1' : '0', onClick: () => setFilter(k) }, label))),
          h('span', null,
            snapshotCount > 0 ? h('button', {
              type: 'button', className: 'dqt-link', title: '恢复到批量关闭之前的状态',
              onClick: () => batch('/toggle 恢复'),
            }, `↩ 恢复(${snapshotCount})`) : null,
            h('button', {
              type: 'button', className: 'dqt-link', disabled: batchCount === 0,
              title: '关闭所有第三方插件（“关闭前需确认”名单除外），排查问题用，之后可一键恢复',
              onClick: () => batch('/toggle 全部关闭 确认',
                `将关闭 ${batchCount} 个插件（保留：${keep.join('、') || '无'}），之后可点「恢复」一键还原。再点一次「确认全部关闭」执行。`),
            }, armed === '__batch' ? `确认全部关闭(${batchCount})` : '全部关闭'))),
        h('div', { className: 'dqt-body' }, body),
        msg ? h('div', { className: 'dqt-msg', 'data-level': msg.level },
          h('span', null, msg.text),
          msg.turnedOff ? h('button', { type: 'button', className: 'dqt-link', title: '插件的按钮/图标没消失时刷新一下', onClick: reloadPage }, '刷新页面') : null) : null,
        h('div', { className: 'dqt-foot' },
          h('span', null, '也可以输入 /toggle 回车使用'),
          h('span', null,
            h('button', { type: 'button', className: 'dqt-link', onClick: reloadPage }, '刷新页面'),
            h('button', {
              type: 'button', className: 'dqt-link', title: '隐藏后可在 /toggle 列表底部的「设置」里重新显示',
              onClick: () => writeConfig({ showButton: false }).catch((e) => setMsg({ level: 'error', text: '隐藏按钮失败：' + (e.message || e) })),
            }, '隐藏此按钮'))));

      return ReactDOM && ReactDOM.createPortal ? ReactDOM.createPortal(pop, document.body) : pop;
    }

    /** 工具栏按钮：左右两个插槽各注册一份，只在配置的位置显示。 */
    function makeToggleButton(position) {
      return function ToggleButton(props) {
        const sessionId = props && props.sessionId;
        const cfg = useConfig();
        const [open, setOpen] = useState(false);
        const btnRef = useRef(null);
        const close = useCallback(() => setOpen(false), []);
        if (cfg.showButton === false || (cfg.buttonPosition || 'left') !== position) return null;
        return h(React.Fragment, null,
          h('button', {
            ref: btnRef, type: 'button', className: 'dqt-btn', 'data-open': open ? '1' : '0',
            title: '插件开关', 'aria-label': '插件开关',
            onClick: () => setOpen((v) => !v),
          }, '🔌'),
          open ? h(Popover, { anchor: btnRef.current, onClose: close, sessionId }) : null);
      };
    }

    // ───────────── 插件页里的配置面板（slot plugins.bundle.config） ─────────────

    function ConfigPanel({ view }) {
      const cfg = useConfig();
      const [err, setErr] = useState(null);
      const [confirmText, setConfirmText] = useState(null);
      const [pinnedText, setPinnedText] = useState(null);
      const save = (patch) => { setErr(null); writeConfig(patch).catch((e) => setErr('保存失败：' + (e.message || e))); };

      if (view === 'summary') {
        return `🔌 按钮：${cfg.showButton ? (cfg.buttonPosition === 'right' ? '右侧' : '左侧') : '已隐藏'}`;
      }
      const check = (key, label, hint) => h('label', { className: 'dqt-cfg-row' },
        h('div', { className: 'dqt-cfg-text' }, h('div', null, label), hint ? h('div', { className: 'dqt-cfg-hint' }, hint) : null),
        h('input', { type: 'checkbox', checked: cfg[key] !== false, onChange: (ev) => save({ [key]: ev.target.checked }) }));
      const listText = confirmText !== null ? confirmText : (cfg.confirmBeforeDisable || []).join('\n');
      return h('div', { className: 'dqt-cfg' },
        check('showButton', '在输入框显示 🔌 按钮', '关掉后只用 /toggle 也完全够用'),
        h('div', { className: 'dqt-cfg-row' },
          h('div', { className: 'dqt-cfg-text' }, h('div', null, '按钮位置'), h('div', { className: 'dqt-cfg-hint' }, '输入框工具栏的左侧或右侧')),
          h('select', { value: cfg.buttonPosition || 'left', onChange: (ev) => save({ buttonPosition: ev.target.value }) },
            h('option', { value: 'left' }, '左侧'),
            h('option', { value: 'right' }, '右侧'))),
        check('showDisabledBundles', '列表里显示“整包未启用”的插件', '关掉后列表只显示已启用插件包里的条目'),
        check('showDescription', '列表里显示中文简介', null),
        h('div', null,
          h('div', null, '关闭前需要确认的插件'),
          h('div', { className: 'dqt-cfg-hint' }, '每行一个包名；关掉这些插件可能让对话或界面不可用，关闭时会先弹确认'),
          h('textarea', {
            value: listText,
            onChange: (ev) => setConfirmText(ev.target.value),
            onBlur: () => {
              if (confirmText === null) return;
              const list = confirmText.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
              setConfirmText(null);
              save({ confirmBeforeDisable: list });
            },
          })),
        h('div', null,
          h('div', null, '常用插件'),
          h('div', { className: 'dqt-cfg-hint' }, '每行一个包名，排在列表最前面；也可以在 🔌 面板里点 ☆ 或用 /toggle 常用 <名称>'),
          h('textarea', {
            value: pinnedText !== null ? pinnedText : (cfg.pinned || []).join('\n'),
            onChange: (ev) => setPinnedText(ev.target.value),
            onBlur: () => {
              if (pinnedText === null) return;
              const list = pinnedText.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
              setPinnedText(null);
              save({ pinned: list });
            },
          })),
        h('div', { className: 'dqt-cfg-row' },
          h('div', { className: 'dqt-cfg-text' },
            h('div', null, '批量关闭记录'),
            h('div', { className: 'dqt-cfg-hint' }, (cfg.batchSnapshot || []).length
              ? `有 ${(cfg.batchSnapshot || []).length} 个插件等待恢复：在对话里输入 /toggle 恢复，或在 🔌 面板点「恢复」`
              : '没有待恢复的记录。在对话里输入 /toggle 全部关闭 可批量关闭（排查问题用）'))),
        err ? h('div', { className: 'dqt-cfg-err' }, err) : null);
    }

    // ───────────── /toggle 弹出列表（commandUi popupSelect） ─────────────

    async function popupOptions() {
      const cfg = await refreshConfig();
      const items = sortPinned(await readItems(managerFacade(), { showDisabledBundles: cfg.showDisabledBundles }), cfg.pinned);
      const pinnedGroup = { name: '__pinned', label: '⭐ 常用' };
      const options = items.map((it) => {
        const locked = needsConfirm(it, cfg.confirmBeforeDisable);
        const option = {
          id: it.id,
          label: `${it.enabled ? '🟢' : '⚪'} ${it.title}${locked ? ' 🔒' : ''}`,
          badge: it.kind === 'bundle' ? '整包未启用' : (it.failed ? '加载失败' : undefined),
          detail: `${it.enabled ? '已开启，点击关闭' : '已关闭，点击开启'}${cfg.showDescription && it.description ? ' · ' + it.description : ''}`,
          group: it.pinned ? pinnedGroup : { name: it.pkg, label: it.pkg },
        };
        if (locked) {
          option.confirmation = {
            title: `确定关闭「${it.title}」吗？`,
            description: '它在“关闭前需确认”名单里，关掉可能让对话或界面不可用。之后可以在 /toggle 列表里重新打开。',
            acknowledgeLabel: '我知道关掉的影响',
            cancelLabel: '取消',
            confirmLabel: '关闭',
          };
        }
        return option;
      });
      // 批量操作组
      const batchGroup = { name: '__batch', label: '批量操作（排查问题用）' };
      const keep = cfg.confirmBeforeDisable || [];
      const batchCount = items.filter((i) => i.kind === 'entry' && i.enabled && !needsConfirm(i, keep)).length;
      const snapshotCount = (cfg.batchSnapshot || []).length;
      if (snapshotCount > 0) {
        options.push({
          id: 'batch:restore',
          label: `↩️ 恢复批量关闭前的状态（${snapshotCount} 个）`,
          detail: '把上次“全部关闭”关掉的插件全部打开',
          group: batchGroup,
        });
      }
      if (batchCount > 0) {
        options.push({
          id: 'batch:disable',
          label: `🧹 全部关闭（${batchCount} 个）`,
          detail: `关闭所有第三方插件，保留：${keep.join('、') || '无'}；之后可一键恢复`,
          group: batchGroup,
          confirmation: {
            title: `确定关闭 ${batchCount} 个插件吗？`,
            description: `会保留“关闭前需确认”名单（${keep.join('、') || '无'}）。之后在本列表点「恢复批量关闭前的状态」即可一键还原。`,
            acknowledgeLabel: '我知道会关掉很多插件',
            cancelLabel: '取消',
            confirmLabel: '全部关闭',
          },
        });
      }

      const settingsGroup = { name: '__settings', label: '设置（本插件）' };
      options.push({
        id: 'setting:button',
        label: cfg.showButton ? '⚙️ 隐藏输入框里的 🔌 按钮' : '⚙️ 显示输入框里的 🔌 按钮',
        detail: cfg.showButton ? '只用 /toggle 的话可以把按钮藏起来' : '按钮目前是隐藏的，点这里恢复',
        group: settingsGroup,
      });
      if (cfg.showButton) {
        options.push({
          id: 'setting:position',
          label: cfg.buttonPosition === 'right' ? '⚙️ 把 🔌 按钮移到左侧' : '⚙️ 把 🔌 按钮移到右侧',
          detail: `当前在${cfg.buttonPosition === 'right' ? '右侧' : '左侧'}`,
          group: settingsGroup,
        });
      }
      options.push({
        id: 'setting:reload',
        label: '🔄 刷新页面',
        detail: '关掉的插件按钮/图标还残留时用',
        group: settingsGroup,
      });
      return options;
    }

    async function submitToggle(sessionId, id) {
      const sessions = runtime.sessions;
      const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined;
      const live = binding && binding.session;
      if (live && typeof live.command === 'function') {
        // 弹出列表里的确认已经做过，带上“确认”跳过 Host 端的二次确认
        const result = await live.command('/toggle ' + id + ' 确认');
        if (result && result.ok === false) throw new Error((result.error && result.error.message) || 'toggle failed');
        return;
      }
      const items = await readItems(managerFacade());
      const item = items.find((i) => i.id === id);
      if (item) await toggleItem(managerFacade(), item);
    }

    async function onPopupSelect(option, session) {
      if (option.id === 'setting:button') { await writeConfig({ showButton: !configCache.showButton }); return; }
      if (option.id === 'setting:position') {
        await writeConfig({ buttonPosition: configCache.buttonPosition === 'right' ? 'left' : 'right' });
        return;
      }
      if (option.id === 'setting:reload') { reloadPage(); return; }
      if (option.id === 'batch:disable') { await runCommand(session.sessionId, '/toggle 全部关闭 确认'); await refreshConfig(); return; }
      if (option.id === 'batch:restore') { await runCommand(session.sessionId, '/toggle 恢复'); await refreshConfig(); return; }
      await submitToggle(session.sessionId, option.id);
    }

    // ───────────── 插件入口 ─────────────

    function apply(ctx) {
      runtime.ctx = ctx;
      ctx.effect(() => () => { runtime.ctx = null; runtime.manager = null; runtime.settings = null; runtime.sessions = null; }, 'quick-toggle: runtime');

      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['remote.pluginManager'], (scope) => {
            runtime.manager = scope.remote && scope.remote.pluginManager;
            scope.effect(() => () => { runtime.manager = null; }, 'quick-toggle: plugin manager');
          });
        } catch (e) { console.error('[quick-toggle] inject remote.pluginManager failed', e); }
        try {
          ctx.inject(['remote.settings'], (scope) => {
            runtime.settings = scope.remote && scope.remote.settings;
            scope.effect(() => () => { runtime.settings = null; }, 'quick-toggle: settings');
            refreshConfig();
          });
        } catch (e) { console.error('[quick-toggle] inject remote.settings failed', e); }
        try {
          ctx.inject(['commandUi', 'sessions'], (scope) => {
            runtime.sessions = scope.get('sessions');
            scope.effect(() => () => { runtime.sessions = null; }, 'quick-toggle: sessions');
            const commandUi = scope.get('commandUi');
            scope.effect(() => commandUi.decorate({
              name: 'toggle',
              available: () => true,
              ui: {
                kind: 'popupSelect',
                searchMode: 'substring',
                searchLabels: () => ({ placeholder: '搜索插件…', empty: '没有可开关的第三方插件', noResults: '没有匹配的插件' }),
                options: () => popupOptions(),
                onSelect: (option, session) => onPopupSelect(option, session),
              },
            }), 'quick-toggle: /toggle popup');
          });
        } catch (e) { console.error('[quick-toggle] /toggle popup registration failed', e); }
      }

      ctx.effect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-dsh-quick-toggle', '1');
        el.textContent = STYLE;
        document.head.appendChild(el);
        return () => { try { el.remove(); } catch (e) { /* 忽略 */ } };
      }, 'quick-toggle: styles');

      // 左右两个位置都注册，按钮组件按配置决定在哪一侧显示
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: 'quick-toggle', order: 90, label: '插件开关' },
        makeToggleButton('left'),
      ));
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
        { name: 'conversation.input.right', id: 'quick-toggle', order: 10, label: '插件开关' },
        makeToggleButton('right'),
      ));

      // 插件页 → 已安装 → 本插件详情页里的配置面板
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
        { name: 'plugins.bundle.config', key: SELF },
        ConfigPanel,
      ));
    }

    module.exports = { apply, inject: ['slots'] };
    return module.exports;
  },
});
