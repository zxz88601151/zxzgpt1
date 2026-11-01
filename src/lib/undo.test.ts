import { describe, expect, it } from "vitest";
import { joinPath, relFromAbs, sepOf, stampLabel, stampNow, undoRootOf } from "./undo";

describe("路径拼接", () => {
  it("Windows 根目录用反斜杠", () => {
    expect(sepOf("F:\\demo")).toBe("\\");
    expect(joinPath("F:\\demo", ".zxz", "undo")).toBe("F:\\demo\\.zxz\\undo");
  });

  it("类 Unix 根目录用斜杠", () => {
    expect(sepOf("/home/me/proj")).toBe("/");
    expect(joinPath("/home/me/proj", ".zxz", "undo")).toBe("/home/me/proj/.zxz/undo");
  });

  it("根目录末尾带分隔符不会拼出双斜杠", () => {
    expect(undoRootOf("F:\\demo\\")).toBe("F:\\demo\\.zxz\\undo");
    expect(undoRootOf("/srv/app/")).toBe("/srv/app/.zxz/undo");
  });
});

describe("relFromAbs", () => {
  it("剥掉快照目录，统一成 / 分隔", () => {
    expect(relFromAbs("F:\\demo\\.zxz\\undo\\2026-11-01T02-49-32\\src\\main.js", "F:\\demo\\.zxz\\undo\\2026-11-01T02-49-32")).toBe(
      "src/main.js"
    );
  });

  it("同目录文件也正确", () => {
    expect(relFromAbs("/tmp/p/.zxz/undo/2026-11-01T02-49-32/index.html", "/tmp/p/.zxz/undo/2026-11-01T02-49-32")).toBe(
      "index.html"
    );
  });
});

describe("时间戳", () => {
  it("目录名转成可读时间", () => {
    expect(stampLabel("2026-11-01T02-49-32")).toBe("11-01 02:49:32");
  });

  it("不是标准格式就原样返回", () => {
    expect(stampLabel("manual")).toBe("manual");
  });

  it("stampNow 产出可直接做目录名", () => {
    const s = stampNow(new Date("2026-11-01T02:49:32.123Z"));
    expect(s).toBe("2026-11-01T02-49-32");
    expect(s).not.toMatch(/[:.]/);
  });
});
