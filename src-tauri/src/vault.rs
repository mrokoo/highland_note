//! 仓库（vault）读写：目录树扫描、笔记 CRUD、全文搜索。
//!
//! **注意**：内容层已经搬到 `notes.rs`（库是真身、文件是只写镜像）。本文件里那套
//! 直接读写 .md 的实现（tree / read / write / create / rename / move / delete / search）
//! 现在只剩 `Vault::new` / `info` / `root` 在被使用，其余是**待清理的历史实现**，
//! 留作参考（将来做「导出为纯文件仓库」可能会用到）。
#![allow(dead_code)]
//!
//! 所有对外暴露的路径都是「相对仓库根的、使用 `/` 分隔的」路径，
//! 由 `resolve` 统一做越界校验，避免前端传入 `..` 之类逃出仓库。

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// 扫描时跳过的目录（模仿 Obsidian 的忽略清单）。
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".obsidian",
    ".trash",
    ".highland",
    ".rnote",
    "node_modules",
    ".vscode",
    ".idea",
];

/// 视为笔记的扩展名。
const NOTE_EXTS: &[&str] = &["md", "markdown"];

/// 搜索时单个文件的最大读取体积，超过则跳过。
const MAX_SEARCH_BYTES: u64 = 4 * 1024 * 1024;

/// 搜索返回的最大命中条数。
const MAX_SEARCH_HITS: usize = 300;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// 相对仓库根的路径，`/` 分隔。
    pub path: String,
    pub is_dir: bool,
    pub mtime: i64,
    pub size: u64,
    /// 笔记库里的稳定 id（走 DB 的树才有；直接扫盘的老路径为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<FileNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub path: String,
    pub content: String,
    pub mtime: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub path: String,
    /// 不含扩展名的文件名，即 Obsidian 里的「笔记名」。
    pub title: String,
    pub folder: String,
    pub mtime: i64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// 1 起的行号。
    pub line: u32,
    pub text: String,
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn is_note(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| NOTE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub(crate) fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

/// 文件的「身份」：修改时间 + 大小。链接索引靠它判断缓存是否还有效。
pub fn stamp(meta: &fs::Metadata) -> (i64, u64) {
    (mtime_ms(meta), meta.len())
}

/// 绝对路径转仓库相对路径（`/` 分隔）。
pub fn to_rel(vault: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 仓库相对路径转绝对路径，并拒绝任何越界写法。
pub fn resolve(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.replace('\\', "/");
    let trimmed = cleaned.trim_matches('/');
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    let candidate = Path::new(trimmed);
    for comp in candidate.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(format!("非法路径：{rel}")),
        }
    }
    Ok(vault.join(candidate))
}

/// 校验用户输入的文件／文件夹名。
fn check_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if name == "." || name == ".." {
        return Err("名称无效".to_string());
    }
    if name.contains(['/', '\\']) {
        return Err("名称不能包含斜杠".to_string());
    }
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err("名称不能包含 < > : \" | ? * 等字符".to_string());
    }
    if name.ends_with('.') {
        return Err("名称不能以点结尾".to_string());
    }
    Ok(name.to_string())
}

fn with_md_ext(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if NOTE_EXTS.iter().any(|e| lower.ends_with(&format!(".{e}"))) {
        name.to_string()
    } else {
        format!("{name}.md")
    }
}

/// 在 dir 下找一个不冲突的文件名：`笔记.md`、`笔记 1.md`、……
fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let (stem, ext) = match file_name.rfind('.') {
        Some(i) if i > 0 => (&file_name[..i], &file_name[i..]),
        _ => (file_name, ""),
    };
    let mut candidate = dir.join(file_name);
    let mut i = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} {i}{ext}"));
        i += 1;
    }
    candidate
}

