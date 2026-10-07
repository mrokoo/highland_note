<script setup lang="ts">
import { ArrowRightLeft, FolderTree, GraduationCap, LayoutDashboard, ListTree, Search, Settings } from "lucide-vue-next";
import { computed, onMounted } from "vue";
import { openQuickSwitcher, refreshReviewStats, startReview, store, type SidebarTab } from "../lib/store";

/** 侧栏徽标：今日到期 + 新卡。 */
const dueCount = computed(() => store.reviewStats?.dueToday ?? 0);

onMounted(() => {
  void refreshReviewStats();
});

interface RailItem {
  key: SidebarTab;
  label: string;
  hint: string;
  icon: unknown;
}

/**
 * 左侧工具/菜单栏：上半是「跳转」这类瞬时动作，下半是列表面板的切换，
 * 设置固定在底部。以后加复习、知识树只要往 items 里加一项。
 */
const items: RailItem[] = [
  { key: "files", label: "文件", hint: "文件 · Ctrl+Shift+E", icon: FolderTree },
  { key: "search", label: "搜索", hint: "全文搜索 · Ctrl+Shift+F", icon: Search },
  { key: "outline", label: "目录", hint: "标题大纲 · Alt+O", icon: ListTree },
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
      <button
        class="rail-button"
        :class="{ active: store.showWorkbench }"
        title="工作台 · Ctrl+Shift+W"
        @click="store.showWorkbench = !store.showWorkbench"
      >
        <LayoutDashboard :size="20" :stroke-width="1.7" />
        <span class="rail-label">工作台</span>
      </button>
      <button
        class="rail-button rail-review"
        title="复习 · Ctrl+Shift+R"
        @click="startReview()"
      >
        <GraduationCap :size="20" :stroke-width="1.7" />
        <span class="rail-label">复习</span>
        <span v-if="dueCount" class="rail-badge">{{ dueCount > 99 ? "99+" : dueCount }}</span>
      </button>
      <button class="rail-button" title="快速跳转 · Ctrl+P" @click="openQuickSwitcher">
        <ArrowRightLeft :size="20" :stroke-width="1.7" />
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
        <component :is="item.icon" :size="20" :stroke-width="1.7" />
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
      <Settings :size="20" :stroke-width="1.7" />
      <span class="rail-label">设置</span>
    </button>
  </nav>
</template>
