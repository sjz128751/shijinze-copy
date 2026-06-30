mod clipboard;
mod models;
mod settings;
mod source_app;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::clipboard::ClipRead;
use crate::models::{ClipItem, FavGroup, Settings};

/// 历史条数上限的合理范围。
const HISTORY_MIN: u32 = 10;
const HISTORY_MAX: u32 = 1000;

fn clamp_history_size(n: u32) -> u32 {
    n.clamp(HISTORY_MIN, HISTORY_MAX)
}

/// 主窗口固定宽度（高度可在设置里调）。
const WIN_WIDTH: f64 = 640.0;
/// 主窗口高度的合理范围。
const WIN_HEIGHT_MIN: u32 = 360;
const WIN_HEIGHT_MAX: u32 = 1400;

fn clamp_window_height(n: u32) -> u32 {
    n.clamp(WIN_HEIGHT_MIN, WIN_HEIGHT_MAX)
}

/// 图片缩略图高度的合理范围。
fn clamp_image_thumb_height(n: u32) -> u32 {
    n.clamp(14, 48)
}

/// 托管的内部可变状态。
struct Inner {
    history: Vec<ClipItem>,
    /// 「常用」收藏分组：每个分组含一组用户精选条目，独立持久化，不受历史上限淘汰。
    /// 始终至少存在 1 个分组。
    fav_groups: Vec<FavGroup>,
    /// 上次记录到的剪贴板内容「签名」，用于去重（也避免 copy_item 写回触发重复记录）。
    last_sig: Option<String>,
    /// 自增 id 计数器。
    next_id: u64,
    /// 当前设置。
    settings: Settings,
    /// 来源 App 图标映射：`sourceApp 名称 -> base64 PNG data URL`。
    ///
    /// 去重的持久化层：图标只在这里存一份，ClipItem 仅以 `source_app` 作引用键。
    /// 随 icons.json 持久化、经 icons-updated 事件/ get_icons 命令下发给前端，
    /// 不再随每条 history 内嵌或全量推送，避免数百条记录重复携带相同图标。
    icons: HashMap<String, String>,
    /// 窗口显示时记录的「前台来源 App」进程号；粘贴前据此把焦点还给它。
    prev_app_pid: Option<i32>,
}

/// 托管状态：主状态锁 + 来源 App 图标缓存（缓存自带独立锁，与主锁解耦）。
struct AppState(Mutex<Inner>, source_app::IconCache);

/// 当前 Unix 毫秒时间戳。
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===================== 历史持久化 =====================

/// 历史持久化文件路径： app_data_dir()/history.json
fn history_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            Some(dir.join("history.json"))
        }
        Err(_) => None,
    }
}

/// 从磁盘加载历史（不存在或失败则返回空）。
fn load_history(app: &AppHandle) -> Vec<ClipItem> {
    let Some(path) = history_path(app) else {
        return Vec::new();
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let mut history = serde_json::from_str::<Vec<ClipItem>>(&content).unwrap_or_default();
            // hash 字段不持久化（#[serde(skip)]），重启后为 None。
            // 对每个 image 项读回磁盘 PNG 重算并回填 hash，
            // 以保证图片去重、last_sig 防重入、copy_item 签名跨重启稳定。
            for item in history.iter_mut() {
                if item.kind == "image" && item.hash.is_none() {
                    if let Some(p) = item.image_path.as_deref() {
                        if let Ok(png) = std::fs::read(p) {
                            if let Some((hash, _thumb)) = clipboard::process_image(&png) {
                                item.hash = Some(hash);
                            }
                        }
                    }
                }
            }
            history
        }
        Err(_) => Vec::new(),
    }
}

/// 将历史写回磁盘（失败时容错，不 panic）。
fn save_history(app: &AppHandle, history: &[ClipItem]) {
    let Some(path) = history_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(history) {
        let _ = std::fs::write(&path, json);
    }
}

// ===================== 来源图标映射持久化 =====================

/// 图标映射持久化文件路径： app_data_dir()/icons.json
fn icons_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            Some(dir.join("icons.json"))
        }
        Err(_) => None,
    }
}

