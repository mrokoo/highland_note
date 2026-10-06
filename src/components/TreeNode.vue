<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight, FileText, Folder } from "lucide-vue-next";
import type { FileNode } from "../lib/api";
import { moveEntry, openNote, store, toggleFolder } from "../lib/store";
import { dnd } from "../lib/dnd";

const props = defineProps<{ node: FileNode; depth: number }>();
const emit = defineEmits<{ (e: "menu", payload: { event: MouseEvent; node: FileNode }): void }>();

const expanded = computed(() => !!store.expanded[props.node.path]);
const active = computed(() => !props.node.isDir && store.activePath === props.node.path);
const isDropTarget = computed(
  () => props.node.isDir && dnd.over === props.node.path && dnd.path !== props.node.path,
);
const children = computed(() => props.node.children ?? []);

function onClick() {
  if (props.node.isDir) toggleFolder(props.node.path);
  else void openNote(props.node.path);
}

function onContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  emit("menu", { event, node: props.node });
}

function onDragStart(event: DragEvent) {
  dnd.path = props.node.path;
  event.dataTransfer?.setData("text/plain", props.node.path);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd() {
  dnd.path = "";
  dnd.over = "";
}

function onDragOver(event: DragEvent) {
  if (!props.node.isDir || !dnd.path || dnd.path === props.node.path) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dnd.over = props.node.path;
}

function onDragLeave() {
  if (dnd.over === props.node.path) dnd.over = "";
}

function onDrop(event: DragEvent) {
  if (!props.node.isDir || !dnd.path || dnd.path === props.node.path) return;
  event.preventDefault();
  event.stopPropagation();
  const source = dnd.path;
  dnd.path = "";
  dnd.over = "";
  void moveEntry(source, props.node.path);
}
</script>

<template>
  <div>
    <div
      class="tree-row"
      :class="{ active, 'drop-target': isDropTarget }"
      :style="{ paddingLeft: `${6 + depth * 14}px` }"
      draggable="true"
      @click="onClick"
      @contextmenu="onContextMenu"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <ChevronRight v-if="node.isDir" class="twisty" :class="{ open: expanded }" :size="13" :stroke-width="2.4" />
      <span v-else class="twisty" />
      <Folder v-if="node.isDir" class="node-icon" :size="14" :stroke-width="1.9" />
      <FileText v-else class="node-icon dim" :size="14" :stroke-width="1.9" />
      <!-- 提示只挂在文件名上：挂在整行会让原生提示框正好盖住右边的「⋯」 -->
      <span class="label" :title="node.path">{{ node.name }}</span>
      <span class="row-actions">
        <button title="更多操作" @click.stop="onContextMenu">⋯</button>
      </span>
    </div>

    <template v-if="node.isDir && expanded">
      <TreeNode
        v-for="child in children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        @menu="(payload) => emit('menu', payload)"
      />
    </template>
  </div>
</template>

<style scoped>
.node-icon {
  flex: none;
  opacity: 0.75;
}

.node-icon.dim {
  opacity: 0.55;
}
</style>
