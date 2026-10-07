/**
 * 折叠箭头（左边那块灰方块）的验收：
 *  - 光标落在某一行时，箭头不该显形（从前它会常显）
 *  - 只有鼠标移到折叠槽上才出现
 *
 *   node scripts/gutter-check.mjs
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

// 打开一篇有列表的笔记，光标点进去
await evaluate(`
  (async () => {
    const rows = [...document.querySelectorAll('.tree-row')];
    rows.find((r) => r.innerText.includes('笔记方法'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const note = [...document.querySelectorAll('.tree-row')].find((r) => r.innerText.includes('每日笔记'));
    note?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    document.querySelector('.cm-content')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.querySelector('.cm-content')?.focus();
    return true;
  })()
`);

const markerState = await evaluate(`
  (() => {
    const gutters = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')];
    if (!gutters.length) return { error: '没有折叠槽' };
    const visible = gutters.filter((el) => Number(getComputedStyle(el).opacity) > 0.05);
    const marker = document.querySelector('.cm-fold-marker');
    const style = marker ? getComputedStyle(marker) : null;
    return {
      gutters: gutters.length,
      visibleGutters: visible.length,
      marker: marker ? { w: Math.round(marker.getBoundingClientRect().width), h: Math.round(marker.getBoundingClientRect().height) } : null,
      markerBg: style?.backgroundColor ?? null,
      activeLine: document.querySelectorAll('.cm-activeLineGutter').length,
    };
  })()
`);

check("编辑器里有折叠槽", markerState.gutters > 0, JSON.stringify(markerState));
check(
  "光标在某一行时，箭头不显形",
  markerState.visibleGutters === 0,
  `可见 ${markerState.visibleGutters} / 共 ${markerState.gutters} 个折叠槽`,
);
check(
  "箭头本体是个 12px 的小方块（不再是贴着文字的大块）",
  markerState.marker ? markerState.marker.w <= 13 && markerState.marker.h <= 13 : false,
  JSON.stringify(markerState.marker),
);
check("箭头默认没有底色", markerState.markerBg === "rgba(0, 0, 0, 0)", String(markerState.markerBg));

// 把鼠标移到折叠槽上：这时才该出现（用真实鼠标移动，CSS :hover 才生效）
const hover = await evaluate(`
  (() => {
    const gutters = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')];
    const box = gutters[Math.min(2, gutters.length - 1)]?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  })()
`);
if (hover) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(hover.x), y: Math.round(hover.y) });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const after = await evaluate(`
    [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].filter((el) => Number(getComputedStyle(el).opacity) > 0.05).length
  `);
  check("鼠标移到折叠槽上才出现箭头", after > 0, `可见 ${after} 个`);
  // 移开
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 700 });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const away = await evaluate(`
    [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].filter((el) => Number(getComputedStyle(el).opacity) > 0.05).length
  `);
  check("鼠标移开后箭头又藏起来", away === 0, `可见 ${away} 个`);
}

console.log("\n=== 折叠箭头验收 ===");
for (const line of steps) console.log(line);
console.log(process.exitCode ? "\n有步骤不符" : "\n全部通过");
socket.close();
