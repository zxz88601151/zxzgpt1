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

describe("属性注入回归（P0-2）", () => {
  it("URL 中的裸双引号不能突破 href 属性", () => {
    const html = renderInline("[a](https://x/\" onclick=\"alert(1))");
    expect(html).toContain('href="https://x/&quot; onclick=&quot;alert(1)"');
    expect(html).not.toContain('" onclick="');
  });

  it("图片 label 中的裸双引号不能突破 alt 属性（onerror 不落地）", () => {
    const html = renderInline("![x\" onerror=\"alert(1)](https://a/b.png)");
    expect(html).toContain('alt="x&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain('" onerror="');
  });

  it("Markdown title 语法（url \"title\"）不再产生裸引号", () => {
    const html = renderInline('[a](https://x/ "title")');
    expect(html).not.toMatch(/"title"/);
    expect(html).toContain("&quot;title&quot;");
  });

  it("单引号输入不产生可突破的属性（整个片段留在 href 值内）", () => {
    const html = renderInline("[a](https://x/' onx='y)");
    // 单引号在双引号界定的属性值内是惰性的：值完整闭合，后面仍是正常属性
    expect(html).toContain('href="https://x/\' onx=\'y" target=');
  });

  it("输入中的 &amp; 不被还原（md.ts 旧实体还原后门回归）", () => {
    const html = renderInline("[a](https://x/?q=1&amp;b=2)");
    expect(html).not.toContain("&".repeat(1) + "b=2"); // 裸 & 不得直接出现在 HTML 源中
    expect(html).toContain("q=1&amp;amp;b=2"); // 用户输入的字面 &amp; 保持双重转义
  });

  it("字符实体 &#x22; / &amp;quot; 不复活为可突破引号", () => {
    const html = renderInline("[a](https://x/&#x22; onmouseover=&#x22;alert(1))");
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&amp;#x22;");
  });

  it("实体编码的 javascript: 协议保持实体编码、不可执行（&#115;=s 绕过回归）", () => {
    // 字面串不是任何协议名，白名单按「无协议」放行成相对路径；安全保证是 & 不被还原，
    // 浏览器单次解码后得到惰性字符串 "java&#115;cript:"，不会二次解码成协议
    const a = renderInline("[a](java&#115;cript:alert(1))");
    expect(a).toContain("java&amp;#115;cript:alert(1)");
    expect(a).not.toContain("javascript:");
    const b = renderInline("[a](&#106;avascript:alert(1))");
    expect(b).toContain("&amp;#106;avascript:alert(1)");
    expect(b).not.toContain("javascript:");
  });

  it("合法 & 参数链接保持行为：HTML 源转义，浏览器解码后等价", () => {
    const html = renderInline("[q](https://x/?a=1&b=2)");
    expect(html).toContain('href="https://x/?a=1&amp;b=2"');
  });

  it("裸链接中的 & 参数同样只转义一次", () => {
    const html = renderInline("见 https://bare.io/?x=1&y=2");
    expect(html).toContain('href="https://bare.io/?x=1&amp;y=2"');
  });

  it("合法图片渲染不受影响", () => {
    const html = renderInline("![截图](https://a/b.png)");
    expect(html).toBe('<img src="https://a/b.png" alt="截图" loading="lazy" />');
  });

  it("大小写混合的 javascript:/data: 仍被拦截", () => {
    expect(renderInline("[a](JaVaScRiPt:alert(1))")).not.toContain("href=");
    expect(renderInline("[a](Data:text/html,x)")).not.toContain("href=");
  });
});

/** escapeAttr 只会发出这四种实体；单次替换即浏览器对属性值的一次解码，
 *  顺序 replace 会把 &amp;quot; 误判成二次解码，所以用单趟正则映射。 */
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
const decodeOnce = (v: string) => v.replace(/&(amp|lt|gt|quot);/g, (_m, n: string) => ENTITY[n]);

/** 从渲染结果里取所有 href/src，按浏览器看到的属性值解码，再交给 WHATWG 解析器定协议 */
function finalProtocols(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => new URL(decodeOnce(m[1]), "http://localhost:1420/").protocol);
}

