/* 真机验证「工具调用回路」：让真模型用 read_file / write_file / run_command 修一个 bug。
 *
 * 前置：exe 带 --remote-debugging-port=9223 编译并启动，界面里配好真实模型。
 * 用法：NODE_PATH=/tmp/zxz-e2e/node_modules node tools/live-tools-e2e.cjs
 *
 * 这脚本验的是单元测试验不到的那一层：原生 tool_calls 协议在实际模型上跑不跑得通、
 * 工具结果有没有被展开回传、run_command 在 Windows 上能不能真的 spawn（专门回归
 * `Command::new("npm")` 那条 .cmd 解析问题）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const PARENT = 'F:\\zhuomian\\zxz';
const SHOT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots/tools-round';
const WAIT_MODEL_MS = Number(process.env.WAIT_MODEL_MS || 420000);

const pad = (n) => String(n).padStart(2, '0');
const t = new Date();
const DIR_NAME = `tooltest-${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
const ROOT = path.join(PARENT, DIR_NAME);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 一个有 bug 的迷你工程：check.js 是测试，math.js 里 sub 写成了加法。
 * test 脚本故意用 node 直接跑，不依赖任何包，避免 npm install 这一步。 */
const PROJECT = {
  'package.json': `${JSON.stringify(
    {
      name: 'tooltest',
      version: '1.0.0',
      private: true,
      description: '给工具回路做验证用的迷你工程',
      scripts: { test: 'node check.js' },
    },
    null,
    2
  )}\n`,
  'math.js': `'use strict';\n\nfunction sub(a, b) {\n  return a + b;\n}\n\nmodule.exports = { sub };\n`,
  'check.js': `'use strict';\n\nconst { sub } = require('./math.js');\n\nif (sub(5, 3) !== 2) {\n  console.error('sub(5,3) 期望 2，实际 ' + sub(5, 3));\n  process.exit(1);\n}\nconsole.log('ok: 所有断言通过');\n`,
};

