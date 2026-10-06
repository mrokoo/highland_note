//! 应用设置的读写，落盘在系统配置目录下（`settings.json`）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 最近打开过的仓库路径，最新在前。
    pub recent_vaults: Vec<String>,
    /// 上次使用的仓库，启动时尝试自动打开。
    pub last_vault: Option<String>,
    /// "dark" | "light"
    pub theme: String,
    /// "edit" | "split" | "preview"
    pub view_mode: String,
    pub font_size: u32,
    pub sidebar_width: u32,
    pub show_sidebar: bool,
    pub show_line_numbers: bool,
    /// 右侧链接面板是否展开。
    pub show_right_panel: bool,
    pub right_panel_width: u32,
    pub editor_width: u32,
    /// 分栏时编辑区占的比例（0.15 – 0.85）。
    pub split_ratio: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            recent_vaults: Vec::new(),
            last_vault: None,
            theme: "dark".to_string(),
            view_mode: "split".to_string(),
            font_size: 16,
            sidebar_width: 268,
            show_sidebar: true,
            show_line_numbers: true,
            show_right_panel: false,
            right_panel_width: 300,
            editor_width: 0,
            split_ratio: 0.5,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("保存设置失败：{e}"))
}
