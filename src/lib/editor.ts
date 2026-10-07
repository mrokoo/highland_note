import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  placeholder,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  EditorState,
  Compartment,
  Prec,
  StateField,
  StateEffect,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxTree,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";

/** Markdown 语法着色：正文用主题色，标记符号做弱化处理。 */
const markdownHighlight = HighlightStyle.define([
  // 标题的行高和字号都由行装饰（.cm-heading-*）接管，这里只留一份同名变量兜底
  { tag: t.heading1, fontSize: "1.7em", fontWeight: "700", lineHeight: "var(--editor-heading-line-height)" },
  { tag: t.heading2, fontSize: "1.45em", fontWeight: "700", lineHeight: "var(--editor-heading-line-height)" },
  { tag: t.heading3, fontSize: "1.25em", fontWeight: "600" },
  { tag: t.heading4, fontSize: "1.12em", fontWeight: "600" },
  { tag: [t.heading5, t.heading6], fontWeight: "600" },
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: "var(--text-strong)" },
  { tag: t.strong, fontWeight: "700", color: "var(--text-strong)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.monospace, color: "var(--code-text)" },
  { tag: t.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent-soft)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--mark)" },
  { tag: t.contentSeparator, color: "var(--mark)" },
  { tag: t.labelName, color: "var(--accent)" },

  // 代码块里的语法着色。配色变量和预览用的 highlight.js 是同一套，
  // 缺了这段的话代码块只有单色（嵌套语言的解析结果没人上色）。
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-number)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--code-variable)" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "var(--code-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: "var(--code-function)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-builtin)" },
  { tag: [t.tagName, t.deleted], color: "var(--code-tag)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: "var(--text-muted)" },
  { tag: [t.escape, t.character, t.special(t.variableName)], color: "var(--code-builtin)" },
  { tag: [t.self, t.constant(t.variableName)], color: "var(--code-number)" },
  { tag: [t.definitionKeyword, t.modifier], color: "var(--code-keyword)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

/** 光标不在本行时折叠掉的 Markdown 标记（所见即所得）。 */
const HIDE_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "URL",
  "StrikethroughMark",
]);

/* ------------------------------------------------------------------ *
 * 行样式：让每一行看起来像 Notion 里的一个块
 *
 * 做法是给「整行」挂一个行装饰类，间距全部由 CSS 的上下内边距承担，
 * 而不是改 Markdown 源文或行高。这样光标进出行、折叠、撤销都不受影响。
 * ------------------------------------------------------------------ */

/** 一行是不是「空行」——空行相当于 Notion 里手敲出来的空块。 */
function isBlankLine(text: string): boolean {
  return !text.trim();
}

/**
 * 只用到语法节点的名字和父节点，所以这里用一个结构化的最小类型。
 *
 * 不直接从 `@lezer/common` 引 `SyntaxNode`：它不在 package.json 的依赖里，
 * 只是被 CodeMirror 顺带装上，显式 import 有可能哪天就找不到了。
 */
interface SyntaxAncestor {
  readonly name: string;
  readonly parent: SyntaxAncestor | null;
}

/**
 * 从叶子节点往外找某个祖先，判断这一行是不是长在引用块 / 表格 / 代码块里面。
 *
 * 按名字直接判断的地方（表格、引用）不需要它，但段落要：列表项里也套着
 * Paragraph，光看节点名会把它当成普通段落，多垫一层间距。
 */
function hasAncestor(node: SyntaxAncestor, names: Set<string>): boolean {
  let current = node.parent;
  while (current) {
    if (names.has(current.name)) return true;
    current = current.parent;
  }
  return false;
}

/** 嵌套层级：第一层是 1，往里的每一层 +1。 */
function listDepth(node: SyntaxAncestor): number {
  let depth = 1;
  let current = node.parent;
  while (current && depth < 6) {
    if (current.name === "ListItem") depth += 1;
    current = current.parent;
  }
  return depth;
}

/** 列表项里面套的块：这些由外层的列表行负责处理，自己不占行。 */
const LIST_CONTENT = new Set(["ListItem", "Blockquote", "Table", "FencedCode", "CodeBlock"]);

/** 引用块里的行由引用那一层统一负责。 */
const QUOTE_ANCESTORS = new Set(["Blockquote"]);

/**
 * 整行装饰的登记台。
 *
 * 同一行会被两趟扫描分别碰上（语法树那趟认得列表项，按行匹配那趟认得待办），
 * 所以这里按行号累积类名，最后合成一个行装饰——一行只留一个，
 * 免得两个 Decoration.line 抢同一个位置。
 */
class LineMarks {
  private readonly classes = new Map<number, string[]>();

  /** 给某一行追加一个类名（重复的类名会去掉）。 */
  add(doc: Text, lineFrom: number, cls: string): void {
    const number = doc.lineAt(lineFrom).number;
    const existing = this.classes.get(number);
    if (!existing) {
      this.classes.set(number, cls.split(" "));
      return;
    }
    for (const name of cls.split(" ")) {
      if (name && !existing.includes(name)) existing.push(name);
    }
  }

  /** 合成行装饰，按行号排好（Decoration.set 要求有序）。 */
  done(doc: Text): Range<Decoration>[] {
    return [...this.classes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([number, names]) =>
        Decoration.line({
          class: names.join(" "),
          /*
           * 顺手把行的文档起点写到 DOM 上。
           *
           * 块手柄要靠它认出「鼠标停的是哪一行」：行高是按块定的，
           * 光看第几个 .cm-line 对不上文档里的行号。
           */
          attributes: { "data-block-from": String(doc.line(number).from) },
        }).range(doc.line(number).from),
      );
  }
}

function selectionTouchesLine(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** 行内图片：直接渲染出来，点一下会退回源码编辑。 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-image";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    wrap.appendChild(img);
    return wrap;
  }

  // 返回 false：让编辑器接住点击，光标落进来就能改源码
  ignoreEvent() {
    return false;
  }
}

/** 待办复选框：点一下直接改写 `[ ]` / `[x]`。 */
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
    readonly view: EditorView,
  ) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-box";
    box.checked = this.checked;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return box;
  }
}

/** 分隔线：`---` 渲染成一条线。 */
class RuleWidget extends WidgetType {
  toDOM() {
    const rule = document.createElement("span");
    rule.className = "cm-rule";
    return rule;
  }

  ignoreEvent() {
    return false;
  }
}

/** 无序列表的圆点：源代码里的 `-` 换成 `•`。 */
class BulletWidget extends WidgetType {
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-bullet";
    dot.textContent = "•";
    return dot;
  }
}

/**
 * 表格：整块渲染成 HTML 表格。
 *
 * 跨行的替换装饰 CodeMirror 只允许由 StateField 提供（ViewPlugin 会直接抛
 * RangeError），所以表格走 tableField，见下面的 buildTables。
 */
class TableWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }

  eq(other: TableWidget) {
    return other.html === this.html;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-table";
    wrap.innerHTML = this.html;
    return wrap;
  }

  // 点一下就退回源码，光标落在表里就能直接改
  ignoreEvent() {
    return false;
  }
}

/**
 * 折叠标记：默认藏着，鼠标移到行号槽或光标停在那一行时才露出来。
 * CodeMirror 自带的 `⌄`/`›` 文字标记在宽槽里显得很突兀，这里换成小箭头。
 */
function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  marker.className = "cm-fold-marker";
  marker.setAttribute("aria-hidden", "true");
  marker.innerHTML = open
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  return marker;
}

export interface LivePreviewOptions {
  /** 把笔记里的图片地址换成 webview 能加载的地址 */
  imageSource?: (url: string) => string | null;
  /** 把表格源码渲染成 HTML（复用预览那套 Markdown 渲染） */
  renderTable?: (source: string) => string;
}

interface TableValue {
  decorations: DecorationSet;
  ranges: { from: number; to: number }[];
}

/** 找出整行表格，光标不在里面时用 HTML 表格替换掉。 */
function buildTables(state: EditorState, renderTable?: (source: string) => string): TableValue {
  const ranges: TableValue["ranges"] = [];
  const decorations: Range<Decoration>[] = [];

  if (renderTable) {
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== "Table") return;
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        // 块级替换必须整行，这里不满足就老实显示源码
        if (node.from !== first.from) return;
        const to = last.to;
        ranges.push({ from: first.from, to });
        const editing = state.selection.ranges.some((r) => r.from <= to && r.to >= first.from);
        if (editing) return;
        const html = renderTable(state.sliceDoc(first.from, to));
        if (html) {
          decorations.push(
            Decoration.replace({ widget: new TableWidget(html), block: true }).range(first.from, to),
          );
        }
      },
    });
  }

  return { decorations: Decoration.set(decorations, true), ranges };
}

