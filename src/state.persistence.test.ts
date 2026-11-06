// @vitest-environment jsdom
/** D-07：loadState / persist 的宿主级回归（需要 localStorage）。 */

import { beforeEach, describe, expect, it } from "vitest";
import { loadState, persist, STORE_KEY } from "./state";
import { BACKUP_KEY_PREFIX, STATE_SCHEMA_VERSION } from "./lib/migration";
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
});
