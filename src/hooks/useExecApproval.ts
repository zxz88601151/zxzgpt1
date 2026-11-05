/** 执行授权（exec / MCP）的人类确认桥（从 App.tsx 抽出的 hook）。
 *
 * 工具执行是 async 流程，确认框是 React 状态，所以用一个 Promise 桥接：
 * ref 让同步路径（如撤回授权时作废待答的框）能立刻拿到 resolver，
 * state 负责触发渲染。授权表本身在 Rust 侧记账，这里只是镜像。
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { permList, permRevoke, type ExecGrant } from "../lib/fsapi";
import type { ExecAsk, ExecChoice } from "../components/ConfirmExec";
import type { Notice } from "../orchestration/session";
import type { AppState } from "../types";

export interface ExecApprovalApi {
  grants: ExecGrant[];
  execAsk: ExecAsk | null;
  askExec: (label: string) => Promise<ExecChoice>;
  answerExec: (choice: ExecChoice) => void;
  refreshGrants: () => Promise<void>;
  revokeGrant: (scope?: string[]) => void;
  dropExecGrants: () => void;
}

export function useExecApproval(opts: {
  stateRef: MutableRefObject<AppState>;
  toast: Notice;
  drawerOpen: boolean;
}): ExecApprovalApi {
  const { stateRef, toast, drawerOpen } = opts;
  const [grants, setGrants] = useState<ExecGrant[]>([]);
  const [execAsk, setExecAsk] = useState<ExecAsk | null>(null);
  const execAskRef = useRef<ExecAsk | null>(null);

  const askExec = useCallback(
    (label: string) =>
      new Promise<ExecChoice>((resolve) => {
        const ask: ExecAsk = { label, resolve };
        execAskRef.current = ask;
        setExecAsk(ask);
      }),
    []
  );

  const answerExec = useCallback((choice: ExecChoice) => {
    const cur = execAskRef.current;
    execAskRef.current = null;
    setExecAsk(null);
    cur?.resolve(choice);
  }, []);

  /** 从 Rust 侧拉一次授权表。失败就当空（界面只是镜像，权威判定永远在 Rust）。 */
  const refreshGrants = useCallback(async () => {
    const ws = stateRef.current.settings.workspace;
    if (!ws) {
      setGrants([]);
      return;
    }
    try {
      setGrants(await permList(ws.sessionId));
    } catch {
      setGrants([]);
    }
  }, [stateRef]);

  /** 撤销一条 / 全部授权，撤销后重新拉表保持界面与 Rust 一致。 */
  const revokeGrant = useCallback(
    (scope?: string[]) => {
      const ws = stateRef.current.settings.workspace;
      if (!ws) return;
      permRevoke(ws.sessionId, scope)
        .then(setGrants)
        .catch((e) => toast(`撤销失败：${(e as Error).message}`, "error"));
    },
    [stateRef, toast]
  );

  useEffect(() => {
    if (drawerOpen) void refreshGrants();
  }, [drawerOpen, refreshGrants]);

  /**
   * 把执行授权收回到「当前对话」的粒度：Rust 侧按工程目录（sessionId）记账，
   * 切对话 / 新建对话时主动撤销，不让上一个对话点过的「允许」给下一个模型用。
   * 撤销失败要说出来：静默失败等于授权还在，而用户以为已经收回了。
   */
  const dropExecGrants = useCallback(() => {
    answerExec("deny");
    const ws = stateRef.current.settings.workspace;
    if (!ws) return;
    permRevoke(ws.sessionId)
      .then(() => setGrants([]))
      .catch((e) => toast(`执行授权撤回失败：${(e as Error).message}`, "error"));
  }, [answerExec, stateRef, toast]);

  return { grants, execAsk, askExec, answerExec, refreshGrants, revokeGrant, dropExecGrants };
}
