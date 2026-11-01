---
name: 通用代码规范
description: 任何语言的代码都要过的底线：命名、函数边界、错误处理、注释、依赖控制。没选其它专项技能时默认用它。
triggers: [代码, 函数, 重构, 命名, 规范, code, refactor]
version: 1.0.0
category: 通用
stage: write
---

# 通用代码规范

适用范围：任何语言、任何规模。专项技能（React、Python、SQL…）与本技能冲突时，以专项为准。

## 硬规则

1. **先读后改**。动已有文件前必须 `@@read` 拿到真实内容；没读到就说不确定，不要凭猜测重写。改完输出整份文件，禁止「其余不变」「…省略…」。
2. **一个函数只做一件事，只在一个抽象层**。函数体内同时出现「读配置、拼 SQL、格式化输出」这类不同层次的动作就要拆开。
3. **命名说人话**。变量是名词（`pendingJobs`），函数是动词短语（`reserveSeat()`），布尔以 `is/has/can/should` 开头。禁止 `data`、`tmp`、`obj`、`handle()`、`doIt()` 这类空名，除非作用域只有三行。
4. **声明只用 `const` / `let`，禁止 `var`**。默认 `const`，只有确需重新赋值才 `let`；JavaScript 里 `var` 的函数作用域提升是真实缺陷来源。
5. **不留魔法值**。重复出现的字面量、状态码、路径、超时时间提成具名常量或参数；只出现一次且语义自明的不必提。
6. **错误必须被处理，不能只被打印**。每个 `catch` / `except` / `if err` 分支要么恢复、要么转换后上抛、要么显式忽略并写明理由。禁止空 catch。
7. **边界先想清楚**：空集合、单元素、null/None/undefined、0 与负数、超长字符串、并发重复提交。写循环和索引前先确认这些情况的行为。
8. **依赖只增必要项**。能三十行写完的不要引包；新依赖要说明为什么现有依赖做不了。不要为了格式化、工具函数引入整个框架。
9. **没有副作用的逻辑与副作用分离**。纯计算单独成函数，IO / 网络 / 全局状态放在边界层，方便测试。
10. **注释写「为什么」**，不写「是什么」。`// i++ 自增` 这种删掉；`// 这里必须用 <=，否则最后一行会被漏掉` 保留。
11. **不留死代码**。注释掉的旧实现、`if (false)`、没人调用的导出，直接删——版本控制里有历史。

## 输出约定

- 解释写在代码外面，代码块内只有代码。
- 一次改多个文件时，按依赖顺序给出：类型/接口 → 实现 → 调用方 → 测试。
- 说清楚「改了什么、为什么」用 3 行以内；不要复述代码。

## 自检清单

写完逐条确认，只报结论：

- [ ] 每条错误分支都有明确去向（恢复 / 上抛 / 理由充分的忽略）
- [ ] 空值、空集合、越界、超长输入都有定义好的行为
- [ ] 没有未使用的变量、导入、参数
- [ ] 命名读起来像自然语言
- [ ] 新增依赖为 0，或已说明不可替代的原因

## 常见反例

```ts
// 反例：空 catch + 魔法值 + 一个函数干三件事
function handle(d: any) {
  try {
    const r = fetch("http://x/api/" + d);
    if (r.status === 200) return r.json();
  } catch (e) {}
}
```

```ts
// 正例
const TIMEOUT_MS = 8_000;

async function loadProfile(userId: string, signal: AbortSignal): Promise<Profile> {
  const res = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}`, { signal });
  if (!res.ok) throw new HttpError(res.status, `加载用户 ${userId} 失败`);
  return (await res.json()) as Profile;
}
```
