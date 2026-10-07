<script setup lang="ts">
import { FolderTree, GraduationCap, LayoutDashboard, ListTree, Search, Settings } from "lucide-vue-next";
import { onMounted } from "vue";
import { refreshReviewStats, startReview, store, type SidebarTab } from "../lib/store";

/**
 * 左侧工具条，从上到下三组：
 *
 * 1. **视图**（工作台 / 复习）—— 换掉中间那一块，互相独立
 * 2. **列表面板**（文件 / 搜索 / 目录）—— 同一时刻只开一个，再点收起
 * 3. **设置**（固定在底部）
 *
 * 「跳转」曾经在这里，现在撤了：新建在文件面板顶部，跳转有 `Ctrl` + `P`，
 * 留一个图标只会让真正常用的那两个更难找。
 * 「复习」上的到期数字徽标也撤了：数字是每天变的，挂在这儿只会一直催你；
 * 今日到期在卡片面板里看得见（进入复习后一张张过就是了）。
 */

onMounted(() => {
  // 仍然要拉一次：卡片面板的小结和左侧「复习」入口都要它把数据准备好
  void refreshReviewStats();
});

interface RailItem {
  key: SidebarTab;
  label: string;
  hint: string;
  icon: unknown;
}

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
      <button class="rail-button" title="复习 · Ctrl+Shift+R" @click="startReview()">
        <GraduationCap :size="20" :stroke-width="1.7" />
        <span class="rail-label">复习</span>
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
