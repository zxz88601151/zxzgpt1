/** D-07：存档迁移链的纯函数回归（不碰 localStorage）。 */

import { describe, expect, it } from "vitest";
import { BACKUP_KEY_PREFIX, BACKUP_REDACTED, decodeState, encodeState, redactBackupRaw, STATE_SCHEMA_VERSION } from "./migration";
import { DEFAULT_SETTINGS } from "../presets";
import type { AppState, Conversation } from "../types";

const conv = (id: string): Conversation => ({
  id, title: "会话", messages: [{ role: "user", content: "hi", createdAt: 1 }], createdAt: 1, updatedAt: 1,
});

const legacy = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({ settings: { baseUrl: "https://old/v1", model: "old-model" }, conversations: [conv("c1")], activeId: "c1", ...patch });

const state = (): AppState => ({
  settings: { ...DEFAULT_SETTINGS },
  conversations: [conv("c1")],
  activeId: "c1",
});

describe("decodeState：旧格式兼容（v1 → v2）", () => {
  it("没有 schemaVersion 视为 v1，settings 补齐默认值但保留用户设置", () => {
    const out = decodeState(legacy(), 1000);
    expect(out.fromVersion).toBe(1);
    expect(out.state.settings.baseUrl).toBe("https://old/v1");
    expect(out.state.settings.contextTurns).toBe(DEFAULT_SETTINGS.contextTurns);
    expect(out.state.conversations).toHaveLength(1);
    expect(out.state.activeId).toBe("c1");
  });

  it("迁移前一定给出备份请求；无敏感字段时原始 raw 一字不改", () => {
    const raw = legacy();
    const out = decodeState(raw, 1000);
    expect(out.backup).not.toBeNull();
    expect(out.backup!.raw).toBe(raw);
    expect(out.backup!.key).toBe(`${BACKUP_KEY_PREFIX}v1`);
    expect(out.repairs.join(" ")).toContain("备份");
  });

  it("独立复核 P2：backup.raw 从 decodeState 产出起就是脱敏快照", () => {
    const secret = "TESTONLY-key-0003";
    const raw = legacy({ settings: { apiKey: secret, model: "legacy" } });
    const out = decodeState(raw, 1000);
    expect(out.state.settings.apiKey).toBe(secret); // 升级不丢 Key
    expect(out.backup!.raw).not.toContain(secret);
    expect(out.backup!.raw).toContain(BACKUP_REDACTED);
    expect(JSON.parse(out.backup!.raw).settings.model).toBe("legacy");
  });

  it("v2 存档不再备份，也不产生迁移修补", () => {
    const raw = encodeState(state());
    const out = decodeState(raw, 1000);
    expect(out.fromVersion).toBe(2);
    expect(out.backup).toBeNull();
  });
});

describe("decodeState：数据修补", () => {
  it("流式中间态 streaming:true 重启后复位，不永远显示生成中", () => {
    const raw = JSON.stringify({
      settings: {}, conversations: [{ ...conv("c1"), messages: [{ role: "assistant", content: "半截", createdAt: 1, streaming: true }] }], activeId: "c1",
    });
    const out = decodeState(raw, 1000);
    expect(out.state.conversations[0].messages[0].streaming).toBe(false);
  });

  it("activeId 指向不存在的会话 → 置空并登记", () => {
    const out = decodeState(legacy({ activeId: "ghost" }), 1000);
    expect(out.state.activeId).toBeNull();
    expect(out.repairs.join(" ")).toContain("activeId");
  });

  it("compactAfterIndex 越界 → 钳制到可用消息条数", () => {
    const raw = JSON.stringify({
      settings: {}, conversations: [{ ...conv("c1"), compactAfterIndex: 99, compactSummary: "摘要" }], activeId: "c1",
    });
    const out = decodeState(raw, 1000);
    expect(out.state.conversations[0].compactAfterIndex).toBe(1);
    expect(out.state.conversations[0].compactSummary).toBe("摘要");
    expect(out.repairs.join(" ")).toContain("越界");
  });

  it("保留未知字段，不做不可逆丢弃", () => {
    const raw = JSON.stringify({
      settings: { customFutureField: "keep" },
      conversations: [{ ...conv("c1"), futureFlag: 1, messages: [{ role: "user", content: "x", createdAt: 1, futureMsg: 2 }] }],
      activeId: "c1",
    });
    const out = decodeState(raw, 1000);
    expect((out.state.settings as unknown as Record<string, unknown>).customFutureField).toBe("keep");
    expect((out.state.conversations[0] as unknown as Record<string, unknown>).futureFlag).toBe(1);
    expect((out.state.conversations[0].messages[0] as unknown as Record<string, unknown>).futureMsg).toBe(2);
  });
});