/// 从磁盘加载 `sourceApp -> dataURL` 图标映射（不存在或失败则返回空）。
fn load_icons(app: &AppHandle) -> HashMap<String, String> {
    let Some(path) = icons_path(app) else {
        return HashMap::new();
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<HashMap<String, String>>(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// 将图标映射写回磁盘（失败时容错，不 panic）。
fn save_icons(app: &AppHandle, icons: &HashMap<String, String>) {
    let Some(path) = icons_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string(icons) {
        let _ = std::fs::write(&path, json);
    }
}

/// 图标映射变更后的收尾：持久化 + 广播。映射通常很小（仅 N 个不同的 App），
/// 且只在出现新 App / 图标变化时才触发，远比每次剪贴板变更全量重推图标省。
fn commit_icons(app: &AppHandle, icons: &HashMap<String, String>) {
    save_icons(app, icons);
    let _ = app.emit("icons-updated", icons);
}

/// 在持锁期间把本次捕获到的来源图标登记进映射。
/// 仅当名称与图标都存在、且与已有值不同（或新增）时写入并返回 `true`。
fn register_icon_locked(
    inner: &mut Inner,
    name: &Option<String>,
    icon: &Option<String>,
) -> bool {
    if let (Some(n), Some(ic)) = (name, icon) {
        if inner.icons.get(n).map(|e| e == ic).unwrap_or(false) {
            false
        } else {
            inner.icons.insert(n.clone(), ic.clone());
            true
        }
    } else {
        false
    }
}

/// 在持锁期间对历史重排为「置顶项(ts desc) ++ 非置顶项(ts desc)」，
/// 并仅对「非置顶」分组按 settings.history_size 截断（置顶项永不淘汰）。
/// 返回被淘汰的图片项磁盘路径，供调用方在释放锁后删除文件（避免泄漏）。
fn sort_and_truncate_locked(inner: &mut Inner) -> Vec<String> {
    // 排序：置顶项按设置排在顶部或底部；同组内按时间戳倒序。
    let pinned_bottom = inner.settings.pinned_position == "bottom";
    inner.history.sort_by(|a, b| {
        let group = if pinned_bottom {
            a.pinned.cmp(&b.pinned) // 置顶在后
        } else {
            b.pinned.cmp(&a.pinned) // 置顶在前
        };
        group.then(b.timestamp.cmp(&a.timestamp))
    });

    let limit = clamp_history_size(inner.settings.history_size) as usize;
    let mut removed = Vec::new();
    let mut unpinned_count = 0usize;
    let mut kept: Vec<ClipItem> = Vec::with_capacity(inner.history.len());

    for item in inner.history.drain(..) {
        if item.pinned {
            kept.push(item);
            continue;
        }
        unpinned_count += 1;
        if unpinned_count <= limit {
            kept.push(item);
        } else if item.kind == "image" {
            if let Some(p) = item.image_path {
                removed.push(p);
            }
        }
    }
    inner.history = kept;
    removed
}

/// 历史变更后的统一收尾（在释放锁后调用）：删除淘汰图片文件、持久化、广播事件。
fn commit(app: &AppHandle, snapshot: &[ClipItem], removed_paths: &[String]) {
    for p in removed_paths {
        let _ = std::fs::remove_file(p);
    }
    save_history(app, snapshot);
    let _ = app.emit("history-updated", snapshot);
}

// ===================== 常用收藏持久化 =====================

/// 常用持久化文件路径： app_data_dir()/favorites.json
fn favorites_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            Some(dir.join("favorites.json"))
        }
        Err(_) => None,
    }
}

/// 为常用项补回图片 hash（重启后 #[serde(skip)] 的 hash 为 None）。
fn rehash_fav_items(items: &mut [ClipItem]) {
    for item in items.iter_mut() {
        if item.kind == "image" && item.hash.is_none() {
            if let Some(p) = item.image_path.as_deref() {
                if let Ok(png) = std::fs::read(p) {
                    if let Some((hash, _thumb)) = clipboard::process_image(&png) {
                        item.hash = Some(hash);
                    }
                }
            }
        }
    }
}

/// 从磁盘加载常用分组。兼容三种磁盘状态：
/// 1) 新格式 `Vec<FavGroup>` → 原样返回，`legacy=false`
/// 2) 旧格式扁平 `Vec<ClipItem>` → 包进一个默认组（id 占位 0），`legacy=true`
/// 3) 缺失/损坏 → 空，`legacy=true`
/// `legacy=true` 表示组 id 需由 setup 统一分配、并补足至少 1 个分组。
fn load_fav_groups(app: &AppHandle) -> (Vec<FavGroup>, bool) {
    let Some(path) = favorites_path(app) else {
        return (Vec::new(), true);
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return (Vec::new(), true);
    };
    // 先尝试新格式（FavGroup 需要 name 字段，老的扁平 ClipItem 会解析失败而落到下面）。
    if let Ok(mut groups) = serde_json::from_str::<Vec<FavGroup>>(&content) {
        for g in groups.iter_mut() {
            rehash_fav_items(&mut g.items);
        }
        return (groups, false);
    }
    // 再尝试旧扁平格式 → 迁移进一个默认组（id 由 setup 统一分配）。
    if let Ok(mut flat) = serde_json::from_str::<Vec<ClipItem>>(&content) {
        rehash_fav_items(&mut flat);
        return (
            vec![FavGroup {
                id: 0,
                name: "默认".to_string(),
                items: flat,
            }],
            true,
        );
    }
    (Vec::new(), true)
}

/// 将常用分组写回磁盘（失败时容错）。
fn save_favorites(app: &AppHandle, groups: &[FavGroup]) {
    let Some(path) = favorites_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(groups) {
        let _ = std::fs::write(&path, json);
    }
}

/// 常用变更后的统一收尾：持久化 + 广播。
fn commit_favorites(app: &AppHandle, snapshot: &[FavGroup]) {
    save_favorites(app, snapshot);
    let _ = app.emit("favorites-updated", snapshot);
}

/// 两条记录内容是否相同（用于常用去重）。
fn same_content(a: &ClipItem, b: &ClipItem) -> bool {
    if a.kind != b.kind {
        return false;
    }
    match a.kind.as_str() {
        "files" => a.files == b.files,
        "image" => a.hash.is_some() && a.hash == b.hash,
        _ => a.text == b.text,
    }
}

// ===================== 历史命令 =====================

#[tauri::command]
fn get_history(state: State<'_, AppState>) -> Vec<ClipItem> {
    match state.0.lock() {
        Ok(inner) => inner.history.clone(),
        Err(_) => Vec::new(),
    }
}

/// 返回 `sourceApp -> 图标 dataURL` 映射。前端启动时拉取一次，
/// 之后通过 icons-updated 事件增量更新，按 ClipItem.sourceApp 键查图标渲染。
#[tauri::command]
fn get_icons(state: State<'_, AppState>) -> HashMap<String, String> {
    match state.0.lock() {
        Ok(inner) => inner.icons.clone(),
        Err(_) => HashMap::new(),
    }
}

