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

export interface Settings {
  recentVaults: string[];
  lastVault: string | null;
  theme: "dark" | "light";
  viewMode: ViewMode;
  fontSize: number;
  sidebarWidth: number;
  showSidebar: boolean;
  showLineNumbers: boolean;
  editorWidth: number;
  /** 分栏时编辑区占的比例（0.15 – 0.85） */
  splitRatio: number;
}

export type ViewMode = "edit" | "split" | "preview";

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
  pathIsDir: (path: string) => invoke<boolean>("path_is_dir", { path }),
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
