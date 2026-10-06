import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** 用成对标记包裹选中内容；没有选中时插入标记并把光标放到中间。 */
export function wrapSelection(view: EditorView, before: string, after = before) {
  const { state } = view;
  const changes = state.selection.ranges.map((range) => ({
    from: range.from,
    to: range.to,
    insert: `${before}${state.sliceDoc(range.from, range.to)}${after}`,
  }));
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) =>
      EditorSelection.range(range.from + before.length, range.to + before.length),
    ),
    state.selection.mainIndex,
  );
  view.dispatch({ changes, selection, scrollIntoView: true });
  view.focus();
}

/** 在光标处插入文本。 */
export function insertAtCursor(view: EditorView, text: string) {
  const { state } = view;
  const range = state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
    scrollIntoView: true,
  });
  view.focus();
}

/** 在当前行行首插入待办标记。 */
export function insertTodo(view: EditorView) {
  const { state } = view;
  const starts = new Set(state.selection.ranges.map((range) => state.doc.lineAt(range.from).from));
  view.dispatch({
    changes: [...starts].map((from) => ({ from, insert: "- [ ] " })),
    scrollIntoView: true,
  });
  view.focus();
}

/** 插入 `[文字](链接)`，光标落在需要继续填写的位置。 */
export function insertLink(view: EditorView) {
  const { state } = view;
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  const insert = `[${text}](https://)`;
  const cursor = text ? range.from + insert.length - 1 : range.from + 1;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
  });
  view.focus();
}

/** 插入 `[[双链]]`，光标落在中间。 */
export function insertWikilink(view: EditorView) {
  const { state } = view;
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  const insert = `[[${text}]]`;
  const cursor = range.from + 2 + text.length;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
  });
  view.focus();
}

/** 删除当前选中的内容（剪切用）。 */
export function deleteSelection(view: EditorView) {
  const { state } = view;
  const changes = state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => ({ from: range.from, to: range.to, insert: "" }));
  if (!changes.length) return;
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
}
