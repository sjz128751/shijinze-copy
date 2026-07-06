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

### 相关文档
- 本地各平台运行/编译/打包命令 + 关键名字：[`本地运行与打包.md`](./本地运行与打包.md)
- GitHub 云端自动打包（Win + Mac）流程：[`GitHub构建流程.md`](./GitHub构建流程.md)

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
- [x] **可选云同步（2026-07）**：设置里「🔄 同步」Tab 配同步密钥 + 开关 + 登录/注册（复用 admin-web `app_user` 账号，`/sjzApp/clip/register` 注册即自动登录）。当前加密统一用内置固定密钥 `Shijinze123`（用户密钥字段保留待后用）。默认走内置后端 `copy.nihaoiii.fun:80`；勾「自建服务器」才显示并使用自填 IP/端口。关闭「开启云同步」时下方全部置灰。登录后独立线程周期性把本地历史 **AES-256-GCM 端到端加密**上传到 admin-web、并拉取合并另一台机器的历史（服务端只存密文、解不开）。**完全隔离旁路**：关闭开关或服务器不可达时零联网、绝不影响单机运行。客户端 `src-tauri/src/sync.rs`；服务端 `com.xiliu.myfunction.clipboard`（`/sjzApp/clip/{login,push,pull,heartbeat}`）。首版只同步 text/files（不含图片）。
- [x] **剪切板使用统计后台（2026-07）**：App 运行+登录时每 5 分钟发心跳；后台页 `/clipstat.html`（软件管理目录，`tool:clipstat`）看设备数/活跃数/用户数/条目数。
- [x] **自定义数据存储位置（2026-07-05）**：设置→存储 Tab 可「选择目录/恢复默认」。所有数据文件（history/favorites/icons.json + images/）统一经 `effective_data_dir` 解析，由全局 `DATA_DIR_OVERRIDE` 决定（空=系统默认 `app_data_dir`）；`settings.data_dir` 持久化。切换时把现有数据迁移到新目录（**新目录已有同名文件则不覆盖**，便于指向已有数据文件夹），并把图片项绝对路径从旧 `images/` 重写到新 `images/` 使新目录自包含，旧目录保留作备份不删。命令 `get_data_dir/pick_data_dir/change_data_dir/reset_data_dir`（对话框走 `tauri-plugin-dialog` 的 blocking API，纯 Rust 侧，前端不加 npm 依赖）。`set_settings` 里 `data_dir` 被锁定为旧值，只能经专用命令改。
- [x] **常用数据导入/导出（2026-07-05）**：设置→存储 Tab「导出 / 合并导入 / 替换导入」。导出把 `Vec<FavGroup>` 写成 JSON；导入兼容分组格式与旧扁平格式，合并时同名分组内按 `same_content` 去重追加、其余作新分组（重新分配 id），替换先清空（前端二次确认）。命令 `export_favorites/import_favorites`。首版图片项仅带缩略图 base64+旧绝对路径，跨机导入图片不保证可用；text/files 完全可移植。
- [x] **常用交互增强（2026-07-05）**：① 分组标签条横向溢出时，竖直鼠标滚轮转左右滚动（`#fav-tabs` 的 `wheel`→`scrollLeft`）；② 常用列表空白处右键「新建常用记录」→ 顶部内联输入框回车保存一条文本常用（命令 `add_fav_text(text, groupId)`，组内去重；输入框 keydown 必须 `stopPropagation` 否则被全局键盘导航截走）。

---

## 5. 未完成需求清单

> 用户在此追加想做的功能；Claude 完成后移动到《4》并标日期。

