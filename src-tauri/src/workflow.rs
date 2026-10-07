//! 工作流：frontmatter 状态、笔记级同步、快速捕获、材料导入。
//!
//! 块 / 卡片的解析已经交给 `rnote.rs`（保存与导入时建立索引），本文件里早期那套
//! 「轻量正则计数器」（count_blocks_and_cards 等）已被取代，留作参考。
#![allow(dead_code)]
//!
//! 设计见 `docs/workflow-design.md`（三段流水线）与 `docs/rnote-storage.md`（存储与关联）。
//! 本模块只做 **P0**：笔记级的索引与状态。块与卡片的表在 P1 加入。

use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Instant;

use crate::store;
use crate::vault::Vault;

// ------------------------------------------------------------------ 常量

pub const ST_NONE: &str = "none";
pub const ST_INBOX: &str = "inbox";
pub const ST_INTERNALIZING: &str = "internalizing";
pub const ST_OUTPUT: &str = "output";
pub const ST_ARCHIVED: &str = "archived";

/// 收集区与归档区的默认目录名。
pub const CAPTURE_DIR: &str = "00-输入/收件箱";
pub const MATERIAL_DIR: &str = "00-输入/材料";
pub const ATTACH_DIR: &str = "attachments";

/// 单个笔记参与同步的最大体积，超过就只登记路径不做解析。
const MAX_SYNC_BYTES: u64 = 2 * 1024 * 1024;

// ------------------------------------------------------------------ 数据结构

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNote {
    pub path: String,
    pub title: String,
    pub status: String,
    pub kind: String,
    pub source: Option<String>,
    pub captured_at: Option<String>,
    pub mtime: i64,
    /// 正文字数（三段合计）
    pub chars: u32,
    pub card_count: u32,
    pub missing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub scanned: usize,
    pub updated: usize,
    pub missing: usize,
    pub elapsed_ms: u128,
}

/// frontmatter 的解析结果（只认我们关心的几个键）。
#[derive(Debug, Default, Clone)]
pub struct FrontMatter {
    pub present: bool,
    /// 正文起始的字节偏移（结束的 `---` 那一行之后）。
    pub body_offset: usize,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub source: Option<String>,
    pub captured_at: Option<String>,
    /// 永久笔记 id，P1 里给有卡片的笔记懒写入。
    pub rn_id: Option<String>,
}

// ------------------------------------------------------------------ frontmatter

/// 解析开头的 YAML frontmatter。第一行不是 `---`、或没有收尾的 `---`，都当没有。
pub fn parse_front_matter(text: &str) -> FrontMatter {
    let mut fm = FrontMatter::default();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);

    let Some(rest) = text.strip_prefix("---") else {
        return fm;
    };
    let Some(rest) = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')) else {
        return fm;
    };

    let mut offset = text.len() - rest.len();
    let mut body_offset = None;
    for line in rest.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']).trim_end();
        if bare == "---" {
            body_offset = Some(offset + line.len());
            break;
        }
        offset += line.len();
    }
    let Some(body_offset) = body_offset else {
        return fm;
    };

    fm.present = true;
    fm.body_offset = body_offset;

    for line in text[..body_offset].lines().skip(1) {
        let line = line.trim();
        if line.is_empty() || line == "---" || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim()
            .to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "status" => fm.status = Some(normalize_status(&value)),
            "type" | "kind" => fm.kind = Some(normalize_kind(&value)),
            "source" => fm.source = Some(value),
            "captured" | "captured_at" | "created" => fm.captured_at = Some(value),
            "rn_id" => fm.rn_id = Some(value),
            _ => {}
        }
    }

    fm
}

/// 状态归一化：中文写法也认，方便手写 frontmatter。
pub fn normalize_status(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "none" | "无" | "未分类" => ST_NONE.to_string(),
        "inbox" | "输入" | "待处理" | "收集" => ST_INBOX.to_string(),
        "internalizing" | "internalise" | "内化" | "内化中" | "加工" | "加工中" => {
            ST_INTERNALIZING.to_string()
        }
        "output" | "输出" | "成品" | "已输出" => ST_OUTPUT.to_string(),
        "archived" | "archive" | "归档" | "已归档" => ST_ARCHIVED.to_string(),
        other => other.to_string(),
    }
}

fn normalize_kind(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "course" | "课程" | "课" => "course".to_string(),
        "book" | "书" | "教材" => "book".to_string(),
        "article" | "文章" => "article".to_string(),
        "clip" | "剪藏" => "clip".to_string(),
        "idea" | "灵感" => "idea".to_string(),
        "output" | "输出" => "output".to_string(),
        "" => "note".to_string(),
        other => other.to_string(),
    }
}

