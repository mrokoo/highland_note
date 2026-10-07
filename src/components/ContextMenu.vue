<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { closeMenu, runMenuItem, store } from "../lib/store";

const panel = ref<HTMLElement | null>(null);
const position = ref({ x: 0, y: 0 });
const ready = ref(false);
const active = ref(-1);

const items = computed(() => store.menu?.items ?? []);
const enabled = computed(() =>
  items.value
    .map((item, index) => (item.separator || item.disabled ? -1 : index))
    .filter((index) => index >= 0),
);

/** 先量出菜单实际大小，再把它挪进窗口内，避免贴边被截断。 */
async function place() {
  await nextTick();
  const el = panel.value;
  if (!el || !store.menu) return;
  const rect = el.getBoundingClientRect();
  const margin = 8;
  position.value = {
    x: Math.max(margin, Math.min(store.menu.x, window.innerWidth - rect.width - margin)),
    y: Math.max(margin, Math.min(store.menu.y, window.innerHeight - rect.height - margin)),
  };
  ready.value = true;
  el.focus();
}

function move(delta: number) {
  const list = enabled.value;
  if (!list.length) return;
  const current = list.indexOf(active.value);
  const next =
    current < 0
      ? delta > 0
        ? 0
        : list.length - 1
      : (current + delta + list.length) % list.length;
  active.value = list[next];
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeMenu();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const item = items.value[active.value];
    if (item) runMenuItem(item);
  }
}

function dismiss() {
  closeMenu();
}

// 菜单未关闭时又弹了新的（例如换个地方右键），重新测量位置
watch(
  () => store.menu,
  () => {
    ready.value = false;
    active.value = -1;
    void place();
  },
);

onMounted(() => {
  void place();
  window.addEventListener("click", dismiss);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);
  window.addEventListener("wheel", dismiss, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("click", dismiss);
  window.removeEventListener("blur", dismiss);
  window.removeEventListener("resize", dismiss);
  window.removeEventListener("wheel", dismiss);
});
</script>

<template>
  <div
    v-if="store.menu"
    ref="panel"
    class="context-menu"
    :class="{ ready }"
    :style="{ left: `${position.x}px`, top: `${position.y}px` }"
    tabindex="-1"
    @contextmenu.prevent.stop
    @keydown="onKeydown"
  >
    <template v-for="(item, index) in items" :key="index">
      <div v-if="item.separator" class="menu-sep" />
      <button
        v-else
        class="menu-item"
        :class="{ danger: item.danger, active: index === active }"
        :disabled="item.disabled"
        @click="runMenuItem(item)"
        @mouseenter="active = index"
      >
        <span class="menu-label">{{ item.label }}</span>
        <span v-if="item.shortcut" class="menu-shortcut">{{ item.shortcut }}</span>
      </button>
    </template>
  </div>
</template>
