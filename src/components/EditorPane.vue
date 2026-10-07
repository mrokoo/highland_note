<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { redo, redoDepth, selectAll, undo, undoDepth } from "@codemirror/commands";
import { createEditor, type EditorHandle } from "../lib/editor";
import {
  activeTab,
  openCardDialog,
  openMenu,
  openMenuAt,
  openWikilink,
  quickCreateCards,
  saveActive,
  store,
  updateActiveContent,
} from "../lib/store";import { resolveAssetUrl } from "../lib/assets";
import { renderMarkdown } from "../lib/markdown";
import { copyText, readClipboardText } from "../lib/clipboard";
import { blocksFromSelection, type SelectedBlock } from "../lib/blocks";
import {
  deleteSelection,
  insertAtCursor,
  insertLink,
  insertTodo,
  insertWikilink,
  wrapSelection,
} from "../lib/format";

const host = ref<HTMLElement | null>(null);
let handle: EditorHandle | null = null;
let view: EditorView | null = null;

/** 每个标签页一份编辑器状态，切回来时保留撤销历史与光标。 */
const states = new Map<string, EditorState>();
const scrolls = new Map<string, number>();
let mountedPath = "";

function onScroll() {
  if (view && mountedPath) scrolls.set(mountedPath, view.scrollDOM.scrollTop);
}

function swapTo(path: string | null) {
  if (!handle || !view) return;
  if (mountedPath) scrolls.set(mountedPath, view.scrollDOM.scrollTop);
  const tab = store.tabs.find((t) => t.path === path);
  if (!tab) {
    mountedPath = "";
    return;
  }
  let state = states.get(tab.path);
  if (!state) {
    state = handle.createState(tab.content);
    states.set(tab.path, state);
  }
  handle.setState(state);
  mountedPath = tab.path;
  void nextTick(() => {
    if (!view) return;
    view.scrollDOM.scrollTop = scrolls.get(tab.path) ?? 0;
    view.focus();
  });
}

function scrollToLine(line: number) {
  if (!view) return;
  const doc = view.state.doc;
  const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
  view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  view.focus();
  store.scrollToLine = null;
}

/**
 * 把笔记里写的图片地址解析成 webview 能加载的 asset 地址。
 * 相对路径按「当前笔记所在目录」算，和 Markdown 的习惯一致。
 */
function resolveImage(url: string): string | null {
  return resolveAssetUrl(url, activeTab.value?.path);
}

/** 造卡范围：优先用选区，没选中就用光标所在的那一段。 */
function selectedBlocks(target: EditorView): SelectedBlock[] {
  const state = target.state;
  const range = state.selection.main;
  return blocksFromSelection(state.doc.toString(), range.from, range.to);
}

/**
 * 标记块（`Ctrl+Shift+B`）：给选中的每一段补一个 `^id`。
 *
 * 卡片自带快照，本来不需要正文配合；这个动作是给**你**用的——
 * 显出"这句已经成块了"，也让 `^id` 可以在双链里被引用。已经有 id 的块不动（幂等）。
 */
function markBlocks(target: EditorView) {
  const state = target.state;
  const blocks = selectedBlocks(target);
  const inserts: { pos: number; insert: string }[] = [];
  const used = new Set<string>();
  const seed = activeTab.value?.path ?? "";

  for (const block of blocks) {
    const line = state.doc.line(Math.max(1, Math.min(block.line, state.doc.lines)));
    if (/\^[A-Za-z0-9][\w-]*\s*$/.test(line.text)) continue;
    let id = blockIdFor(`${seed}:${block.line}:${block.text}`);
    while (used.has(id)) id = `${id}x`;
    used.add(id);
    inserts.push({ pos: line.to, insert: ` ^${id}` });
  }

  if (!inserts.length) {
    store.toast = "这些段落已经有块 id 了";
    return;
  }
  // 从后往前插入，前面的偏移才不会被自己改动
  inserts.sort((a, b) => b.pos - a.pos);
  target.dispatch({
    changes: inserts.map(({ pos, insert }) => ({ from: pos, to: pos, insert })),
    selection: { anchor: inserts[inserts.length - 1].pos + inserts[inserts.length - 1].insert.length },
    scrollIntoView: true,
  });
  store.toast = `已标记 ${inserts.length} 个块`;
}

