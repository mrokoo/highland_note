<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FilePlus,
  FolderPlus,
  FolderTree,
  RefreshCw,
} from "lucide-vue-next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import TreeNode from "./TreeNode.vue";
import OutlinePanel from "./OutlinePanel.vue";
import type { FileNode } from "../lib/api";
import {
  closeVault,
  createFolder,
  createNote,
  deleteEntry,
  moveEntry,
  openMenu,
  openNote,
  openVault,
  pickVault,
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

/** 树里任意一层被展开着。 */
const anyExpanded = computed(() => Object.values(store.expanded).some(Boolean));

function collectFolders(nodes: FileNode[], out: string[]) {
  for (const node of nodes) {
    if (!node.isDir) continue;
    out.push(node.path);
    collectFolders(node.children ?? [], out);
  }
}

/** 一键全部展开 / 全部折叠。 */
function toggleFolders() {
  if (anyExpanded.value) {
    store.expanded = {};
    return;
  }
  const folders: string[] = [];
  collectFolders(store.tree, folders);
  const next: Record<string, boolean> = {};
  for (const path of folders) next[path] = true;
  store.expanded = next;
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 仓库页脚菜单：切换仓库、最近打开、在资源管理器里显示、关闭。 */
function vaultMenu(event: MouseEvent) {
  const current = store.vault?.path;
  const items: MenuItem[] = [
    { label: "打开其他仓库…", shortcut: "Ctrl+O", action: () => void pickVault() },
  ];

  const recents = store.settings.recentVaults.filter((path) => path !== current);
  if (recents.length) {
    items.push({ separator: true });
    for (const path of recents.slice(0, 6)) {
      items.push({ label: `切换到 ${baseName(path)}`, action: () => void openVault(path) });
    }
  }

  if (current) {
    items.push({ separator: true });
    items.push({
      label: "在资源管理器中显示",
      action: () => void revealItemInDir(current).catch(() => undefined),
    });
  }

  items.push({ separator: true });
  items.push({ label: "关闭仓库", danger: true, action: () => void closeVault() });

  openMenu(event, items);
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
    <template v-if="store.sidebarTab === 'files'">
      <div class="sidebar-actions">
        <button class="icon-button" title="新建笔记 · Ctrl+N" @click="createNote('')">
          <FilePlus :size="19" :stroke-width="1.75" />
        </button>
        <button class="icon-button" title="新建文件夹" @click="createFolder('')">
          <FolderPlus :size="19" :stroke-width="1.75" />
        </button>
        <button
          class="icon-button"
          :title="anyExpanded ? '全部折叠' : '全部展开'"
          :disabled="!store.tree.length"
          @click="toggleFolders"
        >
          <ChevronsDownUp v-if="anyExpanded" :size="19" :stroke-width="1.75" />
          <ChevronsUpDown v-else :size="19" :stroke-width="1.75" />
        </button>
        <button class="icon-button" title="刷新" @click="refresh">
          <RefreshCw :size="18" :stroke-width="1.75" />
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

    <template v-else-if="store.sidebarTab === 'outline'">
      <OutlinePanel />
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

    <!-- 仓库页脚：切换 / 管理当前仓库 -->
    <button class="vault-footer" :title="store.vault?.path ?? ''" @click="vaultMenu">
      <FolderTree :size="15" :stroke-width="1.8" class="vault-icon" />
      <span class="vault-footer-name">{{ store.vault?.name ?? "未打开仓库" }}</span>
      <ChevronsUpDown :size="13" :stroke-width="2" class="vault-caret" />
    </button>
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
