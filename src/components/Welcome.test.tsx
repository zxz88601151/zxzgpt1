// @vitest-environment jsdom
/** 组件层 DOM 回归：欢迎页两种空状态与引导卡片的点击契约。
 *
 *  为什么从这两个小组件开始（DEC-020）：ADR 0001 要求把 App.tsx 拆到 < 500 行，
 *  但组件层此前只有 FileWrites 一个 jsdom 测试，硬拆 30+ props 的大组件没有回归网。
 *  先给边界清晰、props 少的展示组件补判据，再谈拆 JSX。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Welcome } from "./Welcome";
import { WELCOME_CHIPS } from "../presets";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Welcome 空状态", () => {
  it("一个会话都没有时给引导文案，不渲染引导卡片", () => {
    act(() => root.render(<Welcome model="gpt-4o" noConv onChip={vi.fn()} />));
    expect(container.textContent).toContain("开始一段对话");
    expect(container.textContent).toContain("API Key");
    expect(container.querySelectorAll(".chip")).toHaveLength(0);
    expect(container.querySelector(".hero-badge")?.textContent).toBe("z");
  });

  it("有会话时显示当前模型与全部引导卡片", () => {
    act(() => root.render(<Welcome model="qwen2.5:7b" onChip={vi.fn()} />));
    expect(container.textContent).toContain("有什么可以帮你的？");
    expect(container.textContent).toContain("qwen2.5:7b");
    expect(container.querySelectorAll(".chip")).toHaveLength(WELCOME_CHIPS.length);
  });

  it("模型为空时显示「尚未配置」，不留下空白", () => {
    act(() => root.render(<Welcome model="" onChip={vi.fn()} />));
    expect(container.textContent).toContain("尚未配置");
  });

  it("点引导卡片只把 body 交给 onChip（不自动发送、不改输入框）", () => {
    const onChip = vi.fn();
    act(() => root.render(<Welcome model="m" onChip={onChip} />));
    const first = container.querySelector(".chip") as HTMLButtonElement;
    act(() => first.click());
    expect(onChip).toHaveBeenCalledTimes(1);
    expect(onChip).toHaveBeenCalledWith(WELCOME_CHIPS[0].body);
    expect(container.querySelector("textarea")).toBeNull();
  });
});