/** 选区 → 造卡弹窗的数据。快照在这一刻就固定下来。 */
function selectionToCompose(blocks: SelectedBlock[]) {
  return blocks.map((block) => ({
    text: block.text,
    heading: block.heading,
    line: block.line,
    question: block.question,
  }));
}

/** 造卡（`Ctrl+Shift+C`）：先把改动落盘，再按选区建卡。 */
async function addCards(target: EditorView) {
  const blocks = selectedBlocks(target);
  if (!blocks.length) {
    store.toast = "先选中一段笔记，再按 Ctrl+Shift+C";
    return;
  }
  // 库里没有块，卡片只认笔记 + 快照，所以先把当前内容存下来再建卡
  await saveActive();
  openCardDialog(selectionToCompose(blocks));
}

/** 快速造卡：不弹窗，问题直接用草稿。 */
async function quickAddCards(target: EditorView) {
  const blocks = selectedBlocks(target);
  if (!blocks.length) {
    store.toast = "先选中一段笔记，再按 Ctrl+Shift+C";
    return;
  }
  await saveActive();
  await quickCreateCards(selectionToCompose(blocks));
}

/**
 * 块菜单里的「为这一块造卡」：先把光标放到那一行，再走和 Ctrl+Shift+C
 * 完全一样的路。与其为菜单写第二遍造卡逻辑，不如把光标挪过去复用。
 */
async function addCardsForLine(line: number) {
  const target = view;
  if (!target) return;
  const doc = target.state.doc;
  const at = doc.line(Math.max(1, Math.min(line, doc.lines)));
  target.dispatch({ selection: { anchor: at.from } });
  await addCards(target);
}

/** 块的稳定短 id：`^` + 8 位哈希。 */
function blockIdFor(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  return hash.toString(36).padStart(8, "0");
}

/** 编辑器里的右键菜单：编辑命令 + Markdown 排版。 */
function onHostContextMenu(event: MouseEvent) {
  if (view) editorMenu(event, view);
}

function editorMenu(event: MouseEvent, target: EditorView) {
  const { state } = target;
  const selectedText = state.selection.ranges
    .map((range) => state.sliceDoc(range.from, range.to))
    .join("\n");
  const hasSelection = state.selection.ranges.some((range) => !range.empty);

  // 在选区之外右键时，先把光标挪过去（和系统行为一致）
  const pos = target.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos != null && !state.selection.ranges.some((range) => pos >= range.from && pos <= range.to)) {
    target.dispatch({ selection: EditorSelection.cursor(pos) });
  }

  openMenu(event, [
    {
      label: "撤销",
      shortcut: "Ctrl+Z",
      disabled: undoDepth(state) === 0,
      action: () => {
        undo(target);
        target.focus();
      },
    },
    {
      label: "重做",
      shortcut: "Ctrl+Shift+Z",
      disabled: redoDepth(state) === 0,
      action: () => {
        redo(target);
        target.focus();
      },
    },
    { separator: true },
    {
      label: "剪切",
      shortcut: "Ctrl+X",
      disabled: !hasSelection,
      action: () => {
        void copyText(selectedText).then(() => deleteSelection(target));
      },
    },
    {
      label: "复制",
      shortcut: "Ctrl+C",
      disabled: !hasSelection,
      action: () => void copyText(selectedText),
    },
    {
      label: "粘贴",
      shortcut: "Ctrl+V",
      action: async () => {
        const text = await readClipboardText();
        if (text) insertAtCursor(target, text);
      },
    },
    { separator: true },
    {
      label: "标记为块",
      shortcut: "Ctrl+Shift+B",
      disabled: !activeTab.value,
      action: () => markBlocks(target),
    },
    {
      label: "为选中的块造卡…",
      shortcut: "Ctrl+Shift+C",
      disabled: !activeTab.value,
      action: () => void addCards(target),
    },
    {
      label: "快速造卡（问题用草稿）",
      disabled: !activeTab.value,
      action: () => void quickAddCards(target),
    },
    { separator: true },
    { label: "加粗", action: () => wrapSelection(target, "**") },
    { label: "斜体", action: () => wrapSelection(target, "*") },
    { label: "删除线", action: () => wrapSelection(target, "~~") },
    { label: "行内代码", action: () => wrapSelection(target, "`") },
    { label: "链接", action: () => insertLink(target) },
    { separator: true },
    { label: "插入双链 [[ ]]", action: () => insertWikilink(target) },
    { label: "插入待办", action: () => insertTodo(target) },
    { separator: true },
    {
      label: "全选",
      shortcut: "Ctrl+A",
      action: () => {
        selectAll(target);
        target.focus();
      },
    },
  ]);
}

