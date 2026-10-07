import { computed, reactive, watch } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  folderOf,
  titleOf,
  type Card,
  type CardSummary,
  type FileNode,
  type LinkReport,
  type NewCard,
  type NoteMeta,
  type DueCard,
  type NoteStatus,
  type ReviewStats,
  type SearchHit,
  type Settings,
  type VaultInfo,
  type ViewMode,
  type WorkflowNote,
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

/**
 * 造卡弹窗的初始内容：**就是编辑器里选中的那些块**。
 *
 * 快照在这里就固定下来（`text` / `heading` / `line`），后面正文怎么改都不影响这张卡。
 */
export interface CardCompose {
  /** 选中的块原文，多行时按行拼接 */
  text: string;
  /** 所在小节 */
  heading: string;
  /** 选区起始行（1 起） */
  line: number;
  /** 预填的问题 */
  question: string;
}

/** 造卡弹窗的可变状态。 */
export interface CardDialogState extends CardCompose {
  path: string;
  title: string;
  angle: string;
  answer: string;
  /** 答案是否仍然跟随块原文（用户一动答案就关掉） */
  followSource: boolean;
  saving: boolean;
  /** 选区里除第一块之外的其余块（勾上就一起建卡） */
  extras: CardCompose[];
  /** 这些块也一起建卡 */
  withExtras: boolean;
}

/** 卡片面板的状态筛选。 */
export type CardFilter = "all" | "new" | "due" | "learning" | "review";

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
  // ---- 工作流（P0）
  /** 看板数据：全部笔记 + 状态 + 块/卡计数 */
  workflow: [] as WorkflowNote[],
  workflowLoading: false,
  workflowSyncedAt: 0,
  /** 工作台（今日 + 三列看板）是否占据主区域 */
  showWorkbench: false,
  /** 快速捕获浮层 */
  captureOpen: false,
  // ---- 复习（P1）
  showReview: false,
  reviewQueue: [] as DueCard[],
  reviewIndex: 0,
  reviewRevealed: false,
  reviewStats: null as ReviewStats | null,
  reviewAnswering: false,
  /** 当前复习范围：null = 全部，否则是某一篇笔记的路径 */
  reviewScope: null as string | null,
  /** 每篇笔记的到期数量：path → { due, total } */
  noteDue: {} as Record<string, { due: number; total: number }>,
  // ---- 卡片（选中块 → 建卡 → 右侧面板）
  /** 当前笔记的卡片 */
  cards: [] as Card[],
  cardsLoading: false,
  /** 当前笔记的卡片小结（新学 / 到期 / 学习中 / 复习中 / 总数） */
  cardSummary: null as CardSummary | null,
  /** 全仓库的卡片计数（左侧「复习」徽标） */
  cardCounts: null as CardSummary | null,
  cardFilter: "all" as CardFilter,
  /** 造卡弹窗；null = 关着 */
  cardDialog: null as CardDialogState | null,
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

// ------------------------------------------------------------------ 工作流

/** 本地日期与时间，收件箱按天分文件用得上。 */
function localStamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

/**
 * 同步索引并刷新看板数据。
 * 默认带 2 秒节流，避免来回切视图时反复扫仓库；`force` 用于拖动改状态之后。
 */
export async function refreshWorkflow(force = false) {
  if (!store.vault) return;
  if (!force && Date.now() - store.workflowSyncedAt < 2000) return;
  store.workflowLoading = true;
  try {
    await api.syncWorkflow();
    store.workflow = await api.listWorkflow();
    store.workflowSyncedAt = Date.now();
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    store.workflowLoading = false;
  }
}

/** 改一篇笔记的状态（写回 frontmatter）。 */
export async function setNoteStatus(path: string, status: NoteStatus) {
  try {
    await api.setNoteStatus(path, status);
    const row = store.workflow.find((note) => note.path === path);
    if (row) row.status = status;
    else await refreshWorkflow(true);
  } catch (error) {
    toast(errorMessage(error));
  }
}

/** 快速捕获：追加到当天的收件箱，然后让文件树把新文件接进来。返回落点路径。 */
export async function capture(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  const { date, time } = localStamp();
  try {
    const path = await api.appendInbox(date, time, text.trim());
    await Promise.all([refreshTree(), refreshNotes(), refreshWorkflow(true)]);
    toast(`已收进 ${path}`);
    return path;
  } catch (error) {
    toast(errorMessage(error));
    return null;
  }
}

