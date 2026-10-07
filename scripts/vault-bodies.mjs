/**
 * 每篇笔记的正文摘要：核对"去掉角色标题"之后一个字都没少。
 *
 *   node scripts/vault-bodies.mjs [仓库路径]
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = process.argv[2] ?? "demo-vault";
const db = new DatabaseSync(join(root, ".rnote", "rnote.db"), { readOnly: true });

const rows = db
  .prepare(
    `SELECT n.path, p.content, p.role FROM parts p
     JOIN notes n ON n.id = p.note_id
     WHERE n.kind = 'note' ORDER BY n.path`,
  )
  .all();

console.log(`共 ${rows.length} 段：`);
for (const row of rows) {
  const head = row.content.split("\n")[0]?.slice(0, 40) ?? "";
  console.log(`  ${row.path}  [${row.role}] ${row.content.length} 字  首行：${JSON.stringify(head)}`);
  if (row.content.includes("## 输入") || row.content.includes("## 内化") || row.content.includes("## 输出")) {
    console.log("    ⚠ 还带着角色标题");
  }
}
