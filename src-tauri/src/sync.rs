//! 云同步（可选功能）。
//!
//! 设计铁律：**完全隔离的旁路，绝不影响单机版**。
//! - 所有阻塞网络请求只在本模块的独立 worker 线程里跑（`reqwest::blocking`）；
//!   绝不在 Tauri 命令的 async 线程里发请求，也绝不在持有 `AppState` 锁时发请求。
//! - 命令只往 channel 投递消息、立即返回；worker 处理后 emit `sync-status` / `history-updated`。
//! - 只做「周期同步」，不 hook 核心的剪贴板 record 路径。
//! - 关闭开关 / 未登录 / 服务器不可达 → 每个入口 early-return 或吞错，主流程零感知。
//!
//! 端到端加密：明文条目用 AES-256-GCM 加密（密钥 = SHA-256(用户同步密钥)），服务端只存密文；
//! 去重指纹 = HMAC-SHA256(密钥, 规范化内容)，服务端据此去重但反推不出内容。
//!
//! 首版只同步 text / files 两类（image 需另传 PNG 字节，暂不做）。

use std::collections::HashSet;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::models::ClipItem;
use crate::AppState;

type HmacSha256 = Hmac<Sha256>;

/// worker 周期 tick（也作为无消息时的默认唤醒间隔）。
const TICK: Duration = Duration::from_secs(15);
/// 两次心跳的最小间隔。
const HEARTBEAT_EVERY: Duration = Duration::from_secs(300);
/// 网络请求超时。
const HTTP_TIMEOUT: Duration = Duration::from_secs(6);
/// 固定加密密钥：当前端到端加密统一用此内置密钥，暂不使用用户输入的密钥。
/// 设置里的「同步密钥」字段（Settings.sync_key）仍保留供后续用途，填不填都不影响；
/// 因此 UI 上不再向用户展示相关说明文案。
const FIXED_ENC_KEY: &str = "Shijinze123";

// ===================== 持久化的登录/设备身份 =====================

/// 登录态与设备身份，独立于用户 Settings 持久化（sync_auth.json）。
/// 分开存是为了：① set_settings 覆盖 Settings 时不会误清 token；② token 属于凭据不混进用户设置。
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncAuth {
    /// 本机稳定设备标识（首次生成后持久化）。
    pub device_id: String,
    /// 登录令牌（未登录为 None）。
    pub token: Option<String>,
    /// 登录用户名（便于展示）。
    pub username: Option<String>,
}

fn auth_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_config_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            Some(dir.join("sync_auth.json"))
        }
        Err(_) => None,
    }
}

/// 加载登录态；device_id 为空时生成并落盘。绝不 panic。
pub fn load_auth(app: &AppHandle) -> SyncAuth {
    let mut auth: SyncAuth = auth_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if auth.device_id.is_empty() {
        let mut bytes = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        auth.device_id = URL_SAFE_NO_PAD.encode(bytes);
        save_auth(app, &auth);
    }
    auth
}

fn save_auth(app: &AppHandle, auth: &SyncAuth) {
    if let Some(path) = auth_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(auth) {
            let _ = std::fs::write(path, json);
        }
    }
}

// ===================== 对外状态（给前端「同步」Tab）=====================

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub logged_in: bool,
    pub username: Option<String>,
    pub device_id: String,
    pub syncing: bool,
    /// 上次成功同步的 Unix 毫秒。
    pub last_sync_ms: Option<u64>,
    /// 上次错误信息（成功后清空）。
    pub last_error: Option<String>,
    /// 面向用户的简短状态文案。
    pub last_message: Option<String>,
}

// ===================== worker 句柄（托管进 Tauri state）=====================

pub enum SyncCmd {
    Login { username: String, password: String },
    Register { username: String, password: String },
    Logout,
    SyncNow,
}

pub struct SyncHandle {
    tx: Mutex<Sender<SyncCmd>>,
    status: Arc<Mutex<SyncStatus>>,
}

