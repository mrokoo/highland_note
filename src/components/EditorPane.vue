<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { redo, redoDepth, selectAll, undo, undoDepth } from "@codemirror/commands";
import { createEditor, type EditorHandle } from "../lib/editor";
import {
  activeTab,
  openMenu,
  openWikilink,
  saveActive,
  store,
  updateActiveContent,
} from "../lib/store";
import { resolveAssetUrl } from "../lib/assets";
import { copyText, readClipboardText } from "../lib/clipboard";
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
    { label: "保存笔记", shortcut: "Ctrl+S", action: () => void saveActive() },
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
    imageSource: resolveImage,
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