/// 把目标项移到其分组顶部、更新 last_sig、写回系统剪贴板、重排截断并广播。
/// 返回 true 表示找到并已写回（供调用方决定是否隐藏窗口/模拟粘贴）。
fn activate_item(app: &AppHandle, id: u64, state: &AppState) -> bool {
    let prepared = {
        let Ok(mut inner) = state.0.lock() else {
            return false;
        };
        let Some(pos) = inner.history.iter().position(|it| it.id == id) else {
            return false;
        };
        let mut item = inner.history.remove(pos);
        item.timestamp = now_millis();

        // 计算签名，避免写回后被轮询当成新项。
        let sig = match item.kind.as_str() {
            "image" => format!("i:{}", item.hash.unwrap_or(0)),
            "files" => format!("f:{}", item.files.clone().unwrap_or_default().join("\u{0}")),
            _ => format!("t:{}", item.text.clone().unwrap_or_default()),
        };
        inner.last_sig = Some(sig);

        let kind = item.kind.clone();
        let text = item.text.clone();
        let files = item.files.clone();
        let image_path = item.image_path.clone();

        inner.history.insert(0, item);
        let removed = sort_and_truncate_locked(&mut inner);
        let snapshot = inner.history.clone();
        (kind, text, files, image_path, snapshot, removed)
    };

    let (kind, text, files, image_path, snapshot, removed) = prepared;

    // 在释放锁后写回系统剪贴板。
    match kind.as_str() {
        "image" => {
            if let Some(path) = image_path {
                let _ = clipboard::write_image_file(&path);
            }
        }
        "files" => {
            if let Some(files) = files {
                let _ = clipboard::write_files(&files);
            }
        }
        _ => {
            if let Some(text) = text {
                let _ = clipboard::write_text(&text);
            }
        }
    }

    commit(app, &snapshot, &removed);
    true
}

/// 本 App 是否已被系统授予「辅助功能」信任（决定模拟按键能否生效）。
#[cfg(target_os = "macos")]
fn accessibility_trusted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }
    unsafe { AXIsProcessTrusted() != 0 }
}
#[cfg(not(target_os = "macos"))]
fn accessibility_trusted() -> bool {
    true
}

/// 打开「系统设置 → 隐私与安全性 → 辅助功能」面板，引导用户授权。
#[cfg(target_os = "macos")]
fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}
#[cfg(not(target_os = "macos"))]
fn open_accessibility_settings() {}

/// 用 enigo 模拟一次 ⌘V（macOS 需「辅助功能」权限，未授权时静默失败）。
fn simulate_cmd_v() {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
    // 粘贴修饰键：macOS 用 ⌘(Meta)，Windows/Linux 用 Ctrl。
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) else {
        return;
    };
    let _ = enigo.key(modifier, Direction::Press);
    let _ = enigo.key(Key::Unicode('v'), Direction::Click);
    let _ = enigo.key(modifier, Direction::Release);
}

#[tauri::command]
fn copy_item(app: AppHandle, id: u64, state: State<'_, AppState>) {
    // 仅复制 + 移顶 + 隐藏窗口（不模拟粘贴）。
    if activate_item(&app, id, &state) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
        }
    }
}

#[tauri::command]
fn paste_item(app: AppHandle, id: u64, state: State<'_, AppState>) {
    // 招牌动作：写回剪贴板 → 隐藏窗口 → (pasteOnSelect 时) 另起线程延时模拟 ⌘V。
    let paste_on_select = state
        .0
        .lock()
        .map(|i| i.settings.paste_on_select)
        .unwrap_or(true);

    if !activate_item(&app, id, &state) {
        return;
    }

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }

    if paste_on_select {
        if accessibility_trusted() {
            let app2 = app.clone();
            let prev_pid = state.0.lock().ok().and_then(|i| i.prev_app_pid);
            std::thread::spawn(move || {
                // 1. 先把焦点还给来源 App（在主线程激活），否则 ⌘V 落不到目标窗口。
                if let Some(pid) = prev_pid {
                    let _ = app2.run_on_main_thread(move || source_app::activate_pid(pid));
                }
                // 2. 等焦点切换完成后，在主线程发送 ⌘V。
                //    enigo 解析键码会调用 HIToolbox/TSM，这些 API 必须在主线程，
                //    否则触发 dispatch_assert_queue 断言导致 SIGTRAP 崩溃。
                std::thread::sleep(Duration::from_millis(130));
                let _ = app2.run_on_main_thread(simulate_cmd_v);
            });
        } else {
            // 未授权辅助功能：内容已写入剪贴板，但无法模拟粘贴。打开设置引导授权。
            let _ = app.emit("need-accessibility", ());
            open_accessibility_settings();
        }
    }
}

#[tauri::command]
fn toggle_pin(app: AppHandle, id: u64, state: State<'_, AppState>) {
    let (snapshot, removed) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        match inner.history.iter_mut().find(|it| it.id == id) {
            Some(item) => item.pinned = !item.pinned,
            None => return,
        }
        let removed = sort_and_truncate_locked(&mut inner);
        (inner.history.clone(), removed)
    };
    commit(&app, &snapshot, &removed);
}

#[tauri::command]
fn delete_item(app: AppHandle, id: u64, state: State<'_, AppState>) {
    let (snapshot, removed) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let mut removed = Vec::new();
        if let Some(pos) = inner.history.iter().position(|it| it.id == id) {
            let it = inner.history.remove(pos);
            if it.kind == "image" {
                if let Some(p) = it.image_path {
                    removed.push(p);
                }
            }
            // 删除后清空 last_sig：否则若删的恰是最近记录项，
            // 重新复制相同内容会被 last_sig 去重跳过而无法重新入库。
            inner.last_sig = None;
        }
        (inner.history.clone(), removed)
    };
    commit(&app, &snapshot, &removed);
}

