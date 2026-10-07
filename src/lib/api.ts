import { invoke } from "@tauri-apps/api/core";

export interface VaultInfo {
  path: string;
  name: string;
}

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  mtime: number;
  size: number;
  children?: FileNode[];
}

export interface NoteContent {
  path: string;
  content: string;
  mtime: number;
}

export interface NoteMeta {
  path: string;
  title: string;
  folder: string;
  mtime: number;
}

export interface SearchHit {
  path: string;
  title: string;
  line: number;
  text: string;
}

/** 一条双链：出链或反向链接。 */
export interface LinkRef {
  path: string;
  title: string;
  target: string;
  alias: string;
  line: number;
  context: string;
  resolved: boolean;
  targetPath: string | null;
}

export interface LinkReport {
  outgoing: LinkRef[];
  backlinks: LinkRef[];
}

export interface Settings {
  recentVaults: string[];
  lastVault: string | null;
  theme: "dark" | "light";
  viewMode: ViewMode;
  fontSize: number;
  sidebarWidth: number;
  showSidebar: boolean;
  showLineNumbers: boolean;
  /** 右侧链接面板是否展开 */
  showRightPanel: boolean;
  rightPanelWidth: number;
  editorWidth: number;
  /** 分栏时编辑区占的比例（0.15 – 0.85） */
  splitRatio: number;
}

export type ViewMode = "edit" | "split" | "preview";

/** 工作流阶段。`none` = 还没加入工作流，不进看板。 */
export type NoteStatus = "none" | "inbox" | "internalizing" | "output" | "archived";

/** 材料类型。 */
export type NoteKind = "note" | "course" | "book" | "article" | "clip" | "idea" | "output";

export interface WorkflowNote {
  path: string;
  title: string;
  status: NoteStatus;
  kind: NoteKind;
  source: string | null;
  capturedAt: string | null;
  mtime: number;
  blockCount: number;
  cardCount: number;
  missing: boolean;
}

export interface DueCard {
  id: number;
  noteId: string;
  path: string;
  title: string;
  heading: string;
  blockText: string;
  kind: "qa" | "cloze";
  question: string;
  answer: string;
  angle: string;
  line: number;
  state: string;
  due: string | null;
  stability: number | null;
  reps: number;
  lapses: number;
  fresh: boolean;
}

export interface GradeResult {
  due: string;
  intervalDays: number;
  state: string;
  stability: number;
  difficulty: number;
}

export interface ReviewStats {
  total: number;
  fresh: number;
  learning: number;
  review: number;
  dueToday: number;
  reviewedToday: number;
}

/**
 * 一张卡片。
 *
 * v5 起卡片是**挂在笔记上**的独立一行：建卡时把选中的块文字快照进 `sourceText`，
 * 之后正文怎么改都不影响它，复习进度也就不会丢。
 */
export interface Card {
  id: number;
  noteId: string;
  path: string;
  title: string;
  kind: "qa" | "cloze";
  question: string;
  answer: string;
  angle: string;
  /** 建卡时选中文字的**快照** */
  sourceText: string;
  sourceHeading: string;
  sourceLine: number;
  state: string;
  due: string | null;
  stability: number | null;
  reps: number;
  lapses: number;
  /** 今天该复习它（新卡，或已到期） */
  dueNow: boolean;
  /** 本次调用是新建的；false = 已经有同一张卡了 */
  created: boolean;
}

/** 建卡入参：来源快照由编辑器里的选区给全。 */
export interface NewCard {
  path: string;
  kind?: "qa" | "cloze";
  question: string;
  answer?: string;
  angle?: string;
  sourceText: string;
  sourceHeading?: string;
  sourceLine?: number;
}

/** 卡片计数：小结、徽标、筛选都用它。 */
export interface CardSummary {
  fresh: number;
  due: number;
  learning: number;
  review: number;
  total: number;
}

export interface SyncReport {
  scanned: number;
  updated: number;
  missing: number;
  elapsedMs: number;
}

export const api = {
  openVault: (path: string) => invoke<VaultInfo>("open_vault", { path }),
  closeVault: () => invoke<void>("close_vault"),
  currentVault: () => invoke<VaultInfo | null>("current_vault"),
  listTree: () => invoke<FileNode[]>("list_tree"),
  readNote: (path: string) => invoke<NoteContent>("read_note", { path }),
  writeNote: (path: string, content: string, expectedMtime?: number | null) =>
    invoke<number>("write_note", { path, content, expectedMtime: expectedMtime ?? null }),
  createNote: (parent: string, name: string) => invoke<string>("create_note", { parent, name }),
  createFolder: (parent: string, name: string) => invoke<string>("create_folder", { parent, name }),
  renameEntry: (path: string, newName: string) => invoke<string>("rename_entry", { path, newName }),
  moveEntry: (path: string, newParent: string) => invoke<string>("move_entry", { path, newParent }),
  deleteEntry: (path: string) => invoke<void>("delete_entry", { path }),
  listNotes: () => invoke<NoteMeta[]>("list_notes"),
  searchNotes: (query: string) => invoke<SearchHit[]>("search_notes", { query }),
  linkReport: (path: string) => invoke<LinkReport>("link_report", { path }),
  pathIsDir: (path: string) => invoke<boolean>("path_is_dir", { path }),
  // ---- 工作流（P0）
  syncWorkflow: () => invoke<SyncReport>("sync_workflow"),
  listWorkflow: () => invoke<WorkflowNote[]>("list_workflow"),
  setNoteStatus: (path: string, status: string) =>
    invoke<void>("set_note_status", { path, status }),
  appendInbox: (date: string, time: string, text: string) =>
    invoke<string>("append_inbox", { date, time, text }),
  importMaterial: (source: string, date: string) =>
    invoke<string>("import_material", { source, date }),
  // ---- 复习（P1）
  dueCards: (today: string, limit?: number, notePath?: string | null) =>
    invoke<DueCard[]>("due_cards", { today, limit: limit ?? null, notePath: notePath ?? null }),
  dueByNote: (today: string) =>
    invoke<{ path: string; title: string; due: number; total: number }[]>("due_by_note", { today }),
  gradeCard: (cardId: number, rating: number, today: string) =>
    invoke<GradeResult>("grade_card", { cardId, rating, today }),
  undoGrade: (cardId: number) => invoke<void>("undo_grade", { cardId }),
  // ---- 卡片（选中块建卡 → 右侧卡片面板）
  listCards: (notePath: string, today: string) =>
    invoke<Card[]>("list_cards", { notePath, today }),
  createCard: (card: NewCard, today: string) => invoke<Card>("create_card", { card, today }),
  deleteCard: (cardId: number) => invoke<void>("delete_card", { cardId }),
  cardSummary: (notePath: string, today: string) =>
    invoke<CardSummary>("card_summary", { notePath, today }),
  cardCounts: (today: string) => invoke<CardSummary>("card_counts", { today }),
  // ---- 安全网
  exportMarkdown: (dir: string) => invoke<number>("export_markdown", { dir }),
  listBackups: () => invoke<string[]>("list_backups"),
  reviewStats: (today: string) => invoke<ReviewStats>("review_stats", { today }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
};

/** 由仓库相对路径得到笔记名（去掉扩展名）。 */
export function titleOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, "");
}

/** 由仓库相对路径得到所在文件夹（根目录返回空串）。 */
export function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}
