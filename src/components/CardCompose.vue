<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CornerDownLeft, RotateCcw } from "lucide-vue-next";
import {
  closeCardDialog,
  resetCardAnswer,
  saveCardDialog,
  setCardAnswer,
  store,
} from "../lib/store";

/**
 * 造卡弹窗：**从一个选中的块里"长"出一张卡**。
 *
 * 三件事按重要性排序：
 * 1. 块原文永远摆在最上面——你是在给"这句话"提问，不是在填一张空表；
 * 2. 角度只是一个标签（回忆 / 应用 / 辨析 / 追问），决定你从哪一侧探询；
 * 3. 答案默认就是块原文（产品规则），只有你主动改才变成自定义。
 */

const dialog = computed(() => store.cardDialog);

const ANGLES = [
  { value: "回忆", hint: "把这句话原样想起来" },
  { value: "应用", hint: "它用在哪、怎么用" },
  { value: "辨析", hint: "它和相近的概念差在哪" },
  { value: "追问", hint: "为什么成立、边界在哪" },
];

const questionInput = ref<HTMLTextAreaElement | null>(null);

const extraCount = computed(() => dialog.value?.extras.length ?? 0);

watch(
  () => store.cardDialog,
  async (value) => {
    if (!value) return;
    await nextTick();
    questionInput.value?.focus();
    questionInput.value?.select();
  },
);

function submit() {
  void saveCardDialog();
}

function cancel() {
  closeCardDialog();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submit();
  }
}
</script>

<template>
  <div v-if="dialog" class="overlay centered" @click.self="cancel">
    <div class="panel compose" @keydown="onKeydown">
      <header class="compose-head">
        <span class="compose-title">为这个块添加卡片</span>
        <span class="compose-source">
          {{ dialog.title }}
          <template v-if="dialog.heading"> › {{ dialog.heading }}</template>
          <span class="compose-line">第 {{ dialog.line }} 行</span>
        </span>
      </header>

      <blockquote class="compose-block">{{ dialog.text }}</blockquote>

      <div class="compose-row">
        <span class="compose-label">角度</span>
        <div class="compose-angles">
          <button
            v-for="angle in ANGLES"
            :key="angle.value"
            class="angle-chip"
            :class="{ active: dialog.angle === angle.value }"
            :title="angle.hint"
            @click="dialog.angle = angle.value"
          >
            {{ angle.value }}
          </button>
        </div>
      </div>

      <div class="compose-field">
        <label class="compose-label" for="card-question">问题</label>
        <textarea
          id="card-question"
          ref="questionInput"
          v-model="dialog.question"
          class="compose-input"
          rows="2"
          placeholder="你要问这句话什么？（回忆 / 应用 / 辨析 / 追问）"
        />
      </div>

      <div class="compose-field">
        <div class="compose-field-head">
          <label class="compose-label" for="card-answer">答案</label>
          <span v-if="dialog.followSource" class="compose-hint">跟随块原文</span>
          <button v-else class="compose-reset" @click="resetCardAnswer">
            <RotateCcw :size="12" :stroke-width="1.9" />
            用块原文
          </button>
        </div>
        <textarea
          id="card-answer"
          class="compose-input"
          rows="3"
          :value="dialog.answer"
          @input="setCardAnswer(($event.target as HTMLTextAreaElement).value)"
        />
      </div>

      <label v-if="extraCount" class="compose-extras">
        <input v-model="dialog.withExtras" type="checkbox" />
        选区里的另外 {{ extraCount }} 个块也各建一张卡（问题用草稿）
      </label>

      <div class="modal-actions">
        <span class="compose-tip">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 添加 · <kbd>Esc</kbd> 取消
        </span>
        <button class="button" @click="cancel">取消</button>
        <button class="button primary" :disabled="dialog.saving" @click="submit">
          <CornerDownLeft :size="13" :stroke-width="2" />
          添加
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compose {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(560px, 92vw);
  padding: 18px;
}

.compose-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.compose-title {
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
}

.compose-source {
  color: var(--text-faint);
  font-size: 12px;
}

.compose-line {
  margin-left: 6px;
  opacity: 0.75;
}

.compose-block {
  margin: 0;
  padding: 10px 12px;
  border-left: 2px solid var(--accent);
  border-radius: 0 6px 6px 0;
  background: var(--bg-app);
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  max-height: 140px;
  overflow: auto;
}

.compose-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.compose-label {
  color: var(--text-muted);
  font-size: 12.5px;
}

.compose-angles {
  display: flex;
  gap: 6px;
}

.angle-chip {
  height: 26px;
  padding: 0 11px;
  border-radius: 13px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-muted);
  font-size: 12.5px;
}

.angle-chip:hover {
  border-color: var(--accent);
  color: var(--text);
}

.angle-chip.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}

.compose-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.compose-field-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.compose-input {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg-app);
  color: var(--text);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
}

.compose-input:focus {
  border-color: var(--accent);
}

.compose-hint {
  color: var(--text-faint);
  font-size: 11.5px;
}

.compose-reset {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.compose-reset:hover {
  background: var(--bg-hover);
  color: var(--accent);
}

.compose-extra {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.compose-extras {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-muted);
  font-size: 12.5px;
  cursor: pointer;
}

.compose-extras input {
  accent-color: var(--accent);
}

.compose-tip {
  margin-right: auto;
  color: var(--text-faint);
  font-size: 11.5px;
}

.compose-tip kbd {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.modal-actions {
  align-items: center;
  margin-top: 0;
}
</style>
