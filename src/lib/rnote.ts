/**
 * RNote 三层结构解析：Note（一篇 Markdown）> Block（原子陈述句）> Card（对 Block 的提问）。
 *
 * 设计要点：
 * - 笔记本身是唯一事实来源，不引入第二份内容数据；
 * - 解析是纯函数、零依赖，编辑器、预览、后端都能复用同一份规则；
 * - Block 用 `^id` 标识（就是 Obsidian 的块引用语法），Card 是 Block 的子列表项、以 `?` 开头，
 *   填空用 `{{...}}`。
 */

export type CardKind = "qa" | "cloze";

export interface RNoteCard {
  /** 卡片稳定标识：`<blockId>#<index>` */
  key: string;
  blockId: string;
  index: number;
  kind: CardKind;
  /** 问题；填空卡是挖空后的整句 */
  question: string;
  /** 答案；填空卡是被挖掉的那一段 */
  answer: string;
  /** 角度标签（回忆 / 应用 / 辨析……），没有则为空串 */
  tag: string;
  /** 问题指纹：编辑导致序号漂移时用它认回原来的复习进度 */
  fingerprint: string;
  /** 源文件行号，1 起 */
  line: number;
}

export interface RNoteBlock {
  /** `^id`；没有写 id 的 Block 这里是自动推导的临时 id */
  id: string;
  /** 是否已经在文件里写死了 `^id` */
  hasExplicitId: boolean;
  /** 去掉 `^id`、去掉卡片子项后的正文（保留 `{{}}` 挖空标记） */
  text: string;
  /** 展示用正文：`{{}}` 已展开为内容 */
  plain: string;
  /** 所在小节标题，用于复习时给出上下文 */
  heading: string;
  line: number;
  /** 列表缩进（空格数，Tab 按 4 算） */
  indent: number;
  /** 嵌套深度 */
  depth: number;
  /** 上一层 Block 的 id */
  parent: string | null;
  cards: RNoteCard[];
}

export interface RNoteDocument {
  title: string;
  blocks: RNoteBlock[];
  /** 整篇的卡片总数 */
  cardCount: number;
}

const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[[ xX]\]\s/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BLOCK_ID_RE = /\s*\^([A-Za-z0-9][\w-]*)\s*$/;
const CLOZE_RE = /\{\{([^{}]+)\}\}/g;
const FENCE_RE = /^\s*(```|~~~)/;

/** 把 `{{挖空}}` 展开成明文，用于展示与默认答案。 */
export function expandCloze(text: string): string {
  return text.replace(CLOZE_RE, (_whole, inner: string) => inner);
}

/** 把一行开头的空白换算成缩进宽度。 */
function indentWidth(leading: string): number {
  return leading.replace(/\t/g, "    ").length;
}

/** 内容指纹：忽略大小写、空白与常见标点，用于认回编辑过的卡片。 */
export function fingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[\s]+/g, "")
    .replace(/[，。、；：？！,.;:?!"'“”‘’()（）\[\]【】<>《》—-]/g, "");
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** 从文本推导一个稳定的短 id（只在 Block 还没有 `^id` 时作为临时值）。 */
export function deriveBlockId(text: string, taken: Set<string>): string {
  const base = fingerprint(text).slice(0, 5) || "b";
  let candidate = base;
  let n = 1;
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * 解析 `- ? 问题 | 标签` 或 `- ? 问题 :: 答案`。
 * 标签取自整行末尾，所以必须先摘掉标签再找 `::`，
 * 否则 `:: 答案 | 应用` 里的标签会被并进答案。
 */
function parseCardBody(content: string): { question: string; answer: string; tag: string } {
  let body = content.replace(/^\?\s*/, "").trim();
  let tag = "";
  const pipe = body.lastIndexOf("|");
  if (pipe >= 0) {
    const maybe = body.slice(pipe + 1).trim();
    if (maybe && !maybe.includes("|")) {
      tag = maybe;
      body = body.slice(0, pipe).trim();
    }
  }
  let answer = "";
  const divider = body.indexOf("::");
  if (divider >= 0) {
    answer = body.slice(divider + 2).trim();
    body = body.slice(0, divider).trim();
  }
  return { question: body, answer, tag };
}

function makeQaCard(block: RNoteBlock, content: string, line: number, index: number): RNoteCard {
  const { question, answer, tag } = parseCardBody(content);
  return {
    key: `${block.id}#${index}`,
    blockId: block.id,
    index,
    kind: "qa",
    question,
    // 没写 `::` 答案时，答案就是 Block 原文——这正是「先理解、再提问」的默认姿势
    answer: answer || block.plain,
    tag,
    fingerprint: fingerprint(question),
    line,
  };
}

