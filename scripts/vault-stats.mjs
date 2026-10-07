/**
 * 看一眼 demo-vault 的库：schema 版本、笔记数、卡片数。
 *
 *   node scripts/vault-stats.mjs [仓库路径]
 *
 * 用 Node 24 自带的 node:sqlite（只读，不写任何东西）。
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = process.argv[2] ?? "demo-vault";
const db = new DatabaseSync(join(root, ".rnote", "rnote.db"), { readOnly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);
const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

console.log(`仓库：${root}`);
console.log(`schema 版本：${db.prepare("PRAGMA user_version").get().user_version}`);
console.log(`表：${tables.join(", ")}`);
for (const table of ["notes", "parts", "cards", "reviews"]) {
  if (tables.includes(table)) console.log(`  ${table}: ${count(table)}`);
}

const cards = db
  .prepare(
    `SELECT n.path, c.question, c.state, c.due, c.angle, c.source_line
     FROM cards c JOIN notes n ON n.id = c.note_id ORDER BY c.id`,
  )
  .all();
if (cards.length) {
  console.log("\n卡片：");
  for (const card of cards) {
    console.log(`  [${card.state}] ${card.path}:${card.source_line} ${card.question}（${card.angle || "无角度"}，到期 ${card.due ?? "今天"}）`);
  }
}
