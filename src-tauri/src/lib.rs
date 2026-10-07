mod notes;
mod review;
mod settings;
mod store;
mod vault;
mod workflow;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use vault::{FileNode, NoteContent, NoteMeta, SearchHit, Vault, VaultInfo};
use workflow::{SyncReport, WorkflowNote};

/// 全局状态：当前打开的仓库，以及带缓存的链接索引。
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

/// 备份文件名用的日期。前端也可以覆盖，这里只要"每天一个"即可。
fn chrono_like_today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    review::format_day(secs / 86_400)
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

    // 允许前端的 <img> 读取这个仓库里的图片（只放开当前仓库目录）
    if let Err(error) = app.asset_protocol_scope().allow_directory(&info.path, true) {
        eprintln!("放开图片目录失败：{error}");
    }

    // 首次打开一个空文件夹：把里面已有的 .md 收进库。
    //
    // **只做这一次**。之后库就是全部——磁盘上的 .md 不再被读回来，
    // 所以"你删掉的笔记下次打开又冒出来"这类事从根上不会发生；
    // 想再收一次旧文件，把仓库里的 .rnote/ 删掉重开即可。
    if let Ok(conn) = store::open(std::path::Path::new(&info.path)) {
        if notes::library_is_fresh(&conn) {
            match notes::import_vault(&conn, std::path::Path::new(&info.path)) {
                Ok(report) if report.imported > 0 => {
                    eprintln!("首次打开：收进 {} 篇笔记", report.imported);
                }
                Ok(_) => {}
                Err(error) => eprintln!("导入笔记库失败：{error}"),
            }
        }
        if let Err(error) = store::meta_set(&conn, "initialized", "1") {
            eprintln!("标记仓库已初始化失败：{error}");
        }
        // v5：把文档模型铺成"笔记（集合）+ 三段"，并给卡片补来源快照（幂等）
        match notes::migrate_collections(&conn) {
            Ok(count) if count > 0 => eprintln!("集合模型整理：{count} 项"),
            Ok(_) => {}
            Err(error) => eprintln!("迁移失败：{error}"),
        }
        // 每天首次打开做一份快照：笔记只在库里，这是唯一的回退依靠
        let today = chrono_like_today();
        if let Err(error) = store::backup_daily(&conn, std::path::Path::new(&info.path), &today) {
            eprintln!("自动备份失败：{error}");
        }
    }

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

// ---------------------------------------------------------------- 笔记库
// DB 是真身，Markdown 是只写镜像；这一层的命令签名与从前保持一致，
// 所以前端几乎不用改（见 docs/rnote-storage.md §10）。

fn db(vault: &Vault) -> Result<rusqlite::Connection, String> {
    store::open(&vault.root)
}

#[tauri::command]
fn list_tree(state: State<'_, AppState>) -> Result<Vec<FileNode>, String> {
    with_vault(&state, |v| notes::tree(&db(v)?))
}

#[tauri::command]
fn read_note(state: State<'_, AppState>, path: String) -> Result<NoteContent, String> {
    with_vault(&state, |v| notes::read(&db(v)?, &path))
}

#[tauri::command]
fn write_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> Result<i64, String> {
    with_vault(&state, |v| {
        notes::write(&db(v)?, &path, &content, expected_mtime)
    })
}

#[tauri::command]
fn create_note(state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    with_vault(&state, |v| notes::create(&db(v)?, &parent, &name, false))
}

#[tauri::command]
fn create_folder(state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    with_vault(&state, |v| notes::create(&db(v)?, &parent, &name, true))
}

#[tauri::command]
fn rename_entry(state: State<'_, AppState>, path: String, new_name: String) -> Result<String, String> {
    with_vault(&state, |v| notes::rename(&db(v)?, &path, &new_name))
}

#[tauri::command]
fn move_entry(state: State<'_, AppState>, path: String, new_parent: String) -> Result<String, String> {
    with_vault(&state, |v| notes::move_node(&db(v)?, &path, &new_parent))
}

#[tauri::command]
fn delete_entry(state: State<'_, AppState>, path: String) -> Result<(), String> {
    with_vault(&state, |v| notes::remove(&db(v)?, &path))
}

#[tauri::command]
fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteMeta>, String> {
    with_vault(&state, |v| notes::notes(&db(v)?))
}

#[tauri::command]
fn search_notes(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    with_vault(&state, |v| notes::search(&db(v)?, &query))
}

/// 某篇笔记的出链与反向链接。
/// 某篇笔记的出链与反向链接（查库）。
#[tauri::command]
fn link_report(state: State<'_, AppState>, path: String) -> Result<notes::LinkReport, String> {
    with_vault(&state, |v| notes::link_report(&db(v)?, &path))
}

/// 某篇笔记的三段摘要（右栏卡片面板、编辑器头部用）。
#[tauri::command]
fn list_parts(state: State<'_, AppState>, path: String) -> Result<Vec<notes::PartRow>, String> {
    with_vault(&state, |v| notes::parts_summary(&db(v)?, &path))
}

/// 导出全部笔记为 Markdown（归档 / 迁移 / 分享）。
#[tauri::command]
fn export_markdown(state: State<'_, AppState>, dir: String) -> Result<usize, String> {
    with_vault(&state, |v| {
        notes::export_markdown(&db(v)?, std::path::Path::new(&dir))
    })
}

/// 现有备份列表（新的在前）。
#[tauri::command]
fn list_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_vault(&state, |v| Ok(store::list_backups(&v.root)))
}

/// 全量重建链接索引（改名 / 移动之后会用到）。
#[tauri::command]
fn reindex_all(state: State<'_, AppState>) -> Result<usize, String> {
    with_vault(&state, |v| notes::reindex_links(&db(v)?))
}

