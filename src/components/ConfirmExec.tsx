/** 执行授权确认框：exec 类命令默认不跑，先问人。
 *
 * 三个选项对应三种"同意"的粒度，覆盖实际使用里真正会遇到的三种意图：
 * - 仅这一次：我现在想跑这一条，但不确定以后要不要；
 * - 本工程目录都允许：这是我在这个项目里的常规操作（比如每次改完都跑 npm test）；
 * - 拒绝：不要跑，并把"用户拒绝了"如实回报给模型。
 *
 * 刻意没有"以后都别再问"这种选项：一条命令的批准是一次具体的人类意图，
 * 把它变成永久通行证，用户不会记得自己三个月前批过什么。
 * 授权也不落盘（Rust 侧只在内存里记账），进程重启即失效。
 */
import { Icon } from "./ui";

export type ExecChoice = "once" | "session" | "deny";

export interface ExecAsk {
  /** 给人看的命令，例如 "npm test" */
  label: string;
  resolve: (choice: ExecChoice) => void;
}

export interface ConfirmExecProps {
  ask: ExecAsk | null;
  onChoose: (choice: ExecChoice) => void;
}

export function ConfirmExec({ ask, onChoose }: ConfirmExecProps) {
  if (!ask) return null;

  return (
    <div
      className="modal-scrim"
      id="confirmExec"
      onClick={(e) => {
        // 点遮罩等同拒绝：不确定的点击不该被当成同意
        if (e.target === e.currentTarget) onChoose("deny");
      }}
    >
      <div className="modal" role="dialog" aria-label="确认执行命令">
        <header className="modal-head">
          <h2>确认执行命令</h2>
          <button className="icon-btn" type="button" title="拒绝" onClick={() => onChoose("deny")}>
            <Icon name="close" />
          </button>
        </header>
        <div className="diff-body">
          <p className="diff-note">模型请求在工程目录里运行下面这条命令。它会在你的本机起一个子进程：</p>
          <pre className="exec-cmd">{ask.label}</pre>
          <p className="diff-note">
            这条命令已经在白名单内（只允许测试、构建、只读 Git），并会在 60 秒后强制结束。
            「本工程目录都允许」只在这次打开的工程目录里有效，关掉工程或重启程序后需要重新批准。
          </p>
        </div>
        <footer className="modal-foot">
          <button className="btn" type="button" onClick={() => onChoose("deny")}>
            拒绝
          </button>
          <button className="btn" type="button" onClick={() => onChoose("once")}>
            仅这一次
          </button>
          <button className="btn primary" type="button" onClick={() => onChoose("session")}>
            本工程目录都允许
          </button>
        </footer>
      </div>
    </div>
  );
}