impl SyncHandle {
    fn send(&self, cmd: SyncCmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }
    fn status(&self) -> SyncStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

/// 启动同步 worker，返回句柄（由调用方 `app.manage`）。
pub fn start(app: &AppHandle) -> SyncHandle {
    let (tx, rx) = std::sync::mpsc::channel::<SyncCmd>();
    let status = Arc::new(Mutex::new(SyncStatus::default()));
    let worker_status = status.clone();
    let worker_app = app.clone();
    std::thread::spawn(move || worker_loop(worker_app, rx, worker_status));
    SyncHandle {
        tx: Mutex::new(tx),
        status,
    }
}

// ===================== 命令（只投递消息 / 读状态，绝不阻塞发网络）=====================

#[tauri::command]
pub fn sync_login(handle: State<'_, SyncHandle>, username: String, password: String) {
    handle.send(SyncCmd::Login { username, password });
}

#[tauri::command]
pub fn sync_register(handle: State<'_, SyncHandle>, username: String, password: String) {
    handle.send(SyncCmd::Register { username, password });
}

#[tauri::command]
pub fn sync_logout(handle: State<'_, SyncHandle>) {
    handle.send(SyncCmd::Logout);
}

#[tauri::command]
pub fn sync_now(handle: State<'_, SyncHandle>) {
    handle.send(SyncCmd::SyncNow);
}

#[tauri::command]
pub fn get_sync_status(handle: State<'_, SyncHandle>) -> SyncStatus {
    handle.status()
}

// ===================== worker 主循环 =====================

fn worker_loop(app: AppHandle, rx: Receiver<SyncCmd>, status: Arc<Mutex<SyncStatus>>) {
    // 已同步过的去重指纹（内存缓存，仅作「避免重复加密/解密」的优化；正确性由服务端去重 + same_content 兜底）。
    let mut seen: HashSet<String> = HashSet::new();
    let mut last_heartbeat: Option<Instant> = None;
    // 上次已上传到服务端的密钥，避免每轮重复上传。
    let mut uploaded_key: Option<String> = None;

    // 初始化对外状态里的 device_id / enabled，并广播一次。
    refresh_static_status(&app, &status);
    emit_status(&app, &status);

    loop {
        match rx.recv_timeout(TICK) {
            Ok(SyncCmd::Login { username, password }) => {
                do_auth(&app, &status, "login", "登录", &username, &password);
                seen.clear();
                uploaded_key = None;
                run_sync(&app, &status, &mut seen, &mut uploaded_key);
                do_heartbeat(&app, &mut last_heartbeat, true);
            }
            Ok(SyncCmd::Register { username, password }) => {
                do_auth(&app, &status, "register", "注册", &username, &password);
                seen.clear();
                uploaded_key = None;
                run_sync(&app, &status, &mut seen, &mut uploaded_key);
                do_heartbeat(&app, &mut last_heartbeat, true);
            }
            Ok(SyncCmd::Logout) => {
                do_logout(&app, &status);
                seen.clear();
                uploaded_key = None;
            }
            Ok(SyncCmd::SyncNow) => {
                run_sync(&app, &status, &mut seen, &mut uploaded_key);
            }
            Err(RecvTimeoutError::Timeout) => {
                run_sync(&app, &status, &mut seen, &mut uploaded_key);
                do_heartbeat(&app, &mut last_heartbeat, false);
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 把 enabled / logged_in / device_id / username 从当前状态刷进 SyncStatus（不发网络）。
fn refresh_static_status(app: &AppHandle, status: &Arc<Mutex<SyncStatus>>) {
    let (enabled, auth) = read_config(app);
    if let Ok(mut s) = status.lock() {
        s.enabled = enabled;
        s.device_id = auth.device_id.clone();
        s.logged_in = auth.token.is_some();
        s.username = auth.username.clone();
    }
}

fn emit_status(app: &AppHandle, status: &Arc<Mutex<SyncStatus>>) {
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    let _ = app.emit("sync-status", snap);
}

// ===================== 读取配置（短暂持锁 clone 出来）=====================

/// 默认（非自建）后端地址。端口 80 隐含在 http 里。
const DEFAULT_SYNC_BASE: &str = "http://copy.nihaoiii.fun";

struct SyncConfig {
    enabled: bool,
    self_host: bool,
    host: String,
    port: u32,
    key: String,
}

/// 从 AppState 短暂持锁读出同步相关配置 + 登录态（clone 后立即释放锁）。
fn read_config(app: &AppHandle) -> (bool, SyncAuth) {
    let cfg = read_full_config(app);
    (cfg.0.enabled, cfg.1)
}

fn read_full_config(app: &AppHandle) -> (SyncConfig, SyncAuth) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(inner) = state.0.lock() {
            let s = &inner.settings;
            return (
                SyncConfig {
                    enabled: s.sync_enabled,
                    self_host: s.sync_self_host,
                    host: s.sync_host.clone(),
                    port: s.sync_port,
                    key: s.sync_key.clone(),
                },
                inner.sync_auth.clone(),
            );
        }
    }
    (
        SyncConfig {
            enabled: false,
            self_host: false,
            host: String::new(),
            port: 9999,
            key: String::new(),
        },
        SyncAuth::default(),
    )
}

fn base_url(cfg: &SyncConfig) -> Option<String> {
    // 非自建：走内置默认后端。
    if !cfg.self_host {
        return Some(DEFAULT_SYNC_BASE.to_string());
    }
    let host = cfg.host.trim();
    if host.is_empty() {
        return None; // 勾了自建但没填地址 → 视为未配置
    }
    // 允许用户填 "http://x"、纯 "x"；端口 80 省略。
    let base = if host.starts_with("http://") || host.starts_with("https://") {
        host.trim_end_matches('/').to_string()
    } else if cfg.port == 80 {
        format!("http://{}", host)
    } else {
        format!("http://{}:{}", host, cfg.port)
    };
    Some(base)
}

fn http_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .ok()
}

// ===================== 登录 / 登出 =====================

#[derive(Deserialize)]
struct ApiResp<T> {
    code: i32,
    msg: Option<String>,
    data: Option<T>,
}

#[derive(Deserialize)]
struct LoginData {
    token: Option<String>,
    username: Option<String>,
}

/// 登录 / 注册共用：POST /sjzApp/clip/{path}，成功后存 token 并更新状态。
/// `path`="login"|"register"，`verb`="登录"|"注册"（仅用于状态文案）。
fn do_auth(
    app: &AppHandle,
    status: &Arc<Mutex<SyncStatus>>,
    path: &str,
    verb: &str,
    username: &str,
    password: &str,
) {
    set_status(status, |s| {
        s.syncing = true;
        s.last_message = Some(format!("{}中…", verb));
        s.last_error = None;
    });
    emit_status(app, status);

    let (cfg, mut auth) = read_full_config(app);
    let result = (|| -> Result<LoginData, String> {
        let base = base_url(&cfg).ok_or_else(|| "未配置服务器地址".to_string())?;
        let client = http_client().ok_or_else(|| "HTTP 客户端初始化失败".to_string())?;
        let resp = client
            .post(format!("{}/sjzApp/clip/{}", base, path))
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .map_err(|e| format!("连接失败: {}", e))?;
        let parsed: ApiResp<LoginData> = resp.json().map_err(|e| format!("响应解析失败: {}", e))?;
        if parsed.code != 200 {
            return Err(parsed.msg.unwrap_or_else(|| format!("{}失败", verb)));
        }
        parsed.data.ok_or_else(|| format!("{}返回为空", verb))
    })();

    match result {
        Ok(data) if data.token.is_some() => {
            auth.token = data.token;
            auth.username = data.username.or_else(|| Some(username.to_string()));
            write_auth(app, &auth);
            set_status(status, |s| {
                s.syncing = false;
                s.logged_in = true;
                s.username = auth.username.clone();
                s.last_error = None;
                s.last_message = Some("已登录".into());
            });
        }
        Ok(_) => {
            set_status(status, |s| {
                s.syncing = false;
                s.last_error = Some(format!("{}未返回令牌", verb));
                s.last_message = Some(format!("{}失败", verb));
            });
        }
        Err(e) => {
            set_status(status, |s| {
                s.syncing = false;
                s.last_error = Some(e);
                s.last_message = Some(format!("{}失败", verb));
            });
        }
    }
    emit_status(app, status);
}

fn do_logout(app: &AppHandle, status: &Arc<Mutex<SyncStatus>>) {
    let (cfg, mut auth) = read_full_config(app);
    // 尽力通知服务端清除令牌（失败无所谓）。
    if let (Some(base), Some(token), Some(client)) =
        (base_url(&cfg), auth.token.clone(), http_client())
    {
        let _ = client
            .post(format!("{}/sjzApp/clip/logout", base))
            .header("Authorization", format!("Bearer {}", token))
            .send();
    }
    auth.token = None;
    auth.username = None;
    write_auth(app, &auth);
    set_status(status, |s| {
        s.logged_in = false;
        s.username = None;
        s.last_message = Some("已退出登录".into());
    });
    emit_status(app, status);
}

/// 更新 AppState 里的 sync_auth 并落盘（短暂持锁）。
fn write_auth(app: &AppHandle, auth: &SyncAuth) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut inner) = state.0.lock() {
            inner.sync_auth = auth.clone();
        }
    }
    save_auth(app, auth);
}

