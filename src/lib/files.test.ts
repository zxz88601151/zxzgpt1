import { describe, expect, it } from "vitest";
import {
  backupRelPath,
  buildReadPayload,
  buildWorkspacePrompt,
  countLines,
  MAX_READ_CHARS,
  normalizeRelPath,
  parseFileBlocks,
  parseReadRequests,
  relPathError,
  shouldSkipDir,
  stripControl,
} from "./files";

const fence = "```";

describe("parseFileBlocks", () => {
  it("抽出 file: 代码块", () => {
    const md = `先建两个文件：\n\n${fence}file:src/a.ts\nexport const a = 1;\n${fence}\n\n${fence}path:docs/readme.md\n# hi\n${fence}\n`;
    const blocks = parseFileBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ path: "src/a.ts", content: "export const a = 1;" });
    expect(blocks[1].path).toBe("docs/readme.md");
  });

  it("忽略普通代码块", () => {
    const md = `${fence}ts\nconst x = 1;\n${fence}`;
    expect(parseFileBlocks(md)).toHaveLength(0);
  });

  it("同一路径以最后一次为准", () => {
    const md = `${fence}file:a.txt\nv1\n${fence}\n${fence}file:a.txt\nv2\n${fence}`;
    const blocks = parseFileBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("v2");
  });

  it("保留代码块内的空行与缩进", () => {
    const body = "function f() {\n  return 1;\n}\n\n// end";
    const md = `${fence}file:x.ts\n${body}\n${fence}`;
    expect(parseFileBlocks(md)[0].content).toBe(body);
  });

  it("兼容 file: 后带空格与反斜杠路径", () => {
    const md = `${fence}file: src\\utils\\x.ts\nlet a=1;\n${fence}`;
    expect(parseFileBlocks(md)[0].path).toBe("src/utils/x.ts");
  });
});

describe("relPathError", () => {
  it("合法路径", () => {
    expect(relPathError("src/a.ts")).toBeNull();
    expect(relPathError("./src/a.ts")).toBeNull();
  });
  it("拒绝越权与盘符", () => {
    expect(relPathError("../a.ts")).toBe("不能包含 ..");
    expect(relPathError("a/../../b")).toBe("不能包含 ..");
    expect(relPathError("C:/Windows/a.txt")).toBe("不能带盘符");
    expect(relPathError("   ")).toBe("路径为空");
  });

  it("开头的 / 视为工程内相对路径", () => {
    expect(relPathError("/src/a.ts")).toBeNull();
  });
});

describe("normalizeRelPath", () => {
  it("去掉 ./ 与多余前缀", () => {
    expect(normalizeRelPath("./a/b.txt")).toBe("a/b.txt");
    expect(normalizeRelPath("/a/b.txt")).toBe("a/b.txt");
    expect(normalizeRelPath(" a\\b ")).toBe("a/b");
  });
});

describe("countLines", () => {
  it("空串为 0", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
  });
});

describe("shouldSkipDir", () => {
  it("跳过依赖与构建产物", () => {
    expect(shouldSkipDir("node_modules")).toBe(true);
    expect(shouldSkipDir("target")).toBe(true);
    expect(shouldSkipDir("src")).toBe(false);
  });
});

