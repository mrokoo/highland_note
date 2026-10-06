<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 该类型没有从包入口导出，这里从方法签名里取，避免手写一份会过期的定义。 */
type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];
import SideBar from "./components/SideBar.vue";
import TabBar from "./components/TabBar.vue";
import EditorPane from "./components/EditorPane.vue";
import PreviewPane from "./components/PreviewPane.vue";
import StatusBar from "./components/StatusBar.vue";
import WelcomeScreen from "./components/WelcomeScreen.vue";
import QuickSwitcher from "./components/QuickSwitcher.vue";
import ModalHost from "./components/ModalHost.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import ContextMenu from "./components/ContextMenu.vue";
import {
  activeTab,
  closeTab,
  createNote,
  cycleViewMode,
  init,
  openMenu,
  openQuickSwitcher,
  pickVault,
  saveActive,
  setSplitRatio,
  setTheme,
  store,
} from "./lib/store";

const showEditor = computed(() => store.settings.viewMode !== "preview");
const showPreview = computed(() => store.settings.viewMode !== "edit");

const panesRef = ref<HTMLElement | null>(null);

// ------------------------------------------------------------ 自绘窗口边框

const appWindow = getCurrentWindow();
const isMaximized = ref(false);
let unlistenResize: (() => void) | undefined;

function minimizeWindow() {
  void appWindow.minimize().catch(() => undefined);
}

function toggleMaximizeWindow() {
  void appWindow.toggleMaximize().catch(() => undefined);
}

function closeWindow() {
  void appWindow.close().catch(() => undefined);
}

/** 去掉原生边框后系统不再提供边缘缩放，这八个热区自己调 startResizeDragging。 */
function startWindowResize(direction: ResizeDirection, event: MouseEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  void appWindow.startResizeDragging(direction).catch(() => undefined);
}

async function syncMaximized() {
  try {
    isMaximized.value = await appWindow.isMaximized();
  } catch {
    isMaximized.value = false;
  }
}

/** 只有「分栏」且确实有笔记时，中间才出现可拖动的分隔条。 */
const isSplit = computed(() => store.settings.viewMode === "split" && !!activeTab.value);

const editorPaneStyle = computed(() =>
  isSplit.value ? { flexGrow: store.settings.splitRatio, flexBasis: "0px" } : {},
);

const previewPaneStyle = computed(() =>
  isSplit.value ? { flexGrow: 1 - store.settings.splitRatio, flexBasis: "0px" } : {},
);

