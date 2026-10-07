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
import { EditorState, Compartment, StateField, type Extension, type Range } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
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
  { tag: t.heading1, fontSize: "1.7em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.45em", fontWeight: "700", lineHeight: "1.3" },
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
  const lines: Range<Decoration>[] = [];
  const replaces: { from: number; to: number; decoration: Decoration }[] = [];
  const { state } = view;

  // 已经被表格部件整块替换的范围，行内装饰要让开，否则会重叠报错
  const inSkipped = (from: number, to: number) => skip.some((r) => from < r.to && to > r.from);

  const replace = (from: number, to: number, decoration: Decoration) => {
    if (from >= to) return;
    replaces.push({ from, to, decoration });
  };

  const decorateLines = (nodeFrom: number, nodeTo: number, base: string) => {
    const first = state.doc.lineAt(nodeFrom).number;
    const last = state.doc.lineAt(Math.min(nodeTo, state.doc.length)).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      let cls = base;
      if (number === first) cls += ` ${base}-first`;
      if (number === last) cls += ` ${base}-last`;
      lines.push(Decoration.line({ class: cls }).range(line.from));
    }
  };

  // 代码块里的内容不参与行内规则（`[[x]]`、`#标签` 在代码里就是普通文本）
  const codeLines = new Set<number>();

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
          decorateLines(node.from, node.to, "cm-code-line");
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;
          for (let number = first; number <= last; number += 1) codeLines.add(number);
          return;
        }
        if (name === "Blockquote") {
          decorateLines(node.from, node.to, "cm-quote-line");
          return;
        }

        // 标题：字号写在自己的行装饰类里。
        // 高亮样式给的 fontSize 在这类整行节点上不可靠（实测只剩粗体和颜色），
        // 所以这里连字号一起接管；光标行也保留字号，只把 `#` 露出来。
        if (name.startsWith("ATXHeading")) {
          const first = state.doc.lineAt(node.from);
          lines.push(Decoration.line({ class: `cm-heading cm-heading-${name.slice(-1)}` }).range(first.from));
          return;
        }

        if (node.from === node.to) return;
        const line = state.doc.lineAt(node.from);
        // 光标所在行保留原始语法，方便直接改
        if (selectionTouchesLine(state, line.from, line.to)) return;

        // 列表符号：无序的换成圆点，有序的淡淡地显示序号
        if (name === "ListMark") {
          if (/^[-*+]$/.test(state.sliceDoc(node.from, node.to))) {
            replace(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }));
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

      // 空行压扁：渲染出来是段间距，而不是空一整行。
      // 这里刻意不看光标：空行没有「源码」可露，压缩与否跟着选区变会让行高忽高忽低。
      if (!line.text.trim()) {
        lines.push(Decoration.line({ class: "cm-blank-line" }).range(line.from));
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
        if (task[2].toLowerCase() === "x") {
          lines.push(Decoration.line({ class: "cm-task-done" }).range(line.from));
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

  return Decoration.set([...lines, ...kept, ...marks], true);
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

function baseTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        color: "var(--text)",
        backgroundColor: "var(--bg-editor)",
        height: "100%",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.7",
        overflow: "auto",
        paddingBottom: "40vh",
      },
      ".cm-content": {
        padding: "20px 0",
        caretColor: "var(--accent)",
        maxWidth: "var(--editor-max-width)",
        margin: "0 auto",
      },
      ".cm-line": { padding: "0 32px" },
      ".cm-gutters": {
        backgroundColor: "var(--bg-editor)",
        color: "var(--text-faint)",
        border: "none",
        paddingLeft: "6px",
      },
      ".cm-activeLine": { backgroundColor: "var(--bg-active-line)" },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--bg-active-line)",
        color: "var(--text-muted)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--accent)",
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--selection)",
      },
      ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--bg-hover)",
        border: "none",
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
      // 代码块：整段底色，首尾补内边距与圆角（围栏行被藏掉后正好当留白用）
      ".cm-code-line": { backgroundColor: "var(--code-bg)" },
      ".cm-code-line-first": { borderRadius: "8px 8px 0 0", paddingTop: "5px" },
      ".cm-code-line-last": { borderRadius: "0 0 8px 8px", paddingBottom: "5px" },
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
      ".cm-quote-line": {
        borderLeft: "3px solid var(--border-strong)",
        paddingLeft: "14px",
        color: "var(--text-muted)",
      },
      // 空行压成段间距，读起来才像排版后的文章
      ".cm-blank-line": { lineHeight: "1.05" },
      ".cm-heading": { color: "var(--text-strong)", fontWeight: "700", lineHeight: "1.32" },
      ".cm-heading-1": { fontSize: "1.7em", borderBottom: "1px solid var(--border)", paddingBottom: "6px" },
      ".cm-heading-2": { fontSize: "1.45em", borderBottom: "1px solid var(--border)", paddingBottom: "4px" },
      ".cm-heading-3": { fontSize: "1.25em", fontWeight: "600" },
      ".cm-heading-4": { fontSize: "1.12em", fontWeight: "600" },
      ".cm-heading-5": { fontSize: "1em", fontWeight: "600" },
      ".cm-heading-6": { fontSize: "0.95em", fontWeight: "600", color: "var(--text-muted)" },
      ".cm-bullet": { color: "var(--accent)", paddingRight: "1px" },
      ".cm-list-number": { color: "var(--text-faint)" },
      ".cm-inline-code": {
        backgroundColor: "var(--code-bg)",
        borderRadius: "4px",
        padding: "1px 5px",
        color: "var(--text-strong)",
      },
      ".cm-link": { cursor: "pointer", textDecoration: "underline", textDecorationColor: "var(--border-strong)" },
      ".cm-wikilink": { color: "var(--accent)", cursor: "pointer" },
      ".cm-hashtag": { color: "var(--accent)" },
      ".cm-task-done": { color: "var(--text-faint)" },
      ".cm-image": { display: "inline-flex", flexDirection: "column", gap: "2px", verticalAlign: "top" },
      ".cm-image img": {
        maxWidth: "100%",
        maxHeight: "420px",
        borderRadius: "8px",
        display: "block",
        cursor: "pointer",
      },
      ".cm-task-box": {
        accentColor: "var(--accent)",
        width: "14px",
        height: "14px",
        verticalAlign: "-2px",
        cursor: "pointer",
      },
      ".cm-rule": {
        display: "inline-block",
        width: "100%",
        borderTop: "1px solid var(--border-strong)",
        verticalAlign: "middle",
      },
      // 表格部件
      ".cm-table": { margin: "6px 0", overflow: "auto" },
      ".cm-table table": { borderCollapse: "collapse", width: "100%", fontSize: "0.94em" },
      ".cm-table th, .cm-table td": {
        border: "1px solid var(--border)",
        padding: "6px 12px",
        textAlign: "left",
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
    tableField,
    livePreview({ imageSource: options.imageSource, renderTable: options.renderTable }, tableField),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    placeholder("开始输入… 支持 Markdown、[[双链]] 与 #标签"),
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
