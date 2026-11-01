/* 真机全流程：本地选文件夹 → 真实模型读文件 → 写代码落盘。
 *
 * 前置：
 *   1) exe 已带 `additionalBrowserArgs: --remote-debugging-port=9223` 编译并启动
 *   2) 用户在界面里配好了真实模型（本脚本不改 baseUrl / key / model，只读取并断言）
 *
 *   node tools/live-deepseek-e2e.cjs
 *
 * 与 desktop-workspace-e2e.cjs 的区别：那边把模型指向 19888 的模拟上游，
 * 这边打的是用户自己接的真模型，因此断言全部围绕「磁盘结果」而不是「回复文案」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const ROOT = process.env.LIVE_ROOT || 'F:\\zhuomian\\zxz\\.tmp-live';
const SHOT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots/live';
const WAIT_MODEL_MS = Number(process.env.WAIT_MODEL_MS || 240000);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const SEED = `// 购物车（旧写法：模块级数组 + 两个函数）
var items = [];

function addItem(name, price, qty) {
  items.push({ name: name, price: price, qty: qty });
}

function total() {
  var sum = 0;
  for (var i = 0; i < items.length; i++) {
    sum += items[i].price * items[i].qty;
  }
  return sum;
}

module.exports = { addItem: addItem, total: total };
`;

const PROMPT =
  '读一下 src/cart.js，把它重构成一个 Cart 类，提供 addItem(name, price, qty)、removeItem(name)、total() 三个方法，行为跟原来保持一致。' +
  '改完把整份新内容写回 src/cart.js，最后用一句话说明改了什么。';

(async () => {
  // 真实目录：先清空再造，确保断言的是本次写入的结果
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', 'cart.js'), SEED);
  fs.mkdirSync(SHOT, { recursive: true });

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const pages = await ctx.pages();
  const page = pages.find((p) => /tauri\.localhost|localhost/.test(p.url())) || pages[0];
  check('连上桌面窗口', Boolean(page), page ? page.url() : '没有可用页面');
  await page.bringToFront();
  await page.waitForTimeout(500);
  page.on('dialog', (d) => d.accept());
  // 上一次跑可能留下弹层（内存态），刷新一次让界面回到持久化状态
  await page.keyboard.press('Escape').catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnWorkspace', { timeout: 15000 });
  await page.waitForTimeout(600);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });

  /* ---------------------------------------------------------- 0. 读现状 */
  const before = await page.evaluate(() => localStorage.getItem('zxz.state.v1'));
  const st = before ? JSON.parse(before) : {};
  const set = st.settings || {};
  const base = String(set.baseUrl || '');
  const model = String(set.model || '');
  const keyLen = String(set.apiKey || '').length;
  const prevWs = set.workspace ? set.workspace.root : null;

  check('读到你接入的模型配置', Boolean(model && base), `model=${model} base=${base}`);
  check('上游是真实 DeepSeek（不是本地模拟）', /api\.deepseek\.com/.test(base), base);
  check('API Key 已在本地保存', keyLen > 20, `${keyLen} 字符（不外传）`);
  check('已就绪，可开始操作界面', await page.locator('#btnWorkspace').isVisible(), '#btnWorkspace 可见');
  await page.screenshot({ path: path.join(SHOT, '01-before.png') });

  /* ------------------------------------------- 1. 本地选文件夹（走真 UI） */
  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker', { state: 'visible', timeout: 8000 });
  // 盘符是异步取的（fs_roots → fs_list），等它渲染出来再数
  await page.waitForSelector('#folderPicker .fp-drive', { timeout: 10000 });
  const driveCount = await page.locator('#folderPicker .fp-drive').count();
  check('文件夹选择器弹出并列出磁盘', driveCount > 0, `${driveCount} 个盘符`);

  await page.locator('#folderPicker .fp-drive', { hasText: /^F:\\?$/ }).first().click();
  await page.waitForSelector('#fpList .fp-row.dir', { timeout: 8000 });

  // 逐级点进去：F:\ → zhuomian → zxz → .tmp-live
  const trail = ['zhuomian', 'zxz', '.tmp-live'];
  for (const seg of trail) {
    const row = page.locator('#fpList .fp-row.dir', { hasText: new RegExp(`^${seg.replace('.', '\\.')}$`) }).first();
    await row.waitFor({ state: 'visible', timeout: 8000 });
    await row.click();
    await page.waitForTimeout(450);
  }
  const target = (await page.locator('.fp-target').innerText()).trim();
  check('逐级导航到目标目录', target.replace(/[\\/]+$/, '').toLowerCase() === ROOT.toLowerCase(), target);
  await page.screenshot({ path: path.join(SHOT, '02-folder-picker.png') });

  await page.click('#fpConfirm');
  await page.waitForSelector('#folderPicker', { state: 'hidden', timeout: 8000 });
  const chip = (await page.locator('#btnWorkspace .ws-name').innerText()).trim();
  check('工程目录已接入（顶栏显示目录名）', chip === '.tmp-live', chip);

  // 目录树是异步扫描后写进 localStorage 的，给它一点时间
  await page
    .waitForFunction(
      () => {
        const raw = localStorage.getItem('zxz.state.v1');
        const ws = raw ? JSON.parse(raw).settings.workspace : null;
        return Boolean(ws && /cart\.js/.test(ws.tree || ''));
      },
      null,
      { timeout: 8000 }
    )
    .catch(() => {});
  const treeText = await page.evaluate(() => {
    const raw = localStorage.getItem('zxz.state.v1');
    const ws = raw ? JSON.parse(raw).settings.workspace : null;
    return ws ? ws.tree || '' : '';
  });
  check('目录树已扫描并注入（含 src/cart.js）', /cart\.js/.test(treeText), treeText.split('\n').slice(0, 4).join(' | ') || '树为空');

  /* --------------------------------------------- 2. 新对话 + 真实模型调用 */
  await page.click('#btnNew');
  await page.waitForTimeout(300);
  await page.fill('#input', PROMPT);
  await page.click('#btnSend');

  const t0 = Date.now();
  // 不能只看「停止按钮消失」：多轮读写之间存在空闲间隙，会提前判定结束。
  // 真正的完成信号是「回执已落盘 + 输入框可按」。
  await page.waitForFunction(
    () => {
      const st = document.querySelector('#faStatus');
      const done = st && /已落盘|有失败项/.test(st.textContent || '');
      const send = document.querySelector('#btnSend');
      const stop = document.querySelector('#btnStop');
      const idle = send && !send.disabled && (!stop || stop.hidden);
      return Boolean(done && idle);
    },
    null,
    { timeout: WAIT_MODEL_MS }
  );
  await page.waitForTimeout(400);
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  const rounds = await page.locator('#chat .msg-assistant, #chat .msg').count();
  check('模型读写完成、文件已落盘', true, `${cost}s，消息节点 ${rounds} 个`);

  const conv = await page.evaluate(() => {
    const raw = localStorage.getItem('zxz.state.v1');
    const s = raw ? JSON.parse(raw) : {};
    const c = (s.conversations || []).find((x) => x.id === s.activeId) || (s.conversations || [])[0];
    return c ? c.messages : [];
  });
  const lastA = conv.filter((m) => m.role === 'assistant' && !m.hidden).pop() || {};
  check('收到助手回复且没有报错', Boolean(lastA) && !lastA.error, lastA.error ? String(lastA.error).slice(0, 140) : `正文 ${String(lastA.content || '').length} 字`);
  check('调用的是真实计费接口（返回 token 用量）', Boolean(lastA.usage && (lastA.usage.total_tokens || lastA.usage.completion_tokens)), JSON.stringify(lastA.usage || {}));

  const hidden = conv.filter((m) => m.hidden);
  const readOk = hidden.some((m) => /<<<FILE src\/cart\.js>>>/.test(m.content || '') && !/读取失败/.test(m.content || ''));
  check('模型先 @@read 了真实文件（程序回传原内容）', readOk, hidden.length ? `注入 ${hidden.length} 条回传` : '无回传消息');
  if (readOk) {
    const echo = hidden.find((m) => /<<<FILE src\/cart\.js>>>/.test(m.content || '')).content;
    check('回传内容就是磁盘上的旧代码', echo.includes('function addItem(name, price, qty)'), echo.split('\n')[1] || '');
  }

  /* ------------------------------------------------- 3. 落盘与磁盘校验 */
  await page.waitForSelector('#fileWrites', { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const s = document.querySelector('#faStatus');
      return s && /已落盘|有失败项/.test(s.textContent || '');
    },
    null,
    { timeout: 30000 }
  );
  const status = (await page.locator('#faStatus').innerText()).trim();
  check('界面显示已落盘', /已落盘/.test(status), status);
  await page.screenshot({ path: path.join(SHOT, '03-written.png'), fullPage: false });

  const disk = fs.readFileSync(path.join(ROOT, 'src', 'cart.js'), 'utf8');
  check('磁盘文件被真实改写', disk !== SEED, `${disk.length} 字节`);
  check('新代码是 Cart 类（含 class Cart）', /class\s+Cart/.test(disk), (disk.split('\n').find((l) => /class/.test(l)) || '').trim());
  check('三个方法都在', ['addItem', 'removeItem', 'total'].every((m) => new RegExp(m + '\\s*\\(').test(disk)));
  check('旧写法已清除（无 var items = []）', !/var items = \[\]/.test(disk));

  // 正文里的代码块会被剥掉（只显示解释），所以以「回执」为准判断模型是否给了文件
  const receipt = (lastA.files || []).find((f) => f.path === 'src/cart.js');
  check('回复里带 file: 块并已生成写入回执', Boolean(receipt && receipt.ok), receipt ? `${receipt.created ? '新建' : '覆盖'} ${receipt.bytes} 字节` : '无回执');
  if (receipt) check('回执字节数与磁盘一致', receipt.bytes === Buffer.byteLength(disk, 'utf8'), `回执 ${receipt.bytes} / 磁盘 ${Buffer.byteLength(disk, 'utf8')}`);

  const undoRoot = path.join(ROOT, '.zxz', 'undo');
  let backups = [];
  if (fs.existsSync(undoRoot)) {
    backups = fs.readdirSync(undoRoot).flatMap((d) => {
      const p = path.join(undoRoot, d, 'src', 'cart.js');
      return fs.existsSync(p) ? [p] : [];
    });
  }
  check('覆盖前留了备份快照', backups.length > 0, backups[0] ? path.relative(ROOT, backups[0]) : '无');
  if (backups[0]) check('快照是旧内容', fs.readFileSync(backups[0], 'utf8').includes('var items = []'));

  /* ------------------------------------------------------ 4. 差异视图 */
  await page.click('#fileWrites .link-btn');
  await page.waitForTimeout(200);
  const openBtn = page.locator('#fileWrites .fa-open').first();
  if (await openBtn.count()) {
    await openBtn.click();
    await page.waitForSelector('.diff-modal, [class*="diff"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const modalText = await page.evaluate(() => (document.querySelector('.diff-modal') || document.body).innerText.slice(0, 300));
    check('能打开差异对比', /src\/cart\.js/.test(modalText), modalText.replace(/\s+/g, ' ').slice(0, 80));
    await page.screenshot({ path: path.join(SHOT, '04-diff.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else {
    check('能打开差异对比', false, '没有可点的文件项');
  }

  check('浏览器无未捕获报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' / '));

  /* ------------------------------------------------------- 5. 还原现场 */
  await page.evaluate((old) => {
    if (old === null) localStorage.removeItem('zxz.state.v1');
    else localStorage.setItem('zxz.state.v1', old);
  }, before);
  check('测试前的状态已还原（模型与历史对话不动）', true, prevWs ? `原工程：${prevWs}` : '原本未接工程目录');
  // 还原后刷新一次，免得界面上还留着测试用的工程目录与弹层
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(800);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  fs.writeFileSync(path.join(SHOT, 'result.json'), JSON.stringify({ at: new Date().toISOString(), cost, results }, null, 2));
  await browser.close().catch(() => {});
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('EXCEPTION', e && e.message);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过（中断）`);
  process.exit(2);
});