/** 拖动分栏分隔条，调整编辑区与预览区的宽度比例。 */
function startPaneResize(event: MouseEvent) {
  event.preventDefault();
  const panes = panesRef.value;
  if (!panes) return;
  const rect = panes.getBoundingClientRect();
  if (rect.width <= 0) return;
  const onMove = (move: MouseEvent) => {
    setSplitRatio((move.clientX - rect.left) / rect.width);
  };
  const onUp = () => {
    document.body.classList.remove("resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  document.body.classList.add("resizing");
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function resetSplitRatio() {
  setSplitRatio(0.5);
}

/** 空白区域（工具栏、状态栏、空状态）的通用菜单。 */
function appMenu(event: MouseEvent) {
  if (store.prompt || store.confirm || store.quickSwitcher || store.showSettings) return;
  openMenu(event, [
    { label: "新建笔记", shortcut: "Ctrl+N", action: () => void createNote("") },
    { label: "快速跳转", shortcut: "Ctrl+P", action: openQuickSwitcher },
    {
      label: "保存当前笔记",
      shortcut: "Ctrl+S",
      disabled: !activeTab.value,
      action: () => void saveActive(),
    },
    { separator: true },
    {
      label: store.settings.showSidebar ? "隐藏侧边栏" : "显示侧边栏",
      shortcut: "Ctrl+B",
      action: () => (store.settings.showSidebar = !store.settings.showSidebar),
    },
    { label: "设置", shortcut: "Ctrl+,", action: () => (store.showSettings = true) },
  ]);
}

/** 屏蔽 WebView 自带的右键菜单，改用应用自己的。 */
function blockNativeMenu(event: Event) {
  event.preventDefault();
}

const rootStyle = computed(() => ({
  "--editor-max-width": store.settings.editorWidth > 0 ? `${store.settings.editorWidth}px` : "780px",
}));

function nextTab(delta: number) {
  const tabs = store.tabs;
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.path === store.activePath);
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next) store.activePath = next.path;
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return; // 编辑器已经处理过的组合键不再重复响应
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();

  switch (key) {
    case "s":
      event.preventDefault();
      void saveActive();
      break;
    case "p":
      event.preventDefault();
      openQuickSwitcher();
      break;
    case "n":
      event.preventDefault();
      void createNote("");
      break;
    case "e":
      event.preventDefault();
      cycleViewMode();
      break;
    case "b":
      event.preventDefault();
      store.settings.showSidebar = !store.settings.showSidebar;
      break;
    case "w":
      event.preventDefault();
      if (store.activePath) closeTab(store.activePath);
      break;
    case "o":
      if (event.shiftKey) {
        event.preventDefault();
        void pickVault();
      }
      break;
    case "f":
      if (event.shiftKey) {
        event.preventDefault();
        store.settings.showSidebar = true;
        store.sidebarTab = "search";
      }
      break;
    case "tab":
      event.preventDefault();
      nextTab(event.shiftKey ? -1 : 1);
      break;
    case ",":
      event.preventDefault();
      store.showSettings = true;
      break;
  }
}

function startSidebarResize(event: MouseEvent) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = store.settings.sidebarWidth;
  const onMove = (move: MouseEvent) => {
    const width = startWidth + move.clientX - startX;
    store.settings.sidebarWidth = Math.max(180, Math.min(560, width));
  };
  const onUp = () => {
    document.body.classList.remove("resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  document.body.classList.add("resizing");
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

watch(
  () => [store.vault?.name, activeTab.value?.title, activeTab.value?.dirty],
  () => {
    const parts: string[] = [];
    if (activeTab.value) parts.push(activeTab.value.dirty ? `• ${activeTab.value.title}` : activeTab.value.title);
    if (store.vault) parts.push(store.vault.name);
    document.title = parts.length ? `${parts.join(" — ")} · Highland Note` : "Highland Note";
  },
);

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("contextmenu", blockNativeMenu, { capture: true });
  void init();
  void syncMaximized();
  void appWindow
    .onResized(() => void syncMaximized())
    .then((unlisten) => {
      unlistenResize = unlisten;
    })
    .catch(() => undefined);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("contextmenu", blockNativeMenu, { capture: true });
  unlistenResize?.();
});
</script>

<template>
  <div class="app" :style="rootStyle" @contextmenu="appMenu">
    <header class="topbar" data-tauri-drag-region="deep">
      <button
        class="icon-button"
        title="切换侧边栏 (Ctrl+B)"
        @click="store.settings.showSidebar = !store.settings.showSidebar"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>

      <div class="app-identity">
        <svg
          class="app-logo"
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linejoin="round"
        >
          <path d="M2.5 19.5 9 8l4 6.5L15.5 11l6 8.5z" />
        </svg>
        <span class="app-title">Highland Note</span>
        <span v-if="store.vault" class="vault-name" :title="store.vault.path">
          {{ store.vault.name }}
        </span>
      </div>

      <button class="icon-button" title="快速跳转 (Ctrl+P)" @click="openQuickSwitcher">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span class="button-label">跳转</span>
      </button>
      <button class="icon-button" title="新建笔记 (Ctrl+N)" @click="createNote('')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M12 11v6M9 14h6" />
        </svg>
      </button>
      <button class="icon-button" title="保存 (Ctrl+S)" @click="saveActive">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 3h11l3 3v15H5z" />
          <path d="M8 3v6h7V3M8 15h8" />
        </svg>
      </button>

      <span class="spacer" />

      <div class="segmented">
        <button :class="{ active: store.settings.viewMode === 'edit' }" title="仅编辑 (Ctrl+E)" @click="store.settings.viewMode = 'edit'">
          编辑
        </button>
        <button :class="{ active: store.settings.viewMode === 'split' }" title="分栏 (Ctrl+E)" @click="store.settings.viewMode = 'split'">
          分栏
        </button>
        <button :class="{ active: store.settings.viewMode === 'preview' }" title="仅预览 (Ctrl+E)" @click="store.settings.viewMode = 'preview'">
          预览
        </button>
      </div>

      <button
        class="icon-button"
        :title="store.settings.theme === 'dark' ? '切换到浅色' : '切换到深色'"
        @click="setTheme(store.settings.theme === 'dark' ? 'light' : 'dark')"
      >
        <svg v-if="store.settings.theme === 'dark'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
        </svg>
      </button>
      <button class="icon-button" title="设置" @click="store.showSettings = true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9.5 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4z" />
        </svg>
      </button>

      <div class="window-controls">
        <button class="window-button" title="最小化" @click="minimizeWindow">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 5h10" stroke="currentColor" stroke-width="1.1" />
          </svg>
        </button>
        <button
          class="window-button"
          :title="isMaximized ? '向下还原' : '最大化'"
          @click="toggleMaximizeWindow"
        >
          <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1.4" stroke="currentColor" stroke-width="1.1" />
          </svg>
          <svg v-else width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.6" y="2.6" width="6.8" height="6.8" rx="1.2" stroke="currentColor" stroke-width="1.1" />
            <path d="M2.9 2.6V1.4A0.8 0.8 0 0 1 3.7 0.6h4.9a0.8 0.8 0 0 1 0.8 0.8v4.9a0.8 0.8 0 0 1-0.8 0.8H7.4" stroke="currentColor" stroke-width="1.1" />
          </svg>
        </button>
        <button class="window-button close" title="关闭" @click="closeWindow">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0.7 0.7 9.3 9.3M9.3 0.7 0.7 9.3" stroke="currentColor" stroke-width="1.1" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 自绘边框后系统不提供边缘缩放，这八个热区负责窗口缩放 -->
    <template v-if="!isMaximized">
      <div class="resize-handle north" @mousedown="startWindowResize('North', $event)" />
      <div class="resize-handle south" @mousedown="startWindowResize('South', $event)" />
      <div class="resize-handle west" @mousedown="startWindowResize('West', $event)" />
      <div class="resize-handle east" @mousedown="startWindowResize('East', $event)" />
      <div class="resize-handle north-west" @mousedown="startWindowResize('NorthWest', $event)" />
      <div class="resize-handle north-east" @mousedown="startWindowResize('NorthEast', $event)" />
      <div class="resize-handle south-west" @mousedown="startWindowResize('SouthWest', $event)" />
      <div class="resize-handle south-east" @mousedown="startWindowResize('SouthEast', $event)" />
    </template>

    <div class="main">
      <SideBar v-if="store.vault && store.settings.showSidebar" />
      <div v-if="store.vault && store.settings.showSidebar" class="splitter" @mousedown="startSidebarResize" />

      <section class="workspace">
        <TabBar v-if="store.tabs.length" />

        <div ref="panesRef" class="panes">
          <EditorPane v-if="store.vault && activeTab" v-show="showEditor" :style="editorPaneStyle" />
          <div
            v-if="isSplit"
            class="pane-splitter"
            title="拖动调整分栏宽度，双击恢复均分"
            @mousedown="startPaneResize"
            @dblclick="resetSplitRatio"
          />
          <PreviewPane v-if="activeTab && showPreview" :style="previewPaneStyle" />

          <div v-if="!activeTab" class="empty-state">
            <template v-if="store.vault">
              <div>还没有打开的笔记</div>
              <div>
                按 <kbd>Ctrl</kbd> + <kbd>N</kbd> 新建，或按 <kbd>Ctrl</kbd> + <kbd>P</kbd> 跳转
              </div>
            </template>
          </div>
        </div>

        <StatusBar />
      </section>
    </div>

    <WelcomeScreen v-if="!store.vault" />
    <QuickSwitcher v-if="store.quickSwitcher" />
    <SettingsPanel v-if="store.showSettings" />
    <ModalHost />
    <ContextMenu v-if="store.menu" />

    <div v-if="store.toast" class="toast">{{ store.toast }}</div>
  </div>
</template>
