import { describe, expect, it } from "vitest";
import { renderInline, renderMarkdown } from "./md";

describe("renderMarkdown 块级", () => {
  it("渲染标题并去掉行尾多余的 #", () => {
    expect(renderMarkdown("## 小标题 ##")).toBe("<h2>小标题</h2>");
  });

  it("渲染有序 / 无序列表", () => {
    expect(renderMarkdown("- 甲\n- 乙")).toBe("<ul><li>甲</li><li>乙</li></ul>");
    expect(renderMarkdown("1. 甲\n2. 乙")).toBe("<ol><li>甲</li><li>乙</li></ol>");
  });

  it("支持二级嵌套列表", () => {
    const html = renderMarkdown("- 甲\n  - 甲一\n- 乙");
    expect(html).toContain("<ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul>");
  });

  it("渲染表格", () => {
    const html = renderMarkdown("| 模块 | 状态 |\n| --- | --- |\n| 流式 | PASS |");
    expect(html).toContain("<table><thead><tr><th>模块</th><th>状态</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>流式</td><td>PASS</td></tr></tbody>");
  });

  it("代码块带语言标签与复制按钮，且内部不再被当作 Markdown", () => {
    const html = renderMarkdown("```js\nconst a = 1; // 注释\n```");
    expect(html).toContain('class="code-block"');
    expect(html).toContain('<span>js</span>');
    expect(html).toContain('<button class="copy" type="button">复制</button>');
    expect(html).toContain('class="tk-key">const');
    expect(html).toContain('class="tk-com"');
    // 代码里的 # 不应变成标题
    expect(html).not.toContain("<h1>");
  });

  it("未闭合的代码块也能收尾渲染", () => {
    const html = renderMarkdown("```py\nprint(1)");
    expect(html).toContain('class="code-block"');
    expect(html).toContain("print");
  });

  it("渲染引用与分割线", () => {
    expect(renderMarkdown("> 引用一句")).toBe("<blockquote><p>引用一句</p></blockquote>");
    expect(renderMarkdown("---")).toBe("<hr />");
  });

  it("段落之间空行分段", () => {
    expect(renderMarkdown("第一段\n\n第二段")).toBe("<p>第一段</p><p>第二段</p>");
  });

  it("行内代码优先于其他语法", () => {
    expect(renderMarkdown("用 `**x**` 表示")).toContain('<code class="inline">**x**</code>');
  });
});

describe("renderInline 行内", () => {
  it("加粗 / 斜体 / 删除线", () => {
    expect(renderInline("**粗**")).toBe("<strong>粗</strong>");
    expect(renderInline("*斜*")).toBe("<em>斜</em>");
    expect(renderInline("~~删~~")).toBe("<del>删</del>");
  });

  it("Markdown 链接与裸链接都变成 target=_blank", () => {
    expect(renderInline("[Tauri](https://tauri.app)")).toContain(
      '<a href="https://tauri.app" target="_blank" rel="noreferrer noopener">Tauri</a>'
    );
    expect(renderInline("见 https://example.com/x")).toContain('href="https://example.com/x"');
  });

  it("拒绝 javascript: 与 data: 链接", () => {
    expect(renderInline("[点我](javascript:alert(1))")).not.toContain("href=");
    expect(renderInline("![x](data:text/html;base64,AA)")).not.toContain("<img");
  });

  it("转义 HTML，避免注入", () => {
    expect(renderInline('<img src=x onerror="alert(1)">')).not.toContain("<img");
    expect(renderMarkdown("<script>alert(1)</script>")).toContain("&lt;script&gt;");
  });

  it("两个空格换行转成 <br />，软换行合并为空格", () => {
    expect(renderInline("甲  \n乙")).toBe("甲<br />乙");
    expect(renderInline("甲\n乙")).toBe("甲 乙");
  });
});

describe("代码块信息串", () => {
  it("普通语言标记照常作为标题", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).toContain(">ts<");
    // 正文经语法高亮，关键字被包进 span，不能按纯文本断言
    expect(html).toContain(">const</span>");
  });

  it("file: 路径显示为标题，不再掉进正文", () => {
    const html = renderMarkdown("```file:src/a.ts\nlet a = 1;\n```");
    expect(html).toContain(">src/a.ts<");
    expect(html).not.toContain(">:src/a.ts");
    expect(html).toContain(">let</span>");
    expect(html).toContain("is-file");
  });
});
