# CLAUDE.md — 剪切板管理器（clipboard-manager）

> 这是一个跨平台剪切板管理器（对标 macOS 的 Maccy），目前 **macOS 优先**。
> 本文件是项目的「单一事实来源」：未来任何一次开发都**先读本文件**，并按下面《工作约定》维护它。

---

## 0. 工作约定（给未来的 Claude / 开发者 —— 必须遵守）

1. **问题记录**：开发中遇到的**任何**问题（编译错误、运行崩溃、平台坑、踩过的雷），无论是否已解决，都要追加到下面 **《6. 问题记录》**，格式：`日期 | 现象 | 根因 | 解决方案`。已解决标 ✅，未解决标 ⏳。
2. **需求清单流转**：
   - 用户会把想做的功能写到 **《5. 未完成需求清单》**。
   - 完成某项后，把它**从未完成清单移动到 《4. 已实现需求清单》**，并标上完成日期。
   - 不要在已实现清单里凭空加东西；它只反映真实跑通的功能。
3. **开发进度**：每次开发**结束时**更新 **《7. 开发进度》**：当前停在哪、下一步做什么、有没有半成品，方便下次无缝接续。
4. 改动遵循既有架构与契约（见《2》《3》），不破坏已实现功能；改完确保 `npm run build` 与 `cargo check` 全绿。

---

## 1. 项目概述与开发环境

- **技术栈**：Tauri v2（Rust 后端）+ 原生 TypeScript + Vite（**多页面**：`index.html` 主窗口、`settings.html` 设置窗口），无前端框架。
- **平台**：macOS 优先（Apple Silicon / aarch64）。窗口为**无边框 + 透明 + 毛玻璃（vibrancy）+ 无 Dock 图标（Accessory，仅菜单栏托盘）**。
- **关键第三方**：
  - 剪贴板读写：`clipboard-rs`（文本/图片/文件）
  - 自动粘贴：`enigo`（模拟 ⌘V）—— **必须在主线程执行**，见问题记录
  - 毛玻璃：`window-vibrancy`
  - 来源 App 名称/图标：`objc2` / `objc2-app-kit`（NSWorkspace / NSRunningApplication / NSImage）
  - 开机自启：`tauri-plugin-autostart`
  - 全局快捷键：`tauri-plugin-global-shortcut`

### 常用命令
> 每个新终端先 `source "$HOME/.cargo/env"`（cargo 不在默认 PATH）。

```bash
source "$HOME/.cargo/env"
npm run tauri dev          # 开发模式（热重载；改 Rust 会自动重编）
npm run build              # 仅前端类型检查 + 构建（tsc && vite build）
(cd src-tauri && cargo check)   # 仅后端编译检查
npm run tauri build        # 打正式包（签名后的 .app + .dmg）
```

- dmg 产物：`src-tauri/target/release/bundle/dmg/clipboard-manager_0.1.0_aarch64.dmg`
- **打 dmg 前**：若之前的 dmg 还挂载着会导致 `bundle_dmg.sh` 失败，先卸载：
  `for v in /Volumes/clipboard*; do hdiutil detach "$v" -force; done`

### 代码签名（重要，关系到「自动粘贴」能否生效）
- macOS 把「辅助功能」授权绑定在**代码签名**上。Tauri 默认是 adhoc 签名，**授权绑不住**（看着授权了系统不认）。
- 解决：用**自签名证书** `Clipboard Manager Dev`（已在 login 钥匙串里），`tauri.conf.json → bundle.macOS.signingIdentity` 指向它。授权一次即长期有效，重新打包也认（同一证书）。
- 证书若丢失需重建（OpenSSL 3.x 导 p12 要加 `-legacy -macalg sha1`，否则 macOS `security` 不认）：
  ```bash
  # cert.cnf: [req] x509_extensions=v3; [v3] extendedKeyUsage=critical,codeSigning; keyUsage=critical,digitalSignature; basicConstraints=critical,CA:false
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -config cert.cnf -extensions v3
  openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -out cm.p12 -passout pass:cmcm -name "Clipboard Manager Dev" -macalg sha1
  security import cm.p12 -k ~/Library/Keychains/login.keychain-db -P cmcm -A
  ```
