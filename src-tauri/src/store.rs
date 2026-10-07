//! SQLite 存储层。
//!
//! 这里只存两类东西：
//! 1. **索引**——笔记 / 块 / 卡片在文件里的位置，随时可以从 Markdown 重建；
//! 2. **状态**——FSRS 排期与复习历史，删了就真没了（所以提供导出）。
//!
//! **知识本体永远在 Markdown 里。** 见 `docs/rnote-storage.md`。

use rusqlite::{Connection, OptionalExtension};
use std::fs;
use std::path::Path;

/// 当前 schema 版本，写在 `PRAGMA user_version` 里，用于迁移。
const SCHEMA_VERSION: i64 = 6;

/// 打开（必要时创建）仓库级数据库 `.rnote/rnote.db`。
pub fn open(vault_root: &Path) -> Result<Connection, String> {
    let dir = vault_root.join(".rnote");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 .rnote 目录失败：{e}"))?;
    let conn = Connection::open(dir.join("rnote.db")).map_err(|e| format!("打开数据库失败：{e}"))?;

    // WAL：崩溃安全 + 读写不互相阻塞；外键约束负责级联清理
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");

    migrate(&conn)?;

    // 记下这个库属于哪个仓库：清理历史遗留时要用它去核对磁盘上的镜像
    let _ = meta_set(&conn, "vault_root", &vault_root.to_string_lossy());

    // 别让二进制库污染笔记仓库的 git 历史
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "*.db\n*.db-wal\n*.db-shm\n");
    }

    Ok(conn)
}

/// v5：笔记变成**集合**，正文按「输入 / 内化 / 输出」三段存。
///
/// 卡片不再依赖块索引——它在创建时把选中的文字**快照**进自己身上（`source_text`），
/// 所以改正文、拆句、移动都不会影响已有卡片，也就不需要那套易碎的"块身份阶梯"。
const SCHEMA_V5: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,               -- 迁移时沿用原文档 id，卡片能直接对上
  parent_id   TEXT,
  kind        TEXT NOT NULL DEFAULT 'note',   -- folder | note
  title       TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'none',
  doc_kind    TEXT NOT NULL DEFAULT 'note',
  source      TEXT,
  captured_at TEXT,
  front       TEXT NOT NULL DEFAULT '',   -- raw frontmatter，原样留档
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_path ON notes(path);
CREATE INDEX IF NOT EXISTS idx_collections_parent ON notes(parent_id);

CREATE TABLE IF NOT EXISTS parts (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                   -- input | internalize | output
  title      TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,      -- 同一种角色可以有多段
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parts_note ON parts(note_id, position);
"#;

/// 重建 `cards`：让 `block_ref` 可空。
///
/// 卡片改成"自带快照、直接属于笔记"之后，它就不再需要块来定位；
/// SQLite 不能直接去掉 NOT NULL，只能"建新表 → 搬数据 → 换名"，整个过程包在一个事务里。
fn rebuild_cards(conn: &Connection) -> Result<(), String> {
    let has_cards: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='cards'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if has_cards == 0 {
        return Ok(());
    }
    // 已经放开过就跳过（block_ref 为空的卡存在即说明已重建）
    let notnull: i64 = conn
        .query_row(
            "SELECT \"notnull\" FROM pragma_table_info('cards') WHERE name = 'block_ref'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(1);
    if notnull == 0 {
        return Ok(());
    }

    conn.execute_batch(
        r#"
BEGIN;
CREATE TABLE cards_v6 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  block_ref   INTEGER,                      -- 可空：不再依赖块索引
  ordinal     INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  angle       TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  line        INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'new',
  due         TEXT,
  stability   REAL,
  difficulty  REAL,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  step        INTEGER,
  last_review TEXT,
  note_id     TEXT,
  source_text    TEXT,
  source_heading TEXT,
  source_line    INTEGER
);
INSERT INTO cards_v6 (id, block_ref, ordinal, kind, question, answer, angle, fingerprint, line,
                      state, due, stability, difficulty, reps, lapses, step, last_review,
                      note_id, source_text, source_heading, source_line)
SELECT id, block_ref, ordinal, kind, question, answer, angle, fingerprint, line,
       state, due, stability, difficulty, reps, lapses, step, last_review,
       note_id, source_text, source_heading, source_line
FROM cards;
DROP TABLE cards;
ALTER TABLE cards_v6 RENAME TO cards;
CREATE INDEX IF NOT EXISTS idx_cards_block ON cards(block_ref);
CREATE INDEX IF NOT EXISTS idx_cards_fp ON cards(block_ref, fingerprint);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id);
COMMIT;
"#,
    )
    .map_err(|e| format!("重建 cards 表失败：{e}"))
}

