mod settings;
mod vault;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use vault::{FileNode, NoteContent, NoteMeta, SearchHit, Vault, VaultInfo};

/// 全局状态：当前打开的仓库。
#[derive(Default)]
struct AppState {
    vault: Mutex<Option<Vault>>,
}

fn with_vault<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Vault) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.vault.lock().map_err(|_| "内部状态异常".to_string())?;
    let current = guard.as_ref().ok_or_else(|| "尚未打开仓库".to_string())?;
    f(current)
}

/// 去掉 Windows 规范化路径的 `\\?\` 前缀，界面显示更干净。
fn simplify(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[tauri::command]
fn open_vault(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<VaultInfo, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("文件夹不存在或不是目录：{path}"));
    }
    let root = simplify(root.canonicalize().unwrap_or(root));
    let info = Vault::new(root).info();

    *state.vault.lock().map_err(|_| "内部状态异常".to_string())? = Some(Vault::new(PathBuf::from(&info.path)));

    let mut s = settings::load(&app);
    s.recent_vaults.retain(|p| p != &info.path);
    s.recent_vaults.insert(0, info.path.clone());
    s.recent_vaults.truncate(12);
    s.last_vault = Some(info.path.clone());
    let _ = settings::save(&app, &s);

    Ok(info)
}

#[tauri::command]
fn close_vault(state: State<'_, AppState>) -> Result<(), String> {
    *state.vault.lock().map_err(|_| "内部状态异常".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn current_vault(state: State<'_, AppState>) -> Option<VaultInfo> {
    let guard = state.vault.lock().ok()?;
    guard.as_ref().map(|v| v.info())
}

#[tauri::command]
fn list_tree(state: State<'_, AppState>) -> Result<Vec<FileNode>, String> {
    with_vault(&state, |v| Ok(v.tree()))
}

#[tauri::command]
fn read_note(state: State<'_, AppState>, path: String) -> Result<NoteContent, String> {
    with_vault(&state, |v| v.read(&path))
}

#[tauri::command]
fn write_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> Result<i64, String> {
    with_vault(&state, |v| v.write(&path, &content, expected_mtime))
}

#[tauri::command]
fn create_note(state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    with_vault(&state, |v| v.create_note(&parent, &name))
}

#[tauri::command]
fn create_folder(state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    with_vault(&state, |v| v.create_folder(&parent, &name))
}

#[tauri::command]
fn rename_entry(state: State<'_, AppState>, path: String, new_name: String) -> Result<String, String> {
    with_vault(&state, |v| v.rename(&path, &new_name))
}

#[tauri::command]
fn move_entry(state: State<'_, AppState>, path: String, new_parent: String) -> Result<String, String> {
    with_vault(&state, |v| v.move_entry(&path, &new_parent))
}

#[tauri::command]
fn delete_entry(state: State<'_, AppState>, path: String) -> Result<(), String> {
    with_vault(&state, |v| v.delete(&path))
}

#[tauri::command]
fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteMeta>, String> {
    with_vault(&state, |v| Ok(v.notes()))
}

#[tauri::command]
fn search_notes(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    with_vault(&state, |v| v.search(&query))
}

/// 判断某个路径是否仍是可用文件夹（用于最近仓库列表）。
#[tauri::command]
fn path_is_dir(path: String) -> bool {
    PathBuf::from(path).is_dir()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::Settings {
    settings::load(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<(), String> {
    settings::save(&app, &settings)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            close_vault,
            current_vault,
            list_tree,
            read_note,
            write_note,
            create_note,
            create_folder,
            rename_entry,
            move_entry,
            delete_entry,
            list_notes,
            search_notes,
            path_is_dir,
            get_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
