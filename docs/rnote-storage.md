# 卡片存储与关联设计（SQLite）

> **2026-10 架构转向（重要）**
> 本文第 3–5 章描述的是"**文件是真身、DB 是索引**"的方案。经确认，实际采用**反过来**：
>
> - **DB 是全部**：笔记内容、树结构、块、卡片、复习状态全部住在 `.rnote/rnote.db`。
>   磁盘上**没有**镜像，应用**不写** `.md`，也**不读回来**（除了下面那条"首次导入"）
> - **首次导入**：打开一个还没有库的文件夹时，把里面已有的 `.md` 收进库，**只做这一次**
> - **之后以库为准**：磁盘上的 `.md` 跟应用再无关系，删掉、改掉都不会影响笔记。
>   想再收一次旧文件，把仓库里的 `.rnote/` 删掉重开
> - **导出是手动动作**：设置里的"导出全部为 Markdown"给你一份可读快照（归档 / 迁移用）
>
> 这么做的收益很直接：第 3–5 章里那套「三级身份 + 指纹兜底 + 降级阶梯 + 同步方向规则」
> **全部不再需要**——磁盘上的文件永远不会反向覆盖库，就不存在"认不回"的问题。
> 代价是笔记不再是可被 Obsidian / git 直接使用的纯文本；换机器靠**拷走整个仓库文件夹**
> 或导出快照，回退靠 `.rnote/backups/` 的每日快照。
>
> 下面第 3–5 章保留作为历史记录；当前实现见 §10。

> 回答两个问题：
> **① 卡片放 SQLite 对不对？** —— 对，但要划清"什么进库、什么留在文件"的边界。
> **② 内化笔记和卡片怎么关联？** —— 关联不是库里的外键，而是**写在 Markdown 正文里的事实**，库只是把它索引出来。
>
> 上游文档：[`workflow-design.md`](workflow-design.md)（工作流总纲）、
> [`rnote-design.md`](rnote-design.md)（Block / Card 的正文格式与解析规则）。

---

## 0. 一页速览

| 问题 | 结论 |
| --- | --- |
| 卡片存哪 | **内容在 Markdown，身份与状态在 SQLite**。库可删可重建（内容部分），删了不丢一个字的笔记 |
| 关联怎么建立 | 三级稳定身份：**笔记 `rn_id` → 块 `^id` → 卡片 `#序号`**，三级全部写在文件里 |
| 认不回怎么办 | 降级阶梯：主键 → 序号 → 指纹 → 块内指纹 → 认定新卡；**认不回不删数据，进孤儿区** |
| 同步方向 | **文件 → 库只覆盖"内容列"；状态列（FSRS）任何重扫都不许碰** |
| 为什么不用 JSON | 评分是高频写、统计要聚合、崩溃不能丢全部。SQLite 的 WAL + 索引正好对症 |

---

## 1. 为什么 SQLite 是对的（验证你的判断）

原来的 `.rnote/schedule.json` 方案在"几百张卡、一天几十次评分"的规模下能跑，但它的代价会随使用暴露：

| 维度 | JSON 单文件 | **SQLite** |
| --- | --- | --- |
| 一次评分 | 序列化整个对象 + 重写整个文件 | 一行 UPDATE + 一条 INSERT，事务提交 |
| 崩溃/断电 | 可能整个排期文件损坏 → 全库进度归零 | WAL 保证已提交事务不丢，最坏丢最后一个未提交的 |
| "今天到期" | 全量加载 + 遍历过滤 | `WHERE due<=? AND orphaned=0` 走索引 |
| 统计（热力图/留存率/成熟度分布） | 拉到前端算 | SQL 聚合，一行 GROUP BY |
| 规模上限 | 几千张卡开始明显卡顿 | 几万张卡无压力 |
| 并发写 | 无（重写文件的窗口期最危险） | 事务 + 锁 |

**代价也如实说：**

- 二进制体积 +约 1 MB（用 `rusqlite` 的 `bundled` 特性，SQLite 静态编进去，用户机器不需要装任何东西）
- 需要 schema 迁移机制（用 `PRAGMA user_version`）
- 状态不再是"肉眼可读的文本"——**但它本来就不是知识本体，而是"我对这些知识的熟练度"**

