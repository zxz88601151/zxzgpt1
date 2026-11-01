/* 桌面端真机验证技能库：技能目录是真的，扫描与附件读取都走 Rust 文件层。
 *
 * 前置：
 *   1) exe 已用 `additionalBrowserArgs: --remote-debugging-port=9223` 编译并启动
 *   2) 模拟上游在 19888 跑着
 *
 *   node tools/desktop-skill-e2e.cjs
 *
 * 与 skill-e2e.cjs 的区别：那边注入假 IPC 验前端链路，这边是端到端——
 * SKILL.md 从磁盘读出、@@ref 真的读到 refs/detail.md，跑完还原用户状态。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:19888/v1';
const MOCK_ROOT = process.env.MOCK_SERVER || 'http://127.0.0.1:19888';
const SHOT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots';

const LIB = path.join('F:', 'zhuomian', 'zxz', '.tmp-skills');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  // 真实技能目录：一个可用技能（含附件）+ 一个坏技能 + 一个不是技能的目录
  fs.rmSync(LIB, { recursive: true, force: true });
  fs.mkdirSync(path.join(LIB, 'ext-skill', 'refs'), { recursive: true });
  fs.writeFileSync(
    path.join(LIB, 'ext-skill', 'SKILL.md'),
    [
      '---',
      'name: 真机技能',
      'description: 放在真实磁盘上的技能，验证外部技能库走的是 Rust 文件层',
      'triggers: [真机技能, tmp-skill]',
      'version: 0.3.0',
      '---',
      '',
      '# 真机技能规则',
      '',
      '1. 表名一律小写复数。',
      '2. 迁移脚本必须成对给出 up / down。',
      '3. 细则见 @@ref: ext-skill/refs/detail.md。',
      '',
    ].join('\n')
  );
  fs.writeFileSync(path.join(LIB, 'ext-skill', 'refs', 'detail.md'), '命名用 verbNoun；错误统一抛 AppError。\n');
  fs.mkdirSync(path.join(LIB, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(LIB, 'broken', 'SKILL.md'), '---\nname: 坏技能\n---\n\n故意缺 description。\n');
  fs.mkdirSync(path.join(LIB, 'notaskill'), { recursive: true });
  fs.writeFileSync(path.join(LIB, 'notaskill', 'notes.md'), '这里不是技能\n');

  // 带危险命令的技能：验证扫描器扫的是「磁盘读出来的正文」，不是别的来源
  fs.mkdirSync(path.join(LIB, 'risky-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(LIB, 'risky-skill', 'SKILL.md'),
    [
      '---',
      'name: 危险示例',
      'description: 正文里放了危险命令，验证扫描器在真机上能扫出磁盘内容',
      '---',
      '',
      '# 危险示例',
      '',
      '先清干净再重建：',
      '',
      '```bash',
      'rm -rf ./data',
      '```',
      '',
    ].join('\n')
  );

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => /tauri|localhost/.test(p.url())) || pages[0];
  check('连上桌面窗口', Boolean(page), page.url());
  // 窗口被遮住时 WebView2 会停渲染，元素尺寸为 0，Playwright 判定为「不可见」——先置前
  await page.bringToFront();
  await page.waitForTimeout(400);
  page.on('dialog', (d) => d.accept());

  const backup = await page.evaluate(() => localStorage.getItem('zxz.state.v1'));

  await page.evaluate(
    ([lib, mock]) => {
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
            workspace: null,
            skills: [],
            skillAuto: true,
            skillsDir: lib,
          },
          conversations: [],
          activeId: null,
        })
      );
    },
    [LIB, MOCK]
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });

  /* ---------------------------------------------------- 真实扫描技能目录 */
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel');
  await page.waitForSelector('.skill-item', { timeout: 15000 });

  const dir = (await page.textContent('#skillDir')) || '';
  check('面板读到真实技能库路径', dir.includes('.tmp-skills'), dir.trim());

  const items = await page.$$eval('#skillList .skill-item', (els) => els.map((e) => e.dataset.id));
  check('磁盘上的技能被列出', items.includes('ext-skill'), items.length + ' 项');
  check('不是技能的目录被跳过', !items.includes('notaskill'), 'notaskill 未出现');

  const title = (await page.textContent('.skill-item[data-id="ext-skill"] .skill-title')) || '';
  check('读到文件里的 name / version', title.includes('真机技能') && title.includes('v0.3.0'), title.trim());

  const err = (await page.textContent('#skillErrors').catch(() => '')) || '';
  check('坏技能单独报错', /broken/.test(err) && /description/.test(err), err.replace(/\s+/g, ' ').slice(0, 50));

  // 扫描器扫的是真实磁盘正文：代码块里的 rm -rf 必须被判成「要执行的危险指令」
  const riskyBadge = (await page.textContent('.skill-item[data-id="risky-skill"] .scan-badge').catch(() => '')) || '';
  check('真机扫描认出磁盘上的危险指令', riskyBadge.includes('危险指令'), riskyBadge.trim());
  const cleanBadge = (await page.textContent('.skill-item[data-id="ext-skill"] .scan-badge').catch(() => '')) || '';
  check('干净技能标干净而不是留空', cleanBadge.includes('干净'), cleanBadge.trim());

  await page.click('.skill-item[data-id="risky-skill"] .skill-scan summary');
  const hits = await page.$$eval('.skill-item[data-id="risky-skill"] .scan-list li', (els) =>
    els.map((e) => (e.dataset.kind || '') + '|' + (e.querySelector('.scan-label') || {}).textContent + '|' + (e.querySelector('.scan-text') || {}).textContent)
  );
  check(
    '命中行标出语境、规则与原文',
    hits.length === 1 && hits[0].startsWith('code|递归删除|') && hits[0].includes('rm -rf'),
    hits.join(' / ')
  );

  await page.screenshot({ path: path.join(SHOT, 'desktop-skill-panel.png') });

  /* ---------------------------------------------------- 启用并验证注入的是磁盘内容 */
  await page.click('.skill-item[data-id="ext-skill"] .switch');
  await page.click('#btnSkillDone');
  await page.waitForSelector('#skillPanel', { state: 'detached' });

  await page.fill('#input', '按真机技能写个迁移脚本');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const s = document.querySelector('#btnStop');
    return !s || s.hidden;
  }, null, { timeout: 60000 });

  const req1 = await (await fetch(MOCK_ROOT + '/_last')).json();
  const sys1 = (req1.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
  check('系统提示词带上磁盘里的技能正文', sys1.includes('技能 ext-skill｜真机技能') && sys1.includes('迁移脚本必须成对给出'), sys1.length + ' 字符');
  check('内建技能仍在库里可选', sys1.includes('react-ts') && sys1.includes('【技能库】'), '目录清单');

  /* ---------------------------------------------------- @@ref 真的读到附件 */
  await page.fill('#input', '[[ref]] 按细则改');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((m) => m.textContent.includes('细则看过了')),
    null,
    { timeout: 60000 }
  );

  const req2 = await (await fetch(MOCK_ROOT + '/_last')).json();
  const toolMsg = (req2.messages || []).filter((m) => m.role === 'user').pop();
  const toolText = String((toolMsg && toolMsg.content) || '');
  check('附件从真实磁盘读出并回传', toolText.includes('技能 ext-skill/refs/detail.md') && toolText.includes('verbNoun'), toolText.length + ' 字符');

  const visible = (await page.textContent('#chat')) || '';
  check('对话里看不到 @@ref 与回传内容', !visible.includes('@@ref:') && !visible.includes('[程序回传]'));

  await page.screenshot({ path: path.join(SHOT, 'desktop-skill-chat.png') });

  /* ---------------------------------------------------- 断开技能库后只剩内建 */
  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel');
  await page.click('#btnSkillClearDir');
  await page.waitForTimeout(400);
  const afterClear = await page.$$eval('#skillList .skill-item', (els) => els.map((e) => e.dataset.id));
  const dirAfter = (await page.textContent('#skillDir')) || '';
  check('断开后不再列出磁盘技能', !afterClear.includes('ext-skill'), afterClear.length + ' 项');
  check('断开后提示未接入', dirAfter.includes('未接入'), dirAfter.trim());
  await page.click('#btnSkillDone');

  /* ---------------------------------------------------- 审计清单落到真实磁盘 */
  const AUDIT_WS = path.join('F:', 'zhuomian', 'zxz', '.tmp-audit');
  fs.rmSync(AUDIT_WS, { recursive: true, force: true });
  fs.mkdirSync(AUDIT_WS, { recursive: true });

  await page.evaluate((root) => {
    const st = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
    st.settings.workspace = { root, name: 'audit', tree: '' };
    localStorage.setItem('zxz.state.v1', JSON.stringify(st));
  }, AUDIT_WS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('#btnWorkspace')?.textContent || '').includes('audit'), null, {
    timeout: 15000,
  });

  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel');
  await page.click('#tabSources');
  await page.waitForSelector('#sourceList');
  await page.click('#btnExportAudit');
  await page.waitForFunction(() => (document.querySelector('#toastHost')?.textContent || '').includes('审计底稿已写入'), null, {
    timeout: 20000,
  });

  const auditDir = path.join(AUDIT_WS, '.zxz', 'audit');
  const auditFiles = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).filter((f) => f.endsWith('.md')) : [];
  check('真机上导出写进了 .zxz/audit/', auditFiles.length === 1, auditFiles.join(', ') || '目录为空');

  const auditMd = auditFiles.length ? fs.readFileSync(path.join(auditDir, auditFiles[0]), 'utf8') : '';
  check(
    '磁盘上的清单是完整的 29 条',
    auditMd.includes('| 登记来源 | 29 |') && auditMd.includes('obra/superpowers') && auditMd.includes('ruvnet/ruflo'),
    auditMd.length + ' 字符'
  );
  check(
    '底稿带实测报告与落地记录',
    auditMd.includes('# 技能来源实测审计报告') && auditMd.includes('已落地为本项目内建技能'),
    '两节齐全'
  );

  const topLevel = fs.readdirSync(AUDIT_WS);
  check('清单不落在工程根、只进 .zxz', topLevel.length === 1 && topLevel[0] === '.zxz', topLevel.join(', ') || '空');
  await page.screenshot({ path: path.join(SHOT, 'desktop-audit.png') });
  await page.click('#btnSkillDone');

  /* ---------------------------------------------------- 还原用户原有的本地状态 */
  await page.evaluate((raw) => {
    if (raw === null) {
      localStorage.removeItem('zxz.state.v1');
      return;
    }
    localStorage.setItem('zxz.state.v1', raw);
    try {
      const s = JSON.parse(raw);
      if (s && s.settings) {
        let dirty = false;
        if (String(s.settings.skillsDir || '').includes('.tmp-skills')) {
          s.settings.skillsDir = null;
          dirty = true;
        }
        if (String((s.settings.workspace || {}).root || '').includes('.tmp-audit')) {
          s.settings.workspace = null;
          dirty = true;
        }
        if (dirty) localStorage.setItem('zxz.state.v1', JSON.stringify(s));
      }
    } catch {
      /* 解析失败就原样保留 */
    }
  }, backup);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });

  fs.rmSync(LIB, { recursive: true, force: true });
  check('测试目录已清理', !fs.existsSync(LIB), LIB);
  fs.rmSync(AUDIT_WS, { recursive: true, force: true });
  check('审计测试目录已清理', !fs.existsSync(AUDIT_WS), AUDIT_WS);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(2);
});