/// 清空历史。clear_pinned=false 仅清非置顶项（保留置顶）；
/// clear_pinned=true 全部清空（含置顶，并删其图片文件）。
#[tauri::command]
fn clear_history(app: AppHandle, clear_pinned: bool, state: State<'_, AppState>) {
    let (snapshot, removed) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let mut removed = Vec::new();
        if clear_pinned {
            for it in inner.history.drain(..) {
                if it.kind == "image" {
                    if let Some(p) = it.image_path {
                        removed.push(p);
                    }
                }
            }
            inner.last_sig = None;
        } else {
            let mut kept: Vec<ClipItem> = Vec::new();
            for it in inner.history.drain(..) {
                if it.pinned {
                    kept.push(it);
                } else if it.kind == "image" {
                    if let Some(p) = it.image_path {
                        removed.push(p);
                    }
                }
            }
            inner.history = kept;
        }
        (inner.history.clone(), removed)
    };
    commit(&app, &snapshot, &removed);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

// ===================== 常用收藏命令 =====================

#[tauri::command]
fn get_favorites(state: State<'_, AppState>) -> Vec<FavGroup> {
    match state.0.lock() {
        Ok(inner) => inner.fav_groups.clone(),
        Err(_) => Vec::new(),
    }
}

/// 把历史项（id 为历史项 id）加入指定常用分组：复制为新常用项（分配新 id），按组内内容去重。
#[tauri::command]
fn add_favorite(app: AppHandle, id: u64, group_id: u64, state: State<'_, AppState>) {
    let snapshot = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let Some(src) = inner.history.iter().find(|it| it.id == id).cloned() else {
            return;
        };
        let Some(gpos) = inner.fav_groups.iter().position(|g| g.id == group_id) else {
            return;
        };
        // 该组内已收藏相同内容则忽略。
        if inner.fav_groups[gpos]
            .items
            .iter()
            .any(|f| same_content(f, &src))
        {
            return;
        }
        let new_id = inner.next_id;
        inner.next_id += 1;
        let mut fav = src.clone();
        fav.id = new_id;
        fav.pinned = false;
        fav.timestamp = now_millis();
        // 图片：复制一份独立 PNG，避免与历史共享文件（历史淘汰/删除时不影响常用，
        // 移除常用时也只删自己这份）。读失败则退化为共享原路径。
        if fav.kind == "image" {
            if let Some(src_path) = src.image_path.as_deref() {
                if let Ok(bytes) = std::fs::read(src_path) {
                    if let Some(p) = clipboard::save_image_png(&app, new_id, &bytes) {
                        fav.image_path = Some(p);
                    }
                }
            }
        }
        inner.fav_groups[gpos].items.insert(0, fav);
        inner.fav_groups.clone()
    };
    commit_favorites(&app, &snapshot);
}

/// 从常用移除（id 为常用项 id，跨所有分组查找）。删除其独立图片 PNG。
#[tauri::command]
fn remove_favorite(app: AppHandle, id: u64, state: State<'_, AppState>) {
    let (snapshot, removed) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let mut removed = Vec::new();
        for g in inner.fav_groups.iter_mut() {
            if let Some(pos) = g.items.iter().position(|it| it.id == id) {
                let it = g.items.remove(pos);
                if it.kind == "image" {
                    if let Some(p) = it.image_path {
                        removed.push(p);
                    }
                }
                break;
            }
        }
        (inner.fav_groups.clone(), removed)
    };
    for p in &removed {
        let _ = std::fs::remove_file(p);
    }
    commit_favorites(&app, &snapshot);
}

/// 新建一个空分组。
#[tauri::command]
fn add_group(app: AppHandle, name: String, state: State<'_, AppState>) {
    let snapshot = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let new_id = inner.next_id;
        inner.next_id += 1;
        let nm = if name.trim().is_empty() {
            "新分组".to_string()
        } else {
            name.trim().to_string()
        };
        inner.fav_groups.push(FavGroup {
            id: new_id,
            name: nm,
            items: Vec::new(),
        });
        inner.fav_groups.clone()
    };
    commit_favorites(&app, &snapshot);
}

/// 重命名分组（空名忽略）。
#[tauri::command]
fn rename_group(app: AppHandle, group_id: u64, name: String, state: State<'_, AppState>) {
    let snapshot = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let nm = name.trim();
        if nm.is_empty() {
            return;
        }
        match inner.fav_groups.iter_mut().find(|g| g.id == group_id) {
            Some(g) => g.name = nm.to_string(),
            None => return,
        }
        inner.fav_groups.clone()
    };
    commit_favorites(&app, &snapshot);
}

/// 删除分组及其条目（含独立图片 PNG）。删后若无分组则重建一个"默认"空组。
#[tauri::command]
fn delete_group(app: AppHandle, group_id: u64, state: State<'_, AppState>) {
    let (snapshot, removed) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let mut removed = Vec::new();
        if let Some(pos) = inner.fav_groups.iter().position(|g| g.id == group_id) {
            let g = inner.fav_groups.remove(pos);
            for it in g.items {
                if it.kind == "image" {
                    if let Some(p) = it.image_path {
                        removed.push(p);
                    }
                }
            }
        }
        if inner.fav_groups.is_empty() {
            let new_id = inner.next_id;
            inner.next_id += 1;
            inner.fav_groups.push(FavGroup {
                id: new_id,
                name: "默认".to_string(),
                items: Vec::new(),
            });
        }
        (inner.fav_groups.clone(), removed)
    };
    for p in &removed {
        let _ = std::fs::remove_file(p);
    }
    commit_favorites(&app, &snapshot);
}