---

## 2. 边界：什么进库，什么必须留在文件里

这是整套设计的红线，先立规矩再谈 schema。

### 2.1 三类数据，三种待遇

| 数据 | 存在哪 | 能否重建 | 理由 |
| --- | --- | --- | --- |
| **卡片内容**（问题、答案、挖空、角度） | **Markdown 正文**，库里存一份"索引副本" | ✅ 删库后重扫即可完全恢复 | 知识本体必须是人可读、可携带、可被 Obsidian / git 直接使用的纯文本 |
| **身份**（`rn_id` / `^id` / 序号） | **Markdown 正文**，库里索引 | ✅ 同上 | 关联关系写在正文里，换个编辑器依然成立 |
| **学习状态**（FSRS：稳定性、难度、到期、复习历史） | **只在库里** | ❌ 删了就没了 | 高频写、要聚合、和内容无关；用导出功能解决备份与迁移 |

### 2.2 一条硬规则

> **不允许存在"只在库里、正文里找不到"的卡片。**
> AI 生成的候选卡、批量导入的卡片，都必须先**落进 Markdown**，再被扫描进库。
> 数据库里 `cards` 表的每一行，都能在某个 `.md` 文件里指到它的原文。

反过来，库里的行缺失是可接受的（`orphaned`），因为丢失通常是暂时的。

### 2.3 为什么不做"卡片完全存库、Markdown 只当素材"

那样确实能做出更强的卡片系统（跨笔记重组、批量打标签、无限字段）。但它会同时失去：

- **删库即失忆**：一次误删/磁盘损坏，几年的知识卡片全没
- **Obsidian / VS Code / git 全看不见卡片**：卡片改动无法 diff、无法 review、无法回滚
- **违背已定的底线**："任何一天不玩了，笔记一行都不会丢"
- **AI 批改无痕**：AI 生成的卡直接进库，你再也说不清"这句话是我写的还是它写的"

我们现在要的"库"，是**索引 + 状态**，不是**知识本体**。

---

## 3. 关联的本质：三级身份

### 3.1 关联链

```
  cards 行 ──block_ref──► blocks 行 ──note_id──► notes 行
     │                       │                      │
     │ 内容来自               │ 内容来自              │ 内容来自
     ▼                       ▼                      ▼
  正文里的 `- ? 问题`      正文里的 `^sys1`      frontmatter 的 `rn_id`
                        （挂在某个 Block 行尾）   （写在笔记开头）
```

**关键一句：卡片挂在哪个块上，是正文里写着的事实（`^id` 跟在哪个 Block 后面），不是数据库里的私货。**
所以用 Obsidian 打开、用记事本改、用 git 切分支，关联关系都还在；数据库只是把它索引出来以加速查询。

### 3.2 三级身份与降级策略

| 层 | 稳定标识 | 写在哪 | 什么时候写 | 认不回时的降级 |
| --- | --- | --- | --- | --- |
| **笔记** | `rn_id`（8 位短码，如 `k3f9a2c1`） | frontmatter | **这篇笔记创建第一张卡时**懒写入 | 按「标题 + 创建时间」匹配；再不行 → 卡片进孤儿区 |
| **块** | `^blockId` | Block 行尾 | **给这个块造第一张卡时**懒写入（沿用现有设计） | 按块文本哈希（`text_hash`）在该笔记内匹配 |
| **卡片** | `#序号`（同块内第几张） | 正文顺序 | 解析时得出 | 按问题指纹匹配（已有实现，见 rnote-design §2.5） |

三级都是**懒写入**——不写卡、不做块引用的笔记，正文里一个字都不会多。这保住了"三层结构可选"的原则。

### 3.3 为什么笔记级也要稳定 id

只用路径当笔记标识，会遇到三种情况：

| 情况 | 只有路径 | **有 `rn_id`** |
| --- | --- | --- |
| 应用内重命名/移动 | 可以级联更新 ✅ | 不用管 ✅ |
| 在 Obsidian / 资源管理器里改名 | 卡片全部变孤儿 ❌ | 认回 ✅ |
| git 切分支 / 同步冲突导致文件短暂消失 | 卡片全部变孤儿 ❌ | 标 `missing`，回来即认回 ✅ |

