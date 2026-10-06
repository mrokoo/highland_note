<script setup lang="ts">
import { computed } from "vue";
import { headingAt, extractOutline } from "../lib/outline";
import { activeTab, store } from "../lib/store";

const headings = computed(() => (activeTab.value ? extractOutline(activeTab.value.content) : []));

/** 光标所在的小节高亮 */
const current = computed(() => headingAt(headings.value, store.cursor.line));

const baseLevel = computed(() =>
  headings.value.length ? Math.min(...headings.value.map((h) => h.level)) : 1,
);

function jump(line: number) {
  store.scrollToLine = line;
}
</script>

<template>
  <div class="outline-body">
    <div class="outline-caption" :title="activeTab?.path">
      {{ activeTab ? activeTab.title : "还没有打开笔记" }}
    </div>

    <div class="outline-list">
      <button
        v-for="(heading, index) in headings"
        :key="`${heading.line}-${heading.text}`"
        class="outline-item"
        :class="{ active: index === current }"
        :style="{ paddingLeft: `${10 + (heading.level - baseLevel) * 12}px` }"
        :title="heading.text"
        @click="jump(heading.line)"
      >
        {{ heading.text }}
      </button>
      <div v-if="!headings.length" class="sidebar-empty">
        {{ activeTab ? "这篇笔记还没有标题" : "打开一篇笔记就能看到它的目录" }}
      </div>
    </div>
  </div>
</template>