/// 写回某常用项内容到系统剪贴板（不改动常用顺序），并设置 last_sig 防被轮询重复记录。
fn activate_favorite(id: u64, state: &AppState) -> bool {
    let prepared = {
        let Ok(mut inner) = state.0.lock() else {
            return false;
        };
        let Some(item) = inner
            .fav_groups
            .iter()
            .flat_map(|g| g.items.iter())
            .find(|it| it.id == id)
            .cloned()
        else {
            return false;
        };
        let sig = match item.kind.as_str() {
            "image" => format!("i:{}", item.hash.unwrap_or(0)),
            "files" => format!("f:{}", item.files.clone().unwrap_or_default().join("\u{0}")),
            _ => format!("t:{}", item.text.clone().unwrap_or_default()),
        };
        inner.last_sig = Some(sig);
        (
            item.kind.clone(),
            item.text.clone(),
            item.files.clone(),
            item.image_path.clone(),
        )
    };
    let (kind, text, files, image_path) = prepared;
    match kind.as_str() {
        "image" => {
            if let Some(path) = image_path {
                let _ = clipboard::write_image_file(&path);
            }
        }
        "files" => {
            if let Some(files) = files {
                let _ = clipboard::write_files(&files);
            }
        }
        _ => {
            if let Some(text) = text {
                let _ = clipboard::write_text(&text);
            }
        }
    }
    true
}

/// 粘贴某常用项：写回剪贴板 → 隐藏窗口 →（pasteOnSelect 时）模拟 ⌘V。
#[tauri::command]
fn paste_favorite(app: AppHandle, id: u64, state: State<'_, AppState>) {
    let paste_on_select = state
        .0
        .lock()
        .map(|i| i.settings.paste_on_select)
        .unwrap_or(true);

    if !activate_favorite(id, &state) {
        return;
    }

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }

    if paste_on_select {
        if accessibility_trusted() {
            let app2 = app.clone();
            let prev_pid = state.0.lock().ok().and_then(|i| i.prev_app_pid);
            std::thread::spawn(move || {
                if let Some(pid) = prev_pid {
                    let _ = app2.run_on_main_thread(move || source_app::activate_pid(pid));
                }
                // ⌘V 模拟必须在主线程（enigo 解析键码会调 HIToolbox/TSM，否则崩溃）。
                std::thread::sleep(Duration::from_millis(130));
                let _ = app2.run_on_main_thread(simulate_cmd_v);
            });
        } else {
            let _ = app.emit("need-accessibility", ());
            open_accessibility_settings();
        }
    }
}

// ===================== 设置命令 =====================

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    match state.0.lock() {
        Ok(inner) => inner.settings.clone(),
        Err(_) => Settings::default(),
    }
}

#[tauri::command]
fn set_settings(app: AppHandle, mut settings: Settings, state: State<'_, AppState>) {
    // 读取旧设置以便 diff。
    let Some(old) = state.0.lock().ok().map(|i| i.settings.clone()) else {
        return;
    };

    // 快捷键变更 → 注销旧的、注册新的；新快捷键注册失败时回退，
    // 保证任何时刻都有一个可用的全局快捷键，并把实际生效的值写回 settings。
    if old.shortcut != settings.shortcut {
        // 先注销旧快捷键。
        if let Ok(s) = old.shortcut.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(s);
        }
        // 尝试注册新快捷键（解析成功且注册成功才算生效）。
        let new_ok = settings
            .shortcut
            .parse::<Shortcut>()
            .ok()
            .and_then(|s| app.global_shortcut().register(s).ok())
            .is_some();
        if !new_ok {
            // 新快捷键无效或被占用：回退到旧快捷键，旧的也不行则回退默认。
            let old_ok = old
                .shortcut
                .parse::<Shortcut>()
                .ok()
                .and_then(|s| app.global_shortcut().register(s).ok())
                .is_some();
            if old_ok {
                settings.shortcut = old.shortcut.clone();
            } else if let Ok(s) = "CmdOrCtrl+Shift+V".parse::<Shortcut>() {
                if app.global_shortcut().register(s).is_ok() {
                    settings.shortcut = "CmdOrCtrl+Shift+V".to_string();
                } else {
                    // 连默认都注册失败，至少不持久化坏值，沿用旧值。
                    settings.shortcut = old.shortcut.clone();
                }
            } else {
                settings.shortcut = old.shortcut.clone();
            }
        }
    }

    // 备用快捷键变更 → 注销旧的、注册新的（空字符串表示不设）。无效/占用则回退旧值。
    if old.shortcut2 != settings.shortcut2 {
        if let Ok(s) = old.shortcut2.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(s);
        }
        if settings.shortcut2.trim().is_empty() {
            // 清空备用键：不注册。
        } else {
            let ok = settings
                .shortcut2
                .parse::<Shortcut>()
                .ok()
                .and_then(|s| app.global_shortcut().register(s).ok())
                .is_some();
            if !ok {
                // 无效或被占用 → 回退旧值（旧值非空则重新注册）。
                settings.shortcut2 = old.shortcut2.clone();
                if let Ok(s) = old.shortcut2.parse::<Shortcut>() {
                    let _ = app.global_shortcut().register(s);
                }
            }
        }
    }

    // 开机自启变更 → enable/disable。
    if old.autostart != settings.autostart {
        let mgr = app.autolaunch();
        if settings.autostart {
            let _ = mgr.enable();
        } else {
            let _ = mgr.disable();
        }
    }

    // 历史上限合法化。
    settings.history_size = clamp_history_size(settings.history_size);
    // 图片缩略图高度合法化。
    settings.image_thumb_height = clamp_image_thumb_height(settings.image_thumb_height);
    // 历史上限或置顶项位置变化 → 需要重排/截断。
    let resort_needed = old.history_size != settings.history_size
        || old.pinned_position != settings.pinned_position;

    // 窗口高度合法化 + 若变化则实时调整主窗口尺寸（宽度保持固定）。
    settings.window_height = clamp_window_height(settings.window_height);
    if old.window_height != settings.window_height {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_size(tauri::LogicalSize::new(
                WIN_WIDTH,
                settings.window_height as f64,
            ));
        }
    }

    // 写入托管状态；若历史上限变化则立即重排+截断。
    let truncate_result = {
        if let Ok(mut inner) = state.0.lock() {
            inner.settings = settings.clone();
            if resort_needed {
                let removed = sort_and_truncate_locked(&mut inner);
                Some((inner.history.clone(), removed))
            } else {
                None
            }
        } else {
            None
        }
    };

    settings::save_settings(&app, &settings);
    let _ = app.emit("settings-updated", &settings);

    // 历史被截断 → 删除淘汰图片文件并广播新历史。
    if let Some((snapshot, removed)) = truncate_result {
        commit(&app, &snapshot, &removed);
    }
}

