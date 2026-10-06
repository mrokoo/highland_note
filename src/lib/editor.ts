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
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { EditorState, Compartment, type Extension, type Range } from "@codemirror/state";
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
]);

/** 光标不在本行时折叠掉的 Markdown 标记（实时预览）。 */
const HIDE_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "StrikethroughMark",
]);

function selectionTouchesLine(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function buildLivePreview(view: EditorView): DecorationSet {
  const widgets: Range<Decoration>[] = [];
  const { state } = view;
  let lastTo = -1;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (!HIDE_MARKS.has(node.name)) return;
        if (node.from === node.to) return;
        // 游标所在行保留原始标记，方便直接编辑语法。
        const line = state.doc.lineAt(node.from);
        if (selectionTouchesLine(state, line.from, line.to)) return;
        if (node.from < lastTo) return;
        let end = node.to;
        if (
          (node.name === "HeaderMark" || node.name === "QuoteMark") &&
          state.doc.sliceString(end, end + 1) === " "
        ) {
          end += 1;
        }
        widgets.push(Decoration.replace({}).range(node.from, end));
        lastTo = end;
      },
    });
  }
  return Decoration.set(widgets, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLivePreview(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildLivePreview(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

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
  return [
    gutterCompartment.of(options.showLineNumbers ? lineNumbers() : []),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
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
    livePreview,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    placeholder("开始输入… 支持 Markdown、[[双链]] 与 #标签"),
    keymap.of([
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
