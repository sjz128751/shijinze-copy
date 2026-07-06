use serde::{Deserialize, Serialize};

/// 默认强调色（macOS 蓝）。
fn default_accent() -> String {
    "#0a84ff".to_string()
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_shortcut() -> String {
    // macOS 用 ⌘；Windows/Linux 用 Ctrl（Cmd 在 Win 上是 Win 键）。
    #[cfg(target_os = "macos")]
    {
        "Cmd+Shift+V".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Ctrl+Shift+V".to_string()
    }
}

fn default_true() -> bool {
    true
}

fn default_kind() -> String {
    "text".to_string()
}

/// 历史条数默认值（仅作用于非置顶项）。
pub fn default_history_size() -> u32 {
    200
}

/// 主窗口默认高度（px）。
pub fn default_window_height() -> u32 {
    760
}

/// 主窗口背景不透明度（百分比 40..=100）。默认 100 = 完全不透明（不透出毛玻璃/亚克力）。
pub fn default_window_opacity() -> u8 {
    100
}

/// 弹窗位置：默认跟随光标。
fn default_popup_position() -> String {
    "cursor".to_string()
}

/// 置顶项位置：默认顶部。
fn default_pinned_position() -> String {
    "top".to_string()
}

/// 搜索命中高亮方式：默认粗体。
fn default_highlight_match() -> String {
    "bold".to_string()
}

/// 图片缩略图默认高度（px）。
pub fn default_image_thumb_height() -> u32 {
    18
}

pub fn default_sync_port() -> u32 {
    9999
}

/// 单条文本最大字符数（超过则不记录）。默认 10 万字符（~100KB），0 表示不限制。
pub fn default_max_text_length() -> u32 {
    100000
}

/// 剪贴板历史项。前端按 camelCase 字段使用。
///
/// 向后兼容旧 history.json（仅含 id/text/timestamp）：
/// 所有新增字段都带 `#[serde(default)]`，缺失 kind 视为 "text"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: u64,
    /// "text" | "image" | "files"
    #[serde(default = "default_kind")]
    pub kind: String,
    /// kind=text 时有内容。
    #[serde(default)]
    pub text: Option<String>,
    /// kind=files 时有：绝对路径数组。
    #[serde(default)]
    pub files: Option<Vec<String>>,
    /// kind=image 时有：base64 PNG data URL（缩略图，供前端预览）。
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// kind=image 时有：磁盘完整 PNG 路径（供回写，前端只读不展示）。
    /// serde rename_all=camelCase 会序列化为 imagePath。
    #[serde(default)]
    pub image_path: Option<String>,
    /// kind=image 时有：像素宽高（前端展示「1920×1080」）。旧数据缺失，加载时回填。
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// kind=image 时有：原始 PNG 字节数（前端展示「256 KB」）。旧数据缺失，加载时回填。
    #[serde(default)]
    pub size: Option<u64>,
    /// Unix 毫秒时间戳。
    pub timestamp: u64,
    /// 是否置顶收藏。置顶项排在最前、不计入历史上限、不被淘汰。
    /// 向后兼容旧数据：缺失时默认 false。
    #[serde(default)]
    pub pinned: bool,
    /// 来源应用本地化名称（如 "Google Chrome"）：复制该内容时所在的前台应用。
    /// 旧数据缺失时为 None。序列化为 sourceApp。
    #[serde(default)]
    pub source_app: Option<String>,
    /// 来源应用图标的 base64 PNG data URL（约 32px，"data:image/png;base64,..."）。
    ///
    /// 去重优化：图标不再逐条内嵌持久化/经 IPC 下发，而是单独存一份
    /// `sourceApp -> dataURL` 映射（icons.json + icons-updated 事件 + get_icons 命令），
    /// 前端按 `sourceApp` 键查图标。故本字段 `skip_serializing`：既不写入 history.json，
    /// 也不出现在 history-updated 全量推送里，避免同一 App 的图标在数百条记录间重复携带。
    /// 仍保留 `#[serde(default)]` 以反序列化旧 history.json（其内嵌图标会在启动时迁移进映射）。
    #[serde(default, skip_serializing)]
    pub source_icon: Option<String>,
    /// 图片像素内容哈希，仅用于内存内去重；不序列化、前端不可见。
    #[serde(skip)]
    pub hash: Option<u64>,
}

/// 「常用」分组：一组用户精选的常用条目。前端按 camelCase 字段使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavGroup {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub items: Vec<ClipItem>,
}