/// 只改 `status` 一个键，其余字节原样保留（不重排 YAML、不丢注释）。
pub fn set_status_in_text(text: &str, status: &str) -> String {
    let status = normalize_status(status);
    let fm = parse_front_matter(text);

    if !fm.present {
        let body = text.strip_prefix('\u{feff}').unwrap_or(text);
        return format!("---\nstatus: {status}\n---\n\n{body}");
    }

    let head = &text[..fm.body_offset];
    let tail = &text[fm.body_offset..];

    let mut lines: Vec<String> = head.split_inclusive('\n').map(|s| s.to_string()).collect();
    let newline = if head.contains("\r\n") { "\r\n" } else { "\n" };

    let mut replaced = false;
    for line in lines.iter_mut() {
        let bare = line.trim_end_matches(['\r', '\n']);
        if let Some((key, _)) = bare.split_once(':') {
            if key.trim().eq_ignore_ascii_case("status") {
                *line = format!("status: {status}{newline}");
                replaced = true;
                break;
            }
        }
    }
    if !replaced {
        // 插在开头的 `---` 之后
        lines.insert(1, format!("status: {status}{newline}"));
    }

    format!("{}{}", lines.concat(), tail)
}

// ------------------------------------------------------------------ 轻量统计

/// 块数（不含任务项与卡片行）与卡片数（问答 + 挖空）。
///
/// P1 会用与前端 `rnote.ts` 同源的解析器替换它——现在只需要能算"分母"。
fn count_blocks_and_cards(text: &str) -> (u32, u32) {
    let body_start = parse_front_matter(text).body_offset;
    let body = text.get(body_start..).unwrap_or(text);

    let mut blocks = 0u32;
    let mut cards = 0u32;
    let mut in_fence = false;

    for raw in body.lines() {
        let line = raw.trim_start();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        match strip_list_marker(line) {
            Some(rest) => {
                if rest.starts_with('?') || rest.starts_with('？') {
                    cards += 1;
                } else if rest.starts_with("[ ]")
                    || rest.starts_with("[x]")
                    || rest.starts_with("[X]")
                    || rest.starts_with("[]")
                {
                    // 任务不是知识单元
                } else if !rest.trim().is_empty() {
                    blocks += 1;
                    cards += count_cloze(rest);
                }
            }
            None => cards += count_cloze(line),
        }
    }

    (blocks, cards)
}

fn strip_list_marker(line: &str) -> Option<&str> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest);
        }
    }
    // 有序列表：`1. ` / `1) `
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        let rest = &line[digits..];
        if let Some(rest) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return Some(rest);
        }
    }
    None
}

fn count_cloze(line: &str) -> u32 {
    line.match_indices("{{")
        .filter(|(idx, _)| line[*idx + 2..].contains("}}"))
        .count() as u32
}

// ------------------------------------------------------------------ 同步

