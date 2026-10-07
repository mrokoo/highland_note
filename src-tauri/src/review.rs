//! 复习排期：FSRS 调度 + 到期查询 + 评分落盘。
//!
//! 设计见 `docs/workflow-design.md` §4.5：状态只写在库里（`.rnote/rnote.db` 的 `cards` 表），
//! 笔记正文永远不被复习流程改动——两条写路径彻底分开，永不相撞。

use fsrs::{MemoryState, FSRS};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// 期望留存率：FSRS 的目标是"到到期日时，你还能记住的概率"。
const DESIRED_RETENTION: f32 = 0.9;

// ------------------------------------------------------------------ 日期工具

/// `YYYY-MM-DD` → 自 1970-01-01 起的天数（Howard Hinnant 的 civil 算法，不引依赖）。
pub fn parse_day(text: &str) -> Option<i64> {
    let mut parts = text.trim().split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// 自 1970-01-01 起的天数 → `YYYY-MM-DD`。
pub fn format_day(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

// ------------------------------------------------------------------ 数据结构

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueCard {
    pub id: i64,
    /// 所属笔记（卡片挂在块上，块属于笔记——所以卡片天然有归属）
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub source_heading: String,
    /// 建卡时选中文字的**快照**（不跟正文同步，正文改了它也不变）
    pub source_text: String,
    pub kind: String,
    pub question: String,
    pub answer: String,
    pub angle: String,
    pub line: u32,
    pub state: String,
    pub due: Option<String>,
    pub stability: Option<f64>,
    pub reps: i64,
    pub lapses: i64,
    /// 新卡（还没复习过）
    pub fresh: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeResult {
    pub due: String,
    pub interval_days: f64,
    pub state: String,
    pub stability: f64,
    pub difficulty: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStats {
    pub total: i64,
    pub fresh: i64,
    pub learning: i64,
    pub review: i64,
    pub due_today: i64,
    pub reviewed_today: i64,
}

// ------------------------------------------------------------------ 查询

/// 今日到期 + 新卡。
///
/// **按笔记分组**：同一篇笔记的卡片连在一起，一篇过完再换下一篇——而不是所有卡片混成一个大池子。
/// `note_path` 不为空时只取那一篇（工作台里"复习这篇"用）。
pub fn due_cards(
    conn: &Connection,
    today: &str,
    limit: usize,
    note_path: Option<&str>,
) -> Result<Vec<DueCard>, String> {
    let sql = "
        SELECT c.id, n.id, n.path, n.title, COALESCE(c.source_heading, ''), COALESCE(c.source_text, ''),
               c.kind, c.question, c.answer, c.angle, COALESCE(c.source_line, 0), c.state, c.due,
               c.stability, c.reps, c.lapses
        FROM cards c
        JOIN notes n ON n.id = c.note_id
        WHERE n.kind = 'note'
          AND (c.due IS NULL OR c.due <= ?1)
          AND (?2 IS NULL OR n.path = ?2)
        ORDER BY n.path, (c.state = 'new') ASC, c.due ASC, c.id
        LIMIT ?3";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![today, note_path, limit as i64], |row| {
            let state: String = row.get(11)?;
            Ok(DueCard {
                id: row.get(0)?,
                note_id: row.get(1)?,
                path: row.get(2)?,
                title: row.get(3)?,
                source_heading: row.get(4)?,
                source_text: row.get(5)?,
                kind: row.get(6)?,
                question: row.get(7)?,
                answer: row.get(8)?,
                angle: row.get(9)?,
                line: row.get::<_, i64>(10)? as u32,
                fresh: state == "new",
                state,
                due: row.get(12)?,
                stability: row.get(13)?,
                reps: row.get(14)?,
                lapses: row.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 每篇笔记的到期数量（工作台上"这篇有几张到期"）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDue {
    pub path: String,
    pub title: String,
    pub due: i64,
    pub total: i64,
}

pub fn due_by_note(conn: &Connection, today: &str) -> Result<Vec<NoteDue>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.path, n.title,
                    SUM(CASE WHEN c.due IS NULL OR c.due <= ?1 THEN 1 ELSE 0 END) AS due,
                    COUNT(*) AS total
             FROM cards c
             JOIN notes n ON n.id = c.note_id
             WHERE n.kind = 'note'
             GROUP BY n.id
             HAVING SUM(CASE WHEN c.due IS NULL OR c.due <= ?1 THEN 1 ELSE 0 END) > 0
             ORDER BY due DESC, n.title",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([today], |row| {
            Ok(NoteDue {
                path: row.get(0)?,
                title: row.get(1)?,
                due: row.get(2)?,
                total: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn stats(conn: &Connection, today: &str) -> Result<ReviewStats, String> {
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap_or(0) };
    Ok(ReviewStats {
        total: count("SELECT COUNT(*) FROM cards"),
        fresh: count("SELECT COUNT(*) FROM cards WHERE state = 'new'"),
        learning: count("SELECT COUNT(*) FROM cards WHERE state IN ('learning','relearning')"),
        review: count("SELECT COUNT(*) FROM cards WHERE state = 'review'"),
        due_today: conn
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE due IS NULL OR due <= ?1",
                [today],
                |row| row.get(0),
            )
            .unwrap_or(0),
        reviewed_today: conn
            .query_row(
                "SELECT COUNT(*) FROM reviews WHERE substr(rated_at, 1, 10) = ?1",
                [today],
                |row| row.get(0),
            )
            .unwrap_or(0),
    })
}

// ------------------------------------------------------------------ 卡片

/// 一张卡片（右侧卡片面板与复习界面共用）。
///
/// v5 起卡片是**挂在笔记上**的独立行：建卡时把选中的块文字快照进 `source_text`，
/// 所以之后改正文、拆句、挪位置都不影响已有卡片，复习进度也就不会丢。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: i64,
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub kind: String,
    pub question: String,
    pub answer: String,
    pub angle: String,
    /// 建卡时选中文字的**快照**（不跟正文同步）
    pub source_text: String,
    pub source_heading: String,
    pub source_line: i64,
    pub state: String,
    pub due: Option<String>,
    pub stability: Option<f64>,
    pub reps: i64,
    pub lapses: i64,
    /// 今天是不是该复习它（新卡或已到期）——卡片面板的筛选直接用这个
    pub due_now: bool,
    /// 本次调用是新建的（false = 命中同一张卡，没重复插）
    pub created: bool,
}

/// 建卡入参：来源快照由调用方（编辑器里的选区）给全。
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCard {
    pub path: String,
    #[serde(default)]
    pub kind: String,
    pub question: String,
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub angle: String,
    #[serde(default)]
    pub source_text: String,
    #[serde(default)]
    pub source_heading: String,
    #[serde(default)]
    pub source_line: i64,
}

/// 一篇笔记的卡片小结（右栏顶部那行数字）。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSummary {
    pub fresh: i64,
    pub due: i64,
    pub learning: i64,
    pub review: i64,
    pub total: i64,
}

const CARD_COLUMNS: &str = "c.id, c.note_id, n.path, n.title, c.kind, c.question, c.answer, c.angle,
     COALESCE(c.source_text, ''), COALESCE(c.source_heading, ''), COALESCE(c.source_line, 0),
     c.state, c.due, c.stability, c.reps, c.lapses";

fn row_to_card(row: &rusqlite::Row<'_>, today: &str) -> rusqlite::Result<Card> {
    let due: Option<String> = row.get(12)?;
    let state: String = row.get(11)?;
    Ok(Card {
        id: row.get(0)?,
        note_id: row.get(1)?,
        path: row.get(2)?,
        title: row.get(3)?,
        kind: row.get(4)?,
        question: row.get(5)?,
        answer: row.get(6)?,
        angle: row.get(7)?,
        source_text: row.get(8)?,
        source_heading: row.get(9)?,
        source_line: row.get(10)?,
        // 新卡没有到期日，但从建出来那一刻就该复习
        due_now: due.is_none() || due.as_deref().is_some_and(|day| day <= today),
        state,
        due,
        stability: row.get(13)?,
        reps: row.get(14)?,
        lapses: row.get(15)?,
        created: true,
    })
}

fn note_id_of(conn: &Connection, path: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT id FROM notes WHERE path = ?1 AND kind = 'note'",
        [path],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("找不到笔记：{path}"))
}

/// 某篇笔记的全部卡片，新卡在前、同状态按建卡顺序。
pub fn cards_of_note(conn: &Connection, path: &str, today: &str) -> Result<Vec<Card>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CARD_COLUMNS} FROM cards c
             JOIN notes n ON n.id = c.note_id
             WHERE n.path = ?1
             ORDER BY (c.state = 'new') DESC, c.due IS NULL DESC, c.due ASC, c.id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([path], |row| row_to_card(row, today))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 问题指纹：忽略大小写、空白与常见标点。用来挡住"同一句问两遍"。
fn question_fingerprint(question: &str) -> String {
    let normalized: String = question
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && !"，。、；：？！,.;:?!\"'“”‘’()（）[]【】<>《》—-#*`^".contains(*c))
        .collect();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 建卡：卡片挂在笔记上，自带选中文字的快照。
///
/// 同一个问题（指纹相同）在这篇笔记里只留一张——重复按快捷键不会插出一堆一样的卡，
/// 返回的 `created = false` 就是"已经有这张卡了"。
pub fn create_card(conn: &Connection, input: &NewCard, today: &str) -> Result<Card, String> {
    let question = input.question.trim();
    if question.is_empty() {
        return Err("问题不能为空".to_string());
    }
    let note_id = note_id_of(conn, &input.path)?;
    let fingerprint = question_fingerprint(question);

    if let Some(existing) = find_card(conn, &note_id, &fingerprint, today)? {
        return Ok(existing);
    }

    let kind = if input.kind == "cloze" { "cloze" } else { "qa" };
    // 答案默认就是块原文；只有显式写了自定义答案才用自定义的
    let answer = {
        let text = input.answer.trim();
        if text.is_empty() {
            input.source_text.trim()
        } else {
            text
        }
    };
    let ordinal: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM cards WHERE note_id = ?1",
            [note_id.as_str()],
            |row| row.get(0),
        )
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO cards (block_ref, ordinal, kind, question, answer, angle, fingerprint, line,
                            note_id, source_text, source_heading, source_line)
         VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            ordinal,
            kind,
            question,
            answer,
            input.angle.trim(),
            fingerprint,
            input.source_line,
            note_id,
            input.source_text.trim(),
            input.source_heading.trim(),
            input.source_line,
        ],
    )
    .map_err(|e| format!("建卡失败：{e}"))?;

    let id = conn.last_insert_rowid();
    let mut card = conn
        .query_row(
            &format!(
                "SELECT {CARD_COLUMNS} FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?1"
            ),
            [id],
            |row| row_to_card(row, today),
        )
        .map_err(|e| e.to_string())?;
    card.created = true;
    Ok(card)
}

