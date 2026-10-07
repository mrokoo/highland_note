/**
 * 造卡那条链的端到端验证：在**真实运行的应用**里走一遍
 * 「打开笔记 → 选中一句话 → Ctrl+Shift+C → 卡片入库 → 右侧卡片面板显示」。
 *
 *   node scripts/app-e2e.mjs
 *
 * 前提：应用带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动，
 * 并且打开的仓库是 demo-vault。这是开发期的验收脚本，不属于应用代码。
 */
const CDP = "http://127.0.0.1:9222/json/list";
const NOTE = "笔记方法/检索练习";
const BLOCK_TEXT = "检索练习";

const targets = await (await fetch(CDP)).json();
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

async function key(text, modifiers = 0) {
  const base = { modifiers, key: text, code: `Key${text.toUpperCase()}`, windowsVirtualKeyCode: text.toUpperCase().charCodeAt(0) };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** 真实鼠标点击：光标要靠它落到编辑器里（合成事件的 isTrusted 是 false，CodeMirror 不认）。 */
async function clickAt(x, y) {
  const point = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
}

const steps = [];
const check = (label, ok, extra = "") => {
  steps.push(`${ok ? "  ok  " : " FAIL "} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
};

// 1) 打开笔记：把窗口叫到前台（真实按键只送到前台窗口），再点文件树里的那一行
await evaluate("window.__TAURI_INTERNALS__.invoke('open_vault', { path: String.raw`E:\\Program\\rs\\highland_note\\demo-vault` })");
await new Promise((resolve) => setTimeout(resolve, 1500));
const focused = await evaluate("document.hasFocus()");
check("应用窗口在前台（真实按键才送得到）", focused === true, String(focused));
await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('.tree-row')];
    const folders = rows.filter((row) => row.innerText.includes('笔记方法'));
    if (folders[0]) folders[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()
`);
await new Promise((resolve) => setTimeout(resolve, 400));
const clicked = await evaluate(`
  (() => {
    const row = [...document.querySelectorAll('.tree-row')].find((item) => item.innerText.includes('检索练习'));
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()
`);
check("在文件树里点开「检索练习」", clicked === true);
await new Promise((resolve) => setTimeout(resolve, 1500));
const openPath = await evaluate("document.querySelector('.tab.active .tab-title')?.textContent ?? ''");
check("笔记在标签页里打开了", openPath.includes("检索练习"), openPath);

// 2) 光标落到含「检索练习」的**正文行**（真实鼠标点击，CodeMirror 只认这个）
const target = await evaluate(`
  (() => {
    const lines = [...document.querySelectorAll('.cm-line')].filter((node) => !node.textContent.trim().startsWith('#'));
    const line = lines.find((node) => node.textContent.includes(${JSON.stringify(BLOCK_TEXT)}));
    if (!line) return null;
    const box = line.getBoundingClientRect();
    return { x: box.left + 40, y: box.top + box.height / 2, text: line.textContent.trim().slice(0, 60) };
  })()
`);
check("在编辑器里找到了那一行", Boolean(target), target?.text ?? "没找到");
if (target) await clickAt(target.x, target.y);
await new Promise((resolve) => setTimeout(resolve, 400));

// 3) 按 Ctrl+Shift+C（modifiers 2 = Ctrl，8 = Shift）
//    真实按键只送到前台窗口，所以按键前先确认焦点真的在编辑器里，不行就重试一次。
async function waitForEditorFocus(timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const active = await evaluate("document.activeElement?.className ?? ''");
    if (active.includes("cm-content")) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function pressCreateCard() {
  if (await waitForEditorFocus()) {
    await key("C", 2 | 8);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return Boolean(await evaluate("document.querySelector('.compose')"));
  }
  return false;
}

let opened = await pressCreateCard();
if (!opened) {
  // 焦点被系统抢走时补一次：把窗口叫到前台再点一下那一行
  console.log("     （第一次按键没打开弹窗，重新聚焦后再试一次）");
  const { execFileSync } = await import("node:child_process");
  execFileSync("pwsh", ["-NoProfile", "-File", "scripts/capture-window.ps1"], { stdio: "ignore" });
  if (target) await clickAt(target.x, target.y);
  await new Promise((resolve) => setTimeout(resolve, 400));
  opened = await pressCreateCard();
}

const dialog = await evaluate("document.querySelector('.compose') ? document.querySelector('.compose-block')?.textContent?.trim() : null");
check("造卡弹窗弹出，并带着块原文", Boolean(dialog), String(dialog).slice(0, 60));

// 4) 写一个问题，点「添加」
const saved = await evaluate(`
  (async () => {
    const area = document.querySelector('#card-question');
    if (!area) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, '端到端验证：检索练习的核心机制是什么？');
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const add = [...document.querySelectorAll('.compose .button')].find((button) => button.textContent.includes('添加'));
    add.click();
    await new Promise((r) => setTimeout(r, 2000));
    return 'clicked';
  })()
`);
check("填好问题并点「添加」", saved === "clicked", saved);

// 5) 卡片进了库，右侧面板也列了出来
const cards = await evaluate("window.__TAURI_INTERNALS__.invoke('list_cards', { notePath: '笔记方法/检索练习', today: new Date().toISOString().slice(0,10) })");
const mine = cards.find((card) => card.question.includes("端到端验证"));
check("卡片进了库", Boolean(mine), mine ? `id=${mine.id} angle=${mine.angle} 到期=${mine.due ?? "今天"}` : "没找到");
check("答案默认是块原文", Boolean(mine) && mine.answer.includes("检索练习"), mine?.answer?.slice(0, 40) ?? "");
check("来源快照与行号记下了", Boolean(mine) && mine.sourceText.length > 0 && mine.sourceLine > 0, mine ? `第 ${mine.sourceLine} 行` : "");

const summary = await evaluate("window.__TAURI_INTERNALS__.invoke('card_summary', { notePath: '笔记方法/检索练习', today: new Date().toISOString().slice(0,10) })");
check("小结里算进去了", summary.total >= 4, JSON.stringify(summary));

await evaluate("document.querySelector('.right-toolbar button[title^=\"卡片视图\"]')?.click()");
await new Promise((resolve) => setTimeout(resolve, 1500));
const panel = await evaluate(`
  (() => {
    const items = [...document.querySelectorAll('.cards-panel .card-question')].map((node) => node.textContent.trim());
    return { cells: [...document.querySelectorAll('.cards-panel .summary-value')].map((n) => n.textContent.trim()), items };
  })()
`);
check("右侧卡片面板列出了这张卡", panel.items.some((text) => text.includes("端到端验证")), `${panel.items.length} 张`);

// 6) 收尾：把验证用的卡片删掉，仓库回到原样
if (mine) await evaluate(`window.__TAURI_INTERNALS__.invoke('delete_card', { cardId: ${mine.id} })`);
const after = await evaluate("window.__TAURI_INTERNALS__.invoke('list_cards', { notePath: '笔记方法/检索练习', today: new Date().toISOString().slice(0,10) })");
check("删卡之后回到原来的 3 张", after.length === 3, `${after.length} 张`);

console.log(`\n=== 端到端验证（${NOTE}）===`);
for (const line of steps) console.log(line);
console.log(process.exitCode ? "\n有步骤不符" : "\n全部通过");
socket.close();
