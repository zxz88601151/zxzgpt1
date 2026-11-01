---
name: React 18 + TypeScript 组件规范
description: 写 React 组件、Hooks、状态管理时的硬规则：数据流单向、依赖数组完整、不滥用 effect、可访问性到位。
triggers: [react, 组件, hooks, tsx, jsx, 前端, useState, useEffect, 页面]
version: 1.0.0
category: 前端
stage: write
---

# React 18 + TypeScript 组件规范

适用范围：React 18 函数组件 + TypeScript + Vite。类组件、Vue、Svelte 不适用。

## 硬规则

1. **组件只从 props 和 hooks 拿数据**。不要在组件里直接读 `localStorage`、`document.querySelector`、全局可变对象；这类访问放在边界层（store、api 模块）或 `useEffect` 里并说明理由。
2. **props 用 interface 显式声明**，可选值写成 `x?: T` 而不是 `x: T | undefined`；不写 `any`，实在不确定用 `unknown` 再收窄。
3. **`useEffect` 只用来同步外部系统**（订阅、定时器、DOM API、网络请求）。能用事件处理函数、`useMemo`、派生计算解决的，不许用 effect。
4. **依赖数组必须完整且稳定**。回调函数进依赖时用 `useCallback`，对象/数组用 `useMemo`，否则每次都重建，effect 反复执行。
5. **每个 effect 都要有清理**：`clearTimeout`、`removeEventListener`、`abort()`、`unsubscribe()`。订阅类不清理就是内存泄漏。
6. **列表渲染用稳定 key**：用业务 id，禁止用数组下标（除非列表只追加不改序）。
7. **状态尽量向上、尽量少**。能由已有状态算出来的不要再存一份；同一份数据不要在父子各自存一份。
8. **异步请求处理三态**：加载中、成功、失败。失败要有可读文案，不要静默 `catch {}`。
9. **受控优先**。输入框、下拉框统一用 `value` + `onChange`，不要用 `defaultValue` 再手动读 DOM。
10. **可访问性是最低要求**：可点击元素用 `<button>`/`<a>`，图标按钮必须有 `aria-label` 或 `title`，弹层加 `role="dialog"` `aria-modal`，Esc 能关。
11. **样式按语义命名**（`.msg-foot`），不写内联魔法色值；颜色、间距走 CSS 变量。
12. **组件文件超过 200 行就拆**：容器负责取数与交互，展示组件只接收 props。

## 输出约定

- 一个组件一个文件，文件名与组件同名（`Composer.tsx`）。
- 导出用命名导出，默认导出只用于页面入口。
- 类型放顶部或单独 `types.ts`，不要散落在 JSX 中间。

## 自检清单

- [ ] 每个 `useEffect` 都有对应清理，依赖数组没有漏项
- [ ] 所有列表有稳定 key
- [ ] 异步路径有失败分支与用户可见文案
- [ ] 交互元素语义正确（button / a / label），图标有可读名称
- [ ] 没有 `any`、没有 `eslint-disable`、没有注释掉的旧代码
- [ ] 派生状态没有重复存储

## 常见反例

```tsx
// 反例：effect 里手动同步可派生状态，且没有清理
const [total, setTotal] = useState(0);
useEffect(() => {
  setTotal(items.reduce((s, i) => s + i.price, 0));
}, []); // 依赖漏了 items
```

```tsx
// 正例：直接派生
const total = useMemo(() => items.reduce((s, i) => s + i.price, 0), [items]);

// 正例：effect 只用于外部系统，且有清理
useEffect(() => {
  const controller = new AbortController();
  loadProfile(userId, controller.signal)
    .then(setProfile)
    .catch((e: Error) => {
      if (e.name !== "AbortError") setError(e.message);
    });
  return () => controller.abort();
}, [userId]);
```
