/** 极简语法高亮：注释 / 字符串 / 数字 / 关键字 / 函数调用五类 token。
 *
 * 不引 highlight.js，保持零运行时依赖；对代码块的「可读」目标够用，
 * 不追求语法树的准确度。输入必须是已转义的 HTML 文本。
 */

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
  "case", "break", "continue", "new", "class", "extends", "import", "export", "from", "default",
  "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "delete", "in",
  "of", "this", "super", "null", "undefined", "true", "false", "def", "elif", "lambda", "None",
  "True", "False", "and", "or", "not", "is", "self", "print", "struct", "interface", "impl",
  "pub", "fn", "mut", "use", "crate", "select", "SELECT", "FROM", "WHERE", "INSERT", "UPDATE",
  "package", "void", "public", "private", "static", "final", "namespace", "template", "typename",
]);

const HL_RE = new RegExp(
  [
    "(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*|--[^\\n]*)", // 1 注释
    "(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)", // 2 字符串
    "(\\b\\d+(?:\\.\\d+)?\\b)", // 3 数字
    "([A-Za-z_$][\\w$]*)(?=\\s*\\()", // 4 函数调用
    "([A-Za-z_$][\\w$]*)", // 5 标识符 / 关键字
  ].join("|"),
  "g"
);

export function highlight(code: string): string {
  return code.replace(HL_RE, (match, com, str, num, fn, word) => {
    if (com) return `<span class="tk-com">${com}</span>`;
    if (str) return `<span class="tk-str">${str}</span>`;
    if (num) return `<span class="tk-num">${num}</span>`;
    if (fn) {
      return KEYWORDS.has(fn) ? `<span class="tk-key">${fn}</span>` : `<span class="tk-fn">${fn}</span>`;
    }
    if (word && KEYWORDS.has(word)) return `<span class="tk-key">${word}</span>`;
    return match;
  });
}

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word);
}
