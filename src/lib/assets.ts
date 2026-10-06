import { convertFileSrc } from "@tauri-apps/api/core";
import { folderOf, store } from "./store";

/**
 * 把笔记里写的图片地址换成 webview 能加载的地址。
 *
 * - `http(s):` / `data:` / 已经是 asset 地址的直接放行
 * - 相对路径按「这篇笔记所在目录」解析，和 Markdown 的习惯一致
 * - 仓库目录在打开仓库时已经放进了 Tauri 的 asset 白名单
 */
export function resolveAssetUrl(url: string, notePath?: string): string | null {
  const raw = url.trim().replace(/^<|>$/g, "");
  if (!raw) return null;
  if (/^(https?:|data:|blob:|asset:|tauri:)/i.test(raw)) return raw;

  const root = store.vault?.path;
  if (!root) return null;

  let relative = raw;
  try {
    relative = decodeURIComponent(raw);
  } catch {
    /* 原样使用 */
  }
  relative = relative.replace(/^\.\//, "");
  if (relative.startsWith("/")) relative = relative.slice(1);

  const folder = notePath ? folderOf(notePath) : "";
  const parts = [root.replace(/[\\/]+$/, "")];
  if (folder) parts.push(folder);
  parts.push(relative);
  return convertFileSrc(parts.join("\\").replace(/\//g, "\\"));
}