// ===================== 窗口与轮询 =====================

/// 统一的窗口显示路径（快捷键 / 托盘）：显示 → 居中 → 聚焦 → emit window-shown。
/// 前端据 window-shown 聚焦搜索框、清空搜索、选中第一项。
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // 在抢焦点之前，记下当前前台 App（粘贴时把焦点还给它）。
        let pid = source_app::frontmost_pid();
        if pid.is_some() {
            if let Ok(mut inner) = app.state::<AppState>().0.lock() {
                inner.prev_app_pid = pid;
            }
        }
        let _ = win.show();
        // 弹窗位置：center=屏幕中心，否则(默认 cursor)跟随光标。
        let center = app
            .state::<AppState>()
            .0
            .lock()
            .map(|i| i.settings.popup_position == "center")
            .unwrap_or(false);
        if center {
            let _ = win.center();
        } else {
            position_at_cursor(app, &win);
        }
        let _ = win.set_focus();
        let _ = app.emit("window-shown", ());
    }
}

/// 把窗口移到鼠标光标附近（左上角靠近光标），并夹紧在光标所在显示器范围内，避免越界。
fn position_at_cursor(app: &AppHandle, win: &tauri::WebviewWindow) {
    let cursor = match app.cursor_position() {
        Ok(p) => p,
        Err(_) => return,
    };
    let win_size = match win.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let monitor = win
        .available_monitors()
        .ok()
        .and_then(|ms| {
            ms.into_iter().find(|m| {
                let p = m.position();
                let s = m.size();
                let x = cursor.x as i32;
                let y = cursor.y as i32;
                x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
            })
        })
        .or_else(|| win.current_monitor().ok().flatten());

    let mut x = cursor.x as i32 - 16;
    let mut y = cursor.y as i32 - 16;
    if let Some(m) = monitor {
        let p = m.position();
        let s = m.size();
        let scale = m.scale_factor();
        // 预留顶部菜单栏(~28pt)与底部 Dock(~96pt)的安全边距，
        // 避免窗口底部沉到 Dock 后面、最后几条看不到。
        let reserve_top = (28.0 * scale) as i32;
        let reserve_bottom = (96.0 * scale) as i32;
        let top = p.y + reserve_top;
        let max_x = (p.x + s.width as i32 - win_size.width as i32).max(p.x);
        let max_y =
            (p.y + s.height as i32 - reserve_bottom - win_size.height as i32).max(top);
        x = x.clamp(p.x, max_x);
        y = y.clamp(top, max_y);
    }
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 切换 "main" 窗口显隐；显示走统一 show 路径。
fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                show_main_window(app);
            }
        }
    }
}

/// 后台轮询读取剪贴板，发现新内容则记录。
fn poll_clipboard_once(app: &AppHandle, state: &AppState) {
    // 忽略密码/敏感内容：命中且设置开启则跳过本轮。
    let ignore_concealed = state
        .0
        .lock()
        .map(|i| i.settings.ignore_concealed)
        .unwrap_or(true);
    if ignore_concealed && clipboard::is_concealed() {
        return;
    }

    let Some(read) = clipboard::read_clipboard() else {
        return;
    };
    match read {
        ClipRead::Text(t) => record_text(app, state, t),
        ClipRead::Files(f) => record_files(app, state, f),
        ClipRead::Image(png) => record_image(app, state, png),
    }
}

fn record_text(app: &AppHandle, state: &AppState, text: String) {
    let sig = format!("t:{text}");
    // 快速去重：内容未变（或锁不可用）则直接跳过，避免每轮都去查前台 App。
    if state
        .0
        .lock()
        .map(|i| i.last_sig.as_deref() == Some(sig.as_str()))
        .unwrap_or(true)
    {
        return;
    }
    // 在主状态锁之外捕获来源 App（含图标，按 bundleId 缓存；自身/失败为 None）。
    let (src_app, src_icon) = source_app::capture_source(&state.1);

    let (snapshot, removed, icons_snapshot) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        // 双重检查（轮询为单线程，稳妥起见）。
        if inner.last_sig.as_deref() == Some(sig.as_str()) {
            return;
        }
        inner.last_sig = Some(sig);

        // 图标只进映射，不内嵌到 ClipItem（去重）。
        let icons_changed = register_icon_locked(&mut inner, &src_app, &src_icon);

        if let Some(pos) = inner
            .history
            .iter()
            .position(|it| it.kind == "text" && it.text.as_deref() == Some(text.as_str()))
        {
            let mut item = inner.history.remove(pos);
            item.timestamp = now_millis();
            // 重新复制：更新来源键（仅当本次捕获成功，避免抹掉旧来源）。
            if src_app.is_some() {
                item.source_app = src_app;
                item.source_icon = None;
            }
            inner.history.insert(0, item);
        } else {
            let id = inner.next_id;
            inner.next_id += 1;
            inner.history.insert(
                0,
                ClipItem {
                    id,
                    kind: "text".into(),
                    text: Some(text),
                    files: None,
                    thumbnail: None,
                    image_path: None,
                    timestamp: now_millis(),
                    pinned: false,
                    source_app: src_app,
                    source_icon: None,
                    hash: None,
                },
            );
        }
        let removed = sort_and_truncate_locked(&mut inner);
        let icons_snapshot = if icons_changed {
            Some(inner.icons.clone())
        } else {
            None
        };
        (inner.history.clone(), removed, icons_snapshot)
    };
    commit(app, &snapshot, &removed);
    if let Some(icons) = icons_snapshot {
        commit_icons(app, &icons);
    }
}

