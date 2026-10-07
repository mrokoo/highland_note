//! 笔记库：**笔记是集合（输入 / 内化 / 输出三段），数据库是唯一存储**。
//!
//! 数据模型（见 `docs/rnote-storage.md`）：
//!
//! ```text
//! notes   笔记与文件夹（parent_id 组成一棵树；kind 区分 folder / note）
//! parts   三段正文：role = input | internalize | output，同一角色可以有多段
//! cards   卡片直接属于笔记，自带 source_text 快照（由"选中文字建卡"产生）
//! links   [[双链]] 索引
//! ```
//!
//! 编辑器现在仍然把一篇笔记当成"一个 Markdown 文档"来编辑，所以这里提供
//! **装配 / 拆解**：`read` 把三段拼成带小节标题的文档，`write` 再按小节拆回 parts。
//! frontmatter 原样保存在 `notes.front` 里，只把 status / 类型 / 来源解析成列供查询。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

use crate::store;
use crate::vault::{is_note, is_skipped_dir, FileNode, NoteContent, NoteMeta, SearchHit};
use crate::workflow::{normalize_status, parse_front_matter};

/// 三段在文档里的标题。
pub const ROLES: [(&str, &str); 3] = [
    ("input", "输入"),
    ("internalize", "内化"),
    ("output", "输出"),
];

fn role_of_label(label: &str) -> Option<&'static str> {
    ROLES
        .iter()
        .find(|(_, name)| *name == label)
        .map(|(key, _)| *key)
}

// ------------------------------------------------------------------ 基础结构

#[derive(Debug, Clone)]
pub struct Note {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub status: String,
    pub doc_kind: String,
    pub source: Option<String>,
    pub captured_at: Option<String>,
    /// raw frontmatter（不含 `---` 两行），原样保留用户自己的键
    pub front: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct Part {
    pub id: String,
    pub role: String,
    pub title: String,
    pub position: i64,
    pub content: String,
}

impl Note {
    pub fn is_dir(&self) -> bool {
        self.kind == "folder"
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub folders: usize,
}

const SELECT_NOTE: &str = "SELECT id, parent_id, kind, title, path, status, doc_kind, source,
                                  captured_at, COALESCE(front, ''), updated_at FROM notes";

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        path: row.get(4)?,
        status: row.get(5)?,
        doc_kind: row.get(6)?,
        source: row.get(7)?,
        captured_at: row.get(8)?,
        front: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn all_notes(conn: &Connection) -> Result<Vec<Note>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT_NOTE} ORDER BY sort, title"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_note).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn note_by_path(conn: &Connection, path: &str) -> Result<Option<Note>, String> {
    conn.query_row(&format!("{SELECT_NOTE} WHERE path = ?1"), [path], row_to_note)
        .optional()
        .map_err(|e| e.to_string())
}

fn note_by_id(conn: &Connection, id: &str) -> Result<Option<Note>, String> {
    conn.query_row(&format!("{SELECT_NOTE} WHERE id = ?1"), [id], row_to_note)
        .optional()
        .map_err(|e| e.to_string())
}