function buildLivePreview(
  view: EditorView,
  options: LivePreviewOptions,
  skip: TableValue["ranges"] = [],
): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const replaces: { from: number; to: number; decoration: Decoration }[] = [];
  const { state } = view;

  // 已经被表格部件整块替换的范围，行内装饰要让开，否则会重叠报错
  const inSkipped = (from: number, to: number) => skip.some((r) => from < r.to && to > r.from);

  const replace = (from: number, to: number, decoration: Decoration) => {
    if (from >= to) return;
    replaces.push({ from, to, decoration });
  };

  /**
   * 把一段连续的行登记成同一个块（代码块、引用块用）。
   *
   * 末尾的 `-last` 只加在最后一行上，用来给整块收一个圆角；
   * 光标所在的那一行也不例外——这两个块样式不遮文字，留着更好认。
   */
  const decorateBlockLines = (nodeFrom: number, nodeTo: number, block: LineMarks, base: string) => {
    const first = state.doc.lineAt(nodeFrom).number;
    const last = state.doc.lineAt(Math.min(nodeTo, state.doc.length)).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      let cls = base;
      if (number === first) cls += ` ${base}-first`;
      if (number === last) cls += ` ${base}-last`;
      block.add(state.doc, line.from, cls);
    }
  };

  // 代码块里的内容不参与行内规则（`[[x]]`、`#标签` 在代码里就是普通文本）
  const codeLines = new Set<number>();

  // 整行的块样式统一在这里登记，防止同一行被叠上两个行装饰
  const block = new LineMarks();

  for (const { from, to } of view.visibleRanges) {
    const firstLine = state.doc.lineAt(from).number;
    const lastLine = state.doc.lineAt(to).number;

    // 第一遍：语法树，负责块级样式与标准 Markdown 标记
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // 已经被表格部件整块替换掉的，别再叠行内装饰
        if (inSkipped(node.from, node.to)) return;

        // 代码块 / 引用块是块级样式，光标在里面也要保留
        if (name === "FencedCode" || name === "CodeBlock") {
          decorateBlockLines(node.from, node.to, block, "cm-code-line");
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;
          for (let number = first; number <= last; number += 1) codeLines.add(number);
          /*
           * 收尾的围栏行（``` 那一行）在源码里必须占一行，但它是空的：
           * 单独标出来，让它不编辑时收掉高度——否则代码块下面会多出一条空白。
           * 缩进式代码块（CodeBlock）没有围栏，自然也不会走到这里。
           */
          const lastLine = state.doc.line(last);
          if (/^(?:\s*)(?:`{3,}|~{3,})\s*$/.test(lastLine.text)) {
            block.add(state.doc, lastLine.from, "cm-code-line-end");
          }
          return;
        }
        if (name === "Blockquote") {
          decorateBlockLines(node.from, node.to, block, "cm-quote-line");
          return;
        }

        // 列表项：整行做成一个块，悬停有底色，文字按层级缩进
        if (name === "ListItem") {
          if (hasAncestor(node.node, QUOTE_ANCESTORS)) return;
          block.add(state.doc, state.doc.lineAt(node.from).from, `cm-list-line cm-list-line-${listDepth(node.node)}`);
          return;
        }

        // 普通段落：上下留出段落间距。
        // 列表项里也套着 Paragraph，那种情况交给上面的 ListItem 处理。
        if (name === "Paragraph") {
          if (hasAncestor(node.node, LIST_CONTENT)) return;
          block.add(state.doc, state.doc.lineAt(node.from).from, "cm-para");
          return;
        }

        // 标题：字号写在自己的行装饰类里。
        // 高亮样式给的 fontSize 在这类整行节点上不可靠（实测只剩粗体和颜色），
        // 所以这里连字号一起接管；光标行也保留字号，只把 `#` 露出来。
        if (name.startsWith("ATXHeading")) {
          const first = state.doc.lineAt(node.from);
          block.add(
            state.doc,
            first.from,
            `cm-heading cm-heading-${name.slice(-1)} cm-heading-line`,
          );
          return;
        }

        if (node.from === node.to) return;
        const line = state.doc.lineAt(node.from);
        // 光标所在行保留原始语法，方便直接改
        if (selectionTouchesLine(state, line.from, line.to)) return;

        // 列表符号：无序的换成圆点，有序的淡淡地显示序号
        if (name === "ListMark") {
          if (/^[-*+]$/.test(state.sliceDoc(node.from, node.to))) {
            /*
             * 待办行的圆点不要：那一行已经有复选框了，前面再顶个「•」是多余的，
             * 还会把复选框比正文多推进去一截。方括号那一段由第二趟换成复选框。
             */
            const isTask = /^\s*[-*+]\s+\[[ xX]\]/.test(line.text);
            replace(
              node.from,
              node.to,
              isTask ? Decoration.replace({}) : Decoration.replace({ widget: new BulletWidget() }),
            );
          } else {
            marks.push(Decoration.mark({ class: "cm-list-number" }).range(node.from, node.to));
          }
          return;
        }

        // 行内代码：加个底色药丸
        if (name === "InlineCode") {
          marks.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
          return;
        }

        // 真正的行内链接 `[文字](地址)` 才加链接样式
        if (name === "Link" && /\]\(/.test(state.sliceDoc(node.from, node.to))) {
          marks.push(Decoration.mark({ class: "cm-link" }).range(node.from, node.to));
          return;
        }

        if (name === "HorizontalRule") {
          replace(node.from, node.to, Decoration.replace({ widget: new RuleWidget() }));
          return;
        }

        if (!HIDE_MARKS.has(name)) return;
        let end = node.to;
        if (
          (name === "HeaderMark" || name === "QuoteMark") &&
          state.doc.sliceString(end, end + 1) === " "
        ) {
          end += 1;
        }
        replace(node.from, end, Decoration.replace({}));
      },
    });

    // 第二遍：语法树里没有节点的写法，按行匹配
    for (let number = firstLine; number <= lastLine; number += 1) {
      if (codeLines.has(number)) continue;
      const line = state.doc.line(number);
      if (inSkipped(line.from, line.to)) continue;

      // 空行也是块：行高和正文一样，样式统一挂 .cm-blank-line（见主题里那个类）。
      // 这里刻意不看光标：空行没有「源码」可露，样式跟着选区变会让行高忽高忽低。
      if (isBlankLine(line.text)) {
        block.add(state.doc, line.from, "cm-blank-line");
        continue;
      }

      if (selectionTouchesLine(state, line.from, line.to)) continue;

      // 待办复选框
      const task = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(line.text);
      if (task) {
        const start = line.from + task[1].length;
        replace(
          start,
          start + 3,
          Decoration.replace({
            widget: new CheckboxWidget(task[2].toLowerCase() === "x", start, view),
          }),
        );
        // 待办行自己也要左右内边距和悬停底色：`- [ ] x` 语法树里没有 ListMark，
        // 上面那趟 ListItem 抓不到它，块间距只能在这里补。
        block.add(state.doc, line.from, "cm-task-line");
        if (task[2].toLowerCase() === "x") {
          block.add(state.doc, line.from, "cm-task-done");
        }
      }

      // 图片：直接按 `![alt](src)` 匹配，比依赖语法树稳
      for (const match of line.text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
        const start = line.from + (match.index ?? 0);
        const src = options.imageSource?.(match[2]);
        if (src) {
          replace(start, start + match[0].length, Decoration.replace({ widget: new ImageWidget(src, match[1]) }));
        }
      }

      // [[双链]]：藏掉方括号与目标，只留显示名
      for (const match of line.text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
        const start = line.from + (match.index ?? 0);
        const inner = match[1];
        const pipe = inner.lastIndexOf("|");
        const displayStart = pipe >= 0 ? start + 2 + pipe + 1 : start + 2;
        const displayEnd = start + match[0].length - 2;
        if (displayEnd <= displayStart) continue;
        replace(start, displayStart, Decoration.replace({}));
        replace(displayEnd, start + match[0].length, Decoration.replace({}));
        marks.push(Decoration.mark({ class: "cm-wikilink" }).range(displayStart, displayEnd));
      }

      // #标签
      for (const match of line.text.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
        const start = line.from + (match.index ?? 0) + match[1].length;
        marks.push(Decoration.mark({ class: "cm-hashtag" }).range(start, start + match[2].length + 1));
      }
    }
  }

  // 替换类装饰不能重叠：起点相同时让「范围大的」先占位。
  // 否则整段替换（比如图片部件）会被它内部的标记（`![`、URL）挤掉，
  // 结果是部件消失、只剩下被隐藏标记后的残缺文本。
  const ordered = [...replaces].sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Range<Decoration>[] = [];
  let cursor = -1;
  for (const item of ordered) {
    if (item.from < cursor) continue;
    kept.push(item.decoration.range(item.from, item.to));
    cursor = item.to;
  }

  return Decoration.set([...block.done(state.doc), ...kept, ...marks], true);
}

