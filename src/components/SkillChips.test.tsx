// @vitest-environment jsdom
/** 组件层 DOM 回归：技能条只显示已启用技能，× 与开面板回调的边界。 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillChips } from "./SkillChips";
import type { Skill } from "../lib/skill";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const skill = (id: string, name: string): Skill =>
  ({ id, name, body: "", description: `说明-${id}` } as Skill);
const skills = [skill("a", "技能A"), skill("b", "技能B"), skill("c", "技能C")];

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

describe("SkillChips 技能条", () => {
  it("只渲染已启用的技能，按钮上带数量", () => {
    act(() => root.render(<SkillChips skills={skills} active={["a", "c"]} onToggle={vi.fn()} onOpen={vi.fn()} />));
    const chips = [...container.querySelectorAll(".skill-chip")];
    expect(chips.map((c) => c.getAttribute("data-id"))).toEqual(["a", "c"]);
    expect(container.querySelector(".skill-open")?.textContent).toContain("技能 2");
  });

  it("没启用任何技能时只剩一个「技能」按钮，不显示 0", () => {
    act(() => root.render(<SkillChips skills={skills} active={[]} onToggle={vi.fn()} onOpen={vi.fn()} />));
    expect(container.querySelectorAll(".skill-chip")).toHaveLength(0);
    const label = container.querySelector(".skill-open")?.textContent ?? "";
    expect(label).toContain("技能");
    expect(label).not.toContain("技能 0");
  });

  it("active 里不存在的 id 不会凭空造出 chip", () => {
    act(() => root.render(<SkillChips skills={skills} active={["ghost"]} onToggle={vi.fn()} onOpen={vi.fn()} />));
    expect(container.querySelectorAll(".skill-chip")).toHaveLength(0);
  });

  it("点 × 把该技能 id 交给 onToggle；点开面板调 onOpen", () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    act(() => root.render(<SkillChips skills={skills} active={["a"]} onToggle={onToggle} onOpen={onOpen} />));
    act(() => (container.querySelector(".skill-chip-x") as HTMLButtonElement).click());
    expect(onToggle).toHaveBeenCalledWith("a");
    act(() => (container.querySelector(".skill-open") as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("disabled 时 × 不可点，onToggle 不触发（忙时不允许改技能）", () => {
    const onToggle = vi.fn();
    act(() => root.render(<SkillChips skills={skills} active={["a"]} disabled onToggle={onToggle} onOpen={vi.fn()} />));
    const x = container.querySelector(".skill-chip-x") as HTMLButtonElement;
    expect(x.disabled).toBe(true);
    act(() => x.click());
    expect(onToggle).not.toHaveBeenCalled();
  });
});
