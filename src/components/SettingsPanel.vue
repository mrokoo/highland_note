<script setup lang="ts">
import { ref } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { closeVault, pickVault, setTheme, store, toast } from "../lib/store";

/** 笔记正文只在库里，所以"导出"和"备份"是两条安全网。 */
const backups = ref<string[]>([]);
const busy = ref(false);

async function loadBackups() {
  if (!store.vault) return;
  try {
    backups.value = await api.listBackups();
  } catch {
    backups.value = [];
  }
}

async function exportAll() {
  const picked = await openDialog({
    directory: true,
    title: "选择导出目录（每篇笔记一个 .md 文件）",
  });
  if (typeof picked !== "string") return;
  busy.value = true;
  try {
    const count = await api.exportMarkdown(picked);
    toast(`已导出 ${count} 篇笔记到 ${picked}`);
  } catch (error) {
    toast(String(error));
  } finally {
    busy.value = false;
  }
}

void loadBackups();

async function switchVault() {
  store.showSettings = false;
  await pickVault();
}

async function shutdownVault() {
  store.showSettings = false;
  await closeVault();
}
</script>

<template>
  <div class="overlay centered" @click.self="store.showSettings = false">
    <div class="panel settings-panel">
      <h3>设置</h3>

      <div class="setting-row">
        <div class="setting-label">主题</div>
        <div class="segmented">
          <button :class="{ active: store.settings.theme === 'dark' }" @click="setTheme('dark')">
            深色
          </button>
          <button :class="{ active: store.settings.theme === 'light' }" @click="setTheme('light')">
            浅色
          </button>
        </div>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">编辑器字号</div>
          <div class="setting-hint">13 – 26 px</div>
        </div>
        <input v-model.number="store.settings.fontSize" type="number" min="13" max="26" />
      </div>

      <div class="setting-row">
        <div class="setting-label">显示行号</div>
        <input v-model="store.settings.showLineNumbers" type="checkbox" />
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">导出全部为 Markdown</div>
          <div class="setting-hint">笔记只在库里，导出是一份可读快照（归档 / 迁移用）</div>
        </div>
        <button class="button" :disabled="busy || !store.vault" @click="exportAll">选择目录…</button>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">自动备份</div>
          <div class="setting-hint">
            每天首次打开时快照到 .rnote/backups/，保留 14 份{{ backups.length ? `（现有 ${backups.length} 份，最新 ${backups[0]}）` : "" }}
          </div>
        </div>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">编辑器最大宽度</div>
          <div class="setting-hint">0 表示铺满窗口</div>
        </div>
        <input v-model.number="store.settings.editorWidth" type="number" min="0" max="2000" step="40" />
      </div>

      <div class="setting-row">
        <div class="setting-label">默认视图</div>
        <select v-model="store.settings.viewMode">
          <option value="edit">编辑</option>
          <option value="split">分栏</option>
          <option value="preview">预览</option>
        </select>
      </div>

      <div class="setting-row">
        <div>
          <div class="setting-label">当前仓库</div>
          <div class="setting-hint">{{ store.vault?.path ?? "未打开" }}</div>
        </div>
        <div style="display: flex; gap: 8px">
          <button class="button" @click="switchVault">切换</button>
          <button class="button" @click="shutdownVault">关闭</button>
        </div>
      </div>

      <div class="modal-actions">
        <button class="button primary" @click="store.showSettings = false">完成</button>
      </div>
    </div>
  </div>
</template>