function livePreview(options: LivePreviewOptions, tableField: StateField<TableValue>) {
  const skipRanges = (state: EditorState) => state.field(tableField, false)?.ranges ?? [];

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildLivePreview(view, options, skipRanges(view.state));
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildLivePreview(update.view, options, skipRanges(update.state));
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * 改写光标所在行的块前缀。
 *
 * 「转换成」这一组动作共用它：先把行首已有的前缀（标题井号、列表符号、
 * 待办方框、引用尖括号）剥掉，再补上目标前缀。所以 H1 → 待办 → 段落
 * 之间来回切都不会越切越乱。
 */
function applyBlockPrefix(view: EditorView, prefix: string, caret: number) {
  const state = view.state;
  const line = state.doc.lineAt(state.selection.main.head);
  const match = /^(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line.text);
  const start = line.from + (match ? match[0].length : 0);
  view.dispatch({
    changes: { from: line.from, to: start, insert: prefix },
    selection: { anchor: line.from + caret },
    scrollIntoView: true,
  });
  view.focus();
}

/** 「转换成」菜单里的一项要用的动作。 */
function convertBlock(view: EditorView, kind: string): () => void {
  const options: Record<string, { prefix: string; caret: number }> = {
    paragraph: { prefix: "", caret: 0 },
    h1: { prefix: "# ", caret: 2 },
    h2: { prefix: "## ", caret: 3 },
    h3: { prefix: "### ", caret: 4 },
    bullet: { prefix: "- ", caret: 2 },
    number: { prefix: "1. ", caret: 3 },
    quote: { prefix: "> ", caret: 2 },
    code: { prefix: "```\n", caret: 4 },
  };
  const option = options[kind] ?? options.paragraph;
  return () => applyBlockPrefix(view, option.prefix, option.caret);
}

/** 「待办」是切换：已经是待办就变回普通段落。 */
function toggleTodo(view: EditorView): () => void {
  return () => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line.text)) applyBlockPrefix(view, "", 0);
    else applyBlockPrefix(view, "- [ ] ", 6);
  };
}

/** 删掉光标所在的这一行（连同换行）。 */
function deleteBlock(view: EditorView): () => void {
  return () => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    view.dispatch({
      changes: { from: line.from, to: Math.min(line.to + 1, view.state.doc.length) },
      selection: { anchor: line.from },
    });
    view.focus();
  };
}

/** 复制光标所在的这一行，插到它下面，光标跟到副本上。 */
function duplicateBlock(view: EditorView): () => void {
  return () => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const text = line.text;
    view.dispatch({
      changes: { from: line.to, insert: `\n${text}` },
      selection: { anchor: line.to + 1 + text.length },
      scrollIntoView: true,
    });
    view.focus();
  };
}

/** 块手柄要用到的宿主能力，由 EditorPane 注入。 */
export interface BlockHandleHost {
  /** 打开块菜单。坐标相对编辑器左上角。 */
  onBlockMenu: (request: BlockMenuRequest) => void;
  /** 把某一行也建成卡片（复用 Ctrl+Shift+C 那条路） */
  addCardForLine: (lineNumber: number) => void;
}

/** 块菜单里「转换成」这一组要用的动作，顺序就是菜单里的顺序。 */
const CONVERT_ITEMS: { key: string; label: string }[] = [
  { key: "paragraph", label: "正文" },
  { key: "h1", label: "标题 1" },
  { key: "h2", label: "标题 2" },
  { key: "h3", label: "标题 3" },
  { key: "bullet", label: "无序列表" },
  { key: "number", label: "有序列表" },
  { key: "quote", label: "引用" },
  { key: "code", label: "代码块" },
];

/** 块手柄菜单的内容。业务动作（造卡）走 host，排版动作编辑器自己就能做。 */
function blockMenuItems(view: EditorView, lineNumber: number): MenuEntry[] {
  const items: MenuEntry[] = [
    { label: "在下方插入一行", action: () => insertEmptyLineBelow(view, lineNumber) },
    // 菜单里不写快捷键提示，除非那个键真的绑上了——写个不存在的键比不写更糟
    { label: "复制这一块", action: duplicateBlock(view) },
  ];
  items.push({ separator: true });
  for (const entry of CONVERT_ITEMS) {
    items.push({ label: `转换成${entry.label}`, action: convertBlock(view, entry.key) });
  }
  items.push({ separator: true });
  items.push({ label: "待办", action: toggleTodo(view) });
  items.push({ separator: true });
  items.push({ label: "删除这一块", action: deleteBlock(view) });
  return items;
}

/** 在某一行下面开一个空行，光标落进去。 */
function insertEmptyLineBelow(view: EditorView, lineNumber: number) {
  const count = view.state.doc.lines;
  const line = view.state.doc.line(Math.max(1, Math.min(lineNumber, count)));
  view.dispatch({
    changes: { from: line.to, insert: "\n" },
    selection: { anchor: line.to + 1 },
    scrollIntoView: true,
  });
  view.focus();
}

/** 拖着块走时，落点用的那根横线。 */
class DropLineWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const bar = document.createElement("div");
    bar.className = "cm-drop-line";
    return bar;
  }
}

interface BlockHandleOptions {
  host: BlockHandleHost;
  /** 额外的菜单项（业务动作），选填 */
  menu?: (lineNumber: number) => MenuEntry[];
}

/** Notion 风格的 6 点抓取图标。 */
const GRIP_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
  '<g fill="currentColor">' +
  '<circle cx="6" cy="4" r="1.4"/><circle cx="10" cy="4" r="1.4"/>' +
  '<circle cx="6" cy="8" r="1.4"/><circle cx="10" cy="8" r="1.4"/>' +
  '<circle cx="6" cy="12" r="1.4"/><circle cx="10" cy="12" r="1.4"/>' +
  "</g></svg>";

/** 加号图标。 */
const PLUS_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M8 3.5v9M3.5 8h9"/></svg>';

/** 一行在拖动过程中的身份：拖的是整行（含行尾换行）。 */
interface DragState {
  /** 按下手柄那一刻的整篇文档，落下前核对，变了就不搬 */
  doc: string;
  from: number;
  to: number;
  text: string;
  /** 这一行按下时的像素位置，用来算移动方向 */
  top: number;
  bottom: number;
  startY: number;
  /** 已经挪开了一段距离，才算真的在拖 */
  moved: boolean;
  target: DropTarget | null;
}

/** 拖动过程中的落点。 */
interface DropTarget {
  /** 插到这个文档位置之前 */
  pos: number;
  /** 指示线画在哪个文档位置 */
  at: number;
}

/** 落点指示线的位置；null = 藏起来。 */
const dropLineEffect = StateEffect.define<number | null>();

/**
 * 落点指示线。
 *
 * 它是模块级常量、而且一开始就挂在扩展里，不是手柄插件自己 append 进去的：
 * 插件构造函数里 dispatch 事务会让 CodeMirror 的首次测量直接抛错
 * （view 还没量完就改配置）。字段永远在场，手柄只管往里写位置。
 */
const dropLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    const next = tr.effects.find((effect) => effect.is(dropLineEffect))?.value;
    if (next === undefined) return value.map(tr.changes);
    return next == null
      ? Decoration.none
      : Decoration.set([Decoration.widget({ widget: new DropLineWidget(), side: 1 }).range(next)]);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * 块手柄：鼠标停在哪一行，那一行左边就浮出「+」和「⋮⋮」。
 *
 * 它不在编辑器内部（不用 gutter），而是浮在编辑器上面的一层，
 * 靠 view.coordsAtPos 把行定位出来。这样不会去动行号槽，
 * 行高变了也不会把行号挤乱。
 */
