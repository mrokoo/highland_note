import { computed, reactive, watch } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  folderOf,
  titleOf,
  type FileNode,
  type LinkReport,
  type NoteMeta,
  type SearchHit,
  type Settings,
  type VaultInfo,
  type ViewMode,
} from "./api";

export interface Tab {
  path: string;
  title: string;
  /** 编辑器中的当前内容 */
  content: string;
  /** 最后一次落盘的内容 */
  savedContent: string;
  mtime: number;
  dirty: boolean;
  error: string;
}

export interface PromptState {
  title: string;
  label: string;
  value: string;
  confirmText: string;
  resolve: (value: string | null) => void;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
  resolve: (value: boolean) => void;
}

/** 自定义右键菜单里的一项。 */
export interface MenuItem {
  label?: string;
  shortcut?: string;
  /** 分隔线：只填这一个字段即可 */
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
  action?: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** 列表面板有哪几页，对应最左侧工具栏的图标。 */
export type SidebarTab = "files" | "search" | "outline";

const defaultSettings: Settings = {
  recentVaults: [],
  lastVault: null,
  theme: "dark",
  viewMode: "split",
  fontSize: 16,
  sidebarWidth: 268,
  showSidebar: true,
  showLineNumbers: true,
  showRightPanel: false,
  rightPanelWidth: 300,
  editorWidth: 0,
  splitRatio: 0.5,
};

/** 分栏比例的允许范围，避免某一侧被拖到完全看不见。 */
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

export function setSplitRatio(ratio: number) {
  store.settings.splitRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export const store = reactive({
  ready: false,
  vault: null as VaultInfo | null,
  tree: [] as FileNode[],
  notes: [] as NoteMeta[],
  tabs: [] as Tab[],
  activePath: null as string | null,
  expanded: {} as Record<string, boolean>,
  settings: { ...defaultSettings } as Settings,
  treeLoading: false,
  loadingNote: false,
  searchQuery: "",
  searchHits: [] as SearchHit[],
  searching: false,
  sidebarTab: "files" as SidebarTab,
  cursor: { line: 1, col: 1, selected: 0 },
  toast: "",
  prompt: null as PromptState | null,
  confirm: null as ConfirmState | null,
  /** 当前打开的自定义右键菜单 */
  menu: null as MenuState | null,
  /** 当前笔记的出链与反向链接 */
  links: null as LinkReport | null,
  linksLoading: false,
  quickSwitcher: false,
  quickQuery: "",
  quickIndex: 0,
  /** 让编辑器跳到指定行 */
  scrollToLine: null as number | null,
  /** 该标签页的内容被外部改动，编辑器需要重建状态 */
  reloadPath: "",
  reloadTick: 0,
  showSettings: false,
});

let toastTimer: number | undefined;

export const activeTab = computed<Tab | null>(
  () => store.tabs.find((t) => t.path === store.activePath) ?? null,
);

export const quickResults = computed<NoteMeta[]>(() => {
  const q = store.quickQuery.trim().toLowerCase();
  if (!q) return store.notes.slice(0, 80);
  return store.notes
    .filter((n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
    .slice(0, 80);
});

export function toast(message: string, ms = 2600) {
  store.toast = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (store.toast = ""), ms);
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ------------------------------------------------------------------ 弹窗

export function askText(
  title: string,
  value = "",
  label = "",
  confirmText = "确定",
): Promise<string | null> {
  return new Promise((resolve) => {
    store.prompt = { title, label, value, confirmText, resolve };
  });
}

export function resolvePrompt(value: string | null) {
  const pending = store.prompt;
  store.prompt = null;
  pending?.resolve(value);
}

export function askConfirm(
  title: string,
  message: string,
  confirmText = "确定",
  danger = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    store.confirm = { title, message, confirmText, danger, resolve };
  });
}

export function resolveConfirm(value: boolean) {
  const pending = store.confirm;
  store.confirm = null;
  pending?.resolve(value);
}

// ------------------------------------------------------------------ 右键菜单

/**
 * 打开自定义右键菜单。会顺手拦掉浏览器/WebView 的原生菜单，
 * 并阻止事件继续冒泡，避免上层再弹一个菜单。
 */
export function openMenu(event: MouseEvent, items: MenuItem[]) {
  event.preventDefault();
  event.stopPropagation();
  const usable = items.filter((item) => item.separator || item.label);
  if (!usable.some((item) => !item.separator)) return;
  store.menu = { x: event.clientX, y: event.clientY, items: usable };
}

export function closeMenu() {
  store.menu = null;
}

export function runMenuItem(item: MenuItem) {
  store.menu = null;
  if (item.separator || item.disabled || !item.action) return;
  item.action();
}

// ------------------------------------------------------------------ 主题与设置

export function applyTheme() {
  document.documentElement.dataset.theme = store.settings.theme;
}

export function setTheme(theme: "dark" | "light") {
  store.settings.theme = theme;
  applyTheme();
}

export function setViewMode(mode: ViewMode) {
  store.settings.viewMode = mode;
}

export function cycleViewMode() {
  const order: ViewMode[] = ["edit", "split", "preview"];
  const idx = order.indexOf(store.settings.viewMode);
  setViewMode(order[(idx + 1) % order.length]);
}

watch(
  () => store.settings,
  () => {
    void api
      .saveSettings(JSON.parse(JSON.stringify(store.settings)) as Settings)
      .catch(() => undefined);
  },
  { deep: true },
);

// ------------------------------------------------------------------ 仓库

export async function refreshTree() {
  if (!store.vault) return;
  store.treeLoading = true;
  try {
    store.tree = await api.listTree();
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    store.treeLoading = false;
  }
}

export async function refreshNotes() {
  if (!store.vault) return;
  try {
    store.notes = await api.listNotes();
  } catch {
    /* 索引失败不影响编辑 */
  }
}

export async function openVault(path: string) {
  try {
    const info = await api.openVault(path);
    store.vault = info;
    store.tabs = [];
    store.activePath = null;
    store.expanded = {};
    store.searchHits = [];
    store.searchQuery = "";
    store.sidebarTab = "files";
    await Promise.all([refreshTree(), refreshNotes()]);
  } catch (error) {
    toast(errorMessage(error));
  }
}

export async function pickVault() {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: "选择笔记仓库文件夹",
  });
  if (typeof selected === "string") await openVault(selected);
}

