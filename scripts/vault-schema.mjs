/**
 * 列出仓库库里每张表的列，用来核对代码用到的列是否真的存在。
 *
 *   node scripts/vault-schema.mjs [仓库路径]
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = process.argv[2] ?? "demo-vault";
const db = new DatabaseSync(join(root, ".rnote", "rnote.db"), { readOnly: true });

console.log(`仓库：${root}（user_version=${db.prepare("PRAGMA user_version").get().user_version}）`);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((row) => row.name);

for (const table of tables) {
  const columns = db
    .prepare(`SELECT name, type, "notnull" AS nn FROM pragma_table_info(?)`)
    .all(table);
  console.log(`\n${table}（${columns.length} 列）：`);
  console.log(
    "  " +
      columns
        .map((column) => `${column.name}${column.nn ? "*" : ""}`)
        .join(", "),
  );
}
