# Highland Note 功能一览

这是一篇用来演示渲染效果的笔记：标题、列表、引用、代码、表格、任务、双链、标签。

## 文本样式

**加粗**、*斜体*、~~删除线~~、`行内代码`，以及 [外部链接](https://tauri.app)。

光标不在这一行时，这些标记都会藏起来，只留下排版后的样子；把光标移到某一行，那一行才会露出原始语法。

---

![仓库里的图片会直接显示出来](sample-image.png)

## 列表

1. 有序列表第一项
2. 第二项
   - 嵌套无序项
   - 再来一项

## 引用

> 光标停在某一行时，那一行会显示原始 Markdown 标记；移开光标，标记自动隐藏。

## 代码

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

```rust
#[tauri::command]
fn read_note(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}
```

## 表格

| 项目 | 说明 |
| --- | --- |
| 编辑器 | CodeMirror 6 |
| 渲染 | markdown-it + highlight.js |
| 存储 | 本地 Markdown 文件 |

## 任务

- [x] 打开仓库
- [x] 打开笔记
- [ ] 待你补充

## 关联

回到 [[欢迎]]，或看看 [[Highland Note 路线图]]。

#功能 #说明


# H1
## H2

