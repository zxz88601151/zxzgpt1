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
  /** 期望值从本地时区算出来，这样断言不会绑死在某台机器的 TZ 上 */
  const localLabel = (utcMs: number) => {
    const t = new Date(utcMs);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  };

  it("目录名是 UTC，界面显示本地时间——不再差一个时区", () => {
    const utc = Date.UTC(2026, 10, 1, 2, 49, 32);
    expect(stampLabel("2026-11-01T02-49-32")).toBe(localLabel(utc));
    expect(stampLabel("2026-11-01T02-49-32-123")).toBe(localLabel(utc));
  });

  it("毫秒位不影响秒级显示", () => {
    expect(stampLabel("2026-11-01T02-49-32-123")).toBe(stampLabel("2026-11-01T02-49-32"));
  });

  it("不是标准格式就原样返回", () => {
    expect(stampLabel("manual")).toBe("manual");
  });

  it("stampNow 产出 23 位毫秒精度，可直接做目录名", () => {
    const s = stampNow(new Date("2026-11-01T02:49:32.123Z"));
    expect(s).toBe("2026-11-01T02-49-32-123");
    expect(s).toHaveLength(23);
    expect(s).not.toMatch(/[:.]/);
  });

  // 秒级时间戳在同一秒内连续备份两次会撞同一个目录，第二次把第一次覆盖掉——
  // 撤销栈会静默少一版，而用户以为每一版都在。
  it("同一秒内的两次备份不会撞在同一个目录名上", () => {
    const a = stampNow(new Date("2026-11-01T02:49:32.100Z"));
    const b = stampNow(new Date("2026-11-01T02:49:32.900Z"));
    expect(a).not.toBe(b);
  });
});