export async function closeVault() {
  for (const tab of store.tabs) {
    if (tab.dirty) await saveTab(tab, true);
  }
  try {
    await api.closeVault();
  } catch {
    /* 忽略 */
  }
  store.vault = null;
  store.tabs = [];
  store.activePath = null;
  store.tree = [];
  store.notes = [];
}

export async function forgetVault(path: string) {
  store.settings.recentVaults = store.settings.recentVaults.filter((p) => p !== path);
  if (!store.settings.recentVaults.length) store.settings.lastVault = null;
}

// ------------------------------------------------------------------ 标签页

export function activateTab(path: string) {
  store.activePath = path;
}

export function toggleFolder(path: string) {
  store.expanded[path] = !store.expanded[path];
}

/** 展开某个笔记所在的所有父级目录。 */
export function revealInTree(path: string) {
  const parts = path.split("/");
  parts.pop();
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    store.expanded[acc] = true;
  }
}

export async function openNote(path: string, line?: number) {
  const existing = store.tabs.find((t) => t.path === path);
  if (existing) {
    store.activePath = path;
    revealInTree(path);
    if (line) store.scrollToLine = line;
    return;
  }
  store.loadingNote = true;
  try {
    const note = await api.readNote(path);
    store.tabs.push({
      path: note.path,
      title: titleOf(note.path),
      content: note.content,
      savedContent: note.content,
      mtime: note.mtime,
      dirty: false,
      error: "",
    });
    store.activePath = note.path;
    revealInTree(note.path);
    if (line) store.scrollToLine = line;
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    store.loadingNote = false;
  }
}

export function closeTab(path: string) {
  const index = store.tabs.findIndex((t) => t.path === path);
  if (index < 0) return;
  const tab = store.tabs[index];
  if (tab.dirty) void saveTab(tab, true);
  store.tabs.splice(index, 1);
  if (store.activePath === path) {
    const next = store.tabs[index] ?? store.tabs[index - 1] ?? null;
    store.activePath = next ? next.path : null;
  }
}

export function closeOtherTabs(path: string) {
  for (const tab of store.tabs) {
    if (tab.path !== path && tab.dirty) void saveTab(tab, true);
  }
  store.tabs = store.tabs.filter((t) => t.path === path);
  store.activePath = path;
}

export function closeAllTabs() {
  for (const tab of store.tabs) {
    if (tab.dirty) void saveTab(tab, true);
  }
  store.tabs = [];
  store.activePath = null;
}

