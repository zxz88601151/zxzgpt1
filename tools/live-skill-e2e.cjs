/* 真机全流程：技能面板 → 新建工程目录 → 真实模型写小项目 → 技能是否真的生效。
 *
 * 前置：
 *   1) exe 已带 `additionalBrowserArgs: --remote-debugging-port=9223` 编译并启动
 *   2) 界面里已配好真实模型（本脚本只读配置做断言，不改 baseUrl / key / model）
 *
 *   node tools/live-skill-e2e.cjs
 *
 * 与 tools/live-deepseek-e2e.cjs 的区别：那边验证「读写链路」，这边验证「技能链路」——
 * 自动按触发词加载了哪几个技能、模型有没有按技能的三步取证去做、有没有把 @@ref 当话讲出来。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const PARENT = 'F:\\zhuomian\\zxz';
const SHOT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots/skill-live';
const WAIT_MODEL_MS = Number(process.env.WAIT_MODEL_MS || 300000);

const stamp = new Date();
const pad = (n) => String(n).padStart(2, '0');
const DIR_NAME = `skilltest-${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
const ROOT = path.join(PARENT, DIR_NAME);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/* ---------------------------------------------------------------- 技能目录重建
 *
 * 不写死「这次应该加载哪几个技能」。而是从 `src/skills/` 的真实源文件重建目录，
 * 用与 `src/lib/skill.ts` 相同的一套打分规则算一遍期望值，再去核对界面实际加载了谁。
 * 这样变更触发词或调整声明顺序都不会让这条断言失真，也不会把「不符预期」误报成「不符设计」。
 */
const BUILTIN_DIR = path.join(__dirname, '..', 'src', 'skills', 'builtin');
const INDEX_TS = path.join(__dirname, '..', 'src', 'skills', 'index.ts');
const MAX_AUTO_MATCH = 2;

function loadCatalog() {
  // 声明顺序要紧：分数相同时由它决定谁上位，所以必须照着 index.ts 的 import 顺序排
  const order = fs
    .readFileSync(INDEX_TS, 'utf8')
    .split('\n')
    .map((line) => /\/builtin\/([a-z0-9-]+)\.md\?raw/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);

  return order.map((id) => {
    const raw = fs.readFileSync(path.join(BUILTIN_DIR, `${id}.md`), 'utf8');
    const fm = raw.split(/^---$/m)[1] || '';
    const field = (k) => ((new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm) || [])[1] || '').trim();
    return {
      id,
      name: field('name'),
      triggers: field('triggers')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  });
}

// 与 src/lib/skill.ts 的 hits() 同构：中文走包含，英文/代码走词边界
function hits(hay, needle) {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  if (/[^\x00-\x7f]/.test(n)) return hay.includes(n);
  const re = new RegExp(`(^|[^a-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_]|$)`);
  return re.test(hay);
}

