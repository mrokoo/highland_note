<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { LinkRef } from "../lib/api";
import {
  activeTab,
  openNote,
  openWikilink,
  scheduleLinksRefresh,
  store,
} from "../lib/store";

const outgoing = computed(() => store.links?.outgoing ?? []);
const backlinks = computed(() => store.links?.backlinks ?? []);
const collapsed = ref<Record<string, boolean>>({});

function toggle(section: string) {
  collapsed.value[section] = !collapsed.value[section];
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** 上下文行：转义后把 `[[链接]]` 换成高亮片段，只显示可读的那部分。 */
function renderContext(text: string): string {
  const escaped = text.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char);
  return escaped.replace(/\[\[([^[\]]+)\]\]/g, (_match, inner: string) => {
    const [targetPart, aliasPart] = inner.split("|");
    const shown = (aliasPart ?? targetPart.split("#")[0]).trim();
    return `<span class="ctx-link">${shown}</span>`;
  });
}

/**
 * 反向链接：跳到「引用者」这篇笔记，并定位到它出现链接的那一行。
 * 注意不能跳 targetPath —— 反链的 target 就是当前笔记自己。
 */
function openBacklink(ref: LinkRef) {
  void openNote(ref.path, ref.line);
}

/** 出链：跳到被引用的笔记；目标不存在时问要不要新建。 */
function openOutgoing(ref: LinkRef) {
  if (ref.resolved && ref.targetPath) void openNote(ref.targetPath, ref.line);
  else void openWikilink(ref.target);
}

onMounted(() => {
  void scheduleLinksRefresh(0);
});

onBeforeUnmount(() => {
  store.links = null;
});

// 换笔记立刻算；编辑内容时防抖重算
watch(
  () => activeTab.value?.path,
  () => void scheduleLinksRefresh(0),
);

watch(
  () => activeTab.value?.content,
  () => scheduleLinksRefresh(),
);
</script>

<template>
  <div class="link-body">
    <!-- 反向链接：谁引用了我 -->
    <section class="link-section">
      <button class="link-section-head" @click="toggle('back')">
        <svg class="chevron" :class="{ open: !collapsed.back }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M9 5l7 7-7 7" />
        </svg>
        <span>反向链接</span>
        <span class="count">{{ backlinks.length }}</span>
      </button>

      <div v-if="!collapsed.back" class="link-list">
        <div
          v-for="link in backlinks"
          :key="`${link.path}:${link.line}`"
          class="link-item"
          :title="`${link.path} : ${link.line}`"
          @click="openBacklink(link)"
        >
          <div class="link-source">{{ link.title }}</div>
          <div class="link-context" v-html="renderContext(link.context)" />
        </div>
        <div v-if="!backlinks.length" class="link-empty">还没有笔记引用这一篇</div>
      </div>
    </section>

    <!-- 出链：我引用了谁 -->
    <section class="link-section">
      <button class="link-section-head" @click="toggle('out')">
        <svg class="chevron" :class="{ open: !collapsed.out }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M9 5l7 7-7 7" />
        </svg>
        <span>出链</span>
        <span class="count">{{ outgoing.length }}</span>
      </button>

      <div v-if="!collapsed.out" class="link-list">
        <div
          v-for="link in outgoing"
          :key="`${link.line}:${link.target}`"
          class="link-item outgoing"
          :class="{ missing: !link.resolved }"
          :title="link.resolved ? link.targetPath ?? '' : `「${link.target}」还不存在，点击创建`"
          @click="openOutgoing(link)"
        >
          <div class="link-source">
            {{ link.alias }}
            <span v-if="!link.resolved" class="badge">未创建</span>
          </div>
          <div class="link-context" v-html="renderContext(link.context)" />
        </div>
        <div v-if="!outgoing.length" class="link-empty">这一篇还没有 [[双链]]</div>
      </div>
    </section>
  </div>
</template>
