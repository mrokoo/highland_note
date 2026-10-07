<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { ExternalLink, X } from "lucide-vue-next";
import {
  closeReview,
  currentReviewCard,
  gradeCurrent,
  openNote,
  revealAnswer,
  store,
  undoGrade,
} from "../lib/store";

/**
 * 复习视图：一张卡一个屏，四档评分。
 *
 * 排期由 FSRS 算（Rust 侧 `review.rs`），这里只负责把"问题 → 想 → 答案 → 自评"
 * 这一遍走得顺：空格翻面、1-4 评分、Esc 退出、能跳回原文。
 */

const card = currentReviewCard;

const total = computed(() => store.reviewQueue.length);
const position = computed(() => Math.min(store.reviewIndex + 1, total.value));
const progress = computed(() =>
  total.value ? Math.round((store.reviewIndex / total.value) * 100) : 0,
);

const RATINGS = [
  { value: 1 as const, label: "重来", hint: "完全没想起来", key: "1" },
  { value: 2 as const, label: "困难", hint: "想起来了，很吃力", key: "2" },
  { value: 3 as const, label: "良好", hint: "正常回忆起来", key: "3" },
  { value: 4 as const, label: "简单", hint: "秒答，太轻松", key: "4" },
];

function onKeydown(event: KeyboardEvent) {
  if (!store.showReview) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeReview();
    return;
  }
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    if (!store.reviewRevealed) revealAnswer();
    else void gradeCurrent(3);
    return;
  }
  if (["1", "2", "3", "4"].includes(event.key)) {
    event.preventDefault();
    if (!store.reviewRevealed) revealAnswer();
    else void gradeCurrent(Number(event.key) as 1 | 2 | 3 | 4);
  }
  if (event.key.toLowerCase() === "z" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void undoGrade();
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="store.showReview" class="review">
    <header class="review-head">
      <span class="review-progress">{{ position }} / {{ total }}</span>
      <div class="review-bar"><div class="review-bar-fill" :style="{ width: `${progress}%` }" /></div>
      <button class="review-close" title="结束复习 (Esc)" @click="closeReview">
        <X :size="16" :stroke-width="1.8" />
      </button>
    </header>

    <main v-if="card" class="review-body">
      <div class="review-source">
        <span class="review-title">{{ card.title }}</span>
        <template v-if="card.heading"><span class="review-sep">›</span>{{ card.heading }}</template>
        <button
          class="review-jump"
          title="回到原文"
          @click="openNote(card.path, card.line)"
        >
          <ExternalLink :size="13" :stroke-width="1.8" />
          原文
        </button>
      </div>

      <section class="review-card">
        <div v-if="card.angle" class="review-angle">{{ card.angle }}</div>
        <div class="review-question">{{ card.question }}</div>

        <div v-if="store.reviewRevealed" class="review-answer">
          <div class="review-answer-label">答案</div>
          <div class="review-answer-text">{{ card.answer }}</div>
          <div v-if="card.blockText !== card.answer" class="review-block">
            <span class="review-answer-label">出处</span>
            {{ card.blockText }}
          </div>
        </div>
      </section>

      <footer class="review-foot">
        <button v-if="!store.reviewRevealed" class="review-reveal" @click="revealAnswer">
          显示答案 <kbd>空格</kbd>
        </button>
        <div v-else class="review-ratings">
          <button
            v-for="rating in RATINGS"
            :key="rating.value"
            class="review-rating"
            :class="`r${rating.value}`"
            :disabled="store.reviewAnswering"
            :title="rating.hint"
            @click="gradeCurrent(rating.value)"
          >
            <span class="r-label">{{ rating.label }}</span>
            <kbd>{{ rating.key }}</kbd>
          </button>
        </div>
      </footer>
    </main>

    <main v-else class="review-body review-empty">
      <div class="review-done">今天没有到期的卡片</div>
      <div class="review-done-hint">写几条 Block，给它们提个问，明天就会出现在这里</div>
      <button class="review-reveal" @click="closeReview">回到工作台</button>
    </main>
  </div>
</template>

<style scoped>
.review {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}

.review-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
  height: 42px;
  padding: 0 14px;
}

.review-progress {
  color: var(--text-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.review-bar {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--bg-hover);
  overflow: hidden;
}

.review-bar-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}

.review-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--text-muted);
}

.review-close:hover {
  background: var(--bg-hover);
  color: var(--text-strong);
}

.review-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: 24px 32px 32px;
}

.review-source {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 12px;
}

.review-sep {
  opacity: 0.6;
}

.review-jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 3px 8px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.review-jump:hover {
  background: var(--bg-hover);
  color: var(--accent);
}

.review-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding: 20px 0;
  overflow: auto;
}

.review-angle {
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: 5px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 11.5px;
}

.review-question {
  color: var(--text-strong);
  font-size: 22px;
  line-height: 1.5;
  font-weight: 600;
}

.review-answer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.review-answer-label {
  color: var(--text-faint);
  font-size: 11.5px;
}

.review-answer-text {
  color: var(--text);
  font-size: 16px;
  line-height: 1.7;
}

.review-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-sidebar);
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.65;
}

.review-foot {
  flex: none;
  padding-top: 8px;
}

.review-reveal {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 18px;
  border-radius: 9px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 13.5px;
}

.review-reveal:hover {
  background: var(--accent);
  color: #fff;
}

.review-reveal kbd,
.review-rating kbd {
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  opacity: 0.7;
}

.review-ratings {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.review-rating {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 40px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 13.5px;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.review-rating:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.review-rating.r1:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.review-rating.r3:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.review-rating:disabled {
  opacity: 0.5;
}

.review-empty {
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
}

.review-done {
  color: var(--text-strong);
  font-size: 16px;
}

.review-done-hint {
  margin-bottom: 10px;
  color: var(--text-faint);
  font-size: 12.5px;
}
</style>
