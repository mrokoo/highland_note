/**
 * RNote 解析器的验证脚本（不属于应用代码，用 Node 直接跑）：
 *
 *   node scripts/rnote-check.ts
 *
 * Node 24 原生支持类型擦除，所以不需要任何构建步骤。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseRNote, type RNoteDocument } from "../src/lib/rnote.ts";

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, "..", "docs", "rnote-sample.md");
const markdown = readFileSync(samplePath, "utf8");
const doc = parseRNote(markdown);

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(
    `[${mark}] ${label}` +
      (ok ? "" : `\n         期望 ${JSON.stringify(expected)}\n         实际 ${JSON.stringify(actual)}`),
  );
}

function findByText(doc: RNoteDocument, needle: string) {
  const block = doc.blocks.find((b) => b.text.includes(needle));
  if (!block) throw new Error(`没找到包含「${needle}」的 Block`);
  return block;
}

console.log("=== 解析结果 ===");
console.log(`标题: ${doc.title}`);
console.log(`Block 数: ${doc.blocks.length}，卡片数: ${doc.cardCount}\n`);

for (const block of doc.blocks) {
  const indent = "  ".repeat(block.depth);
  console.log(`${indent}● [${block.id}] ${block.text.split("\n")[0]}`);
  if (block.heading) console.log(`${indent}  小节: ${block.heading}`);
  for (const card of block.cards) {
    const tag = card.tag ? ` #${card.tag}` : "";
    const kind = card.kind === "cloze" ? "填空" : "问答";
    console.log(`${indent}  └─ (${kind}${tag}) ${card.question.replace(/\n/g, " ")}`);
    console.log(`${indent}     答: ${card.answer.split("\n")[0]}   key=${card.key}`);
  }
}

console.log("\n=== 断言 ===");

check("Block 数量（代码块与待办不计入）", doc.blocks.length, 4);
check("卡片总数", doc.cardCount, 7);
check("标题取自一级标题", doc.title, "思考，快与慢");

const sys1 = findByText(doc, "系统 1 是快速");
check("^sys1 被识别为显式 id", [sys1.id, sys1.hasExplicitId], ["sys1", true]);
check("sys1 的卡片数", sys1.cards.length, 2);
check("默认答案就是 Block 原文", sys1.cards[0].answer, sys1.text);
check("角度标签被解析", sys1.cards[1].tag, "应用");
check("卡片 key", sys1.cards.map((c) => c.key), ["sys1#0", "sys1#1"]);

const sys2b = findByText(doc, "系统 2 并不会主动接管");
check("嵌套 Block 的深度", sys2b.depth, 1);
check("嵌套 Block 的父节点", sys2b.parent, "sys2");
check("嵌套 Block 保留小节上下文", sys2b.heading, "系统 1 与系统 2");

const anchor = findByText(doc, "锚定效应");
check("显式答案被解析", anchor.cards[0].answer, "先抛出一个高参考价，让真实售价显得便宜。");
check("显式答案的问题不含 ::", anchor.cards[0].question, "在产品定价中如何利用锚定效应？");
check(
  "填空卡挖空当前空位、其余还原",
  anchor.cards[2].question,
  "锚定效应是指人们在做判断时过度依赖______。",
);
check("填空卡答案", anchor.cards[2].answer, "最先获得的信息");
check("填空卡排在问答卡之后", anchor.cards.map((c) => c.kind), ["qa", "qa", "cloze"]);

check("代码块里的 `- ?` 没有变成卡片", doc.blocks.some((b) => b.text.includes("这不是卡片")), false);
check("待办没有被当成 Block", doc.blocks.some((b) => b.text.includes("待办")), false);

const keys = doc.blocks.flatMap((b) => b.cards.map((c) => c.key));
check("卡片 key 全局唯一", new Set(keys).size, keys.length);

// 编辑容错：在中间插入一张新卡，序号会漂，但指纹能把原来的复习进度认回来
const shifted = parseRNote(
  markdown.replace(
    "    - ? 系统 1 的特点是什么？",
    "    - ? 系统 1 会自动运行吗？\n    - ? 系统 1 的特点是什么？",
  ),
);
const shiftedCards = findByText(shifted, "系统 1 是快速").cards;
check("插入新卡后序号漂移", shiftedCards[1].key, "sys1#1");
check("原卡指纹不变，可认回进度", shiftedCards[1].fingerprint, sys1.cards[0].fingerprint);

// 标点与空白不影响指纹
const reflowed = parseRNote(markdown.replace("系统 1 的特点是什么？", "系统 1 的特点是什么 ? "));
check(
  "标点/空白变化不影响指纹",
  findByText(reflowed, "系统 1 是快速").cards[0].fingerprint,
  sys1.cards[0].fingerprint,
);

// 自动 id：没写 ^id 的 Block 也能拿到稳定临时 id
const noIds = parseRNote("- 没有写 id 的陈述句。\n    - ? 它是什么？\n");
check("未写 id 时自动推导", noIds.blocks[0].hasExplicitId, false);
check("自动 id 仍然可用", noIds.blocks[0].cards[0].key.endsWith("#0"), true);

console.log(`\n结果: ${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
if (failures > 0) process.exitCode = 1;