fn find_card(
    conn: &Connection,
    note_id: &str,
    fingerprint: &str,
    today: &str,
) -> Result<Option<Card>, String> {
    conn.query_row(
        &format!(
            "SELECT {CARD_COLUMNS} FROM cards c JOIN notes n ON n.id = c.note_id
             WHERE c.note_id = ?1 AND c.fingerprint = ?2 ORDER BY c.id LIMIT 1"
        ),
        params![note_id, fingerprint],
        |row| row_to_card(row, today),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|card| card.map(|mut card| {
        card.created = false;
        card
    }))
}

/// 删卡：只删卡片行，正文一个字都不动（卡片本来就不在正文里）。
pub fn delete_card(conn: &Connection, card_id: i64) -> Result<(), String> {
    let affected = conn
        .execute("DELETE FROM cards WHERE id = ?1", [card_id])
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err(format!("找不到卡片：{card_id}"));
    }
    Ok(())
}

/// 一篇笔记的卡片小结。
pub fn card_summary(conn: &Connection, path: &str, today: &str) -> Result<CardSummary, String> {
    let (fresh, due, learning, review, total): (i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT SUM(CASE WHEN c.state = 'new' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN c.due IS NULL OR c.due <= ?2 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN c.state IN ('learning','relearning') THEN 1 ELSE 0 END),
                    SUM(CASE WHEN c.state = 'review' THEN 1 ELSE 0 END),
                    COUNT(*)
             FROM cards c JOIN notes n ON n.id = c.note_id
             WHERE n.path = ?1",
            params![path, today],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(CardSummary {
        fresh,
        due,
        learning,
        review,
        total,
    })
}

/// 仓库里全部卡片的计数（左侧「复习」徽标用）。
pub fn card_counts(conn: &Connection, today: &str) -> Result<CardSummary, String> {
    let (fresh, due, learning, review, total): (i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN due IS NULL OR due <= ?1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN state IN ('learning','relearning') THEN 1 ELSE 0 END),
                    SUM(CASE WHEN state = 'review' THEN 1 ELSE 0 END),
                    COUNT(*)
             FROM cards",
            [today],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(CardSummary {
        fresh,
        due,
        learning,
        review,
        total,
    })
}

// ------------------------------------------------------------------ 评分

/// 四档评分：1 重来 / 2 困难 / 3 良好 / 4 简单。返回下一次到期。
pub fn grade(conn: &Connection, card_id: i64, rating: u8, today: &str) -> Result<GradeResult, String> {
    let rating = rating.clamp(1, 4);
    let today_days = parse_day(today).ok_or_else(|| format!("日期格式不对：{today}"))?;

    let (state, stability, difficulty, last_review, due_before): (String, Option<f64>, Option<f64>, Option<String>, Option<String>) =
        conn.query_row(
            "SELECT state, stability, difficulty, last_review, due FROM cards WHERE id = ?1",
            [card_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|_| format!("找不到卡片：{card_id}"))?;

    let elapsed = last_review
        .as_deref()
        .and_then(parse_day)
        .map(|day| (today_days - day).max(0) as u32)
        .unwrap_or(0);

    let memory = match (stability, difficulty) {
        (Some(stability), Some(difficulty)) if state != "new" => Some(MemoryState {
            stability: stability as f32,
            difficulty: difficulty as f32,
        }),
        _ => None,
    };

    let fsrs = FSRS::default();
    let next = fsrs
        .next_states(memory, DESIRED_RETENTION, elapsed)
        .map_err(|e| format!("FSRS 计算失败：{e}"))?;
    let item = match rating {
        1 => next.again,
        2 => next.hard,
        3 => next.good,
        _ => next.easy,
    };

    let interval = item.interval.max(0.0);
    // 到期日按天存。**打「重来」的卡当天就要再见到**（Anki 的重学步长也是这个意思），
    // 复习界面会把它排到本轮末尾；其余按 FSRS 给的间隔四舍五入。
    let due_days = if rating == 1 {
        today_days
    } else {
        today_days + interval.round().max(1.0) as i64
    };
    let due = format_day(due_days);

    let next_state = if rating == 1 {
        "relearning"
    } else if memory.is_none() || state == "relearning" {
        "review"
    } else {
        state.as_str()
    };
    let lapsed = if rating == 1 && state == "review" { 1 } else { 0 };

    conn.execute(
        "UPDATE cards SET state = ?1, due = ?2, stability = ?3, difficulty = ?4,
                          reps = reps + 1, lapses = lapses + ?5, step = NULL, last_review = ?6
         WHERE id = ?7",
        params![
            next_state,
            due,
            item.memory.stability as f64,
            item.memory.difficulty as f64,
            lapsed,
            today,
            card_id
        ],
    )
    .map_err(|e| format!("写排期失败：{e}"))?;

    conn.execute(
        "INSERT INTO reviews (card_id, rated_at, rating, state, stability, difficulty, interval_d,
                              before_state, before_stability, before_difficulty, before_due, before_last)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            card_id,
            format!("{today}T00:00:00"),
            rating as i64,
            next_state,
            item.memory.stability as f64,
            item.memory.difficulty as f64,
            interval,
            state,
            stability,
            difficulty,
            due_before,
            last_review
        ],
    )
    .map_err(|e| format!("写复习历史失败：{e}"))?;

    Ok(GradeResult {
        due,
        interval_days: interval as f64,
        state: next_state.to_string(),
        stability: item.memory.stability as f64,
        difficulty: item.memory.difficulty as f64,
    })
}

