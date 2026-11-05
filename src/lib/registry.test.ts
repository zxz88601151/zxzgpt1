import { describe, expect, it } from "vitest";
import {
  buildToolsPrompt,
  exploreToolDefs,
  findTool,
  isExploreTool,
  parseToolArgs,
  planModeBlocks,
  TOOL_DEFS,
  TOOLS,
  validateToolArgs,
  type ToolContext,
} from "./registry";
import type { RunResult } from "./fsapi";

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    readFile: async () => "",
    listDir: async () => [],
    writeFile: async () => [],
    runCommand: async (): Promise<RunResult> => ({ exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false }),
    webSearch: async () => [],
    ...over,
  };
}

describe("注册表是唯一来源", () => {
  it("TOOL_DEFS 完全由 TOOLS 派生，没有第二条手写清单", () => {
    expect(TOOL_DEFS).toHaveLength(TOOLS.length);
    for (const spec of TOOLS) {
      const def = TOOL_DEFS.find((d) => d.function.name === spec.name);
      expect(def, `${spec.name} 没有对应的函数声明`).toBeTruthy();
      // 三个字段必须逐字节一致：任何一处手写副本都会在这里分叉
      expect(def?.function.description).toBe(spec.description);
      expect(def?.function.parameters).toEqual(spec.parameters);
      expect(def?.type).toBe("function");
    }
  });

  it("工具名不重复，且 findTool 精确命中", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(findTool(n)?.name).toBe(n);
  });

  it("未注册的工具名一律拒绝，不做别名归一", () => {
    // 变形一旦被归一成同一个工具，参数校验与权限等级的对应关系就变成模糊匹配，
    // 而模糊匹配正是绕过拦截的经典入口。所以这里逐个确认它们落空。
    for (const alias of ["shell_exec", "exec", "", "Run_Command", "RUN_COMMAND", " run_command", "run_command ", "run-command", "writeFile"]) {
      expect(findTool(alias), `${JSON.stringify(alias)} 不该命中任何工具`).toBeNull();
      expect(validateToolArgs(alias, {})).toBe(`未知工具：${alias}`);
    }
  });
});

describe("权限等级", () => {
  it("每个工具都标了等级，只读工具不被计划模式拦", () => {
    for (const spec of TOOLS) {
      expect(["read", "write", "exec"]).toContain(spec.access);
    }
    // 计划模式必须拦住所有会改磁盘或起进程的工具，且只拦这两类
    const blocked = TOOLS.filter((t) => planModeBlocks(t.access)).map((t) => t.name).sort();
    const risky = TOOLS.filter((t) => t.access === "write" || t.access === "exec").map((t) => t.name).sort();
    expect(blocked).toEqual(risky);
    expect(blocked).toEqual(["apply_patch", "edit_file", "run_command", "write_file"]);
    for (const t of TOOLS) {
      if (t.access === "read") expect(planModeBlocks(t.access)).toBe(false);
    }
  });

  it("系统提示里的拦截清单与权限等级一致，不靠手写", () => {
    const prompt = buildToolsPrompt(true, false);
    // 文案由 TOOLS 顺序派生，不手写工具名：被拦的每个工具名都必须出现在文案里
    for (const spec of TOOLS) {
      if (planModeBlocks(spec.access)) expect(prompt).toContain(spec.name);
    }
    expect(prompt).toContain("会被程序拦截");
    // 只读工具必须仍然可用，否则模型在计划模式下什么都做不了
    expect(prompt).toContain("read_file、list_dir、search_files 仍可用");
    // 非计划模式不该出现拦截文案
    expect(buildToolsPrompt(false, false)).not.toContain("会被程序拦截");
  });
});