describe("协议白名单与控制字符绕过（R1）", () => {
  const dangerous: [string, string][] = [
    ["协议名内 TAB", "[a](java\tscript:alert(1))"],
    ["协议名内 LF", "[a](java\nscript:alert(1))"],
    ["协议名内 CR", "[a](java\rscript:alert(1))"],
    ["协议名前 TAB", "[a](\tjavascript:alert(1))"],
    ["协议名前 CR", "[a](\rjavascript:alert(1))"],
    ["前导 C0 \\x01", "[a](\u0001javascript:alert(1))"],
    ["前导 C0 \\x00", "[a](\u0000javascript:alert(1))"],
    ["前导 \\x0c 表单符", "[a](\u000cjavascript:alert(1))"],
    ["尾随 C0 \\x02", "[a](javascript:alert(1)\u0002)"],
    ["大小写混合 + TAB", "[a](JaVa\tScRiPt:alert(1))"],
    ["data 协议名内 TAB", "![x](da\tta:text/html;base64,AA)"],
    ["vbscript", "[a](vbscript:msgbox(1))"],
    ["about", "[a](about:blank)"],
    ["blob", "[a](blob:http://localhost/uuid)"],
    ["file", "[a](file:///C:/Windows/win.ini)"],
    ["view-source", "[a](view-source:http://x/a)"],
    ["chrome", "[a](chrome://version)"],
    ["未知协议默认拒绝", "[a](wxwork://x)"],
  ];

  for (const [name, src] of dangerous) {
    it(`${name} —— 不生成可点击链接，也不生成图片`, () => {
      const html = renderInline(src);
      expect(html).not.toMatch(/<a\s/);
      expect(html).not.toMatch(/<img\s/);
      expect(finalProtocols(html)).toEqual([]);
      // 整段链接语法被消费、降级为纯文本，不会残留可被二次解析的 [ ]( 结构
      expect(html).not.toMatch(/\]\(/);
    });
  }

  it("协议名中间出现非法字符（NUL）时按解析器判为相对路径，最终协议是 base 的 http:", () => {
    const html = renderInline("[a](java\u0000script:alert(1))");
    const protocols = finalProtocols(html);
    expect(protocols.length).toBe(1);
    expect(protocols[0]).toBe("http:");
    expect(protocols).not.toContain("javascript:");
  });

  it("白名单协议都落地，且解析器看到的协议与放行理由一致", () => {
    const cases: [string, string][] = [
      ["[a](https://x/a)", "https:"],
      ["[a](HTTP://X/A)", "http:"],
      ["[a](http://x/?a=1&b=2)", "http:"],
      ["[a](mailto:someone@x.com)", "mailto:"],
      ["[a](tel:+100)", "tel:"],
    ];
    for (const [src, protocol] of cases) {
      const protocols = finalProtocols(renderInline(src));
      expect(protocols).toEqual([protocol]);
    }
  });

  it("相对路径 / 锚点 / 协议相对都放行，解析后落在 base 协议内", () => {
    for (const src of ["[a](附件.md)", "[a](./rel/path)", "[a](/abs/path)", "[a](#heading)", "[a](//cdn.example.com/a.js)", "[a](path/to/file:name)"]) {
      const protocols = finalProtocols(renderInline(src));
      expect(protocols).toEqual(["http:"]);
    }
  });

  it("前导控制符 + 大写协议经解析器还原后仍是合法 http:", () => {
    const html = renderInline("[a]( \t\n\u000cHTTP://ok/a)");
    expect(finalProtocols(html)).toEqual(["http:"]);
    expect(html).toContain("<a href=");
  });

  it("percent 编码与实体形式的 javascript: 不会复活成协议", () => {
    expect(finalProtocols(renderInline("[a](%6aavascript:alert(1))"))).toEqual(["http:"]);
    expect(finalProtocols(renderInline("[a](java&#115;cript:alert(1))"))).toEqual(["http:"]);
  });

  it("合法查询参数的单个 & 仍只转义一次（解码后与原文等价）", () => {
    const html = renderInline("[q](https://x/?a=1&b=2)");
    expect(html).toContain('href="https://x/?a=1&amp;b=2"');
    expect(decodeOnce(html.match(/href="([^"]*)"/)![1])).toBe("https://x/?a=1&b=2");
  });

  it("控制字符与裸引号混排时属性仍闭合（转义职责未被协议改动削弱）", () => {
    const html = renderInline('[a](https://x/" onmouseover="\talert(1))');
    expect(html).not.toContain('" onmouseover="');
    expect(finalProtocols(html)).toEqual(["https:"]);
  });

  it("危险协议降级为纯文本后，label 里的尖括号仍被转义", () => {
    const html = renderInline("[<b>点</b>](javascript:alert(1))");
    expect(html).not.toMatch(/<a\s|<img\s|<b>/);
    expect(html).toContain("&lt;b&gt;点&lt;/b&gt;");
  });

  it("块级 renderMarkdown 走同一条判定：真实文档路径同样拦下 TAB 绕过", () => {
    // App 实际渲染的是整段 Markdown，这里补齐行内测试覆盖不到的段落 → 行内调用链
    const html = renderMarkdown("请看 [点我](java\tscript:alert(1)) 这个链接");
    expect(html).not.toMatch(/<a\s/);
    expect(finalProtocols(html)).toEqual([]);
    // 同一段落里的合法链接不受影响
    const ok = renderMarkdown("请看 [官网](https://tauri.app) 和 [文档](./docs/a.md)");
    expect(finalProtocols(ok)).toEqual(["https:", "http:"]);
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
