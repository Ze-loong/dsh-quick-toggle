# dsh-quick-toggle

在 DeepSeek Harness 的输入框里快捷开关第三方插件——不用进插件页、不用开插件市场。

[English](#english)

## 功能

- **`/toggle` 弹出列表**：输入 `/toggle` 回车，输入框上方弹出可搜索的插件列表（开/关状态 + 简介），点一项即切换。
- **🔌 按钮**：输入框工具栏的下拉开关面板，支持搜索、「全部 / 已开启 / 已关闭」筛选，结果就地显示。按钮可隐藏、可放左侧或右侧。
- **常用置顶**：点 ☆ 把常用插件排到最前。
- **批量关闭 + 一键恢复**：排查“哪个插件把界面弄坏了”时，一键关闭所有第三方插件（保护名单除外），排查完一键还原。关闭前的状态存在配置里，重启后也能恢复。
- **安全保护**
  - “关闭前需确认”名单：模型提供方、主题等关掉会让界面不可用的插件，关闭前先确认（列表里带 🔒）。
  - 核心依赖保护：关掉某插件后如果 DSH 报告官方核心插件在等待它的服务，会立即重新打开它并说明原因。
  - 不列出本插件自己、`cordis:*` 系统插件和 DSH 自带的 `@deepseek-ai/*` 核心包（用户自己安装的 `@deepseek-ai/*` 包会列出）。
- **未启用的插件也能开**：已安装但整包未启用的插件同样出现在列表里，点一下整包开启。

## 安装

在插件页「添加插件」里输入 `dsh-quick-toggle`，或在 dsh-market 插件市场里搜索安装。
需要 DeepSeek Harness 0.2.2 及以上（0.2.x）。

## 用法

| 操作 | 效果 |
|---|---|
| `/toggle` 回车 | 弹出插件列表，点一项切换；底部有批量操作和本插件设置 |
| 🔌 按钮 | 下拉开关面板 |
| `/toggle list` | 文字版清单 |
| `/toggle <名称>` | 按名称模糊匹配并切换；匹配到多个时列出编号，再 `/toggle <编号>` |
| `/toggle <名称> 确认` | 关闭“关闭前需确认”名单里的插件 |
| `/toggle 常用 <名称>` | 加入/移出常用 |
| `/toggle 全部关闭` | 预览将关闭哪些；`/toggle 全部关闭 确认` 执行 |
| `/toggle 恢复` | 恢复到批量关闭之前的状态 |
| `/toggle 按钮 显示` / `隐藏` | 控制 🔌 按钮 |

关掉某个插件后，如果界面上还残留它的按钮或图标，在 `/toggle` 列表底部或 🔌 面板里点「🔄 刷新页面」即可（部分插件的前端不能热卸载）。

## 设置

插件页 → 已安装 → `dsh-quick-toggle` 详情页里有配置面板；`/toggle` 列表底部「设置（本插件）」也能改常用项。改动即时生效，写入 profile 的 `cordis.patch.yml`。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `showButton` | `true` | 显示 🔌 按钮 |
| `buttonPosition` | `left` | 按钮在工具栏左侧或右侧 |
| `showDisabledBundles` | `true` | 列表里显示“整包未启用”的插件 |
| `showDescription` | `true` | 显示简介 |
| `confirmBeforeDisable` | `dsh-oh-my-claude`、`dsh-codex-subscription`、`dsh-claude-style`、`dshmarket`、`billion-context` | 关闭前需确认的包名；批量关闭时保留 |
| `pinned` | 空 | 常用插件包名 |
| `batchSnapshot` | 空 | 批量关闭前的状态（自动维护） |

## 工作原理

- 开关调用 DSH 自带的 `pluginManager.setPluginEnabled` / `setBundleEnabled`：写入 profile 的用户补丁层（`cordis.patch.yml`），热生效，不修改任何插件本身的文件。
- 插件的浏览器端按“插件包”加载，所以关掉一个包里最后一个开着的条目时，会连包一起停用，前端按钮/图标才会卸载。
- 每次开关都是“发出 → 等运行时真实状态 → 没生效就重试”：连续改动时 DSH 可能暂时拒绝请求，整包刚启用时条目也会晚一点出现。
- `/toggle` 弹出列表使用官方 `commandUi.decorate` + `popupSelect`（与内置 `/permission` 同一机制）；配置面板挂在插件页的 `plugins.bundle.config` 插槽。

## 开发

```bash
npm test      # 用模拟的插件管理服务跑 Host 端命令和浏览器端冒烟测试
npm run check # 语法检查
```

## English

**dsh-quick-toggle** lets you switch third-party DeepSeek Harness plugins on and off from the composer.

- Type `/toggle` and press Enter for a searchable picker; click an entry to toggle it.
- A 🔌 composer button opens the same list with search, on/off filters and pins.
- **Disable all + restore**: turn every third-party plugin off (except a protected list) to find the one breaking your UI, then restore the previous state in one click — the snapshot survives restarts.
- Safety: a confirm-before-disable list (model providers, theme, …), automatic re-enable when DSH reports that a core plugin is waiting on the one you turned off, and DSH's own `@deepseek-ai/*` core packages are never listed.
- Changes go through DSH's `pluginManager` into the profile's user patch layer and apply live; plugin files are never modified.

The UI is in Chinese. Requires DeepSeek Harness 0.2.2+ (0.2.x).

## License

MIT