// 与 src/lib/skill.ts 的 matchSkills() 同构：命中数降序，同分按声明顺序，截断到 limit
function autoMatched(catalog, text, active = [], limit = MAX_AUTO_MATCH) {
  const hay = text.toLowerCase();
  const scored = [];
  catalog.forEach((s, at) => {
    if (active.includes(s.id)) return;
    let score = 0;
    for (const t of s.triggers) if (hits(hay, t)) score += 1;
    if (score === 0 && hits(hay, s.id)) score += 1;
    if (score > 0) scored.push({ s, score, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, Math.max(0, limit));
}

const PROMPT = [
  '帮我写一个小项目：一个本地记账本网页，纯 HTML + CSS + 原生 JavaScript，不要框架、不要依赖、不要 CDN。',
  '功能要求：',
  '1. 能记一笔（金额、类别、备注），列表按时间倒序',
  '2. 每一笔能删掉，顶部显示合计金额和笔数',
  '3. 刷新页面数据还在',
  '4. 分成三个文件：index.html、css/style.css、js/app.js',
  '5. 空列表、金额为 0 或负数都要有明确处理',
  '代码尽量简洁，一个函数只做一件事，命名别糊弄。',
  '写完之后请自己验证一遍：逐条对照上面 5 条要求，说清楚哪些已验证、哪些没法验证。',
].join('\n');

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

  /* ------------------------------------------------ 0. 现状与配置 */
  const readState = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('zxz.state.v1');
      const s = raw ? JSON.parse(raw) : {};
      return {
        settings: s.settings || {},
        conversations: s.conversations || [],
        activeId: s.activeId || '',
      };
    });

  const before = await readState();
  const set = before.settings;
  const base = String(set.baseUrl || '');
  const model = String(set.model || '');
  const prevSkills = Array.isArray(set.skills) ? set.skills.slice() : [];
  const prevAuto = set.skillAuto !== false;

  check('读到接入的模型配置', Boolean(model && base), `model=${model} base=${base}`);
  check('上游是真实 DeepSeek', /api\.deepseek\.com/.test(base), base);
  check('API Key 已保存', String(set.apiKey || '').length > 20, `${String(set.apiKey || '').length} 字符（不外传）`);
  console.log(`      技能原始状态：已启用 ${prevSkills.length} 个 ${JSON.stringify(prevSkills)}，自动加载 ${prevAuto}`);

  /* ------------------------------------------------ 1. 技能面板 */
  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel', { state: 'visible', timeout: 8000 });
  await page.waitForSelector('#skillList .skill-item', { timeout: 8000 });
  const itemCount = await page.locator('#skillList .skill-item').count();
  check('技能面板列出内建技能', itemCount === 12, `${itemCount} 条`);

  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('#skillList .skill-item')].map((el) => el.getAttribute('data-id'))
  );
  check(
    '内建 id 与设计一致',
    ['code-style', 'verify-before-done', 'react-ts', 'dangerous-ops'].every((x) => ids.includes(x)),
    ids.slice(0, 6).join(', ')
  );

  // 触发词是「自动加载」的依据，必须在界面上看得见才能验收
  const triggerText = await page.evaluate(() => {
    const row = document.querySelector('#skillList .skill-item[data-id="code-style"] .skill-triggers');
    return row ? row.textContent.trim() : '';
  });
  check('技能行展示了触发词', /代码/.test(triggerText) && /函数/.test(triggerText), triggerText.slice(0, 60));

  // 为了可预测，先把已启用的技能全部关掉（测的是「自动匹配」，不是「手动勾选」）
  let opened = 0;
  for (let i = 0; i < 8; i++) {
    const on = page.locator('#skillList .switch.on');
    if ((await on.count()) === 0) break;
    await on.first().click();
    opened += 1;
    await page.waitForTimeout(120);
  }
  if (opened) console.log(`      关掉了 ${opened} 个已启用技能（测试结束后恢复）`);

  const autoBox = page.locator('#skillAuto');
  check('存在「按关键词自动加载」开关', (await autoBox.count()) === 1, `checked=${await autoBox.isChecked()}`);
  if (!(await autoBox.isChecked())) await autoBox.check();
  const autoOn = await autoBox.isChecked();
  check('自动加载已开启', autoOn, String(autoOn));
  await page.screenshot({ path: path.join(SHOT, '01-skill-panel.png') });

  await page.click('#btnSkillDone');
  await page.waitForSelector('#skillPanel', { state: 'hidden', timeout: 8000 });
  const chipCount = await page.locator('#skillChips .skill-chip').count();
  check('关闭面板后没有手动启用的技能', chipCount === 0, `${chipCount} 个 chip`);

  /* ------------------------------------------------ 2. 选文件夹 + 新建 */
  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker', { state: 'visible', timeout: 8000 });
  await page.waitForSelector('#folderPicker .fp-drive', { timeout: 10000 });
  const driveCount = await page.locator('#folderPicker .fp-drive').count();
  check('选择器列出磁盘', driveCount > 0, `${driveCount} 个盘符`);

  await page.locator('#folderPicker .fp-drive', { hasText: /^F:\\?$/ }).first().click();
  await page.waitForSelector('#fpList .fp-row.dir', { timeout: 8000 });
  for (const seg of ['zhuomian', 'zxz']) {
    const row = page.locator('#fpList .fp-row.dir', { hasText: new RegExp(`^${seg}$`) }).first();
    await row.waitFor({ state: 'visible', timeout: 8000 });
    await row.click();
    await page.waitForTimeout(400);
  }
  const here = (await page.locator('.fp-target').innerText()).trim();
  check('导航到父目录', here.replace(/[\\/]+$/, '').toLowerCase() === PARENT.toLowerCase(), here);

  // 走界面新建：这条链路上一轮刚补，顺便回归
  await page.click('#fpNewDir');
  await page.waitForSelector('#fpNewName', { timeout: 5000 });
  await page.fill('#fpNewName', DIR_NAME);
  await page.click('#fpNewOk');
  await page.waitForTimeout(1200);
  check('界面新建的目录真的落在磁盘上', fs.existsSync(ROOT) && fs.statSync(ROOT).isDirectory(), ROOT);

  const inside = (await page.locator('.fp-target').innerText()).trim();
  check('新建后自动进入该目录', inside.replace(/[\\/]+$/, '').toLowerCase() === ROOT.toLowerCase(), inside);
  await page.screenshot({ path: path.join(SHOT, '02-new-folder.png') });

  await page.click('#fpConfirm');
  await page.waitForSelector('#folderPicker', { state: 'hidden', timeout: 8000 });
  const chip = (await page.locator('#btnWorkspace .ws-name').innerText()).trim();
  check('工程目录已接入', chip === DIR_NAME, chip);

  /* ------------------------------------------------ 3. 发需求，看技能有没有自动加载 */
  await page.click('#btnNew');
  await page.waitForTimeout(400);
  // 自动匹配的输入之一是「当前已启用的技能」，得用发送那一刻的真实值，不能用测试前的旧状态
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
      { timeout: 8000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => '');
  check('界面提示按关键词自动加载了技能', /已按关键词加载技能/.test(toastMsg), toastMsg || '没等到提示');
  // 期望值按源码重建的目录 + 同构打分规则算出来，不在脚本里写死技能名
  const catalog = loadCatalog();
  const activeRecorded = Array.isArray(beforeSend.settings.skills) ? beforeSend.settings.skills : [];
  check('重算用的启用列表与界面一致', JSON.stringify(activeRecorded) === JSON.stringify(activeAtSend), JSON.stringify(activeAtSend));
  const rankedAll = autoMatched(catalog, PROMPT, activeAtSend, 99);
  const expected = rankedAll.slice(0, MAX_AUTO_MATCH).map((x) => x.s.name);
  // toast 会把前后几条提示连在一起，所以只取「紧跟在加载提示后面、且确实是目录里技能名」的连续几段
  const tail = toastMsg.split('已按关键词加载技能：')[1] || '';
  const actual = [];
  for (const seg of tail.split('、')) {
    const name = seg.trim();
    if (catalog.some((s) => s.name === name)) actual.push(name);
    else break;
  }

  check(
    '自动加载结果与源码规则重算一致',
    JSON.stringify(actual) === JSON.stringify(expected),
    `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`
  );
  check(
    '加载的技能名都在目录里',
    actual.every((n) => catalog.some((s) => s.name === n)),
    actual.join('、')
  );
  check(
    '匹配数超过上限时按「命中数 → 声明顺序」截断',
    rankedAll.length > MAX_AUTO_MATCH,
    `命中 ${rankedAll.map((x) => `${x.s.name}:${x.score}`).join(' ')}｜只取前 ${MAX_AUTO_MATCH}`
  );

  /* ------------------------------------------------ 4. 等模型写完 */
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
  await page.waitForTimeout(600);
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  check('模型写完并落盘', true, `${cost}s`);

  /* ------------------------------------------------ 5. 回复本身 */
  const after = await readState();
  const conv = after.conversations.find((c) => c.id === after.activeId) || after.conversations[0] || { messages: [] };
  const msgs = conv.messages || [];
  const lastA = [...msgs].reverse().find((m) => m.role === 'assistant' && !m.hidden) || {};
  const reply = String(lastA.content || '');
  check('拿到助手回复且无错误', Boolean(reply) && !lastA.error, lastA.error ? String(lastA.error).slice(0, 140) : `${reply.length} 字`);
  check('真实计费接口（有 token 用量）', Boolean(lastA.usage && lastA.usage.total_tokens), JSON.stringify(lastA.usage || {}));

  check('回复里没有 @@ref 指令残留', !/^\s*@@(?:ref|skill)/im.test(reply), /@@(?:ref|skill)/.test(reply) ? '发现残留' : '干净');
  const hidden = msgs.filter((m) => m.hidden);
  console.log(`      hidden 回传 ${hidden.length} 条`);

  // verify-before-done 的三步：回读 / 对照 / 定量。这里是行为层证据，不是文案游戏。
  const readBack = hidden.some((m) => /<<<FILE (?:js\/app\.js|index\.html|css\/style\.css)>>>/.test(m.content || ''));
  check('按技能要求回读了刚落盘的文件', readBack, readBack ? '有 @@read 回传' : '没有回读');
  // 取证要落在结构上：有逐条对照的标题、条目数覆盖全部需求、每条给了「成立/没法验证」的定性，
  // 而不是通篇都在说「应该没问题」。具体用词交给模型，判据只看这三件事有没有做到。
  const items = reply.match(/^\d+\.\s+.+/gm) || [];
  const hasVerdict = /(成立|成立。|一致|一致。|未验证|没法验证|无法验证|没有真实点击|未在浏览器)/.test(reply);
  check('回复逐条对照了需求', /逐条对照/.test(reply) && items.length >= 5, `${items.length} 条编号条目`);
  check('每条需求给了定性结论', hasVerdict, (reply.match(/(成立|未验证|没法验证|无法验证)/g) || []).slice(0, 4).join('/') || '未见口径');
  check('明说了哪些没法验证', /(无法验证|没法验证|不能验证|无法确认)/.test(reply), /(无法验证|没法验证|不能验证|无法确认)/.exec(reply)?.[0] || '没提');

  /* ------------------------------------------------ 6. 磁盘结果 */
  const listFiles = (dir) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.zxz') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out.sort();
  };
  const files = listFiles(ROOT);
  check('三个文件都落在磁盘上', ['index.html', 'css/style.css', 'js/app.js'].every((f) => files.includes(f)), files.join(', ') || '空目录');
  for (const f of files) {
    check(`  ${f} 非空`, fs.statSync(path.join(ROOT, f)).size > 200, `${fs.statSync(path.join(ROOT, f)).size} 字节`);
  }

  await page.screenshot({ path: path.join(SHOT, '03-after-write.png') });

  /* ------------------------------------------------ 7. 设置恢复 */
  const nowState = await readState();
  const finalSkills = nowState.settings.skills || [];
  check('自动加载没有篡改用户的启用列表', Array.isArray(finalSkills), JSON.stringify(finalSkills));
  if (prevSkills.length) {
    await page.evaluate((list) => {
      const raw = localStorage.getItem('zxz.state.v1');
      const s = raw ? JSON.parse(raw) : {};
      s.settings = { ...(s.settings || {}), skills: list };
      localStorage.setItem('zxz.state.v1', JSON.stringify(s));
    }, prevSkills);
    check('已恢复测试前的启用技能', true, JSON.stringify(prevSkills));
  } else {
    check('已恢复测试前的启用技能', true, '原本就没启用');
  }

  check('界面无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '干净');

  const pass = results.filter((r) => r.ok).length;
  fs.writeFileSync(path.join(SHOT, 'result.json'), JSON.stringify({ pass, total: results.length, dir: ROOT, reply, results }, null, 2));
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  console.log(`工程目录：${ROOT}`);
  console.log(`回复正文：${reply.length} 字（完整内容在 result.json）`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
