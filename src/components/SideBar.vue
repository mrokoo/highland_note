<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import TreeNode from "./TreeNode.vue";
import type { FileNode } from "../lib/api";
import {
  createFolder,
  createNote,
  deleteEntry,
  moveEntry,
  openMenu,
  openNote,
  refreshNotes,
  refreshTree,
  renameEntry,
  runSearch,
  scheduleSearch,
  store,
  type MenuItem,
} from "../lib/store";
import { copyText } from "../lib/clipboard";
import { ROOT_DROP, dnd } from "../lib/dnd";

const searchInput = ref<HTMLInputElement | null>(null);

const rootIsDropTarget = computed(() => dnd.over === ROOT_DROP);

// 从快捷键切到搜索页时自动聚焦输入框
watch(
  () => store.sidebarTab,
  async (tab) => {
    if (tab !== "search") return;
    await nextTick();
    searchInput.value?.focus();
  },
);

/** 文件树 / 文件夹空白处的右键菜单。 */
function rowMenu(event: MouseEvent, node: FileNode | null) {
  if (!node) {
    openMenu(event, [
      { label: "新建笔记", action: () => void createNote("") },
      { label: "新建文件夹", action: () => void createFolder("") },
      { label: "刷新", action: () => void refresh() },
    ]);
    return;
  }

  const items: MenuItem[] = [];
  if (node.isDir) {
    items.push({ label: "在此新建笔记", action: () => void createNote(node.path) });
    items.push({ label: "在此新建文件夹", action: () => void createFolder(node.path) });
  } else {
    items.push({ label: "打开", action: () => void openNote(node.path) });
  }
  items.push({ separator: true });
  items.push({ label: "重命名", action: () => void renameEntry(node.path) });
  items.push({ label: "复制路径", action: () => void copyText(node.path) });
  if (node.path.includes("/")) {
    items.push({ label: "移动到根目录", action: () => void moveEntry(node.path, "") });
  }
  items.push({ separator: true });
  items.push({
    label: "删除",
    danger: true,
    action: () => void deleteEntry(node.path),
  });
  openMenu(event, items);
}

/** 搜索结果的右键菜单。 */
function hitMenu(event: MouseEvent, path: string, line: number, text: string) {
  openMenu(event, [
    { label: "打开", action: () => void openNote(path, line) },
    { label: "复制这一行", action: () => void copyText(text) },
    { separator: true },
    { label: "复制路径", action: () => void copyText(path) },
  ]);
}

async function refresh() {
  await Promise.all([refreshTree(), refreshNotes()]);
}

function onRootDragOver(event: DragEvent) {
  if (!dnd.path) return;
  event.preventDefault();
  dnd.over = ROOT_DROP;
}

function onRootDragLeave() {
  if (dnd.over === ROOT_DROP) dnd.over = "";
}

function onRootDrop(event: DragEvent) {
  if (!dnd.path) return;
  event.preventDefault();
  const source = dnd.path;
  dnd.path = "";
  dnd.over = "";
  void moveEntry(source, "");
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

function highlight(text: string, query: string): string {
  const escaped = text.replace(/[&<>]/g, (c) => HTML_ESCAPES[c] ?? c);
  const needle = query.trim();
  if (!needle) return escaped;
  const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(safe, "gi"), (match) => `<mark>${match}</mark>`);
}
</script>

<template>
  <aside class="sidebar" :style="{ width: `${store.settings.sidebarWidth}px` }">
    <div class="sidebar-tabs">
      <button :class="{ active: store.sidebarTab === 'files' }" @click="store.sidebarTab = 'files'">
        文件
      </button>
      <button :class="{ active: store.sidebarTab === 'search' }" @click="store.sidebarTab = 'search'">
        搜索
      </button>
    </div>

    <template v-if="store.sidebarTab === 'files'">
      <div class="sidebar-actions">
        <button class="icon-button" title="新建笔记 (Ctrl+N)" @click="createNote('')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M12 11v6M9 14h6" />
          </svg>
          新建笔记
        </button>
        <button class="icon-button" title="新建文件夹" @click="createFolder('')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M12 12v5M9.5 14.5h5" />
          </svg>
        </button>
        <button class="icon-button" title="刷新" @click="refresh">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 12a8 8 0 1 1-2.3-5.6" />
            <path d="M20 4v4h-4" />
          </svg>
        </button>
      </div>

      <div
        class="tree"
        :class="{ 'drop-target': rootIsDropTarget }"
        @contextmenu="rowMenu($event, null)"
        @dragover="onRootDragOver"
        @dragleave="onRootDragLeave"
        @drop="onRootDrop"
      >
        <TreeNode
          v-for="node in store.tree"
          :key="node.path"
          :node="node"
          :depth="0"
          @menu="({ event, node }) => rowMenu(event, node)"
        />
        <div v-if="!store.tree.length" class="sidebar-empty">
          {{ store.treeLoading ? "正在读取…" : "这个仓库里还没有笔记" }}
        </div>
      </div>
    </template>

    <template v-else>
      <div class="search-box">
        <input
          ref="searchInput"
          v-model="store.searchQuery"
          placeholder="搜索全部笔记的内容…"
          @input="scheduleSearch"
          @keydown.enter="runSearch"
        />
      </div>
      <div class="search-results">
        <div v-if="store.searching" class="sidebar-empty">搜索中…</div>
        <template v-else-if="store.searchHits.length">
          <div class="result-count">{{ store.searchHits.length }} 条结果</div>
          <div
            v-for="hit in store.searchHits"
            :key="`${hit.path}:${hit.line}`"
            class="search-hit"
            @click="openNote(hit.path, hit.line)"
            @contextmenu="hitMenu($event, hit.path, hit.line, hit.text)"
          >
            <div class="hit-title">
              {{ hit.title }}<span class="hit-line-no">:{{ hit.line }}</span>
            </div>
            <div class="hit-line" v-html="highlight(hit.text, store.searchQuery)" />
          </div>
        </template>
        <div v-else class="sidebar-empty">
          {{ store.searchQuery.trim() ? "没有匹配的内容" : "输入关键词搜索笔记正文" }}
        </div>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.result-count {
  padding: 4px 10px 8px;
  color: var(--text-faint);
  font-size: 12px;
}

.hit-line-no {
  color: var(--text-faint);
}

.tree.drop-target {
  background: var(--accent-bg);
  outline: 1px dashed var(--accent);
  outline-offset: -2px;
}
</style>