onMounted(() => {
  if (!host.value) return;
  handle = createEditor(host.value, {
    content: activeTab.value?.content ?? "",
    dark: store.settings.theme === "dark",
    fontSize: store.settings.fontSize,
    showLineNumbers: store.settings.showLineNumbers,
    onChange: (text) => updateActiveContent(text),
    onCursor: (info) => {
      store.cursor = info;
    },
    onWikilink: (target) => void openWikilink(target),
    onExtractBlock: () => {
      if (view) markBlocks(view);
    },
    onAddCard: () => {
      if (view) void addCards(view);
    },
    imageSource: resolveImage,
    renderTable: (source) => renderMarkdown(source),
    /*
     * 块手柄的菜单：编辑器给的坐标是相对编辑器左上角的，这里翻成屏幕坐标
     * 交给统一的自定义菜单。菜单项本身就是 MenuItem 的形状，直接用。
     */
    onBlockMenu: (request) => {
      const rect = view?.dom.getBoundingClientRect();
      if (!rect) return;
      openMenuAt(rect.left + request.x, rect.top + request.y, request.items);
    },
    onAddCardForLine: (line) => void addCardsForLine(line),
  });
  view = handle.view;
  mountedPath = store.activePath ?? "";
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  if (store.scrollToLine) scrollToLine(store.scrollToLine);
});

onBeforeUnmount(() => {
  view?.scrollDOM.removeEventListener("scroll", onScroll);
  handle?.destroy();
  handle = null;
  view = null;
});

watch(
  () => store.activePath,
  (path) => swapTo(path),
);

watch(
  () => store.settings.theme,
  (theme) => handle?.setDark(theme === "dark"),
);

watch(
  () => store.settings.fontSize,
  (size) => handle?.setFontSize(size),
);

watch(
  () => store.settings.showLineNumbers,
  (show) => handle?.setLineNumbers(show),
);

watch(
  () => store.reloadTick,
  () => {
    const path = store.reloadPath;
    const tab = store.tabs.find((t) => t.path === path);
    if (!tab || !handle) return;
    states.delete(path);
    const fresh = handle.createState(tab.content);
    states.set(path, fresh);
    if (store.activePath === path) {
      handle.setState(fresh);
      mountedPath = path;
    }
  },
);

watch(
  () => store.scrollToLine,
  (line) => {
    if (line) void nextTick(() => scrollToLine(line));
  },
);

watch(
  () => store.settings.viewMode,
  () => {
    void nextTick(() => view?.requestMeasure());
  },
);
</script>

<template>
  <div class="editor-pane">
    <div ref="host" class="editor-host" @contextmenu="onHostContextMenu" />
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.editor-host {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
</style>