/// 每张表"后面补上去"的列：**每次打开都核对一遍**，不看版本号。
///
/// 教训：升级流程原来写的是"版本号到了就整段跳过"，于是一个在 v5 之前就建好的库
/// （版本号已经是 6、`notes` 表却没有 `front` 列）永远不会被补上，
/// 打开仓库时 `SELECT ... front ...` 直接报错，文件面板整片空掉。
/// 列是幂等的、几十微秒的事，没有理由把它绑在版本号上。
const ADDED_COLUMNS: [(&str, &[&str]); 3] = [
    (
        "notes",
        &["front TEXT NOT NULL DEFAULT ''"],
    ),
    (
        "cards",
        &[
            "note_id TEXT",
            "source_text TEXT",
            "source_heading TEXT",
            "source_line INTEGER",
        ],
    ),
    (
        "reviews",
        &[
            "before_state TEXT",
            "before_stability REAL",
            "before_difficulty REAL",
            "before_due TEXT",
            "before_last TEXT",
        ],
    ),
];

/// 缺哪列补哪列（补过的返回条数，供日志看）。
fn ensure_columns(conn: &Connection) -> Result<usize, String> {
    let mut added = 0;
    for (table, columns) in ADDED_COLUMNS {
        let existing: Vec<String> = {
            let mut stmt = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        if existing.is_empty() {
            continue; // 这张表还没有，等建表那一步
        }
        for column in columns {
            let name = column.split_whitespace().next().unwrap_or("");
            if name.is_empty() || existing.iter().any(|have| have == name) {
                continue;
            }
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column}"), [])
                .map_err(|e| format!("给 {table} 补列 {name} 失败：{e}"))?;
            added += 1;
        }
    }
    Ok(added)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if version < SCHEMA_VERSION {
        conn.execute_batch(SCHEMA_V1)
            .map_err(|e| format!("建表失败：{e}"))?;
        conn.execute_batch(SCHEMA_V2)
            .map_err(|e| format!("建表失败：{e}"))?;
        conn.execute_batch(SCHEMA_V3)
            .map_err(|e| format!("建表失败：{e}"))?;
        conn.execute_batch(SCHEMA_V5)
            .map_err(|e| format!("建表失败：{e}"))?;
    }

    // 补列与版本号无关：老库、跨版本跳过来的库、手工改过的库，都靠这一步对齐。
    // 必须排在 rebuild_cards 之前——那张新表要按列名搬数据，缺列就没法搬。
    ensure_columns(conn)?;

    if version < SCHEMA_VERSION {
        // v6：卡片不再依赖块 —— block_ref 允许为空，重建表把它放开
        rebuild_cards(conn)?;
        let _ = conn.pragma_update(None, "user_version", SCHEMA_VERSION);
    }
    Ok(())
}

/// 表结构。新增表用 `IF NOT EXISTS`，不改变已有列，所以小版本升级不需要迁移脚本。
const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 笔记层：文件在库里的投影
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,              -- rn_id，缺省时用 path 的稳定哈希兜底
  path        TEXT NOT NULL,                 -- 仓库相对路径，'/' 分隔
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'none',  -- inbox|internalizing|output|archived|none
  kind        TEXT NOT NULL DEFAULT 'note',  -- note|course|book|article|clip|idea|output
  source      TEXT,
  captured_at TEXT,
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  block_count INTEGER NOT NULL DEFAULT 0,    -- 全部 Block 数（含没有 ^id 的）
  card_count  INTEGER NOT NULL DEFAULT 0,
  missing     INTEGER NOT NULL DEFAULT 0,    -- 文件暂时不见了（切分支、同步冲突）
  scanned_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);

-- 块层与卡片层在 P1 加入（见 docs/rnote-storage.md §4）
"#;