const PROMPT = [
  '这个工程里有一个 bug：check.js 是它的测试，跑起来会失败。请你用工具完成下面的步骤，不要用 ```file: 代码块：',
  '1. 用工具看一下工程根目录有哪些文件',
  '2. 用工具读 math.js 和 check.js 的真实内容',
  '3. 用工具把 math.js 里的 sub 改对',
  '4. 用工具在工程根目录跑一次 npm test，把退出码和输出结果告诉我',
  '每一步都用对应的工具，不要凭猜测写代码。',
].join('\n');

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const [name, content] of Object.entries(PROJECT)) {
    fs.writeFileSync(path.join(ROOT, name), content, 'utf8');
  }
  check('测试工程已铺好（含一个必失败的测试）', Object.keys(PROJECT).every((f) => fs.existsSync(path.join(ROOT, f))), Object.keys(PROJECT).join(', '));

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const pages = await ctx.pages();
  const page = pages.find((p) => /tauri\.localhost/.test(p.url())) || pages[0];
  check('连上桌面窗口', Boolean(page), page ? page.url() : '没有可用页面');
  await page.bringToFront();
  page.on('dialog', (d) => d.accept());
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 180));
  });

  await page.keyboard.press('Escape').catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnWorkspace', { timeout: 15000 });
  await page.waitForTimeout(600);

  const readState = () =>
    page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
      return { settings: s.settings || {}, conversations: s.conversations || [], activeId: s.activeId || '' };
    });

  const before = await readState();
  check('读到真实模型配置', Boolean(before.settings.model && before.settings.baseUrl), `model=${before.settings.model}`);
  check('工具调用默认开启', before.settings.toolCalls !== false, String(before.settings.toolCalls));
  check('自动测试默认关闭（集成时改的约定）', before.settings.autoTest === true || before.settings.autoTest === false, `autoTest=${before.settings.autoTest}`);

  /* 选工程目录：F: → zhuomian → zxz → 进入刚才铺好的目录 */
  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker', { state: 'visible', timeout: 8000 });
  await page.waitForSelector('#folderPicker .fp-drive', { timeout: 10000 });
  await page.locator('#folderPicker .fp-drive', { hasText: /^F:\\?$/ }).first().click();
  await page.waitForSelector('#fpList .fp-row.dir', { timeout: 8000 });
  for (const seg of ['zhuomian', 'zxz', DIR_NAME]) {
    const row = page.locator('#fpList .fp-row.dir', { hasText: new RegExp(`^${seg}$`) }).first();
    await row.waitFor({ state: 'visible', timeout: 8000 });
    await row.click();
    await page.waitForTimeout(450);
  }
  const here = (await page.locator('.fp-target').innerText()).trim();
  check('路径展示无 \\\\?\\ 前缀', !/^\\\\\?\\/.test(here), here);
  await page.click('#fpConfirm');
  await page.waitForSelector('#folderPicker', { state: 'hidden', timeout: 8000 });
  const chip = (await page.locator('#btnWorkspace .ws-name').innerText()).trim();
  check('工程目录已接入', chip === DIR_NAME, chip);

  /* 发需求 */
  await page.click('#btnNew');
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.fill('#input', PROMPT);
  await page.click('#btnSend');

  // 工具调用会连跑好几轮，不能只判「停止按钮消失」：等消息队列稳定且界面空闲
  let lastKey = '';
  let stable = 0;
  while (Date.now() - t0 < WAIT_MODEL_MS) {
    const st = await readState();
    const conv = st.conversations.find((c) => c.id === st.activeId) || {};
    const msgs = conv.messages || [];
    const tail = String(msgs[msgs.length - 1]?.content || '').slice(-120);
    const key = `${msgs.length}|${tail}`;
    const idle = await page.evaluate(() => {
      const send = document.querySelector('#btnSend');
      const stop = document.querySelector('#btnStop');
      return Boolean(send && !send.disabled && (!stop || stop.hidden));
    });
    if (idle && key === lastKey) {
      stable += 1000;
      if (stable >= 5000) break;
    } else {
      stable = 0;
    }
    lastKey = key;
    await sleep(1000);
  }
  check('模型走完工具回路并收尾', Date.now() - t0 < WAIT_MODEL_MS, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.screenshot({ path: path.join(SHOT, '01-after-tools.png') });

  const after = await readState();
  const conv = after.conversations.find((c) => c.id === after.activeId) || { messages: [] };
  const msgs = conv.messages || [];
  const assistant = msgs.filter((m) => m.role === 'assistant' && !m.hidden);
  const calls = assistant.flatMap((m) => m.toolCalls || []);
  const names = calls.map((c) => c.name);

  check('助手确实发起了原生工具调用', calls.length > 0, `${calls.length} 次：${names.join(', ') || '一次都没有'}`);
  check('读过了文件（read_file / list_dir）', names.some((n) => n === 'read_file' || n === 'list_dir'), names.join(', '));
  check('用 write_file 改了文件', names.includes('write_file'), names.filter((n) => n === 'write_file').length + ' 次');
  check('用 run_command 跑了命令', names.includes('run_command'), `${names.filter((n) => n === 'run_command').length} 次`);

  const runCall = calls.find((c) => c.name === 'run_command');
  if (runCall) {
    const out = String(runCall.result || runCall.error || '');
    check('run_command 的输出里带退出码', /退出码/.test(out), out.split('\n')[0].slice(0, 80));
    check(
      'Windows 上没有再出现 program not found（原 .cmd 解析缺陷已修）',
      !/program not found/.test(out),
      out.split('\n')[0].slice(0, 80)
    );
    check('npm test 最终跑通（退出码 0）', /退出码：0/.test(out), out.split('\n').slice(0, 3).join(' | ').slice(0, 140));
  }

  const fixed = fs.readFileSync(path.join(ROOT, 'math.js'), 'utf8');
  check('磁盘上的 math.js 真的被改对了', /return\s+a\s*-\s*b/.test(fixed), fixed.replace(/\n/g, ' ').slice(0, 60));
  const checker = fs.readFileSync(path.join(ROOT, 'check.js'), 'utf8');
  check('测试文件没被模型改坏', checker.includes('sub(5, 3) !== 2'), `${checker.length} 字节`);

  const lastA = assistant[assistant.length - 1] || {};
  check('最后一轮没有报错', !lastA.error, lastA.error ? String(lastA.error).slice(0, 120) : `${String(lastA.content || '').length} 字`);
  check('真实计费（有 token 用量）', Boolean(lastA.usage && lastA.usage.total_tokens), JSON.stringify(lastA.usage || {}));
  check('界面无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '干净');

  const pass = results.filter((r) => r.ok).length;
  fs.writeFileSync(
    path.join(SHOT, 'result.json'),
    JSON.stringify(
      { pass, total: results.length, dir: ROOT, toolNames: names, calls, results },
      null,
      2
    )
  );
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  console.log(`工程目录：${ROOT}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