/** 重命名／移动后同步已打开标签页的路径。 */
function remapTabs(from: string, to: string) {
  for (const tab of store.tabs) {
    if (tab.path === from) {
      tab.path = to;
      tab.title = titleOf(to);
    } else if (tab.path.startsWith(`${from}/`)) {
      tab.path = to + tab.path.slice(from.length);
      tab.title = titleOf(tab.path);
    }
  }
  if (store.activePath === from) store.activePath = to;
  else if (store.activePath?.startsWith(`${from}/`)) {
    store.activePath = to + store.activePath.slice(from.length);
  }
}

function closeTabsUnder(path: string) {
  const affected = store.tabs.filter((t) => t.path === path || t.path.startsWith(`${path}/`));
  for (const tab of affected) closeTab(tab.path);
}

// ------------------------------------------------------------------ 编辑与保存

const saveTimers = new Map<string, number>();

export function scheduleSave(path: string, delay = 600) {
  const running = saveTimers.get(path);
  if (running) clearTimeout(running);
  saveTimers.set(
    path,
    setTimeout(() => {
      saveTimers.delete(path);
      const tab = store.tabs.find((t) => t.path === path);
      if (tab) void saveTab(tab);
    }, delay),
  );
}

export function updateActiveContent(text: string) {
  const tab = activeTab.value;
  if (!tab || tab.content === text) return;
  tab.content = text;
  tab.dirty = tab.content !== tab.savedContent;
  if (tab.dirty) scheduleSave(tab.path);
}

export async function saveTab(tab: Tab, force = false) {
  if (!tab.dirty && !force) return;
  const running = saveTimers.get(tab.path);
  if (running) {
    clearTimeout(running);
    saveTimers.delete(tab.path);
  }
  try {
    const mtime = await api.writeNote(tab.path, tab.content, force ? null : tab.mtime);
    tab.mtime = mtime;
    tab.savedContent = tab.content;
    tab.dirty = false;
    tab.error = "";
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith("CONFLICT::")) {
      const diskMtime = Number(message.slice("CONFLICT::".length)) || tab.mtime;
      const overwrite = await askConfirm(
        "文件已被外部修改",
        `「${tab.title}」在磁盘上被其他程序改动过。要用当前内容覆盖它吗？`,
        "覆盖",
        true,
      );
      if (overwrite) {
        tab.mtime = diskMtime;
        await saveTab(tab, true);
      } else {
        await reloadTab(tab);
      }
    } else {
      tab.error = message;
      toast(message);
    }
  }
}

export async function saveActive() {
  const tab = activeTab.value;
  if (tab) await saveTab(tab, true);
}

/** 从磁盘重新载入，丢弃编辑器中的改动。 */
export async function reloadTab(tab: Tab) {
  try {
    const note = await api.readNote(tab.path);
    tab.content = note.content;
    tab.savedContent = note.content;
    tab.mtime = note.mtime;
    tab.dirty = false;
    tab.error = "";
    store.reloadPath = tab.path;
    store.reloadTick += 1;
  } catch (error) {
    toast(errorMessage(error));
  }
}

export async function reloadActive() {
  const tab = activeTab.value;
  if (!tab) return;
  const ok = await askConfirm(
    "重新载入",
    `将丢弃「${tab.title}」中未保存的修改并从磁盘重新读取，继续吗？`,
    "重新载入",
    true,
  );
  if (ok) await reloadTab(tab);
}

// ------------------------------------------------------------------ 文件操作

export async function createNote(parent = "", presetName = "") {
  const name = presetName || (await askText("新建笔记", "未命名笔记", "笔记名称", "创建"));
  if (!name) return;
  try {
    const path = await api.createNote(parent, name);
    await Promise.all([refreshTree(), refreshNotes()]);
    await openNote(path);
  } catch (error) {
    toast(errorMessage(error));
  }
}

export async function createFolder(parent = "") {
  const name = await askText("新建文件夹", "新文件夹", "文件夹名称", "创建");
  if (!name) return;
  try {
    await api.createFolder(parent, name);
    await refreshTree();
    if (parent) store.expanded[parent] = true;
  } catch (error) {
    toast(errorMessage(error));
  }
}

export async function renameEntry(path: string) {
  const current = path.split("/").pop() ?? path;
  const isNote = /\.(md|markdown)$/i.test(current);
  const initial = isNote ? titleOf(path) : current;
  const name = await askText("重命名", initial, "新名称");
  if (!name || name === initial) return;
  try {
    const newPath = await api.renameEntry(path, name);
    remapTabs(path, newPath);
    await Promise.all([refreshTree(), refreshNotes()]);
  } catch (error) {
    toast(errorMessage(error));
  }
}

