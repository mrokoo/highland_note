<script setup lang="ts">
import { computed } from "vue";
import { ExternalLink, Layers, Plus, Trash2 } from "lucide-vue-next";
import {
  activeTab,
  openNote,
  removeCard,
  reviewNote,
  setCardFilter,
  store,
  visibleCards,
} from "../lib/store";

/**
 * 右侧「卡片视图」：打开一篇笔记时，这里就是你为它建的全部卡片。
 *
 * 三块内容，从上到下：
 * 1. 小结 —— 新学 / 到期 / 学习中 / 复习中，一眼看出这篇内化到哪一步；
 * 2. 筛选 —— 按状态看卡片（默认全部）；
 * 3. 列表 —— 问题 + 角度 + 出处，点一下跳回原文那一行，也能就地删卡。
 *
 * 建卡不在这里做：卡片的来源是**你在编辑器里选中的块**，
 * 所以入口在编辑器（选中 → Ctrl+Shift+C）。这里只负责看和复习。
 */

const summary = computed(() => store.cardSummary);
const cards = computed(() => visibleCards.value);

const FILTERS = [
  { key: "all" as const, label: "全部" },
  { key: "new" as const, label: "新学" },
  { key: "due" as const, label: "到期" },
  { key: "learning" as const, label: "学习中" },
  { key: "review" as const, label: "复习中" },
];

function filterCount(key: (typeof FILTERS)[number]["key"]): number {
  const all = store.cards;
  switch (key) {
    case "new":
      return all.filter((card) => card.state === "new").length;
    case "due":
      return all.filter((card) => card.dueNow).length;
    case "learning":
      return all.filter((card) => card.state === "learning" || card.state === "relearning").length;
    case "review":
      return all.filter((card) => card.state === "review").length;
    default:
      return all.length;
  }
}

/** 状态徽标：新学 / 学习中 / 复习中，只有到期才显示到期日。 */
function stateLabel(card: (typeof cards.value)[number]): string {
  if (card.state === "new") return "新学";
  if (card.state === "learning" || card.state === "relearning") return "学习中";
  return "复习中";
}

function dueLabel(card: (typeof cards.value)[number]): string {
  if (!card.due) return "今天";
  if (card.dueNow) return "今天";
  return card.due.slice(5);
}
</script>

<template>
  <div class="cards-panel">
    <div v-if="!activeTab" class="cards-empty">打开一篇笔记，这里会列出它的卡片</div>

    <template v-else>
      <div class="cards-summary">
        <div class="summary-cell">
          <span class="summary-value">{{ summary?.fresh ?? 0 }}</span>
          <span class="summary-label">新学</span>
        </div>
        <div class="summary-cell">
          <span class="summary-value accent">{{ summary?.due ?? 0 }}</span>
          <span class="summary-label">到期</span>
        </div>
        <div class="summary-cell">
          <span class="summary-value">{{ summary?.learning ?? 0 }}</span>
          <span class="summary-label">学习中</span>
        </div>
        <div class="summary-cell">
          <span class="summary-value">{{ summary?.review ?? 0 }}</span>
          <span class="summary-label">复习中</span>
        </div>
      </div>

      <div class="cards-actions">
        <button
          class="cards-review"
          :disabled="!summary?.due"
          :title="summary?.due ? '只复习这一篇的卡片' : '这篇今天没有到期的卡片'"
          @click="activeTab && reviewNote(activeTab.path)"
        >
          <Layers :size="13" :stroke-width="1.9" />
          复习这篇
          <span v-if="summary?.due" class="cards-review-count">{{ summary.due }}</span>
        </button>
        <span class="cards-total">共 {{ summary?.total ?? 0 }} 张</span>
      </div>

      <div class="cards-filters">
        <button
          v-for="filter in FILTERS"
          :key="filter.key"
          class="filter-chip"
          :class="{ active: store.cardFilter === filter.key }"
          @click="setCardFilter(filter.key)"
        >
          {{ filter.label }}
          <span class="filter-count">{{ filterCount(filter.key) }}</span>
        </button>
      </div>

      <div class="cards-list">
        <div v-if="store.cardsLoading" class="cards-empty">读取中…</div>

        <template v-else-if="cards.length">
          <article v-for="card in cards" :key="card.id" class="card-item">
            <div class="card-top">
              <span class="card-state" :class="`s-${card.state}`">{{ stateLabel(card) }}</span>
              <span v-if="card.angle" class="card-angle">{{ card.angle }}</span>
              <span class="card-due" :class="{ urgent: card.dueNow }">{{ dueLabel(card) }}</span>
              <div class="card-tools">
                <button
                  class="card-tool"
                  title="回到原文那一行"
                  @click="openNote(card.path, card.sourceLine || undefined)"
                >
                  <ExternalLink :size="13" :stroke-width="1.8" />
                </button>
                <button class="card-tool danger" title="删除这张卡" @click="removeCard(card)">
                  <Trash2 :size="13" :stroke-width="1.8" />
                </button>
              </div>
            </div>

            <div class="card-question">{{ card.question }}</div>

            <div v-if="card.sourceHeading" class="card-source">
              {{ card.sourceHeading }}
              <span v-if="card.sourceLine" class="card-source-line">第 {{ card.sourceLine }} 行</span>
            </div>

            <div v-if="card.answer && card.answer !== card.sourceText" class="card-answer">
              {{ card.answer }}
            </div>

            <div class="card-meta">
              <span>复习 {{ card.reps }} 次</span>
              <span v-if="card.lapses">· 忘过 {{ card.lapses }} 次</span>
            </div>
          </article>
        </template>

        <div v-else-if="store.cards.length" class="cards-empty">这个筛选下没有卡片</div>

        <div v-else class="cards-empty cards-hint">
          <Plus :size="15" :stroke-width="1.7" />
          <div>这篇还没有卡片</div>
          <div class="cards-hint-line">
            在编辑器里选中几句陈述，按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> 建卡
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cards-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.cards-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  flex: none;
  padding: 10px 10px 8px;
}

