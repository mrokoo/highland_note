/**
 * 看一眼仓库的"身份"信息：初始化标记、笔记数、卡片数、以及备份情况。
 *
 *   node scripts/vault-state.mjs [仓库路径]
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "demo-vault";
const db = new DatabaseSync(join(root, ".rnote", "rnote.db"), { readOnly: true });

const meta = Object.fromEntries(
  db.prepare("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]),
);
const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

console.log(`仓库：${root}`);
console.log(`  初始化标记 initialized：${meta.initialized ?? "（没有）"}`);
console.log(`  记下的仓库路径：${meta.vault_root ?? "（没有）"}`);
console.log(`  上次同步：${meta.last_sync ?? "（没有）"}`);
console.log(`  笔记 ${count("notes")} 条，卡片 ${count("cards")} 张，复习记录 ${count("reviews")} 条`);

const backupsDir = join(root, ".rnote", "backups");
const backups = existsSync(backupsDir) ? readdirSync(backupsDir).filter((f) => f.endsWith(".db")) : [];
console.log(`  备份 ${backups.length} 份${backups.length ? `（最新 ${backups.sort().at(-1)}）` : ""}`);

// 磁盘上还有哪些 .md：它们跟应用已经没关系了，列出来只是让你心里有数
const disk = db
  .prepare("SELECT path FROM notes WHERE kind = 'note' ORDER BY path")
  .all()
  .map((row) => row.path);
console.log(`\n库里的笔记（${disk.length}）：`);
for (const path of disk) console.log(`  ${path}${existsSync(join(root, `${path}.md`)) ? "   ← 磁盘上还有同名 .md（不被读取）" : ""}`);
