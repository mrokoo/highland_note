//! 仓库级链接索引：解析每篇笔记里的 `[[双链]]`，回答「我引用了谁」和「谁引用了我」。
//!
//! 索引按 `(修改时间, 大小)` 缓存每篇笔记的解析结果，所以重复查询只需要重新解析
//! 真正改动过的文件，而不是把整个仓库重读一遍。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

use crate::vault::{is_note, is_skipped_dir, stamp, to_rel};

/// 一条链接（出链或反向链接）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    /// 链接所在的笔记：出链时是当前笔记，反向链接时是引用者
    pub path: String,
    /// 该笔记的标题（文件名去掉扩展名）
    pub title: String,
    /// 链接里写的目标（已去掉 `#锚点`）
    pub target: String,
    /// 显示用的文字，`[[目标|别名]]` 时是别名
    pub alias: String,
    /// 1 起的行号
    pub line: u32,
    /// 链接所在那一行的原文
    pub context: String,
    /// 目标笔记是否存在
    pub resolved: bool,
    /// 解析到的目标路径
    pub target_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReport {
    /// 当前笔记引用了谁
    pub outgoing: Vec<LinkRef>,
    /// 谁引用了当前笔记
    pub backlinks: Vec<LinkRef>,
}

#[derive(Debug, Clone)]
struct RawLink {
    target: String,
    alias: String,
    line: u32,
    context: String,
}

#[derive(Debug, Clone)]
struct CachedNote {
    mtime: i64,
    size: u64,
    title: String,
    links: Vec<RawLink>,
}

#[derive(Default)]
pub struct LinkIndex {
    notes: HashMap<String, CachedNote>,
}

/// 扫描一篇笔记里的 `[[链接]]`，跳过围栏代码块。
fn extract_links(content: &str) -> Vec<RawLink> {
    let mut out = Vec::new();
    let mut in_fence = false;

    for (index, raw) in content.lines().enumerate() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        let mut from = 0;
        while let Some(offset) = raw[from..].find("[[") {
            let start = from + offset;
            let Some(end_offset) = raw[start + 2..].find("]]") else {
                break;
            };
            let end = start + 2 + end_offset;
            let inner = &raw[start + 2..end];
            from = end + 2;

            if inner.is_empty() || inner.contains('[') || inner.contains(']') || inner.contains('\n') {
                continue;
            }
            // `[[目标|别名]]`：竖线前是目标
            let (target_part, alias_part) = match inner.split_once('|') {
                Some((target, alias)) => (target, Some(alias)),
                None => (inner, None),
            };
            // `[[目标#小节]]`：只拿笔记名去解析
            let target = target_part.split('#').next().unwrap_or("").trim();
            if target.is_empty() {
                continue;
            }
            out.push(RawLink {
                target: target.to_string(),
                alias: alias_part
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty())
                    .unwrap_or_else(|| target.to_string()),
                line: index as u32 + 1,
                context: raw.trim().to_string(),
            });
        }
    }
    out
}

impl LinkIndex {
    pub fn clear(&mut self) {
        self.notes.clear();
    }

    /// 增量刷新：只重读改动过的文件，并清掉已删除的条目。
    pub fn refresh(&mut self, vault: &Path) {
        let mut seen: HashSet<String> = HashSet::new();

        for entry in WalkDir::new(vault)
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
            let rel = to_rel(vault, entry.path());
            let (mtime, size) = stamp(&meta);
            seen.insert(rel.clone());

            let fresh = self
                .notes
                .get(&rel)
                .map(|cached| cached.mtime == mtime && cached.size == size)
                .unwrap_or(false);
            if fresh {
                continue;
            }

            let Ok(content) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let title = entry
                .path()
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            self.notes.insert(
                rel,
                CachedNote {
                    mtime,
                    size,
                    title,
                    links: extract_links(&content),
                },
            );
        }

        self.notes.retain(|path, _| seen.contains(path));
    }

    /// 算出某篇笔记的出链与反向链接。
    pub fn report(&self, current: &str) -> LinkReport {
        // 两种解析方式：按标题，或按「相对路径（可带 .md）」
        let mut by_title: HashMap<String, String> = HashMap::new();
        let mut by_path: HashMap<String, String> = HashMap::new();
        for (path, note) in &self.notes {
            by_title
                .entry(note.title.to_lowercase())
                .or_insert_with(|| path.clone());
            let mut key = path.to_lowercase();
            if let Some(stripped) = key.strip_suffix(".md") {
                key = stripped.to_string();
            } else if let Some(stripped) = key.strip_suffix(".markdown") {
                key = stripped.to_string();
            }
            by_path.entry(key).or_insert_with(|| path.clone());
        }

        let resolve = |target: &str| -> Option<String> {
            let key = target.to_lowercase();
            by_title
                .get(&key)
                .cloned()
                .or_else(|| by_path.get(&key).cloned())
                .or_else(|| {
                    let mut key = key.clone();
                    if let Some(stripped) = key.strip_suffix(".md") {
                        key = stripped.to_string();
                    }
                    by_path.get(&key).cloned()
                })
        };

        let current_note = self.notes.get(current);

        let outgoing: Vec<LinkRef> = current_note
            .map(|note| {
                note.links
                    .iter()
                    .map(|link| {
                        let target_path = resolve(&link.target);
                        LinkRef {
                            path: current.to_string(),
                            title: note.title.clone(),
                            target: link.target.clone(),
                            alias: link.alias.clone(),
                            line: link.line,
                            context: link.context.clone(),
                            resolved: target_path.is_some(),
                            target_path,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut backlinks: Vec<LinkRef> = Vec::new();
        for (path, note) in &self.notes {
            if path == current {
                continue;
            }
            for link in &note.links {
                if resolve(&link.target).as_deref() == Some(current) {
                    backlinks.push(LinkRef {
                        path: path.clone(),
                        title: note.title.clone(),
                        target: link.target.clone(),
                        alias: link.alias.clone(),
                        line: link.line,
                        context: link.context.clone(),
                        resolved: true,
                        target_path: Some(current.to_string()),
                    });
                }
            }
        }

        // 按笔记标题排序，同一篇里按行号，阅读顺序稳定
        backlinks.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then(a.line.cmp(&b.line))
        });

        LinkReport { outgoing, backlinks }
    }
}