/// 应用设置。前端按 camelCase 字段使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Tauri 加速键字符串，如 "Cmd+Shift+V"。
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    /// 备用全局快捷键（同样呼出/隐藏窗口）；空字符串表示不设。
    #[serde(default)]
    pub shortcut2: String,
    /// 失焦自动隐藏窗口，默认 true。
    #[serde(default = "default_true")]
    pub auto_hide_on_blur: bool,
    /// 开机自启，默认 false。
    #[serde(default)]
    pub autostart: bool,
    /// "system" | "light" | "dark"，默认 "system"。
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 强调色十六进制，如 "#0a84ff"。
    #[serde(default = "default_accent")]
    pub accent: String,
    /// 历史条数上限（仅作用于非置顶项），默认 200，合理范围 10..=1000。
    #[serde(default = "default_history_size")]
    pub history_size: u32,
    /// 选中并回车/点击后是否模拟 ⌘V 自动粘贴到前台 App，默认 true。
    #[serde(default = "default_true")]
    pub paste_on_select: bool,
    /// 是否忽略密码/敏感(concealed/transient)剪贴板内容，默认 false（不忽略）。
    #[serde(default)]
    pub ignore_concealed: bool,
    /// 主窗口高度（px），默认 760，合理范围 360..=1400。
    #[serde(default = "default_window_height")]
    pub window_height: u32,
    /// 主窗口背景不透明度（百分比 40..=100），默认 100=不透明。低于 100 时透出毛玻璃/亚克力磨砂。
    #[serde(default = "default_window_opacity")]
    pub window_opacity: u8,
    /// 弹窗位置："cursor"=光标处，"center"=屏幕中心，默认 "cursor"。
    #[serde(default = "default_popup_position")]
    pub popup_position: String,
    /// 置顶项位置："top"=历史顶部，"bottom"=底部，默认 "top"。
    #[serde(default = "default_pinned_position")]
    pub pinned_position: String,
    /// 主窗口顶栏是否显示应用名「剪切板」，默认 true。
    #[serde(default = "default_true")]
    pub show_app_name: bool,
    /// 列表行左侧是否显示来源 App 图标，默认 true。
    #[serde(default = "default_true")]
    pub show_source_icon: bool,
    /// 历史行右侧是否显示 ⌘1..⌘9 序号，默认 true。
    #[serde(default = "default_true")]
    pub show_numbers: bool,
    /// 搜索命中高亮方式："bold"|"underline"|"none"，默认 "bold"。
    #[serde(default = "default_highlight_match")]
    pub highlight_match: String,
    /// 图片项缩略图高度（px），默认 18，合理范围 14..=48。
    #[serde(default = "default_image_thumb_height")]
    pub image_thumb_height: u32,

    // ===== 云同步（可选功能，默认全关；关闭时零联网、零影响单机版）=====
    /// 是否开启云同步（登录后周期性上传/下载加密历史 + 发心跳）。默认 false。
    #[serde(default)]
    pub sync_enabled: bool,
    /// 是否使用自建服务器。false（默认）时走内置默认后端 copy.nihaoiii.fun:80，
    /// 忽略 sync_host / sync_port；true 时才用下面填的 IP / 端口。
    #[serde(default)]
    pub sync_self_host: bool,
    /// 自建服务器 IP / 域名（仅 sync_self_host=true 时生效），如 "192.168.1.10"。空表示未配置。
    #[serde(default)]
    pub sync_host: String,
    /// 自建服务器端口（仅 sync_self_host=true 时生效），默认 9999。
    #[serde(default = "default_sync_port")]
    pub sync_port: u32,
    /// 端到端加密同步密钥（口令）。两台设备须填一致；服务端只存密文、解不开。空表示未配置。
    #[serde(default)]
    pub sync_key: String,

    /// 历史数据自定义存储目录（history/favorites/icons/images 都存这里）。
    /// 空字符串（默认）= 用系统默认 app_data_dir。仅经 change_data_dir/reset_data_dir 变更。
    #[serde(default)]
    pub data_dir: String,

    /// 单条文本最大字符数：超过则不记录（避免超大文本进历史后全量 IPC 重发/渲染卡死）。
    /// 默认 10 万；0 = 不限制。
    #[serde(default = "default_max_text_length")]
    pub max_text_length: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            shortcut: default_shortcut(),
            shortcut2: String::new(),
            auto_hide_on_blur: true,
            autostart: false,
            theme: default_theme(),
            accent: default_accent(),
            history_size: default_history_size(),
            paste_on_select: true,
            ignore_concealed: false,
            window_height: default_window_height(),
            window_opacity: default_window_opacity(),
            popup_position: default_popup_position(),
            pinned_position: default_pinned_position(),
            show_app_name: true,
            show_source_icon: true,
            show_numbers: true,
            highlight_match: default_highlight_match(),
            image_thumb_height: default_image_thumb_height(),
            sync_enabled: false,
            sync_self_host: false,
            sync_host: String::new(),
            sync_port: default_sync_port(),
            sync_key: String::new(),
            data_dir: String::new(),
            max_text_length: default_max_text_length(),
        }
    }
}
