/**
 * 界面改动的验收（对着跑着的应用做）：
 *  1. 新建笔记是白纸，没有「## 内化」；写了内容之后才长出小节
 *  2. 左边栏没有「跳转」，图标顺序是 工作台 / 复习 → 文件 / 搜索 / 目录 → 设置
 *  3. 状态栏的保存状态不可点
 *  4. 折叠侧边栏有过渡（transition 生效，动画中途宽度在 0 和设定值之间）
 *
 *   node scripts/ui-check.mjs
 */
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("没有找到可调试的页面");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const slot = pending.get(message.id);
  if (!slot) return;
  pending.delete(message.id);
  if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
  else slot.resolve(message.result);
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

const steps = [];
const check = (label, ok, extra = "") => {
  steps.push(`${ok ? "  ok  " : " FAIL "} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
};

// ---- 1) 左边栏：没有「跳转」，顺序合理
const rail = await evaluate(`
  [...document.querySelectorAll('.rail-button')].map((b) => b.innerText.trim().split('\\n')[0])
`);
check("左边栏没有「跳转」", !rail.includes("跳转"), rail.join(" / "));
check(
  "顺序是 工作台 → 复习 → 文件 → 搜索 → 目录 → 设置",
  JSON.stringify(rail) === JSON.stringify(["工作台", "复习", "文件", "搜索", "目录", "设置"]),
  rail.join(" → "),
);

// ---- 2) 状态栏的保存状态不是按钮（要先打开一篇笔记，状态栏才有这一段）
const saveEl = await evaluate(`
  (async () => {
    const rows = [...document.querySelectorAll('.tree-row')];
    rows.find((r) => r.innerText.includes('笔记方法'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const note = [...document.querySelectorAll('.tree-row')].find((r) => r.innerText.includes('检索练习'));
    if (note) note.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const el = document.querySelector('.status-save');
    return { tag: el ? el.tagName : null, text: el ? el.textContent.trim() : null };
  })()
`);
check("保存状态是纯文本（不是按钮）", saveEl.tag === "SPAN", `${saveEl.tag} / ${saveEl.text}`);
check("保存状态说的是自动保存", String(saveEl.text ?? "").includes("自动保存"), String(saveEl.text));

// ---- 2b) 标签页上不该有"未保存"小圆点，窗口标题也不带 • 标记
const dirtyUi = await evaluate(`
  (async () => {
    const dots = document.querySelectorAll('.tab .dirty-dot').length;
    // 敲一个字，看圆点会不会冒出来
    const view = document.querySelector('.cm-content');
    view?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { dots, title: document.title };
  })()
`);
check("标签页上没有未保存圆点", dirtyUi.dots === 0, `${dirtyUi.dots} 个`);
check("窗口标题不带 • 未保存标记", !dirtyUi.title.includes("•"), dirtyUi.title);

// ---- 3) 新建笔记：白纸，而且正文里永远没有"内化"
const created = await evaluate(`
  (async () => {
    const path = await window.__TAURI_INTERNALS__.invoke('create_note', { parent: '', name: '界面验收-白纸' });
    const note = await window.__TAURI_INTERNALS__.invoke('read_note', { path });
    return { path, content: note.content };
  })()
`);
check("新建笔记是空的", created.content === "", JSON.stringify(created.content));

// 写一句话再读回来：正文就是那句话，不会被套上「## 内化」
const afterWrite = await evaluate(`
  (async () => {
    await window.__TAURI_INTERNALS__.invoke('write_note', {
      path: ${JSON.stringify(created.path)},
      content: '第一句话\\n',
      expectedMtime: null,
    });
    const note = await window.__TAURI_INTERNALS__.invoke('read_note', { path: ${JSON.stringify(created.path)} });
    return note.content;
  })()
`);
check("正文不带「## 内化」", afterWrite === "第一句话\n", JSON.stringify(afterWrite));

// 老笔记（正文里曾经被塞过角色标题）打开时也不该再看到它
const legacy = await evaluate(`
  (async () => {
    const tree = await window.__TAURI_INTERNALS__.invoke('list_tree');
    const flat = [];
    const walk = (nodes) => nodes.forEach((n) => (n.isDir ? walk(n.children ?? []) : flat.push(n.path)));
    walk(tree);
    for (const path of flat) {
      const note = await window.__TAURI_INTERNALS__.invoke('read_note', { path });
      for (const role of ['## 输入', '## 内化', '## 输出']) {
        if (note.content.includes(role)) return { path, role };
      }
    }
    return null;
  })()
`);
check("仓库里没有任何笔记还带着角色标题", legacy === null, legacy ? `${legacy.path} 里有 ${legacy.role}` : "全部干净");

// 收尾：删掉验收用的笔记
await evaluate(`window.__TAURI_INTERNALS__.invoke('delete_entry', { path: ${JSON.stringify(created.path)} })`);
const gone = await evaluate(`
  (async () => {
    try { await window.__TAURI_INTERNALS__.invoke('read_note', { path: ${JSON.stringify(created.path)} }); return false; }
    catch { return true; }
  })()
`);
check("验收用的笔记已删除", gone === true);

// ---- 4) 折叠侧边栏：transition 生效，动画中途宽度在中间值
const collapse = await evaluate(`
  (async () => {
    const side = document.querySelector('.sidebar');
    if (!side) return { error: '没有侧栏' };
    const style = getComputedStyle(side);
    const before = side.getBoundingClientRect().width;
    window.__highlandTest = { transition: style.transitionProperty, duration: style.transitionDuration };
    // 走应用自己的那条路：Ctrl+B 等价于切换 showSidebar
    const toggle = [...document.querySelectorAll('.topbar .icon-button')].find((b) => (b.title || '').includes('侧边栏'));
    toggle.click();
    await new Promise((r) => setTimeout(r, 60));
    const middle = side.getBoundingClientRect().width;
    await new Promise((r) => setTimeout(r, 400));
    const after = side.getBoundingClientRect().width;
    toggle.click();
    await new Promise((r) => setTimeout(r, 400));
    const restored = side.getBoundingClientRect().width;
    return { before, middle, after, restored, ...window.__highlandTest };
  })()
`);
check("侧栏有宽度过渡", String(collapse.transition).includes("width"), JSON.stringify(collapse));
check("收起后宽度归零", collapse.after < 1, `${collapse.after}px`);
check(
  "收起过程是渐变的（不是瞬间跳变）",
  collapse.middle > 1 && collapse.middle < collapse.before,
  `中途 ${Math.round(collapse.middle)}px / 起始 ${Math.round(collapse.before)}px`,
);
check("展开能回到原宽度", Math.abs(collapse.restored - collapse.before) < 2, `${Math.round(collapse.restored)}px`);

console.log("\n=== 界面验收 ===");
for (const line of steps) console.log(line);
console.log(process.exitCode ? "\n有步骤不符" : "\n全部通过");
socket.close();
