<script setup lang="ts">
import { forgetVault, openVault, pickVault, store } from "../lib/store";
</script>

<template>
  <div class="welcome">
    <div class="welcome-card">
      <h1>Highland Note</h1>
      <p class="subtitle">本地优先的 Markdown 笔记：一个文件夹就是一个仓库</p>

      <div class="welcome-actions">
        <button class="button primary" @click="pickVault">打开文件夹作为仓库</button>
      </div>

      <div v-if="store.settings.recentVaults.length" class="recent-list">
        <div class="label">最近打开</div>
        <div
          v-for="path in store.settings.recentVaults"
          :key="path"
          class="recent-item"
          @click="openVault(path)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span class="r-name">{{ path.split(/[\\/]/).pop() }}</span>
          <span class="r-path">{{ path }}</span>
          <button class="r-forget" title="从列表移除" @click.stop="forgetVault(path)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>
