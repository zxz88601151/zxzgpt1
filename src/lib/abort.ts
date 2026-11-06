/** 让一段可能永久挂起的等待，在主链路 signal 中止时立刻结算（独立复审 P1-1）。
 *
 * 典型场景：MCP 工具等用户点「允许」，`ask()` 返回的 Promise 只有在人点按钮时
 * 才 resolve。此时用户点「停止」，主链路已 abort，但那个 Promise 还挂着，
 * `runToolBatch` 的串行层就不会返回，`runRounds` 的 finally 不复位 busy —— UI 死锁。
 *
 * `waitAbortable` 把 signal 变成第二条结算通道：abort 立刻以 `fallback` 收摊，
 * 且不再等待原 Promise。原 Promise 之后 resolve/reject 都不会二次结算，
 * 也不会留下未处理的 rejection。
 *
 * 纯函数，不依赖 React / Tauri，便于单测。
 */
export function waitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  fallback: T,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(fallback);

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve(fallback);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}