class BlockHandle {
  private readonly container: HTMLElement;

  private readonly overlay: HTMLElement;

  private readonly menuButton: HTMLElement;

  private currentLine = 0;

  private drag: DragState | null = null;

  /** 刚拖完的那一下点击不要当成「点手柄」，否则菜单会在松手时自己弹出来。 */
  private keepClickClosed = false;

  /** 已经排了一次测量，别重复排队。 */
  private placing = false;

  /** 插件被销毁之后，排进队列的那次测量不能再动 DOM。 */
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly options: BlockHandleOptions,
  ) {
    this.container = document.createElement("div");
    this.container.className = "cm-block-handle";

    const insert = this.button("cm-block-add", PLUS_ICON, "在下方插入一行");
    insert.addEventListener("mousedown", (event) => event.preventDefault());
    insert.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.insertBelow();
    });

    // draggable=false：拖拽由 pointer 事件自己实现，不要浏览器那套原生拖放
    this.menuButton = this.button("cm-block-menu", GRIP_ICON, "拖动可移动这一块，点击打开菜单");
    this.menuButton.draggable = false;
    this.menuButton.addEventListener("mousedown", (event) => event.preventDefault());
    this.menuButton.addEventListener("pointerdown", (event) => this.beginDrag(event));
    this.menuButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 拖动之后的松手不算点击
      if (this.keepClickClosed) {
        this.keepClickClosed = false;
        return;
      }
      this.openMenuAt(this.menuButton.getBoundingClientRect());
    });

    this.overlay = document.createElement("div");
    this.overlay.className = "cm-block-overlay";
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.append(insert, this.menuButton);
    this.container.append(this.overlay);

    view.dom.appendChild(this.container);
    view.dom.classList.add("cm-has-block-handle");

    view.contentDOM.addEventListener("mousemove", this.onMove);
    view.contentDOM.addEventListener("mouseleave", this.onLeave);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    view.dom.addEventListener("mouseleave", this.onLeave);
  }

  destroy() {
    this.destroyed = true;
    this.view.contentDOM.removeEventListener("mousemove", this.onMove);
    this.view.contentDOM.removeEventListener("mouseleave", this.onLeave);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
    // 拖到一半被销毁（切标签页、关窗）时也要把 window 上的监听摘掉
    this.drag = null;
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragUp);
    this.view.dom.classList.remove("cm-has-block-handle");
    this.container.remove();
  }

  /**
   * 这一行位置变了（滚动、编辑）之后重新贴上去。
   *
   * 走 `place()`，不要在 update 里直接量——原因见那里。
   */
  refresh() {
    if (this.currentLine > 0) this.place();
  }

  /**
   * 排一次「重新贴手柄」，真正量位置的动作留到 measure 的 read 阶段。
   *
   * 不能在插件的 `update()` 里直接量：CodeMirror 在更新过程中禁止读布局，
   * `coordsAtPos` 会抛 “Reading the editor layout isn't allowed during an update”。
   * 而插件 `update()` 抛出的异常会被 CodeMirror 判成插件崩溃——它会调用
   * `destroy()` 把这个插件停用掉：手柄当场消失，并且这一份编辑器里再也长不回来
   * （打字、拖动、改字号都会触发 update，所以从前是"用手柄碰一下就没"）。
   * `requestMeasure` 的 read 阶段本来就是留给插件读布局的，改走它。
   */
  private place() {
    if (this.placing || this.destroyed) return;
    this.placing = true;
    this.view.requestMeasure({
      read: () => {
        this.placing = false;
        if (this.destroyed) return;
        this.position();
      },
    });
  }

  private button(cls: string, html: string, title: string): HTMLElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `cm-block-button ${cls}`;
    el.title = title;
    el.tabIndex = -1;
    el.innerHTML = html;
    return el;
  }

  /** 鼠标压在哪一行上。返回 0 表示不在正文范围内。 */
  private lineAtPointer(event: MouseEvent): number {
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return 0;
    try {
      return this.view.state.doc.lineAt(pos).number;
    } catch {
      return 0;
    }
  }

  private onMove = (event: MouseEvent) => {
    if (this.drag) return;
    const line = this.lineAtPointer(event);
    if (line === 0 || line === this.currentLine) return;
    this.currentLine = line;
    this.position();
  };

  /**
   * 指针离开正文。
   *
   * 挪到手柄自己身上时不能躲。手柄浮在正文上面，指针从文字移到按钮的那一瞬间
   * 就会触发 contentDOM 的 mouseleave；照躲不误的话 `cm-block-handle-visible`
   * 一掉，按钮立刻变回 `pointer-events: none`，按下去命中的是底下的文字——
   * 「+」和菜单永远点不开，拖拽也起不来（hide() 顺手把 currentLine 清成 0）。
   */
  private onLeave = (event: MouseEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.container.contains(next)) return;
    this.hide();
  };

  private onScroll = () => {
    if (this.drag) return;
    this.position();
  };

  private position() {
    const count = this.view.state.doc.lines;
    if (this.currentLine < 1 || this.currentLine > count) return this.hide();
    this.overlay.style.visibility = "hidden";
    this.container.classList.add("cm-block-handle-visible");

    const line = this.view.state.doc.line(this.currentLine);
    const coords = this.view.coordsAtPos(line.from);
    if (!coords) return this.hide();

    /*
     * 竖直方向问 DOM 要这一行的**盒子**，不要用文字坐标：块样式带着上下内边距
     * （标题上 14px、代码块 8px），按文字居中手柄会比整块偏高几个像素。
     * 水平方向仍然用 coordsAtPos（正文左边缘），那是行内边距量不出来的。
     */
    const element = this.lineElement(line.from);
    const box = element?.getBoundingClientRect();
    const host = this.view.dom.getBoundingClientRect();
    const height = this.overlay.offsetHeight || 22;
    const width = this.overlay.offsetWidth || 40;
    const centerY = box ? box.top + box.height / 2 : (coords.top + coords.bottom) / 2;
    this.overlay.style.top = `${Math.round(centerY - host.top - height / 2)}px`;
    /*
     * 水平方向：整块放到这一块的左边，右边缘离「块自己的左边缘」4px。
     *
     * 基准不能只用 coords.left（那是**文字**的左边缘）：引用块的竖条、代码块的
     * 面板都比文字更靠左，按文字算手柄就压在竖条和面板上了。差多少由行上的
     * --block-handle-shift 给出（见主题里那组变量）。
     *
     * 不减掉手柄自身的宽度，两个按钮就正好压在行首两个字上；
     * 左边缘兜到 0：窗口窄的时候宁可贴着编辑器左边，也不要被 overflow 切掉一半。
     */
    const edgeShift = this.handleShift(element);
    this.overlay.style.left = `${Math.round(
      Math.max(0, coords.left - host.left - width - 4 - edgeShift),
    )}px`;
    this.overlay.style.visibility = "";
  }

  /**
   * 这一块的手柄还要再往左让多少像素。
   *
   * 引用块的竖条、代码块的面板都比文字更靠左，手柄得退到它们外面去；
   * 让多少由主题按块写在 `--block-handle-shift` 上（默认 0）。
   * 量不出来就按 0 处理：宁可手柄贴得近一点，也不要为了一个读不到的值把它甩到别处去。
   */
  private handleShift(element: HTMLElement | null): number {
    if (!element) return 0;
    const raw = getComputedStyle(element).getPropertyValue("--block-handle-shift");
    const shift = Number.parseFloat(raw);
    return Number.isFinite(shift) ? Math.max(0, shift) : 0;
  }

  private hide() {
    if (this.drag) return;
    this.currentLine = 0;
    this.container.classList.remove("cm-block-handle-visible");
  }

  /** 加号：在这一行下面开一个新行，光标跟过去。 */
  private insertBelow() {
    insertEmptyLineBelow(this.view, this.currentLine);
    this.currentLine = 0;
    this.hide();
  }

  /**
   * 点手柄：把菜单开在手柄右边。
   *
   * 先把光标挪到这一行上再开菜单。菜单里的动作（转换成标题、删除这一块……）
   * 都是照着「光标所在行」干的，光标不在这一行的话，点了菜单动的却是别处。
   * 顺带也符合直觉：想操作哪一块，光标就在哪一块。
   */
  private openMenuAt(rect: DOMRect) {
    const host = this.view.dom.getBoundingClientRect();
    const lineNumber = this.currentLine;
    const doc = this.view.state.doc;
    const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)));
    // 不传 scrollIntoView：点手柄不该把正文滚一下
    this.view.dispatch({ selection: { anchor: line.from } });

    const items = blockMenuItems(this.view, lineNumber);
    items.push({ separator: true });
    items.push({
      label: "为这一块造卡…",
      action: () => this.options.host.addCardForLine(lineNumber),
    });
    const extra = this.options.menu?.(lineNumber) ?? [];
    if (extra.length) {
      items.push({ separator: true }, ...extra);
    }
    this.options.host.onBlockMenu({
      x: rect.right - host.left + 6,
      y: rect.top - host.top,
      lineNumber,
      items,
    });
  }

  // ---------------------------------------------------------------- 拖动

  /** 这一行的 DOM 元素。靠 data-block-from（行的文档起点）认，比按序号数可靠。 */
  private lineElement(from: number): HTMLElement | null {
    return this.view.contentDOM.querySelector<HTMLElement>(`.cm-line[data-block-from="${from}"]`);
  }

  /**
   * 按下手柄。
   *
   * 这里只登记「拖的是哪一行」，真正的判断留到 pointermove：没挪动的话
   * 就当成一次点击，松开时开菜单（Notion 也是这个手感）。
   */
  private beginDrag(event: PointerEvent) {
    if (event.button !== 0 || this.drag || this.currentLine < 1) return;
    const state = this.view.state;
    const line = state.doc.line(this.currentLine);
    const element = this.lineElement(line.from);
    if (!element) return;

    const rect = element.getBoundingClientRect();
    this.drag = {
      doc: state.doc.toString(),
      from: line.from,
      to: Math.min(line.to + 1, state.doc.length),
      text: line.text,
      top: rect.top,
      bottom: rect.bottom,
      startY: event.clientY,
      moved: false,
      target: null,
    };
    this.container.dataset.dragging = "true";
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragUp);
    // 别让浏览器顺手选中文字
    event.preventDefault();
  }

  private onDragMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    this.container.classList.add("cm-block-handle-dragging");
    this.container.dataset.dragging = "true";
    const target = this.targetAt(event.clientY, drag);
    drag.target = target;
    this.view.dispatch({ effects: dropLineEffect.of(target ? target.at : null) });
  };

  /**
   * 指针落在哪两行之间，返回值就是「插到这个文档位置之前」。
   *
   * DOM 上的 `data-block-from` 只用来认「是哪一行」，文档位置一律回去问
   * `state.doc`——行装饰可能比正文晚一拍，直接信 DOM 里的偏移会算错落点。
   */
  private targetAt(clientY: number, drag: DragState): DropTarget | null {
    const doc = this.view.state.doc;
    const rendered: { from: number; top: number; bottom: number }[] = [];
    for (const el of this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line[data-block-from]")) {
      const number = Number(el.dataset.blockFrom);
      if (Number.isNaN(number) || number < 0 || number > doc.length) continue;
      const rect = el.getBoundingClientRect();
      rendered.push({ from: doc.lineAt(number).from, top: rect.top, bottom: rect.bottom });
    }
    rendered.sort((a, b) => a.top - b.top);
    if (!rendered.length) return null;

    let pos: number;
    const hit = rendered.find((item) => clientY >= item.top && clientY < item.bottom);
    if (hit) {
      const before = clientY < hit.top + (hit.bottom - hit.top) / 2;
      const line = doc.lineAt(hit.from);
      pos = before ? line.from : Math.min(line.to + 1, doc.length);
    } else if (clientY < rendered[0].top) {
      pos = rendered[0].from;
    } else {
      // 落在最下面一行之下：插到文档末尾
      pos = doc.length;
    }
    pos = Math.max(0, Math.min(pos, doc.length));
    // 拖到自己身上（或自己的前半段）等于没动，不画指示线
    if (pos >= drag.from && pos <= drag.to) return null;
    return { pos, at: pos };
  }

  private onDragUp = () => {
    const drag = this.drag;
    const moved = Boolean(drag?.moved);
    this.endDrag();
    if (!drag) return;
    if (!moved) return; // 当成点击，交给 click 处理
    this.keepClickClosed = true;
    if (!drag.target) return;
    this.moveBlock(drag);
  };

  /**
   * 真的搬家：把这一段从原位剪下来，插到落点上。
   *
   * 做法是先把「剪下来再插进去」的结果拼成一个字符串，再用它替换
   * `[min(来源, 落点), max(来源, 落点)]` 这一整块。看着绕，但每一步都是
   * 纯字符串运算，能逐字符核对；试过的两种「更直白」的写法都栽在
   * CodeMirror 的坐标语义上：
   *   - 「删除 + 插入」两条改动写进同一次 dispatch：第二条的插入点会被
   *     第一条改动挪动，落点飘到目标行**中间**，插进了半句话里；
   *   - 直接替换 [min, max] 整块但不先剪掉来源：往下拖时，被拖的那一行
   *     本身就在这段里面，算出来和原文一模一样，等于没搬。
   */
  private moveBlock(drag: DragState) {
    const view = this.view;
    const target = drag.target;
    if (!target) return;
    // 拖动期间正文被别人改过就算了，别按旧偏移乱改
    if (view.state.doc.toString() !== drag.doc) return;

    const doc = view.state.doc.toString();
    const text = doc.slice(drag.from, drag.to);
    if (!text) return;

    // 先剪下来。被拖的那一段整个在落点之前时，落点要往前挪一个 text.length
    const without = doc.slice(0, drag.from) + doc.slice(drag.to);
    const at = Math.max(0, Math.min(target.pos - (target.pos > drag.from ? text.length : 0), without.length));
    const next = without.slice(0, at) + text + without.slice(at);
    // 拼出来和原文一模一样就是原地没动，别白压一层撤销
    if (next === doc) return;

    // 改动只能落在前后两份正文相同的那一段里
    const start = Math.min(drag.from, at);
    const end = Math.max(drag.to, at + text.length);
    view.dispatch({
      changes: { from: start, to: end, insert: next.slice(start, end) },
      selection: { anchor: at },
      scrollIntoView: true,
      userEvent: "move.block",
    });
    view.focus();
  }

  private endDrag() {
    this.drag = null;
    this.container.classList.remove("cm-block-handle-dragging");
    delete this.container.dataset.dragging;
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragUp);
    this.view.dispatch({ effects: dropLineEffect.of(null) });
  }
}

