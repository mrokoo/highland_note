<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { resolveConfirm, resolvePrompt, store } from "../lib/store";

const input = ref<HTMLInputElement | null>(null);
const promptValue = ref("");

watch(
  () => store.prompt,
  async (prompt) => {
    if (!prompt) return;
    promptValue.value = prompt.value;
    await nextTick();
    input.value?.focus();
    input.value?.select();
  },
  { immediate: true },
);

function confirmPrompt() {
  const value = promptValue.value.trim();
  if (!value) return;
  resolvePrompt(value);
}
</script>

<template>
  <div v-if="store.prompt" class="overlay centered" @click.self="resolvePrompt(null)">
    <div class="panel modal">
      <h3>{{ store.prompt.title }}</h3>
      <label v-if="store.prompt.label">{{ store.prompt.label }}</label>
      <input
        ref="input"
        v-model="promptValue"
        @keydown.enter.prevent="confirmPrompt"
        @keydown.esc.prevent="resolvePrompt(null)"
      />
      <div class="modal-actions">
        <button class="button" @click="resolvePrompt(null)">取消</button>
        <button class="button primary" @click="confirmPrompt">
          {{ store.prompt.confirmText }}
        </button>
      </div>
    </div>
  </div>

  <div v-if="store.confirm" class="overlay centered" @click.self="resolveConfirm(false)">
    <div class="panel modal">
      <h3>{{ store.confirm.title }}</h3>
      <p>{{ store.confirm.message }}</p>
      <div class="modal-actions">
        <button class="button" @click="resolveConfirm(false)">取消</button>
        <button
          class="button"
          :class="store.confirm.danger ? 'danger' : 'primary'"
          @click="resolveConfirm(true)"
        >
          {{ store.confirm.confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>
