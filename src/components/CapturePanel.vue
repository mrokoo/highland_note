<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { CornerDownLeft } from "lucide-vue-next";
import { capture, openNote, store } from "../lib/store";

/**
 * 快速捕获浮层：一个输入框，落点固定，不做任何分类。
 *
 * 这一层的全部要求就是"零决策"——要分类等清收件箱的时候再说（见 docs/workflow-design.md §3.1）。
 */

const text = ref("");
const input = ref<HTMLTextAreaElement | null>(null);
const busy = ref(false);

watch(
  () => store.captureOpen,
  async (open) => {
    if (!open) return;
    text.value = "";
    busy.value = false;
    await nextTick();
    input.value?.focus();
  },
);

function close() {
  store.captureOpen = false;
}

async function submit(andOpen = false) {
  if (busy.value) return;
  const value = text.value.trim();
  if (!value) {
    close();
    return;
  }
  busy.value = true;
  const path = await capture(value);
  busy.value = false;
  close();
  if (andOpen && path) await openNote(path);
}

/** Esc 关，Enter 存，Ctrl/Cmd + Enter 存完立刻打开。 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit(event.ctrlKey || event.metaKey);
  }
}
</script>

<template>
  <div v-if="store.captureOpen" class="overlay centered" @click.self="close">
    <div class="panel capture-panel">
      <textarea
        ref="input"
        v-model="text"
        class="capture-input"
        rows="4"
        placeholder="记一笔…（粘贴链接会自动变成链接）"
        @keydown="onKeydown"
      />

      <div class="capture-foot">
        <span class="capture-hint">
          存进当天的收件箱 ·
          <kbd>Enter</kbd> 存入 · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 存并打开
        </span>
        <button class="capture-submit" :disabled="busy" @click="submit(true)">
          <CornerDownLeft :size="14" :stroke-width="2" />
          存入
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.capture-panel {
  width: 460px;
  padding: 12px;
}

.capture-input {
  width: 100%;
  padding: 10px 11px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg-editor);
  color: var(--text);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.6;
  resize: none;
  outline: none;
}

.capture-input:focus {
  border-color: var(--accent);
}

.capture-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
}

.capture-hint {
  color: var(--text-faint);
  font-size: 11.5px;
}

.capture-hint kbd {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-hover);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.capture-submit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 11px;
  border-radius: 7px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 12.5px;
}

.capture-submit:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.capture-submit:disabled {
  opacity: 0.5;
}
</style>
