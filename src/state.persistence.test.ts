// @vitest-environment jsdom
/** D-07：loadState / persist 的宿主级回归（需要 localStorage）。 */

import { beforeEach, describe, expect, it } from "vitest";
import { loadState, persist, STORE_KEY } from "./state";
import { BACKUP_KEY_PREFIX, BACKUP_REDACTED, STATE_SCHEMA_VERSION } from "./lib/migration";
import { DEFAULT_SETTINGS } from "./presets";
import type { AppState, Conversation } from "./types";

const conv = (id: string): Conversation => ({
  id, title: "会话", messages: [{ role: "user", content: "hi", createdAt: 1 }], createdAt: 1, updatedAt: 1,
});

const state = (): AppState => ({ settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" }, conversations: [conv("c1"), conv("c2")], activeId: "c1" });

beforeEach(() => localStorage.clear());

describe("持久化读写", () => {
  it("无存档时给默认设置，不写备份键", () => {
    const s = loadState();
    expect(s.conversations).toEqual([]);
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(localStorage.getItem(`${BACKUP_KEY_PREFIX}corrupt`)).toBeNull();
  });

  it("persist 后存档带 schemaVersion，且 API Key 与会话能读回", () => {
    persist(state());
    expect(JSON.parse(localStorage.getItem(STORE_KEY)!).schemaVersion).toBe(STATE_SCHEMA_VERSION);
    const back = loadState();
    expect(back.settings.apiKey).toBe("test-key");
    expect(back.conversations.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(back.activeId).toBe("c1");
  });

  it("旧版裸存档读回后自动迁移，并保留一份原始备份", () => {
    const raw = JSON.stringify({ settings: { model: "legacy" }, conversations: [conv("old")], activeId: "old" });
    localStorage.setItem(STORE_KEY, raw);
    const s = loadState();
    expect(s.settings.model).toBe("legacy");
    expect(s.settings.contextTurns).toBe(DEFAULT_SETTINGS.contextTurns);
    expect(localStorage.getItem(`${BACKUP_KEY_PREFIX}v1`)).toBe(raw);
  });

  it("损坏存档也能启动，原始内容落到 corrupt 备份", () => {
    localStorage.setItem(STORE_KEY, "{broken");
    const s = loadState();
    expect(s.conversations).toEqual([]);
    expect(localStorage.getItem(`${BACKUP_KEY_PREFIX}corrupt`)).toBe("{broken");
  });

  it("再次 persist 覆盖存档后不再重复触发迁移备份", () => {
    const raw = JSON.stringify({ settings: {}, conversations: [], activeId: null });
    localStorage.setItem(STORE_KEY, raw);
    loadState();
    localStorage.removeItem(`${BACKUP_KEY_PREFIX}v1`);
    persist(state());
    loadState(); // 已是 v2，不应再写备份
    expect(localStorage.getItem(`${BACKUP_KEY_PREFIX}v1`)).toBeNull();
  });

  it("独立复审 P2：旧版存档含 API Key 时，备份只留脱敏快照，主键仍能正常读回", () => {
    const secret = "TESTONLY-key-0001";
    const raw = JSON.stringify({
      settings: { apiKey: secret, model: "legacy" },
      conversations: [conv("old")],
      activeId: "old",
    });
    localStorage.setItem(STORE_KEY, raw);
    const s = loadState();
    // 升级不丢 Key：明文仍只在主键里
    expect(s.settings.apiKey).toBe(secret);
    expect(localStorage.getItem(STORE_KEY)).toContain(secret);
    const backup = localStorage.getItem(`${BACKUP_KEY_PREFIX}v1`)!;
    expect(backup).not.toContain(secret);
    expect(backup).toContain(BACKUP_REDACTED);
    // 备份仍可用于人工恢复：其余字段与会话都在
    expect(JSON.parse(backup).settings.model).toBe("legacy");
    expect(JSON.parse(backup).conversations[0].id).toBe("old");
  });

  it("独立复审 P2：损坏存档里混有 apiKey 片段时，corrupt 备份同样脱敏", () => {
    const secret = "TESTONLY-key-0002";
    localStorage.setItem(STORE_KEY, `{"settings":{"apiKey":"${secret}"},broken`);
    loadState();
    const backup = localStorage.getItem(`${BACKUP_KEY_PREFIX}corrupt`)!;
    expect(backup).not.toContain(secret);
    expect(backup).toContain(BACKUP_REDACTED);
  });

  it("独立复核 P2：Unicode 转义键名解析后是应用有效 Key，备份仍须脱敏", () => {
    const secret = "TESTONLY-key-0004";
    const raw = `{"settings":{"ap\\u0069Key":"${secret}"},"conversations":[],"activeId":null}`;
    localStorage.setItem(STORE_KEY, raw);
    const s = loadState();
    expect(s.settings.apiKey).toBe(secret); // 应用确实把它当 API Key 读进 state
    const backup = localStorage.getItem(`${BACKUP_KEY_PREFIX}v1`)!;
    expect(backup).not.toContain(secret);
    expect(backup).toContain(BACKUP_REDACTED);
  });

  it("第 3 轮复核 N1：深嵌套存档不因脱敏爆栈，也不静默丢历史", () => {
    const secret = "TESTONLY-key-0005";
    let core = `{"apiKey":"${secret}","leaf":1}`;
    for (let i = 0; i < 12000; i++) core = `{"n":${core}}`;
    const raw = `{"settings":{"apiKey":"${secret}"},"conversations":[{"id":"c1","title":"历史","messages":[],"createdAt":1,"updatedAt":1}],"activeId":"c1","deep":${core}}`;
    localStorage.setItem(STORE_KEY, raw);
    const s = loadState();
    expect(s.conversations.map((c) => c.id)).toEqual(["c1"]); // 没被静默吞成默认状态
    expect(s.settings.apiKey).toBe(secret);
    const backup = localStorage.getItem(`${BACKUP_KEY_PREFIX}v1`)!;
    expect(backup).not.toBeNull();
    expect(backup).not.toContain(secret);
  });

  it("第 4 轮复核 P2：深嵌套 + 对象形式 Key 端到端也不留明文", () => {
    const secret = "TESTONLY-key-0006";
    let core = `{"n":1}`;
    for (let i = 0; i < 6000; i++) core = `{"n":${core}}`;
    const raw = `{"settings":{"apiKey":{"nested":"${secret}"}},"conversations":[{"id":"c1","title":"历史","messages":[],"createdAt":1,"updatedAt":1}],"activeId":"c1","deep":${core}}`;
    localStorage.setItem(STORE_KEY, raw);
    const s = loadState();
    expect(s.conversations.map((c) => c.id)).toEqual(["c1"]);
    const backup = localStorage.getItem(`${BACKUP_KEY_PREFIX}v1`)!;
    expect(backup).not.toBeNull();
    expect(backup).not.toContain(secret);
    expect(backup).toContain(BACKUP_REDACTED);
  });

  it("第 5 轮复核 P2：重复键存档端到端不把前一段明文写进备份", () => {
    const secret = "TESTONLY-key-0007";
    const raw = `{"settings":{"apiKey":"${secret}","apiKey":""},"conversations":[{"id":"c1","title":"历史","messages":[],"createdAt":1,"updatedAt":1}],"activeId":"c1"}`;
    localStorage.setItem(STORE_KEY, raw);
    const s = loadState();
    expect(s.conversations.map((c) => c.id)).toEqual(["c1"]);
    const backup = localStorage.getItem(`${BACKUP_KEY_PREFIX}v1`)!;
    expect(backup).not.toContain(secret);
  });
});