/** 导入材料：选一个文件 → 附件复制进仓库 → 生成材料卡。 */
export async function importMaterial() {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    title: "选择要收进仓库的材料",
    filters: [
      { name: "材料", extensions: ["mp3", "m4a", "wav", "flac", "mp4", "mkv", "mov", "pdf", "epub", "png", "jpg", "jpeg", "webp", "txt"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (typeof picked !== "string") return;
  const { date } = localStamp();
  try {
    const path = await api.importMaterial(picked, date);
    await Promise.all([refreshTree(), refreshNotes(), refreshWorkflow(true)]);
    await openNote(path);
    toast("材料已收进 00-输入/材料");
  } catch (error) {
    toast(errorMessage(error));
  }
}

// ------------------------------------------------------------------ 复习（P1）

const currentReviewCard = computed<DueCard | null>(
  () => store.reviewQueue[store.reviewIndex] ?? null,
);

export { currentReviewCard };

/** 刷新复习概况（侧栏徽标用）。 */
export async function refreshReviewStats() {
  if (!store.vault) return;
  try {
    const today = localStamp().date;
    store.reviewStats = await api.reviewStats(today);
    // 徽标与右栏小结用的都是"库里到底有多少张卡"，所以顺手一起刷
    store.cardCounts = await api.cardCounts(today);
    const perNote = await api.dueByNote(today);
    const map: Record<string, { due: number; total: number }> = {};
    for (const row of perNote) map[row.path] = { due: row.due, total: row.total };
    store.noteDue = map;
  } catch {
    /* 库还没建好时忽略 */
  }
}

// ------------------------------------------------------------------ 卡片（选中块 → 建卡）

/** 卡片面板现在该显示哪些卡。 */
export const visibleCards = computed<Card[]>(() => {
  switch (store.cardFilter) {
    case "new":
      return store.cards.filter((card) => card.state === "new");
    case "due":
      return store.cards.filter((card) => card.dueNow);
    case "learning":
      return store.cards.filter((card) => card.state === "learning" || card.state === "relearning");
    case "review":
      return store.cards.filter((card) => card.state === "review");
    default:
      return store.cards;
  }
});

export function setCardFilter(filter: CardFilter) {
  store.cardFilter = filter;
}

/** 刷新当前笔记的卡片与小结（建卡、删卡、复习之后都要叫一次）。 */
export async function refreshCards() {
  const path = store.activePath;
  if (!store.vault || !path) {
    store.cards = [];
    store.cardSummary = null;
    return;
  }
  store.cardsLoading = true;
  try {
    const today = localStamp().date;
    const [cards, summary] = await Promise.all([
      api.listCards(path, today),
      api.cardSummary(path, today),
    ]);
    store.cards = cards;
    store.cardSummary = summary;
  } catch {
    store.cards = [];
    store.cardSummary = null;
  } finally {
    store.cardsLoading = false;
  }
}

/** 打开造卡弹窗（内容来自编辑器里的选区）。 */
export function openCardDialog(blocks: CardCompose[]) {
  const path = store.activePath;
  const first = blocks[0];
  if (!path || !first) return;
  store.cardDialog = {
    ...first,
    path,
    title: titleOf(path),
    angle: "回忆",
    // 答案默认永远是块原文：卡片只是"探询的角度"，知识本体还是那句话
    answer: first.text,
    followSource: true,
    saving: false,
    extras: blocks.slice(1),
    withExtras: false,
  };
}

export function closeCardDialog() {
  store.cardDialog = null;
}

/** 用户改了答案 → 不再跟随块原文。 */
export function setCardAnswer(value: string) {
  const dialog = store.cardDialog;
  if (!dialog) return;
  dialog.answer = value;
  dialog.followSource = value.trim() === dialog.text.trim();
}

/** 把答案拉回块原文。 */
export function resetCardAnswer() {
  const dialog = store.cardDialog;
  if (!dialog) return;
  dialog.answer = dialog.text;
  dialog.followSource = true;
}

/**
 * 建一条（或多条）卡片。
 *
 * 答案留空时由 Rust 侧取块原文——"答案默认是块原文"这条产品规则只写在一处。
 */
export async function createCardFromBlocks(
  blocks: CardCompose[],
  options: { angle: string; answer: string; followSource: boolean },
): Promise<number> {
  if (!blocks.length || !store.activePath) return 0;
  const today = localStamp().date;
  let created = 0;
  let duplicate = 0;
  for (const block of blocks) {
    const card: NewCard = {
      path: store.activePath,
      kind: "qa",
      question: block.question.trim(),
      answer: options.followSource ? "" : options.answer.trim(),
      angle: options.angle.trim(),
      sourceText: block.text,
      sourceHeading: block.heading,
      sourceLine: block.line,
    };
    try {
      const saved = await api.createCard(card, today);
      if (saved.created) created += 1;
      else duplicate += 1;
    } catch (error) {
      toast(errorMessage(error));
      break;
    }
  }
  if (duplicate && !created) toast("这些块已经有同样的卡了");
  else if (created) toast(`已建 ${created} 张卡${duplicate ? `，${duplicate} 张已存在` : ""}`);
  await Promise.all([refreshCards(), refreshReviewStats(), refreshWorkflow(true)]);
  return created;
}

/** 单块建卡：造卡弹窗的「添加」按钮。 */
export async function saveCardDialog() {
  const dialog = store.cardDialog;
  if (!dialog || dialog.saving) return;
  if (!dialog.question.trim()) {
    toast("先写一个问题——卡片就是对这个块的探询");
    return;
  }
  dialog.saving = true;
  const blocks: CardCompose[] = [{ ...dialog }];
  if (dialog.withExtras) blocks.push(...dialog.extras);
  try {
    await createCardFromBlocks(blocks, {
      angle: dialog.angle,
      answer: dialog.answer,
      followSource: dialog.followSource,
    });
    store.cardDialog = null;
  } finally {
    if (store.cardDialog) store.cardDialog.saving = false;
  }
}

/**
 * 快速造卡：不弹窗，问题直接用草稿。
 *
 * 这是最常用的那条路——选中一句话、按一下键，卡就建好了；想改问法再走弹窗。
 */
export async function quickCreateCards(blocks: CardCompose[], angle = "回忆") {
  if (!blocks.length) return 0;
  return createCardFromBlocks(blocks, { angle, answer: "", followSource: true });
}

/** 删卡：只删卡片行，正文一个字都不动。 */
export async function removeCard(card: Card) {
  const ok = await askConfirm(
    "删除卡片",
    `确定删掉「${card.question}」吗？笔记正文不会动，复习进度会一起没掉。`,
    "删除",
    true,
  );
  if (!ok) return;
  try {
    await api.deleteCard(card.id);
    await Promise.all([refreshCards(), refreshReviewStats(), refreshWorkflow(true)]);
  } catch (error) {
    toast(errorMessage(error));
  }
}

/** 复习某一篇笔记的卡片（工作台上的入口）。 */
export function reviewNote(path: string) {
  void startReview(path);
}

/**
 * 开始复习。`notePath` 不为空时只复习那一篇笔记——
 * 卡片挂在块上、块属于笔记，所以"按笔记复习"是天然的，而不是硬凑的分组。
 */
export async function startReview(notePath?: string) {
  if (!store.vault) return;
  store.reviewQueue = [];
  store.reviewIndex = 0;
  store.reviewRevealed = false;
  try {
    store.reviewQueue = await api.dueCards(localStamp().date, undefined, notePath ?? null);
    store.reviewScope = notePath ?? null;
    store.reviewIndex = 0;
    store.showReview = true;
    store.showWorkbench = false;
  } catch (error) {
    toast(errorMessage(error));
  }
}

export function revealAnswer() {
  store.reviewRevealed = true;
}

export function closeReview() {
  store.showReview = false;
  void refreshReviewStats();
  void refreshWorkflow(true);
}

/** 评分并前进；打「重来」的卡排到本轮末尾再出现一次。 */
export async function gradeCurrent(rating: 1 | 2 | 3 | 4) {
  const card = currentReviewCard.value;
  if (!card || store.reviewAnswering) return;
  store.reviewAnswering = true;
  try {
    await api.gradeCard(card.id, rating, localStamp().date);
    if (rating === 1) {
      store.reviewQueue.push(card);
    }
    store.reviewIndex += 1;
    store.reviewRevealed = false;
    if (store.reviewIndex >= store.reviewQueue.length) closeReview();
    else void refreshReviewStats();
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    store.reviewAnswering = false;
  }
}

/** 撤销最近一次评分（回到上一张）。 */
export async function undoGrade() {
  const card = currentReviewCard.value;
  if (!card) return;
  try {
    await api.undoGrade(card.id);
    store.reviewRevealed = false;
  } catch (error) {
    toast(errorMessage(error));
  }
}

/** 切换笔记时自动跟上卡片数据（面板没开就不白读一遍库）。 */
function watchActiveNote() {
  watch(
    () => store.activePath,
    () => {
      if (store.settings.showRightPanel) void refreshCards();
      else {
        store.cards = [];
        store.cardSummary = null;
      }
    },
  );
}

watchActiveNote();

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
  // 不管从哪儿打开的，都切回编辑器视图（工作台只是"一屏概览"）
  store.showWorkbench = false;
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