/// v2：**笔记库**。DB 成为真身，Markdown 变成只写镜像。
///
/// `content` 存**整篇正文（含 frontmatter）**——编辑器和镜像都原样看到它；
/// `status` / `doc_kind` 等是从 frontmatter 里解析出来的**派生列**，给看板和查询用。
/// 这样既不用重写 YAML，也不会丢掉用户自定义的 frontmatter 键。
const SCHEMA_V2: &str = r#"
-- v1 的 notes 表（文件扫描出来的索引）在 v2 里由 nodes 取代，直接丢掉重建
DROP TABLE IF EXISTS notes;

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,               -- 稳定 id，与路径无关
  parent_id   TEXT,                           -- NULL = 根
  kind        TEXT NOT NULL,                  -- folder | doc
  title       TEXT NOT NULL,
  path        TEXT NOT NULL,                  -- 相对仓库，doc 带 .md；由树推导
  content     TEXT NOT NULL DEFAULT '',       -- 仅 doc：整篇 Markdown
  status      TEXT NOT NULL DEFAULT 'none',   -- 派生：inbox|internalizing|output|archived|none
  doc_kind    TEXT NOT NULL DEFAULT 'note',   -- 派生：course|book|article|clip|idea|output|note
  source      TEXT,
  captured_at TEXT,
  front       TEXT NOT NULL DEFAULT '',   -- raw frontmatter，原样留档
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 1      -- 每次保存 +1，替代 mtime 做冲突检测
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
"#;

/// v3：**块、卡片、链接**。都从笔记正文解析出来，随保存与导入重建。
///
/// 关键约定：重建索引**只覆盖内容列，绝不触碰 FSRS 状态列**（`state` / `due` /
/// `stability` / `difficulty` / `reps` / `lapses` / `step` / `last_review`）。
/// 卡片认回顺序：先 `(block, ordinal)`，再 `(block, fingerprint)`，都没有才新建。
const SCHEMA_V3: &str = r#"
CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  block_key  TEXT NOT NULL,               -- 正文里的 ^id，或按正文推导的短 id
  text       TEXT NOT NULL,
  plain      TEXT NOT NULL,               -- {{}} 展开后的展示文本
  heading    TEXT NOT NULL DEFAULT '',
  line       INTEGER NOT NULL,
  indent     INTEGER NOT NULL DEFAULT 0,
  depth      INTEGER NOT NULL DEFAULT 0,
  parent_key TEXT,
  explicit   INTEGER NOT NULL DEFAULT 0,  -- 正文里是否写死了 ^id
  UNIQUE(node_id, block_key)
);
CREATE INDEX IF NOT EXISTS idx_blocks_node ON blocks(node_id);

CREATE TABLE IF NOT EXISTS cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  block_ref   INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  kind        TEXT NOT NULL,              -- qa | cloze
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  angle       TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  line        INTEGER NOT NULL DEFAULT 0,
  -- ↓↓↓ FSRS 状态：只由评分写入，重建索引不许碰 ↓↓↓
  state       TEXT NOT NULL DEFAULT 'new',
  due         TEXT,
  stability   REAL,
  difficulty  REAL,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  step        INTEGER,
  last_review TEXT,
  UNIQUE(block_ref, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_cards_block ON cards(block_ref);
CREATE INDEX IF NOT EXISTS idx_cards_fp ON cards(block_ref, fingerprint);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);

CREATE TABLE IF NOT EXISTS links (
  from_node TEXT NOT NULL,                -- 来源笔记路径
  target    TEXT NOT NULL,                -- [[目标]]（已去掉 # 小节与 | 别名）
  alias     TEXT NOT NULL DEFAULT '',
  line      INTEGER NOT NULL,
  context   TEXT NOT NULL DEFAULT '',     -- 所在行的原文，面板里给出语境
  PRIMARY KEY (from_node, line, target)
);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);

-- 复习历史：卡片删了也留档（故意不加外键）
CREATE TABLE IF NOT EXISTS reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL,
  rated_at     TEXT NOT NULL,
  rating       INTEGER NOT NULL,     -- 1 重来 / 2 困难 / 3 良好 / 4 简单
  state        TEXT NOT NULL,        -- 评分后的状态
  stability    REAL,
  difficulty   REAL,
  interval_d   REAL,
  -- 评分前的快照，撤销评分时原样放回
  before_state      TEXT,
  before_stability  REAL,
  before_difficulty REAL,
  before_due        TEXT,
  before_last       TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_time ON reviews(rated_at);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id);
"#;

/// 取一个 meta 值。
pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .ok()
    .flatten()
}