`rn_id` 只在有卡片时才写入，所以它出现在 frontmatter 里的那 8 位，是"这篇笔记已经进入复习系统"的标记。

---

## 4. Schema

```sql
PRAGMA journal_mode = WAL;      -- 崩溃安全 + 并发读写
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;        -- schema 版本，迁移依据

-- ── 笔记层：文件在库里的投影 ──────────────────────────────
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,          -- rn_id；缺省时用 path 的稳定哈希兜底
  path        TEXT NOT NULL,             -- 仓库相对路径，'/' 分隔
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'none',   -- inbox|internalizing|output|archived|none
  kind        TEXT NOT NULL DEFAULT 'note',   -- course|book|article|clip|idea|output|note
  source      TEXT,
  captured_at TEXT,
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  block_count INTEGER NOT NULL DEFAULT 0,     -- 全部 Block 数（含没有 ^id 的），算覆盖率用
  card_count  INTEGER NOT NULL DEFAULT 0,
  missing     INTEGER NOT NULL DEFAULT 0,     -- 文件暂时不见了
  scanned_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_notes_path ON notes(path);
CREATE INDEX idx_notes_status ON notes(status);

-- ── 块层：只有带 ^id 的块才进表（没有 id 就挂不住卡）──────
CREATE TABLE blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  block_id   TEXT NOT NULL,              -- 正文里的 ^sys1
  text       TEXT NOT NULL,              -- 块原文（冗余，供搜索与复习展示）
  heading    TEXT,                       -- 所属小节，复习时给上下文
  depth      INTEGER NOT NULL DEFAULT 0, -- 缩进层级
  line       INTEGER NOT NULL,           -- 最近扫描到的行号（仅提示，会漂）
  text_hash  TEXT NOT NULL,              -- hash(规范化文本)，^id 丢了靠它认回
  UNIQUE(note_id, block_id)
);
CREATE INDEX idx_blocks_note ON blocks(note_id);
CREATE INDEX idx_blocks_hash ON blocks(note_id, text_hash);

-- ── 卡片层：内容来自 Markdown，状态只在库里 ──────────────
CREATE TABLE cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 代理键，永不变化
  block_ref   INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,          -- 同块内第几张（0 起）
  kind        TEXT NOT NULL,             -- 'qa' | 'cloze'
  question    TEXT NOT NULL,             -- ← 内容列
  answer      TEXT NOT NULL,             -- ← 内容列
  angle       TEXT,                      -- ← 内容列：辨析|应用|反例|边界
  fingerprint TEXT NOT NULL,             -- ← 内容列：问题规范化后的哈希
  key_hint    TEXT NOT NULL,             -- ← 展示用：rn_id::block_id#ordinal
  -- ↓↓↓ 状态列：只由评分写入，任何重扫都不许覆盖 ↓↓↓
  state       TEXT NOT NULL DEFAULT 'new',   -- new|learning|review|relearning
  due         TEXT,
  stability   REAL,
  difficulty  REAL,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  last_review TEXT,
  step        INTEGER,
  orphaned    INTEGER NOT NULL DEFAULT 0,    -- 归属暂时找不到
  updated_at  INTEGER NOT NULL,
  UNIQUE(block_ref, ordinal)
);
CREATE INDEX idx_cards_due   ON cards(due) WHERE orphaned = 0;
CREATE INDEX idx_cards_block ON cards(block_ref);
CREATE INDEX idx_cards_fp    ON cards(block_ref, fingerprint);

-- ── 复习历史：卡片删了也留档（故意不加外键）───────────────
CREATE TABLE reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    INTEGER NOT NULL,           -- 不加 FK：卡片没了历史也要在
  note_id    TEXT,
  rated_at   TEXT NOT NULL,
  rating     INTEGER NOT NULL,           -- 1=重来 2=困难 3=良好 4=简单
  elapsed_ms INTEGER,
  state      TEXT NOT NULL,
  stability  REAL,
  difficulty REAL,
  interval_d REAL
);
CREATE INDEX idx_reviews_time ON reviews(rated_at);

-- ── 配置与元信息 ────────────────────────────────────────
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version / algorithm / desired_retention / new_per_day /
-- reviews_per_day / last_full_scan
```