// ---------------------------------------------------------------- 复习（P1）

/// 今日到期 + 新卡。
#[tauri::command]
fn due_cards(
    state: State<'_, AppState>,
    today: String,
    limit: Option<usize>,
    note_path: Option<String>,
) -> Result<Vec<review::DueCard>, String> {
    with_vault(&state, |v| {
        review::due_cards(&db(v)?, &today, limit.unwrap_or(200), note_path.as_deref())
    })
}

/// 每篇笔记的到期数量（工作台用）。
#[tauri::command]
fn due_by_note(state: State<'_, AppState>, today: String) -> Result<Vec<review::NoteDue>, String> {
    with_vault(&state, |v| review::due_by_note(&db(v)?, &today))
}

/// 四档评分：1 重来 / 2 困难 / 3 良好 / 4 简单。
#[tauri::command]
fn grade_card(
    state: State<'_, AppState>,
    card_id: i64,
    rating: u8,
    today: String,
) -> Result<review::GradeResult, String> {
    with_vault(&state, |v| review::grade(&db(v)?, card_id, rating, &today))
}

/// 撤销某张卡最近一次评分。
#[tauri::command]
fn undo_grade(state: State<'_, AppState>, card_id: i64) -> Result<(), String> {
    with_vault(&state, |v| review::undo_last(&db(v)?, card_id))
}

/// 复习概况（总数 / 新卡 / 到期 / 今日已复习）。
#[tauri::command]
fn review_stats(state: State<'_, AppState>, today: String) -> Result<review::ReviewStats, String> {
    with_vault(&state, |v| review::stats(&db(v)?, &today))
}

// ---------------------------------------------------------------- 卡片（块 → 卡）

/// 某篇笔记的全部卡片（右侧卡片面板）。
#[tauri::command]
fn list_cards(
    state: State<'_, AppState>,
    note_path: String,
    today: String,
) -> Result<Vec<review::Card>, String> {
    with_vault(&state, |v| review::cards_of_note(&db(v)?, &note_path, &today))
}

/// 从选中的块建一张卡：答案默认取块原文，来源快照一并存下。
#[tauri::command]
fn create_card(
    state: State<'_, AppState>,
    card: review::NewCard,
    today: String,
) -> Result<review::Card, String> {
    with_vault(&state, |v| review::create_card(&db(v)?, &card, &today))
}

/// 删一张卡（只删库里的卡片行，正文不动）。
#[tauri::command]
fn delete_card(state: State<'_, AppState>, card_id: i64) -> Result<(), String> {
    with_vault(&state, |v| review::delete_card(&db(v)?, card_id))
}

/// 一篇笔记的卡片小结（新学 / 到期 / 学习中 / 复习中 / 总数）。
#[tauri::command]
fn card_summary(
    state: State<'_, AppState>,
    note_path: String,
    today: String,
) -> Result<review::CardSummary, String> {
    with_vault(&state, |v| review::card_summary(&db(v)?, &note_path, &today))
}

/// 仓库里全部卡片的计数（左侧「复习」徽标）。
#[tauri::command]
fn card_counts(state: State<'_, AppState>, today: String) -> Result<review::CardSummary, String> {
    with_vault(&state, |v| review::card_counts(&db(v)?, &today))
}

/// 判断某个路径是否仍是可用文件夹（用于最近仓库列表）。
#[tauri::command]
fn path_is_dir(path: String) -> bool {
    PathBuf::from(path).is_dir()
}

// ---------------------------------------------------------------- 工作流（P0）

/// 增量扫描仓库，把笔记路径、状态与统计同步进 `.rnote/rnote.db`。
#[tauri::command]
fn sync_workflow(state: State<'_, AppState>) -> Result<SyncReport, String> {
    with_vault(&state, |vault| {
        let conn = store::open(&vault.root)?;
        workflow::sync(vault, &conn)
    })
}

/// 看板数据：全部笔记 + 状态 + 块/卡计数。
#[tauri::command]
fn list_workflow(state: State<'_, AppState>) -> Result<Vec<WorkflowNote>, String> {
    with_vault(&state, |vault| {
        let conn = store::open(&vault.root)?;
        workflow::list(&conn)
    })
}

/// 改一篇笔记的状态（写回 frontmatter 的 `status`，只动这一个键）。
#[tauri::command]
fn set_note_status(state: State<'_, AppState>, path: String, status: String) -> Result<(), String> {
    with_vault(&state, |vault| {
        let conn = store::open(&vault.root)?;
        workflow::set_status(vault, &conn, &path, &status)
    })
}

/// 快速捕获：追加一条到当天的收件箱笔记。
#[tauri::command]
fn append_inbox(
    state: State<'_, AppState>,
    date: String,
    time: String,
    text: String,
) -> Result<String, String> {
    with_vault(&state, |vault| workflow::append_inbox(&db(vault)?, vault, &date, &time, &text))
}

/// 导入材料：附件进 `attachments/`，并生成一张材料卡。
#[tauri::command]
fn import_material(
    state: State<'_, AppState>,
    source: String,
    date: String,
) -> Result<String, String> {
    with_vault(&state, |vault| {
        workflow::import_material(&db(vault)?, vault, std::path::Path::new(&source), &date)
    })
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
            link_report,
            list_parts,
            reindex_all,
            export_markdown,
            list_backups,
            due_cards,
            due_by_note,
            grade_card,
            undo_grade,
            review_stats,
            list_cards,
            create_card,
            delete_card,
            card_summary,
            card_counts,
            path_is_dir,
            sync_workflow,
            list_workflow,
            set_note_status,
            append_inbox,
            import_material,
            get_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
