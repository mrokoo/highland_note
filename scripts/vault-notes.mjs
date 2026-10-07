/**
 * 把 demo-vault 库里的笔记树打印出来（只读），用来核对文件面板该显示什么。
 *
 *   node scripts/vault-notes.mjs [仓库路径]
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = process.argv[2] ?? "demo-vault";
const db = new DatabaseSync(join(root, ".rnote", "rnote.db"), { readOnly: true });

const rows = db
  .prepare(
    `SELECT n.id, n.parent_id, n.kind, n.title, n.path, n.status,
            (SELECT COUNT(*) FROM parts p WHERE p.note_id = n.id) AS parts,
            (SELECT COUNT(*) FROM cards c WHERE c.note_id = n.id) AS cards
     FROM notes n ORDER BY n.path`,
  )
  .all();

console.log(`notes 表 ${rows.length} 行：`);
for (const row of rows) {
  console.log(
    `  ${row.kind === "folder" ? "[目录]" : "[笔记]"} ${row.path}  parent=${row.parent_id ?? "-"} parts=${row.parts} cards=${row.cards} status=${row.status}`,
  );
}

const roots = rows.filter((row) => row.parent_id === null).map((row) => row.path);
console.log(`\n根节点（${roots.length}）：${roots.join(", ") || "（没有）"}`);
const orphans = rows.filter(
  (row) => row.parent_id !== null && !rows.some((other) => other.id === row.parent_id),
);
if (orphans.length) console.log(`孤儿节点（父级不在表里，树里看不见）：${orphans.map((r) => r.path).join(", ")}`);

/** 文件面板那棵树现在按路径推导目录（见 notes.rs 的 tree()），这里复刻一遍。 */
const dirs = new Map();
const ensureDirs = (dir) => {
  let acc = "";
  for (const segment of dir.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${segment}` : segment;
    if (!dirs.has(acc)) dirs.set(acc, { name: segment, path: acc, children: [] });
  }
};
const top = [];
for (const row of rows) {
  if (row.kind === "folder") ensureDirs(row.path);
  else if (row.path.includes("/")) ensureDirs(row.path.slice(0, row.path.lastIndexOf("/")));
}
for (const row of rows) {
  if (row.kind === "folder") continue;
  const node = { name: row.title, path: row.path, children: [] };
  const slash = row.path.lastIndexOf("/");
  if (slash < 0) top.push(node);
  else dirs.get(row.path.slice(0, slash))?.children.push(node);
}
for (const path of [...dirs.keys()].filter((p) => p.includes("/")).sort((a, b) => b.length - a.length)) {
  const node = dirs.get(path);
  dirs.get(path.slice(0, path.lastIndexOf("/")))?.children.push(node);
}
for (const path of dirs.keys()) {
  if (!path.includes("/")) top.push(dirs.get(path));
}
const shape = (nodes, depth = 0) =>
  nodes
    .flatMap((node) => [
      `${"  ".repeat(depth)}${node.children.length && !node.path.includes("/") ? "[目录] " : ""}${node.name}  (${node.path})`,
      ...shape(node.children, depth + 1),
    ])
    .join("\n");
console.log(`\n文件面板会显示 ${top.length} 个根节点：\n${shape(top)}`);
