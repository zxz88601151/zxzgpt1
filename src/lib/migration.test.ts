/** D-07：存档迁移链的纯函数回归（不碰 localStorage）。 */

import { describe, expect, it } from "vitest";
import { BACKUP_KEY_PREFIX, decodeState, encodeState, STATE_SCHEMA_VERSION } from "./migration";
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

  it("迁移前一定给出备份请求，原始 raw 一字不改", () => {
    const raw = legacy();
    const out = decodeState(raw, 1000);
    expect(out.backup).not.toBeNull();
    expect(out.backup!.raw).toBe(raw);
    expect(out.backup!.key).toBe(`${BACKUP_KEY_PREFIX}v1`);
    expect(out.repairs.join(" ")).toContain("备份");
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