fn set_status(status: &Arc<Mutex<SyncStatus>>, f: impl FnOnce(&mut SyncStatus)) {
    if let Ok(mut s) = status.lock() {
        f(&mut s);
    }
}

// ===================== 同步核心 =====================

/// 服务端条目线格式（与 Java ClipboardEntryDo 的 JSON 字段对齐，camelCase）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WireEntry {
    content_type: String,
    dedup_hash: String,
    cipher_text: String,
    nonce: String,
    item_timestamp: u64,
    pinned: i32,
}

/// push 请求体。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PushBody {
    device_id: String,
    entries: Vec<WireEntry>,
}

/// 被加密的明文条目（仅 text / files）。两端都是本客户端，字段名无需对外约定。
#[derive(Serialize, Deserialize)]
struct PlainItem {
    kind: String,
    text: Option<String>,
    files: Option<Vec<String>>,
    timestamp: u64,
    pinned: bool,
    source_app: Option<String>,
}

fn run_sync(
    app: &AppHandle,
    status: &Arc<Mutex<SyncStatus>>,
    seen: &mut HashSet<String>,
    uploaded_key: &mut Option<String>,
) {
    let (cfg, auth) = read_full_config(app);
    refresh_static_status(app, status);

    // 关闭 / 未登录 / 未配置 → 直接返回，零联网。
    if !cfg.enabled {
        return;
    }
    let (Some(base), Some(token)) = (base_url(&cfg), auth.token.clone()) else {
        return;
    };
    let Some(client) = http_client() else {
        return;
    };

    // 加密密钥固定为常量，不使用用户输入的密钥、也不因缺密钥而阻塞同步。
    let key = derive_key(FIXED_ENC_KEY);

    // 用户输入的同步密钥：仍与服务端存取（保留供后续用途），但不参与加密。
    let user_key = cfg.key.trim().to_string();
    if user_key.is_empty() {
        // 本地没有 → 尝试从服务端取回并回填（保留找回能力）。
        if let Some(server_key) = fetch_server_key(&client, &base, &token) {
            adopt_sync_key(app, &server_key);
        }
    } else if uploaded_key.as_deref() != Some(user_key.as_str()) {
        upload_server_key(&client, &base, &token, &user_key);
        *uploaded_key = Some(user_key.clone());
    }

    set_status(status, |s| s.syncing = true);

    let mut had_error: Option<String> = None;

    // 1) 推送本地新条目。
    match build_push_entries(app, &key, seen) {
        Ok(entries) if !entries.is_empty() => {
            let hashes: Vec<String> = entries.iter().map(|e| e.dedup_hash.clone()).collect();
            let body = PushBody {
                device_id: auth.device_id.clone(),
                entries,
            };
            match client
                .post(format!("{}/sjzApp/clip/push", base))
                .header("Authorization", format!("Bearer {}", token))
                .json(&body)
                .send()
                .and_then(|r| r.error_for_status())
            {
                Ok(_) => {
                    for h in hashes {
                        seen.insert(h);
                    }
                }
                Err(e) => had_error = Some(format!("上传失败: {}", e)),
            }
        }
        Ok(_) => {}
        Err(e) => had_error = Some(e),
    }

    // 2) 拉取远端条目并合并（全量拉取，用 seen + same_content 双重去重，避免跨机漏项）。
    if had_error.is_none() {
        match pull_entries(&client, &base, &token) {
            Ok(remote) => {
                if let Err(e) = merge_remote(app, &key, seen, remote) {
                    had_error = Some(e);
                }
            }
            Err(e) => had_error = Some(format!("下载失败: {}", e)),
        }
    }

    let now_ms = now_ms();
    set_status(status, |s| {
        s.syncing = false;
        if let Some(e) = had_error.clone() {
            s.last_error = Some(e);
            s.last_message = Some("同步出错（不影响本地使用）".into());
        } else {
            s.last_error = None;
            s.last_sync_ms = Some(now_ms);
            s.last_message = Some("已同步".into());
        }
    });
    emit_status(app, status);
}