- [ ] （示例格式）功能描述 —— 备注 / 验收标准
- [ ] 把 productName 从 `clipboard-manager` 改成中文名（如「剪切板」），dmg/菜单栏/活动监视器显示名同步
- [ ] 出 Intel(x86_64) 或 universal 包（现仅 Apple Silicon）
- [ ] 图标负缓存（来源 App 图标取不到时避免每次重试转换）
- [ ] vibrancy 失败兜底（旧系统/私有 API 变动时给不透明背景，避免透明穿透）
- [ ] 云同步：支持图片类型（需上传 PNG 字节 + 对端重建 image_path）
- [ ] 云同步：跨机删除/取消置顶的传播（当前是追加式并集，删除仅本机生效）
- [ ] 云同步：同步密钥/登录 token 目前明文存本地（settings.json / sync_auth.json），考虑接系统 keychain

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
- ✅ 2026-07-05 | `tauri build` 打 dmg 又失败 `bundle_dmg.sh`，但卷名不是 `shijinze-copy` 也不是 `clipboard-manager` | 上一次 dmg 打包**失败**会残留一个**随机名**临时卷 `/Volumes/dmg.XXXXXX`（rw.*.dmg），按固定名 detach 匹配不到 | 用 `hdiutil info` 找到 `image-path` 指向本项目 `bundle/macos/rw.*.dmg` 的那个 disk，`hdiutil detach /Volumes/dmg.XXXX -force` 卸载并 `rm -f bundle/macos/rw.*.dmg`，再重打
- ✅ 2026-07-03 | 刚呼出窗口时**历史列表空白**（连占位图标都没有），要手动滚一下才出现（右侧短列表「常用」不受影响） | **超一屏的 overflow 滚动容器 `#list` 在窗口显示时 WKWebView 不给它光栅化**，非得一次真实滚动位移才触发（跟内容何时渲染无关；短列表不足一屏所以没事）。走过弯路：translateZ 对长列表无效、display 开关+重拉数据更糟且卡 | ①`onWindowShown` 默认不重建 DOM；② `kickListPaint()` 只给 `#list` 补一次真实 2px 滚动位移（下一帧复位，非同帧来回）、在 rAF/100ms/250ms 各一发。详见踩坑记录`前端与窗口.md`（`src/main.ts`）
- ✅ 2026-07-03 | 弹出时选中不稳定落第 1 行，跑到光标压住的中间行 | 弹窗出现在光标处、光标压住中间行 → 系统派发「原地」mousemove 抢选中；且程序化滚动（scrollTop=0/kickListPaint）误触发 `selectUnderPointer` 跟随光标 | 加 `programmaticScrolls` 守卫程序化滚动 + `pointerArmed`/`pointerBaseline`「鼠标真移动过」判定：弹出先锁第 0 行，位移>2px 才 arm 跟随光标
- ✅ 2026-07-03 | 云同步登录：admin 账号登不进 | admin 是后台 `sys_user`，剪切板同步复用移动端 `app_user`（两套独立账号体系）| 用 app_user 账号登录（同安卓 App）；没有则 `/sjzApp/user/register` 注册。详见踩坑记录 `云同步.md`
- ✅ 2026-07-03 | 云同步编译 `E0034 new_from_slice 冲突` | 同时 use 了 aes-gcm `KeyInit` 与 hmac `Mac`，都有 `new_from_slice` | 全限定 `<HmacSha256 as Mac>::new_from_slice(key)`
- ✅ 2026-07-06 | Windows 主窗口背景固定发黑、与浅色内容割裂（Mac 观感协调） | 亚克力 tint 固定为近黑 `(18,18,18,125)`，不跟随主题；浅色主题下内容浅、底色黑，显糊/割裂 | 亚克力改**跟随主题**：新增 `apply_win_acrylic(win, theme)`——浅色给浅磨砂 `(243,243,245,150)`、深色给干净暗磨砂 `(43,43,46,150)`；`theme="system"` 时 `reg query …\Personalize /v AppsUseLightTheme`（0x0=深）判断系统深浅色。setup 首次应用 + 每次 `show_main_window` 弹窗重刷（跟随系统切换）。仅 Windows
- ✅ 2026-07-06 | 自动粘贴慢：点击后隔 1~2s 才 ⌘V、时快时慢 | 旧实现在后台线程 `sleep(130ms)` 后用 `run_on_main_thread(simulate_cmd_v)` 发 ⌘V；但此时本 App 已隐藏窗口+还焦点给来源 App、退成后台 Accessory 应用，其事件循环被系统懒惰派发，排队的闭包滞留最多 ~1~2s。（走主线程是因 enigo 解析键码调 HIToolbox/TSM 只能主线程）| macOS 改直接投递 CGEvent（`post_cmd_v_cgevent`：数字键码 kVK_ANSI_V=0x09 + Command 修饰位 + `CGEventPost`，裸 FFI 链 CoreGraphics/CoreFoundation，无新依赖）——数字键码不碰 HIToolbox/TSM，可任意线程调用，⌘V 直接在 worker 线程发，不再等本 App 后台事件循环 → 延迟回到 ~130ms。两处粘贴收敛到 `fire_auto_paste()`；enigo 仅非 macOS 保留。详见踩坑记录 `Rust后端.md`
- ✅ 2026-07-05 | 加「选择数据目录」后点按钮 App 卡死/被强退（exit 144） | tauri-plugin-dialog 的 `blocking_pick_folder/pick_file/save_file` 会把原生对话框派发到**主线程**再阻塞等待；而 Tauri v2 **同步命令默认就在主线程执行** → 主线程自己等自己，死锁 | 开对话框的命令改标 `#[tauri::command(async)]`（令其在独立线程跑），主线程才能处理对话框事件。顺带把做大量文件拷贝的 `change_data_dir/reset_data_dir` 也标 async 避免卡 UI

