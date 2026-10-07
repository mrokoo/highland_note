<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { FolderInput, RefreshCw, Zap } from "lucide-vue-next";
import type { NoteStatus, WorkflowNote } from "../lib/api";
import {
  importMaterial,
  openNote,
  refreshReviewStats,
  refreshWorkflow,
  reviewNote,
  setNoteStatus,
  store,
  toast,
} from "../lib/store";

/**
 * 工作台：一眼看清"输入—内化—输出"三段里各有什么，以及哪一件积压了多久。
 *
 * P0 只做笔记级的状态流转；复习排期与成熟度在 P1/P2 接入（见 docs/workflow-design.md §9）。
 */

interface Column {
  key: NoteStatus;
  label: string;
  hint: string;
}

const columns: Column[] = [
  { key: "inbox", label: "待处理", hint: "还没加工。允许乱，但每一件都要做个决定" },
  { key: "internalizing", label: "内化中", hint: "正在用自己的话写、正在反复复习" },
  { key: "output", label: "已输出", hint: "已经讲清楚了，能给别人看" },
  { key: "none", label: "未分类", hint: "还没加入工作流的老笔记；拖进左边三列即可归类" },
];

const KIND_LABEL: Record<string, string> = {
  note: "笔记",
  course: "课程",
  book: "书",
  article: "文章",
  clip: "剪藏",
  idea: "灵感",
  output: "输出",
};

const dragging = ref<string | null>(null);
const hoverColumn = ref<NoteStatus | null>(null);

const counts = computed(() => {
  const map: Record<string, number> = {};
  for (const note of store.workflow) {
    if (note.missing) continue;
    map[note.status] = (map[note.status] ?? 0) + 1;
  }
  return map;
});

const archivedCount = computed(() => counts.value.archived ?? 0);
const missingCount = computed(() => store.workflow.filter((note) => note.missing).length);

function notesOf(key: NoteStatus): WorkflowNote[] {
  return store.workflow
    .filter((note) => note.status === key && !note.missing)
    .sort((a, b) => ageMs(a) - ageMs(b));
}

/** 积压天数：优先看捕获日期，没有就看文件修改时间。 */
function ageMs(note: WorkflowNote): number {
  const base = note.capturedAt ? Date.parse(note.capturedAt) : note.mtime;
  return Number.isFinite(base) && base > 0 ? base : Date.now();
}

function ageDays(note: WorkflowNote): number {
  return Math.floor((Date.now() - ageMs(note)) / 86_400_000);
}

