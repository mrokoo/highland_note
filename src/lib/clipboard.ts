import {
  readText as readClipboard,
  writeText as writeClipboard,
} from "@tauri-apps/plugin-clipboard-manager";

/** 写入系统剪贴板，插件不可用时退回浏览器接口。 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await writeClipboard(text);
    return true;
  } catch {
    /* 继续尝试下面的方式 */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 继续尝试下面的方式 */
  }
  // 最后兜底：老式 execCommand，在没有安全上下文时也能用
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** 读取系统剪贴板文本。 */
export async function readClipboardText(): Promise<string> {
  try {
    return await readClipboard();
  } catch {
    /* 继续尝试下面的方式 */
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
