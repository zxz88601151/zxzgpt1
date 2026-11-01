/* 新一轮真机全流程：真模型写一个「番茄钟网页」 → 静态质量检查 → 起服务真跑一遍。
 *
 * 前置：exe 带 --remote-debugging-port=9223 编译并启动，界面里已配好真实模型。
 * 用法：NODE_PATH=/tmp/zxz-e2e/node_modules node tools/live-web-round.cjs
 *
 * 与 skill-e2e 的分工：那边验 Echo/mock，这边只关心「模型写出来的代码能不能用」——
 * 所以断言分三层：磁盘产物是否存在 → 静态质量扫描 → 浏览器里真跑（含 25 分钟快进）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { loadCatalog, autoMatched, MAX_AUTO_MATCH } = require('./lib/skill-match.cjs');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const PARENT = 'F:\\zhuomian\\zxz';
const SHOT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots/web-round';
const PORT = Number(process.env.SERVE_PORT || 8901);
const WAIT_MODEL_MS = Number(process.env.WAIT_MODEL_MS || 420000);

const pad = (n) => String(n).padStart(2, '0');
const s = new Date();
const DIR_NAME = `webtest-${pad(s.getMonth() + 1)}${pad(s.getDate())}-${pad(s.getHours())}${pad(s.getMinutes())}`;
const ROOT = path.join(PARENT, DIR_NAME);

const results = [];
/* 严重度：
 *   blocker —— 功能坏的、违反「离线可用」这类硬要求的，影响退出码
 *   warn    —— 风格/健壮性建议（用不用 var、有没有给 localStorage 兜 try 之类），
 *              环境相关或有争议，只报告不判死
 */