- 用户安装后仍需在 **系统设置 → 隐私与安全性 → 辅助功能** 勾选本 App（自动粘贴 + 全局快捷键需要）。

---

## 2. 架构与关键文件

### 后端 `src-tauri/src/`
- `lib.rs`：入口、状态（`AppState(Mutex<Inner>, IconCache)`）、全部命令、剪贴板轮询线程、托盘、窗口事件、全局快捷键、自动粘贴、弹窗定位。
- `models.rs`：`ClipItem` / `FavGroup` / `Settings` 数据模型（serde `rename_all="camelCase"`）。
- `settings.rs`：设置 `settings.json` 读写（含 `CmdOrCtrl→Cmd` 迁移）。
- `clipboard.rs`：基于 clipboard-rs 的读写、图片缩略图/PNG、concealed（密码）检测。
- `source_app.rs`：来源 App 名称/图标（NSWorkspace），以及 `frontmost_pid()` / `activate_pid()`（粘贴前还原焦点）。

### 前端
- `index.html` + `src/main.ts`：主窗口（双列：左历史 `#list`、右常用 `#favorites`）。
- `settings.html` + `src/settings.ts`：独立设置窗口（顶部 Tab 分页）。
- `src/styles.css`：两窗口共用样式。

### 数据持久化（`app_data_dir`，设置在 `app_config_dir`）
`history.json`、`favorites.json`（分组结构）、`icons.json`（来源图标映射）、`images/<id>.png`（图片项原图）、`settings.json`。

---

## 3. 前后端契约（命令 / 事件 / 模型）

### Tauri 命令（前端 `invoke`，参数 camelCase）
`get_history` · `paste_item(id)` · `copy_item(id)` · `toggle_pin(id)` · `delete_item(id)` · `clear_history(clearPinned)` · `hide_window` · `get_settings` · `set_settings(settings)` · `get_favorites` · `add_favorite(id, groupId)` · `remove_favorite(id)` · `paste_favorite(id)` · `add_group(name)` · `rename_group(groupId, name)` · `delete_group(groupId)` · `get_icons` · `open_settings`

### 事件（Rust → 前端）
`history-updated`（ClipItem[]）· `favorites-updated`（FavGroup[]）· `settings-updated`（Settings）· `icons-updated`（图标映射）· `window-shown` · `need-accessibility`

### 模型
- `ClipItem { id, kind:"text"|"image"|"files", text?, files?, thumbnail?, imagePath?, timestamp, pinned, sourceApp?, sourceIcon? }`
- `FavGroup { id, name, items: ClipItem[] }`
- `Settings { shortcut, shortcut2, autoHideOnBlur, autostart, theme, accent, historySize, pasteOnSelect, ignoreConcealed, windowHeight, popupPosition("cursor"|"center"), pinnedPosition("top"|"bottom"), showAppName, showSourceIcon, showNumbers, highlightMatch("bold"|"underline"|"none"), imageThumbHeight }`

---

## 4. 已实现需求清单

> 完成日期统一记 2026-06。

