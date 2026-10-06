<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { closeQuickSwitcher, createNote, openNote, quickResults, store } from "../lib/store";

const input = ref<HTMLInputElement | null>(null);

function move(delta: number) {
  const total = quickResults.value.length;
  if (!total) return;
  store.quickIndex = (store.quickIndex + delta + total) % total;
}

async function choose(index?: number) {
  const target = quickResults.value[index ?? store.quickIndex];
  if (!target) return;
  closeQuickSwitcher();
  await openNote(target.path);
}

async function createFromQuery() {
  const name = store.quickQuery.trim();
  closeQuickSwitcher();
  if (name) await createNote("", name);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (quickResults.value.length) void choose();
    else void createFromQuery();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeQuickSwitcher();
  }
}

watch(
  () => store.quickQuery,
  () => {
    store.quickIndex = 0;
  },
);

watch(
  () => store.quickSwitcher,
  async (open) => {
    if (!open) return;
    await nextTick();
    input.value?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div class="overlay" @click.self="closeQuickSwitcher">
    <div class="panel quick-switcher">
      <input
        ref="input"
        v-model="store.quickQuery"
        placeholder="按名称跳转或新建笔记…"
        @keydown="onKeydown"
      />
      <div class="quick-list">
        <div
          v-for="(item, index) in quickResults"
          :key="item.path"
          class="quick-item"
          :class="{ selected: index === store.quickIndex }"
          @mouseenter="store.quickIndex = index"
          @click="choose(index)"
        >
          <span class="q-title">{{ item.title }}</span>
          <span class="q-path">{{ item.folder || "/" }}</span>
        </div>
        <div v-if="!quickResults.length" class="sidebar-empty">
          没有匹配的笔记，回车可直接新建《{{ store.quickQuery }}》
        </div>
      </div>
    </div>
  </div>
</template>