/// 写一个 meta 值。
pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map(|_| ())
    .map_err(|e| format!("写入 meta 失败：{e}"))
}

// ------------------------------------------------------------------ 安全网

/// 备份保留份数。
const KEEP_BACKUPS: usize = 14;

/// 每天首次打开时给库做一份快照（`VACUUM INTO`，一致且不依赖 WAL 状态）。
///
/// 放弃 Markdown 镜像之后，这是"库坏了还能回去"的唯一依靠。
pub fn backup_daily(conn: &Connection, vault_root: &Path, today: &str) -> Result<Option<String>, String> {
    let dir = vault_root.join(".rnote").join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;

    let target = dir.join(format!("rnote-{today}.db"));
    if !target.exists() {
        // VACUUM INTO 会写一个干净的副本；文件已存在会报错，所以前面先判断
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])
            .map_err(|e| format!("备份失败：{e}"))?;
    }
    prune_backups(&dir)?;
    Ok(Some(target.to_string_lossy().to_string()))
}

/// 只留最近 N 份备份。
fn prune_backups(dir: &Path) -> Result<(), String> {
    let mut files: Vec<std::path::PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().map(|ext| ext == "db").unwrap_or(false))
        .collect();
    files.sort();
    while files.len() > KEEP_BACKUPS {
        let oldest = files.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

/// 已有备份列表（新的在前），设置页展示用。
pub fn list_backups(vault_root: &Path) -> Vec<String> {
    let dir = vault_root.join(".rnote").join("backups");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".db"))
        .collect();
    files.sort();
    files.reverse();
    files
}

// ------------------------------------------------------------------ 单元测试

#[cfg(test)]
mod tests {
    use super::*;

    /// 老库最常见的坏样子：版本号已经是最新，表里却缺列。
    ///
    /// 真事：demo-vault 的 `notes` 表没有 `front` 列而 `user_version` 是 6，
    /// 打开仓库时 `SELECT ... front ...` 直接报错，文件面板整片空掉。
    #[test]
    fn open_backfills_columns_on_a_vault_that_is_already_at_the_latest_version() {
        let dir = std::env::temp_dir().join(format!("hn-store-old-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".rnote")).unwrap();

        // 手搓一个"v6 但没有 front 列"的库
        {
            let conn = Connection::open(dir.join(".rnote").join("rnote.db")).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE notes (
                  id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT NOT NULL DEFAULT 'note',
                  title TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'none',
                  doc_kind TEXT NOT NULL DEFAULT 'note', source TEXT, captured_at TEXT,
                  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE cards (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, block_ref INTEGER, ordinal INTEGER NOT NULL DEFAULT 0,
                  kind TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
                  angle TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL, line INTEGER NOT NULL DEFAULT 0,
                  state TEXT NOT NULL DEFAULT 'new', due TEXT, stability REAL, difficulty REAL,
                  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, step INTEGER,
                  last_review TEXT, note_id TEXT, source_text TEXT, source_heading TEXT, source_line INTEGER
                );
                CREATE TABLE reviews (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, rated_at TEXT NOT NULL,
                  rating INTEGER NOT NULL, state TEXT NOT NULL, stability REAL, difficulty REAL,
                  interval_d REAL
                );
                INSERT INTO notes (id, kind, title, path, status, doc_kind, sort, created_at, updated_at)
                VALUES ('n1', 'note', '甲', '笔记方法/甲', 'none', 'note', 0, 1, 1);
                PRAGMA user_version = 6;
                "#,
            )
            .unwrap();
        }

        let conn = open(&dir).unwrap();
        // 补列之后，仓库里的查询就能正常跑了
        let title: String = conn
            .query_row(
                "SELECT COALESCE(front, ''), title FROM notes WHERE path = '笔记方法/甲'",
                [],
                |row| {
                    let _front: String = row.get(0)?;
                    row.get(1)
                },
            )
            .unwrap();
        assert_eq!(title, "甲");
        for (table, column) in [("notes", "front"), ("reviews", "before_state")] {
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{table}.{column} 应当被补上");
        }
        // 再开一次是幂等的
        drop(conn);
        let conn = open(&dir).unwrap();
        assert_eq!(ensure_columns(&conn).unwrap(), 0, "第二次打开不该再补任何列");

        let _ = fs::remove_dir_all(&dir);
    }
}