- [x] 基础：后台监听剪贴板、历史列表、搜索、点击回填、托盘、全局快捷键、本地持久化
- [x] 多类型：支持 **文本 / 图片 / 文件**（clipboard-rs）；图片落盘 + 缩略图
- [x] 失焦自动隐藏（可设置开关）
- [x] 开机自启（可设置开关）
- [x] 去掉 Dock 图标，仅菜单栏托盘（Accessory）
- [x] 主题（系统/浅色/深色）+ 强调色 + 窗口高度可调
- [x] **Maccy 风格**：键盘全操作（↑↓/Enter/⌘1-9/⌘⌫/⌘P/Esc）、自动粘贴（选中即粘到前台 App）、置顶收藏、忽略密码（concealed）、历史条数可配、选中即粘贴
- [x] 毛玻璃无边框窗口 + 圆角 + 顶栏可拖动
- [x] 每行左侧显示**来源 App 图标**（按 bundleId 缓存，独立 icons.json）
- [x] 单列紧凑布局（图标 + 单行文本省略 + 右侧 ⌘N 序号），行高紧凑
- [x] 设置改为**独立窗口**（非抽屉）+ **Tab 分页**（通用/外观/存储/固定/忽略/高级）
- [x] **双列**：左历史 + 右「常用」收藏，历史项右键「加入常用」（选分组）
- [x] 常用**分组**：切换 / 新建 / 双击重命名 / 右键删除；分组持久化
- [x] 弹窗位置可选（光标处 / 屏幕中心）；弹窗跟随光标
- [x] 固定项位置（顶部/底部）、图片高度、高亮匹配（粗体/下划线/无，XSS 安全）、显示应用名/应用图标/序号 等开关
- [x] 图片项**双行大缩略图**展示
- [x] 滚动时高亮**即时跟随光标**（绕过 WKWebView 滚动期间不更新 hover），历史/常用一致，无残留
- [x] 自动粘贴崩溃修复（主线程模拟 ⌘V）+ 焦点还原（粘贴前激活来源 App）
- [x] 自签名证书签名，辅助功能授权可长期生效；未授权时引导打开设置页
- [x] 快捷键用具体修饰键（`Cmd`/`Ctrl`，不再 `CmdOrCtrl`）+ 老值自动迁移
- [x] **备用快捷键**（第二个全局键，同样呼出/隐藏，可清除）
- [x] 弹窗底部预留 Dock/菜单栏边距，不被遮挡
- [x] App 名（productName）改为 `shijinze-copy`（进程名/活动监视器同步；identifier 不变）
- [x] 打包签名 dmg（aarch64）
- [x] **Windows 跨平台支持**：粘贴 Ctrl+V、默认快捷键 Ctrl+Shift+V、亚克力磨砂背景、skipTaskbar；macOS 专属代码已 cfg 隔离
- [x] **GitHub Actions CI**：`.github/workflows/build-windows.yml`，云端 Windows runner 出 `.msi`/`.exe`

---

## 5. 未完成需求清单

> 用户在此追加想做的功能；Claude 完成后移动到《4》并标日期。

- [ ] （示例格式）功能描述 —— 备注 / 验收标准
- [ ] 把 productName 从 `clipboard-manager` 改成中文名（如「剪切板」），dmg/菜单栏/活动监视器显示名同步
- [ ] 出 Intel(x86_64) 或 universal 包（现仅 Apple Silicon）
- [ ] 图标负缓存（来源 App 图标取不到时避免每次重试转换）
- [ ] vibrancy 失败兜底（旧系统/私有 API 变动时给不透明背景，避免透明穿透）

---

## 6. 问题记录

> 格式：`日期 | 现象 | 根因 | 解决`。✅ 已解决 / ⏳ 待解决。