/// 把仓库里**还没有记录**的 `.md` 收进库（首开仓库时的迁移，以及外部新文件的导入）。
///
/// 注意方向：这是**文件 → 库**的唯一入口，而且只认"库里还没有这条路径"的文件。
/// 已经在库里的笔记，磁盘上的镜像被改了也不会被读回来——库是真身（见 docs/rnote-storage.md §10）。
pub fn sync(vault: &Vault, conn: &Connection) -> Result<SyncReport, String> {
    let started = Instant::now();
    let report = crate::notes::import_vault(conn, &vault.root)?;
    let missing = 0usize;
    store::meta_set(conn, "last_sync", &now_secs().to_string())?;

    Ok(SyncReport {
        scanned: report.imported + report.folders,
        updated: report.imported,
        missing,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// 看板数据：全部笔记 + 状态 + 块/卡计数（计数现算，保证与正文一致）。
pub fn list(conn: &Connection) -> Result<Vec<WorkflowNote>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.path, n.title, n.status, n.doc_kind, n.source, n.captured_at, n.updated_at,
                    COALESCE((SELECT SUM(LENGTH(p.content)) FROM parts p WHERE p.note_id = n.id), 0),
                    (SELECT COUNT(*) FROM cards c WHERE c.note_id = n.id)
             FROM notes n WHERE n.kind = 'note' ORDER BY n.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WorkflowNote {
                path: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                kind: row.get(3)?,
                source: row.get(4)?,
                captured_at: row.get(5)?,
                mtime: row.get(6)?,
                chars: row.get::<_, i64>(7)? as u32,
                card_count: row.get::<_, i64>(8)? as u32,
                missing: false,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 改一篇笔记的状态：写回 frontmatter（库 + 镜像一起更新）。
pub fn set_status(vault: &Vault, conn: &Connection, rel: &str, status: &str) -> Result<(), String> {
    crate::notes::set_status(conn, rel, status)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 追加一条到当天的收件箱，返回落点路径。
///
/// 收件箱也是库里的普通笔记：先确保 `00-输入/收件箱` 这级文件夹存在，再新建或追加。
pub fn append_inbox(
    conn: &Connection,
    vault: &Vault,
    date: &str,
    time: &str,
    text: &str,
) -> Result<String, String> {
    let rel = format!("{CAPTURE_DIR}/{date}");
    let line = format!("- {time} {}\n", text.trim());

    match crate::notes::read(conn, &rel) {
        Ok(existing) => {
            let mut content = existing.content;
            if !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(&line);
            crate::notes::write(conn, &rel, &content, None)?;
        }
        Err(_) => {
            let content = format!(
                "---\nstatus: {ST_INBOX}\ntype: idea\ncaptured: {date}\n---\n\n# {date} 收件箱\n\n{line}"
            );
            crate::notes::create_with_content(conn, CAPTURE_DIR, date, &content)?;
        }
    }

    Ok(rel)
}

/// 导入一份材料（音视频 / PDF / 图片…）：附件复制进 `attachments/`，并生成一张材料卡。
pub fn import_material(
    conn: &Connection,
    vault: &Vault,
    source: &Path,
    date: &str,
) -> Result<String, String> {
    if !source.is_file() {
        return Err(format!("找不到文件：{}", source.display()));
    }
    let file_name = source
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "文件名无效".to_string())?;
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());
    let ext = source
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    // 1. 复制附件（附件不进库，就是仓库里的文件）
    fs::create_dir_all(vault.root.join(ATTACH_DIR)).map_err(|e| format!("创建附件目录失败：{e}"))?;
    let stored = unique_name(&vault.root.join(ATTACH_DIR), &file_name);
    fs::copy(source, vault.root.join(ATTACH_DIR).join(&stored))
        .map_err(|e| format!("复制附件失败：{e}"))?;

    // 2. 生成材料卡（重名时自动换名字）
    let kind = match ext.as_str() {
        "mp3" | "m4a" | "wav" | "flac" | "aac" | "ogg" | "mp4" | "mkv" | "mov" | "webm" => "course",
        "pdf" | "epub" | "mobi" | "azw3" => "book",
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => "clip",
        _ => "article",
    };
    let content = format!(
        "---\nstatus: {ST_INBOX}\ntype: {kind}\ncaptured: {date}\n---\n\n# {stem}\n\n![[{stored}]]\n\n## 原文摘录\n\n（听 / 看的时候往这里丢要点，不求完整）\n\n## 我的加工\n\n（用自己的话、举自己的例子）\n"
    );

    let mut title = stem.clone();
    let mut note_rel = format!("{MATERIAL_DIR}/{title}");
    for index in 2..1000 {
        if crate::notes::read(conn, &note_rel).is_err() {
            break;
        }
        title = format!("{stem} {index}");
        note_rel = format!("{MATERIAL_DIR}/{title}");
    }
    crate::notes::create_with_content(conn, MATERIAL_DIR, &title, &content)?;

    Ok(note_rel)
}

fn unique_name(dir: &Path, file_name: &str) -> String {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return file_name.to_string();
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..1000 {
        let name = format!("{stem} {index}{ext}");
        if !dir.join(&name).exists() {
            return name;
        }
    }
    file_name.to_string()
}

fn unique_note_rel(vault: &Vault, rel: &str) -> Result<String, String> {
    let _ = vault;
    Ok(rel.to_string())
}

// ------------------------------------------------------------------ 单元测试

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic_front_matter() {
        let text = "---\nstatus: inbox\ntype: course\ncaptured: 2026-10-06\n---\n\n# 标题\n正文\n";
        let fm = parse_front_matter(text);
        assert!(fm.present);
        assert_eq!(fm.status.as_deref(), Some("inbox"));
        assert_eq!(fm.kind.as_deref(), Some("course"));
        assert_eq!(fm.captured_at.as_deref(), Some("2026-10-06"));
        assert_eq!(&text[fm.body_offset..], "\n# 标题\n正文\n");
    }

    #[test]
    fn parse_chinese_status_and_no_front_matter() {
        let fm = parse_front_matter("---\n状态: 内化\n---\n正文");
        // 「状态」不是我们认的键，但 status 的英文键才是标准；这里应保持未识别
        assert!(fm.present);
        assert_eq!(fm.status, None);

        let fm = parse_front_matter("status: 内化\n---\n");
        assert!(!fm.present);

        let fm = parse_front_matter("---\nstatus: 内化\n---\n正文");
        assert_eq!(fm.status.as_deref(), Some("internalizing"));
    }

    #[test]
    fn parse_without_closing_is_not_front_matter() {
        let text = "---\n只是分隔线\n\n正文";
        assert!(!parse_front_matter(text).present);
        // 顶层横线也不该被当成 frontmatter
        assert!(!parse_front_matter("---\n\n正文").present);
    }

    #[test]
    fn set_status_replaces_only_that_key() {
        let text = "---\n# 我的注释\ntype: book\nstatus: inbox\nsource: 某本书\n---\n\n正文\n";
        let out = set_status_in_text(text, "内化");
        assert!(out.contains("type: book"));
        assert!(out.contains("source: 某本书"));
        assert!(out.contains("# 我的注释"));
        assert!(out.contains("status: internalizing"));
        assert!(out.contains("正文"));
        // 其余内容一字不动
        assert_eq!(out.matches("status:").count(), 1);
    }

    #[test]
    fn set_status_inserts_when_missing() {
        let text = "---\ntype: book\n---\n\n正文";
        let out = set_status_in_text(text, "output");
        assert!(out.starts_with("---\nstatus: output\ntype: book\n---\n"));
    }

    #[test]
    fn set_status_creates_front_matter_when_absent() {
        let out = set_status_in_text("# 标题\n\n正文", "inbox");
        assert_eq!(out, "---\nstatus: inbox\n---\n\n# 标题\n\n正文");
    }


    #[test]
    fn normalize_status_accepts_chinese() {
        assert_eq!(normalize_status("内化"), "internalizing");
        assert_eq!(normalize_status("输出"), "output");
        assert_eq!(normalize_status("归档"), "archived");
        assert_eq!(normalize_status("随便什么"), "随便什么");
    }

    /// 建一个临时仓库（每个用例独立目录，用完删掉）。
    fn temp_vault(name: &str) -> Vault {
        let dir = std::env::temp_dir().join(format!("hn-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Vault::new(dir)
    }

    #[test]
    fn set_status_writes_front_matter_then_survives_resync() {
        let vault = temp_vault("set-status");
        fs::write(vault.root.join("a.md"), "# 标题\n\n- 一条块\n").unwrap();
        let conn = crate::store::open(&vault.root).unwrap();

        sync(&vault, &conn).unwrap();
        set_status(&vault, &conn, "a", "内化").unwrap();

        // 状态写在库里（frontmatter 原样留档，装配时再拼回去）
        let text = crate::notes::read(&conn, "a").unwrap().content;
        assert!(text.starts_with("---\nstatus: internalizing\n---\n"), "{text}");
        assert!(text.contains("# 标题"));

        // 外改磁盘上的旧 .md 完全不影响库：库是唯一存储
        fs::write(
            vault.root.join("a.md"),
            "---\nstatus: output\n---\n\n外部改的内容\n",
        )
        .unwrap();
        sync(&vault, &conn).unwrap();

        let listed = list(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, "internalizing", "库里的状态不该被镜像覆盖");
        assert!(!listed[0].missing);
        assert!(listed[0].chars > 0, "正文字数应当统计到");

        let _ = fs::remove_dir_all(&vault.root);
    }

    #[test]
    fn import_material_copies_attachment_and_writes_note() {
        let vault = temp_vault("import");
        let conn = crate::store::open(&vault.root).unwrap();
        let source = vault.root.join("第3讲.mp3");
        fs::write(&source, b"fake audio bytes").unwrap();

        let rel = import_material(&conn, &vault, &source, "2026-10-07").unwrap();
        assert_eq!(rel, "00-输入/材料/第3讲");
        assert!(vault.root.join("attachments/第3讲.mp3").exists());

        let note = crate::notes::read(&conn, &rel).unwrap().content;
        assert!(note.contains("status: inbox"));
        assert!(note.contains("type: course"));
        assert!(note.contains("captured: 2026-10-07"));
        assert!(note.contains("![[第3讲.mp3]]"));
        assert!(note.contains("## 我的加工"));

        // 重名材料不覆盖，另起一个名字
        let again = import_material(&conn, &vault, &source, "2026-10-07").unwrap();
        assert_eq!(again, "00-输入/材料/第3讲 2");
        assert!(vault.root.join("attachments/第3讲 2.mp3").exists());

        let _ = fs::remove_dir_all(&vault.root);
    }

    #[test]
    fn append_inbox_creates_daily_note_and_appends() {
        let vault = temp_vault("inbox");
        let conn = crate::store::open(&vault.root).unwrap();
        let rel = append_inbox(&conn, &vault, "2026-10-07", "14:10", "第一条").unwrap();
        assert_eq!(rel, "00-输入/收件箱/2026-10-07");
        append_inbox(&conn, &vault, "2026-10-07", "15:22", "第二条").unwrap();

        let text = crate::notes::read(&conn, &rel).unwrap().content;
        assert!(text.contains("- 14:10 第一条"));
        assert!(text.contains("- 15:22 第二条"));
        assert_eq!(text.matches("---").count(), 2, "frontmatter 只应有一对：{text}");
        // 收件箱是库里的普通笔记，看板能直接看到它
        let listed = list(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, "inbox");

        let _ = fs::remove_dir_all(&vault.root);
    }
}