**两个刻意的决定：**

1. `cards.id` 是**代理键**（自增整数），不是 `rn_id::block_id#ordinal` 拼出来的字符串。
   因为块 id 改名时，主键不该跟着变——拼字符串做主键会让"改个 `^id`"变成一次主键迁移，
   而历史表还引用着旧主键。可读的 `key_hint` 单独存一列，给日志和导出用。
2. `reviews.card_id` **不加外键**。删掉一张卡不该抹掉"我曾经复习过它 12 次"这个事实。

---

## 5. 同步器：文件 → 库

### 5.1 核心规则（一句话）

> **重扫只覆盖内容列，永不触碰状态列。**
> 写回正文只发生在"你在应用里编辑卡片"时，且只写内容，不写状态。

| 列 | 来源 | 重扫时 |
| --- | --- | --- |
| `question` / `answer` / `kind` / `angle` / `fingerprint` / `key_hint` | Markdown | **覆盖** |
| `line` / `heading` / `depth` / `text` / `text_hash` / `block_count` / `card_count` | Markdown | **覆盖** |
| `status` / `kind` / `source` / `captured_at`（notes 行） | frontmatter | **覆盖** |
| `state` / `due` / `stability` / `difficulty` / `reps` / `lapses` / `last_review` / `step` | 评分 | **绝不覆盖** |
| `orphaned` / `missing` / `scanned_at` | 同步器自己 | 覆盖 |

### 5.2 算法

```
sync_vault(vault):
  ① 遍历 .md（复用现有 walkdir，跳过 .rnote/ 等）
  ② 每篇：
     a. mtime + size 都没变 → 跳过（快路径，日常 99% 走这里）
     b. 变了 → 读正文，解析 frontmatter + rnote.ts 的 Block/Card 结构
     c. notes 行 UPSERT：
          先按 rn_id 找 → 找到就只更新 path（**改名/移动自动认回**）
          找不到 → 按 path 找 → 命中说明是老笔记（尚未有卡，无需 rn_id）
          都没有 → 插入新行
     d. 对每个带 ^id 的 Block：按 (note_id, block_id) UPSERT；
          没命中就按 (note_id, text_hash) 试一次（^id 被改过）
     e. 对每张 Card，按降级阶梯匹配（见下）
     f. 记下"这一轮没见到的卡片 id"
  ③ 把 f 里的卡片标 orphaned = 1（**不删**，状态保留）
  ④ 文件不存在的 notes 行标 missing = 1（同样不删）
  ⑤ 孤儿区里超过 90 天、且用户确认过的卡片才真正清理
  ⑥ 更新 meta.last_full_scan
```

### 5.3 卡片匹配的降级阶梯

```
匹配一张卡（按优先级，命中即停）：
  ① (block_ref, ordinal)       —— 常规：块没动、顺序没动
  ② (block_ref, fingerprint)   —— 序号漂移：中间插了一张新卡
  ③ (note_id, fingerprint)     —— 块被拆/并/换 id：跨块在**同一篇笔记内**认回
  ④ 都没命中                     —— 认定是新卡，state = 'new'
本轮没被任何卡认领的旧行        —— orphaned = 1
```

阶梯 ③ 是这次新增的：原来的设计只在块内按指纹找，块一旦被拆开（一句拆成两句），卡片就成了孤儿。
放宽到"同一篇笔记内"能救回绝大多数情况，而且**不会跨笔记误认**（不同笔记里出现同样的问题，才真的该是两张卡）。

### 5.4 什么时候触发同步

| 时机 | 范围 | 耗时 |
| --- | --- | --- |
| 应用启动 | 增量（mtime 快路径） | 百篇笔记 < 100 ms |
| 编辑器保存某篇后 | 只同步这一篇 | 毫秒级 |
| 打开工作台 / 评审视图前 | 若距上次 > 30 s 则增量一次 | 同上 |
| 手动「重建索引」 | 全量（删表重扫，**保留状态列**） | 秒级 |

