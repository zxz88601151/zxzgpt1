import { useMemo, useState } from "react";
import { STAGE_LABEL, groupSkills, type Skill } from "../lib/skill";
import {
  SCAN_KIND_LABEL,
  isClean,
  scanHeadline,
  scanSkill,
  summarizeScans,
  type ScanResult,
} from "../lib/skillscan";
import {
  HOOK_LABEL,
  KIND_LABEL,
  SOURCES,
  cloneCommand,
  groupSources,
  repoUrl,
  summarizeSources,
  type SourceEntry,
} from "../skills/sources";
import {
  AUDIT_BY_ID,
  SKILL_CHAR_LIMIT,
  VERDICT_LABEL,
  instructionFiles,
  summarizeAudits,
  type AuditRecord,
  type HitKind,
} from "../skills/audit";
import { copyText } from "../lib/text";

const HIT_KIND_LABEL: Record<HitKind, string> = {
  instruction: "要求执行",
  guard: "防护规则",
  doc: "仅文档提及",
  none: "未命中",
};

interface SkillPanelProps {
  open: boolean;
  /** 内建 + 本地技能 */
  skills: Skill[];
  active: string[];
  /** 外部技能库目录 */
  dir: string | null;
  /** 解析失败的技能 */
  errors: { id: string; error: string }[];
  loading: boolean;
  auto: boolean;
  onToggle: (id: string) => void;
  onToggleAuto: (v: boolean) => void;
  onOpenDir: () => void;
  onClearDir: () => void;
  onReload: () => void;
  /** 导出审计清单（有工程目录就写盘，没有就下载） */
  onExportAudit: () => void;
  /** 导出本地技能扫描结果 */
  onExportScan: () => void;
  onClose: () => void;
}

type Tab = "skills" | "sources";

/**
 * 扫描徽章。干净的也标出来——「查过且没事」和「压根没查」是两回事，
 * 只标有问题的会让用户以为干净的那些没被扫过。
 */
function ScanBadge({ scan }: { scan: ScanResult }) {
  if (isClean(scan)) {
    return (
      <span className="scan-badge clean" title="10 条危险模式都没命中">
        干净
      </span>
    );
  }
  const code = scan.code > 0;
  const detail = `代码块 ${scan.code} · 正文 ${scan.prose} · 劝阻 ${scan.guard}`;
  return (
    <span className={"scan-badge " + (code ? "code" : "soft")} title={detail}>
      {code ? `${scan.code} 处危险指令` : `${scan.findings.length} 处提及`}
    </span>
  );
}

/**
 * 技能库面板：两个页签——「技能」管启用与正文预览，「来源」是外部仓库的审计底稿。
 * 「选技能库目录」只在桌面端可用（要读磁盘），浏览器直开时后端会报错。
 */
