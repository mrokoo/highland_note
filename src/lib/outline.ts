/** 从 Markdown 里抽取标题，供「目录」面板使用。 */

export interface OutlineHeading {
  level: number;
  text: string;
  /** 1 起的行号，用来让编辑器跳过去 */
  line: number;
}

/** 标题里的行内标记在目录里没必要显示。 */
function plainHeading(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) =>
      alias ?? target,
    )
    .replace(/[*_`~]/g, "")
    .replace(/\s*#+\s*$/, "")
    .trim();
}

/**
 * 抽取标题列表。
 * 会跳过 YAML frontmatter 和围栏代码块——代码块里的 `# 注释` 不是标题。
 */
export function extractOutline(markdown: string): OutlineHeading[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings: OutlineHeading[] = [];

  let cursor = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) cursor = end + 1;
  }

  let inFence = false;
  for (; cursor < lines.length; cursor += 1) {
    const raw = lines[cursor];
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (!match) continue;
    const text = plainHeading(match[2]);
    if (!text) continue;
    headings.push({ level: match[1].length, text, line: cursor + 1 });
  }
  return headings;
}

/** 光标在第 line 行时，它属于哪一个标题（返回标题在列表中的下标，没有则 -1）。 */
export function headingAt(headings: OutlineHeading[], line: number): number {
  let found = -1;
  for (let i = 0; i < headings.length; i += 1) {
    if (headings[i].line <= line) found = i;
    else break;
  }
  return found;
}