/**
 * 装块手柄。
 *
 * 手柄的位置是按「行的像素坐标」算出来的，行一改（插字、换行、折叠）
 * 坐标就过期了，所以在 update 里重新贴一次。
 */
function blockHandle(options: BlockHandleOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      readonly handle: BlockHandle;

      constructor(view: EditorView) {
        this.handle = new BlockHandle(view, options);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.geometryChanged) {
          this.handle.refresh();
        }
      }

      destroy() {
        this.handle.destroy();
      }
    },
  );
}

function baseTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        color: "var(--text)",
        backgroundColor: "var(--bg-editor)",
        height: "100%",
        /*
         * 每一行都当成一个块来排：正文用无衬线体（和 Notion 一样），
         * 一行就是一个排版单位。
         *
         * 字号与行高都取全局变量：字号跟着设置里的「字号」走，
         * 行高和预览区是同一个值（切「编辑 / 分栏 / 预览」时节奏不变）。
         */
        fontFamily: "var(--font-text)",
        fontSize: "var(--editor-font-size)",
        lineHeight: "var(--editor-line-height)",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        paddingBottom: "40vh",
      },
      ".cm-content": {
        padding: "24px 0 0",
        caretColor: "var(--accent)",
        maxWidth: "var(--editor-max-width)",
        margin: "0 auto",
      },

      // ---- 块的基本形：左右内边距 + 每行自带的上下间距 ----
      /*
       * 行高必须写在行元素上，不能只写在 &（.cm-editor）上：
       * CodeMirror 的基底样式给 .cm-content 定死了 line-height: 1.4，
       * 它是后代规则、会盖掉从 & 继承下来的值——写在 & 上的行高一直没生效。
       * 写在这里，未挂块类的行（比如 frontmatter 那几行）也跟正文同一个行高。
       *
       * position: relative 是给落点指示线和灰底衬底当定位父级用的；
       * z-index: 0 让行自己成为层叠上下文，衬底的 z-index: -1 才不会沉到
       * .cm-editor 的不透明底色后面去。
       *
       * --block-text-start / --block-text-end 是「文字在行里的左右边界」（相对 padding box），
       * --block-handle-shift 是「手柄还要再往左让多少像素」（引用竖条、代码面板比文字宽出来的部分），
       * --block-band-top / --block-band-bottom 是「高亮衬底相对整块要收掉多少」：
       * 默认 0（衬底就是整块），只有标题那种「上方留了一大段块间距」的行才收，
       * 好让衬底围着文字上下等距。列表缩进、引用竖条、代码面板各自覆写这些值，
       * 衬底与手柄就自动跟着对齐。
       */
      ".cm-line": {
        padding: "0 var(--block-padding-x)",
        position: "relative",
        zIndex: "0",
        lineHeight: "var(--editor-line-height)",
        "--block-text-start": "var(--block-padding-x)",
        "--block-text-end": "var(--block-padding-x)",
        // 默认：块的左边缘就是文字的左边缘（手柄不用额外让位）
        "--block-handle-shift": "0px",
        "--block-band-top": "0px",
        "--block-band-bottom": "0px",
      },

      /*
       * 块手柄：鼠标停在哪一行，那一行左边就浮出「+」和「⋮⋮」。
       *
       * 它是编辑器上面的一层浮层，不占正文位置，所以行号、行宽都不会因为它变化；
       * 默认整层透明、不接收事件——不然鼠标只要扫过左侧就会一直在跟它较劲。
       */
      "&.cm-has-block-handle": { position: "relative" },
      ".cm-block-handle": {
        position: "absolute",
        inset: "0",
        // 盖在行号槽上（行号槽自己带 z-index: 200）
        zIndex: "300",
        pointerEvents: "none",
        overflow: "hidden",
      },
      ".cm-block-overlay": {
        position: "absolute",
        display: "flex",
        alignItems: "center",
        gap: "0",
        height: "22px",
        opacity: "0",
        transition: "opacity 0.12s ease",
      },
      ".cm-block-handle-visible .cm-block-overlay": { opacity: "1", pointerEvents: "auto" },
      // 拖动的时候手柄自己藏起来，免得跟落点指示线抢注意力
      ".cm-block-handle-dragging .cm-block-overlay": { opacity: "0", pointerEvents: "none" },
      ".cm-block-button": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "20px",
        height: "20px",
        padding: "0",
        border: "none",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--text-faint)",
        cursor: "pointer",
        transition: "background 0.12s ease, color 0.12s ease",
      },
      ".cm-block-button:hover": { background: "var(--bg-active)", color: "var(--text)" },
      ".cm-block-add": { cursor: "pointer" },
      ".cm-block-menu": { cursor: "grab" },
      ".cm-block-menu:active": { cursor: "grabbing" },

      /*
       * 落点指示线：拖动时显示「会插到这里」。
       *
       * 用绝对定位，不占任何布局空间——它插在正文中间，一旦参与排版就会把
       * 周围的行推来推去，指示线自己都跟着跳。
       */
      ".cm-drop-line": {
        position: "absolute",
        left: "var(--block-padding-x)",
        right: "var(--block-padding-x)",
        top: "-2px",
        height: "3px",
        borderRadius: "2px",
        background: "var(--accent)",
        pointerEvents: "none",
      },

      /*
       * 光标所在行 = 画在行底下的一层衬底（::before），不是直接给行上底色。
       *
       * 直接给行上底色、再用 background-clip: content-box 收边的话，灰底的四边
       * 就等于文字盒的四边：文字紧贴灰边，圆角也被字压住看不出弧度。
       * 画成衬底就能比文字四周各让出 --block-inset-x，圆角也才显出来。
       *
       * 定位原点是行的 **padding box**（绝对定位子元素的包含块 = 最近的定位祖先的
       * padding 边）：正文、列表没有边框，padding box 就是行框；引用块有 3px 竖条
       * （border），padding box 从竖条右侧起——引用那几个变量就是按这个原点写的。
       *
       * 左右按 --block-text-start / --block-text-end 定位，上下按
       * --block-band-top / --block-band-bottom 定位。
       * 「悬停」那一版（:hover::before）已按需求取消：鼠标扫过不再有底色。
       * 现在只有光标所在行会亮起，圆角与过渡仍取全局变量。
       */
      ".cm-line::before": {
        content: '""',
        position: "absolute",
        left: "calc(var(--block-text-start) - var(--block-inset-x))",
        right: "calc(var(--block-text-end) - var(--block-inset-x))",
        top: "var(--block-band-top)",
        bottom: "var(--block-band-bottom)",
        zIndex: "-1",
        borderRadius: "var(--block-radius)",
        backgroundColor: "transparent",
        transition: "var(--block-transition)",
        pointerEvents: "none",
      },
      ".cm-activeLine::before": { backgroundColor: "var(--bg-active-line)" },

      /*
       * 块间距：每一行都自带同一份很小的上下内边距。
       * 段与段之间的空档交给空行自己去撑——空行是完整的一块（见 .cm-blank-line），
       * 不再是压扁的一条缝。
       */
      ".cm-para": { padding: "var(--block-padding-y) var(--block-padding-x)" },

      // ---- 标题：照 Notion 的字号阶梯，不要下边框 ----
      // 标题的行高单独收紧一档（原因见 global.css 里那组变量的说明）
      ".cm-heading": { color: "var(--text-strong)", lineHeight: "var(--editor-heading-line-height)" },
      /*
       * 标题上方那 14px 是「和上一段的间距」，不是标题自己的留白：
       * 衬底要把这段收掉，光标落在标题上时底色才是围着文字上下等距的，
       * 否则文字会被顶到色块的下半部分（看着不居中）。
       */
      ".cm-heading-line": {
        paddingTop: "14px",
        paddingBottom: "var(--block-padding-y)",
        "--block-band-top": "calc(14px - var(--block-padding-y))",
      },
      ".cm-heading-1": { fontSize: "1.875em", fontWeight: "700" },
      ".cm-heading-2": { fontSize: "1.5em", fontWeight: "600" },
      ".cm-heading-3": { fontSize: "1.25em", fontWeight: "600" },
      ".cm-heading-4": { fontSize: "1.125em", fontWeight: "600" },
      ".cm-heading-5": { fontSize: "1em", fontWeight: "600" },
      ".cm-heading-6": { fontSize: "0.95em", fontWeight: "600", color: "var(--text-muted)" },

      // ---- 列表：整行是一个块，文字按层级缩进 ----
      // 每一层同时给出「文字起点」和左内边距：内边距读这个变量，灰底衬底也读它
      ".cm-list-line": {
        paddingTop: "var(--block-padding-y)",
        paddingBottom: "var(--block-padding-y)",
        paddingLeft: "var(--block-text-start)",
      },
      ".cm-list-line-2": {
        "--block-text-start": "calc(var(--block-padding-x) + 24px)",
        paddingLeft: "var(--block-text-start)",
      },
      ".cm-list-line-3": {
        "--block-text-start": "calc(var(--block-padding-x) + 48px)",
        paddingLeft: "var(--block-text-start)",
      },
      ".cm-list-line-4": {
        "--block-text-start": "calc(var(--block-padding-x) + 72px)",
        paddingLeft: "var(--block-text-start)",
      },
      ".cm-list-line-5": {
        "--block-text-start": "calc(var(--block-padding-x) + 96px)",
        paddingLeft: "var(--block-text-start)",
      },
      ".cm-list-line-6": {
        "--block-text-start": "calc(var(--block-padding-x) + 120px)",
        paddingLeft: "var(--block-text-start)",
      },
      // 列表符号占一个固定宽度，文字自然对齐
      ".cm-list-number": { color: "var(--text-muted)" },

      // ---- 待办 ----
      ".cm-task-line": { padding: "var(--block-padding-y) var(--block-padding-x)" },
      ".cm-task-done": { color: "var(--text-faint)" },

      // ---- 引用：左侧竖条，整块连成一条 ----
      /*
       * 定位原点是 padding box（竖条是 border，在它左边 3px），所以这里都按
       * 「竖条右侧」来算：文字从 12px（= 自己的左内边距）开始，竖条在 -3px 处。
       * 衬底于是落在文字左边 6px（正好贴着竖条外面）；
       * 手柄还要多让 15px（12px 内边距 + 3px 竖条），退到竖条外面 4px。
       */
      ".cm-quote-line": {
        borderLeft: "3px solid var(--border-strong)",
        padding: "var(--block-padding-y) 14px var(--block-padding-y) 12px",
        marginLeft: "var(--block-padding-x)",
        color: "var(--text-muted)",
        "--block-text-start": "12px",
        "--block-text-end": "14px",
        "--block-handle-shift": "15px",
      },
      // 首尾两行的额外内边距同样收进衬底，引用块的高亮也上下等距
      ".cm-quote-line-first": {
        paddingTop: "5px",
        borderTopRightRadius: "var(--block-radius)",
        "--block-band-top": "calc(5px - var(--block-padding-y))",
      },
      ".cm-quote-line-last": {
        paddingBottom: "5px",
        borderBottomRightRadius: "var(--block-radius)",
        "--block-band-bottom": "calc(5px - var(--block-padding-y))",
      },

      /*
       * 空行 = 还没写字的块：和正文行同一个行高、同一份内边距。
       *
       * 从前这里压成 line-height 0.4 的一条缝，一页里只要有几个空行，整篇的
       * 节奏就断成几截，空行本身也窄得点不进去（想在那里补字得先对准那条缝）。
       * 现在它是完整的一块：行高由 .cm-line 上的 --editor-line-height 决定，
       * 段间距由空行自己撑开，光标行与悬停高亮也才有正常的高度。
       */
      ".cm-blank-line": { padding: "var(--block-padding-y) var(--block-padding-x)" },

      // ---- 行号槽 ----
      ".cm-gutters": {
        backgroundColor: "var(--bg-editor)",
        color: "var(--text-faint)",
        border: "none",
        // 留一点点就够：块手柄要挤在正文左侧这点空间里，行号槽太宽会把它顶到行号上
        paddingLeft: "2px",
        fontSize: "0.75em",
      },
      /*
       * 行号一律贴着自己的行顶端对齐。
       *
       * 行高现在基本是统一的（空行也是完整一行），但代码块的字号是 0.9em、
       * 标题更大，行号槽里的元素还是会被拉成各自的高度；不写这一条的话
       * 数字会在格子里居中，一页行号就会忽高忽低。
       */
      ".cm-gutterElement": { display: "flex", alignItems: "flex-start" },
      ".cm-lineNumbers .cm-gutterElement": { paddingTop: "3px" },
      /*
       * 光标所在行：只在正文那一条上淡淡地上一层底色（Notion 没有这个提示，
       * 但编辑器里丢了光标位置更难受），行号槽不跟着变，免得左边多一块。
       * 底色画在行的衬底上（见 .cm-line::before），几何和悬停高亮完全一致。
       *
       * 行元素自己的底色必须显式置空：highlightActiveLine 的基底样式给
       * .cm-activeLine 留了一层浅蓝（#99eeff33），不写这一条它就会垫在衬底下面，
       * 光标行看起来偏青。
       */
      ".cm-activeLine": { backgroundColor: "transparent" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--accent)",
        borderLeftWidth: "2px",
      },
      /*
       * 选区底色。
       *
       * 选择器必须写到和 CodeMirror 基底样式一样具体：基底样式给
       * `.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
       * 定了一份深色默认值（不透明的墨绿），具体度比只写一个类名高得多，
       * 从前的写法压不过它——主题里的 --selection 一直没生效。
       */
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: "var(--selection)",
        },
      ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--bg-hover)",
        border: "none",
        borderRadius: "var(--block-radius)",
        color: "var(--text-muted)",
      },
      ".cm-panels": { backgroundColor: "var(--bg-panel)", color: "var(--text)" },
      ".cm-searchMatch": { backgroundColor: "var(--selection-match)", outline: "none" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--selection)" },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-panel)",
        border: "1px solid var(--border)",
        color: "var(--text)",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--bg-hover)",
        color: "var(--text-strong)",
      },
      // ---- 所见即所得：块级样式与行内小部件 ----
      /*
       * 代码块：整段底色 + 圆角（围栏行被藏掉后正好当留白用）。
       *
       * 正文换成正文字体后，代码块里的等宽字体得在这里显式写回来——
       * 不写的话 `const box = ...` 会跟着正文一起变成无衬线，代码就散了。
       *
       * 面板底色和别的灰底一样画在衬底上（::before），不再铺满整行：
       * 铺满整行的话它比正文块宽出左右各 32px，在一页里看着就是「这块特别宽」。
       * 现在它和别的灰底用同一套左右内缩（文字 ∓ --block-inset-x），宽度就一致了。
       */
      ".cm-code-line": {
        fontFamily: "var(--font-mono)",
        fontSize: "0.9em",
        transition: "var(--block-transition)",
        /*
         * 面板比别的灰底再往外让一点：代码块左右得有点留白，只让 6px 的话
         * 代码会紧贴面板边缘。手柄的让位量跟着这个变量走，不用另写。
         */
        "--block-inset-x": "14px",
        "--block-handle-shift": "var(--block-inset-x)",
      },
      ".cm-code-line::before": {
        backgroundColor: "var(--code-bg)",
        // 内部各行不收圆角，整段才是一块连续的面板；圆角只给首尾两行
        borderRadius: "0",
      },
      /*
       * 光标落在代码行上：面板底色不能换（换了就断成一条），
       * 用一层内阴影叠上去，看起来就是同一块面板稍微亮了一点。
       */
      ".cm-code-line.cm-activeLine::before": {
        backgroundColor: "var(--code-bg)",
        boxShadow: "inset 0 0 0 999px var(--bg-active-line)",
      },
      /*
       * 首尾两行的 8px 是代码面板自己的上下留白，属于面板、不是行高：
       * 衬底照样铺满（--block-band-* 不设偏移），圆角只收首尾。
       */
      ".cm-code-line-first": { paddingTop: "8px" },
      ".cm-code-line-last": { paddingBottom: "8px" },
      /*
       * 收尾围栏行是空的（```），让它别占一整行：代码块下面就不会多出一块空白。
       * 光标停上去时要恢复正常——那一行是你改围栏的地方，得看得见、点得到。
       * 字号和行高都要压成 0：CodeMirror 给被替换掉的片段套了个行内占位元素，
       * 只压行高的话，它的字身框照样撑出十几像素。
       */
      ".cm-code-line-end:not(.cm-activeLine)": { lineHeight: "0", fontSize: "0px" },
      ".cm-code-line-first::before": {
        borderTopLeftRadius: "var(--block-radius)",
        borderTopRightRadius: "var(--block-radius)",
      },
      ".cm-code-line-last::before": {
        borderBottomLeftRadius: "var(--block-radius)",
        borderBottomRightRadius: "var(--block-radius)",
      },
      /*
       * 折叠槽：平时完全空着。
       *
       * 从前"光标所在行"也会把箭头亮出来，结果一打开笔记、光标落在第一行，
       * 左边就常挂着一块灰方块，像是界面没对齐。现在只有真的把鼠标移到这一槽
       * 才显形；键盘用户用 Ctrl+Shift+[ / ] 折叠，不需要靠这个箭头。
       */
      ".cm-foldGutter": { width: "14px" },
      ".cm-foldGutter .cm-gutterElement": { opacity: "0", transition: "opacity 0.12s" },
      ".cm-foldGutter:hover .cm-gutterElement": { opacity: "1" },
      ".cm-foldGutter .cm-gutterElement:hover": { opacity: "1" },
      ".cm-fold-marker": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "12px",
        height: "12px",
        borderRadius: "3px",
        color: "var(--text-faint)",
        cursor: "pointer",
        transition: "color 0.12s, background 0.12s",
      },
      ".cm-fold-marker:hover": { background: "var(--bg-hover)", color: "var(--text-strong)" },
      ".cm-bullet": { color: "var(--accent)", paddingRight: "1px" },
      ".cm-inline-code": {
        backgroundColor: "var(--code-bg)",
        borderRadius: "var(--block-radius)",
        padding: "1px 5px",
        color: "var(--text-strong)",
        transition: "var(--block-transition)",
      },
      ".cm-link": { cursor: "pointer", textDecoration: "underline", textDecorationColor: "var(--border-strong)" },
      ".cm-wikilink": { color: "var(--accent)", cursor: "pointer" },
      ".cm-hashtag": { color: "var(--accent)" },
      ".cm-image": { display: "inline-flex", flexDirection: "column", gap: "2px", verticalAlign: "top" },
      ".cm-image img": {
        maxWidth: "100%",
        maxHeight: "420px",
        borderRadius: "var(--block-radius)",
        display: "block",
        cursor: "pointer",
      },
      // 待办复选框：Notion 是 16px 的圆角方框
      ".cm-task-box": {
        accentColor: "var(--accent)",
        width: "15px",
        height: "15px",
        borderRadius: "3px",
        verticalAlign: "-2px",
        cursor: "pointer",
      },
      ".cm-rule": {
        display: "inline-block",
        width: "100%",
        borderTop: "1px solid var(--border)",
        verticalAlign: "middle",
      },
      // 表格部件：正文换无衬线后，表格也要显式写回来（它 inherits 自 .cm-scroller）
      // 表格是整块替换，不吃 .cm-line 的左右内边距，所以自己补上同样的 --block-padding-x；
      // 字号与单元格内边距和预览区的表格保持同一套值
      ".cm-table": { padding: "6px var(--block-padding-x)", overflow: "auto" },
      ".cm-table table": {
        borderCollapse: "collapse",
        width: "100%",
        fontSize: "0.94em",
        fontFamily: "var(--font-text)",
      },
      ".cm-table th, .cm-table td": {
        border: "1px solid var(--border)",
        padding: "8px 12px",
        textAlign: "left",
        verticalAlign: "top",
      },
      ".cm-table th": {
        backgroundColor: "var(--bg-panel)",
        color: "var(--text-strong)",
        fontWeight: "600",
      },
      ".cm-table p": { margin: "0" },
    },
    { dark },
  );
}

