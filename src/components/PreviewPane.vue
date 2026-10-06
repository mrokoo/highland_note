<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown } from "../lib/markdown";
import {
  activeTab,
  openMenu,
  openWikilink,
  runSearch,
  store,
  type MenuItem,
} from "../lib/store";
import { copyText } from "../lib/clipboard";

const html = ref("");
const body = ref<HTMLElement | null>(null);
let timer: number | undefined;

function refresh() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    html.value = activeTab.value ? renderMarkdown(activeTab.value.content) : "";
  }, 110);
}

watch(() => activeTab.value?.path, refresh, { immediate: true });
watch(() => activeTab.value?.content, refresh);
watch(() => store.reloadTick, refresh);

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

async function openExternal(url: string) {
  await openUrl(url).catch(() => undefined);
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? "";
}

function selectAllPreview() {
  const el = body.value;
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement;

  const link = target.closest("[data-wikilink]");
  if (link) {
    event.preventDefault();
    await openWikilink(link.getAttribute("data-wikilink") ?? "");
    return;
  }

  const tag = target.closest("[data-tag]");
  if (tag) {
    store.settings.showSidebar = true;
    store.sidebarTab = "search";
    store.searchQuery = `#${tag.getAttribute("data-tag") ?? ""}`;
    await runSearch();
    return;
  }

  const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
  if (anchor && /^https?:/i.test(anchor.getAttribute("href") ?? "")) {
    event.preventDefault();
    await openExternal(anchor.href);
  }
}

/** 预览区的右键菜单：复制、跳转、打开链接。 */
function onContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const selection = selectedText();
  const items: MenuItem[] = [];

  const wiki = target.closest("[data-wikilink]");
  if (wiki) {
    const name = wiki.getAttribute("data-wikilink") ?? "";
    items.push({ label: `打开「${name}」`, action: () => void openWikilink(name) });
    items.push({ label: "复制笔记名", action: () => void copyText(name) });
    items.push({ separator: true });
  }

  const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
  if (anchor && /^https?:/i.test(anchor.getAttribute("href") ?? "")) {
    items.push({ label: "在浏览器中打开", action: () => void openExternal(anchor.href) });
    items.push({ label: "复制链接地址", action: () => void copyText(anchor.href) });
    items.push({ separator: true });
  }

  items.push({
    label: "复制",
    shortcut: "Ctrl+C",
    disabled: !selection,
    action: () => void copyText(selection),
  });
  items.push({ label: "全选", shortcut: "Ctrl+A", action: selectAllPreview });
  items.push({ separator: true });
  items.push({
    label: "复制整篇 Markdown",
    action: () => void copyText(activeTab.value?.content ?? ""),
  });

  openMenu(event, items);
}
</script>

<template>
  <div class="preview-pane" @click="onClick" @contextmenu="onContextMenu">
    <div ref="body" class="markdown-body" v-html="html" />
  </div>
</template>
