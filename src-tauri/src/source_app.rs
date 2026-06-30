//! 来源 App 捕获：读取复制时所在的前台应用名称与图标。
//!
//! macOS 上通过 `NSWorkspace::frontmostApplication()` 取得 `NSRunningApplication`，
//! 读取本地化名称、bundleIdentifier 与图标（NSImage），并把图标转成 ~32px 的
//! base64 PNG data URL。图标转换较重，故按 bundleIdentifier 缓存，同一应用只算一次。
//!
//! 任何一步失败都返回 `(None, None)`，绝不 panic；前台是应用自身时也返回 None。

use std::collections::HashMap;
use std::sync::Mutex;

/// 应用自身 bundle id：前台为自己时不作为来源（避免把剪贴板窗口当来源 App）。
const SELF_BUNDLE_ID: &str = "com.shijinze.clipboard-manager";

/// 来源图标缓存：bundleId -> base64 PNG data URL（仅缓存成功结果）。
///
/// 内部自带 `Mutex`，与主状态锁解耦：图标转换在主状态锁之外进行，
/// 命中缓存时只做一次只读查表。
pub struct IconCache {
    inner: Mutex<HashMap<String, String>>,
}

impl IconCache {
    pub fn new() -> Self {
        IconCache {
            inner: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(target_os = "macos")]
    fn get(&self, bundle_id: &str) -> Option<String> {
        self.inner.lock().ok()?.get(bundle_id).cloned()
    }

    #[cfg(target_os = "macos")]
    fn put(&self, bundle_id: String, data_url: String) {
        if let Ok(mut m) = self.inner.lock() {
            m.insert(bundle_id, data_url);
        }
    }
}

impl Default for IconCache {
    fn default() -> Self {
        Self::new()
    }
}

/// 捕获当前前台应用作为来源：返回 `(本地化名称, 图标 data URL)`。
///
/// 前台为应用自身、取不到前台应用、或转换失败时返回 `(None, None)`。
#[cfg(target_os = "macos")]
pub fn capture_source(cache: &IconCache) -> (Option<String>, Option<String>) {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;

    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let Some(app) = workspace.frontmostApplication() else {
            return (None, None);
        };

        let bundle_id: Option<String> = app.bundleIdentifier().map(|s| s.to_string());

        // 前台是自己 → 不记来源。
        if bundle_id.as_deref() == Some(SELF_BUNDLE_ID) {
            return (None, None);
        }

        let name: Option<String> = app.localizedName().map(|s| s.to_string());

        // 图标：按 bundleId 缓存；缓存未命中才做一次 NSImage → PNG 转换。
        let icon: Option<String> = match bundle_id.as_deref() {
            Some(bid) => {
                if let Some(cached) = cache.get(bid) {
                    Some(cached)
                } else if let Some(url) = app.icon().and_then(|img| nsimage_to_png_data_url(&img)) {
                    cache.put(bid.to_string(), url.clone());
                    Some(url)
                } else {
                    None
                }
            }
            // 没有 bundleId 无法缓存，直接转换（罕见）。
            None => app.icon().and_then(|img| nsimage_to_png_data_url(&img)),
        };

        (name, icon)
    })
}

/// NSImage → ~32px base64 PNG data URL。
///
/// 路径：NSImage.TIFFRepresentation → TIFF 字节 → image crate 解码 → 缩放到约 32px
/// → 重新编码 PNG → base64。仅用到 `TIFFRepresentation` + `NSData::to_vec` 两个原生
/// 调用，其余交给已有 image crate（其默认 feature 含 tiff/png 解码）。任何一步失败返回 None。
#[cfg(target_os = "macos")]
fn nsimage_to_png_data_url(img: &objc2_app_kit::NSImage) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    // NSImage → TIFF 字节。
    let tiff = img.TIFFRepresentation()?;
    let tiff_bytes = tiff.to_vec();
    if tiff_bytes.is_empty() {
        return None;
    }

    // 用 image crate 解码 TIFF → 缩放到 ~32px → 编码 PNG。
    let dynimg = image::load_from_memory(&tiff_bytes).ok()?;
    let thumb = dynimg.thumbnail(32, 32);
    let mut buf = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buf, image::ImageFormat::Png).ok()?;

    let b64 = STANDARD.encode(buf.into_inner());
    Some(format!("data:image/png;base64,{b64}"))
}

/// 取当前前台应用的进程号（排除应用自身）。用于在粘贴前把焦点还给来源 App。
#[cfg(target_os = "macos")]
pub fn frontmost_pid() -> Option<i32> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;

    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;
        if app.bundleIdentifier().map(|s| s.to_string()).as_deref() == Some(SELF_BUNDLE_ID) {
            return None;
        }
        Some(app.processIdentifier() as i32)
    })
}

/// 把指定进程号的应用重新激活到前台（粘贴前调用，确保 ⌘V 落到目标 App）。
/// 必须在主线程调用（AppKit 要求）。
#[cfg(target_os = "macos")]
pub fn activate_pid(pid: i32) {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    autoreleasepool(|_| {
        if let Some(app) = unsafe { NSRunningApplication::runningApplicationWithProcessIdentifier(pid) }
        {
            app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn frontmost_pid() -> Option<i32> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn activate_pid(_pid: i32) {}

/// 非 macOS 平台：无来源 App 概念，恒返回 `(None, None)`。
#[cfg(not(target_os = "macos"))]
pub fn capture_source(_cache: &IconCache) -> (Option<String>, Option<String>) {
    (None, None)
}