export async function deleteEntry(path: string) {
  const ok = await askConfirm(
    "删除",
    `确定删除「${path.split("/").pop()}」吗？文件会被移到系统回收站。`,
    "删除",
    true,
  );
  if (!ok) return;
  try {
    await api.deleteEntry(path);
    closeTabsUnder(path);
    await Promise.all([refreshTree(), refreshNotes()]);
  } catch (error) {
    toast(errorMessage(error));
  }
}

export async function moveEntry(path: string, newParent: string) {
  if (folderOf(path) === newParent) return;
  if (newParent && (newParent === path || newParent.startsWith(`${path}/`))) {
    toast("不能移动到自身内部");
    return;
  }
  try {
    const newPath = await api.moveEntry(path, newParent);
    remapTabs(path, newPath);
    await Promise.all([refreshTree(), refreshNotes()]);
  } catch (error) {
    toast(errorMessage(error));
  }
}

// ------------------------------------------------------------------ 双链

export function findNoteByTitle(title: string): NoteMeta | undefined {
  const needle = title.trim().replace(/\.(md|markdown)$/i, "").toLowerCase();
  if (!needle) return undefined;
  return (
    store.notes.find((n) => n.title.toLowerCase() === needle) ??
    store.notes.find((n) => n.path.toLowerCase().replace(/\.(md|markdown)$/i, "") === needle)
  );
}

export async function openWikilink(target: string) {
  const note = findNoteByTitle(target);
  if (note) {
    await openNote(note.path);
    return;
  }
  const name = target.trim();
  if (!name) return;
  if (/[\\/:*?"<>|]/.test(name)) {
    toast(`「${name}」不是有效的笔记名`);
    return;
  }
  const ok = await askConfirm("新建笔记", `「${name}」尚不存在，现在创建吗？`, "创建");
  if (!ok) return;
  try {
    const path = await api.createNote("", name);
    await Promise.all([refreshTree(), refreshNotes()]);
    await openNote(path);
  } catch (error) {
    toast(errorMessage(error));
  }
}

// ------------------------------------------------------------------ 搜索

let searchTimer: number | undefined;

export function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(), 220);
}

export async function runSearch() {
  if (!store.vault) return;
  const query = store.searchQuery.trim();
  if (!query) {
    store.searchHits = [];
    return;
  }
  store.searching = true;
  try {
    store.searchHits = await api.searchNotes(query);
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    store.searching = false;
  }
}

// ------------------------------------------------------------------ 链接与反链

let linksTimer: number | undefined;

/** 重新计算当前笔记的出链与反链（Rust 侧按 mtime 增量扫描，开销不大）。 */
export async function refreshLinks() {
  if (linksTimer) {
    clearTimeout(linksTimer);
    linksTimer = undefined;
  }
  const tab = activeTab.value;
  if (!tab || !store.vault) {
    store.links = null;
    return;
  }
  store.linksLoading = true;
  try {
    store.links = await api.linkReport(tab.path);
  } catch {
    store.links = null;
  } finally {
    store.linksLoading = false;
  }
}

/** 编辑过程中的刷新做防抖，别每敲一个字就重算一次。 */
export function scheduleLinksRefresh(delay = 700) {
  if (!store.settings.showRightPanel) return;
  if (linksTimer) clearTimeout(linksTimer);
  linksTimer = setTimeout(() => void refreshLinks(), delay);
}

// ------------------------------------------------------------------ 快速切换

export function openQuickSwitcher() {
  if (!store.vault) return;
  store.quickQuery = "";
  store.quickIndex = 0;
  store.quickSwitcher = true;
}

export function closeQuickSwitcher() {
  store.quickSwitcher = false;
}

// ------------------------------------------------------------------ 启动

export async function init() {
  try {
    const loaded = await api.getSettings();
    store.settings = { ...defaultSettings, ...loaded };
  } catch {
    /* 首次运行没有配置文件 */
  }
  applyTheme();
  store.ready = true;

  const last = store.settings.lastVault;
  if (last) {
    try {
      if (await api.pathIsDir(last)) await openVault(last);
    } catch {
      /* 仓库已被移动或删除，安静地回到欢迎页 */
    }
  }
}

export { folderOf, titleOf };