fn parts_of(conn: &Connection, note_id: &str) -> Result<Vec<Part>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, role, title, position, content FROM parts
             WHERE note_id = ?1 ORDER BY position, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([note_id], |row| {
            Ok(Part {
                id: row.get(0)?,
                role: row.get(1)?,
                title: row.get(2)?,
                position: row.get(3)?,
                content: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 短 id：时间戳 + 计数器混合成 base36。不需要密码学强度，只要不撞。
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut value = stamp.wrapping_mul(31).wrapping_add(n.wrapping_mul(0x9E37_79B9));
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(10);
    out.push('n');
    for _ in 0..9 {
        out.push(ALPHABET[(value % 36) as usize] as char);
        value /= 36;
    }
    out
}

// ------------------------------------------------------------------ 装配与拆解

/// 把一篇笔记装配成编辑器看到的 Markdown 文档。
///
/// **笔记正文就是正文**，不再往里塞 `## 输入 / ## 内化 / ## 输出` 这类小节标题——
/// 那是早期"一篇笔记由三段组成"的模型留下的，现在只会碍眼：
/// 每次打开笔记都先看到一行"内化"，而且它还会出现在标题大纲里。
/// 库里的分段（`parts.role`）照旧保留，只是不再往正文里写。
pub fn assemble(conn: &Connection, note: &Note) -> Result<String, String> {
    let parts = parts_of(conn, &note.id)?;
    let mut out = String::new();

    if !note.front.trim().is_empty() {
        out.push_str("---\n");
        out.push_str(note.front.trim_end());
        out.push_str("\n---\n\n");
    }

    let bodies: Vec<&str> = parts
        .iter()
        .map(|part| part.content.trim())
        .filter(|text| !text.is_empty())
        .collect();
    if !bodies.is_empty() {
        out.push_str(&bodies.join("\n\n"));
        out.push('\n');
    }

    // 一个字都没有时返回空串，而不是一个换行——新建的笔记在编辑器里就该是彻底空的
    let text = out.trim_end();
    if text.is_empty() {
        return Ok(String::new());
    }
    Ok(format!("{text}\n"))
}

/// 拆解：整篇正文就是一段。
///
/// 从前这里按 `## 输入 / ## 内化 / ## 输出` 切段；现在笔记只有一段正文，
/// 统一归到 `internalize`（角色仍在库里存着，将来要分角色再说）。
/// 顺手把**旧的**角色标题行去掉——用户没写过它们，是当年装配时加上去的。
fn split_sections(body: &str) -> Vec<(String, String, String)> {
    let text = strip_role_headers(body).trim().to_string();
    vec![("internalize".to_string(), String::new(), text)]
}

/// 去掉行首的角色标题（`## 输入`、`## 内化 · 得到第 3 讲`、`## 输出`）。
///
/// 顺手把空行收一收：标题行拿掉之后会留下两三行连着空行，看着像文档破了洞。
fn strip_role_headers(body: &str) -> String {
    let kept: Vec<&str> = body
        .lines()
        .filter(|line| {
            let Some(rest) = line.trim().strip_prefix("## ") else {
                return true;
            };
            let (label, _) = match rest.trim().split_once('·') {
                Some((label, title)) => (label.trim(), title.trim()),
                None => (rest.trim(), ""),
            };
            role_of_label(label).is_none()
        })
        .collect();
    normalize_blank_lines(&kept.join("\n"))
}

/// 连续空行压成一个空行，首尾空白去掉。
fn normalize_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        if line.trim().is_empty() {
            continue; // 空行不写出去，段落之间统一补一个
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(line.trim_end());
    }
    out
}

/// 把拆解结果写进 parts：同角色按顺序对位更新，多出来的删掉，不够的新建。
fn save_parts(
    conn: &Connection,
    note_id: &str,
    sections: &[(String, String, String)],
) -> Result<(), String> {
    let existing = parts_of(conn, note_id)?;
    let now = now_ms();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (index, (role, title, content)) in sections.iter().enumerate() {
        let slot = existing
            .iter()
            .find(|part| part.role == *role && !used.contains(&part.id));
        match slot {
            Some(part) => {
                used.insert(part.id.clone());
                conn.execute(
                    "UPDATE parts SET title = ?1, position = ?2, content = ?3, updated_at = ?4
                     WHERE id = ?5",
                    params![title, index as i64, content, now, part.id],
                )
                .map_err(|e| e.to_string())?;
            }
            None => {
                conn.execute(
                    "INSERT INTO parts (id, note_id, role, title, position, content, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![new_id(), note_id, role, title, index as i64, content, now],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    for part in existing {
        if !used.contains(&part.id) {
            conn.execute("DELETE FROM parts WHERE id = ?1", [&part.id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 拆出 frontmatter：`raw` 原样留档，正文交给拆解。
fn split_front(content: &str) -> (String, String) {
    let fm = parse_front_matter(content);
    if !fm.present {
        return (String::new(), content.to_string());
    }
    let raw = content[..fm.body_offset]
        .trim()
        .trim_start_matches("---")
        .trim_end_matches("---")
        .trim()
        .to_string();
    let body = content[fm.body_offset.min(content.len())..]
        .trim_start_matches('\n')
        .to_string();
    (raw, body)
}

// ------------------------------------------------------------------ 路径

fn child_path(parent: Option<&Note>, title: &str) -> String {
    match parent {
        Some(parent) if !parent.path.is_empty() => format!("{}/{}", parent.path, title),
        _ => title.to_string(),
    }
}

/// 重算某个节点及其后代的 path（改名 / 移动之后）。
fn rewrite_paths(conn: &Connection, root_id: &str) -> Result<(), String> {
    let notes = all_notes(conn)?;
    let by_id: std::collections::HashMap<String, Note> =
        notes.into_iter().map(|n| (n.id.clone(), n)).collect();

    fn walk(
        conn: &Connection,
        by_id: &std::collections::HashMap<String, Note>,
        node: &Note,
        parent_path: &str,
    ) -> Result<(), String> {
        let path = if parent_path.is_empty() {
            node.title.clone()
        } else {
            format!("{}/{}", parent_path, node.title)
        };
        if path != node.path {
            conn.execute("UPDATE notes SET path = ?1 WHERE id = ?2", params![path, node.id])
                .map_err(|e| e.to_string())?;
        }
        let mut children: Vec<&Note> = by_id
            .values()
            .filter(|n| n.parent_id.as_deref() == Some(node.id.as_str()))
            .collect();
        children.sort_by(|a, b| a.title.cmp(&b.title));
        for child in children {
            walk(conn, by_id, child, &path)?;
        }
        Ok(())
    }

    if let Some(node) = by_id.get(root_id) {
        let parent_path = node
            .parent_id
            .as_deref()
            .and_then(|pid| by_id.get(pid))
            .map(|p| p.path.clone())
            .unwrap_or_default();
        walk(conn, &by_id, node, &parent_path)?;
    }
    Ok(())
}

/// 保证 `a/b/c` 这条文件夹路径存在，返回最末一级 id。
fn ensure_folder(conn: &Connection, dir: &str, now: i64) -> Result<Option<String>, String> {
    let mut parent: Option<String> = None;
    let mut parent_path = String::new();
    for segment in dir.split('/').filter(|s| !s.is_empty()) {
        let path = if parent_path.is_empty() {
            segment.to_string()
        } else {
            format!("{parent_path}/{segment}")
        };
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM notes WHERE path = ?1 AND kind = 'folder'",
                [&path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let id = match existing {
            Some(id) => id,
            None => {
                let id = new_id();
                conn.execute(
                    "INSERT INTO notes (id, parent_id, kind, title, path, status, doc_kind, front,
                                        sort, created_at, updated_at)
                     VALUES (?1, ?2, 'folder', ?3, ?4, 'none', 'folder', '', 0, ?5, ?5)",
                    params![id, parent, segment, path, now],
                )
                .map_err(|e| format!("建文件夹 {path} 失败：{e}"))?;
                id
            }
        };
        parent = Some(id);
        parent_path = path;
    }
    Ok(parent)
}

// ------------------------------------------------------------------ 读

pub fn read(conn: &Connection, path: &str) -> Result<NoteContent, String> {
    let note = note_by_path(conn, path)?.ok_or_else(|| format!("找不到笔记：{path}"))?;
    if note.is_dir() {
        return Err("这是一个文件夹".to_string());
    }
    Ok(NoteContent {
        path: note.path.clone(),
        content: assemble(conn, &note)?,
        mtime: note.updated_at,
    })
}

/// 文件面板的目录树。
///
/// **文件夹由路径推导，不靠 `parent_id` 递归**：v5 把笔记变成"集合"之后，
/// 从磁盘导入的老笔记 parent_id 一律为空（而 `parts`/`cards` 都在），
/// 只认 parent_id 的话文件面板会整片空掉——路径才是那棵树唯一的真相。
/// 库里真实存在的文件夹仍然是节点（能放空目录），路径里没有对应文件夹的笔记
/// 会把自己的上级目录就地补出来。
pub fn tree(conn: &Connection) -> Result<Vec<FileNode>, String> {
    let notes = all_notes(conn)?;
    let mut dirs: BTreeMap<String, FileNode> = BTreeMap::new();
    let mut docs: BTreeMap<String, FileNode> = BTreeMap::new();

    /** 建出 `a/b` 这条目录路径上的每一级，返回最末一级的路径。 */
    fn ensure_dirs(dirs: &mut BTreeMap<String, FileNode>, dir: &str) {
        let mut acc = String::new();
        for segment in dir.split('/').filter(|s| !s.is_empty()) {
            acc = if acc.is_empty() {
                segment.to_string()
            } else {
                format!("{acc}/{segment}")
            };
            dirs.entry(acc.clone()).or_insert_with(|| FileNode {
                name: segment.to_string(),
                path: acc.clone(),
                is_dir: true,
                mtime: 0,
                size: 0,
                id: None,
                children: Vec::new(),
            });
        }
    }

    for note in &notes {
        if note.is_dir() {
            // 库里的文件夹优先：它的 id 是 move / 拖拽要用的
            ensure_dirs(&mut dirs, &note.path);
            if let Some(node) = dirs.get_mut(&note.path) {
                node.id = Some(note.id.clone());
                node.mtime = note.updated_at;
            }
            continue;
        }
        if let Some((dir, _)) = note.path.rsplit_once('/') {
            ensure_dirs(&mut dirs, dir);
        }
        docs.insert(
            note.path.clone(),
            FileNode {
                name: note.title.clone(),
                path: note.path.clone(),
                is_dir: false,
                mtime: note.updated_at,
                size: 0,
                id: Some(note.id.clone()),
                children: Vec::new(),
            },
        );
    }

    // 先挂笔记，再把文件夹按深度从深到浅接进上级——顺序反了会漏掉深层目录
    for (path, node) in docs {
        match path.rsplit_once('/') {
            Some((dir, _)) => {
                if let Some(parent) = dirs.get_mut(dir) {
                    parent.children.push(node);
                }
            }
            None => {
                dirs.insert(path, node);
            }
        }
    }

    let dir_paths: Vec<String> = dirs
        .keys()
        .filter(|path| path.contains('/'))
        .cloned()
        .collect();
    for path in dir_paths.into_iter().rev() {
        if let Some((parent_path, _)) = path.rsplit_once('/') {
            if let Some(node) = dirs.remove(&path) {
                if let Some(parent) = dirs.get_mut(parent_path) {
                    parent.children.push(node);
                }
            }
        }
    }

    let mut out: Vec<FileNode> = dirs.into_values().collect();
    sort_tree(&mut out);
    Ok(out)
}

/// 目录在前、文件在后，各自按名字排序（和系统文件管理器一致）。
fn sort_tree(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    for node in nodes.iter_mut() {
        sort_tree(&mut node.children);
    }
}

pub fn notes(conn: &Connection) -> Result<Vec<NoteMeta>, String> {
    let rows = all_notes(conn)?;
    let mut out: Vec<NoteMeta> = rows
        .iter()
        .filter(|note| !note.is_dir())
        .map(|note| NoteMeta {
            path: note.path.clone(),
            title: note.title.clone(),
            folder: note
                .path
                .rsplit_once('/')
                .map(|(dir, _)| dir.to_string())
                .unwrap_or_default(),
            mtime: note.updated_at,
            size: 0,
        })
        .collect();
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

/// 全文检索：搜装配后的文档，行号与编辑器里看到的完全一致。
pub fn search(conn: &Connection, query: &str) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for note in all_notes(conn)?.iter().filter(|note| !note.is_dir()) {
        let text = assemble(conn, note)?;
        for (index, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: note.path.clone(),
                    title: note.title.clone(),
                    line: (index + 1) as u32,
                    text: line.trim().chars().take(200).collect(),
                });
                if hits.len() >= 300 {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

// ------------------------------------------------------------------ 写

/// 保存一篇笔记：拆三段进 parts，frontmatter 原样留档，同时重建链接索引。
pub fn write(
    conn: &Connection,
    path: &str,
    content: &str,
    expected_mtime: Option<i64>,
) -> Result<i64, String> {
    let note = note_by_path(conn, path)?.ok_or_else(|| format!("找不到笔记：{path}"))?;
    if note.is_dir() {
        return Err("这是一个文件夹".to_string());
    }
    if let Some(expected) = expected_mtime {
        if note.updated_at != expected && (note.updated_at - expected).abs() > 1000 {
            return Err(format!("CONFLICT::{}", note.updated_at));
        }
    }

    let (front, body) = split_front(content);
    let fm = parse_front_matter(content);
    let sections = split_sections(&body);
    let now = now_ms();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE notes SET front = ?1, status = ?2, doc_kind = ?3, source = ?4, captured_at = ?5,
                          updated_at = ?6
         WHERE id = ?7",
        params![
            front,
            fm.status.clone().unwrap_or_else(|| note.status.clone()),
            fm.kind.clone().unwrap_or_else(|| note.doc_kind.clone()),
            fm.source.clone().or_else(|| note.source.clone()),
            fm.captured_at.clone().or_else(|| note.captured_at.clone()),
            now,
            note.id
        ],
    )
    .map_err(|e| format!("保存失败：{e}"))?;

    save_parts(&tx, &note.id, &sections)?;
    index_links(&tx, &note.path, content)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(now)
}

/// 只改状态：frontmatter 里的 `status` 一并改掉，两处保持一致。
pub fn set_status(conn: &Connection, path: &str, status: &str) -> Result<(), String> {
    let note = note_by_path(conn, path)?.ok_or_else(|| format!("找不到笔记：{path}"))?;
    let normalized = normalize_status(status);
    let doc = format!("---\n{}\n---\n", note.front.trim_end());
    let updated = crate::workflow::set_status_in_text(&doc, &normalized);
    let (new_front, _) = split_front(&updated);
    conn.execute(
        "UPDATE notes SET status = ?1, front = ?2, updated_at = ?3 WHERE id = ?4",
        params![normalized, new_front, now_ms(), note.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn create(
    conn: &Connection,
    parent_path: &str,
    title: &str,
    is_dir: bool,
) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("名字不能为空".to_string());
    }
    let parent = if parent_path.is_empty() {
        None
    } else {
        match note_by_path(conn, parent_path)?.filter(|n| n.is_dir()) {
            Some(found) => Some(found),
            // 目录不存在就顺手建出来：收件箱、材料目录就是这样按需出现的
            None => match ensure_folder(conn, parent_path, now_ms())? {
                Some(id) => note_by_id(conn, &id)?,
                None => None,
            },
        }
    };
    let path = child_path(parent.as_ref(), title);
    if note_by_path(conn, &path)?.is_some() {
        return Err(format!("「{title}」已经存在"));
    }

    let now = now_ms();
    let id = new_id();
    conn.execute(
        "INSERT INTO notes (id, parent_id, kind, title, path, status, doc_kind, front, sort,
                            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'none', ?6, '', 0, ?7, ?7)",
        params![
            id,
            parent.map(|p| p.id),
            if is_dir { "folder" } else { "note" },
            title,
            path,
            if is_dir { "folder" } else { "note" },
            now
        ],
    )
    .map_err(|e| format!("新建失败：{e}"))?;

    // 新建的笔记**不预置空段**：库里没有段，装配出来就是一张白纸，
    // 不会先看到一行「## 内化」。第一次保存时按内容自然长出一段。
    Ok(path)
}

/// 收件箱 / 材料卡这类"带初始内容"的新建。
pub fn create_with_content(
    conn: &Connection,
    parent_path: &str,
    title: &str,
    content: &str,
) -> Result<String, String> {
    let path = create(conn, parent_path, title, false)?;
    let note = note_by_path(conn, &path)?.ok_or_else(|| "新建后读不到".to_string())?;
    let (front, body) = split_front(content);
    let fm = parse_front_matter(content);
    conn.execute(
        "UPDATE notes SET front = ?1, status = ?2, doc_kind = ?3, source = ?4, captured_at = ?5
         WHERE id = ?6",
        params![
            front,
            fm.status.unwrap_or_else(|| "none".to_string()),
            fm.kind.unwrap_or_else(|| "note".to_string()),
            fm.source,
            fm.captured_at,
            note.id
        ],
    )
    .map_err(|e| e.to_string())?;
    save_parts(conn, &note.id, &split_sections(&body))?;
    index_links(conn, &path, content)?;
    Ok(path)
}

pub fn rename(conn: &Connection, path: &str, new_title: &str) -> Result<String, String> {
    let note = note_by_path(conn, path)?.ok_or_else(|| format!("找不到：{path}"))?;
    let new_title = new_title.trim();
    if new_title.is_empty() {
        return Err("名字不能为空".to_string());
    }
    let parent = match note.parent_id.as_deref() {
        Some(pid) => note_by_id(conn, pid)?,
        None => None,
    };
    let new_path = child_path(parent.as_ref(), new_title);
    if new_path != path && note_by_path(conn, &new_path)?.is_some() {
        return Err(format!("「{new_title}」已经存在"));
    }
    conn.execute(
        "UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_title, now_ms(), note.id],
    )
    .map_err(|e| e.to_string())?;
    rewrite_paths(conn, &note.id)?;
    reindex_links(conn)?;
    note_by_id(conn, &note.id)?
        .map(|fresh| fresh.path)
        .ok_or_else(|| "改名后读不到".to_string())
}

pub fn move_node(conn: &Connection, path: &str, new_parent_path: &str) -> Result<String, String> {
    let note = note_by_path(conn, path)?.ok_or_else(|| format!("找不到：{path}"))?;
    let parent = if new_parent_path.is_empty() {
        None
    } else {
        Some(
            note_by_path(conn, new_parent_path)?
                .filter(|n| n.is_dir())
                .ok_or_else(|| format!("找不到文件夹：{new_parent_path}"))?,
        )
    };
    if let Some(target) = parent.as_ref() {
        if target.path == note.path || target.path.starts_with(&format!("{}/", note.path)) {
            return Err("不能移动到自己的子目录里".to_string());
        }
    }
    conn.execute(
        "UPDATE notes SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![parent.map(|p| p.id), now_ms(), note.id],
    )
    .map_err(|e| e.to_string())?;
    rewrite_paths(conn, &note.id)?;
    reindex_links(conn)?;
    note_by_id(conn, &note.id)?
        .map(|fresh| fresh.path)
        .ok_or_else(|| "移动后读不到".to_string())
}

pub fn remove(conn: &Connection, path: &str) -> Result<(), String> {
    let note = note_by_path(conn, path)?.ok_or_else(|| format!("找不到：{path}"))?;
    let all = all_notes(conn)?;
    let mut doomed = vec![note.clone()];
    let mut frontier = vec![note.id.clone()];
    while let Some(current) = frontier.pop() {
        for child in all.iter().filter(|n| n.parent_id.as_deref() == Some(current.as_str())) {
            doomed.push(child.clone());
            frontier.push(child.id.clone());
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for item in &doomed {
        tx.execute("DELETE FROM parts WHERE note_id = ?1", [&item.id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM links WHERE from_node = ?1", [&item.path])
            .map_err(|e| e.to_string())?;
        // 卡片是笔记的一部分：笔记没了，它的卡也该没（人已经确认过一次删除）
        tx.execute("DELETE FROM cards WHERE note_id = ?1", [&item.id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM notes WHERE id = ?1", [&item.id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    retire_paths(conn, &doomed);
    remove_mirrors(conn, &doomed);
    Ok(())
}

/// 记下"用户在应用里删掉了哪些路径"。
///
/// 仓库里的 `.md` 是只写镜像，删除时虽然会一并删掉，但删不动的情况总有；
/// 而 `import_vault` 判断"要不要导入"只能看磁盘——于是删掉的笔记会在下次打开时回来。
/// 墓碑是这条链上唯一记得住"它已经不在了"的地方。
fn retire_paths(conn: &Connection, doomed: &[Note]) {
    let mut retired: Vec<String> = store::meta_get(conn, RETIRED_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    for item in doomed {
        let path = strip_note_ext(&item.path).to_string();
        if !retired.contains(&path) {
            retired.push(path);
        }
    }
    if let Ok(text) = serde_json::to_string(&retired) {
        let _ = store::meta_set(conn, RETIRED_KEY, &text);
    }
}

/// 已被用户删除、不许再导入的路径（存在 `meta` 里的墓碑清单）。
const RETIRED_KEY: &str = "retired_paths";

/// 已被用户删除、不许再导入的路径。
fn retired_paths(conn: &Connection) -> Vec<String> {
    store::meta_get(conn, RETIRED_KEY)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 顺手删掉磁盘上的 Markdown 镜像。
///
/// 不删的话，下次打开仓库时 `import_vault` 会发现"库里没有、磁盘上有"，
/// 把你刚删掉的笔记原样拉回来。删不动（被占用、权限不足）就留着，不因为一个镜像让删除失败。
fn remove_mirrors(conn: &Connection, doomed: &[Note]) {
    let Some(root) = vault_root(conn) else { return };
    for item in doomed.iter().filter(|note| !note.is_dir()) {
        let file = Path::new(&root).join(format!("{}.md", item.path));
        let _ = trash::delete(&file);
    }
    // 空的目录镜像也一并收走（里面还有东西就留着）
    for item in doomed.iter().filter(|note| note.is_dir()).rev() {
        let dir = Path::new(&root).join(&item.path);
        if dir.is_dir() && fs::read_dir(&dir).map(|mut it| it.next().is_none()).unwrap_or(false) {
            let _ = fs::remove_dir(&dir);
        }
    }
}

/// 这个库属于哪个仓库：`meta` 里记着，缺了就从库文件位置推。
fn vault_root(conn: &Connection) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = 'vault_root'", [], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .unwrap_or(None)
    .or_else(|| {
        conn.path()
            .map(PathBuf::from)
            .and_then(|file| file.parent().and_then(|dir| dir.parent()).map(PathBuf::from))
            .map(|root| root.to_string_lossy().to_string())
    })
}

// ------------------------------------------------------------------ 链接

fn index_links(conn: &Connection, from_path: &str, content: &str) -> Result<(), String> {
    conn.execute("DELETE FROM links WHERE from_node = ?1", [from_path])
        .map_err(|e| e.to_string())?;
    for (index, raw) in content.lines().enumerate() {
        let line_no = (index + 1) as i64;
        let mut rest = raw;
        while let Some(start) = rest.find("[[") {
            let after = &rest[start + 2..];
            let Some(end) = after.find("]]") else { break };
            let inner = &after[..end];
            rest = &after[end + 2..];
            if inner.contains('[') || inner.trim().is_empty() {
                continue;
            }
            let (target, alias) = match inner.split_once('|') {
                Some((target, alias)) => (target.trim(), alias.trim()),
                None => (inner.trim(), ""),
            };
            let target = target.split('#').next().unwrap_or(target).trim();
            if target.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR REPLACE INTO links (from_node, target, alias, line, context)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    from_path,
                    target,
                    alias,
                    line_no,
                    raw.trim().chars().take(160).collect::<String>()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 全量重建链接索引（改名 / 移动之后调用）。
pub fn reindex_links(conn: &Connection) -> Result<usize, String> {
    let rows = all_notes(conn)?;
    let mut count = 0usize;
    for note in rows.iter().filter(|note| !note.is_dir()) {
        let text = assemble(conn, note)?;
        index_links(conn, &note.path, &text)?;
        count += 1;
    }
    Ok(count)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    pub path: String,
    pub title: String,
    pub target: String,
    pub alias: String,
    pub line: u32,
    pub context: String,
    pub resolved: bool,
    pub target_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReport {
    pub outgoing: Vec<LinkRef>,
    pub backlinks: Vec<LinkRef>,
}

pub fn link_report(conn: &Connection, path: &str) -> Result<LinkReport, String> {
    let rows = all_notes(conn)?;
    let docs: Vec<(String, String)> = rows
        .iter()
        .filter(|note| !note.is_dir())
        .map(|note| (note.path.clone(), note.title.clone()))
        .collect();

    let resolve = |target: &str| -> Option<String> {
        let wanted = target.to_lowercase();
        docs.iter()
            .find(|(p, t)| t.to_lowercase() == wanted || p.to_lowercase() == wanted)
            .map(|(p, _)| p.clone())
    };
    let title_of = |path: &str| -> String {
        docs.iter()
            .find(|(p, _)| p == path)
            .map(|(_, t)| t.clone())
            .unwrap_or_else(|| path.to_string())
    };

    let mut outgoing = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT target, alias, line, context FROM links WHERE from_node = ?1 ORDER BY line")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for (target, alias, line, context) in mapped.flatten() {
            let target_path = resolve(&target);
            outgoing.push(LinkRef {
                path: path.to_string(),
                title: title_of(path),
                alias: if alias.is_empty() { target.clone() } else { alias },
                resolved: target_path.is_some(),
                target_path,
                target,
                line: line as u32,
                context,
            });
        }
    }

    let mut backlinks = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT from_node, target, alias, line, context FROM links ORDER BY from_node, line")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for (from, target, alias, line, context) in mapped.flatten() {
            if resolve(&target).as_deref() != Some(path) {
                continue;
            }
            backlinks.push(LinkRef {
                title: title_of(&from),
                path: from,
                target,
                alias,
                line: line as u32,
                context,
                resolved: true,
                target_path: Some(path.to_string()),
            });
        }
    }

    Ok(LinkReport { outgoing, backlinks })
}

// ------------------------------------------------------------------ 导入与导出

/// 这个仓库是不是"全新的库"：一条笔记都没有，也从来没初始化过。
///
/// 只有这种库才做自动导入（把文件夹里已有的 `.md` 收进来，见 `open_vault`）。
pub fn library_is_fresh(conn: &Connection) -> bool {
    if store::meta_get(conn, "initialized").as_deref() == Some("1") {
        return false;
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap_or(0);
    count == 0
}

/// 把仓库里**还没有记录**的 `.md` 收进库（首次打开一个已有文件夹时用）。
pub fn import_vault(conn: &Connection, root: &Path) -> Result<ImportReport, String> {
    let now = now_ms();
    let mut imported = 0usize;
    let mut folders = 0usize;
    let retired = retired_paths(conn);

    let walker = WalkDir::new(root).into_iter().filter_entry(|entry| {
        if entry.file_type().is_dir() {
            !is_skipped_dir(&entry.file_name().to_string_lossy())
        } else {
            true
        }
    });

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for entry in walker.flatten() {
        if !entry.file_type().is_file() || !is_note(entry.path()) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if rel.is_empty() {
            continue;
        }
        let note_path = rel
            .trim_end_matches(".md")
            .trim_end_matches(".markdown")
            .to_string();
        // 用户在应用里删过的路径不再导入（镜像可能还留在磁盘上）
        if retired.contains(&note_path) {
            continue;
        }
        if note_by_path(&tx, &note_path)?.is_some() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(entry.path()) else { continue };
        let content = raw.strip_prefix('\u{feff}').unwrap_or(&raw).to_string();

        let (dir, title) = match note_path.rsplit_once('/') {
            Some((dir, title)) => (dir.to_string(), title.to_string()),
            None => (String::new(), note_path.clone()),
        };
        let parent_id = if dir.is_empty() {
            None
        } else {
            let before: i64 = tx
                .query_row("SELECT COUNT(*) FROM notes WHERE kind = 'folder'", [], |r| r.get(0))
                .unwrap_or(0);
            let id = ensure_folder(&tx, &dir, now)?;
            let after: i64 = tx
                .query_row("SELECT COUNT(*) FROM notes WHERE kind = 'folder'", [], |r| r.get(0))
                .unwrap_or(0);
            folders += (after - before) as usize;
            id
        };

        let (front, body) = split_front(&content);
        let fm = parse_front_matter(&content);
        let note_id = new_id();
        tx.execute(
            "INSERT INTO notes (id, parent_id, kind, title, path, status, doc_kind, source,
                                captured_at, front, sort, created_at, updated_at)
             VALUES (?1, ?2, 'note', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
            params![
                note_id,
                parent_id,
                title,
                note_path,
                fm.status.unwrap_or_else(|| "none".to_string()),
                fm.kind.unwrap_or_else(|| "note".to_string()),
                fm.source,
                fm.captured_at,
                front,
                now
            ],
        )
        .map_err(|e| format!("导入 {note_path} 失败：{e}"))?;
        save_parts(&tx, &note_id, &split_sections(&body))?;
        index_links(&tx, &note_path, &content)?;
        imported += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ImportReport { imported, folders })
}

/// 导出全部笔记为 Markdown（归档 / 迁移 / 分享）。
pub fn export_markdown(conn: &Connection, out_dir: &Path) -> Result<usize, String> {
    let rows = all_notes(conn)?;
    fs::create_dir_all(out_dir).map_err(|e| format!("创建导出目录失败：{e}"))?;
    let mut written = 0usize;
    for note in rows.iter().filter(|note| !note.is_dir()) {
        let content = assemble(conn, note)?;
        let target = out_dir.join(format!("{}.md", note.path));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        fs::write(&target, content).map_err(|e| format!("写 {} 失败：{e}", note.path))?;
        written += 1;
    }
    Ok(written)
}

/// 把老库整理成集合模型（幂等，可在每次打开仓库时跑）：
///
/// 1. `nodes` 里的文件夹与父子关系补进 `notes`（否则树是平的）
/// 2. 「内化」段里残留的 frontmatter 摘到 `notes.front`
/// 3. 删掉块索引——卡片已经自带快照，不再依赖它
/// 4. 收拾带扩展名的重复路径（`笔记方法/检索练习.md`）
/// 5. 收拾"三段"时代的残留：空段删掉，正文里的 `## 内化` 之类标题去掉，多段并成一段
pub fn migrate_collections(conn: &Connection) -> Result<usize, String> {
    let now = now_ms();
    let mut moved = 0usize;

    // 1) 文件夹
    let folders: Vec<(String, Option<String>, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, parent_id, title, path FROM nodes WHERE kind = 'folder'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().unwrap_or_default()
    };
    for (id, parent, title, path) in folders {
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO notes (id, parent_id, kind, title, path, status, doc_kind,
                                              front, sort, created_at, updated_at)
                 VALUES (?1, ?2, 'folder', ?3, ?4, 'none', 'folder', '', 0, ?5, ?5)",
                params![id, parent, title, path, now],
            )
            .map_err(|e| format!("补文件夹失败：{e}"))?;
        moved += changed;
    }

    // 2) 父子关系（笔记行也要，否则树是平的）
    let _ = conn.execute(
        "UPDATE notes SET parent_id = (SELECT n.parent_id FROM nodes n WHERE n.id = notes.id)
         WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.id = notes.id)",
        [],
    );

    // 3) 把内化段里的 frontmatter 摘到 notes.front（旧迁移把整篇原样放进去了）
    let parts: Vec<(String, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, note_id, content FROM parts WHERE role = 'internalize'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().unwrap_or_default()
    };
    for (part_id, note_id, content) in parts {
        if !content.trim_start().starts_with("---") {
            continue;
        }
        let (front, body) = split_front(&content);
        if front.is_empty() {
            continue;
        }
        let existing: String = conn
            .query_row("SELECT COALESCE(front, '') FROM notes WHERE id = ?1", [&note_id], |r| r.get(0))
            .unwrap_or_default();
        if existing.trim().is_empty() {
            conn.execute("UPDATE notes SET front = ?1 WHERE id = ?2", params![front, note_id])
                .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE parts SET content = ?1 WHERE id = ?2",
            params![body.trim().to_string(), part_id],
        )
        .map_err(|e| e.to_string())?;
        moved += 1;
    }

    // 4) 块索引退场
    let _ = conn.execute("DROP TABLE IF EXISTS blocks", []);

    // 5) 老路径的 `.md` 重复行退场（见函数注释）
    moved += retire_extension_paths(conn)?;

    // 6) "三段"时代的残留退场
    moved += retire_section_parts(conn)?;

    reindex_links(conn)?;
    Ok(moved)
}

/// 收拾"一篇笔记由输入 / 内化 / 输出三段组成"那个模型留下的痕迹。
///
/// 三件事，都只碰"应用自己加的东西"：
/// - 空段删掉（从前新建笔记会预置一个空的「内化」段，它让每篇笔记都顶着一行标题）
/// - 正文里行首的 `## 输入 / ## 内化 / ## 输出` 去掉（是装配时写进去的，用户没写过）
/// - 剩下多段就并成一段：角色在库里仍有列，但正文只有一段
fn retire_section_parts(conn: &Connection) -> Result<usize, String> {
    let notes = all_notes(conn)?;
    let mut changed = 0usize;

    for note in notes.iter().filter(|note| !note.is_dir()) {
        let parts = parts_of(conn, &note.id)?;
        if parts.is_empty() {
            continue; // 新建的笔记就是没有段，正常
        }

        let mut kept: Vec<Part> = Vec::new();
        for part in parts {
            if part.content.trim().is_empty() {
                conn.execute("DELETE FROM parts WHERE id = ?1", [&part.id])
                    .map_err(|e| e.to_string())?;
                changed += 1;
                continue;
            }
            let cleaned = strip_role_headers(&part.content).trim().to_string();
            if cleaned != part.content {
                changed += 1;
            }
            kept.push(Part {
                content: cleaned,
                ..part
            });
        }

        match kept.len() {
            0 => {}
            1 => {
                let only = &kept[0];
                conn.execute(
                    "UPDATE parts SET role = 'internalize', title = '', content = ?1, updated_at = ?2
                     WHERE id = ?3",
                    params![only.content, now_ms(), only.id],
                )
                .map_err(|e| e.to_string())?;
            }
            _ => {
                let joined = kept
                    .iter()
                    .map(|part| part.content.trim())
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n");
                let keep_id = kept[0].id.clone();
                // 标题只在唯一一段上有意义，合并时丢掉
                conn.execute(
                    "UPDATE parts SET role = 'internalize', title = '', content = ?1, updated_at = ?2
                     WHERE id = ?3",
                    params![joined, now_ms(), keep_id],
                )
                .map_err(|e| e.to_string())?;
                for extra in kept.iter().skip(1) {
                    conn.execute("DELETE FROM parts WHERE id = ?1", [&extra.id])
                        .map_err(|e| e.to_string())?;
                }
                changed += 1;
            }
        }
    }

    Ok(changed)
}

/// 收拾"同一个文件在库里有两行"的历史遗留。
///
/// 卡片时代之前路径带扩展名（`笔记方法/检索练习.md`），现在规范化成不带扩展名
/// （`笔记方法/检索练习`）。迁移只搬了正文与卡片，老行留在表里，于是文件面板里会出现
/// 两个同名笔记——真正的笔记是**卡片挂在谁身上**的那一个，另一个是空壳。
///
/// 规则（顺序很重要，并且只做"没有歧义"的事）：
/// - 同一个文件（忽略扩展名后路径相同）有两行：**把卡片与正文归到不带扩展名的那一行**，
///   再删掉带扩展名的老行。卡片是绝对不能再丢的——它们是复习进度。
/// - 只有带扩展名的一行、而且它有卡片：只把路径规范化，笔记留住。
/// - 只有带扩展名的一行、内容与磁盘上的 Markdown 镜像一样：那是导入留下的空壳，
///   删掉。"库里删掉的笔记，下次打开又被导入回来"是明确写在设计里的反面行为
///   （见 `docs/rnote-storage.md`：Markdown 是只写镜像，永远不读回来）。
fn retire_extension_paths(conn: &Connection) -> Result<usize, String> {
    let rows: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, path FROM notes
                 WHERE kind = 'note' AND (path LIKE '%.md' OR path LIKE '%.markdown')",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        mapped.collect::<Result<Vec<_>, _>>().unwrap_or_default()
    };

    let mut moved = 0usize;
    for (legacy_id, legacy_path) in rows {
        let canonical = strip_note_ext(&legacy_path).to_string();
        let twin: Option<String> = conn
            .query_row(
                "SELECT id FROM notes WHERE path = ?1 AND kind = 'note'",
                [&canonical],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match twin {
            Some(twin_id) => {
                let cards = migrate_cards(conn, &legacy_id, &twin_id)?;
                let parts = migrate_parts(conn, &legacy_id, &twin_id)?;
                // 老行已经空了：卡片和正文都在真身那边
                conn.execute("DELETE FROM notes WHERE id = ?1", [&legacy_id])
                    .map_err(|e| format!("清理重复笔记 {legacy_path} 失败：{e}"))?;
                moved += 1 + cards + parts;
            }
            None => {
                if has_cards(conn, &legacy_id)? {
                    conn.execute(
                        "UPDATE notes SET path = ?1 WHERE id = ?2",
                        params![canonical, legacy_id],
                    )
                    .map_err(|e| format!("去掉扩展名失败：{e}"))?;
                    moved += 1;
                } else if is_mirror_shell(conn, &legacy_id, &legacy_path)? {
                    conn.execute("DELETE FROM notes WHERE id = ?1", [&legacy_id])
                        .map_err(|e| format!("清理空壳 {legacy_path} 失败：{e}"))?;
                    moved += 1;
                } else {
                    conn.execute(
                        "UPDATE notes SET path = ?1 WHERE id = ?2",
                        params![canonical, legacy_id],
                    )
                    .map_err(|e| format!("去掉扩展名失败：{e}"))?;
                    moved += 1;
                }
            }
        }
    }
    Ok(moved)
}

/// 笔记路径的规范化形式：去掉 `.md` / `.markdown`。
pub fn strip_note_ext(path: &str) -> &str {
    path.strip_suffix(".markdown")
        .or_else(|| path.strip_suffix(".md"))
        .unwrap_or(path)
}

fn has_cards(conn: &Connection, note_id: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards WHERE note_id = ?1", [note_id], |row| {
            row.get(0)
        })
        .unwrap_or(0);
    Ok(count > 0)
}

/// 把老行的卡片挪到真身身上；同一个问题（指纹相同）只留真身已有的那张，多出来的删掉。
/// 返回处理掉的卡片数。
fn migrate_cards(conn: &Connection, from: &str, to: &str) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM cards WHERE note_id = ?1
           AND EXISTS (SELECT 1 FROM cards k WHERE k.note_id = ?2 AND k.fingerprint = cards.fingerprint)",
        params![from, to],
    )
    .map_err(|e| format!("合并重复卡片失败：{e}"))?;
    conn.execute("UPDATE cards SET note_id = ?1 WHERE note_id = ?2", params![to, from])
        .map_err(|e| format!("迁移卡片归属失败：{e}"))
}

/// 老行的正文挪到真身身上（真身已经有正文就不动）。返回挪动的段数。
fn migrate_parts(conn: &Connection, from: &str, to: &str) -> Result<usize, String> {
    let has_body: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM parts WHERE note_id = ?1 AND TRIM(content) <> ''",
            [to],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_body > 0 {
        return Ok(0);
    }
    conn.execute("UPDATE parts SET note_id = ?1 WHERE note_id = ?2", params![to, from])
        .map_err(|e| format!("迁移正文失败：{e}"))
}

/// 这一行是不是"什么都没加过"的镜像空壳：正文与磁盘上的 Markdown 一模一样。
///
/// 用来避免把用户删掉的笔记又拉回库里。磁盘上的镜像读不到时（比如笔记从没导出过）
/// 返回 false——宁可留着，也不要凭猜测删掉用户的东西。
fn is_mirror_shell(conn: &Connection, note_id: &str, path: &str) -> Result<bool, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT content FROM parts WHERE note_id = ?1 AND TRIM(content) <> '' ORDER BY position LIMIT 1",
            [note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(text) = text else {
        return Ok(true); // 一点正文都没有，留着也没有意义
    };
    let root = vault_root(conn);
    let Some(root) = root else {
        return Ok(false);
    };
    let file = Path::new(&root).join(format!("{path}.md"));
    let Ok(disk) = fs::read_to_string(&file) else {
        return Ok(false);
    };
    let disk = disk.strip_prefix('\u{feff}').unwrap_or(&disk);
    let (_, body) = split_front(disk);
    Ok(normalize_text(&body) == normalize_text(&text))
}

fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_string()
}

/// 某篇笔记的段（左栏/右栏展示用）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartRow {
    pub id: String,
    pub role: String,
    pub label: String,
    pub title: String,
    pub position: i64,
    pub chars: usize,
}

pub fn parts_summary(conn: &Connection, path: &str) -> Result<Vec<PartRow>, String> {
    let note = note_by_path(conn, path)?.ok_or_else(|| format!("找不到笔记：{path}"))?;
    Ok(parts_of(conn, &note.id)?
        .into_iter()
        .map(|part| PartRow {
            label: ROLES
                .iter()
                .find(|(key, _)| *key == part.role)
                .map(|(_, label)| label.to_string())
                .unwrap_or_else(|| part.role.clone()),
            chars: part.content.chars().count(),
            id: part.id,
            role: part.role,
            title: part.title,
            position: part.position,
        })
        .collect())
}

// ------------------------------------------------------------------ 单元测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn temp_env(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("hn-notes2-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let conn = store::open(&dir).unwrap();
        (dir, conn)
    }

    #[test]
    fn import_keeps_frontmatter_and_builds_tree() {
        let (root, conn) = temp_env("assemble");
        fs::create_dir_all(root.join("笔记方法")).unwrap();
        fs::write(
            root.join("笔记方法/甲.md"),
            "---\nstatus: 内化\ntags: [a, b]\n---\n\n- 一条陈述\n",
        )
        .unwrap();
        let report = import_vault(&conn, &root).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.folders, 1);

        let note = note_by_path(&conn, "笔记方法/甲").unwrap().unwrap();
        assert_eq!(note.status, "internalizing");
        assert!(note.front.contains("tags: [a, b]"), "用户自己的键要保留");

        let text = read(&conn, "笔记方法/甲").unwrap().content;
        assert!(text.starts_with("---\nstatus: 内化"), "{text}");
        assert!(text.contains("tags: [a, b]"));
        assert!(text.contains("一条陈述"));
        assert!(!text.contains("## 内化"), "导入的正文不该被套上角色标题：{text}");

        let tree = tree(&conn).unwrap();
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].children[0].path, "笔记方法/甲");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tree_shows_folders_even_when_notes_have_no_parent_row() {
        let (root, conn) = temp_env("tree-paths");
        let now = now_ms();
        // v5 之后从磁盘导入的老笔记就是这个样子：parent_id 空着，路径里却带着目录
        for (id, title, path) in [
            ("n1", "甲", "笔记方法/甲"),
            ("n2", "乙", "笔记方法/深一层/乙"),
            ("n3", "丙", "项目/丙"),
        ] {
            conn.execute(
                "INSERT INTO notes (id, parent_id, kind, title, path, status, doc_kind, front, sort,
                                    created_at, updated_at)
                 VALUES (?1, NULL, 'note', ?2, ?3, 'none', 'note', '', 0, ?4, ?4)",
                params![id, title, path, now],
            )
            .unwrap();
        }
        // 库里真实的文件夹（新建时建的）也要保住，且带 id
        conn.execute(
            "INSERT INTO notes (id, parent_id, kind, title, path, status, doc_kind, front, sort,
                                created_at, updated_at)
             VALUES ('d1', NULL, 'folder', '空目录', '空目录', 'none', 'folder', '', 0, ?1, ?1)",
            [now],
        )
        .unwrap();

        let tree = tree(&conn).unwrap();
        let names: Vec<&str> = tree.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["空目录", "笔记方法", "项目"], "目录在前，按名字排序");

        let notes_dir = tree.iter().find(|node| node.path == "笔记方法").unwrap();
        assert!(notes_dir.is_dir);
        let inner: Vec<&str> = notes_dir.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(inner, vec!["深一层", "甲"], "目录在前，文件在后");

        let deep = notes_dir
            .children
            .iter()
            .find(|node| node.path == "笔记方法/深一层")
            .unwrap();
        assert_eq!(deep.children[0].path, "笔记方法/深一层/乙");
        assert_eq!(deep.children[0].id.as_deref(), Some("n2"));
        assert!(!deep.children[0].is_dir);
        assert!(!deep.children[0].path.ends_with(".md"), "路径里不带扩展名");

        // 空目录由库里的行留着；路径推导出来的目录是正常的深层目录
        let empty = tree.iter().find(|node| node.path == "空目录").unwrap();
        assert!(empty.children.is_empty());
        assert_eq!(empty.id.as_deref(), Some("d1"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_extension_paths_are_retired_without_losing_notes() {
        let (root, conn) = temp_env("legacy-md");
        let now = now_ms();
        let insert = |id: &str, title: &str, path: &str| {
            conn.execute(
                "INSERT INTO notes (id, parent_id, kind, title, path, status, doc_kind, front, sort,
                                    created_at, updated_at)
                 VALUES (?1, NULL, 'note', ?2, ?3, 'none', 'note', '', 0, ?4, ?4)",
                params![id, title, path, now],
            )
            .unwrap();
        };
        let add_card = |id: i64, note_id: &str, question: &str, answer: &str| {
            conn.execute(
                "INSERT INTO cards (id, ordinal, kind, question, answer, angle, fingerprint, line,
                                    note_id, source_text, source_heading, source_line)
                 VALUES (?1, 0, 'qa', ?2, ?3, '回忆', ?4, 3, ?5, ?3, '内化', 3)",
                params![id, question, answer, format!("fp{id}"), note_id],
            )
            .unwrap();
        };
        let add_part = |id: &str, note_id: &str, content: &str| {
            conn.execute(
                "INSERT INTO parts (id, note_id, role, title, position, content, created_at, updated_at)
                 VALUES (?1, ?2, 'internalize', '', 0, ?3, ?4, ?4)",
                params![id, note_id, content, now],
            )
            .unwrap();
        };

        // 真身（集合模型）与它的老行：老行身上挂着卡片、也有正文
        insert("new1", "检索练习", "笔记方法/检索练习");
        add_part("p-new", "new1", "真身的正文");
        insert("old1", "检索练习", "笔记方法/检索练习.md");
        add_part("p-old", "old1", "老行的正文");
        add_card(1, "old1", "为什么检索练习比重复阅读有效？", "因为回忆会强化提取路径。");
        add_card(2, "old1", "我在什么时候用过检索练习？", "上周复习时。");
        // 只有老路径、但有卡片：必须只改路径，不许删
        insert("old2", "孤本", "项目/孤本.md");
        add_card(3, "old2", "孤本讲了什么？", "孤本的答案。");

        migrate_collections(&conn).unwrap();

        let mut paths: Vec<String> = all_notes(&conn)
            .unwrap()
            .into_iter()
            .map(|note| note.path)
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["笔记方法/检索练习", "项目/孤本"]);
        let kept = note_by_path(&conn, "笔记方法/检索练习").unwrap().unwrap();
        assert_eq!(kept.id, "new1", "留下的应当是集合模型那一行");

        // **卡片是复习进度，一张都不能丢**：两张都归到真身身上
        let cards = {
            let mut stmt = conn
                .prepare("SELECT note_id, question FROM cards ORDER BY id")
                .unwrap();
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(cards.len(), 3, "三张卡都还在：{cards:?}");
        assert!(cards.iter().all(|(note_id, _)| note_id != "old1"), "{cards:?}");
        assert_eq!(
            cards.iter().filter(|(note_id, _)| note_id == "new1").count(),
            2,
            "老行挂的卡片要挪到真身身上"
        );
        let orphan = note_by_path(&conn, "项目/孤本").unwrap().unwrap();
        assert_eq!(orphan.id, "old2");

        // 幂等：再跑一次什么都不发生
        assert_eq!(migrate_collections(&conn).unwrap(), 0);

        let _ = fs::remove_dir_all(&root);
    }

    /// 用户删掉的笔记，不该因为磁盘上还留着 `.md` 就回到库里。
    ///
    /// 库是全部：导入只发生在"全新的库"上，之后磁盘上那些 `.md` 文件跟应用再没关系。
    #[test]
    fn notes_are_only_imported_once_when_the_library_is_fresh() {
        let (root, conn) = temp_env("import-once");
        fs::create_dir_all(root.join("笔记方法")).unwrap();
        fs::write(root.join("笔记方法/甲.md"), "---\nstatus: 内化\n---\n\n甲的内容\n").unwrap();

        assert!(library_is_fresh(&conn), "刚建的库应当是全新的");
        assert_eq!(import_vault(&conn, &root).unwrap().imported, 1);
        store::meta_set(&conn, "initialized", "1").unwrap();
        assert!(!library_is_fresh(&conn), "标记过初始化就不再是全新的库");

        // 用户在应用里删掉了这篇（镜像是外部文件，删不删都不影响库）
        remove(&conn, "笔记方法/甲").unwrap();
        assert!(notes(&conn).unwrap().is_empty());

        // 再打开仓库：磁盘上那个 .md 还在，但不该再被收进来
        assert!(!library_is_fresh(&conn));
        assert!(notes(&conn).unwrap().is_empty(), "库是全部，导入只做一次");

        // 库里有了别的笔记之后，同样不会再自动导入
        create(&conn, "", "新的甲", false).unwrap();
        assert!(!library_is_fresh(&conn));
        assert_eq!(notes(&conn).unwrap().len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    /// 用户删掉的笔记，不该因为磁盘上还留着 `.md` 文件就被拉回库里。
    #[test]
    fn a_deleted_note_is_not_resurrected_from_a_leftover_markdown_file() {
        let (root, conn) = temp_env("legacy-shell");
        fs::create_dir_all(root.join("笔记方法")).unwrap();
        fs::write(root.join("笔记方法/甲.md"), "---\nstatus: 内化\n---\n\n甲的内容\n").unwrap();
        import_vault(&conn, &root).unwrap();
        store::meta_set(&conn, "initialized", "1").unwrap();
        assert_eq!(notes(&conn).unwrap().len(), 1);

        // 用户在应用里删掉了这篇
        remove(&conn, "笔记方法/甲").unwrap();
        assert!(notes(&conn).unwrap().is_empty());
        assert!(!root.join("笔记方法/甲.md").exists(), "磁盘上的那份也跟着走");

        // 下次打开仓库时不会又冒出来：导入只在"全新的库"上做，而且这篇磁盘上也没了
        let report = import_guarded(&conn, &root).unwrap();
        assert_eq!(report.imported, 0);
        migrate_collections(&conn).unwrap();
        assert!(notes(&conn).unwrap().is_empty(), "删掉的笔记不该自己回来");

        // 兜底那一层也要成立：镜像还在（比如删进了回收站又还原）时，墓碑挡住导入；
        // 就算漏了，空壳也会被整理清掉
        fs::write(root.join("笔记方法/甲.md"), "---\nstatus: 内化\n---\n\n甲的内容\n").unwrap();
        assert_eq!(import_guarded(&conn, &root).unwrap().imported, 0, "墓碑要挡住它");
        migrate_collections(&conn).unwrap();
        assert!(
            notes(&conn).unwrap().is_empty(),
            "空壳应当被清掉，而不是变成一篇笔记：{:?}",
            notes(&conn).unwrap().iter().map(|n| n.path.clone()).collect::<Vec<_>>()
        );

        // 墓碑只认路径：之后新建的笔记照常导入（这里直接调 import_vault，
        // 绕开"只导一次"那层闸门，专门验墓碑本身）
        fs::write(root.join("笔记方法/乙.md"), "---\nstatus: 内化\n---\n\n乙的内容\n").unwrap();
        assert_eq!(import_vault(&conn, &root).unwrap().imported, 1);
        assert_eq!(notes(&conn).unwrap().len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    /// 与 `open_vault` 同一条路径：只有全新的库才导入。
    fn import_guarded(conn: &Connection, root: &Path) -> Result<ImportReport, String> {
        if !library_is_fresh(conn) {
            return Ok(ImportReport {
                imported: 0,
                folders: 0,
            });
        }
        import_vault(conn, root)
    }

    /// 新建的笔记是一张白纸：不该带上「## 内化」这种空小节标题。
    #[test]
    fn a_new_note_is_empty_and_grows_its_first_section_on_save() {
        let (root, conn) = temp_env("empty-note");
        let path = create(&conn, "", "白纸", false).unwrap();

        assert_eq!(read(&conn, &path).unwrap().content, "", "新建的笔记应当是空的");
        let note = note_by_path(&conn, &path).unwrap().unwrap();
        assert!(parts_of(&conn, &note.id).unwrap().is_empty(), "不该预置空段");

        // 什么都不写就保存：还是空的（没有内容就不该长出小节）
        write(&conn, &path, "", None).unwrap();
        assert_eq!(read(&conn, &path).unwrap().content, "", "空文档不该装配出标题");

        // 写了东西就是正经正文，不会再被套上「## 内化」
        write(&conn, &path, "第一句话\n", None).unwrap();
        assert_eq!(read(&conn, &path).unwrap().content, "第一句话\n");

        // 用户自己写的小节标题（不是 输入/内化/输出 那三个角色名）照旧留着
        write(&conn, &path, "## 卡片盒\n\n甲\n\n## 我的加工\n\n乙\n", None).unwrap();
        let text = read(&conn, &path).unwrap().content;
        assert_eq!(text, "## 卡片盒\n\n甲\n\n## 我的加工\n\n乙\n", "{text}");

        let _ = fs::remove_dir_all(&root);
    }

    /// 旧的 `## 输入 / ## 内化 / ## 输出` 不会再出现在正文里。
    #[test]
    fn role_headers_never_reach_the_document() {
        let (root, conn) = temp_env("role-headers");
        create(&conn, "", "三段时代", false).unwrap();
        write(&conn, "", "", None).unwrap_err(); // 空路径应当报错，不该静默
        let doc = "---\nstatus: internalizing\n---\n\n## 输入\n\n得到课程第 3 讲\n\n## 内化\n\n- 检索练习有效\n\n## 输出\n\n我的一篇成品\n";
        write(&conn, "三段时代", doc, None).unwrap();

        let text = read(&conn, "三段时代").unwrap().content;
        assert!(!text.contains("## 输入"), "{text}");
        assert!(!text.contains("## 内化"), "{text}");
        assert!(!text.contains("## 输出"), "{text}");
        // 内容一个字不少，只是合并成一篇正文
        assert!(text.contains("得到课程第 3 讲"), "{text}");
        assert!(text.contains("- 检索练习有效"), "{text}");
        assert!(text.contains("我的一篇成品"), "{text}");
        assert!(text.starts_with("---\nstatus: internalizing"), "{text}");

        // 库里只有一段，而且往返稳定
        let note = note_by_path(&conn, "三段时代").unwrap().unwrap();
        let parts = parts_of(&conn, &note.id).unwrap();
        assert_eq!(parts.len(), 1, "多段应当并为一段：{parts:?}");
        assert_eq!(parts[0].role, "internalize");
        write(&conn, "三段时代", &text, None).unwrap();
        assert_eq!(text, read(&conn, "三段时代").unwrap().content, "往返应当稳定");

        let _ = fs::remove_dir_all(&root);
    }

    /// 老库里"每篇都顶着一行内化"的残留，打开仓库时会被收拾干净。
    #[test]
    fn section_parts_are_retired_on_migration() {
        let (root, conn) = temp_env("retire-sections");
        create(&conn, "", "老笔记", false).unwrap();
        let note = note_by_path(&conn, "老笔记").unwrap().unwrap();
        let now = now_ms();
        // 造出三段时代的形态：一个空段 + 两段带正文，正文里还带着角色标题
        for (id, role, content) in [
            ("p1", "internalize", ""),
            ("p2", "input", "## 输入\n\n材料原文\n"),
            ("p3", "internalize", "## 内化\n\n我的加工\n"),
        ] {
            conn.execute(
                "INSERT INTO parts (id, note_id, role, title, position, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '', 0, ?4, ?5, ?5)",
                params![id, note.id, role, content, now],
            )
            .unwrap();
        }

        assert!(retire_section_parts(&conn).unwrap() > 0);

        let parts = parts_of(&conn, &note.id).unwrap();
        assert_eq!(parts.len(), 1, "空段删掉、两段并一段：{parts:?}");
        assert_eq!(parts[0].role, "internalize");
        assert_eq!(parts[0].content, "材料原文\n\n我的加工");
        assert_eq!(read(&conn, "老笔记").unwrap().content, "材料原文\n\n我的加工\n");

        // 幂等
        assert_eq!(retire_section_parts(&conn).unwrap(), 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_splits_sections_into_parts() {
        let (root, conn) = temp_env("split");
        create(&conn, "", "集合", false).unwrap();
        let doc = "---\nstatus: internalizing\n---\n\n## 输入\n\n得到课程第 3 讲\n\n## 内化\n\n- 检索练习有效\n\n## 输出\n\n我的一篇成品\n";
        write(&conn, "集合", doc, None).unwrap();

        let note = note_by_path(&conn, "集合").unwrap().unwrap();
        let parts = parts_of(&conn, &note.id).unwrap();
        assert_eq!(parts.len(), 1, "现在一篇笔记只有一段正文");
        assert_eq!(parts[0].role, "internalize");
        assert!(parts[0].content.contains("得到课程第 3 讲"));
        assert!(parts[0].content.contains("- 检索练习有效"));
        assert!(parts[0].content.contains("我的一篇成品"));

        // frontmatter 单独存档，不在正文里
        assert_eq!(note.status, "internalizing");
        assert!(read(&conn, "集合").unwrap().content.starts_with("---\nstatus: internalizing"));

        // 装配是拆解的逆运算：读回来再存一遍，内容不变
        let text = read(&conn, "集合").unwrap().content;
        write(&conn, "集合", &text, None).unwrap();
        let again = parts_of(&conn, &note.id).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(text, read(&conn, "集合").unwrap().content, "往返应当稳定");

        // 普通正文照旧
        write(&conn, "集合", "就是一整篇普通笔记\n\n再来一段\n", None).unwrap();
        let parts = parts_of(&conn, &note.id).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].role, "internalize");
        assert!(parts[0].content.contains("就是一整篇普通笔记"));

        let _ = fs::remove_dir_all(&root);
    }

    /// 从前 `## 输入 · 第一讲` 这种带标题的多段模型，现在归成一段正文：
    /// 内容一个字不丢，只是不再有"段"这层壳。
    #[test]
    fn titled_sections_collapse_into_one_body() {
        let (root, conn) = temp_env("multipart");
        create(&conn, "", "多份输入", false).unwrap();
        write(
            &conn,
            "多份输入",
            "## 输入 · 第一讲\n\n甲\n\n## 输入 · 第二讲\n\n乙\n\n## 内化\n\n丙\n",
            None,
        )
        .unwrap();
        let note = note_by_path(&conn, "多份输入").unwrap().unwrap();
        let parts = parts_of(&conn, &note.id).unwrap();
        assert_eq!(parts.len(), 1, "只有一段正文：{parts:?}");
        assert_eq!(parts[0].content, "甲\n\n乙\n\n丙");

        let text = read(&conn, "多份输入").unwrap().content;
        assert_eq!(text, "甲\n\n乙\n\n丙\n");
        assert!(!text.contains("## 输入"), "{text}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn crud_and_search_work_on_notes() {
        let (root, conn) = temp_env("crud");
        create(&conn, "", "项目", true).unwrap();
        let note = create(&conn, "项目", "计划", false).unwrap();
        assert_eq!(note, "项目/计划");

        write(&conn, "项目/计划", "锚定效应讲的是参考点\n", None).unwrap();
        let hits = search(&conn, "锚定").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "项目/计划");
        assert_eq!(hits[0].title, "计划");

        let renamed = rename(&conn, "项目", "归档项目").unwrap();
        assert_eq!(renamed, "归档项目");
        assert!(note_by_path(&conn, "归档项目/计划").unwrap().is_some());
        assert!(note_by_path(&conn, "项目/计划").unwrap().is_none());

        let moved = move_node(&conn, "归档项目/计划", "").unwrap();
        assert_eq!(moved, "计划");
        remove(&conn, "计划").unwrap();
        assert!(note_by_path(&conn, "计划").unwrap().is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn links_are_indexed_from_parts() {
        let (root, conn) = temp_env("links");
        create_with_content(&conn, "", "甲", "## 内化\n\n一条陈述\n").unwrap();
        create_with_content(&conn, "", "乙", "## 内化\n\n回到 [[甲]] 看看\n").unwrap();

        let report = link_report(&conn, "乙").unwrap();
        assert_eq!(report.outgoing.len(), 1);
        assert!(report.outgoing[0].resolved);
        assert_eq!(report.outgoing[0].target_path.as_deref(), Some("甲"));

        let back = link_report(&conn, "甲").unwrap();
        assert_eq!(back.backlinks.len(), 1);
        assert_eq!(back.backlinks[0].path, "乙");

        // 改名之后链接按新路径重排
        rename(&conn, "甲", "甲改").unwrap();
        let report = link_report(&conn, "乙").unwrap();
        assert!(!report.outgoing[0].resolved, "旧目标名已失效");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn export_writes_assembled_markdown() {
        let (root, conn) = temp_env("export2");
        create_with_content(&conn, "", "甲", "---\nstatus: 内化\n---\n\n正文甲\n").unwrap();
        let out = root.join("导出");
        assert_eq!(export_markdown(&conn, &out).unwrap(), 1);
        let text = fs::read_to_string(out.join("甲.md")).unwrap();
        assert!(text.contains("status: 内化"), "frontmatter 要带上：{text}");
        assert!(text.contains("正文甲"));
        assert!(!text.contains("## 内化"), "角色标题不该出现在导出里：{text}");
        let _ = fs::remove_dir_all(&root);
    }
}