describe("decodeState：异常与未来版本", () => {
  it("JSON 损坏 → 默认状态 + corrupt 备份", () => {
    const out = decodeState("{not json", 1000);
    expect(out.state.conversations).toEqual([]);
    expect(out.backup!.key).toBe(`${BACKUP_KEY_PREFIX}corrupt`);
    expect(out.repairs.join(" ")).toContain("损坏");
  });

  it("顶层不是对象 → 默认状态 + corrupt 备份", () => {
    const out = decodeState("[1,2,3]", 1000);
    expect(out.state.conversations).toEqual([]);
    expect(out.backup!.key).toBe(`${BACKUP_KEY_PREFIX}corrupt`);
  });

  it("未来版本 v3 → 不丢数据，备份后按 v2 尽力读取", () => {
    const raw = legacy({ schemaVersion: 3 });
    const out = decodeState(raw, 1000);
    expect(out.fromVersion).toBe(3);
    expect(out.backup!.key).toBe(`${BACKUP_KEY_PREFIX}v3`);
    expect(out.state.settings.model).toBe("old-model");
    expect(out.repairs.join(" ")).toContain("未来版本");
  });

  it("无存档 → 默认状态，不产生备份", () => {
    const out = decodeState(null, 1000);
    expect(out.fromVersion).toBe(0);
    expect(out.backup).toBeNull();
    expect(out.state.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("encodeState", () => {
  it("写入带当前 schemaVersion，且能 round-trip 回等价状态", () => {
    const raw = encodeState(state());
    expect(JSON.parse(raw).schemaVersion).toBe(STATE_SCHEMA_VERSION);
    const back = decodeState(raw, 1000);
    expect(back.state.conversations[0].id).toBe("c1");
    expect(back.state.activeId).toBe("c1");
    expect(back.backup).toBeNull();
  });

  it("encode 不改内存里的 AppState 对象", () => {
    const s = state();
    encodeState(s);
    expect((s as unknown as Record<string, unknown>).schemaVersion).toBeUndefined();
  });
});

describe("redactBackupRaw：备份不复制第二份明文 API Key", () => {
  const secret = "TESTONLY-key-0001";

  it("没有 apiKey 的存档逐字节原样返回", () => {
    const raw = legacy();
    expect(redactBackupRaw(raw)).toBe(raw);
  });

  it("空字符串 apiKey 保持原样，不误报占位", () => {
    const raw = JSON.stringify({ settings: { apiKey: "" }, conversations: [] });
    expect(redactBackupRaw(raw)).toBe(raw);
    expect(redactBackupRaw(raw)).not.toContain(BACKUP_REDACTED);
  });

  it("非空 apiKey 换成占位，其余字段与结构一字不改", () => {
    const raw = JSON.stringify({ settings: { apiKey: secret, model: "legacy" }, conversations: [conv("c1")], activeId: "c1" });
    const out = redactBackupRaw(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain(BACKUP_REDACTED);
    expect(JSON.parse(out).settings.model).toBe("legacy");
    expect(JSON.parse(out).conversations[0].id).toBe("c1");
    expect(out).toBe(raw.replace(secret, BACKUP_REDACTED));
  });

  it("损坏 JSON 里的 apiKey 片段同样被盖住（parse 失败不能漏）", () => {
    const raw = `{"settings":{"apiKey":"${secret}"},broken`;
    const out = redactBackupRaw(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain(BACKUP_REDACTED);
  });

  it("值里含转义引号也能整体替换，不留残片", () => {
    const raw = `{"settings":{"apiKey":"a\\"${secret}"},"conversations":[]}`;
    const out = redactBackupRaw(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain(BACKUP_REDACTED);
  });

  it("多处出现全部脱敏；形似但不是 apiKey 的键不受影响", () => {
    const raw = `{"settings":{"apiKey":"${secret}"},"note":{"apiKey":"${secret}"},"api_key":"${secret}"}`;
    const out = redactBackupRaw(raw);
    expect(out.split(BACKUP_REDACTED)).toHaveLength(3);
    expect(out).toContain(`"api_key":"${secret}"`);
  });

  it("独立复核 P2：Unicode 转义键名解析后就是 apiKey，必须脱敏", () => {
    const raw = `{"settings":{"ap\\u0069Key":"${secret}"},"conversations":[]}`;
    // JSON.parse 后键名是 apiKey，buildState 会把它当真正的 API Key 读进 state
    expect(JSON.parse(raw).settings.apiKey).toBe(secret);
    const out = redactBackupRaw(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain(BACKUP_REDACTED);
  });

  it("独立复核 P2：大小写变体键名按忽略大小写的规则一并脱敏", () => {
    const raw = `{"settings":{"APIKey":"${secret}"}}`;
    const out = redactBackupRaw(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain(BACKUP_REDACTED);
  });

  it("损坏 JSON 的值没有闭合引号时也不留明文", () => {
    const raw = `{"settings":{"apiKey":"${secret}`;
    const out = redactBackupRaw(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain(BACKUP_REDACTED);
  });

  it("第 3 轮复核 N2：apiKey 值非字符串时内部明文也不残留", () => {
    const obj = `{"settings":{"apiKey":{"nested":"${secret}"}},"conversations":[]}`;
    const arr = `{"settings":{"apiKey":["${secret}"]}}`;
    expect(redactBackupRaw(obj)).not.toContain(secret);
    expect(redactBackupRaw(arr)).not.toContain(secret);
  });

  it("第 3 轮复核 N3：损坏 JSON + Unicode 转义键名也不留明文", () => {
    const raw = `{"settings":{"ap\\u0069Key":"${secret}"},broken`;
    const out = redactBackupRaw(raw);
    expect(out).not.toContain(secret);
    expect(out).toContain(BACKUP_REDACTED);
  });

  it("第 3 轮复核 N4：__proto__ 字段重建后不丢", () => {
    const raw = `{"settings":{"apiKey":"${secret}","__proto__":{"x":1}}}`;
    const out = redactBackupRaw(raw);
    expect(out).toContain('"__proto__"');
    expect(out).not.toContain(secret);
  });

  it("第 3 轮复核 N1：12000 层深嵌套不爆栈且脱敏仍生效", () => {
    let core = `{"apiKey":"${secret}"}`;
    for (let i = 0; i < 12000; i++) core = `{"n":${core}}`;
    const raw = `{"settings":{"apiKey":"${secret}"},"deep":${core}}`;
    expect(() => redactBackupRaw(raw)).not.toThrow();
    expect(redactBackupRaw(raw)).not.toContain(secret);
    expect(() => decodeState(raw, 1000)).not.toThrow();
  });

  it("第 4 轮复核 P2：深嵌套 + apiKey 对象/数组值也不留明文（降级安全摘要）", () => {
    let core = `{"apiKey":{"nested":"${secret}"}}`;
    for (let i = 0; i < 6000; i++) core = `{"n":${core}}`;
    const rawObj = `{"settings":{"apiKey":{"nested":"${secret}"}},"deep":${core}}`;
    const rawArr = `{"settings":{"apiKey":["${secret}"]},"deep":${core}}`;
    for (const raw of [rawObj, rawArr]) {
      const out = redactBackupRaw(raw);
      expect(out).not.toContain(secret);
      expect(out).toContain(BACKUP_REDACTED);
      expect(decodeState(raw, 1000).backup!.raw).not.toContain(secret);
    }
    // 兜底路径产出的是零原文摘要，不再试图局部替换
    expect(redactBackupRaw(rawObj)).toContain("__zxz_backup_redacted__");
  });

  it("第 5 轮复核 P2：同名重复 apiKey 键末值为空，也不把前一段明文带进备份", () => {
    const rawEmpty = `{"settings":{"apiKey":"${secret}","apiKey":""},"conversations":[]}`;
    const rawNull = `{"settings":{"ap\\u0069Key":"${secret}","apiKey":null},"conversations":[]}`;
    for (const raw of [rawEmpty, rawNull]) {
      const out = redactBackupRaw(raw);
      expect(out).not.toContain(secret);
      expect(decodeState(raw, 1000).backup!.raw).not.toContain(secret);
    }
    // 末值为空时不引入占位，避免误报「配过 Key」
    expect(redactBackupRaw(rawEmpty)).not.toContain(BACKUP_REDACTED);
  });
});