fn record_files(app: &AppHandle, state: &AppState, files: Vec<String>) {
    let sig = format!("f:{}", files.join("\u{0}"));
    // 快速去重：内容未变（或锁不可用）则跳过，避免每轮都去查前台 App。
    if state
        .0
        .lock()
        .map(|i| i.last_sig.as_deref() == Some(sig.as_str()))
        .unwrap_or(true)
    {
        return;
    }
    let (src_app, src_icon) = source_app::capture_source(&state.1);

    let (snapshot, removed, icons_snapshot) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        if inner.last_sig.as_deref() == Some(sig.as_str()) {
            return;
        }
        inner.last_sig = Some(sig);

        // 图标只进映射，不内嵌到 ClipItem（去重）。
        let icons_changed = register_icon_locked(&mut inner, &src_app, &src_icon);

        if let Some(pos) = inner
            .history
            .iter()
            .position(|it| it.kind == "files" && it.files.as_ref() == Some(&files))
        {
            let mut item = inner.history.remove(pos);
            item.timestamp = now_millis();
            if src_app.is_some() {
                item.source_app = src_app;
                item.source_icon = None;
            }
            inner.history.insert(0, item);
        } else {
            let id = inner.next_id;
            inner.next_id += 1;
            inner.history.insert(
                0,
                ClipItem {
                    id,
                    kind: "files".into(),
                    text: None,
                    files: Some(files),
                    thumbnail: None,
                    image_path: None,
                    timestamp: now_millis(),
                    pinned: false,
                    source_app: src_app,
                    source_icon: None,
                    hash: None,
                },
            );
        }
        let removed = sort_and_truncate_locked(&mut inner);
        let icons_snapshot = if icons_changed {
            Some(inner.icons.clone())
        } else {
            None
        };
        (inner.history.clone(), removed, icons_snapshot)
    };
    commit(app, &snapshot, &removed);
    if let Some(icons) = icons_snapshot {
        commit_icons(app, &icons);
    }
}

fn record_image(app: &AppHandle, state: &AppState, png: Vec<u8>) {
    // 解码、计算稳定哈希与缩略图（在锁外做较重的处理）。
    let Some((hash, thumbnail)) = clipboard::process_image(&png) else {
        return;
    };
    let sig = format!("i:{hash}");

    // 快速去重：内容未变（或锁不可用）则跳过，避免每轮都去查前台 App。
    if state
        .0
        .lock()
        .map(|i| i.last_sig.as_deref() == Some(sig.as_str()))
        .unwrap_or(true)
    {
        return;
    }
    let (src_app, src_icon) = source_app::capture_source(&state.1);

    let (snapshot, removed, icons_snapshot) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        if inner.last_sig.as_deref() == Some(sig.as_str()) {
            return;
        }
        inner.last_sig = Some(sig);

        // 图标只进映射，不内嵌到 ClipItem（去重）。
        let icons_changed = register_icon_locked(&mut inner, &src_app, &src_icon);

        if let Some(pos) = inner
            .history
            .iter()
            .position(|it| it.kind == "image" && it.hash == Some(hash))
        {
            let mut item = inner.history.remove(pos);
            item.timestamp = now_millis();
            if src_app.is_some() {
                item.source_app = src_app;
                item.source_icon = None;
            }
            inner.history.insert(0, item);
        } else {
            let id = inner.next_id;
            inner.next_id += 1;
            let image_path = clipboard::save_image_png(app, id, &png);
            inner.history.insert(
                0,
                ClipItem {
                    id,
                    kind: "image".into(),
                    text: None,
                    files: None,
                    thumbnail: Some(thumbnail),
                    image_path,
                    timestamp: now_millis(),
                    pinned: false,
                    source_app: src_app,
                    source_icon: None,
                    hash: Some(hash),
                },
            );
        }
        let removed = sort_and_truncate_locked(&mut inner);
        let icons_snapshot = if icons_changed {
            Some(inner.icons.clone())
        } else {
            None
        };
        (inner.history.clone(), removed, icons_snapshot)
    };
    commit(app, &snapshot, &removed);
    if let Some(icons) = icons_snapshot {
        commit_icons(app, &icons);
    }
}

/// 打开（或聚焦）独立的设置窗口。
#[tauri::command]
fn open_settings(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.center();
        let _ = win.set_focus();
    }
}

