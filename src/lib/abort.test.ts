/** 可取消等待的回归：审批框挂起时点停止，必须立刻结算而不是死锁。 */

import { describe, expect, it, vi } from "vitest";
import { waitAbortable } from "./abort";

describe("waitAbortable", () => {
  it("没有 signal 时就是原 Promise 的结果", async () => {
    await expect(waitAbortable(Promise.resolve("allow"), undefined, "deny")).resolves.toBe("allow");
  });

  it("signal 已中止 → 直接给 fallback，不等原 Promise", async () => {
    const controller = new AbortController();
    controller.abort();
    const never = new Promise<string>(() => {});
    await expect(waitAbortable(never, controller.signal, "deny")).resolves.toBe("deny");
  });

  it("等待中 abort → 立刻以 fallback 结算", async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});
    const p = waitAbortable(never, controller.signal, "deny");
    controller.abort();
    await expect(p).resolves.toBe("deny");
  });

  it("abort 之前原 Promise 先 resolve → 取真实结果", async () => {
    const controller = new AbortController();
    await expect(waitAbortable(Promise.resolve("allow"), controller.signal, "deny")).resolves.toBe("allow");
  });

  it("原 Promise reject 时向外传播，不被 fallback 吞掉", async () => {
    const controller = new AbortController();
    await expect(waitAbortable(Promise.reject(new Error("IPC 断了")), controller.signal, "deny")).rejects.toThrow("IPC 断了");
  });

  it("abort 结算会退订监听；原 Promise 晚到不二次结算", async () => {
    let onAbort: (() => void) | null = null;
    const remove = vi.fn();
    const fakeSignal = {
      aborted: false,
      addEventListener: vi.fn((_type: string, cb: () => void) => { onAbort = cb; }),
      removeEventListener: remove,
    } as unknown as AbortSignal;
    let settle!: (v: string) => void;
    const pending = new Promise<string>((r) => { settle = r; });
    const p = waitAbortable(pending, fakeSignal, "deny");
    onAbort!();
    await expect(p).resolves.toBe("deny");
    expect(remove).toHaveBeenCalledTimes(1);
    settle("allow"); // 晚到的真实选择不能覆盖「已停止」的裁决
    await expect(p).resolves.toBe("deny");
  });
});
