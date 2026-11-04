// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileWrites } from "./FileWrites";
import type { FileWriteResult, Workspace } from "../types";
import type { FileBlock } from "../lib/files";
import * as fsapi from "../lib/fsapi";

// 只 mock openPreview：文件回执里点「预览」只该打开窗口，不该触发别的 IPC
vi.mock("../lib/fsapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/fsapi")>();
  return { ...actual, openPreview: vi.fn() };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspace: Workspace = { sessionId: "ws-1", root: "F:/proj", name: "proj", tree: "" };

let container: HTMLDivElement;
let root: Root;

function mount(blocks: FileBlock[], files: FileWriteResult[]) {
  const onApply = vi.fn().mockResolvedValue([]);
  act(() => {
    root.render(<FileWrites blocks={blocks} files={files} workspace={workspace} onApply={onApply} />);
  });
  // 文件列表默认收起，先展开才能看到每个文件的按钮
  act(() => {
    (container.querySelector(".fa-head .link-btn") as HTMLButtonElement | null)?.click();
  });
}

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

describe("FileWrites 预览按钮", () => {
  it("HTML 文件渲染预览按钮，点击用工程根目录拼绝对路径调 openPreview", async () => {
    mount([{ path: "index.html", content: "<h1>hi</h1>" }], [
      { path: "index.html", ok: true, created: true, bytes: 10 },
    ]);

    const btn = container.querySelector(".fa-preview") as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn!.click();
    });
    expect(fsapi.openPreview).toHaveBeenCalledWith("F:/proj/index.html");
  });

  it("非 HTML 文件不渲染预览按钮", () => {
    mount([{ path: "app.py", content: "print(1)" }], [{ path: "app.py", ok: true, created: true, bytes: 10 }]);

    expect(container.querySelector(".fa-preview")).toBeNull();
  });

  it("写入失败的文件不渲染预览按钮", () => {
    mount([{ path: "index.html", content: "<h1>hi</h1>" }], [
      { path: "index.html", ok: false, error: "写不进去" },
    ]);

    expect(container.querySelector(".fa-preview")).toBeNull();
  });
});