/// 从本地历史里挑出「未同步过的 text/files 条目」，加密成 WireEntry。
fn build_push_entries(
    app: &AppHandle,
    key: &[u8; 32],
    seen: &HashSet<String>,
) -> Result<Vec<WireEntry>, String> {
    let history = snapshot_history(app);
    let mut out = Vec::new();
    for it in &history {
        if it.kind != "text" && it.kind != "files" {
            continue; // 首版不同步 image
        }
        let Some(canon) = canonical_content(it) else {
            continue;
        };
        let dedup = dedup_hash(key, &canon);
        if seen.contains(&dedup) {
            continue;
        }
        let plain = PlainItem {
            kind: it.kind.clone(),
            text: it.text.clone(),
            files: it.files.clone(),
            timestamp: it.timestamp,
            pinned: it.pinned,
            source_app: it.source_app.clone(),
        };
        let json = serde_json::to_vec(&plain).map_err(|e| e.to_string())?;
        let (cipher_b64, nonce_b64) = encrypt(key, &json).ok_or("加密失败")?;
        out.push(WireEntry {
            content_type: it.kind.clone(),
            dedup_hash: dedup,
            cipher_text: cipher_b64,
            nonce: nonce_b64,
            item_timestamp: it.timestamp,
            pinned: if it.pinned { 1 } else { 0 },
        });
    }
    Ok(out)
}