fn sort_nodes(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn build_tree(dir: &Path, vault: &Path, depth: usize) -> Vec<FileNode> {
    // 目录层数上限，防止异常结构导致递归过深。
    if depth > 24 {
        return Vec::new();
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut nodes: Vec<FileNode> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".md" {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };

        if meta.is_dir() {
            if is_skipped_dir(&name) {
                continue;
            }
            let children = build_tree(&path, vault, depth + 1);
            // 空文件夹也保留，方便先建结构再写笔记。
            nodes.push(FileNode {
                name,
                path: to_rel(vault, &path),
                id: None,
                is_dir: true,
                mtime: mtime_ms(&meta),
                size: 0,
                children,
            });
        } else if meta.is_file() && is_note(&path) {
            nodes.push(FileNode {
                name,
                path: to_rel(vault, &path),
                id: None,
                is_dir: false,
                mtime: mtime_ms(&meta),
                size: meta.len(),
                children: Vec::new(),
            });
        }
    }

    sort_nodes(&mut nodes);
    nodes
}

// ---------------------------------------------------------------- 命令实现

pub struct Vault {
    pub root: PathBuf,
}

impl Vault {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn info(&self) -> VaultInfo {
        VaultInfo {
            path: self.root.to_string_lossy().to_string(),
            name: self
                .root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| self.root.to_string_lossy().to_string()),
        }
    }

    pub fn tree(&self) -> Vec<FileNode> {
        build_tree(&self.root, &self.root, 0)
    }

    pub fn read(&self, rel: &str) -> Result<NoteContent, String> {
        let abs = resolve(&self.root, rel)?;
        let meta = fs::metadata(&abs).map_err(|e| format!("读取失败：{e}"))?;
        if meta.is_dir() {
            return Err("这是一个文件夹".to_string());
        }
        let content = fs::read_to_string(&abs).map_err(|e| format!("读取失败：{e}"))?;
        Ok(NoteContent {
            path: to_rel(&self.root, &abs),
            content: content.strip_prefix('\u{feff}').unwrap_or(&content).to_string(),
            mtime: mtime_ms(&meta),
        })
    }

    /// 写入笔记。`expected_mtime` 不为空且与磁盘现状不一致时返回冲突，交由前端决定。
    pub fn write(&self, rel: &str, content: &str, expected_mtime: Option<i64>) -> Result<i64, String> {
        let abs = resolve(&self.root, rel)?;
        if abs.is_dir() {
            return Err("这是一个文件夹".to_string());
        }
        if let Some(expected) = expected_mtime {
            if let Ok(meta) = fs::metadata(&abs) {
                let disk = mtime_ms(&meta);
                // 允许 1 秒误差，避免文件系统时间精度造成误报。
                if disk != expected && (disk - expected).abs() > 1000 {
                    return Err(format!("CONFLICT::{disk}"));
                }
            }
        }
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        // 先写临时文件再替换，避免写入中途崩溃损坏笔记。
        let tmp = abs.with_extension("md.tmp-write");
        fs::write(&tmp, content).map_err(|e| format!("写入失败：{e}"))?;
        fs::rename(&tmp, &abs).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("写入失败：{e}")
        })?;
        let meta = fs::metadata(&abs).map_err(|e| format!("写入后读取失败：{e}"))?;
        Ok(mtime_ms(&meta))
    }

    pub fn create_note(&self, parent: &str, name: &str) -> Result<String, String> {
        let name = with_md_ext(&check_name(name)?);
        let dir = if parent.trim_matches('/').is_empty() {
            self.root.clone()
        } else {
            resolve(&self.root, parent)?
        };
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
        let target = unique_path(&dir, &name);
        fs::write(&target, "").map_err(|e| format!("创建失败：{e}"))?;
        Ok(to_rel(&self.root, &target))
    }

    pub fn create_folder(&self, parent: &str, name: &str) -> Result<String, String> {
        let name = check_name(name)?;
        let dir = if parent.trim_matches('/').is_empty() {
            self.root.clone()
        } else {
            resolve(&self.root, parent)?
        };
        let target = unique_path(&dir, &name);
        fs::create_dir_all(&target).map_err(|e| format!("创建失败：{e}"))?;
        Ok(to_rel(&self.root, &target))
    }

    pub fn rename(&self, rel: &str, new_name: &str) -> Result<String, String> {
        let abs = resolve(&self.root, rel)?;
        if !abs.exists() {
            return Err("目标不存在".to_string());
        }
        let is_dir = abs.is_dir();
        let new_name = if is_dir {
            check_name(new_name)?
        } else {
            with_md_ext(&check_name(new_name)?)
        };
        let parent = abs.parent().ok_or("无法定位父目录")?;
        let target = parent.join(&new_name);
        if target.exists() && target != abs {
            return Err("同名文件已存在".to_string());
        }
        fs::rename(&abs, &target).map_err(|e| format!("重命名失败：{e}"))?;
        Ok(to_rel(&self.root, &target))
    }

    /// 移动到新的父目录（拖拽用）。
    pub fn move_entry(&self, rel: &str, new_parent: &str) -> Result<String, String> {
        let abs = resolve(&self.root, rel)?;
        if !abs.exists() {
            return Err("目标不存在".to_string());
        }
        let dir = if new_parent.trim_matches('/').is_empty() {
            self.root.clone()
        } else {
            resolve(&self.root, new_parent)?
        };
        if !dir.is_dir() {
            return Err("目标不是文件夹".to_string());
        }
        let name = abs
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("无法定位文件名")?;
        // 不允许把文件夹移进自己的子目录。
        if dir.starts_with(&abs) {
            return Err("不能移动到自身内部".to_string());
        }
        let target = unique_path(&dir, &name);
        fs::rename(&abs, &target).map_err(|e| format!("移动失败：{e}"))?;
        Ok(to_rel(&self.root, &target))
    }

    /// 删除：优先移入系统回收站，失败则退回直接删除。
    pub fn delete(&self, rel: &str) -> Result<(), String> {
        let abs = resolve(&self.root, rel)?;
        if abs == self.root {
            return Err("不能删除仓库根目录".to_string());
        }
        if !abs.exists() {
            return Err("目标不存在".to_string());
        }
        match trash::delete(&abs) {
            Ok(()) => Ok(()),
            Err(_) => {
                let result = if abs.is_dir() {
                    fs::remove_dir_all(&abs)
                } else {
                    fs::remove_file(&abs)
                };
                result.map_err(|e| format!("删除失败：{e}"))
            }
        }
    }

    /// 仓库内全部笔记，供快速切换（Ctrl+P）与 [[双链]] 解析使用。
    pub fn notes(&self) -> Vec<NoteMeta> {
        let mut out = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if e.file_type().is_dir() {
                    !is_skipped_dir(&name) && !name.starts_with('.')
                } else {
                    true
                }
            })
            .flatten()
        {
            if !entry.file_type().is_file() || !is_note(entry.path()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let rel = to_rel(&self.root, entry.path());
            out.push(NoteMeta {
                title: entry
                    .path()
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                folder: rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default(),
                path: rel,
                mtime: mtime_ms(&meta),
                size: meta.len(),
            });
        }
        out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        out
    }

    /// 全文搜索，逐行返回命中。
    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>, String> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits: Vec<SearchHit> = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if e.file_type().is_dir() {
                    !is_skipped_dir(&name) && !name.starts_with('.')
                } else {
                    true
                }
            })
            .flatten()
        {
            if hits.len() >= MAX_SEARCH_HITS {
                break;
            }
            if !entry.file_type().is_file() || !is_note(entry.path()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_SEARCH_BYTES {
                continue;
            }
            let Ok(content) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let rel = to_rel(&self.root, entry.path());
            let title = entry
                .path()
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            for (idx, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    hits.push(SearchHit {
                        path: rel.clone(),
                        title: title.clone(),
                        line: idx as u32 + 1,
                        text: line.trim().chars().take(240).collect(),
                    });
                    if hits.len() >= MAX_SEARCH_HITS {
                        break;
                    }
                }
            }
        }
        Ok(hits)
    }
}