export interface CursorInfo {
  line: number;
  col: number;
  selected: number;
}

export interface EditorOptions {
  content: string;
  dark: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  onChange: (text: string) => void;
  onCursor: (info: CursorInfo) => void;
  onWikilink?: (target: string) => void;
  /** Ctrl+Shift+B：把光标/选区所在的段落标记成块 */
  onExtractBlock?: () => void;
  /** Ctrl+Shift+C：为选中的块造卡 */
  onAddCard?: () => void;
  /** 把笔记里的图片地址换成 webview 能加载的地址 */
  imageSource?: (url: string) => string | null;
  /** 把表格源码渲染成 HTML（复用预览那套 Markdown 渲染） */
  renderTable?: (source: string) => string;
  /** 点块手柄上的「⋮⋮」时调这里。菜单已经拼好，外面只需要按坐标弹出来 */
  onBlockMenu?: (request: BlockMenuRequest) => void;
  /** 往块菜单里再补几项（业务动作放在这个位置） */
  blockMenu?: (lineNumber: number) => MenuEntry[];
  /** 把某一行的块建成卡片（块菜单里的那一项） */
  onAddCardForLine?: (lineNumber: number) => void;
}

/** 块菜单的一项：编辑器只管画和触发，动作由外面定义。 */
export interface MenuEntry {
  label?: string;
  /** 右侧的快捷键提示 */
  shortcut?: string;
  /** 分隔线：只填这一个字段即可 */
  separator?: boolean;
  action?: () => void;
}