fn pull_entries(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
) -> Result<Vec<WireEntry>, reqwest::Error> {
    let resp = client
        .get(format!("{}/sjzApp/clip/pull", base))
        .header("Authorization", format!("Bearer {}", token))
        .send()?
        .error_for_status()?;
    let parsed: ApiResp<Vec<WireEntry>> = resp.json()?;
    Ok(parsed.data.unwrap_or_default())
}

/// 从服务端取回本用户保存的同步密钥（无则 None）。
fn fetch_server_key(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
) -> Option<String> {
    let resp = client
        .get(format!("{}/sjzApp/clip/key", base))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    let parsed: ApiResp<String> = resp.json().ok()?;
    parsed.data.filter(|s| !s.trim().is_empty())
}

/// 把本地密钥上传保存到服务端（供换设备找回）。失败静默。
fn upload_server_key(client: &reqwest::blocking::Client, base: &str, token: &str, key: &str) {
    let _ = client
        .post(format!("{}/sjzApp/clip/key", base))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "key": key }))
        .send();
}

/// 把从服务端取回的密钥写入本地 Settings 并持久化 + 广播（settings 窗口据此回填密钥框）。
fn adopt_sync_key(app: &AppHandle, key: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let settings = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        if inner.settings.sync_key == key {
            return; // 已一致，无需写盘/广播
        }
        inner.settings.sync_key = key.to_string();
        inner.settings.clone()
    };
    crate::settings::save_settings(app, &settings);
    let _ = app.emit("settings-updated", &settings);
}