describe("Schema 与参数校验不能互相矛盾", () => {
  it("required 里的字段缺了就一定被 validate 拒掉", () => {
    for (const spec of TOOLS) {
      const required = ((spec.parameters.required as string[] | undefined) ?? []).slice();
      if (!required.length) {
        // 没有必填项的工具，空参数必须合法——否则模型按 schema 传参会莫名被拒
        expect(spec.validate({}), `${spec.name} 无必填项却拒绝了空参数`).toBeNull();
        continue;
      }
      expect(spec.validate({}), `${spec.name} 缺必填项却通过了校验`).not.toBeNull();
      // 只补齐一个必填项之外的东西不该让校验意外通过：逐项去掉必填项都要被拒
      for (const missing of required) {
        const args: Record<string, unknown> = {};
        for (const k of required) if (k !== missing) args[k] = k === "argv" ? ["npm", "test"] : "x";
        expect(spec.validate(args), `${spec.name} 缺 ${missing} 却通过了校验`).not.toBeNull();
      }
    }
  });

  it("每个 schema 都关掉了多余属性", () => {
    for (const spec of TOOLS) {
      expect(spec.parameters.additionalProperties, `${spec.name} 没写 additionalProperties`).toBe(false);
      expect(spec.parameters.type).toBe("object");
    }
  });

  it("validateToolArgs 与各工具自带的 validate 完全一致", () => {
    const samples: Record<string, Record<string, unknown>> = {
      read_file: { path: "../etc/passwd" },
      list_dir: { path: "src" },
      search_files: { query: "abc", path: "src" },
      write_file: { path: "a.ts", content: "x" },
      edit_file: { path: "a.ts", old_text: "x", new_text: "y" },
      apply_patch: { path: "a.ts", hunks: [{ old_text: "x", new_text: "y" }] },
      run_command: { argv: ["npm", "install"] },
    };
    for (const spec of TOOLS) {
      const args = samples[spec.name] ?? {};
      expect(validateToolArgs(spec.name, args)).toBe(spec.validate(args));
    }
  });
});

describe("执行入口", () => {
  it("read_file 返回内容，超长会被截断并注明", async () => {
    const spec = findTool("read_file")!;
    const out = await spec.run({ path: "a.ts" }, fakeCtx({ readFile: async () => "hello" }));
    expect(out).toEqual({ result: "hello" });

    const big = await spec.run({ path: "a.ts" }, fakeCtx({ readFile: async () => "x".repeat(30000) }));
    expect(big.result?.length).toBeLessThan(30000);
    expect(big.result).toContain("已截断");
  });

  it("list_dir 空目录给人话，不返回空字符串", async () => {
    const spec = findTool("list_dir")!;
    expect((await spec.run({}, fakeCtx())).result).toBe("(空目录)");
  });

  it("write_file 用户放弃时不谎报成功", async () => {
    const spec = findTool("write_file")!;
    expect((await spec.run({ path: "a.ts", content: "x" }, fakeCtx({ writeFile: async () => [] }))).error).toContain("用户放弃");
    const failed = await spec.run({ path: "a.ts", content: "x" }, fakeCtx({ writeFile: async () => [{ ok: false, error: "回读不一致" }] }));
    expect(failed.error).toBe("回读不一致");
    const ok = await spec.run(
      { path: "a.ts", content: "x" },
      fakeCtx({ writeFile: async () => [{ ok: true, path: "a.ts", bytes: 1, created: true, verified: true }] })
    );
    expect(ok.result).toContain("已写入 a.ts");
    expect(ok.result).toContain("新建");
  });

  it("run_command 在注册表这一层也重查白名单，不只靠外层", async () => {
    const spec = findTool("run_command")!;
    const out = await spec.run({ argv: ["npm", "install"] }, fakeCtx());
    expect(out.error).toContain("npm 只允许");
  });

  it("run_command 执行前审计 package.json 脚本，坏脚本不进子进程", async () => {
    const spec = findTool("run_command")!;
    let called = false;
    const out = await spec.run(
      { argv: ["npm", "test"] },
      fakeCtx({
        readFile: async () => JSON.stringify({ scripts: { test: "node evil.js" } }),
        runCommand: async () => {
          called = true;
          return { exit_code: 0, stdout: "", stderr: "", timed_out: false, truncated: false };
        },
      })
    );
    expect(out.error).toContain("受信任");
    expect(called, "审计没过还真的把命令跑出去了").toBe(false);
  });

  it("run_command 读不到 package.json 时拒绝，不当成没脚本", async () => {
    const spec = findTool("run_command")!;
    const out = await spec.run(
      { argv: ["npm", "test"] },
      fakeCtx({
        readFile: async () => {
          throw new Error("不存在");
        },
      })
    );
    expect(out.error).toContain("无法读取 package.json");
  });

  it("run_command 正常结果带退出码，截断时明确告知模型", async () => {
    const spec = findTool("run_command")!;
    const base = { exit_code: 0, stdout: "ok", stderr: "", timed_out: false, truncated: false };
    const okOut = await spec.run({ argv: ["git", "status"] }, fakeCtx({ runCommand: async () => base }));
    expect(okOut.result).toContain("退出码：0");

    const cut = await spec.run(
      { argv: ["git", "status"] },
      fakeCtx({ runCommand: async () => ({ ...base, truncated: true }) })
    );
    expect(cut.result).toContain("已截断");
    expect(cut.result).toContain("不要把「没看到报错」当成测试通过");
  });

  it("search_files 走注入的上下文，不做真实 IO", async () => {
    const spec = findTool("search_files")!;
    const out = await spec.run(
      { query: "needle" },
      fakeCtx({
        listDir: async (rel) => (rel === "" ? [{ name: "a.ts", path: "/p/a.ts", dir: false, size: 10 }] : []),
        readFile: async () => "line1\nhas NEEDLE here\n",
      })
    );
    expect(out.result).toContain("a.ts:2");
  });
});