.summary-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 0;
  border-radius: var(--radius);
  background: var(--bg-app);
}

.summary-value {
  color: var(--text-strong);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.summary-value.accent {
  color: var(--accent);
}

.summary-label {
  color: var(--text-faint);
  font-size: 11px;
}

.cards-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 0 10px 8px;
}

.cards-review {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: 7px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 12.5px;
}

.cards-review:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.cards-review:disabled {
  opacity: 0.45;
}

.cards-review-count {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg-app);
  color: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.cards-total {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 11.5px;
}

.cards-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  flex: none;
  padding: 0 10px 8px;
  border-bottom: 1px solid var(--border);
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
}

.filter-chip:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.filter-chip.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}

.filter-count {
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.filter-chip.active .filter-count {
  color: inherit;
  opacity: 0.75;
}

.cards-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.card-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
}

.card-item:hover {
  border-color: var(--border);
  background: var(--bg-hover);
}

.card-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.card-state {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--bg-hover);
  color: var(--text-muted);
  font-size: 10.5px;
}

.card-state.s-new {
  background: var(--accent-bg);
  color: var(--accent);
}

.card-state.s-review {
  color: var(--accent-soft);
}

.card-angle {
  color: var(--text-faint);
  font-size: 11px;
}

.card-due {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.card-due.urgent {
  color: var(--accent);
}

.card-tools {
  display: flex;
  gap: 2px;
  opacity: 0;
}

.card-item:hover .card-tools {
  opacity: 1;
}

.card-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--text-faint);
}

.card-tool:hover {
  background: var(--bg-active);
  color: var(--accent);
}

.card-tool.danger:hover {
  color: var(--danger);
}

.card-question {
  color: var(--text-strong);
  font-size: 13px;
  line-height: 1.55;
}

.card-source {
  color: var(--text-faint);
  font-size: 11.5px;
}

.card-source-line {
  margin-left: 6px;
  opacity: 0.8;
}

.card-answer {
  padding-left: 8px;
  border-left: 2px solid var(--border-strong);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.card-meta {
  display: flex;
  gap: 5px;
  color: var(--text-faint);
  font-size: 11px;
}

.cards-empty {
  padding: 18px 12px;
  color: var(--text-faint);
  font-size: 12.5px;
  text-align: center;
}

.cards-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}

.cards-hint-line {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.7;
}

.cards-hint kbd {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10.5px;
}
</style>
