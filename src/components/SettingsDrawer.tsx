import { useEffect, useState } from "react";
import { fetchModels, testConnection } from "../api";
import { PRESETS, findPreset } from "../presets";
import { clamp } from "../lib/text";
import type { Settings, Theme, Transport } from "../types";
import { IconButton } from "./ui";

interface SettingsDrawerProps {
  open: boolean;
  settings: Settings;
  transport: Transport;
  onClose: () => void;
  onSave: (next: Settings) => void;
  /** 主题下拉改动时即时预览，保存后才落盘 */
  onThemePreview: (theme: Theme) => void;
}

type ResultKind = "" | "ok" | "bad";

export function SettingsDrawer({ open, settings, transport, onClose, onSave, onThemePreview }: SettingsDrawerProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [models, setModels] = useState<string[]>([]);
  const [keyVisible, setKeyVisible] = useState(false);
  const [result, setResult] = useState<{ text: string; kind: ResultKind }>({ text: "", kind: "" });

  // 每次打开都用最新设置重置草稿与提示
  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setModels(findPreset(settings.preset)?.models || []);
    setResult({ text: "", kind: "" });
    setKeyVisible(false);
  }, [open, settings]);

  const patch = (next: Partial<Settings>) => setDraft((d) => ({ ...d, ...next }));

  const onPresetChange = (id: string) => {
    const p = findPreset(id);
    if (!p) return;
    setDraft((d) => ({
      ...d,
      preset: id,
      baseUrl: p.base,
      model: p.defaultModel || d.model,
      apiKey: p.noKey && !d.apiKey ? "ollama" : d.apiKey,
    }));
    setModels(p.models);
  };

  const modelOptions = Array.from(new Set([...models, draft.model].filter(Boolean)));

  const doTest = async () => {
    setResult({ text: "正在测试…", kind: "" });
    const res = await testConnection(draft, transport).catch((e: Error) => ({ ok: false, message: e.message || String(e) }));
    setResult({ text: res.message || (res.ok ? "连接正常" : "连接失败"), kind: res.ok ? "ok" : "bad" });
  };

  const doFetchModels = async () => {
    setResult({ text: "正在拉取…", kind: "" });
    const res = await fetchModels(draft, transport).catch((e: Error) => ({ ok: false, models: [], message: e.message }));
    if (res.ok && res.models && res.models.length) {
      setModels(res.models);
      setResult({ text: `拉取到 ${res.models.length} 个模型`, kind: "ok" });
    } else {
      setResult({ text: res.message || "拉取失败，请手动填写模型名", kind: "bad" });
    }
  };

  return (
    <>
      <div className="scrim" id="scrim" hidden={!open} onClick={onClose} />
      <div className="drawer" id="drawer" hidden={!open} role="dialog" aria-modal="true" aria-label="设置">
        <div className="drawer-head">
          <h2>设置</h2>
          <IconButton id="btnCloseDrawer" title="关闭" name="close" onClick={onClose} />
        </div>

        <div className="drawer-body">
          <div className="field">
            <label htmlFor="preset">服务商预设</label>
            <select id="preset" value={draft.preset} onChange={(e) => onPresetChange(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="help">任选一家 OpenAI 兼容接口，填入密钥即可对话</p>
          </div>

          <div className="field">
            <label htmlFor="baseUrl">Base URL</label>
            <input
              id="baseUrl"
              type="text"
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              value={draft.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="apiKey">API Key</label>
            <div className="with-action">
              <input
                id="apiKey"
                type={keyVisible ? "text" : "password"}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
                value={draft.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
              <button className="ghost-btn" id="btnToggleKey" type="button" onClick={() => setKeyVisible((v) => !v)}>
                {keyVisible ? "隐藏" : "显示"}
              </button>
            </div>
            <p className="help">密钥保存在本机浏览器存储中，仅用于调用你配置的模型</p>
          </div>

          <div className="field">
            <label htmlFor="model">模型</label>
            <div className="with-action">
              <input
                id="model"
                type="text"
                placeholder="gpt-4o-mini"
                spellCheck={false}
                list="modelList"
                autoComplete="off"
                value={draft.model}
                onChange={(e) => patch({ model: e.target.value })}
              />
              <button className="ghost-btn" id="btnFetchModels" type="button" onClick={doFetchModels}>
                拉取列表
              </button>
            </div>
            <datalist id="modelList">
              {modelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="temperature">
                温度 <b id="tempVal">{Number(draft.temperature).toFixed(1)}</b>
              </label>
              <input
                id="temperature"
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="maxTokens">最大输出 tokens</label>
              <input
                id="maxTokens"
                type="number"
                min={1}
                max={200000}
                step={1}
                placeholder="留空则由模型决定"
                value={draft.maxTokens ?? ""}
                onChange={(e) => patch({ maxTokens: e.target.value.trim() ? Number(e.target.value) : null })}
              />
            </div>
            <div className="field">
              <label htmlFor="contextTurns">携带上下文轮数</label>
              <input
                id="contextTurns"
                type="number"
                min={0}
                max={100}
                step={1}
                value={draft.contextTurns}
                onChange={(e) => patch({ contextTurns: clamp(Number(e.target.value) || 0, 0, 100) })}
              />
            </div>
            <div className="field">
              <label htmlFor="theme">主题</label>
              <select
                id="theme"
                value={draft.theme}
                onChange={(e) => {
                  const theme = e.target.value === "light" ? "light" : "dark";
                  patch({ theme });
                  onThemePreview(theme);
                }}
              >
                <option value="dark">深色</option>
                <option value="light">浅色</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="systemPrompt">系统提示词</label>
            <textarea
              id="systemPrompt"
              rows={3}
              placeholder="你是 zxz，一个简洁、直接、基于事实回答的助手"
              value={draft.systemPrompt}
              onChange={(e) => patch({ systemPrompt: e.target.value })}
            />
          </div>

          <label className="check">
            <input id="stream" type="checkbox" checked={draft.stream} onChange={(e) => patch({ stream: e.target.checked })} />
            <span>流式输出（逐字返回）</span>
          </label>

          <div className="drawer-actions">
            <button className="primary-btn" id="btnSave" type="button" onClick={() => onSave(draft)}>
              保存
            </button>
            <button className="ghost-btn" id="btnTest" type="button" onClick={doTest}>
              测试连接
            </button>
            <span className={"test-result" + (result.kind ? " " + result.kind : "")} id="testResult">
              {result.text}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
