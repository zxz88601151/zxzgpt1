/* zxz 前端 E2E（模拟上游，零真实 API）
 *
 * 覆盖：启动 → 通道探测 → 设置/测试连接/拉取模型 → 流式对话 → Markdown 渲染
 *       → 思维链折叠 → usage → 中断 → 错误提示 → 新建/搜索/主题 → 刷新后持久化
 *
 *   MODE=direct|proxy node e2e.js   （proxy 需先注入 __TAURI_INTERNALS__，见 run-e2e.sh）
 */
'use strict';

const { launchBrowser } = require('./browser.cjs');

// 默认值必须跟 vite.config.ts 的 port 一致（1420），否则不传 ZXZ_BASE 时
// 会去敲一个没人监听的 5173，报 ERR_CONNECTION_REFUSED，看着像前端崩了。
// 主机名用 localhost 而不是 127.0.0.1：vite 绑的是 ::1，写死 127.0.0.1 同样连不上。
const BASE = process.env.ZXZ_BASE || 'http://localhost:1420';
const MODE = process.env.MODE || 'direct';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:19888/v1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  if (MODE === 'proxy') {
    const port = Number(process.env.PROXY_PORT);
    const token = process.env.PROXY_TOKEN;
    await page.addInitScript(
      ([p, t]) => {
        window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'proxy_info' ? { port: p, token: t } : null) };
      },
      [port, token]
    );
  }

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew');
  // 通道探测是异步的，等状态文字从「检测中」落定再断言
  await page.waitForFunction(() => !/检测中/.test(document.querySelector('#transportText')?.textContent || ''), null, { timeout: 15000 });

  // 1 通道
  const transportText = (await page.textContent('#transportText')) || '';
  check('通道探测', MODE === 'proxy' ? transportText.includes('本地代理') : transportText.includes('直连'), transportText.trim());

  // 2 设置面板
  await page.click('#modelPill');
  await page.waitForSelector('#drawer:not([hidden])');
  await page.selectOption('#preset', 'custom');
  await page.fill('#baseUrl', MOCK);
  await page.fill('#apiKey', 'mock-key');
  await page.fill('#model', 'mock-gpt-4o');
  check('设置抽屉打开', true);

  // 3 拉取模型
  await page.click('#btnFetchModels');
  await page.waitForFunction(() => /拉取到 \d+ 个模型|拉取失败/.test(document.querySelector('#testResult').textContent), null, { timeout: 15000 });
  const fetchMsg = await page.textContent('#testResult');
  check('拉取模型列表', /拉取到 4 个模型/.test(fetchMsg), fetchMsg.trim());

  // 4 测试连接
  await page.click('#btnTest');
  await page.waitForFunction(() => document.querySelector('#testResult').classList.contains('ok') || document.querySelector('#testResult').classList.contains('bad'), null, { timeout: 20000 });
  const testMsg = await page.textContent('#testResult');
  check('测试连接', testMsg.includes('连接正常'), testMsg.trim());

  await page.click('#btnSave');
  await page.waitForSelector('#drawer', { state: 'hidden' });

  // 5 流式对话
  await page.fill('#input', '你好，演示一下渲染 [[long]]');
  await page.click('#btnSend');
  await page.waitForFunction(
    () => {
      const md = document.querySelector('.msg.assistant .md');
      return md && md.textContent.includes('不消耗任何真实 token');
    },
    null,
    { timeout: 60000 }
  );
  await page.waitForFunction(() => !document.querySelector('#btnStop') || document.querySelector('#btnStop').hidden, null, { timeout: 60000 });

  const md = await page.evaluate(() => {
    const el = document.querySelector('.msg.assistant .md');
    const q = (s) => !!el.querySelector(s);
    return {
      h1: q('h1'),
      h2: q('h2'),
      ul: q('ul'),
      nestedLi: q('ul li ul li'),
      ol: q('ol'),
      table: q('table'),
      codeBlock: q('.code-block pre code'),
      highlighted: q('.tk-key') || q('.tk-com') || q('.tk-str'),
      inlineCode: q('code.inline'),
      quote: q('blockquote'),
      strong: q('strong'),
      del: q('del'),
      link: q('a[href="https://tauri.app"]'),
      copyBtn: q('.code-block .copy'),
      text: el.textContent.length,
    };
  });
  check('Markdown 标题', md.h1 && md.h2);
  check('Markdown 列表（含嵌套）', md.ul && md.nestedLi);
  check('Markdown 有序列表', md.ol);
  check('Markdown 表格', md.table);
  check('代码块 + 高亮 + 复制按钮', md.codeBlock && md.highlighted && md.copyBtn);
  check('行内代码 / 引用 / 加粗 / 删除线', md.inlineCode && md.quote && md.strong && md.del);
  check('外链渲染', md.link);
  const longOk = await page.evaluate(() => {
    const el = document.querySelector('.msg.assistant .md');
    const heads = [...el.querySelectorAll('h3')].map((h) => h.textContent.trim());
    return heads.filter((h) => /^补充段落 \d+$/.test(h)).length === 12 && el.querySelectorAll('.code-block').length === 1;
  });
  check('长文本完整渲染（12 段 + 1 代码块）', longOk, md.text + ' 字符（已去除 Markdown 语法符）');

  const usage = await page.textContent('.msg.assistant .msg-foot').catch(() => '');
  check('usage 回显', /\d+ in · \d+ out/.test(usage), (usage || '').trim().replace(/\s+/g, ' '));
  if (process.env.SHOT_CONV) await page.screenshot({ path: process.env.SHOT_CONV });

  // 5.5 重新生成：不能把用户消息再追加一遍
  await page.waitForTimeout(500);
  const regenBefore = await page.evaluate(() => ({
    users: document.querySelectorAll('.msg.user').length,
    assists: document.querySelectorAll('.msg.assistant').length,
  }));
  await page.click('#btnRegen');
  await page.waitForFunction(() => {
    const stop = document.querySelector('#btnStop');
    return !stop || stop.hidden;
  }, null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const regenAfter = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('zxz.state.v1') || '{"conversations":[]}');
    const conv = (st.conversations || []).find((c) => c.id === st.activeId);
    return {
      users: document.querySelectorAll('.msg.user').length,
      assists: document.querySelectorAll('.msg.assistant').length,
      stored: conv ? conv.messages.length : -1,
    };
  });
  check(
    '重新生成不重复追加用户消息',
    regenAfter.users === regenBefore.users && regenAfter.assists === regenBefore.assists && regenAfter.stored === 2,
    `user ${regenBefore.users}→${regenAfter.users}，assistant ${regenBefore.assists}→${regenAfter.assists}，存储 ${regenAfter.stored} 条`
  );

  // 5.6 上下文轮数 = 1：应当只带「上一轮问答 + 本次提问」
  await page.click('#modelPill');
  await page.fill('#contextTurns', '1');
  await page.click('#btnSave');
  await page.waitForSelector('#drawer', { state: 'hidden' });
  await page.fill('#input', '第二句，检查上下文窗口');
  await page.click('#btnSend');
  await page.waitForFunction(() => {
    const stop = document.querySelector('#btnStop');
    return !stop || stop.hidden;
  }, null, { timeout: 60000 });
  const lastReq = await (await fetch(new URL(MOCK).origin + '/_last')).json();
  const ctx = lastReq.messages || [];
  // 只数对话消息：system 是「窗口之外」的固定上下文（技能提示词 / 工程提示词都在这一层），
  // 它不参与轮数裁剪。早先这里直接数 ctx.length，技能提示词一加进来就假红了。
  const dialog = ctx.filter((m) => m.role !== "system");
  check(
    '上下文轮数=1 只带最近一轮',
    dialog.length === 3 && dialog[0].role === 'user' && dialog[1].role === 'assistant' && dialog[2].role === 'user',
    `${dialog.length} 条对话（另有 ${ctx.length - dialog.length} 条 system）：${dialog.map((m) => m.role).join(',')}`
  );
  await page.click('#modelPill');
  await page.fill('#contextTurns', '10');
  await page.click('#btnSave');
  await page.waitForSelector('#drawer', { state: 'hidden' });

  // 6 思维链
  await page.click('#btnNew');
  await page.fill('#input', 'reasoner-mock 的思考链测试');
  await page.evaluate(() => {
    // 切到 reasoner 模型：走设置表单最保险
  });
  await page.click('#modelPill');
  await page.fill('#model', 'reasoner-mock');
  await page.click('#btnSave');
  await page.fill('#input', '显示思考过程');
  await page.click('#btnSend');
  await page.waitForSelector('.msg.assistant details.reasoning', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#btnStop') || document.querySelector('#btnStop').hidden, null, { timeout: 60000 });
  const reasoning = await page.textContent('.msg.assistant details.reasoning');
  check('思维链折叠块', reasoning.includes('已生成思考过程'), reasoning.slice(0, 30));

  // 7 中断生成
  await page.fill('#input', '[[slow]] 这段要被我中断');
  await page.click('#btnSend');
  await page.waitForTimeout(1200);
  await page.click('#btnStop');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((m) => m.textContent.includes('已停止生成')),
    null,
    { timeout: 15000 }
  );
  check('中断生成', true);

  // 8 上游错误（401 翻译）
  await page.click('#modelPill');
  await page.fill('#model', 'bad-key');
  await page.click('#btnSave');
  await page.fill('#input', '触发 401');
  await page.click('#btnSend');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((m) => /401|Incorrect API key/.test(m.textContent)),
    null,
    { timeout: 20000 }
  );
  const errText = await page.evaluate(() => [...document.querySelectorAll('.msg.assistant .md')].pop().textContent.trim());
  check('上游 401 错误提示', true, errText.slice(0, 60));

  // 9 会话管理 + 搜索
  await page.click('#btnNew');
  await page.click('#btnNew');
  const convCount = await page.locator('.conv-item').count();
  check('多会话新建', convCount === 4, convCount + ' 个会话');
  await page.fill('#searchConv', '401');
  await page.waitForTimeout(200);
  const filtered = await page.locator('.conv-item').count();
  check('会话搜索', filtered >= 1 && filtered < convCount, `命中 ${filtered} 个`);
  await page.fill('#searchConv', '');

  // 10 主题
  await page.click('#btnTheme');
  const theme = await page.getAttribute('html', 'data-theme');
  check('主题切换', theme === 'light' || theme === 'dark', theme);
  await page.click('#btnTheme');

  // 11 刷新持久化
  await page.waitForTimeout(400); // 等 250ms 的落盘防抖
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.conv-item');
  const afterReload = await page.locator('.conv-item').count();
  const modelAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('zxz.state.v1')).settings.model);
  check('刷新后会话持久化', afterReload === convCount, `${afterReload} 个`);
  check('刷新后设置持久化', modelAfter === 'bad-key', modelAfter);

  await page.screenshot({ path: process.env.SHOT || `/tmp/zxz-e2e/shot-${MODE}.png`, fullPage: false });

  // 上游 401 属于故意触发的用例，浏览器会为此记一条资源加载错误，不算缺陷
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource|401 \(Unauthorized\)/.test(t));
  check('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(2);
});
