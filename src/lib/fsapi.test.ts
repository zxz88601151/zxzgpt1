/** fsapi 契约测试：守住「文件和命令 IPC 只认 sessionId」这条边界。
 *
 * 迁移前每个文件/命令 IPC 都带一个 root，工程边界只是前端约定；
 * 迁移后 root 只在 ws_open 里出现一次，其余命令一律只带 sessionId。
 * 这里把 invoke 换成记录器，逐条断言发出去的参数形状——
 * 这是「不再依赖前端传入 root」唯一能在本机跑的自动化检查。
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildTree,
  fsAvailable,
  fsExists,
  fsListIn,
  fsRead,
  fsWrite,
  runAllowed,
  sessionFor,
  wsClose,
  wsInfo,
  wsOpen,
} from "./fsapi";
import { listUndo, restoreUndo } from "./undo";

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

let calls: Call[] = [];
let handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {};

function installDesktop(impl: Record<string, (args?: Record<string, unknown>) => unknown> = {}): void {
  calls = [];
  handlers = impl;
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        const h = handlers[cmd];
        if (!h) throw new Error("未实现的命令：" + cmd);
        return h(args);
      },
    },
  };
}

function uninstallDesktop(): void {
  // 浏览器直开：window 在，但没有 Tauri 通道
  (globalThis as unknown as { window: unknown }).window = {};
  calls = [];
  handlers = {};
}

function lastOf(cmd: string): Call {
  const hit = calls.filter((c) => c.cmd === cmd).pop();
  if (!hit) throw new Error("没调用过 " + cmd);
  return hit;
}

beforeEach(() => {
  installDesktop();
});

describe("文件与命令 IPC 只带 sessionId", () => {
  it("fs_exists 报错必须抛出，不能当成「不存在」", async () => {
    // 「确认不存在」和「校验失败」是两件事：后者被吞成 false，覆盖写入就会
    // 以为这是新建文件、跳过备份，把一次越界校验失败变成一次不可撤销的覆盖。
    installDesktop({
      fs_exists: () => {
        throw new Error("越出了工程目录");
      },
    });
    await expect(fsExists("ws-1", "../outside.txt")).rejects.toThrow("越出了工程目录");
  });

  it("读 / 写 / 查 / 列目录 / 跑命令都不再出现 root", async () => {
    installDesktop({
      fs_read: () => "content",
      fs_write: () => ({ path: "/p/a.ts", bytes: 3, created: true }),
      fs_exists: () => true,
      fs_list_in: () => [],
      run_allowed: () => ({ exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false }),
    });

    await fsRead("ws-1", "src/a.ts");
    await fsWrite("ws-1", "src/a.ts", "abc");
    await fsExists("ws-1", "src/a.ts");
    await fsListIn("ws-1", "src");
    await runAllowed("ws-1", ["npm", "test"]);

    for (const cmd of ["fs_read", "fs_write", "fs_exists", "fs_list_in", "run_allowed"]) {
      const { args } = lastOf(cmd);
      expect(args?.sessionId, cmd + " 必须带 sessionId").toBe("ws-1");
      expect(args && "root" in args, cmd + " 不能带 root").toBe(false);
    }
    expect(lastOf("fs_read").args?.rel).toBe("src/a.ts");
    expect(lastOf("fs_write").args).toMatchObject({ sessionId: "ws-1", rel: "src/a.ts", content: "abc" });
    expect(lastOf("run_allowed").args?.argv).toEqual(["npm", "test"]);
  });

  it("root 只在 ws_open 里出现一次", async () => {
    installDesktop({ ws_open: () => ({ id: "ws-abc", root: "F:\\proj", name: "proj" }) });
    const s = await wsOpen("F:\\proj");
    expect(s.id).toBe("ws-abc");
    // ws_open 收 root，但它不收 rel：它是登记入口，不是读写通道
    expect(lastOf("ws_open").args).toEqual({ root: "F:\\proj" });
  });

  it("会话关闭与查询只带 sessionId", async () => {
    installDesktop({ ws_info: () => ({ id: "ws-1", root: "F:\\proj", name: "proj" }), ws_close: () => null });
    await wsInfo("ws-1");
    await wsClose("ws-1");
    expect(lastOf("ws_info").args).toEqual({ sessionId: "ws-1" });
    expect(lastOf("ws_close").args).toEqual({ sessionId: "ws-1" });
  });
});

describe("目录树与撤销栈走会话通道", () => {
  it("buildTree 用 fs_list_in 递归，不带绝对路径", async () => {
    installDesktop({
      fs_list_in: (args) => {
        const rel = String(args?.rel ?? "");
        if (rel === "") return [{ name: "src", path: "/p/src", dir: true, size: 0 }];
        if (rel === "src") return [{ name: "a.ts", path: "/p/src/a.ts", dir: false, size: 12 }];
        return [];
      },
    });
    const tree = await buildTree("ws-1", 2);
    expect(tree).toContain("src");
    expect(tree).toContain("a.ts");
    const listed = calls.filter((c) => c.cmd === "fs_list_in").map((c) => String(c.args?.rel));
    expect(listed).toEqual(["", "src"]);
    for (const c of calls) {
      expect(c.args?.sessionId).toBe("ws-1");
      expect("root" in (c.args ?? {})).toBe(false);
    }
  });

  it("撤销栈按 sessionId 列出快照，rel 仍是工程内路径", async () => {
    installDesktop({
      fs_list_in: (args) => {
        const rel = String(args?.rel ?? "");
        if (rel === ".zxz/undo") return [{ name: "2026-11-01T02-49-32", path: "/p/.zxz/undo/2026-11-01T02-49-32", dir: true, size: 0 }];
        if (rel === ".zxz/undo/2026-11-01T02-49-32") return [{ name: "src", path: "/p/.zxz/undo/2026-11-01T02-49-32/src", dir: true, size: 0 }];
        if (rel === ".zxz/undo/2026-11-01T02-49-32/src") {
          return [{ name: "a.ts", path: "/p/.zxz/undo/2026-11-01T02-49-32/src/a.ts", dir: false, size: 21 }];
        }
        return [];
      },
    });
    const snaps = await listUndo("ws-1");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].stamp).toBe("2026-11-01T02-49-32");
    expect(snaps[0].files).toEqual([{ rel: "src/a.ts", bytes: 21 }]);
    for (const c of calls) {
      expect(c.cmd).toBe("fs_list_in");
      expect(c.args?.sessionId).toBe("ws-1");
    }
  });

  it("恢复某一版也只走 sessionId", async () => {
    installDesktop({
      fs_read: () => "old",
      fs_write: () => ({ path: "/p/src/a.ts", bytes: 3, created: false }),
    });
    const r = await restoreUndo("ws-1", "2026-11-01T02-49-32", "src/a.ts");
    expect(r.bytes).toBe(3);
    for (const c of calls) {
      expect(c.args?.sessionId).toBe("ws-1");
      expect("root" in (c.args ?? {})).toBe(false);
    }
  });
});

describe("sessionFor 的会话复用", () => {
  it("同一目录复用会话号，会话失效后重新登记", async () => {
    let alive = true;
    installDesktop({
      ws_open: (args) => ({ id: "ws-" + String(args?.root).slice(-1), root: String(args?.root), name: "n" }),
      ws_info: () => {
        if (!alive) throw new Error("会话已关闭");
        return { id: "ws-t", root: "/t", name: "t" };
      },
    });

    const a = await sessionFor("/tmp/lib");
    const b = await sessionFor("/tmp/lib");
    expect(a).toBe(b); // 同一目录不该反复开会话
    expect(calls.filter((c) => c.cmd === "ws_open")).toHaveLength(1);

    // 会话被 Rust 侧关掉（进程重启）后要重新登记，而不是继续用失效的 id
    alive = false;
    const c = await sessionFor("/tmp/lib");
    expect(calls.filter((x) => x.cmd === "ws_open")).toHaveLength(2);
    expect(c).toBeTruthy();
  });
});

describe("浏览器直开时", () => {
  it("没有桌面通道就不可用，调用直接报错", async () => {
    uninstallDesktop();
    expect(fsAvailable()).toBe(false);
    await expect(fsRead("ws-1", "a.ts")).rejects.toThrow("桌面端");
    installDesktop();
  });
});
