/** 本地工程模式的逻辑层（ADR 0001 第 5 步：把 App.tsx 的接线层拆薄）。
 *
 * 这里不 import react、不碰组件 state：写盘、读文件、项目记忆、技能附件、
 * 消息变换都做成独立函数。App 只保留 useCallback 薄封装与 toast / 目录树刷新
 * 这类 UI 副作用。依赖方向单向：workspace → lib 各模块，不反向依赖 App。
 */

import type { Conversation, FileWriteResult, Message } from "../types";
import { fsExists, fsRead, fsWrite, sessionFor, undoWrite } from "./fsapi";
import { backupRelPath, relPathError, type FileBlock, type ReadOutcome } from "./files";
import { diffLines, diffStats } from "./diff";
import { stampNow } from "./undo";
import { buildPendingWrites, type PendingWrite } from "./pending";
import { PROJECT_MEMORY_FILES, truncateProjectMemory } from "./project";
import { skillRefLabel, type Skill, type SkillRef } from "./skill";

/** 就地更新一条消息。找不到会话/下标时原样返回，不改原数组。 */
export function patchMessageAt(
  conversations: Conversation[],
  convId: string,
  index: number,
  fn: (m: Message) => Message,
  now: number,
): Conversation[] {
  return conversations.map((c) => {
    if (c.id !== convId) return c;
    const list = c.messages.slice();
    const old = list[index];
    if (!old) return c;
    list[index] = fn(old);
    return { ...c, messages: list, updatedAt: now };
  });
}

export interface ApplySummary {
  results: FileWriteResult[];
  ok: number;
  fail: number;
  unverified: number;
  backedUp: number;
}

/**
 * 把一组 file: 块写进工程目录：路径校验 → 覆盖前备份 → 写入 → 回读校验 → 差异统计。
 *
 * 「确认不存在」与「校验失败」必须分开：fsExists 会把后者抛出来，抛了就不能往下写，
 * 否则等于把一次越界/链接校验失败当成「新建文件」，静默跳过备份，覆盖就不可撤销。
 * toast 与目录树刷新留给调用方，它们是 UI 副作用，不属于这一层。
 */
export async function applyFileBlocks(blocks: FileBlock[], sessionId: string): Promise<ApplySummary> {
  const stamp = stampNow();
  const results: FileWriteResult[] = [];
  let backedUp = 0;

  for (const b of blocks) {
    const bad = relPathError(b.path);
    if (bad) {
      results.push({ path: b.path, ok: false, error: bad });
      continue;
    }
    try {
      let oldText = "";
      let backup: string | undefined;
      let exists: boolean;
      try {
        exists = await fsExists(sessionId, b.path);
      } catch (e) {
        results.push({
          path: b.path,
          ok: false,
          error: `无法确认目标是否存在，已中止写入：${(e as Error).message}`,
        });
        continue;
      }
      if (exists) {
        // 备份失败必须阻断写入：没有备份的覆盖不可撤销，不能「先写了再说」。
        oldText = await fsRead(sessionId, b.path);
        backup = backupRelPath(stamp, b.path);
        // 走撤销专用通道：普通 fsWrite 整目录拒绝 .zxz/undo，
        // 因为模型手里的 write_file 用的正是那条通道。
        await undoWrite(sessionId, stamp, b.path, oldText);
        backedUp += 1;
      }
      const r = await fsWrite(sessionId, b.path, b.content);
      let verified = true;
      try {
        verified = (await fsRead(sessionId, b.path)) === b.content;
      } catch {
        verified = false;
      }
      const stats = diffStats(diffLines(oldText, b.content));
      results.push({
        path: b.path,
        ok: true,
        bytes: r.bytes,
        created: r.created,
        ...(backup ? { backup } : {}),
        add: stats.add,
        del: stats.del,
        verified,
      });
    } catch (e) {
      results.push({ path: b.path, ok: false, error: (e as Error).message });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  return {
    results,
    ok,
    fail: results.length - ok,
    unverified: results.filter((r) => r.ok && r.verified === false).length,
    backedUp,
  };
}

/** 写入前确认面板用的差异项：读不到旧内容就按新建处理，面板里显示为空。 */
export async function buildPendingItems(blocks: FileBlock[], sessionId: string): Promise<PendingWrite[]> {
  const olds = new Map<string, string>();
  for (const b of blocks) {
    try {
      if (await fsExists(sessionId, b.path)) olds.set(b.path, await fsRead(sessionId, b.path));
    } catch {
      /* 读不到旧内容就按新建处理 */
    }
  }
  return buildPendingWrites(blocks, olds);
}

/** 接入工程时读项目记忆：CLAUDE.md 优先，没有就退到 AGENTS.md，读不到就算没有。 */
export async function loadProjectMemory(
  sessionId: string
): Promise<{ source: string; body: string } | null> {
  for (const file of PROJECT_MEMORY_FILES) {
    try {
      const body = await fsRead(sessionId, file);
      if (body.trim()) return { source: file, body: truncateProjectMemory(body) };
    } catch {
      /* 这个文件不存在就试下一个 */
    }
  }
  return null;
}

/** 按模型的要求读真实文件内容；路径非法时把原因当成该条结果回传，不阻断其余。 */
export async function readForModel(sessionId: string, paths: string[]): Promise<ReadOutcome[]> {
  const out: ReadOutcome[] = [];
  for (const p of paths) {
    const bad = relPathError(p);
    if (bad) {
      out.push({ path: p, error: bad });
      continue;
    }
    try {
      out.push({ path: p, content: await fsRead(sessionId, p) });
    } catch (e) {
      out.push({ path: p, error: (e as Error).message });
    }
  }
  return out;
}

/** 按模型要求取技能附件：内建技能只有正文，外部技能从它自己的目录读。 */
export async function readSkillRefs(all: Skill[], refs: SkillRef[]): Promise<ReadOutcome[]> {
  const out: ReadOutcome[] = [];
  for (const r of refs) {
    const label = skillRefLabel(r);
    const sk = all.find((x) => x.id === r.skillId);
    if (!sk) {
      out.push({ path: label, error: `没有这个技能（可用：${all.map((x) => x.id).slice(0, 8).join("、")}）` });
      continue;
    }
    if (!sk.dir) {
      out.push(
        r.rel === "SKILL.md"
          ? { path: label, content: sk.body }
          : { path: label, error: "内建技能没有附带文件，只能取 SKILL.md" }
      );
      continue;
    }
    try {
      out.push({ path: label, content: await fsRead(await sessionFor(sk.dir), r.rel) });
    } catch (e) {
      out.push({ path: label, error: (e as Error).message });
    }
  }
  return out;
}
