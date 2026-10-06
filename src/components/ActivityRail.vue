<script setup lang="ts">
import { openQuickSwitcher, store, type SidebarTab } from "../lib/store";

interface RailItem {
  key: SidebarTab;
  label: string;
  hint: string;
}

/**
 * 左侧工具/菜单栏：上半是「跳转」这类瞬时动作，下半是列表面板的切换，
 * 设置固定在底部。以后加复习、知识树只要往 items 里加一项。
 */
const items: RailItem[] = [
  { key: "files", label: "文件", hint: "文件 · Ctrl+Shift+E" },
  { key: "search", label: "搜索", hint: "全文搜索 · Ctrl+Shift+F" },
  { key: "outline", label: "目录", hint: "标题大纲 · Alt+O" },
];

function select(key: SidebarTab) {
  if (store.sidebarTab === key && store.settings.showSidebar) {
    // 再点一次当前项 = 收起列表面板
    store.settings.showSidebar = false;
    return;
  }
  store.sidebarTab = key;
  store.settings.showSidebar = true;
}
</script>

<template>
  <nav class="rail">
    <div class="rail-items">
      <button class="rail-button" title="快速跳转 · Ctrl+P" @click="openQuickSwitcher">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 12h13M12 6l6 6-6 6" />
        </svg>
        <span class="rail-label">跳转</span>
      </button>
    </div>

    <div class="rail-divider" />

    <div class="rail-items">
      <button
        v-for="item in items"
        :key="item.key"
        class="rail-button"
        :class="{ active: store.sidebarTab === item.key && store.settings.showSidebar }"
        :title="item.hint"
        @click="select(item.key)"
      >
        <svg
          v-if="item.key === 'files'"
          width="19"
          height="19"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M9.5 11h5M9.5 15h5" />
        </svg>
        <svg
          v-else-if="item.key === 'search'"
          width="19"
          height="19"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <svg v-else width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 6h10M4 12h16M4 18h7" />
        </svg>
        <span class="rail-label">{{ item.label }}</span>
      </button>
    </div>

    <div class="rail-spacer" />

    <button
      class="rail-button"
      :class="{ active: store.showSettings }"
      title="设置 · Ctrl+,"
      @click="store.showSettings = true"
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9.5 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4z"
        />
      </svg>
      <span class="rail-label">设置</span>
    </button>
  </nav>
</template>