/// 撤掉最近一次评分（复习界面按错了能退回来）。
pub fn undo_last(conn: &Connection, card_id: i64) -> Result<(), String> {
    // 评分时把"评分前"的状态一起存了，撤销就是把它们原样放回去
    let previous: Option<(i64, Option<String>, Option<f64>, Option<f64>, Option<String>, Option<String>)> =
        conn.query_row(
            "SELECT id, before_state, before_stability, before_difficulty, before_due, before_last
             FROM reviews WHERE card_id = ?1 ORDER BY id DESC LIMIT 1",
            [card_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .ok();

    let Some((review_id, state, stability, difficulty, due, last)) = previous else {
        return Err("这张卡还没有可撤销的评分".to_string());
    };

    conn.execute("DELETE FROM reviews WHERE id = ?1", [review_id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE cards SET state = COALESCE(?1, 'new'), stability = ?2, difficulty = ?3,
                          due = ?4, last_review = ?5, reps = MAX(reps - 1, 0),
                          lapses = MAX(lapses - 1, 0)
         WHERE id = ?6",
        params![state, stability, difficulty, due, last, card_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------------ 单元测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;
    use std::fs;

    #[test]
    fn date_roundtrip() {
        for text in ["2026-01-01", "2026-10-07", "2024-02-29", "1999-12-31"] {
            let days = parse_day(text).unwrap();
            assert_eq!(format_day(days), text);
        }
        assert_eq!(parse_day("2026-10-08").unwrap() - parse_day("2026-10-07").unwrap(), 1);
        assert!(parse_day("乱写").is_none());
    }

    /// 造一篇笔记 + 两张卡（卡片自带快照，这是"选中文字建卡"之后的形态）。
    fn seeded_vault(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("hn-review-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let conn = store::open(&dir).unwrap();
        crate::notes::create_with_content(
            &conn,
            "",
            "测试",
            "## 内化\n\n系统 1 是直觉系统。\n",
        )
        .unwrap();
        let note_id: String = conn
            .query_row("SELECT id FROM notes WHERE path = '测试'", [], |r| r.get(0))
            .unwrap();
        for (index, question) in ["它有什么特点？", "它什么时候会出错？"].iter().enumerate() {
            conn.execute(
                "INSERT INTO cards (block_ref, ordinal, kind, question, answer, angle, fingerprint,
                                    line, note_id, source_text, source_heading, source_line)
                 VALUES (NULL, ?1, 'qa', ?2, '系统 1 是直觉系统。', '', ?3, 0, ?4,
                         '系统 1 是直觉系统。', '内化', 3)",
                rusqlite::params![index as i64, question, format!("fp{index}"), note_id],
            )
            .unwrap();
        }
        (dir, conn)
    }

    #[test]
    fn new_cards_are_due_and_grading_schedules_them() {
        let (root, conn) = seeded_vault("grade");
        let today = "2026-10-07";

        let due = due_cards(&conn, today, 20, None).unwrap();
        assert_eq!(due.len(), 2, "两张新卡都该到期");
        assert!(due.iter().all(|card| card.fresh));

        let first = &due[0];
        assert_eq!(first.title, "测试");
        assert_eq!(first.source_heading, "内化", "来源小节来自建卡时的位置");
        assert_eq!(first.source_text, "系统 1 是直觉系统。");

        // 打「良好」：应当排到未来某天，并且不再是新卡
        let result = grade(&conn, first.id, 3, today).unwrap();
        assert!(result.interval_days > 0.0, "良好应当给正间隔：{result:?}");
        assert!(result.due.as_str() > today, "到期日应当在今天之后：{}", result.due);
        assert_eq!(result.state, "review");
        assert!(result.stability > 0.0);

        let stats = stats(&conn, today).unwrap();
        assert_eq!(stats.total, 2);
        assert_eq!(stats.fresh, 1);
        assert_eq!(stats.review, 1);
        assert_eq!(stats.due_today, 1, "排到未来的那张不该再出现在今天");
        assert_eq!(stats.reviewed_today, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn again_brings_the_card_back_today_and_counts_a_lapse() {
        let (root, conn) = seeded_vault("again");
        let today = "2026-10-07";
        let card = &due_cards(&conn, today, 20, None).unwrap()[0];

        // 先正常复习一次，进入 review 状态
        let first = grade(&conn, card.id, 3, today).unwrap();
        assert_eq!(first.state, "review");

        // 到期日再来一次，打「重来」
        let later = first.due.clone();
        let result = grade(&conn, card.id, 1, &later).unwrap();
        assert_eq!(result.state, "relearning");
        assert_eq!(result.due, later, "重来的卡当天再来");
        let (lapses, reps): (i64, i64) = conn
            .query_row("SELECT lapses, reps FROM cards WHERE id = ?1", [card.id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(lapses, 1);
        assert_eq!(reps, 2);

        // 撤销最近一次评分
        undo_last(&conn, card.id).unwrap();
        let (state, reps): (String, i64) = conn
            .query_row("SELECT state, reps FROM cards WHERE id = ?1", [card.id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(state, "review");
        assert_eq!(reps, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn queue_groups_by_note_and_can_be_scoped_to_one() {
        let (root, conn) = seeded_vault("group");
        let today = "2026-10-07";
        // 再加一篇笔记，两篇各两张卡
        crate::notes::create_with_content(&conn, "", "第二篇", "## 内化\n\n另一条陈述。\n").unwrap();
        let other_id: String = conn
            .query_row("SELECT id FROM notes WHERE path = '第二篇'", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO cards (block_ref, ordinal, kind, question, answer, angle, fingerprint,
                                line, note_id, source_text, source_heading, source_line)
             VALUES (NULL, 0, 'qa', '第二个问题？', '另一条陈述。', '', 'fpB', 0, ?1,
                     '另一条陈述。', '内化', 3)",
            rusqlite::params![other_id],
        )
        .unwrap();

        let all = due_cards(&conn, today, 50, None).unwrap();
        assert_eq!(all.len(), 3, "测试 两张 + 第二篇 一张");
        // 同一篇笔记的卡片必须连在一起
        let paths: Vec<&str> = all.iter().map(|card| card.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted, "队列应当按笔记聚在一起：{paths:?}");
        assert!(!all[0].note_id.is_empty(), "卡片带着所属笔记的 id");

        // 只复习某一篇
        let only_b = due_cards(&conn, today, 50, Some("第二篇")).unwrap();
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].path, "第二篇");

        // 每篇的到期数
        let per_note = due_by_note(&conn, today).unwrap();
        assert_eq!(per_note.len(), 2);
        let a = per_note.iter().find(|row| row.path == "测试").unwrap();
        assert_eq!(a.due, 2);
        assert_eq!(a.total, 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deleting_the_card_clears_it_from_the_queue() {
        let (root, conn) = seeded_vault("delete");
        let today = "2026-10-07";
        assert_eq!(due_cards(&conn, today, 20, None).unwrap().len(), 2);
        // 删掉一张卡片 → 队列里也没了（卡片是独立行，删了就是删了）
        conn.execute("DELETE FROM cards WHERE id = (SELECT MIN(id) FROM cards)", [])
            .unwrap();
        assert_eq!(due_cards(&conn, today, 20, None).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    /// 造一个空仓库 + 一篇笔记，用来测"选中块建卡"。
    fn note_vault(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("hn-cards-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let conn = store::open(&dir).unwrap();
        crate::notes::create_with_content(
            &conn,
            "",
            "系统 1",
            "## 内化\n\n系统 1 是快速、自动、几乎不费力气的直觉系统。\n",
        )
        .unwrap();
        (dir, conn)
    }

    fn sample_card(path: &str, question: &str) -> NewCard {
        NewCard {
            path: path.to_string(),
            kind: "qa".into(),
            question: question.into(),
            answer: String::new(),
            angle: "回忆".into(),
            source_text: "系统 1 是快速、自动、几乎不费力气的直觉系统。".into(),
            source_heading: "内化".into(),
            source_line: 3,
        }
    }

    #[test]
    fn creating_a_card_keeps_the_selected_block_as_a_snapshot() {
        let (root, conn) = note_vault("create");
        let today = "2026-10-07";

        let card = create_card(&conn, &sample_card("系统 1", "系统 1 的特点是什么？"), today).unwrap();
        assert!(card.created);
        assert_eq!(card.angle, "回忆");
        // 答案默认就是块原文——不填 answer 时不需要调用方操心
        assert_eq!(card.answer, "系统 1 是快速、自动、几乎不费力气的直觉系统。");
        assert_eq!(card.source_heading, "内化");
        assert_eq!(card.source_line, 3);
        assert_eq!(card.state, "new");
        assert!(card.due_now, "刚建的卡今天就该出现在复习队列里");
        assert!(!card.note_id.is_empty(), "卡片带着所属笔记的 id");

        // 正文改了，卡片的来源快照不动
        crate::notes::write(
            &conn,
            "系统 1",
            "## 内化\n\n系统 1 换了一种说法。\n",
            None,
        )
        .unwrap();
        let again = cards_of_note(&conn, "系统 1", today).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(
            again[0].source_text,
            "系统 1 是快速、自动、几乎不费力气的直觉系统。",
            "快照不跟正文同步"
        );

        // 排期队列里也能看到它
        let due = due_cards(&conn, today, 20, None).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].question, "系统 1 的特点是什么？");

        let summary = card_summary(&conn, "系统 1", today).unwrap();
        assert_eq!((summary.total, summary.fresh, summary.due), (1, 1, 1));

        let counts = card_counts(&conn, today).unwrap();
        assert_eq!((counts.total, counts.fresh), (1, 1));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_question_is_not_asked_twice() {
        let (root, conn) = note_vault("dedupe");
        let today = "2026-10-07";

        let first = create_card(&conn, &sample_card("系统 1", "系统 1 的特点是什么？"), today).unwrap();
        // 标点与空白不算差别：连按两次快捷键不该插出两张一样的卡
        let second = create_card(&conn, &sample_card("系统 1", " 系统1的特点是什么 "), today).unwrap();
        assert!(!second.created);
        assert_eq!(second.id, first.id);
        assert_eq!(cards_of_note(&conn, "系统 1", today).unwrap().len(), 1);

        // 换个角度问同一件事：那是另一张卡
        let mut other = sample_card("系统 1", "系统 1 什么时候会出错？");
        other.answer = "自定义答案".into();
        let third = create_card(&conn, &other, today).unwrap();
        assert!(third.created);
        assert_eq!(third.answer, "自定义答案", "显式给的答案优先于块原文");
        assert_eq!(cards_of_note(&conn, "系统 1", today).unwrap().len(), 2);

        // 空问题直接拒绝
        assert!(create_card(&conn, &sample_card("系统 1", "   "), today).is_err());
        // 笔记不存在时说清楚是哪一篇
        assert!(create_card(&conn, &sample_card("不存在的笔记", "问题"), today).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deleting_a_card_removes_it_from_the_panel_and_the_queue() {
        let (root, conn) = note_vault("delete_card");
        let today = "2026-10-07";
        let card = create_card(&conn, &sample_card("系统 1", "系统 1 的特点是什么？"), today).unwrap();

        delete_card(&conn, card.id).unwrap();
        assert!(cards_of_note(&conn, "系统 1", today).unwrap().is_empty());
        assert!(due_cards(&conn, today, 20, None).unwrap().is_empty());
        assert_eq!(card_summary(&conn, "系统 1", today).unwrap().total, 0);
        assert!(delete_card(&conn, card.id).is_err(), "删第二次要说找不到");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_card_survives_reopening_the_vault() {
        let (root, conn) = note_vault("persist");
        let today = "2026-10-07";
        create_card(&conn, &sample_card("系统 1", "系统 1 的特点是什么？"), today).unwrap();
        drop(conn);

        // 重开仓库（真实使用里每次命令都会走一遍 store::open）之后卡片还在
        let conn = store::open(&root).unwrap();
        let cards = cards_of_note(&conn, "系统 1", today).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(card_summary(&conn, "系统 1", today).unwrap().fresh, 1);
        // 再建一次同一个问题：认得出是同一张，不重复插
        let again = create_card(&conn, &sample_card("系统 1", "系统 1 的特点是什么？"), today).unwrap();
        assert!(!again.created);
        assert_eq!(again.id, cards[0].id);

        let _ = fs::remove_dir_all(&root);
    }
}