/** 打开块菜单要用的坐标与内容。坐标相对编辑器左上角。 */
export interface BlockMenuRequest {
  x: number;
  y: number;
  lineNumber: number;
  items: MenuEntry[];
}

export interface EditorHandle {
  view: EditorView;
  setState(state: EditorState): void;
  getState(): EditorState;
  createState(content: string): EditorState;
  setDark(dark: boolean): void;
  setFontSize(size: number): void;
  setLineNumbers(show: boolean): void;
  focus(): void;
  destroy(): void;
}

/** 主题／字号／行号这几个可动态切换的部分，用 Compartment 包裹。 */
export interface EditorCompartments {
  theme: Compartment;
  font: Compartment;
  gutter: Compartment;
}

export function createCompartments(): EditorCompartments {
  return { theme: new Compartment(), font: new Compartment(), gutter: new Compartment() };
}

function buildExtensions(options: EditorOptions, compartments: EditorCompartments): Extension[] {
  const { theme: themeCompartment, font: fontCompartment, gutter: gutterCompartment } = compartments;

  // 表格是整块替换，只能由 StateField 提供；行内装饰要避开它
  const tableField = StateField.define<TableValue>({
    create: (state) => buildTables(state, options.renderTable),
    update: (value, tr) =>
      tr.docChanged || tr.selection ? buildTables(tr.state, options.renderTable) : value,
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  return [
    gutterCompartment.of(options.showLineNumbers ? lineNumbers() : []),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: foldMarker }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(markdownHighlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    dropLineField,
    tableField,
    livePreview({ imageSource: options.imageSource, renderTable: options.renderTable }, tableField),
    /*
     * 块手柄：菜单内容要外面的业务动作（造卡），所以没给 onBlockMenu 就干脆
     * 不装——比如样式验收页就没有菜单可开。
     */
    options.onBlockMenu
      ? blockHandle({
          host: {
            onBlockMenu: (request) => options.onBlockMenu?.(request),
            addCardForLine: (lineNumber) => options.onAddCardForLine?.(lineNumber),
          },
          menu: options.blockMenu,
        })
      : [],
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    placeholder("开始输入… 支持 Markdown、[[双链]] 与 #标签"),
    /*
     * 回车：markdown() 自己会装一张键位表（Prec.high），把 Enter 绑到
     * insertNewlineContinueMarkup。那条命令在「光标停在空的列表项上」时有个
     * 默认行为：只要这一项不是列表的第一项、上一行又不是空行，它就先往这一项
     * **上面**插一个空行，把紧凑列表变松——在笔记里看着就是「按一下回车多出一行
     * 空的」，而且那个空条目还留在原地。同一个命令把 nonTightLists 关掉就老实了：
     * 空条目上回车一律删掉标记、就此收尾这个列表。
     * 用 Prec.highest 是为了盖过 markdown() 那张表。
     */
    Prec.highest(
      keymap.of([
        { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
      ]),
    ),
    keymap.of([
      // RNote 的两个动作：块与卡片。放在默认键位表最前面，先被它们接住
      {
        key: "Mod-Shift-b",
        preventDefault: true,
        run: () => {
          options.onExtractBlock?.();
          return true;
        },
      },
      {
        key: "Mod-Shift-c",
        preventDefault: true,
        run: () => {
          options.onAddCard?.();
          return true;
        },
      },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
      if (update.docChanged || update.selectionSet) {
        const range = update.state.selection.main;
        const line = update.state.doc.lineAt(range.head);
        options.onCursor({
          line: line.number,
          col: range.head - line.from + 1,
          selected: update.state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0),
        });
      }
    }),
    // Ctrl/Cmd + 点击 [[双链]] 直接跳转
    // （右键菜单不在这里处理：CodeMirror 不会把 contextmenu 转发给 domEventHandlers，
    //   改由 EditorPane 的外层容器监听）
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const line = view.state.doc.lineAt(pos);
        const offset = pos - line.from;
        const re = /\[\[([^\]\n]+)\]\]/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(line.text))) {
          if (offset >= match.index && offset <= match.index + match[0].length) {
            event.preventDefault();
            const target = match[1].split("|")[0].split("#")[0].trim();
            if (target) options.onWikilink?.(target);
            return true;
          }
        }
        return false;
      },
    }),
    themeCompartment.of(baseTheme(options.dark)),
    fontCompartment.of(EditorView.theme({ "&": { fontSize: `${options.fontSize}px` } })),
  ];
}

/** 建立 CodeMirror 编辑器实例。 */
export function createEditor(
  parent: HTMLElement,
  options: EditorOptions,
  compartments: EditorCompartments = createCompartments(),
): EditorHandle {
  const extensions = buildExtensions(options, compartments);
  const {
    theme: themeCompartment,
    font: fontCompartment,
    gutter: gutterCompartment,
  } = compartments;

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.content, extensions }),
  });

  return {
    view,
    setState(state) {
      view.setState(state);
    },
    getState() {
      return view.state;
    },
    createState(content: string) {
      return EditorState.create({ doc: content, extensions });
    },
    setDark(dark) {
      view.dispatch({ effects: themeCompartment.reconfigure(baseTheme(dark)) });
    },
    setFontSize(size) {
      view.dispatch({
        effects: fontCompartment.reconfigure(EditorView.theme({ "&": { fontSize: `${size}px` } })),
      });
    },
    setLineNumbers(show) {
      view.dispatch({
        effects: gutterCompartment.reconfigure(show ? lineNumbers() : []),
      });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