function check(name, ok, detail, severity) {
  const sev = severity === 'warn' ? 'warn' : 'blocker';
  const good = Boolean(ok);
  results.push({ name, ok: good, severity: sev, detail: detail === undefined ? '' : String(detail) });
  console.log(`${good ? 'PASS' : sev === 'warn' ? 'WARN' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function info(msg) {
  console.log(`      ${msg}`);
}

const PROMPT = [
  '帮我写一个番茄钟网页，纯 HTML + CSS + 原生 JavaScript，不要框架、不要依赖、不要 CDN，',
  '必须能离线双击 index.html 直接打开使用。',
  '功能要求：',
  '1. 专注 25 分钟、休息 5 分钟两个模式，页面上用 mm:ss 显示剩余时间',
  '2. 提供开始、暂停、重置三个操作',
  '3. 完成一轮专注后「今日完成轮数」+1，切换模式时要有明确提示',
  '4. 分成三个文件：index.html、css/style.css、js/app.js',
  '5. 关键元素请加上 data-testid，取值固定为：btnStart、btnPause、btnReset、timeDisplay、modeLabel、roundsToday',
  '6. 计时到点、模式切换、重置回初始态、轮数持久化都要有明确处理',
  '代码尽量简洁，一个函数只做一件事，命名别糊弄。',
  '写完之后请自己验证一遍：逐条对照上面 6 条要求，说明哪些成立、哪些没法验证。',
].join('\n');

const EXPECTED_FILES = ['index.html', 'css/style.css', 'js/app.js'];

/* ------------------------------------------------------------ 静态质量扫描 */
function staticAudit(files) {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const html = read('index.html');
  const css = read('css/style.css');
  const js = read('js/app.js');
  const extRef = /https?:\/\/|\/\/[a-z0-9-]+\.[a-z]{2,}\//i;

  check('HTML 有 doctype', /^\s*<!DOCTYPE html>/i.test(html), (html.match(/^\s*<![^>]*>/i) || [''])[0].slice(0, 30));
  check('HTML 声明了语言（lang）', /<html[^>]+lang=/i.test(html), (/<html[^>]+lang="[^"]*"/i.exec(html) || [''])[0]);
  check('HTML 声明 UTF-8', /<meta[^>]+charset=["']?utf-8/i.test(html));
  check('HTML 有 viewport（移动端不溢出）', /<meta[^>]+name=["']viewport["']/i.test(html));

  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(#|mailto:|data:)/.test(u));
  check('HTML 引用的本地资源都存在', refs.length > 0 && refs.every((u) => fs.existsSync(path.join(ROOT, u))), refs.join(', '));
  check('没有任何外链/CDN', !extRef.test(html) && !extRef.test(css) && !extRef.test(js));
  check(
    'CSS/JS 以相对路径引入',
    /(href="css\/style\.css")/.test(html) && /(src="js\/app\.js")/.test(html),
    (html.match(/(?:href|src)="(css\/style\.css|js\/app\.js)"/g) || []).join(', ')
  );

  const inlineOn = [...html.matchAll(/\son[a-z]+\s*=/gi)].map((m) => m[0].trim());
  check('HTML 没有内联事件属性', inlineOn.length === 0, inlineOn.slice(0, 3).join(' ') || '干净');
  const inlineStyle = [...html.matchAll(/\sstyle\s*=/gi)].length;
  check('HTML 没有内联 style', inlineStyle === 0, `${inlineStyle} 处`);

  check('CSS 没有 @import 外链', !/@import\s+url\(\s*['"]?https?:/i.test(css));
  const imp = (css.match(/!important/g) || []).length;
  check('CSS 没有滥用 !important', imp === 0, `${imp} 处`, 'warn');
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  check('CSS 括号配平', open === close && open > 0, `{ ${open} / } ${close}`);

  const bad = [
    ['var 声明', /\bvar\s+[a-zA-Z_$]/g],
    ['eval(', /\beval\s*\(/g],
    ['document.write', /\bdocument\.write\s*\(/g],
    ['console.log', /\bconsole\.log\s*\(/g],
    ['innerHTML', /\binnerHTML\s*=/g],
    ['松散相等 ==', /(?<![=!<>])==(?!=)/g],
    ['空 catch', /catch\s*(\([^)]*\))?\s*\{\s*\}/g],
    ['TODO/FIXME', /\b(TODO|FIXME)\b/g],
  ];
  for (const [label, re] of bad) {
    const hits = js.match(re) || [];
    // var 只是风格/健壮性：技能里没有明文禁止，实测也不影响功能，所以降级为 warn
    const sev = label === 'var 声明' ? 'warn' : 'blocker';
    check(
      `JS 无 ${label}`,
      hits.length === 0,
      hits.length ? `${hits.length} 处：${hits.slice(0, 2).join(' | ')}` : '干净',
      sev
    );
  }

  check('JS 用了严格相等', (js.match(/===/g) || []).length > 0, `${(js.match(/===/g) || []).length} 处 ===`);
  check(
    'JS 修改文本走 textContent 而非 innerHTML',
    /textContent\s*=/.test(js),
    `${(js.match(/textContent\s*=/g) || []).length} 处 textContent`
  );

  const hasLs = /localStorage/.test(js);
  const lsInTry = hasLs && /try\s*\{[^}]*localStorage/s.test(js);
  check(
    'localStorage 访问被 try 包住（file:// 下不炸）',
    !hasLs || lsInTry,
    hasLs ? (lsInTry ? '已包 try' : '未包 try（本机 Chromium 实测仍可用）') : '未使用',
    'warn'
  );

  const setI = (js.match(/\bsetInterval\s*\(/g) || []).length;
  const clearI = (js.match(/\bclearInterval\s*\(/g) || []).length;
  check('setInterval 有对应 clearInterval（不留泄漏）', setI === 0 || clearI > 0, `setInterval ${setI} / clearInterval ${clearI}`);

  const lines = js.split('\n');
  const fnLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(l));
  const fnCount = fnLines.length;
  check('函数数量适中（拆分合理）', fnCount >= 4 && fnCount <= 40, `${fnCount} 个命名函数`);

  // 最长函数：从「function」那行起，按同级缩进找配对的 }。
  // 缩进感知很重要——第二轮产出整个包在 IIFE 里，只认列 0 的 function 会量出 0 行而假通过。
  let longest = 0;
  let longestName = '';
  for (const { l, i } of fnLines) {
    const indent = l.match(/^\s*/)[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      const cur = lines[j].match(/^\s*/)[0].length;
      if (cur <= indent && /^\s*\}/.test(lines[j])) {
        const name = /function\s+([A-Za-z_$][\w$]*)/.exec(l)[1];
        if (j - i > longest) {
          longest = j - i;
          longestName = name;
        }
        break;
      }
    }
  }
  check('函数长度可测（真的测到了边界）', fnCount > 0 && longest > 0, `${fnCount} 个函数中量到最长 ${longest} 行`);
  check('没有超长函数（≤40 行）', fnCount > 0 && longest > 0 && longest <= 40, `最长 ${longest} 行：${longestName}`);

  check('行数在合理区间', lines.length >= 40 && lines.length <= 400, `js/app.js ${lines.length} 行`);

  return { html, css, js };
}

async function waitHttp(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((res) => {
      const req = http.get(url, (r) => {
        r.resume();
        res(r.statusCode === 200);
      });
      req.on('error', () => res(false));
      req.setTimeout(1000, () => {
        req.destroy();
        res(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });

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
      const raw = localStorage.getItem('zxz.state.v1');
      const s = raw ? JSON.parse(raw) : {};
      return { settings: s.settings || {}, conversations: s.conversations || [], activeId: s.activeId || '' };
    });

  /* ------------------------------------------------ 0. 配置核对 */
  const before = await readState();
  const set = before.settings;
  check('读到真实模型配置', Boolean(set.model && set.baseUrl), `model=${set.model}`);
  check('上游是真实接口', /api\.deepseek\.com/.test(String(set.baseUrl || '')) || /https?:\/\//.test(String(set.baseUrl || '')), String(set.baseUrl));
  const prevSkills = Array.isArray(set.skills) ? set.skills.slice() : [];

  /* ------------------------------------------------ 1. 建工程目录 */
  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker', { state: 'visible', timeout: 8000 });
  await page.waitForSelector('#folderPicker .fp-drive', { timeout: 10000 });
  await page.locator('#folderPicker .fp-drive', { hasText: /^F:\\?$/ }).first().click();
  await page.waitForSelector('#fpList .fp-row.dir', { timeout: 8000 });
  for (const seg of ['zhuomian', 'zxz']) {
    const row = page.locator('#fpList .fp-row.dir', { hasText: new RegExp(`^${seg}$`) }).first();
    await row.waitFor({ state: 'visible', timeout: 8000 });
    await row.click();
    await page.waitForTimeout(400);
  }
  await page.click('#fpNewDir');
  await page.waitForSelector('#fpNewName', { timeout: 5000 });
  await page.fill('#fpNewName', DIR_NAME);
  await page.click('#fpNewOk');
  await page.waitForTimeout(1200);
  check('工程目录已在磁盘上创建', fs.existsSync(ROOT) && fs.statSync(ROOT).isDirectory(), ROOT);
  const inside = (await page.locator('.fp-target').innerText()).trim();
  check('路径展示无 \\\\?\\ 前缀', !inside.includes('?') || !/^\\\\\?\\/.test(inside), inside);
  await page.click('#fpConfirm');
  await page.waitForSelector('#folderPicker', { state: 'hidden', timeout: 8000 });
  await page.screenshot({ path: path.join(SHOT, '01-workspace.png') });

  /* ------------------------------------------------ 2. 发需求 */
  await page.click('#btnNew');
  await page.waitForTimeout(400);
  const beforeSend = await readState();
  const activeAtSend = Array.isArray(beforeSend.settings.skills) ? beforeSend.settings.skills.slice() : [];
  await page.fill('#input', PROMPT);
  await page.click('#btnSend');

  const toastMsg = await page
    .waitForFunction(
      () => {
        const host = document.querySelector('#toastHost');
        const txt = host ? host.textContent || '' : '';
        return /已按关键词加载技能/.test(txt) ? txt.trim() : false;
      },
      null,
      { timeout: 9000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => '');
  const catalog = loadCatalog();
  const expected = autoMatched(catalog, PROMPT, activeAtSend, MAX_AUTO_MATCH).map((x) => x.s.name);
  const tail = toastMsg.split('已按关键词加载技能：')[1] || '';
  const actual = [];
  for (const seg of tail.split('、')) {
    const name = seg.trim();
    if (catalog.some((k) => k.name === name)) actual.push(name);
    else break;
  }
  check(
    '自动加载的技能与源码规则重算一致',
    JSON.stringify(actual) === JSON.stringify(expected),
    `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`
  );

  /* ------------------------------------------------ 3. 等模型写完 */
  const t0 = Date.now();
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
  await page.waitForTimeout(800);
  check('模型写完并落盘', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.screenshot({ path: path.join(SHOT, '02-after-write.png') });

  const after = await readState();
  const conv = after.conversations.find((c) => c.id === after.activeId) || after.conversations[0] || { messages: [] };
  const lastA = [...(conv.messages || [])].reverse().find((m) => m.role === 'assistant' && !m.hidden) || {};
  const reply = String(lastA.content || '');
  check('拿到助手回复且无错误', Boolean(reply) && !lastA.error, lastA.error ? String(lastA.error).slice(0, 120) : `${reply.length} 字`);
  check('真实计费（有 token 用量）', Boolean(lastA.usage && lastA.usage.total_tokens), JSON.stringify(lastA.usage || {}));

  /* ------------------------------------------------ 4. 磁盘产物 */
  const files = EXPECTED_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));
  check('三个文件都落盘', files.length === EXPECTED_FILES.length, files.join(', ') || '空目录');
  const extra = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.name !== '.zxz')
    .map((e) => e.name);
  check('没有产出预期外的多余文件', extra.every((n) => n === 'index.html' || n === 'css' || n === 'js'), extra.join(', '));
  for (const f of files) {
    check(`  ${f} 非空`, fs.statSync(path.join(ROOT, f)).size > 200, `${fs.statSync(path.join(ROOT, f)).size} 字节`);
  }
  if (files.length !== EXPECTED_FILES.length) {
    const bl = results.filter((r) => r.severity === 'blocker');
    fs.writeFileSync(
      path.join(SHOT, 'result.json'),
      JSON.stringify({ pass: bl.filter((r) => r.ok).length, total: bl.length, dir: ROOT, reply, results }, null, 2)
    );
    console.log('\n产物不全，静态检查与运行检查跳过');
    process.exit(1);
  }

  /* ------------------------------------------------ 5. 静态质量 */
  console.log('\n---- 静态质量检查 ----');
  staticAudit(files);
  console.log('----------------------\n');

  /* ------------------------------------------------ 6. 起服务真跑 */
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const server = spawn(py, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}/`;
  const up = await waitHttp(base, 15000);
  check('静态服务已起', up, base);

  if (up) {
    const test = await ctx.newPage();
    const errs = [];
    const external = [];
    let faviconMissed = false;
    let badResources = [];
    test.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text().slice(0, 160));
    });
    test.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
    test.on('request', (r) => {
      if (!/^http:\/\/127\.0\.0\.1:/.test(r.url())) external.push(r.url().slice(0, 80));
    });
    test.on('response', (r) => {
      if (r.status() >= 400) {
        if (/favicon\.ico$/.test(r.url())) faviconMissed = true;
        else badResources.push(`${r.status()} ${r.url()}`);
      }
    });

    let clockOk = true;
    try {
      await test.clock.install();
    } catch (e) {
      clockOk = false;
      info(`虚拟时钟不可用，跳过快进类用例：${String(e).slice(0, 60)}`);
    }

    await test.goto(base, { waitUntil: 'load' });
    await test.waitForTimeout(400);
    // 浏览器会自己要 favicon.ico，静态服务返回 404 是环境噪音，不是页面代码的问题；
    // 这类 404 会被单独记账，页面自身引用出错才算失败。
    const codeErrs = errs.filter((t) => !(faviconMissed && /Failed to load resource/.test(t) && /404/.test(t)));
    check('页面加载后无 JS 报错', codeErrs.length === 0, codeErrs.slice(0, 2).join(' | ') || '干净');
    check('页面自身引用的资源全部 200', badResources.length === 0, badResources.slice(0, 2).join(' | ') || '干净');
    if (faviconMissed) info('已忽略浏览器自动请求 favicon.ico 导致的 404（页面里没有引用它）');
    check('运行时零外部请求（真离线）', external.length === 0, external.slice(0, 2).join(' | ') || '干净');

    const ids = ['btnStart', 'btnPause', 'btnReset', 'timeDisplay', 'modeLabel', 'roundsToday'];
    const missing = [];
    for (const id of ids) if ((await test.locator(`[data-testid="${id}"]`).count()) === 0) missing.push(id);
    check('约定的 data-testid 齐全', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : ids.join(','));

    const Display = () => test.locator('[data-testid="timeDisplay"]').innerText();
    const Mode = () => test.locator('[data-testid="modeLabel"]').innerText();
    const Rounds = () => test.locator('[data-testid="roundsToday"]').innerText();

    if (missing.length === 0) {
      const init = await Display();
      check('初始倒计时是 25:00', /25:00/.test(init), init);
      info(`初始模式：${await Mode()}｜今日轮数：${await Rounds()}`);

      if (clockOk) {
        await test.click('[data-testid="btnStart"]');
        await test.clock.runFor(3000);
        const t1v = await Display();
        check('点开始后倒计时在走', t1v !== init, `${init} → ${t1v}`);

        await test.click('[data-testid="btnPause"]');
        await test.clock.runFor(5000);
        const t2v = await Display();
        check('点暂停后倒计时停住', t2v === t1v, `${t1v} → ${t2v}`);

        await test.click('[data-testid="btnReset"]');
        const t3v = await Display();
        check('点重置回到 25:00', /25:00/.test(t3v), t3v);

        // 完整跑完一轮专注：虚拟时钟快进 25 分钟
        const roundsBefore = await Rounds();
        await test.click('[data-testid="btnStart"]');
        await test.clock.runFor(25 * 60 * 1000 + 2000);
        const modeAfter = await Mode();
        const roundsAfter = await Rounds();
        check('专注结束后切到休息模式', /休息/.test(modeAfter), modeAfter);
        check('完成一轮后今日轮数 +1', roundsAfter !== roundsBefore, `${roundsBefore} → ${roundsAfter}`);

        await test.reload({ waitUntil: 'load' });
        await test.waitForTimeout(300);
        check('刷新后今日轮数仍在（持久化）', (await Rounds()) === roundsAfter, `${await Rounds()}`);
      } else {
        await test.click('[data-testid="btnStart"]');
        await test.waitForTimeout(1600);
        const t1v = await Display();
        check('点开始后倒计时在走', t1v !== init, `${init} → ${t1v}`);
        info('暂停/重置/整轮完成需要虚拟时钟，本次未做');
      }
      await test.screenshot({ path: path.join(SHOT, '10-page.png'), fullPage: true });
    } else {
      await test.screenshot({ path: path.join(SHOT, '10-page.png'), fullPage: true });
      info('缺 data-testid，交互用例未做（这条本身就是「未按约定交付」）');
    }
    await test.close();
  }
  server.kill();

  /* ------------------------------------------------ 7. 收尾 */
  if (prevSkills.length) {
    await page.evaluate((list) => {
      const s = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
      s.settings = { ...(s.settings || {}), skills: list };
      localStorage.setItem('zxz.state.v1', JSON.stringify(s));
    }, prevSkills);
  }
  check('界面无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '干净');

  const blockers = results.filter((r) => r.severity === 'blocker');
  const pass = blockers.filter((r) => r.ok).length;
  const warns = results.filter((r) => r.severity === 'warn' && !r.ok);
  fs.writeFileSync(
    path.join(SHOT, 'result.json'),
    JSON.stringify({ pass, total: blockers.length, warn: warns.length, dir: ROOT, reply, files, results }, null, 2)
  );
  console.log(`\n==== 硬失败 ${pass}/${blockers.length} PASS｜建议项 WARN ${warns.length} 条 ====`);
  for (const w of warns) console.log(`  WARN  ${w.name} — ${w.detail}`);
  console.log(`工程目录：${ROOT}`);
  console.log(`页面截图：${path.join(SHOT, '10-page.png')}`);
  process.exit(pass === blockers.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