/** 一个 `{{...}}` 生成一张填空卡，评测时只挖掉当前这一处。 */
function makeClozeCards(block: RNoteBlock, startIndex: number): RNoteCard[] {
  const matches = [...block.text.matchAll(CLOZE_RE)];
  return matches.map((match, offset) => {
    let seen = 0;
    const question = block.text.replace(CLOZE_RE, (_whole, inner: string) => {
      const current = seen;
      seen += 1;
      return current === offset ? "______" : inner;
    });
    return {
      key: `${block.id}#${startIndex + offset}`,
      blockId: block.id,
      index: startIndex + offset,
      kind: "cloze" as const,
      question,
      answer: match[1].trim(),
      tag: "",
      fingerprint: fingerprint(`${question}::${match[1]}`),
      line: block.line,
    };
  });
}

/** 解析一篇 RNote 笔记。 */
export function parseRNote(markdown: string): RNoteDocument {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: RNoteBlock[] = [];
  const taken = new Set<string>();
  const stack: RNoteBlock[] = [];
  const headingPath: string[] = [];

  /** 一级标题视为笔记标题，不再重复出现在 Block 的上下文里。 */
  const headingContext = () =>
    headingPath
      .slice(1)
      .filter(Boolean)
      .join(" › ");

  let title = "";
  let cursor = 0;
  let inFence = false;
  let frontmatter = false;

  // YAML frontmatter
  if (lines[0]?.trim() === "---") {
    frontmatter = true;
    cursor = 1;
  }

  let currentBlock: RNoteBlock | null = null;

  for (; cursor < lines.length; cursor += 1) {
    const raw = lines[cursor];
    const lineNo = cursor + 1;

    if (frontmatter) {
      if (raw.trim() === "---") frontmatter = false;
      continue;
    }

    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      currentBlock = null;
      continue;
    }
    if (inFence) continue;

    if (!raw.trim()) {
      currentBlock = null;
      continue;
    }

    const heading = HEADING_RE.exec(raw);
    if (heading) {
      const level = heading[1].length;
      headingPath.length = level - 1;
      headingPath[level - 1] = heading[2].trim();
      if (level === 1 && !title) title = heading[2].trim();
      stack.length = 0;
      currentBlock = null;
      continue;
    }

    const list = LIST_RE.exec(raw);
    if (list) {
      const indent = indentWidth(list[1]);
      const content = list[2].trim();

      // `- [ ] 待办` 是任务，不是 RNote 的 Block
      if (TASK_RE.test(content)) continue;

      // 卡片：以 `?` 开头的子项
      if (content.startsWith("?")) {
        let parent: RNoteBlock | null = null;
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].indent < indent) {
            parent = stack[i];
            break;
          }
        }
        currentBlock = null;
        if (parent) {
          parent.cards.push(makeQaCard(parent, content, lineNo, parent.cards.length));
        }
        continue;
      }

      // 普通列表项：一个 Block
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : null;
      const idMatch = BLOCK_ID_RE.exec(content);
      const explicit = idMatch ? idMatch[1] : "";
      const text = (idMatch ? content.slice(0, idMatch.index) : content).trim();
      const id = explicit || deriveBlockId(text, taken);
      taken.add(id);

      const block: RNoteBlock = {
        id,
        hasExplicitId: Boolean(explicit),
        text,
        plain: expandCloze(text),
        heading: headingContext(),
        line: lineNo,
        indent,
        depth: stack.length,
        parent: parent ? parent.id : null,
        cards: [],
      };
      blocks.push(block);
      stack.push(block);
      currentBlock = block;
      continue;
    }

    // 非列表行：带 `^id` 的段落也算 Block，否则视为上一 Block 的续行
    const idMatch = BLOCK_ID_RE.exec(raw);
    const trimmed = raw.trim();
    if (idMatch && !list) {
      const text = raw.slice(0, raw.length - idMatch[0].length).trim();
      const explicit = idMatch[1];
      const id = explicit || deriveBlockId(text, taken);
      taken.add(id);
      while (stack.length && stack[stack.length - 1].indent >= 0) stack.pop();
      const block: RNoteBlock = {
        id,
        hasExplicitId: Boolean(explicit),
        text,
        plain: expandCloze(text),
        heading: headingContext(),
        line: lineNo,
        indent: 0,
        depth: 0,
        parent: null,
        cards: [],
      };
      blocks.push(block);
      stack.push(block);
      currentBlock = block;
      continue;
    }
    if (currentBlock && !idMatch) {
      currentBlock.text = `${currentBlock.text}\n${trimmed}`.trim();
      currentBlock.plain = expandCloze(currentBlock.text);
    }
  }

  // 填空卡统一在最后生成，保证 `- ?` 卡片的序号不受影响
  let total = 0;
  for (const block of blocks) {
    const cloze = makeClozeCards(block, block.cards.length);
    block.cards.push(...cloze);
    total += block.cards.length;
  }

  return { title, blocks, cardCount: total };
}