function ageText(note: WorkflowNote): string {
  const days = ageDays(note);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 待处理超过 14 天标黄、30 天标红——不是催你，是让"该删就删"容易一点。 */
function urgency(note: WorkflowNote): string {
  if (note.status !== "inbox") return "";
  const days = ageDays(note);
  if (days >= 30) return "stale";
  if (days >= 14) return "warn";
  return "";
}

async function onDrop(key: NoteStatus) {
  const path = dragging.value;
  dragging.value = null;
  hoverColumn.value = null;
  if (!path) return;
  const note = store.workflow.find((item) => item.path === path);
  if (!note || note.status === key) return;
  await setNoteStatus(path, key);
  toast(`已移到「${columns.find((column) => column.key === key)?.label}」`);
}

async function open(note: WorkflowNote) {
  await openNote(note.path);
  store.showWorkbench = false;
}

/** 这篇笔记有几张卡到期（没有就不显示）。 */
function dueOf(path: string) {
  return store.noteDue[path]?.due ?? 0;
}

onMounted(() => {
  void refreshWorkflow(true);
  void refreshReviewStats();
});
</script>

<template>
  <section class="workbench">
    <header class="wb-head">
      <div class="wb-today">
        <span class="wb-title">今日</span>
        <span class="wb-stat" :class="{ zero: !counts.inbox }">
          待处理 <b>{{ counts.inbox ?? 0 }}</b>
        </span>
        <span class="wb-stat" :class="{ zero: !counts.internalizing }">
          内化中 <b>{{ counts.internalizing ?? 0 }}</b>
        </span>
        <span class="wb-stat" :class="{ zero: !counts.output }">
          已输出 <b>{{ counts.output ?? 0 }}</b>
        </span>
      </div>

      <div class="wb-actions">
        <button class="wb-button primary" title="快速捕获 · Ctrl+Shift+I" @click="store.captureOpen = true">
          <Zap :size="15" :stroke-width="1.9" />
          快速捕获
        </button>
        <button class="wb-button" title="导入录音 / 教材 / 课程材料" @click="importMaterial">
          <FolderInput :size="15" :stroke-width="1.9" />
          导入材料
        </button>
        <button
          class="wb-button"
          :disabled="store.workflowLoading"
          title="重新扫描仓库"
          @click="refreshWorkflow(true)"
        >
          <RefreshCw :size="15" :stroke-width="1.9" :class="{ spinning: store.workflowLoading }" />
          重新扫描
        </button>
      </div>
    </header>

    <div class="wb-board">
      <div
        v-for="column in columns"
        :key="column.key"
        class="wb-column"
        :class="[`col-${column.key}`, { hovering: hoverColumn === column.key }]"
        @dragover.prevent="hoverColumn = column.key"
        @dragleave="hoverColumn = hoverColumn === column.key ? null : hoverColumn"
        @drop.prevent="onDrop(column.key)"
      >
        <div class="wb-column-head" :title="column.hint">
          <span>{{ column.label }}</span>
          <span class="wb-count">{{ counts[column.key] ?? 0 }}</span>
        </div>

        <div class="wb-list">
          <article
            v-for="note in notesOf(column.key)"
            :key="note.path"
            class="wb-card"
            :class="{ dragging: dragging === note.path }"
            draggable="true"
            :title="note.path"
            @dragstart="dragging = note.path"
            @dragend="dragging = null; hoverColumn = null"
            @click="open(note)"
          >
            <div class="wb-card-title">{{ note.title }}</div>
            <div class="wb-card-meta">
              <span class="wb-kind">{{ KIND_LABEL[note.kind] ?? note.kind }}</span>
              <span class="wb-age" :class="urgency(note)">{{ ageText(note) }}</span>
              <span v-if="note.blockCount || note.cardCount" class="wb-size">
                {{ note.blockCount }} 块<template v-if="note.cardCount"> · {{ note.cardCount }} 卡</template>
              </span>
            </div>
            <div v-if="dueOf(note.path)" class="wb-card-due">
              <span class="wb-due-count">{{ dueOf(note.path) }} 张到期</span>
              <button class="wb-due-go" title="只复习这一篇" @click.stop="reviewNote(note.path)">
                复习这篇
              </button>
            </div>
          </article>

          <div v-if="!notesOf(column.key).length" class="wb-empty">
            {{ column.key === "none" ? "都在工作流里了" : "还没有" }}
          </div>
        </div>
      </div>
    </div>

    <footer class="wb-foot">
      <span>拖动卡片可以改状态，状态写在笔记的 frontmatter 里</span>
      <span class="wb-foot-right">
        <template v-if="archivedCount">已归档 {{ archivedCount }} 篇 · </template>
        <template v-if="missingCount">文件暂时找不到 {{ missingCount }} 篇 · </template>
        共 {{ store.workflow.length }} 篇
      </span>
    </footer>
  </section>
</template>

<style scoped>
.workbench {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--bg-editor);
}

/* ---------------------------------------------------------- 顶部今日 */

.wb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  height: 46px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}

.wb-today {
  display: flex;
  align-items: baseline;
  gap: 14px;
}

.wb-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-strong);
}

.wb-stat {
  font-size: 12px;
  color: var(--text-muted);
}

.wb-stat b {
  color: var(--accent);
  font-size: 14px;
  margin-left: 2px;
}

.wb-stat.zero b {
  color: var(--text-faint);
}

.wb-actions {
  display: flex;
  gap: 8px;
}

.wb-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12px;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.wb-button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-strong);
}

.wb-button.primary {
  border-color: transparent;
  background: var(--accent-bg);
  color: var(--accent);
}

.wb-button:disabled {
  opacity: 0.5;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------------------------------------------------------- 看板 */

.wb-board {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.wb-column {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 190px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--bg-sidebar);
  transition: border-color 0.12s, background 0.12s;
}

.wb-column.hovering {
  border-color: var(--accent);
  background: var(--accent-bg);
}

/* 未分类是"还没进工作流"的老笔记，视觉上退后一层 */
.wb-column.col-none {
  background: transparent;
  border-color: var(--border);
}

.wb-column-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  padding: 9px 12px 7px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.wb-count {
  color: var(--text-faint);
  font-weight: 400;
}

.wb-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-height: 60px;
  padding: 0 8px 10px;
  overflow: auto;
}

.wb-card {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  cursor: pointer;
  transition: border-color 0.12s, transform 0.08s;
}

.wb-card:hover {
  border-color: var(--border-strong);
}

.wb-card.dragging {
  opacity: 0.45;
}

.wb-card-title {
  color: var(--text-strong);
  font-size: 13px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.wb-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  color: var(--text-faint);
  font-size: 11px;
}

.wb-kind {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover);
}

.wb-age.warn {
  color: var(--mark);
}

.wb-age.stale {
  color: var(--danger);
}

.wb-size {
  margin-left: auto;
}

.wb-card-due {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}

.wb-due-count {
  color: var(--accent);
  font-size: 11.5px;
}

.wb-due-go {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 11.5px;
}

.wb-due-go:hover {
  background: var(--accent);
  color: #fff;
}

.wb-empty {
  padding: 14px 4px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

/* ---------------------------------------------------------- 底部 */

.wb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  padding: 7px 16px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11.5px;
}
</style>
