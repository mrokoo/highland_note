import { reactive } from "vue";

/** 文件树拖拽的共享状态。 */
export const dnd = reactive({
  /** 正在拖动的条目路径 */
  path: "",
  /** 当前悬停的目标：文件夹路径，或 `__root__` 表示仓库根目录 */
  over: "",
});

export const ROOT_DROP = "__root__";
