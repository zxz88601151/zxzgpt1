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
  ExecGrantRequired,
  fsAvailable,
  fsExists,
  fsListIn,
  fsRead,
  fsWrite,
  permGrant,
  permRevoke,
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

  it("撤销栈走 undo_list 专用通道，前端不再自己拼 .zxz/undo 路径", async () => {
    installDesktop({
      undo_list: (args) => {
        // stamp 为 null：列快照目录；给出时 rel 是相对该快照的路径
        if (args?.stamp == null) {
          return [{ name: "2026-11-01T02-49-32-123", path: "/p/.zxz/undo/2026-11-01T02-49-32-123", dir: true, size: 0 }];
        }
        if (args.stamp === "2026-11-01T02-49-32-123" && args.rel === "") {
          return [{ name: "src", path: "/p/.zxz/undo/2026-11-01T02-49-32-123/src", dir: true, size: 0 }];
        }
        if (args.stamp === "2026-11-01T02-49-32-123" && args.rel === "src") {
          return [{ name: "a.ts", path: "/p/.zxz/undo/2026-11-01T02-49-32-123/src/a.ts", dir: false, size: 21 }];
        }
        return [];
      },
    });
    const snaps = await listUndo("ws-1");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].stamp).toBe("2026-11-01T02-49-32-123");
    expect(snaps[0].files).toEqual([{ rel: "src/a.ts", bytes: 21 }]);
    // 关键：普通 fs_read / fs_list_in 对 .zxz/undo 已在 Rust 侧关闭，
    // 撤销面板只能走专用通道；这里断言它一条普通通道都没碰。
    const ordinary = calls.filter((c) => c.cmd === "fs_read" || c.cmd === "fs_list_in" || c.cmd === "fs_exists");
    expect(ordinary).toHaveLength(0);
    for (const c of calls) {
      expect(c.cmd).toBe("undo_list");
      expect(c.args?.sessionId).toBe("ws-1");
      expect("root" in (c.args ?? {})).toBe(false);
    }
  });

  it("撤销目录不存在时返回空栈，不算故障（Rust 侧返回空数组，前端不预探）", async () => {
    installDesktop({ undo_list: () => [] });
    expect(await listUndo("ws-1")).toEqual([]);
    expect(calls.map((c) => c.cmd)).toEqual(["undo_list"]);
  });

  it("撤销目录存在却列不出来必须报错，不能装作没有快照", async () => {
    installDesktop({
      undo_list: () => {
        throw new Error("权限不足");
      },
    });
    await expect(listUndo("ws-1")).rejects.toThrow("权限不足");
  });

  it("恢复某一版走 undo_write 备份、undo_read 读正文，正文写回仍走 fs_write", async () => {
    installDesktop({
      fs_exists: () => true,
      fs_read: () => "old",
      undo_read: () => "SNAPSHOT",
      undo_write: () => ({ path: "/p/.zxz/undo/x/src/a.ts", bytes: 3, created: true }),
      fs_write: () => ({ path: "/p/src/a.ts", bytes: 3, created: false }),
    });
    const r = await restoreUndo("ws-1", "2026-11-01T02-49-32-123", "src/a.ts");
    expect(r.bytes).toBe(3);
    expect(r.safety).not.toBeNull();
    // 备份必须走专用通道：普通写通道在 Rust 侧已经拒绝 .zxz/undo
    const backupCall = calls.find((c) => c.cmd === "undo_write");
    expect(backupCall).toBeTruthy();
    expect(backupCall?.args?.rel).toBe("src/a.ts");
    expect(String(backupCall?.args?.stamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/);
    // 快照正文只能从 undo_read 取；普通 fs_read 对 .zxz/undo 已关闭
    const snapshotRead = calls.find((c) => c.cmd === "undo_read");
    expect(snapshotRead?.args?.stamp).toBe("2026-11-01T02-49-32-123");
    expect(snapshotRead?.args?.rel).toBe("src/a.ts");
    expect(calls.filter((c) => c.cmd === "fs_read").every((c) => c.args?.rel === "src/a.ts")).toBe(true);
    // 正文写回不能也走 undo_write
    expect(calls.filter((c) => c.cmd === "fs_write")).toHaveLength(1);
    for (const c of calls) {
      expect(c.args?.sessionId).toBe("ws-1");
      expect("root" in (c.args ?? {})).toBe(false);
    }
  });

  it("备份写不进去时恢复必须中止，不能覆盖成不可撤销", async () => {
    installDesktop({
      fs_exists: () => true,
      fs_read: () => "old",
      undo_read: () => "SNAPSHOT",
      undo_write: () => {
        throw new Error("磁盘满了");
      },
      fs_write: () => ({ path: "/p/src/a.ts", bytes: 3, created: false }),
    });
    await expect(restoreUndo("ws-1", "2026-11-01T02-49-32-123", "src/a.ts")).rejects.toThrow("已中止恢复");
    // 关键：正文一个字节都不能被写出去
    expect(calls.some((c) => c.cmd === "fs_write")).toBe(false);
  });

  it("当前内容读不出来（超大/二进制）时同样中止，不静默跳过备份", async () => {
    installDesktop({
      fs_exists: () => true,
      undo_read: () => "SNAPSHOT",
      fs_read: () => {
        // 快照正文已由 undo_read 拿到；这里是工程里的当前文件，读不出来
        throw new Error("超过 4MB");
      },
    });
    await expect(restoreUndo("ws-1", "2026-11-01T02-49-32-123", "src/a.ts")).rejects.toThrow("已中止");
    expect(calls.some((c) => c.cmd === "fs_write" || c.cmd === "undo_write")).toBe(false);
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

describe("exec 闸门的错误语义", () => {
  it("need_grant 还原成 ExecGrantRequired，界面才知道要弹框", async () => {
    installDesktop({
      run_allowed: () => {
        throw JSON.stringify({ kind: "need_grant", scope: ["npm", "test"], label: "npm test" });
      },
    });
    const err = await runAllowed("ws-1", ["npm", "test"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecGrantRequired);
    expect((err as ExecGrantRequired).scope).toEqual(["npm", "test"]);
    expect((err as ExecGrantRequired).label).toBe("npm test");
  });

  it("refused 是普通 Error，带白名单给的原因", async () => {
    installDesktop({
      run_allowed: () => {
        throw JSON.stringify({ kind: "refused", reason: "npm 只允许 test、run build、run lint、--version" });
      },
    });
    const err = await runAllowed("ws-1", ["npm", "install"]).catch((e: unknown) => e);
    // 这条最要紧：不能变成 ExecGrantRequired，否则界面会为一个本来就被拒的命令弹框
    expect(err).not.toBeInstanceOf(ExecGrantRequired);
    expect((err as Error).message).toContain("npm 只允许");
  });

  it("不是闸门 JSON 的错误原样透传", async () => {
    installDesktop({
      run_allowed: () => {
        throw new Error("会话已关闭，请重新接入工程目录");
      },
    });
    await expect(runAllowed("ws-1", ["git", "status"])).rejects.toThrow("会话已关闭");
  });

  it("授权与撤销都只带 sessionId，scope 走结构化数组", async () => {
    installDesktop({
      perm_grant: () => [{ scope: ["npm", "test"], uses_left: null, label: "npm test" }],
      perm_revoke: () => [],
    });
    const grants = await permGrant("ws-1", ["npm", "test"], null, "npm test");
    expect(grants[0].uses_left).toBeNull();
    await permRevoke("ws-1");
    const grantCall = calls.find((c) => c.cmd === "perm_grant");
    expect(grantCall?.args).toEqual({ sessionId: "ws-1", scope: ["npm", "test"], uses: null, label: "npm test" });
    const revokeCall = calls.find((c) => c.cmd === "perm_revoke");
    // 不传 scope 就是清空全部，不能变成"传了个空数组"那种模糊语义
    expect(revokeCall?.args?.scope).toBeUndefined();
    for (const c of calls) {
      expect(c.args?.sessionId).toBe("ws-1");
      expect("root" in (c.args ?? {})).toBe(false);
    }
  });
});
