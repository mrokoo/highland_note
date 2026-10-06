<script setup lang="ts">
import { computed } from "vue";
import { activeTab, store } from "../lib/store";
import { countStats } from "../lib/markdown";

const stats = computed(() =>
  activeTab.value ? countStats(activeTab.value.content) : { chars: 0, words: 0 },
);

const saveState = computed(() => {
  const tab = activeTab.value;
  if (!tab) return "";
  if (tab.error) return tab.error;
  return tab.dirty ? "未保存" : "已保存";
});

const viewLabel = computed(
  () => ({ edit: "编辑", split: "分栏", preview: "预览" })[store.settings.viewMode],
);
</script>

<template>
  <footer class="statusbar">
    <span v-if="store.vault">{{ store.vault.name }}</span>
    <span v-if="activeTab" :title="activeTab.path">{{ activeTab.path }}</span>
    <span class="spacer" />
    <span v-if="activeTab">{{ stats.words }} 字 · {{ stats.chars }} 字符</span>
    <span v-if="activeTab">行 {{ store.cursor.line }}，列 {{ store.cursor.col }}</span>
    <span v-if="store.cursor.selected">已选 {{ store.cursor.selected }}</span>
    <span :class="{ error: activeTab?.error }">{{ saveState }}</span>
    <span>{{ viewLabel }}</span>
  </footer>
</template>