---

## 7. 开发进度

> 每次开发结束更新这里。

**最近更新：2026-07-05**

- **本次完成**：① 换新剪贴板 App 图标（青绿→海蓝渐变 + 白板 + 琥珀夹子 + 叠卡，源 `src-tauri/icons/icon-source.svg` → `npx tauri icon` 出全套）；② 自定义数据存储位置（`effective_data_dir` + `DATA_DIR_OVERRIDE`，迁移+图片路径重写）；③ 常用导入/导出（`export_favorites`/`import_favorites`）。新增依赖 `tauri-plugin-dialog`（Rust blocking 对话框，前端零新依赖）。
- **验证**：`cargo check` 与 `npm run build` 全绿。**尚未真机手测**目录切换/导入导出的实际 UI 流程与图片迁移，也**未重新打包 dmg**。
- **下次从这里开始**：真机验证「选择目录→迁移→重启后仍读新目录」「导出→替换导入→合并导入」全流程（尤其含图片项时旧绝对路径重写是否生效）；无误后重新打 dmg。

---

**2026-07-03 存档**

- **本次完成：可选云同步 + 后台使用统计**（跨 admin-web 两端）。
  - 客户端：`src-tauri/src/sync.rs`（独立 worker 线程 + AES-256-GCM 端到端加密 + HMAC 去重 + 心跳）；`models.rs` 加 4 个同步 Settings 字段；`lib.rs` 接线（Inner 加 `sync_auth`、setup 启 worker、注册 4 命令）；设置窗口加「🔄 同步」Tab。新增依赖 reqwest(纯HTTP,无TLS)/aes-gcm/sha2/hmac/rand。
  - 服务端：`com.xiliu.myfunction.clipboard`（2 实体 + 2 Mapper + 2 Service + 2 Controller）；建表数组、ToolAuthFilter 规则、菜单初始化三处已登记；后台页 `static/clipstat.html`。
  - **验证**：三端编译全绿；后端 `mvn spring-boot:run` 起来后 curl 跑通 login/push/pull/heartbeat + 统计页鉴权拦截；客户端 `npm run tauri dev` 启动带 worker 无 panic。**尚未做真机双端同步实测**（需两台机器登录同账号+同密钥）。
  - **关键事实**：剪切板登录复用 `app_user`（同安卓 App），**不是** admin（sys_user）。
- **当前状态**：所有已列功能均在 `npm run tauri dev` 下跑通；前端 `npm run build` 与后端 `cargo check` 全绿。
- **下次从这里开始（云同步）**：① 真机双端同步实测（两台机填相同服务器+相同同步密钥，登录同一 app_user，看历史互相出现）；② 处理《5》里云同步 TODO（图片同步、跨机删除传播、密钥进 keychain）。

- **最后完成**：新增「备用快捷键」（`shortcut2`）+ 修复「弹窗底部沉到 Dock 后面」（`position_at_cursor` 预留 Dock/菜单栏边距）；并**已打出最新签名 dmg**。
  产物：`src-tauri/target/release/bundle/dmg/clipboard-manager_0.1.0_aarch64.dmg`（签名 `Clipboard Manager Dev`）。
- **打包注意**：① 先停 dev；② 卸载挂载的 dmg 卷要用 `hdiutil detach "/Volumes/clipboard-manager" -force 2>/dev/null || true`（**不要用 `/Volumes/clipboard*` glob**，zsh 无匹配会报错中断整条命令）。
- **Windows 版**：代码已跨平台化（粘贴/快捷键/亚克力/skipTaskbar，objc 仅 mac），已写好 `.github/workflows/build-windows.yml`；项目已 `git init` 并提交。**Mac 上无法直接打 Win 包**，需推到 GitHub 由 Actions 出 `.msi/.exe`。
- **下次从这里开始**：
  1. 用户推送到 GitHub 后，确认 Actions 的 Windows 包能正常构建/运行；首个 Win 包视觉若有问题再调（本机无法测 Windows）。
  2. 处理《5. 未完成需求清单》里的项（Intel/universal mac 包、图标负缓存等）。
