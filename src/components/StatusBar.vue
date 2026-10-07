<script setup lang="ts">
import { computed } from "vue";
import { activeTab, store } from "../lib/store";
import { countStats } from "../lib/markdown";

const stats = computed(() =>
  activeTab.value ? countStats(activeTab.value.content) : { chars: 0, words: 0 },
);

/**
 * 保存状态只是**提示**，不是按钮：编辑停手约 0.6 秒自动落库，
 * 所以要手动点的入口一个都不留（`Ctrl` + `S` 仍然可用，但不再是必经之路）。
 *
 * 平时就写"已自动保存"，不跟着每次编辑闪"保存中…"——那是打扰，不是信息。
 */
const saveState = computed(() => {
  const tab = activeTab.value;
  if (!tab) return "";
  if (tab.error) return tab.error;
  return "已自动保存";
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
    <span
      v-if="activeTab"
      class="status-save"
      :class="{ dirty: activeTab.dirty, error: activeTab.error }"
    >
      {{ saveState }}
    </span>
    <span>{{ viewLabel }}</span>
  </footer>
</template>
