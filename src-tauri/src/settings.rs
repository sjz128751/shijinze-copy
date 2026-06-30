use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::models::Settings;

/// 设置持久化文件路径： app_config_dir()/settings.json
fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            Some(dir.join("settings.json"))
        }
        Err(_) => None,
    }
}

/// 从磁盘加载设置（不存在或失败则返回默认，容错不 panic）。
pub fn load_settings(app: &AppHandle) -> Settings {
    let Some(path) = settings_path(app) else {
        return Settings::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let mut s = serde_json::from_str::<Settings>(&content).unwrap_or_default();
            // 迁移：把跨平台别名 CmdOrCtrl/CommandOrControl 规整为本平台具体键
            // （macOS→Cmd，Windows/Linux→Ctrl）。
            if s.shortcut.contains("CmdOrCtrl") || s.shortcut.contains("CommandOrControl") {
                #[cfg(target_os = "macos")]
                let repl = "Cmd";
                #[cfg(not(target_os = "macos"))]
                let repl = "Ctrl";
                s.shortcut = s
                    .shortcut
                    .replace("CommandOrControl", repl)
                    .replace("CmdOrCtrl", repl);
            }
            s
        }
        Err(_) => Settings::default(),
    }
}

/// 将设置写回磁盘（失败时容错，不 panic）。
pub fn save_settings(app: &AppHandle, settings: &Settings) {
    let Some(path) = settings_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(&path, json);
    }
}