// ===================== 入口 =====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| match event {
            // 关闭窗口 → 阻止默认、改为隐藏（不退出 App）。main 与 settings 都只隐藏。
            WindowEvent::CloseRequested { api, .. } => {
                let label = window.label();
                if label == "main" || label == "settings" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // 失焦 → 若 autoHideOnBlur 为真则隐藏。
            WindowEvent::Focused(false) => {
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        let hide = state
                            .0
                            .lock()
                            .map(|i| i.settings.auto_hide_on_blur)
                            .unwrap_or(false);
                        if hide {
                            let _ = window.hide();
                        }
                    }
                }
            }
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // macOS：去 Dock 图标，仅菜单栏托盘。
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // 加载设置与历史。
            let mut app_settings = settings::load_settings(&handle);
            app_settings.history_size = clamp_history_size(app_settings.history_size);
            app_settings.window_height = clamp_window_height(app_settings.window_height);
            app_settings.image_thumb_height = clamp_image_thumb_height(app_settings.image_thumb_height);
            let win_height = app_settings.window_height;
            let mut history = load_history(&handle);
            let (mut fav_groups, fav_legacy) = load_fav_groups(&handle);

            // 来源图标映射：先读独立的 icons.json，再迁移旧 history.json 内嵌的
            // sourceIcon（老格式逐条内嵌）进映射，随后清空各条内嵌图标。
            // 这样旧数据无缝升级到「图标单独存一份」的去重布局，且不再回写内嵌图标。
            let mut icons = load_icons(&handle);
            let mut migrated = false;
            for item in history.iter_mut() {
                if let (Some(name), Some(icon)) = (item.source_app.as_ref(), item.source_icon.take())
                {
                    icons.entry(name.clone()).or_insert(icon);
                    migrated = true;
                }
            }
            if migrated {
                save_icons(&handle, &icons);
            }

            // next_id 取 历史 + 所有分组 id + 分组内所有项 id 的最大值 + 1。
            let mut max_id = history.iter().map(|it| it.id).max().unwrap_or(0);
            let mut any_id = !history.is_empty();
            for g in &fav_groups {
                if !fav_legacy {
                    max_id = max_id.max(g.id);
                    any_id = true;
                }
                for it in &g.items {
                    max_id = max_id.max(it.id);
                    any_id = true;
                }
            }
            let mut next_id = if any_id { max_id + 1 } else { 0 };
            // 旧扁平格式迁移来的分组用占位 id（0），在此统一分配真实唯一 id。
            if fav_legacy {
                for g in fav_groups.iter_mut() {
                    g.id = next_id;
                    next_id += 1;
                }
            }
            // 始终保证至少 1 个分组（含磁盘上存了空数组 [] 的情况）。
            if fav_groups.is_empty() {
                fav_groups.push(FavGroup {
                    id: next_id,
                    name: "默认".to_string(),
                    items: Vec::new(),
                });
                next_id += 1;
            }

            // 注册全局快捷键（来自设置；解析失败则回退默认）。
            let shortcut_ok = app_settings
                .shortcut
                .parse::<Shortcut>()
                .ok()
                .and_then(|s| app.global_shortcut().register(s).ok())
                .is_some();
            if !shortcut_ok {
                if let Ok(s) = "CmdOrCtrl+Shift+V".parse::<Shortcut>() {
                    let _ = app.global_shortcut().register(s);
                }
            }

            // 注册备用快捷键（可选；为空则跳过）。
            if !app_settings.shortcut2.trim().is_empty() {
                if let Ok(s) = app_settings.shortcut2.parse::<Shortcut>() {
                    let _ = app.global_shortcut().register(s);
                }
            }

            // 同步开机自启状态到设置。
            {
                let mgr = app.autolaunch();
                if app_settings.autostart {
                    let _ = mgr.enable();
                } else {
                    let _ = mgr.disable();
                }
            }

            app.manage(AppState(
                Mutex::new(Inner {
                    history,
                    fav_groups,
                    last_sig: None,
                    next_id,
                    settings: app_settings,
                    icons,
                    prev_app_pid: None,
                }),
                source_app::IconCache::new(),
            ));

            // 应用设置中的主窗口高度（覆盖 tauri.conf 默认值）。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_size(tauri::LogicalSize::new(WIN_WIDTH, win_height as f64));
            }

            // macOS：给 main 窗口加毛玻璃（半透明、跟随系统外观）+ 圆角，
            // 配合 transparent:true / decorations:false 形成 Maccy 风格无边框毛玻璃窗。
            // 容错：失败不影响其余功能。
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                if let Some(win) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(
                        &win,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::Active),
                        Some(12.0),
                    );
                }
            }

            // Windows：给 main 窗口加亚克力磨砂背景（配合 transparent:true），
            // 让透明窗口呈现类似 macOS 毛玻璃的半透明效果；失败不影响其余功能。
            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::apply_acrylic;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = apply_acrylic(&win, Some((18, 18, 18, 125)));
                }
            }

            // 托盘菜单与图标。
            let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // 启动时按当前规则重排+截断一次（兼容旧数据/上限变小），再广播初始数据。
            if let Some(state) = app.try_state::<AppState>() {
                let (snapshot, removed) = {
                    if let Ok(mut inner) = state.0.lock() {
                        let removed = sort_and_truncate_locked(&mut inner);
                        (inner.history.clone(), removed)
                    } else {
                        (Vec::new(), Vec::new())
                    }
                };
                for p in &removed {
                    let _ = std::fs::remove_file(p);
                }
                save_history(&handle, &snapshot);
                let _ = handle.emit("history-updated", &snapshot);
            }

            // 后台剪贴板监听线程。
            let bg_handle = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(700));
                if let Some(state) = bg_handle.try_state::<AppState>() {
                    poll_clipboard_once(&bg_handle, &state);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            get_icons,
            copy_item,
            paste_item,
            toggle_pin,
            delete_item,
            clear_history,
            hide_window,
            get_favorites,
            add_favorite,
            remove_favorite,
            paste_favorite,
            add_group,
            rename_group,
            delete_group,
            get_settings,
            set_settings,
            open_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
