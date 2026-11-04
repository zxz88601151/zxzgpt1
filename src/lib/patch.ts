/** 补丁引擎：纯函数，只算结果，不碰磁盘、不弹确认。
 *
 * 落盘统一走注册表工具的 ctx.writeFile（也就是 write_file 那条路），这样备份、
 * 写入前确认、回读校验全部复用，不另起一套写路径。路线图 P2-2 的要求逐条对齐：
 *
 * - 精确替换，不做模糊匹配：old_text 必须逐字命中。命中 0 次或多次都直接报错，
 *   绝不猜一个“最像的”位置改下去——模糊匹配改错地方比改失败更难发现。
 * - 冲突检测 = 精确命中本身：文件在模型读完之后被人改过，old_text 就对不上，
 *   拒绝写入。hash 比对只能告诉你“文件变过”，命中失败还能告诉你是“你要改的
 *   那段已经不是你读到的样子”，对改动点更贴切，所以这里不用 hash。
 * - 原子性：多 hunk 先在内存里算出完整结果，任一 hunk 失败就整体不写，
 *   不留改了一半的文件。真正的落盘仍由调用方在算出结果后做一次。
 * - CRLF：整文件以 CRLF 为主时按 CRLF 匹配与输出，LF 文件不受影响；
 *   混用换行符的文件会被统一成主导的那一种，这一点写在下面注释里。
 */

export interface PatchHunk {
  old_text: string;
  new_text: string;
}

export type PatchResult = { ok: true; content: string } | { ok: false; error: string };

/** 拆出换行风格：含 CRLF 就按 CRLF 文件处理，匹配与输出都走同一套。 */
function splitLineEndings(content: string): { crlf: boolean; text: string } {
  const crlf = content.includes("\r\n");
  return { crlf, text: crlf ? content.replace(/\r\n/g, "\n") : content };
}

function joinLineEndings(crlf: boolean, text: string): string {
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

/** 模型给的 old/new 也可能带 CRLF：先归一成 LF 再比对，否则 LF 文件永远对不上。 */
function normalizeSnippet(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

/** 单处精确替换：必须恰好命中一次，否则报错且不返回任何新内容。 */
function replaceOnce(text: string, oldText: string, newText: string): PatchResult {
  if (!oldText) return { ok: false, error: "old_text 不能为空：空串在文件里处处都算命中，没法定位要改哪一处" };
  if (oldText === newText) return { ok: false, error: "old_text 与 new_text 相同，这次编辑没有改动" };
  const n = countOccurrences(text, oldText);
  if (n === 0) {
    return {
      ok: false,
      error: "old_text 没有命中（出现 0 次）：文件可能已被改过，请先用 read_file 核对原文，不要凭印象猜原文",
    };
  }
  if (n > 1) {
    return {
      ok: false,
      error: `old_text 命中 ${n} 次：请把 old_text 扩到含唯一上下文（多带几行上下行），让它只命中要改的那一处`,
    };
  }
  return { ok: true, content: text.replace(oldText, newText) };
}

/** 单处编辑：edit_file 工具的纯计算部分。 */
export function applyEdit(content: string, oldText: string, newText: string): PatchResult {
  const { crlf, text } = splitLineEndings(content);
  const r = replaceOnce(text, normalizeSnippet(oldText), normalizeSnippet(newText));
  if (!r.ok) return r;
  return { ok: true, content: joinLineEndings(crlf, r.content) };
}

/** 多处编辑：apply_patch 工具的纯计算部分。hunk 按顺序作用在前一个的结果上，
 *  任一处失败就整体报错，调用方拿不到半截结果，也就写不出去。 */
export function applyHunks(content: string, hunks: PatchHunk[]): PatchResult {
  if (!hunks.length) return { ok: false, error: "hunks 不能为空：至少给一个 old_text/new_text 对" };
  const { crlf, text } = splitLineEndings(content);
  let cur = text;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const r = replaceOnce(cur, normalizeSnippet(h.old_text), normalizeSnippet(h.new_text));
    if (!r.ok) return { ok: false, error: `第 ${i + 1} 个 hunk 失败：${r.error}` };
    cur = r.content;
  }
  return { ok: true, content: joinLineEndings(crlf, cur) };
}