export function SkillPanel({
  open,
  skills,
  active,
  dir,
  errors,
  loading,
  auto,
  onToggle,
  onToggleAuto,
  onOpenDir,
  onClearDir,
  onReload,
  onExportAudit,
  onExportScan,
  onClose,
}: SkillPanelProps) {
  const [tab, setTab] = useState<Tab>("skills");
  const [copied, setCopied] = useState("");

  // 只扫外部技能：内建那 12 条是本项目自带、review 过的，扫出来全是自己的示例，纯噪音。
  // 这个扫描器的用途是「你从外面拿来的东西」。
  const scans = useMemo(() => {
    const map = new Map<string, ScanResult>();
    for (const s of skills) {
      if (s.source === "local") map.set(s.id, scanSkill(s.id, s.name, s.body));
    }
    return map;
  }, [skills]);

  if (!open) return null;

  const builtin = skills.filter((s) => s.source === "builtin");
  const local = skills.filter((s) => s.source === "local");
  const sum = summarizeSources(SOURCES);
  const auditSum = summarizeAudits();
  const scanSum = summarizeScans([...scans.values()]);
  const auditedInstruction = Object.values(AUDIT_BY_ID).reduce((n, a) => n + instructionFiles(a), 0);

  const renderItem = (s: Skill) => {
    const on = active.includes(s.id);
    const scan = scans.get(s.id);
    return (
      <li
        className={"skill-item" + (on ? " on" : "")}
        key={s.id}
        data-id={s.id}
        data-stage={s.stage}
        data-scan={scan ? (isClean(scan) ? "clean" : scan.code > 0 ? "code" : "soft") : undefined}
      >
        <div className="skill-row">
          <button
            className={"switch" + (on ? " on" : "")}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={"启用 " + s.name}
            onClick={() => onToggle(s.id)}
          >
            <i />
          </button>
          <div className="skill-main">
            <div className="skill-title">
              <b>{s.name}</b>
              <code className="skill-id">{s.id}</code>
              {s.version ? <span className="skill-ver">v{s.version}</span> : null}
              {scan ? <ScanBadge scan={scan} /> : null}
            </div>
            <p className="skill-desc">{s.description}</p>
            {s.triggers.length ? (
              <p className="skill-triggers">触发词：{s.triggers.slice(0, 8).join("、")}</p>
            ) : null}
          </div>
        </div>
        {scan && scan.findings.length ? (
          <details className="skill-scan">
            <summary>
              扫描到 {scan.findings.length} 处 · 代码块 {scan.code} / 正文 {scan.prose} / 劝阻 {scan.guard}
            </summary>
            <ul className="scan-list">
              {scan.findings.map((f) => (
                <li key={f.line + f.rule} data-kind={f.kind}>
                  <code className="scan-line">{f.line}</code>
                  <span className="scan-kind">{SCAN_KIND_LABEL[f.kind]}</span>
                  <b className="scan-label">{f.label}</b>
                  <code className="scan-text">{f.text}</code>
                  {/* 后果写在卡上而不是 hover 里：用户要先知道会出什么事，才判断得了这条技能要不要装 */}
                  <span className="scan-why">{f.why}</span>
                </li>
              ))}
            </ul>
            <p className="scan-note">
              只扫 SKILL.md 正文，不扫 refs/ 与仓库脚本。命中性质是按位置猜的，得自己看原文再决定。
            </p>
          </details>
        ) : null}
        <details className="skill-body">
          <summary>看规则正文（{s.body.length} 字符）</summary>
          <pre>{s.body}</pre>
        </details>
      </li>
    );
  };

  const renderGroups = (list: Skill[]) =>
    groupSkills(list).map((g) => (
      <div className="skill-group" key={g.key} data-cat={g.key}>
        <h4 className="skill-group-head">
          {g.key} <span>{g.skills.length}</span>
        </h4>
        <ul>{g.skills.map(renderItem)}</ul>
      </div>
    ));

  const copyClone = async (e: SourceEntry) => {
    await copyText(cloneCommand(e));
    setCopied(e.id);
    window.setTimeout(() => setCopied((v) => (v === e.id ? "" : v)), 1500);
  };

  const renderAudit = (a: AuditRecord) => (
    <div className="src-audited" data-verdict={a.verdict}>
      <p className="src-verdict-text">{a.verdictText}</p>
      <p className="src-metrics">
        {a.skills} 份 SKILL.md · 最长 {a.longest} 字符 · 超 {SKILL_CHAR_LIMIT} 上限 {a.oversize} 份
        {a.predicted && a.predicted !== a.risk ? ` · 预判 ${a.predicted} → 实测 ${a.risk}` : ""}
      </p>
      {a.hits.length ? (
        <table className="src-hits">
          <thead>
            <tr>
              <th>扫描项</th>
              <th>文件</th>
              <th>性质</th>
            </tr>
          </thead>
          <tbody>
            {a.hits.map((h, i) => (
              <tr key={`${h.pattern}-${h.kind}-${i}`} data-kind={h.kind}>
                <td>
                  <code>{h.pattern}</code>
                  {h.note ? <span className="src-hit-note">{h.note}</span> : null}
                  {h.evidence.length ? (
                    <ul className="src-evidence">
                      {h.evidence.map((ev) => (
                        <li key={ev}>
                          <code>{ev}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td>{h.files}</td>
                <td className={"hit-" + h.kind}>{HIT_KIND_LABEL[h.kind]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {a.keep.length ? (
        <div className="src-keep">
          <b>可以拿</b>
          <ul>
            {a.keep.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {a.drop.length ? (
        <div className="src-drop">
          <b>必须排除</b>
          <ul>
            {a.drop.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {a.applied?.length ? (
        <p className="src-applied">
          已落地为内建技能 {a.applied.map((x) => `「${x}」`).join("、")}
        </p>
      ) : null}
    </div>
  );

  const renderSource = (e: SourceEntry) => {
    const facts = [
      e.facts?.lang || "",
      typeof e.facts?.stars === "number" ? `${e.facts.stars}★` : "",
      e.facts?.license ? e.facts.license : "",
      e.facts?.pushed ? `推送 ${e.facts.pushed}` : "",
    ].filter(Boolean);
    const verified = e.checked === "api" ? "已核实" : e.checked === "web" ? "仅确认存在" : "未核实";
    const audit = AUDIT_BY_ID[e.id];
    const downgraded = audit && audit.predicted && audit.predicted !== audit.risk;
    return (
      <li
        className={"src-item" + (audit ? " audited" : "")}
        key={e.id}
        data-id={e.id}
        data-hook={e.hook}
        data-stage={e.stage}
        data-verdict={audit?.verdict ?? ""}
      >
        <div className="src-row">
          <div className="src-main">
            <div className="src-title">
              <b>{e.name}</b>
              <code className="src-repo">{e.facts?.movedTo || e.id}</code>
            </div>
            <p className="src-what">{e.what}</p>
          </div>
          <div className="src-badges">
            <span className={"src-badge kind-" + e.kind}>{KIND_LABEL[e.kind]}</span>
            <span className={"src-badge hook-" + e.hook}>{HOOK_LABEL[e.hook]}</span>
            {e.risk === "high" ? (
              <span className={"src-badge risk" + (downgraded ? " stale" : "")}>
                {downgraded ? "预判高风险" : "高风险"}
              </span>
            ) : null}
            {audit ? (
              <span className={"src-badge verdict-" + audit.verdict}>{VERDICT_LABEL[audit.verdict]}</span>
            ) : null}
          </div>
        </div>
        <details className="src-more">
          <summary>
            审计项（{e.audit.length}）· {verified}
            {e.facts?.movedTo ? " · 已改名" : ""}
            {audit ? ` · 实测：${VERDICT_LABEL[audit.verdict]}` : " · 待实测"}
          </summary>
          <ul className="src-audit">
            {e.audit.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          {facts.length ? <p className="src-facts">{facts.join(" · ")} · 2026-11-01</p> : null}
          {audit ? renderAudit(audit) : null}
          <div className="src-actions">
            <button className="link-btn" type="button" onClick={() => void copyClone(e)}>
              {copied === e.id ? "已复制" : "复制 clone 命令"}
            </button>
            <a className="link-btn" href={repoUrl(e)} target="_blank" rel="noreferrer">
              打开仓库
            </a>
          </div>
        </details>
      </li>
    );
  };

  return (
    <div className="modal-scrim" id="skillPanel" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="技能库">
        <header className="modal-head">
          <h2>技能库</h2>
          <span className="modal-sub">
            技能是给模型的编码规范；来源清单是外部仓库的审计底稿，两者分开。
          </span>
          <button className="icon-btn" type="button" title="关闭" onClick={onClose}>
            &times;
          </button>
        </header>

        <div className="skill-tabs" id="skillTabs" role="tablist">
          <button
            id="tabSkills"
            type="button"
            role="tab"
            aria-selected={tab === "skills"}
            className={"skill-tab" + (tab === "skills" ? " on" : "")}
            onClick={() => setTab("skills")}
          >
            技能 <span>{skills.length}</span>
          </button>
          <button
            id="tabSources"
            type="button"
            role="tab"
            aria-selected={tab === "sources"}
            className={"skill-tab" + (tab === "sources" ? " on" : "")}
            onClick={() => setTab("sources")}
          >
            来源清单 <span>{SOURCES.length}</span>
          </button>
        </div>

        {tab === "skills" ? (
          <>
            <div className="skill-src">
              <div className="skill-src-path" id="skillDir" title={dir || ""}>
                {dir ? dir : "未接入外部技能库"}
              </div>
              <button className="btn ghost" id="btnSkillPickDir" type="button" onClick={onOpenDir}>
                选目录
              </button>
              {dir ? (
                <>
                  <button className="btn ghost" id="btnSkillReload" type="button" disabled={loading} onClick={onReload}>
                    {loading ? "扫描中…" : "重扫"}
                  </button>
                  <button className="btn ghost" id="btnSkillClearDir" type="button" onClick={onClearDir}>
                    断开
                  </button>
                </>
              ) : null}
            </div>

            <label className="check skill-auto">
              <input id="skillAuto" type="checkbox" checked={auto} onChange={(e) => onToggleAuto(e.target.checked)} />
              <span>按触发词自动加载（一句话里出现「react」「建表」这类词时自动补上对应技能）</span>
            </label>

            <div className="skill-list" id="skillList">
              <h3>
                内建 <span>{builtin.length}</span>
              </h3>
              {renderGroups(builtin)}

              {local.length ? (
                <>
                  <h3>
                    外部技能库 <span>{local.length}</span>
                  </h3>
                  <p className={"scan-headline" + (scanSum.withCode ? " warn" : "")} id="scanHeadline">
                    {scanHeadline(scanSum)}
                    {scanSum.truncated > 0 ? ` · ${scanSum.truncated} 个正文超 ${SKILL_CHAR_LIMIT} 字符，加载时会被截断` : ""}
                  </p>
                  {renderGroups(local)}
                </>
              ) : null}

              {errors.length ? (
                <div className="skill-errors" id="skillErrors">
                  <b>读不出来的技能（{errors.length}）</b>
                  <ul>
                    {errors.map((e) => (
                      <li key={e.id}>
                        <code>{e.id}</code> — {e.error}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!local.length && dir && !loading ? (
                <p className="skill-hint">这个目录下没找到技能。技能目录里每个子文件夹放一个 SKILL.md。</p>
              ) : null}
              {!dir ? (
                <p className="skill-hint">
                  想加自己的规范：建一个文件夹，里面每个子目录放一份 SKILL.md（frontmatter 写 name 与
                  description，可选 category / stage），再点「选目录」指过来即可。
                </p>
              ) : null}

              {local.length ? (
                <div className="skill-scan-foot">
                  <span className="foot-note">扫描结果写成 Markdown：只有「第几行写了什么」，不含技能正文</span>
                  <button className="btn ghost" id="btnExportScan" type="button" onClick={onExportScan}>
                    导出扫描结果
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="src-summary" id="sourceSummary">
              <span>
                登记 <b>{sum.total}</b>
              </span>
              <span>
                可接入 <b>{sum.attach}</b>
              </span>
              <span>
                需宿主 <b>{sum.hosted}</b>
              </span>
              <span>
                仅参考 <b>{sum.readonly}</b>
              </span>
              <span className={sum.risk ? "warn" : ""}>
                高风险 <b>{sum.risk}</b>
              </span>
              <span className="src-summary-note">
                已核实 {sum.verified}/{sum.total}
              </span>
              <span className={"src-summary-note" + (auditSum.reject ? " warn" : "")}>
                已实测 {auditSum.total} · 不接入 <b>{auditSum.reject}</b> · 挑着接 <b>{auditSum.selective}</b>
              </span>
            </div>

            <div className="skill-list" id="sourceList">
              {groupSources(SOURCES).map((g) => (
                <div className="src-group" key={g.stage} data-stage={g.stage}>
                  <h4 className="skill-group-head">
                    {STAGE_LABEL[g.stage]}
                    <em className="skill-group-en">{g.stage}</em>
                    <span>{g.entries.length}</span>
                  </h4>
                  <ul>{g.entries.map(renderSource)}</ul>
                </div>
              ))}
              <p className="skill-hint">
                清单只记录「仓库是什么、能不能接入、要查什么」，不含任何第三方正文。带「可接入」的仓库
                clone 下来后在「技能」页选它的目录即可扫描。标了「实测」的，是把仓库拉下来 grep 过一遍：
                共 {auditedInstruction} 处命中是「要求照做」，其余是防护规则或变更记录——
                <b>扫出来的关键词本身不算风险，要看它在哪出现</b>。
              </p>
            </div>
          </>
        )}

        <footer className="modal-foot">
          {tab === "sources" ? (
            <>
              <span className="foot-note">清单 + 实测报告，导成一份 Markdown</span>
              <button className="btn ghost" id="btnExportAudit" type="button" onClick={onExportAudit}>
                导出审计底稿
              </button>
            </>
          ) : (
            <button
              className="btn ghost"
              type="button"
              onClick={() => active.forEach(onToggle)}
              disabled={!active.length}
            >
              全部关闭
            </button>
          )}
          <button className="btn primary" id="btnSkillDone" type="button" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