---

## 6. 关联在界面上长什么样

三级身份对应三种粒度的呈现，**同一个关联模型，三种用法**：

| 粒度 | 用在哪 | 数据来源 |
| --- | --- | --- |
| **笔记级** | 工作台看板、成熟度徽标 | `notes.card_count / block_count`，加 `cards` 聚合 |
| **块级** | 编辑器里的卡片圆点、右侧卡片面板 | `cards WHERE block_ref = ?` |
| **卡片级** | 复习界面、状态点、下次到期 | `cards` 单行 |

**跨笔记关联**（这是三级身份额外赚到的）：

- **块引用即共享**：笔记 B 里写 `[[笔记 A#^sys1]]`，指向的是同一个 `block_id` →
  在 B 里就能看到 A 那个块的卡片状态，甚至直接复习同一张卡（**不复制卡片**）
- **血缘链路**：材料（`00-输入`）→ 内化（`10-内化`）→ 输出（`20-输出`）
  用现成的反链引擎 + `sources` 字段串起来，库这边只提供"卡片挂在哪些块上"这一层

**孤儿区**：工作台底部一个入口「有 3 张卡找不到归属」→ 列出卡片 + 最后所在笔记 → 三个动作：
**重新指定块** / **移到别的笔记** / **删除**。默认什么都不做，因为"找不到"通常是暂时的。

---

## 7. 可重建性与迁移

| 场景 | 结果 |
| --- | --- |
| 删掉 `.rnote/rnote.db` | 内容索引、块、卡片**全部自动重建**；**FSRS 进度全部丢失** ⚠️ |
| git 切分支导致文件短暂消失 | `missing = 1`，切回来即认回；不产生孤儿 |
| 在 Obsidian 里改名笔记 | 靠 `rn_id` 认回，进度完整保留 |
| 在 Obsidian 里删掉一个带卡的 Block | 卡片进孤儿区，进度保留；重新粘回同一段文字（块文本哈希相同）可自动认回 |
| 把仓库整个拷到另一台机器 | 带上 `.rnote/rnote.db` 即可；不带也能用，只是复习进度归零 |

因此提供两个命令（都放在设置页）：

- **导出学习进度** → `.rnote/export/progress-YYYYMMDD.json`：按 `rn_id::block_id#ordinal` 键出的 FSRS 状态 + 历史
- **导入学习进度** → 合并进现有库（同键以"更成熟的一方"为准，避免误覆盖）

`.rnote/` 里自动放一个 `.gitignore`（内容 `*.db*`），避免二进制库污染笔记仓库的 git 历史。

---

## 8. 落地位置与顺序

这份设计与 [`workflow-design.md`](workflow-design.md) §9 路线图的对应关系：

| 阶段 | 存储相关的工作 |
| --- | --- |
| **P0** | `rusqlite` + schema v1 + **notes 表与同步器**（笔记级）→ 工作台、状态、成熟度的分母都有了 |
| **P1** | **blocks / cards 表** + 降级阶梯 + FSRS（`fsrs` crate）评分事务 + `reviews` 历史 |
| **P2** | 孤儿区界面、跨笔记块引用共享、导出/导入进度 |
| **P3** | 统计仪表盘直接查 `reviews`（热力图/留存率/成熟度分布） |

Rust 侧新增（`src-tauri/src/`）：

```
store.rs     连接管理、PRAGMA、schema 迁移（user_version）
sync.rs      遍历 + 解析 + UPSERT + 降级阶梯 + 孤儿标记
cards.rs     cards_of_note / cards_of_block / due_cards / orphans
review.rs    grade_card（事务：更新状态 + 追加 reviews）、stats
```

前端只通过命令拿数据，**不直接碰数据库**——和现有"前端不碰文件系统"的约定一致。

---

## 9. 一句话总结

**SQLite 存的是"我对知识的熟练度"和"知识的索引"，Markdown 存的永远是"知识本身"。**
关联不靠库里的外键，而靠写进正文的三级身份（`rn_id` → `^id` → `#序号`），
库的职责只是把这个关系**索引出来、查得快、算得准**——所以库坏了可以重建，笔记永远是你的。
