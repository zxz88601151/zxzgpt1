/* 桌面端真机验证：通过 WebView2 的 CDP 端口驱动真实窗口，落盘走真 Rust IPC。
 *
 * 前置：
 *   1) exe 已用 `additionalBrowserArgs: --remote-debugging-port=9223` 编译并启动
 *   2) 模拟上游在 19888 跑着
 *
 *   node tools/desktop-workspace-e2e.cjs
 *
 * 与 workspace-e2e.cjs 的区别：那边注入假 IPC 验前端链路，这边是端到端——
 * 文件真的写到磁盘上（含 @@read 读回来的真实内容），越权路径真的被 Rust 拦下。
 * 测试会临时改写 localStorage 指向模拟上游，跑完还原用户原来的状态。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:19888/v1';
const SHOT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots';

const ROOT = path.join('F:', 'zhuomian', 'zxz', '.tmp-ws');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'marker.txt'), 'seed\n'); // 让目录浏览有内容可断言
  fs.writeFileSync(path.join(ROOT, 'src', 'old.js'), 'function legacyInit(root) {\n  return root.querySelector(".legacy");\n}\n');

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => /tauri|localhost/.test(p.url())) || pages[0];
  check('连上桌面窗口', Boolean(page), page.url());
  // 窗口被遮住时 WebView2 会停渲染，元素尺寸为 0，Playwright 判定为「不可见」——先置前
  await page.bringToFront();
  await page.waitForTimeout(400);
  page.on('dialog', (d) => d.accept());

  // 先把用户原来的状态存下来，测完还原（不要动用户真实的对话和 Key）
  const backup = await page.evaluate(() => localStorage.getItem('zxz.state.v1'));

  // 预置：模型指向模拟上游 + 工程目录指向临时目录
  await page.evaluate(
    ([root, mock]) => {
      function baseName(p) {
        const t = p.replace(/[\\/]+$/, '');
        const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
        return i >= 0 ? t.slice(i + 1) : t;
      }
      localStorage.setItem(
        'zxz.state.v1',
        JSON.stringify({
          settings: {
            preset: 'custom',
            baseUrl: mock,
            apiKey: 'mock-key',
            model: 'mock-gpt-4o',
            temperature: 0.7,
            maxTokens: null,
            contextTurns: 10,
            systemPrompt: '',
            stream: true,
            theme: 'dark',
            workspace: { root, name: baseName(root), tree: '' },
          },
          conversations: [],
          activeId: null,
        })
      );
    },
    [ROOT, MOCK]
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });
  await page.waitForFunction(
    () => !/检测中/.test(document.querySelector('#transportText')?.textContent || ''),
    null,
    { timeout: 15000 }
  );

  const chip = (await page.textContent('#btnWorkspace')) || '';
  check('顶栏读到工程目录', chip.includes('.tmp-ws'), chip.trim());

  /* ---------------------------------------------------- 真实 fs_list：打开选择器 */
  // 上一次跑崩可能留着弹层，先关掉，保证从干净状态开始
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker');
  // 首次 fs_list 要走一趟 IPC，等行出现再断言，别用固定 sleep；万一首刷为空，重开一次
  try {
    await page.waitForSelector('.fp-row', { timeout: 8000 });
  } catch {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#folderPicker', { state: 'detached' });
    await page.click('#btnWorkspace');
    await page.waitForSelector('.fp-row', { timeout: 15000 });
  }
  const hasMarker = await page.locator('.fp-row', { hasText: 'marker.txt' }).count();
  const dirRows = await page.locator('.fp-row.dir').count();
  check('真实目录浏览（fs_list）', hasMarker === 1 && dirRows >= 1, `文件 ${hasMarker} / 目录 ${dirRows}`);
  await page.screenshot({ path: path.join(SHOT, 'desktop-picker.png') });

  /* ------------------------------------------- 真实 fs_mkdir：新建工作区文件夹 */
  await page.click('#fpNewDir');
  await page.waitForSelector('#fpNewName');
  await page.fill('#fpNewName', 'made-by-ui');
  await page.click('#fpNewOk');
  await page.waitForFunction(
    () => (document.querySelector('.fp-target')?.textContent || '').endsWith('made-by-ui'),
    null,
    { timeout: 12000 }
  );
  const made = path.join(ROOT, 'made-by-ui');
  check('真机上新建的文件夹真的出现在磁盘', fs.existsSync(made) && fs.statSync(made).isDirectory(), made);

  // 建完会自动进入新目录，重名要在它的上级目录里试
  await page.click('.fp-path button[title="上一级"]');
  await page.waitForFunction(() => (document.querySelector('.fp-target')?.textContent || '').endsWith('.tmp-ws'), null, {
    timeout: 8000,
  });
  check('「上一级」能退回父目录', true, ((await page.textContent('.fp-target')) || '').trim());

  // 重名交给 Rust 拒绝：前端不该自己吞掉这个错
  await page.click('#fpNewDir');
  await page.fill('#fpNewName', 'made-by-ui');
  await page.click('#fpNewOk');
  await page.waitForSelector('#fpNewErr', { timeout: 10000 });
  const dupMsg = ((await page.textContent('#fpNewErr')) || '').trim();
  check('重名被 Rust 侧拒绝并显示原因', /已存在/.test(dupMsg), dupMsg);
  await page.click('#fpNewCancel');
  fs.rmSync(made, { recursive: true, force: true });

  await page.keyboard.press('Escape');
  await page.waitForSelector('#folderPicker', { state: 'detached' });

  /* ---------------------------------------------------- 生成 → 自动真实写盘 */
  await page.fill('#input', '[[files]] 帮我搭一个静态页面工程');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#fileWrites', { timeout: 30000 });
  await page.waitForFunction(() => (document.querySelector('#faStatus')?.textContent || '').includes('已落盘'), null, {
    timeout: 20000,
  });

  const expected = ['index.html', 'src/main.js', 'src/style.css', 'README.md'];
  const missing = expected.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  check('未点按钮，磁盘上就出现 4 个文件', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : 'ok');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('文件内容与模型输出一致', html.includes('<h1>你好，本地工程</h1>'), html.length + ' 字节');

  const status = (await page.textContent('#faStatus')) || '';
  check('界面回显已落盘', /已落盘/.test(status), status.trim());

  const chatText = await page.textContent('#chat');
  check('对话框不再堆代码', !chatText.includes('<!doctype html>') && !chatText.includes('font-family: system-ui'));

  await page.click('#fileWrites .fa-head .link-btn');
  await page.waitForSelector('#fileWrites .fa-list');
  const listed = await page.$$eval('#fileWrites .fa-list code', (els) => els.map((e) => e.textContent));
  check('回执列出 4 个文件', listed.length === 4, listed.join(', '));

  /* ---------------------------------------------------- 覆盖写 + 备份 */
  const before = fs.statSync(path.join(ROOT, 'index.html')).mtimeMs;
  await page.fill('#input', '[[files]] 再来一次');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#fileWrites').length >= 2, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  const after = fs.statSync(path.join(ROOT, 'index.html')).mtimeMs;
  check('同名文件被覆盖', after > before, new Date(after).toISOString().slice(11, 19));

  const undoRoot = path.join(ROOT, '.zxz', 'undo');
  const stamps = fs.existsSync(undoRoot) ? fs.readdirSync(undoRoot) : [];
  const backups = stamps.flatMap((s) => {
    const dir = path.join(undoRoot, s);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `${s}/${e.name}`);
  });
  check('覆盖前留了备份', backups.length >= 1, backups.slice(0, 3).join(', '));

  /* ---------------------------------------------------- @@read：读真实文件再改 */
  await page.fill('#input', '[[read]] 把 src/old.js 重构一下');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#fileWrites').length >= 3, null, { timeout: 35000 });
  await page.waitForTimeout(800);

  const oldJs = fs.readFileSync(path.join(ROOT, 'src', 'old.js'), 'utf8');
  check('读到真实内容后按文件改写', oldJs.includes('export function legacyInit'), oldJs.split('\n')[0]);
  check('旧实现已被整文件替换', !oldJs.includes('root.querySelector(".legacy")'), oldJs.length + ' 字节');

  const visible = await page.textContent('#chat');
  check('回传的文件内容不显示给用户', !visible.includes('<<<FILE') && !visible.includes('[程序回传]'));

  /* ---------------------------------------------------- 差异对比（真实磁盘内容） */
  const lastBar = page.locator('#fileWrites').last();
  await lastBar.locator('.fa-head .link-btn').click();
  await lastBar.locator('.fa-list .fa-open').first().click();
  await page.waitForSelector('#diffModal', { timeout: 15000 });

  const delLines = await page.$$eval('#diffBody .diff-line.del code', (els) => els.map((e) => e.textContent));
  const addLines = await page.$$eval('#diffBody .diff-line.add code', (els) => els.map((e) => e.textContent));
  check('diff 读出磁盘原内容', delLines.some((l) => l.includes('.legacy')), delLines.join(' | ').slice(0, 60));
  check('diff 列出模型写入的新行', addLines.some((l) => l.includes('export function legacyInit')), addLines.length + ' 行');
  const badge = (await page.textContent('#diffModal .diff-badge')) || '';
  check('diff 摘要 +N −N', /[+−]/.test(badge), badge.trim());
  await page.screenshot({ path: path.join(SHOT, 'desktop-diff.png') });
  await page.click('#diffModal .modal-foot .btn.primary');
  await page.waitForSelector('#diffModal', { state: 'detached' });

  /* ---------------------------------------------------- 回滚（真写回磁盘） */
  await page.click('#btnUndo');
  await page.waitForSelector('#undoPanel');
  await page.waitForSelector('.undo-snap', { timeout: 15000 });
  const snapCount = await page.locator('.undo-snap').count();
  check('写入历史读到真实快照目录', snapCount >= 1, snapCount + ' 个');

  const head = page.locator('.undo-snap-head').first();
  if (!(await head.evaluate((el) => el.classList.contains('on')))) await head.click();
  const undoFiles = await page.$$eval('.undo-files code', (els) => els.map((e) => e.textContent));
  check('快照里能看到被覆盖的文件', undoFiles.includes('src/old.js'), undoFiles.join(', '));

  await page.locator('.undo-files li', { hasText: 'src/old.js' }).first().locator('.link-btn').last().click();
  await page.waitForFunction(() => document.querySelector('#toastHost')?.textContent?.includes('已恢复'), null, {
    timeout: 20000,
  });
  const afterUndo = fs.readFileSync(path.join(ROOT, 'src', 'old.js'), 'utf8');
  check('回滚把旧内容写回了磁盘', afterUndo.includes('root.querySelector(".legacy")'), afterUndo.split('\n')[0]);
  await page.screenshot({ path: path.join(SHOT, 'desktop-undo.png') });
  await page.click('#undoPanel .modal-foot .btn.primary');
  await page.waitForSelector('#undoPanel', { state: 'detached' });

  /* ---------------------------------------------------- 越权写入必须被 Rust 拦住 */
  const escape = await page.evaluate(
    async ([root]) => {
      const inv = window.__TAURI_INTERNALS__;
      const out = {};
      for (const rel of ['../evil.txt', 'C:/Windows/evil.txt', 'a/../../evil.txt']) {
        try {
          await inv.invoke('fs_write', { root, rel, content: 'x' });
          out[rel] = 'ALLOWED';
        } catch (e) {
          out[rel] = String(e);
        }
      }
      try {
        const r = await inv.invoke('fs_write', { root, rel: 'proof/ok.txt', content: 'hello' });
        out['proof/ok.txt'] = r && r.created ? 'created' : 'overwrote';
      } catch (e) {
        out['proof/ok.txt'] = String(e);
      }
      return out;
    },
    [ROOT]
  );
  check('拦截 ../evil.txt', /不允许/.test(escape['../evil.txt']), escape['../evil.txt']);
  check('拦截盘符路径', /不允许/.test(escape['C:/Windows/evil.txt']), escape['C:/Windows/evil.txt']);
  check('拦截 a/../../evil.txt', /不允许/.test(escape['a/../../evil.txt']), escape['a/../../evil.txt']);
  check('合法路径仍可写入', escape['proof/ok.txt'] === 'created', escape['proof/ok.txt']);
  check(
    '越权文件没有落盘',
    !fs.existsSync(path.join(ROOT, '..', 'evil.txt')) && !fs.existsSync('C:/Windows/evil.txt')
  );

  await page.screenshot({ path: path.join(SHOT, 'desktop-workspace.png') });

  /* ---------------------------------------------------- 还原用户原有的本地状态 */
  await page.evaluate((raw) => {
    if (raw === null) {
      localStorage.removeItem('zxz.state.v1');
      return;
    }
    localStorage.setItem('zxz.state.v1', raw);
    // 上一轮测试可能把临时工程写进了状态，还原时顺手摘掉，别把测试脚手架留给用户
    try {
      const s = JSON.parse(raw);
      if (s && s.settings && s.settings.workspace && String(s.settings.workspace.root || '').includes('.tmp-ws')) {
        s.settings.workspace = null;
        localStorage.setItem('zxz.state.v1', JSON.stringify(s));
      }
    } catch {
      /* 解析失败就原样保留 */
    }
  }, backup);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });
  const chipAfter = (await page.textContent('#btnWorkspace')) || '';
  check('还原后不再指向临时工程', !chipAfter.includes('.tmp-ws'), chipAfter.trim() || '(未选工程)');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