describe("buildWorkspacePrompt", () => {
  it("包含根目录、目录树与落盘格式", () => {
    const p = buildWorkspacePrompt("D:\\proj", "src/\n  a.ts");
    expect(p).toContain("D:\\proj");
    expect(p).toContain("src/");
    expect(p).toContain("```file:相对路径");
    expect(p).toContain("不出现 ..");
  });

  it("空树时说明未扫描，不编造结构", () => {
    const p = buildWorkspacePrompt("/tmp/x", "   ");
    expect(p).toContain("空或尚未扫描");
  });

  it("声明自动落盘与读文件协议", () => {
    const p = buildWorkspacePrompt("D:\\proj", "");
    expect(p).toContain("自动写入磁盘");
    expect(p).toContain("@@read:");
    expect(p).toContain("真实读写");
  });

  it("确认开启时不再说自动写入，计划模式说清不落盘", () => {
    expect(buildWorkspacePrompt("D:\\proj", "", { confirmWrites: true })).toContain("等用户批复后才写入磁盘");
    expect(buildWorkspacePrompt("D:\\proj", "", { confirmWrites: true })).not.toContain("不需要用户确认");
    expect(buildWorkspacePrompt("D:\\proj", "", { planMode: true })).toContain("只出方案，不落盘");
  });

  it("工具模式下要求优先用工具，不混用文本协议", () => {
    expect(buildWorkspacePrompt("D:\\proj", "", { toolMode: true })).toContain("优先用工具");
    expect(buildWorkspacePrompt("D:\\proj", "", { toolMode: true })).toContain("run_command");
  });
});

describe("parseReadRequests", () => {
  it("抽出 @@read 行，支持冒号与省略冒号", () => {
    const md = "先看看现有代码：\n@@read: src/a.ts\n@@read src/b.ts\n然后我再改。";
    expect(parseReadRequests(md)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("去重并限制数量", () => {
    const md = Array.from({ length: 10 }, (_, i) => `@@read: f${i}.ts`).join("\n") + "\n@@read: f0.ts";
    const out = parseReadRequests(md);
    expect(out).toHaveLength(6);
    expect(new Set(out).size).toBe(6);
  });

  it("正文里出现 @@read 字样但不在行首时不误判", () => {
    expect(parseReadRequests("用 @@read: 语法 可以读文件")).toHaveLength(0);
  });

  it("不会把 @@read 当成 file 块", () => {
    expect(parseFileBlocks("@@read: src/a.ts")).toHaveLength(0);
  });
});

describe("stripControl", () => {
  it("剥掉 file 块与 @@read 行，只留解释文字", () => {
    const md = `我把文件写好了。\n\n@@read: src/a.ts\n\n${fence}file:src/a.ts\nexport const a = 1;\n${fence}\n\n完事。`;
    const out = stripControl(md);
    expect(out).toContain("我把文件写好了");
    expect(out).toContain("完事");
    expect(out).not.toContain("file:src/a.ts");
    expect(out).not.toContain("export const a");
    expect(out).not.toContain("@@read");
  });

  it("普通代码块原样保留", () => {
    const md = `${fence}ts\nconst x = 1;\n${fence}`;
    expect(stripControl(md)).toContain("const x = 1;");
  });

  it("全是文件块时返回空串", () => {
    expect(stripControl(`${fence}file:a.txt\nhi\n${fence}`)).toBe("");
  });
});

describe("buildReadPayload", () => {
  it("回传真实内容并带起止标记", () => {
    const p = buildReadPayload([{ path: "src/a.ts", content: "export const a = 1;" }]);
    expect(p).toContain("<<<FILE src/a.ts>>>");
    expect(p).toContain("export const a = 1;");
    expect(p).toContain("<<<END src/a.ts>>>");
    expect(p).toContain("@@read:");
  });

  it("读取失败的文件把错误带回去", () => {
    const p = buildReadPayload([{ path: "nope.ts", error: "读取失败（nope.ts）：NotFound" }]);
    expect(p).toContain("读取失败");
    expect(p).toContain("NotFound");
  });

  it("超长内容截断并说明", () => {
    const p = buildReadPayload([{ path: "big.ts", content: "x".repeat(MAX_READ_CHARS + 100) }]);
    expect(p).toContain("已截断");
    expect(p.length).toBeLessThan(MAX_READ_CHARS + 400);
  });
});

describe("backupRelPath", () => {
  it("覆盖前备份到 .zxz/undo/<时间戳>/", () => {
    expect(backupRelPath("2026-11-01T02-03-04", "src/a.ts")).toBe(".zxz/undo/2026-11-01T02-03-04/src/a.ts");
  });
  it("备份目录本身不进目录树", () => {
    expect(shouldSkipDir(".zxz")).toBe(true);
  });
});
