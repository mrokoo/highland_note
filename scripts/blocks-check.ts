/**
 * 选区 → 块 的验证脚本（不属于应用代码，用 Node 直接跑）：
 *
 *   node scripts/blocks-check.ts
 *
 * 这里量的是"选中一段笔记之后，会变成几张卡"——也就是造卡这条链的第一公里。
 * 规则写死在 `src/lib/blocks.ts` 的注释里，这个脚本就是把那些话变成断言。
 */
import { blocksFromSelection, draftQuestion, headingContextAt } from "../src/lib/blocks.ts";

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

const NOTE = [
  "---",
  "status: internalizing",
  "---",
  "",
  "# 思考，快与慢",
  "",
  "## 系统 1 与系统 2",
  "",
  "- 系统 1 是快速、自动、几乎不费力气的直觉系统。 ^sys1",
  "- 系统 2 是缓慢、需要注意力、消耗心力的理性系统。",
  "  它并不会主动接管判断。",
  "",
  "锚定效应是指人们在做判断时过度依赖最先获得的信息。",
  "",
  "```js",
  "const never = 'a card';",
  "```",
  "",
  "- [ ] 这不是块",
  "- 这是一句陈述，带着一个问题？",
].join("\n");

/** 选区 = 从某段文字的开头选到某段文字的结尾（更接近人手动拉选区的样子）。 */
function select(fromText: string, toText = fromText) {
  const from = NOTE.indexOf(fromText);
  const to = NOTE.indexOf(toText, from) + toText.length;
  if (from < 0 || to <= from) throw new Error(`选区定位失败：${fromText}`);
  return blocksFromSelection(NOTE, from, to);
}

console.log("=== 小节上下文 ===");
const lines = NOTE.split("\n");
check("块所在小节一直被带出来", headingContextAt(lines, 8), "系统 1 与系统 2");
check("正文段落的小节同上", headingContextAt(lines, 12), "系统 1 与系统 2");
check("一级标题不算小节（那是笔记标题）", headingContextAt(lines, 4), "");
check(
  "多级标题拼成一条路径",
  headingContextAt(["# 书", "## 上部", "### 第 3 章", "正文"], 3),
  "上部 › 第 3 章",
);

console.log("\n=== 选中一行 ===");
const single = select("系统 1 是快速");
check("一条陈述 = 一个块", single.length, 1);
check("去掉行尾的 ^id", single[0].text, "系统 1 是快速、自动、几乎不费力气的直觉系统。");
check("行号是文档里的真实行号", single[0].line, 9);
check("小节跟着块走", single[0].heading, "系统 1 与系统 2");
check(
  "短句直接成问",
  single[0].question,
  "系统 1 是快速、自动、几乎不费力气的直觉系统。？",
);

console.log("\n=== 选中多行（跨空行的两段）===");
const two = select("系统 2 是缓慢", "最先获得的信息。");
check("空行分段：带子项的列表块 + 一个段落块", two.length, 2);
check("列表块连子项一起", two[0].text.split("\n").length, 2);
check("第二块的原文", two[1].text, "锚定效应是指人们在做判断时过度依赖最先获得的信息。");
check("第二块的行号", two[1].line, 13);

console.log("\n=== 列表项的边界 ===");
const list = select("- 系统 2 是缓慢", "- 这是一句陈述，带着一个问题？");
check("每个顶格列表项各成一块（任务项不算）", list.length, 3);
check(
  "列表符号不进正文",
  list[0].text.split("\n")[0],
  "系统 2 是缓慢、需要注意力、消耗心力的理性系统。",
);
check("缩进的子项并进上一块", list[0].text.split("\n")[1], "它并不会主动接管判断。");
check("段落也成块", list[1].text, "锚定效应是指人们在做判断时过度依赖最先获得的信息。");
check("任务项不是块", list[2].text, "这是一句陈述，带着一个问题？");
check(
  "代码块整段跳过",
  list.every((block) => !block.text.includes("const never")),
  true,
);
check(
  "选区从列表中间开始时，不牵连上面的段落",
  select("系统 2 是缓慢").length,
  1,
);

console.log("\n=== 草稿问题 ===");
check("短句加问号", draftQuestion("系统 1 是直觉系统。"), "系统 1 是直觉系统。？");
check("已经是问句就不再叠问号", draftQuestion("系统 1 的特点是什么？"), "系统 1 的特点是什么？");
check(
  "长句截断，问题得能一眼看完",
  draftQuestion("锚定效应是指人们在做判断时过度依赖最先获得的信息，即使这个信息与判断无关。"),
  "锚定效应是指人们在做判断时过度依赖最先获得的信息……？",
);

console.log(failures ? `\n${failures} 项不符` : "\n全部通过");
process.exit(failures ? 1 : 0);
