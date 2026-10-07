/**
 * 块（Block）的选区处理：把编辑器里选中的一段笔记，拆成"可以单独提问"的块。
 *
 * 与 `rnote.ts` 的分工：那边的解析器认的是**正文里写死的标记**（`- ? 问题` 这种把卡
 * 存在正文里的老方案）；这里认的是**用户的选区**——因为卡片已经改成"建卡时把选中的
 * 文字快照进卡片自己身上"，正文不需要再为了卡片长出任何标记。
 *
 * 三个约定：
 * - 空行分段：一个非空行块就是一个块；
 * - 列表项自带边界：连续的 `-` / `1.` 行，每个列表项各成一个块；
 * - 代码块整段跳过：示例代码不该变成复习卡。
 */

export interface SelectedBlock {
  /** 块的原文（去掉列表符号与行尾的 `^id`） */
  text: string;
  /** 块在文档里的第一行（1 起） */
  line: number;
  /** 所在小节标题；没有标题时是笔记标题，再没有才是空串 */
  heading: string;
  /** 预填的问题 */
  question: string;
}

const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[[ xX]\]\s/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
/** 行尾的块引用 id（Obsidian 语法），建卡时不该出现在问题里 */
const BLOCK_ID_RE = /\s*\^([A-Za-z0-9][\w-]*)\s*$/;

function indentWidth(leading: string): number {
  return leading.replace(/\t/g, "    ").length;
}

/** 选区起点所在的小节：就近往上看标题，标题层级自己拼 `›`。 */
export function headingContextAt(lines: string[], from: number): string {
  const path: string[] = [];
  for (let i = Math.min(from, lines.length - 1); i >= 0; i -= 1) {
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;
    const level = match[1].length;
    // 从近往远扫描，所以每一级都是先遇到最近的那个，后来的标题只能是它的上级；
    // 数组要够长才放得下这一级（中间的槽位留空，最后 filter 掉）
    if (path.length < level) path.length = level;
    path[level - 1] = match[2].trim();
  }
  // 一级标题是笔记标题，不当小节用（和预览里的目录一致）
  return path
    .slice(1)
    .filter(Boolean)
    .join(" › ");
}

/** 从块原文生成一个草稿问题：够短就直接问，太长就截断——问题得能一眼看完。 */
export function draftQuestion(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (/[?？]$/.test(flat)) return flat;
  if (flat.length <= 24) return `${flat}？`;
  return `${flat.slice(0, 24)}……？`;
}

/** 去掉行尾的 `^id`，留下可读的块原文。 */
function stripBlockId(text: string): string {
  return text.replace(BLOCK_ID_RE, "").trim();
}

/**
 * 把选中的文字（以及它在全文里的起始位置）拆成块。
 *
 * `content` 是整篇笔记；`from` / `to` 是字符偏移（CodeMirror 的选区）。
 */
export function blocksFromSelection(content: string, from: number, to: number): SelectedBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const startLine = content.slice(0, from).split("\n").length - 1;
  const endLine = content.slice(0, to).split("\n").length - 1;

  const blocks: SelectedBlock[] = [];
  const heading = headingContextAt(lines, startLine);
  let inFence = false;
  let pending: { text: string; line: number } | null = null;

  const flush = () => {
    if (!pending) return;
    const text = stripBlockId(pending.text);
    if (text) {
      blocks.push({
        text,
        line: pending.line,
        heading: headingContextAt(lines, pending.line - 1) || heading,
        question: draftQuestion(text),
      });
    }
    pending = null;
  };

  for (let index = startLine; index <= Math.min(endLine, lines.length - 1); index += 1) {
    const raw = lines[index];

    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;

    if (!raw.trim()) {
      flush();
      continue;
    }

    // 标题只用来给后面的块当上下文，本身不成块
    if (HEADING_RE.test(raw)) {
      flush();
      continue;
    }

    const list = LIST_RE.exec(raw);
    if (list) {
      const content_ = list[2].trim();
      if (TASK_RE.test(content_)) {
        flush();
        continue;
      }
      // 顶格列表项各成一块；缩进子项并进上一块的正文（作为它的补充说明）
      if (indentWidth(list[1]) === 0 || !pending) {
        flush();
        pending = { text: content_, line: index + 1 };
      } else if (pending) {
        pending.text = `${pending.text}\n${content_}`;
      }
      continue;
    }

    // 普通段落行：紧跟着上一行的并进同一块，空行之后另起一块
    if (pending) pending.text = `${pending.text}\n${raw.trim()}`;
    else pending = { text: raw.trim(), line: index + 1 };
  }

  flush();
  return blocks;
}