- ✅ 2026-06 | 安装后双击粘贴**立即闪退**（SIGTRAP） | enigo 在**后台线程**解析键码调用了 macOS HIToolbox/TSM，这些 API 必须在主线程 → `dispatch_assert_queue` 断言崩溃 | 把模拟 ⌘V 放到主线程：后台线程只 sleep，再 `app.run_on_main_thread(simulate_cmd_v)`
- ✅ 2026-06 | 修了闪退后**只复制、不自动粘贴** | adhoc 签名无稳定「指定要求」，TCC 辅助功能授权绑不住（看着授权也不生效） | 用自签名证书 `Clipboard Manager Dev` 签名（`signingIdentity`）；授权一次长期有效
- ✅ 2026-06 | 授权生效后仍粘不进目标 App | Accessory 应用显示窗口后抢了焦点，隐藏后焦点没还回去，⌘V 落空 | 显示窗口前记录前台 App 的 pid（`frontmost_pid`），粘贴时先 `activate_pid` 还原焦点再发 ⌘V
- ✅ 2026-06 | 滚动时高亮跟随有 ~1s 延迟、且旧高亮不消失 | WKWebView **滚动期间不更新 `:hover`/不派发鼠标事件**；且残留来自 CSS `:hover`/`.fav-item:hover` 背景 | 高亮全部改 JS 驱动 `.selected`（mousemove + scroll 时用 `elementFromPoint` 主动算光标下的行），删掉所有 `:hover` 背景，去掉 `.item` 背景过渡
- ✅ 2026-06 | 列表项只显示 ⌘ 序号、文本不渲染 | 行容器类名 `item-${kind}`（如 `item-text`）与内部 `.item-text` 撞名，后者 `-webkit-box/line-clamp` 污染整行 | 行的类型修饰类名改用 `kind-${kind}` 前缀
- ✅ 2026-06 | 窗口内**所有滚动都失效** | ① flex 滚动容器缺 `min-height:0`；② 设置抽屉遮罩 `display:flex` 覆盖了 `hidden` 属性，透明遮罩吞掉了所有滚轮/点击 | 给 `.list/.preview/.settings-body` 加 `min-height:0`；遮罩加 `pointer-events:none`（仅 `.open` 时 auto）+ `[hidden]{display:none}`（后改独立窗口后已不用抽屉）
- ✅ 2026-06 | `tauri build` 打 dmg 失败 `bundle_dmg.sh` | 上一个 dmg 卷还挂载在 `/Volumes/clipboard-manager` | 打包前 `hdiutil detach` 卸载同名卷
- ✅ 2026-06 | `security import` p12 报 `MAC verification failed` | OpenSSL 3.x 默认 p12 MAC 算法 macOS `security` 不认 | 导出加 `-legacy -macalg sha1`
- ✅ 2026-06 | 快捷键显示 `CmdOrCtrl` | 录制器把 Meta/Ctrl 统一映射成跨平台别名 | 录制改具体键（Meta→`Cmd`、Ctrl→`Ctrl`）；后端加载时迁移老值 `CmdOrCtrl→Cmd`
- ✅ 2026-06 | 弹窗底部沉到 Dock 后面、最后几条看不到 | `position_at_cursor` 只夹紧到整块屏幕（含 Dock 区域） | 夹紧时预留顶部菜单栏(~28pt)与底部 Dock(~96pt)边距（按 `scale_factor` 换算）。**注**：96pt 是经验值，Dock 放大/超大时可能仍偏差；如需精确可用 NSScreen `visibleFrame`
- ✅ 2026-06 | `for v in /Volumes/clipboard*` 让整条打包命令中断 | zsh 在 glob 无匹配时报 `no matches found` 并中断 | 卸载卷用具体名：`hdiutil detach "/Volumes/clipboard-manager" -force 2>/dev/null || true`

---

## 7. 开发进度

> 每次开发结束更新这里。

**最近更新：2026-06-30**

- **当前状态**：所有已列功能均在 `npm run tauri dev` 下跑通；前端 `npm run build` 与后端 `cargo check` 全绿。
- **最后完成**：新增「备用快捷键」（`shortcut2`）+ 修复「弹窗底部沉到 Dock 后面」（`position_at_cursor` 预留 Dock/菜单栏边距）；并**已打出最新签名 dmg**。
  产物：`src-tauri/target/release/bundle/dmg/clipboard-manager_0.1.0_aarch64.dmg`（签名 `Clipboard Manager Dev`）。
- **打包注意**：① 先停 dev；② 卸载挂载的 dmg 卷要用 `hdiutil detach "/Volumes/clipboard-manager" -force 2>/dev/null || true`（**不要用 `/Volumes/clipboard*` glob**，zsh 无匹配会报错中断整条命令）。
- **Windows 版**：代码已跨平台化（粘贴/快捷键/亚克力/skipTaskbar，objc 仅 mac），已写好 `.github/workflows/build-windows.yml`；项目已 `git init` 并提交。**Mac 上无法直接打 Win 包**，需推到 GitHub 由 Actions 出 `.msi/.exe`。
- **下次从这里开始**：
  1. 用户推送到 GitHub 后，确认 Actions 的 Windows 包能正常构建/运行；首个 Win 包视觉若有问题再调（本机无法测 Windows）。
  2. 处理《5. 未完成需求清单》里的项（Intel/universal mac 包、图标负缓存等）。
