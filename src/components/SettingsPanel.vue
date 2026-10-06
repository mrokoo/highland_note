<script setup lang="ts">
import { closeVault, pickVault, setTheme, store } from "../lib/store";

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
