/* 本地工程模式 E2E：选文件夹 → 自动写盘 → diff 回看 → @@read 读真实文件 → 回滚
 *
 *   node tools/workspace-e2e.cjs
 *
 * 说明：真实写盘由 Rust 的 `fsx` 负责，那份代码由 tools/fs-harness 的 13 条
 * Rust 单测覆盖（含 ../ 与盘符越权）。浏览器里跑不了 IPC，所以这里注入一个
 * 假的 `__TAURI_INTERNALS__`（带一份虚拟文件系统），验证的是
 * 「解析 → 校验 → 写盘 → 回执 → 读回来喂给模型 → 看差异 → 回滚」整条链路。
 */
'use strict';

const { launchBrowser } = require('./browser.cjs');

const BASE = process.env.ZXZ_BASE || 'http://localhost:1420';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:19888/v1';
const MOCK_ROOT = process.env.MOCK_SERVER || 'http://127.0.0.1:19888';
const OUT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());

  // 假 Tauri IPC：虚拟文件系统（disk: 相对路径 → 内容），所有读写都记下来
  await page.addInitScript(() => {
    const DRIVE = 'F:\\';
    const ROOT = 'F:\\demo';
    const disk = {
      'README.md': '# demo\n',
      'src/old.js': 'function legacyInit(root) {\n  return root.querySelector(".legacy");\n}\n',
    };
    const written = [];
    const read = [];
    window.__WRITTEN = written;
    window.__READ = read;
    window.__DISK = disk;

    // 「新建文件夹」建出来的空目录（绝对路径）：光靠 disk 的 key 反推不出来
    const mkDirs = [];
    window.__MKDIRS = mkDirs;
    const joinAbs = (base, name) => (base.endsWith('\\') ? base + name : base + '\\' + name);

    const toAbs = (rel) => ROOT + '\\' + rel.split('/').join('\\');
    const toRel = (abs) => {
      if (abs === ROOT) return '';
      if (!abs.startsWith(ROOT + '\\')) return null;
      return abs.slice(ROOT.length + 1).split('\\').join('/');
    };

    // 从 disk 反推出某一层的目录项
    function listOf(abs) {
      const seen = new Map();
      if (abs === DRIVE) {
        seen.set('demo', { name: 'demo', dir: true, path: ROOT, size: 0 });
      } else {
        const prefix = toRel(abs);
        if (prefix === null) return [];
        const head = prefix ? prefix + '/' : '';
        for (const key of Object.keys(disk)) {
          if (head && !key.startsWith(head)) continue;
          const rest = key.slice(head.length);
          if (!rest) continue;
          const slash = rest.indexOf('/');
          const name = slash < 0 ? rest : rest.slice(0, slash);
          const isDir = slash >= 0;
          if (!seen.has(name)) {
            seen.set(name, {
              name,
              dir: isDir,
              path: toAbs(head + name),
              size: isDir ? 0 : disk[key].length,
            });
          }
        }
      }
      // 新建出来的空目录也要出现在列表里（只算当前这一层的直接子项）
      const baseAbs = abs.endsWith('\\') ? abs : abs + '\\';
      for (const d of mkDirs) {
        if (!d.startsWith(baseAbs)) continue;
        const name = d.slice(baseAbs.length).split('\\')[0];
        if (!name || seen.has(name)) continue;
        seen.set(name, { name, dir: true, path: baseAbs + name, size: 0 });
      }
      return [...seen.values()].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    }
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === 'proxy_info') return null; // 保持直连，请求直接打 mock 上游
        // 工作区会话：真实实现里 root 只在这里登记一次，之后只认 sessionId
        if (cmd === 'ws_open') {
          const base = String(args.root).split(/[\\/]/).filter(Boolean).pop() || String(args.root);
          return { id: 'ws-e2e', root: String(args.root), name: base };
        }
        if (cmd === 'ws_info') return { id: String(args.sessionId), root: ROOT, name: 'demo' };
        if (cmd === 'ws_close') return null;
        if (cmd === 'fs_roots') return [DRIVE];
        if (cmd === 'fs_list') return listOf(args.path);
        // 工程内列目录：只收 sessionId + 相对路径
        if (cmd === 'fs_list_in') return listOf(args.rel ? toAbs(args.rel) : ROOT);
        if (cmd === 'fs_mkdir') {
          // 与 Rust 侧同口径：已存在就报错，不静默复用
          if (listOf(args.dir).some((e) => e.name === args.name)) {
            throw new Error('「' + args.name + '」已存在，换个名字或直接点进去');
          }
          const target = joinAbs(args.dir, args.name);
          mkDirs.push(target);
          return target;
        }
        if (cmd === 'fs_exists') return Object.prototype.hasOwnProperty.call(disk, args.rel);
        if (cmd === 'fs_read') {
          read.push(args.rel);
          if (!Object.prototype.hasOwnProperty.call(disk, args.rel)) throw new Error('读取失败（' + args.rel + '）：NotFound');
          return disk[args.rel];
        }
        if (cmd === 'fs_write') {
          const created = !Object.prototype.hasOwnProperty.call(disk, args.rel);
          disk[args.rel] = args.content;
          written.push({ sessionId: args.sessionId, rel: args.rel, bytes: args.content.length, created });
          return { path: toAbs(args.rel), bytes: args.content.length, created };
        }
        // 撤销区走专用通道：普通 fs_write 在 Rust 侧已整目录拒绝 .zxz/undo，
        // 这里必须跟着实现，否则"备份走专用通道"这条链路在 e2e 里根本走不通。
        if (cmd === 'undo_write') {
          const rel = '.zxz/undo/' + args.stamp + '/' + args.rel;
          const created = !Object.prototype.hasOwnProperty.call(disk, rel);
          disk[rel] = args.content;
          written.push({ sessionId: args.sessionId, rel, bytes: args.content.length, created });
          return { path: toAbs(rel), bytes: args.content.length, created };
        }
        if (cmd === 'undo_read') {
          const rel = '.zxz/undo/' + args.stamp + '/' + args.rel;
          if (!Object.prototype.hasOwnProperty.call(disk, rel)) throw new Error('快照不存在：' + rel);
          return disk[rel];
        }
        if (cmd === 'undo_list') {
          const head =
            args.stamp == null ? '.zxz/undo' : '.zxz/undo/' + args.stamp + (args.rel ? '/' + args.rel : '');
          return listOf(toAbs(head));
        }
        // 执行授权：本脚本不跑命令，但打开工程时会拉一次授权列表，不能让它抛
        if (cmd === 'perm_list' || cmd === 'perm_grant' || cmd === 'perm_revoke') return [];
        // 停止按钮会顺手通知 Rust 终止正在跑的命令；这里没有子进程，返回 false
        if (cmd === 'run_cancel') return false;
        throw new Error('unknown cmd: ' + cmd);
      },
    };
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew');
  await page.waitForFunction(
    () => !/检测中/.test(document.querySelector('#transportText')?.textContent || ''),
    null,
    { timeout: 15000 }
  );

  /* ---------------------------------------------------------- 1. 选文件夹 */
  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker');
  check('打开文件夹选择器', await page.isVisible('#folderPicker'));

  await page.waitForSelector('.fp-row.dir');
  const driveRows = await page.locator('.fp-row.dir').count();
  check('列出盘符下的目录', driveRows >= 1, driveRows + ' 个');

  /* ------------------------------------------------ 1.1 新建工作区文件夹 */
  await page.click('#fpNewDir');
  await page.waitForSelector('#fpNewName');
  check('新建文件夹输入框出现、空名不可提交', await page.isDisabled('#fpNewOk'));

  await page.fill('#fpNewName', 'ws-new');
  await page.click('#fpNewOk');
  await page.waitForFunction(
    () => (document.querySelector('.fp-target')?.textContent || '').replace(/[\\/]+$/, '').endsWith('ws-new'),
    null,
    { timeout: 8000 }
  );
  check('新建成功后直接进入新目录', true, ((await page.textContent('.fp-target')) || '').trim());

  await page.locator('.fp-drive', { hasText: 'F:' }).first().click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#fpList .fp-row.dir')].some((r) => (r.textContent || '').includes('ws-new'))
  );
  check('返回上级能在列表里看到新目录', true);

  await page.click('#fpNewDir');
  await page.fill('#fpNewName', 'ws-new');
  await page.click('#fpNewOk');
  await page.waitForSelector('#fpNewErr', { timeout: 5000 });
  const dup = (await page.textContent('#fpNewErr')) || '';
  check('重名时报错而不是静默复用', /已存在/.test(dup), dup.trim());

  await page.click('#fpNewName');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#fpNewRow', { state: 'detached', timeout: 5000 });
  check('Esc 只收起新建行，选择器仍开着', await page.isVisible('#folderPicker'));

  await page.locator('.fp-row.dir', { hasText: 'demo' }).first().click();
  await page.waitForFunction(() => (document.querySelector('.fp-target')?.textContent || '').includes('demo'));
  const rows = await page.locator('.fp-row').count();
  check('进入 demo 目录', rows >= 2, rows + ' 条');

  await page.click('#fpConfirm');
  await page.waitForSelector('#folderPicker', { state: 'detached' });
  const chip = (await page.textContent('#btnWorkspace')) || '';
  check('顶栏显示工程名', chip.includes('demo'), chip.trim());
  check('工程模式下出现写入历史入口', await page.isVisible('#btnUndo'));

  /* ---------------------------------------------------------- 2. 配置模型 */
  await page.click('#modelPill');
  await page.waitForSelector('#drawer:not([hidden])');
  await page.fill('#baseUrl', MOCK);
  await page.fill('#apiKey', 'mock-key');
  await page.fill('#model', 'mock-gpt-4o');
  await page.click('#btnSave');
  await page.waitForSelector('#drawer', { state: 'hidden' });

  /* ---------------------------------------------------------- 3. 模型输出文件 → 自动落盘 */
  await page.fill('#input', '[[files]] 帮我搭一个静态页面工程');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#fileWrites', { timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector('#faStatus')?.textContent || '').includes('已落盘'), null, {
    timeout: 15000,
  });

  const written = await page.evaluate(() => window.__WRITTEN);
  const writes = written.filter((w) => !w.rel.startsWith('.zxz/undo/')); // 备份也是写，单独看
  check('未点击任何按钮就写入磁盘', writes.length === 4, writes.map((w) => w.rel).join(', '));
  check(
    '路径直接来自模型输出',
    writes.some((w) => w.rel === 'index.html') && writes.some((w) => w.rel === 'src/main.js')
  );
  check(
    '写入只带已登记的 sessionId，不携带任何 root',
    writes.every((w) => w.sessionId === 'ws-e2e' && !('root' in w)),
    writes[0] && writes[0].sessionId
  );

  const diskHtml = await page.evaluate(() => window.__DISK['index.html'] || '');
  check('文件内容真的写进了磁盘', diskHtml.includes('<h1>你好，本地工程</h1>'), diskHtml.length + ' 字节');

  const chatText = await page.textContent('#chat');
  check('对话框不再显示文件代码', !chatText.includes('<!doctype html>') && !chatText.includes('font-family: system-ui'));
  check('对话框仍保留解释文字', chatText.includes('最小可运行的静态页面工程'));

  await page.click('#fileWrites .fa-head .link-btn');
  await page.waitForSelector('#fileWrites .fa-list');
  const listed = await page.$$eval('#fileWrites .fa-list code', (els) => els.map((e) => e.textContent));
  check('文件列表含 4 个路径', listed.length === 4 && listed.includes('src/main.js'), listed.join(', '));

  await page.screenshot({ path: `${OUT}/workspace-autowrite.png` });

  /* ---------------------------------------------------------- 4. 系统提示词 */
  const last = await (await fetch(`${MOCK_ROOT}/_last`)).json();
  const sys = (last.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
  check('提示词含本地工程说明', sys.includes('本地工程模式'), sys.slice(0, 30).replace(/\s+/g, ' '));
  check('提示词含工程根目录', sys.includes('F:\\demo'));
  check('提示词含目录树', sys.includes('README.md'));
  check('提示词约定落盘格式', sys.includes('```file:相对路径'));
  check('提示词声明自动写入', sys.includes('自动写入磁盘'));
  check('提示词给出读文件协议', sys.includes('@@read: 相对路径'));

  /* ---------------------------------------------------------- 5. 非法路径只写合法的 */
  await page.fill('#input', '[[badpath]] 再写几个');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#fileWrites').length >= 2, null, { timeout: 20000 });
  await page.waitForTimeout(600);

  const afterBad = await page.evaluate(() => window.__WRITTEN.map((w) => w.rel));
  check('只写入合法路径', afterBad.filter((r) => r === 'ok/safe.txt').length === 1, afterBad.join(', '));
  check(
    '越权路径没有到达写入层',
    !afterBad.some((w) => w.includes('..') || /^[A-Za-z]:/.test(w)),
    afterBad.join(', ')
  );

  const badBar = page.locator('#fileWrites').last();
  const badStatus = (await badBar.locator('#faStatus').textContent()) || '';
  check('回执标出失败项', /有失败项/.test(badStatus), badStatus.trim());
  await badBar.locator('.fa-head .link-btn').click();
  const badRows = await badBar.locator('.fa-list li.bad').count();
  check('两个非法路径逐条标红', badRows === 2, badRows + ' 条');

  /* ---------------------------------------------------------- 6. @@read：读真实文件后再改 */
  await page.fill('#input', '[[read]] 把 src/old.js 重构一下');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#fileWrites').length >= 3, null, { timeout: 25000 });
  await page.waitForTimeout(600);

  const readList = await page.evaluate(() => window.__READ);
  check('程序真的读了工程里的文件', readList.includes('src/old.js'), readList.join(', '));

  const diskOld = await page.evaluate(() => window.__DISK['src/old.js'] || '');
  check('读到内容后按文件写回磁盘', diskOld.includes('export function legacyInit'), diskOld.split('\n')[0]);

  const hiddenOk = await page.evaluate(() => {
    const t = document.querySelector('#chat').textContent || '';
    return !t.includes('<<<FILE') && !t.includes('[程序回传]');
  });
  check('回传的文件内容不显示给用户', hiddenOk);

  /* ---------------------------------------------------------- 7. 差异对比 */
  const undoBar = page.locator('#fileWrites').last();
  await undoBar.locator('.fa-head .link-btn').click();
  await undoBar.locator('.fa-list .fa-open').first().click();
  await page.waitForSelector('#diffModal', { timeout: 10000 });

  const delLines = await page.$$eval('#diffBody .diff-line.del code', (els) => els.map((e) => e.textContent));
  const addLines = await page.$$eval('#diffBody .diff-line.add code', (els) => els.map((e) => e.textContent));
  check('diff 列出被删掉的旧行', delLines.some((l) => l.includes('.legacy')), delLines.join(' | ').slice(0, 80));
  check('diff 列出新增的新行', addLines.some((l) => l.includes('export function legacyInit')), addLines.length + ' 行');
  const diffBadge = (await page.textContent('#diffModal .diff-badge')) || '';
  check('diff 顶部有 +N −N 摘要', /[+−]/.test(diffBadge), diffBadge.trim());

  await page.screenshot({ path: `${OUT}/workspace-diff.png` });
  await page.click('#diffModal .modal-foot .btn.primary');
  await page.waitForSelector('#diffModal', { state: 'detached' });

  const rowDiff = (await page.locator('#fileWrites').last().locator('.fa-diff').first().textContent().catch(() => '')) || '';
  check('回执行上也有增删行数', /[+−]/.test(rowDiff), rowDiff.trim() || '(空)');

  /* ---------------------------------------------------------- 8. 回滚到上一版 */
  await page.click('#btnUndo');
  await page.waitForSelector('#undoPanel');
  await page.waitForSelector('.undo-snap', { timeout: 10000 });
  const snaps = await page.locator('.undo-snap').count();
  check('写入历史列出快照', snaps >= 1, snaps + ' 个');

  // 面板默认展开最新一次快照；已经展开就别再点，否则会收起
  const firstHead = page.locator('.undo-snap-head').first();
  if (!(await firstHead.evaluate((el) => el.classList.contains('on')))) await firstHead.click();
  const undoFiles = await page.$$eval('.undo-files code', (els) => els.map((e) => e.textContent));
  check('快照里能看到被覆盖的文件', undoFiles.includes('src/old.js'), undoFiles.join(', '));

  await page.locator('.undo-files li', { hasText: 'src/old.js' }).first().locator('.link-btn').last().click();
  await page.waitForFunction(() => /\.legacy/.test(window.__DISK['src/old.js'] || ''), null, { timeout: 15000 });
  const restored = await page.evaluate(() => window.__DISK['src/old.js']);
  check('回滚把旧内容写回了磁盘', restored.includes('root.querySelector(".legacy")'), restored.split('\n')[0]);
  check(
    '回滚前又存了一份当前版本（可再撤销）',
    await page.evaluate(() =>
      Object.keys(window.__DISK).some(
        (k) =>
          k.startsWith('.zxz/undo/') &&
          k.endsWith('/src/old.js') &&
          window.__DISK[k].includes('export function legacyInit')
      )
    )
  );

  await page.screenshot({ path: `${OUT}/workspace-undo.png` });
  await page.click('#undoPanel .modal-foot .btn.primary');
  await page.waitForSelector('#undoPanel', { state: 'detached' });

  check('无 JS 运行时错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})();