describe("parseToolArgs：合法 JSON ≠ 可用参数", () => {
  it("正常对象放行", () => {
    const r = parseToolArgs('{"path":"a.ts"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.path).toBe("a.ts");
  });

  it("空串当成空对象（模型偶尔不给 arguments）", () => {
    const r = parseToolArgs("");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({});
  });

  it("语法错误报「不是合法 JSON」", () => {
    const r = parseToolArgs('{"path":');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不是合法 JSON");
  });

  // 下面这些都能 JSON.parse 成功，但都不是对象。放过去的话，validate 里读 args.path
  // 会抛在 try 外面，一个畸形参数就能打断整轮对话。
  it.each(["null", "[1,2]", "3", '"x"', "true"])("非对象字面量 %s 被归一成错误", (raw) => {
    const r = parseToolArgs(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("工具参数必须是 JSON 对象");
  });

  it("解析失败与类型不对是两种不同错误，别混成一句", () => {
    const syntax = parseToolArgs("{oops");
    const type = parseToolArgs("null");
    expect(syntax.ok).toBe(false);
    expect(type.ok).toBe(false);
    if (!syntax.ok && !type.ok) expect(syntax.error).not.toBe(type.error);
  });
});

describe("补丁工具：edit_file / apply_patch", () => {
  it("edit_file 参数校验：空 old_text、缺 new_text、越界路径都拒掉", () => {
    expect(validateToolArgs("edit_file", { path: "a.ts", old_text: "", new_text: "y" })).not.toBeNull();
    expect(validateToolArgs("edit_file", { path: "a.ts", old_text: "x" })).not.toBeNull();
    expect(validateToolArgs("edit_file", { path: "../x", old_text: "x", new_text: "y" })).not.toBeNull();
    expect(validateToolArgs("edit_file", { path: "a.ts", old_text: "x", new_text: "" })).toBeNull();
  });

  it("apply_patch 参数校验：hunks 不是数组、为空、超 50、单条缺字段都拒掉", () => {
    expect(validateToolArgs("apply_patch", { path: "a.ts", hunks: "x" })).not.toBeNull();
    expect(validateToolArgs("apply_patch", { path: "a.ts", hunks: [] })).not.toBeNull();
    expect(
      validateToolArgs("apply_patch", { path: "a.ts", hunks: Array.from({ length: 51 }, () => ({ old_text: "x", new_text: "y" })) })
    ).not.toBeNull();
    expect(validateToolArgs("apply_patch", { path: "a.ts", hunks: [{ old_text: "x" }] })).not.toBeNull();
    expect(validateToolArgs("apply_patch", { path: "a.ts", hunks: [{ old_text: "", new_text: "y" }] })).not.toBeNull();
  });

  it("edit_file 成功时把算好的新内容交给写通道，不自己碰磁盘", async () => {
    const spec = findTool("edit_file")!;
    let written = "";
    const out = await spec.run(
      { path: "a.ts", old_text: "hello world", new_text: "hello zxz" },
      fakeCtx({
        readFile: async () => "hello world",
        writeFile: async (_rel, content) => {
          written = content;
          return [{ ok: true, path: "a.ts", bytes: content.length, created: false, verified: true }];
        },
      })
    );
    expect(written).toBe("hello zxz");
    expect(out.result).toContain("已补丁编辑 a.ts");
  });

  it("edit_file 命中失败时不调写通道，磁盘没有改动", async () => {
    const spec = findTool("edit_file")!;
    let called = false;
    const out = await spec.run(
      { path: "a.ts", old_text: "not there", new_text: "y" },
      fakeCtx({
        readFile: async () => "hello world",
        writeFile: async () => {
          called = true;
          return [];
        },
      })
    );
    expect(out.error).toContain("没有命中");
    expect(called).toBe(false);
  });

  it("edit_file 读不到文件时明说只改已存在文件，不谎报成功", async () => {
    const spec = findTool("edit_file")!;
    const out = await spec.run(
      { path: "new.ts", old_text: "x", new_text: "y" },
      fakeCtx({
        readFile: async () => {
          throw new Error("不存在");
        },
      })
    );
    expect(out.error).toContain("只改已存在的文件");
  });

  it("apply_patch 多 hunk 按顺序应用，第二处失败时整体不写", async () => {
    const spec = findTool("apply_patch")!;
    let written = "";
    const ok = await spec.run(
      { path: "a.ts", hunks: [{ old_text: "a=1", new_text: "a=10" }, { old_text: "b=2", new_text: "b=20" }] },
      fakeCtx({
        readFile: async () => "a=1\nb=2\n",
        writeFile: async (_rel, content) => {
          written = content;
          return [{ ok: true, path: "a.ts", bytes: content.length, created: false, verified: true }];
        },
      })
    );
    expect(written).toBe("a=10\nb=20\n");
    expect(ok.result).toContain("2 个 hunk");

    let called = false;
    const bad = await spec.run(
      { path: "a.ts", hunks: [{ old_text: "a=1", new_text: "a=10" }, { old_text: "b=3", new_text: "b=30" }] },
      fakeCtx({
        readFile: async () => "a=1\nb=2\n",
        writeFile: async () => {
          called = true;
          return [];
        },
      })
    );
    expect(bad.error).toContain("第 2 个 hunk");
    expect(called).toBe(false);
  });
});

describe("探索模式：名单制三件套", () => {
  it("发给模型的定义只剩三件套，原 TOOL_DEFS 不改动", () => {
    expect(exploreToolDefs().map((d) => d.function.name)).toEqual(["read_file", "list_dir", "search_files"]);
    expect(TOOL_DEFS.map((d) => d.function.name)).toContain("write_file");
  });

  it("写与跑命令（包括新补丁工具）默认不认，未知工具也不认", () => {
    for (const n of ["write_file", "edit_file", "apply_patch", "run_command", "glob", ""]) {
      expect(isExploreTool(n), `${n} 不该在探索名单里`).toBe(false);
    }
    for (const n of ["read_file", "list_dir", "search_files"]) {
      expect(isExploreTool(n)).toBe(true);
    }
  });

  it("探索模式的提示词只讲只读工具，不提补丁与测试回路", () => {
    const prompt = buildToolsPrompt(false, false, true);
    expect(prompt).toContain("探索模式");
    expect(prompt).toContain("read_file");
    expect(prompt).not.toContain("edit_file");
    expect(prompt).not.toContain("npm test");
    // 非探索模式的提示词必须提到补丁工具，否则模型不知道有这条路
    expect(buildToolsPrompt(false, false)).toContain("edit_file");
  });
});
