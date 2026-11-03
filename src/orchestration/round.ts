/** 轮末判定：一轮对话（= 一条助手消息 + 这一轮的工具执行）结束后，下一步做什么。
 *
 * 为什么单独抽出来：这段逻辑原来埋在 `send()` 闭包的最深处，夹在「写文件」「跑测试」
 * 「拼隐藏消息」「更新 state」之间，改了不知道会碰到谁。它本身是**纯决策**——
 * 输入是这一轮的观察结果，输出是「停」还是「继续」，没有 IO、没有 React。
 * 抽出来之后每条出口都能单独断言。
 *
 * **这个模块的边界（别读多了）**：它只回答「停还是继续」。它**不阻止任何副作用**——
 * 「报错后还会不会跑 npm test」「计划模式下会不会落盘」都在 App.tsx 里，由调用方的
 * 提前 break 守着（`App.tsx` 的 `if (aborted || failed) break;`）。那一行不能删：
 * 删了之后 nextRound 仍然会返回 stop，但 `npm test` 已经跑完了——判定太晚，
 * 拦不住已经发生的事。这里保留 aborted/failed 分支是为了让本函数的规格完整
 * （纯函数对全定义域有值），不是生产路径的守卫。
 */

import { MAX_TEST_ROUNDS } from "../lib/tools";

/** 单次发送里最多几轮「读文件 → 改文件」。到顶就停，让用户再发一条。 */
export const MAX_ROUNDS = 6;

/** 这一轮结束时观察到的信号。全部是布尔/计数，方便断言。 */
export interface RoundSignals {
  /** 用户点了停止 */
  aborted: boolean;
  /** 网络/上游报错 */
  failed: boolean;
  /** 测试回路判定这一轮必须放弃（连续 MAX_TEST_ROUNDS 轮没过） */
  testGiveUp: boolean;
  /** 本轮执行了几条工具调用 */
  toolCalls: number;
  /** 本轮模型要求读几个文件（`@@read:`） */
  reads: number;
  /** 本轮模型要求附几个技能文件 */
  skillRefs: number;
  /** 当前轮次，0 起 */
  round: number;
}

/**
 * 停止原因。
 *
 * 每种原因都必须有明确的归宿：要么一句提示，要么**有理由的静默**
 * （用户自己点的停止、已经报过的错——重复弹窗只会盖掉原来那条）。
 * 归宿在 `stopNotice` 里逐条写清楚，不是"默认不提示"。
 */
export type StopReason = "aborted" | "failed" | "test_gave_up" | "no_followup" | "rounds_exhausted";

export type RoundEnd = { kind: "stop"; reason: StopReason } | { kind: "continue" };

/**
 * 轮末判定。
 *
 * 判定顺序是有讲究的，不能重排：
 *
 * 1. 中断/报错最先——已经出错的轮次不该再触发任何后续动作。
 * 2. 测试回路放弃——测试明确不过时，即使模型还想继续读文件也要停，
 *    否则会变成"带着红灯继续写"。
 * 3. 没有任何后续请求——这才是**正常收尾**，模型把话说完了。
 * 4. 轮数到顶——注意它排在 3 之后：最后一轮如果本来就没有后续请求，
 *    应该按"说完了"收尾，而不是报"轮数用尽"（那会让用户以为被截断了）。
 */
export function nextRound(s: RoundSignals): RoundEnd {
  if (s.aborted) return { kind: "stop", reason: "aborted" };
  if (s.failed) return { kind: "stop", reason: "failed" };
  if (s.testGiveUp) return { kind: "stop", reason: "test_gave_up" };

  const wantsContext = s.reads > 0 || s.skillRefs > 0;
  if (s.toolCalls === 0 && !wantsContext) return { kind: "stop", reason: "no_followup" };

  if (s.round >= MAX_ROUNDS - 1) return { kind: "stop", reason: "rounds_exhausted" };

  return { kind: "continue" };
}

/**
 * 停止时要对用户说的话。`null` 表示不弹——但每一种 `null` 都有具体理由，见下。
 *
 * 文案就是用户体验的一部分，所以这几种情况都只在这里定义一次：
 * 同一条话术在 App 与这里各写一份，改一处忘另一处的那天，用户会看到两句不一样的结论。
 */
export function stopNotice(reason: StopReason): string | null {
  switch (reason) {
    case "rounds_exhausted":
      return `已达到本次最多 ${MAX_ROUNDS} 轮读写，继续请再发一条消息`;
    case "test_gave_up":
      return `测试 ${MAX_TEST_ROUNDS} 轮仍未通过，已停止自动修复，请人工处理`;
    case "no_followup":
      // 正常收尾：模型把话说完了，不需要额外解释
      return null;
    case "aborted":
      // 中止是用户自己点出来的，不用再弹一次
      return null;
    case "failed":
      // 报错原文已经由上游那条 toast 报过，重复弹只会盖掉它
      return null;
  }
}

/**
 * 自动测试回路的开启条件。
 *
 * `autoTest` 必须是**严格的 true**。它是"程序会自动执行工程里写死的 npm 脚本"这件事的开关，
 * 而那个脚本可能正是模型刚写的。所以只有明确写了 `true` 才跑；
 * `undefined`、`"false"`、`1` 一律视为关——写成 `!g.autoTest` 这类取反判断，
 * 会把 `"false"` 这种字符串当成开启。
 *
 * 参数收的是**原始值**（`unknown`），归一化在函数内部做：如果让调用方先归一，
 * 这个函数的承诺就有一半留在外面，改错了单测也照样绿。
 */
export interface AutoTestGate {
  /** 这一轮是否真的写成功了至少一个文件 */
  wroteSomething: boolean;
  /** 用户设置里的自动测试开关（原样传进来） */
  autoTest: unknown;
  /** 用户设置里的工具调用开关（原样传进来；只有显式 false 才算关） */
  toolCalls: unknown;
  planMode: boolean;
  /** 是否运行在桌面端（浏览器直开没有 IPC，跑不了命令） */
  desktop: boolean;
  /** 是否已接入工程目录 */
  hasWorkspace: boolean;
}

export function shouldAutoTest(g: AutoTestGate): boolean {
  if (!g.wroteSomething) return false;
  if (g.autoTest !== true) return false;
  // 只有显式 false 才算关：这个开关默认是开的，缺字段不该被当成用户关掉了
  if (g.toolCalls === false) return false;
  if (g.planMode) return false;
  if (!g.desktop) return false;
  if (!g.hasWorkspace) return false;
  return true;
}
