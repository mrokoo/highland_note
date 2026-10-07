<script setup lang="ts">
import { Columns2, Eye, Layers, Link, SquarePen } from "lucide-vue-next";
import { ref, watch } from "vue";
import type { ViewMode } from "../lib/api";
import { activeTab, refreshCards, store } from "../lib/store";
import CardsPanel from "./CardsPanel.vue";
import LinkPanel from "./LinkPanel.vue";

/**
 * 右侧图标栏 + 面板。
 *
 * - 展开时：图标行在顶端，下面是当前功能的面板内容
 * - 收起时：只留一条竖排图标栏（和左边栏对称），点了就能再展开
 * - 两页功能：链接与反链、这篇笔记的卡片（加日历、标签这类，只要往 panels 里加一项）
 */

interface ViewItem {
  key: ViewMode;
  label: string;
  icon: unknown;
}

interface PanelItem {
  key: "links" | "cards";
  label: string;
  icon: unknown;
}

const views: ViewItem[] = [
  { key: "edit", label: "仅编辑 · Ctrl+E", icon: SquarePen },
  { key: "split", label: "分栏 · Ctrl+E", icon: Columns2 },
  { key: "preview", label: "仅预览 · Ctrl+E", icon: Eye },
];

/** 右侧面板的功能列表 */
const panels: PanelItem[] = [
  { key: "cards", label: "卡片视图", icon: Layers },
  { key: "links", label: "链接与反链", icon: Link },
];

const activePanel = ref<PanelItem["key"]>("cards");

/** 面板展开且停在「卡片」上时，数据必须是当前这篇笔记的。 */
function syncCards(open = store.settings.showRightPanel) {
  if (open && activePanel.value === "cards") void refreshCards();
}

watch(() => activeTab.value?.path, () => syncCards());
watch(() => store.settings.showRightPanel, (open) => syncCards(open));

function selectPanel(key: PanelItem["key"]) {
  if (!store.settings.showRightPanel) {
    store.settings.showRightPanel = true;
    activePanel.value = key;
    syncCards(true);
    return;
  }
  if (activePanel.value === key) {
    // 再点一次当前功能 = 收起面板（和左边栏一致）
    store.settings.showRightPanel = false;
    return;
  }
  activePanel.value = key;
  syncCards(true);
}
</script>

<template>
  <aside
    class="right-side"
    :class="{ collapsed: !store.settings.showRightPanel }"
    :style="store.settings.showRightPanel ? { width: `${store.settings.rightPanelWidth}px` } : {}"
  >
    <div class="right-toolbar">
      <button
        v-for="view in views"
        :key="view.key"
        class="icon-button"
        :class="{ active: store.settings.viewMode === view.key }"
        :title="view.label"
        @click="store.settings.viewMode = view.key"
      >
        <component :is="view.icon" :size="19" :stroke-width="1.75" />
      </button>

      <span class="spacer" />

      <button
        v-for="panel in panels"
        :key="panel.key"
        class="icon-button"
        :class="{ active: store.settings.showRightPanel && activePanel === panel.key }"
        :title="store.settings.showRightPanel ? `${panel.label} · 再点收起` : panel.label"
        @click="selectPanel(panel.key)"
      >
        <component :is="panel.icon" :size="19" :stroke-width="1.75" />
      </button>
    </div>

    <div v-if="store.settings.showRightPanel" class="right-body">
      <CardsPanel v-if="activePanel === 'cards'" />
      <LinkPanel v-else />
    </div>
  </aside>
</template>
