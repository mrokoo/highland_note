<script setup lang="ts">
import { activateTab, closeAllTabs, closeOtherTabs, closeTab, createNote, openMenu, store } from "../lib/store";
import { copyText } from "../lib/clipboard";

function tabMenu(event: MouseEvent, path: string) {
  openMenu(event, [
    { label: "关闭", shortcut: "Ctrl+W", action: () => closeTab(path) },
    { label: "关闭其他标签页", action: () => closeOtherTabs(path) },
    { label: "关闭全部标签页", action: closeAllTabs },
    { separator: true },
    { label: "复制笔记路径", action: () => void copyText(path) },
  ]);
}
</script>

<template>
  <div class="tabbar">
    <div
      v-for="tab in store.tabs"
      :key="tab.path"
      class="tab"
      :class="{ active: tab.path === store.activePath }"
      :title="tab.path"
      @click="activateTab(tab.path)"
      @mousedown.middle.prevent="closeTab(tab.path)"
      @contextmenu="tabMenu($event, tab.path)"
    >
      <span v-if="tab.dirty" class="dirty-dot" />
      <span class="tab-title">{{ tab.title }}</span>
      <button class="tab-close" title="关闭 (Ctrl+W)" @click.stop="closeTab(tab.path)">✕</button>
    </div>

    <button class="tab-new" title="新建笔记 · Ctrl+N" @click="createNote('')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  </div>
</template>