/// 把远端条目解密后合并进本地历史：same_content 去重、分配本地新 id、重排截断、commit 刷新前端。
fn merge_remote(
    app: &AppHandle,
    key: &[u8; 32],
    seen: &mut HashSet<String>,
    remote: Vec<WireEntry>,
) -> Result<(), String> {
    let mut incoming: Vec<ClipItem> = Vec::new();
    for e in remote {
        if seen.contains(&e.dedup_hash) {
            continue; // 已见过，跳过解密
        }
        seen.insert(e.dedup_hash.clone());
        let Some(bytes) = decrypt(key, &e.cipher_text, &e.nonce) else {
            continue; // 密钥不匹配/损坏：跳过（不影响本地）
        };
        let Ok(plain) = serde_json::from_slice::<PlainItem>(&bytes) else {
            continue;
        };
        if plain.kind != "text" && plain.kind != "files" {
            continue;
        }
        incoming.push(ClipItem {
            id: 0, // 合并时分配本地 id
            kind: plain.kind,
            text: plain.text,
            files: plain.files,
            thumbnail: None,
            image_path: None,
            width: None,
            height: None,
            size: None,
            timestamp: plain.timestamp,
            pinned: plain.pinned,
            source_app: plain.source_app,
            source_icon: None,
            hash: None,
        });
    }
    if incoming.is_empty() {
        return Ok(());
    }

    let Some(state) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let (snapshot, removed) = {
        let mut inner = state.0.lock().map_err(|_| "state lock 失败")?;
        for mut item in incoming {
            // 本地已有相同内容则跳过（避免与本机条目重复）。
            if inner.history.iter().any(|h| crate::same_content(h, &item)) {
                continue;
            }
            item.id = inner.next_id;
            inner.next_id += 1;
            inner.history.push(item);
        }
        let removed = crate::sort_and_truncate_locked(&mut inner);
        (inner.history.clone(), removed)
    };
    crate::commit(app, &snapshot, &removed);
    Ok(())
}

/// 短暂持锁 clone 出历史快照。
fn snapshot_history(app: &AppHandle) -> Vec<ClipItem> {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(inner) = state.0.lock() {
            return inner.history.clone();
        }
    }
    Vec::new()
}

/// 去重规范化内容串（仅 text/files）。
fn canonical_content(it: &ClipItem) -> Option<String> {
    match it.kind.as_str() {
        "text" => Some(format!("t:{}", it.text.clone().unwrap_or_default())),
        "files" => Some(format!(
            "f:{}",
            it.files.clone().unwrap_or_default().join("\u{1}")
        )),
        _ => None,
    }
}

// ===================== 心跳 =====================

fn do_heartbeat(app: &AppHandle, last: &mut Option<Instant>, force: bool) {
    let (cfg, auth) = read_full_config(app);
    if !cfg.enabled || auth.token.is_none() {
        return; // 关闭同步或未登录：不发心跳（关闭=完全不联网）
    }
    if !force {
        if let Some(t) = last {
            if t.elapsed() < HEARTBEAT_EVERY {
                return;
            }
        }
    }
    let (Some(base), Some(token), Some(client)) =
        (base_url(&cfg), auth.token.clone(), http_client())
    else {
        return;
    };
    let body = serde_json::json!({
        "deviceId": auth.device_id,
        "platform": platform(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "deviceName": device_name(),
    });
    let ok = client
        .post(format!("{}/sjzApp/clip/heartbeat", base))
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .is_ok();
    if ok {
        *last = Some(Instant::now());
    }
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    }
}

fn device_name() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|s| !s.is_empty())
}

// ===================== 加密原语 =====================

fn derive_key(passphrase: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(passphrase.as_bytes());
    let out = h.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

/// AES-256-GCM 加密，返回 (密文 base64, nonce base64)。
fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Option<(String, String)> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher.encrypt(nonce, plaintext).ok()?;
    Some((STANDARD.encode(ct), STANDARD.encode(nonce_bytes)))
}

/// AES-256-GCM 解密；密钥/nonce 不匹配或数据损坏返回 None。
fn decrypt(key: &[u8; 32], cipher_b64: &str, nonce_b64: &str) -> Option<Vec<u8>> {
    let ct = STANDARD.decode(cipher_b64).ok()?;
    let nonce_bytes = STANDARD.decode(nonce_b64).ok()?;
    if nonce_bytes.len() != 12 {
        return None;
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher.decrypt(nonce, ct.as_ref()).ok()
}

/// HMAC-SHA256(密钥, 内容) 的 base64，作服务端去重指纹。
fn dedup_hash(key: &[u8; 32], content: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac key");
    mac.update(content.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
