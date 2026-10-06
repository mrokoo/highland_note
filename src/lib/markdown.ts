import MarkdownIt, {
  type Env,
  type MarkdownIt as MarkdownItInstance,
  type Renderer,
  type StateInline,
  type Token,
} from "markdown-it";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** `[[目标笔记|显示名]]` */
function wikilinkPlugin(md: MarkdownItInstance) {
  md.inline.ruler.before("link", "wikilink", (state: StateInline, silent: boolean) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner || inner.includes("\n") || inner.includes("[") || inner.includes("]")) return false;

    const [rawTarget, rawAlias] = inner.split("|");
    const target = rawTarget.trim();
    if (!target) return false;

    if (!silent) {
      const token = state.push("wikilink", "", 0);
      token.content = (rawAlias ?? rawTarget).trim();
      token.meta = { target };
    }
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules.wikilink = (tokens: Token[], idx: number) => {
    const token = tokens[idx];
    const target = String((token.meta as { target?: string } | null)?.target ?? "");
    return `<a class="wikilink" href="#" data-wikilink="${escapeHtml(target)}">${escapeHtml(
      token.content,
    )}</a>`;
  };
}

/** 行内 `#标签` */
function hashtagPlugin(md: MarkdownItInstance) {
  md.inline.ruler.before("emphasis", "hashtag", (state: StateInline, silent: boolean) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x23) return false;
    const prev = start > 0 ? src[start - 1] : "";
    if (prev && /[\p{L}\p{N}_]/u.test(prev)) return false;
    const match = /^#([\p{L}\p{N}_/-]+)/u.exec(src.slice(start));
    if (!match) return false;
    if (!silent) {
      const token = state.push("hashtag", "", 0);
      token.content = match[1];
    }
    state.pos = start + match[0].length;
    return true;
  });

  md.renderer.rules.hashtag = (tokens: Token[], idx: number) => {
    const tag = tokens[idx].content;
    return `<span class="hashtag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`;
  };
}

/** 代码高亮交给 highlight.js，失败时退回纯文本。 */
function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const value = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${value}</code></pre>`;
    } catch {
      /* 落到下面的纯文本分支 */
    }
  }
  return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
}

const md: MarkdownItInstance = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  highlight: highlightCode,
});

md.use(wikilinkPlugin);
md.use(hashtagPlugin);

/** 把 `- [ ] 待办` 渲染成真正的复选框。 */
function taskLists(html: string): string {
  return html.replace(
    /<li>\[([ xX])\]\s+/g,
    (_match, mark: string) =>
      `<li class="task-item"><input type="checkbox" disabled${
        mark.toLowerCase() === "x" ? " checked" : ""
      }> `,
  );
}

export function renderMarkdown(source: string): string {
  const html = taskLists(md.render(source));
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-wikilink", "data-tag"] });
}

/** 提取正文里出现的所有 `[[链接]]` 目标，用于反链。 */
export function extractLinks(source: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const target = match[1].split("|")[0].split("#")[0].trim();
    if (target) out.push(target);
  }
  return out;
}

/** 提取正文里出现的所有 `#标签`。 */
export function extractTags(source: string): string[] {
  const out = new Set<string>();
  const re = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) out.add(match[2]);
  return [...out];
}

/** 统计正文字数与字符数（中文按字计）。 */
export function countStats(source: string): { chars: number; words: number } {
  const chars = source.length;
  const cjk = (source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (source.match(/[A-Za-z0-9_\u00c0-\u024f]+/g) ?? []).length;
  return { chars, words: cjk + latin };
}

export type { Env, Renderer };
