/** 自实现 Markdown 渲染（零依赖）。
 *
 * 支持：标题、有序/无序列表（含嵌套）、表格、引用、分割线、链接、图片、
 * 行内代码、代码块（带语言标签与复制按钮）、加粗、斜体、删除线。
 * 所有文本都经过 escapeHtml，标签由本模块生成，不存在注入面。
 */

import { highlight } from "./hl";
import { escapeHtml, uid } from "./text";

// 信息串允许带冒号与路径，这样 ```file:src/a.ts 的路径不会被当成正文首行
const CODE_RE = /```([^\n]*)\n?([\s\S]*?)(?:```|$)/g;
const INLINE_RE = /`([^`\n]+)`/g;

export function renderCodeBlock(code: string, lang: string): string {
  const body = highlight(escapeHtml(code.replace(/\n$/, "")));
  const id = "cb-" + uid();
  // ```file:相对路径 —— 本地工程模式的落盘块，标题直接显示文件路径
  const filePath = /^(?:file|path)\s*:\s*(.+)$/i.exec(lang.trim());
  const head = filePath ? filePath[1].trim() : lang.trim() || "text";
  return (
    `<div class="code-block${filePath ? " is-file" : ""}" data-copy-target="${id}">` +
    `<div class="code-head"><span>${escapeHtml(head)}</span>` +
    `<button class="copy" type="button">复制</button></div>` +
    `<pre><code id="${id}">${body}</code></pre></div>`
  );
}

/** 行内富文本：自动链接 / Markdown 链接 / 加粗 / 斜体 / 删除线 */
export function renderInline(input: string): string {
  const tags: string[] = [];
  const keep = (html: string) => {
    tags.push(html);
    return `\u0000T${tags.length - 1}\u0000`;
  };

  let text = escapeHtml(input);

  // 先渲染 Markdown 链接：裸链接若先占位，会让 [x](url) 里的 url 被吃掉
  text = text.replace(/!?\[([^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (m, label: string, rawUrl: string) => {
    const clean = String(rawUrl).replace(/&amp;/g, "&").split(/\s+&quot;/)[0];
    if (/^\s*javascript:/i.test(clean) || /^\s*data:/i.test(clean)) return label;
    return m.startsWith("!")
      ? keep(`<img src="${clean}" alt="${label}" loading="lazy" />`)
      : keep(`<a href="${clean}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  });

  // 再处理裸链接
  text = text.replace(/(https?:\/\/[^\s<)"']+)/g, (_m, url: string) => {
    return keep(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`);
  });

  // 强调
  text = text.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string, b: string) => `<strong>${a || b}</strong>`);
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p: string, a: string) => `${p}<em>${a}</em>`);
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, (_m, p: string, a: string) => `${p}<em>${a}</em>`);
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 硬换行保留，软换行合并为空格
  text = text.replace(/ {2}\n/g, "<br />").replace(/\n/g, " ");

  // 还原标签占位
  return text.replace(/\u0000T(\d+)\u0000/g, (_m, i: string) => tags[Number(i)]);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** 按最小缩进去掉一层缩进，交给递归处理 */
function dedent(lines: string[]): string[] {
  const nonempty = lines.filter((l) => l.trim());
  if (!nonempty.length) return lines;
  const min = Math.min(...nonempty.map((l) => (l.match(/^\s*/) || [""])[0].length));
  return lines.map((l) => l.slice(min));
}

/** 支持多级嵌套的有序/无序列表 */
function renderList(lines: string[]): string {
  const indentOf = (line: string) => (line.match(/^\s*/) || [""])[0].length;
  const baseIndent = indentOf(lines[0]);
  const items: { text: string; children: string[] }[] = [];
  let cur: { text: string; children: string[] } | null = null;

  for (const raw of lines) {
    const marker = raw.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    const indent = indentOf(raw);

    if (marker && (indent <= baseIndent || !cur)) {
      if (cur) items.push(cur);
      cur = { text: marker[2], children: [] };
    } else if (cur && marker) {
      cur.children.push(raw);
    } else if (cur && indent > baseIndent) {
      cur.children.push(raw);
    } else if (cur) {
      cur.text += " " + raw.trim();
    } else {
      cur = { text: raw.trim(), children: [] };
    }
  }
  if (cur) items.push(cur);

  const body = items
    .map((it) => {
      let inner = renderInline(it.text);
      if (it.children.length) inner += renderList(dedent(it.children));
      return `<li>${inner}</li>`;
    })
    .join("");

  return /^\s*\d+[.)]\s+/.test(lines[0]) ? `<ol>${body}</ol>` : `<ul>${body}</ul>`;
}

/** 块级 Markdown → HTML */
export function renderMarkdown(src: string | null | undefined): string {
  const source = String(src ?? "");
  const blocks: string[] = [];
  const inlines: string[] = [];

  // 1) 抽出代码块与行内代码，避免其内部被当成 Markdown 处理
  let text = source.replace(CODE_RE, (_m, lang: string, code: string) => {
    blocks.push(renderCodeBlock(code, lang));
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  text = text.replace(INLINE_RE, (_m, code: string) => {
    inlines.push(`<code class="inline">${escapeHtml(code)}</code>`);
    return `\u0000I${inlines.length - 1}\u0000`;
  });

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${renderInline(para.join("\n"))}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    let m: RegExpMatchArray | null;

    if (!line.trim()) {
      flushPara();
      continue;
    }

    // 代码块占位
    if ((m = line.match(/^\u0000B(\d+)\u0000$/))) {
      flushPara();
      out.push(blocks[Number(m[1])]);
      continue;
    }

    // 标题
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${renderInline(m[2].replace(/\s+#+\s*$/, ""))}</h${lvl}>`);
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara();
      out.push("<hr />");
      continue;
    }

    // 引用
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      i--;
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // 表格
    if (line.includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next) && next.includes("-")) {
      flushPara();
      const head = splitRow(line);
      i += 2; // 跳过分隔行
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join("");
      const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        buf.push(lines[i]);
        i++;
      }
      i--;
      out.push(renderList(buf));
      continue;
    }

    para.push(line);
  }
  flushPara();

  let html = out.join("");
  html = html.replace(/\u0000I(\d+)\u0000/g, (_m, i: string) => inlines[Number(i)]);
  return html;
}
