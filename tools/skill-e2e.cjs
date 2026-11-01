/* 技能库 E2E：内建技能、分类分组、外部技能目录、自动匹配、提示词注入、@@ref 取附件、
 * 来源清单（29 条）与审计清单导出（无工程时下载 / 有工程时写进 .zxz/audit/）
 *
 *   node tools/skill-e2e.cjs
 *
 * 浏览器里没有 Tauri IPC，所以注入一个假的 `__TAURI_INTERNALS__`（虚拟技能目录）。
 * 真实磁盘那一路由 tools/desktop-skill-e2e.cjs 在真机上跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.ZXZ_BASE || 'http://127.0.0.1:5173';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:19888/v1';
const MOCK_ROOT = process.env.MOCK_SERVER || 'http://127.0.0.1:19888';
const OUT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const SEED = {
  settings: {
    preset: 'custom',
    baseUrl: MOCK,
    apiKey: 'mock-key',
    model: 'mock-gpt-4o',
    temperature: 0,
    maxTokens: null,
    contextTurns: 10,
    systemPrompt: '',
    stream: true,
    theme: 'dark',
    workspace: null,
    skills: [],
    skillAuto: true,
    skillsDir: 'F:\\libs\\skills',
  },
  conversations: [],
  activeId: null,
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());

  // 假 Tauri IPC：一个技能库目录，两个能用的技能 + 一个坏技能 + 一个不是技能的目录
  await page.addInitScript(() => {
    const ROOT = 'F:\\libs\\skills';
    const DISK = {
      'ext-skill/SKILL.md':
        '---\nname: 外部口径\ndescription: 第三方技能库里的自有规范，写数据库相关代码时用\ntriggers: [口径, 数据库命名]\nversion: 2.1.0\n---\n\n# 外部规范\n\n表名统一小写复数。',
      'ext-skill/refs/detail.md': '命名用 verbNoun；错误统一抛 AppError。',
      // 两个样本技能，专门验证扫描器：
      // risky 是代码块里的真命令（判 code），clean 一条都没命中
      'risky-skill/SKILL.md':
        '---\nname: 危险示例\ndescription: 部署流程里带真实命令的第三方技能\ncategory: 交付\nstage: ship\n---\n\n# 部署\n\n## 清理旧构建\n\n```bash\nrm -rf ./build\n```\n\n然后强推：\n\n```\ngit push --force origin main\n```',
      'clean-skill/SKILL.md':
        '---\nname: 干净示例\ndescription: 没有任何危险指令的第三方技能\n---\n\n# 规范\n\n函数要短，命名要准。',
      'broken/SKILL.md': '---\nname: 坏技能\n---\n\n这个没有 description，应该被跳过。',
      'notes/readme.md': '这里不是技能目录',
    };
    const reads = [];
    window.__READS = reads;
    const writes = [];
    window.__WRITES = writes;
    window.__SKILL_ROOT = ROOT;

    // fs_read(root, rel) 的 root 可能是技能库根，也可能是单个技能目录
    const toKey = (root, rel) => {
      const base = String(root || '').replace(/\\+$/, '');
      const abs = base + '\\' + String(rel || '').replace(/\//g, '\\');
      const prefix = ROOT + '\\';
      if (!abs.startsWith(prefix)) return null;
      return abs.slice(prefix.length).split('\\').join('/');
    };

    const dirsOf = (abs) => {
      if (abs === ROOT) {
        return [
          { name: 'broken', dir: true, path: ROOT + '\\broken', size: 0 },
          { name: 'clean-skill', dir: true, path: ROOT + '\\clean-skill', size: 0 },
          { name: 'ext-skill', dir: true, path: ROOT + '\\ext-skill', size: 0 },
          { name: 'notes', dir: true, path: ROOT + '\\notes', size: 0 },
          { name: 'risky-skill', dir: true, path: ROOT + '\\risky-skill', size: 0 },
        ];
      }
      if (abs === 'F:\\') return [{ name: 'libs', dir: true, path: 'F:\\libs', size: 0 }];
      return [];
    };

    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === 'proxy_info') return null; // 直连 mock 上游
        if (cmd === 'fs_roots') return ['F:\\'];
        if (cmd === 'fs_list') return dirsOf(args.path);
        if (cmd === 'fs_exists') return Object.prototype.hasOwnProperty.call(DISK, toKey(args.root, args.rel));
        if (cmd === 'fs_read') {
          const key = toKey(args.root, args.rel);
          reads.push(key === null ? 'ESCAPE:' + args.rel : key);
          if (key === null || !Object.prototype.hasOwnProperty.call(DISK, key)) {
            throw new Error('NotFound: ' + args.rel);
          }
          return DISK[key];
        }
        if (cmd === 'fs_write') {
          const key = toKey(args.root, args.rel);
          if (key === null) throw new Error('越权写入：' + args.rel);
          const created = !Object.prototype.hasOwnProperty.call(DISK, key);
          DISK[key] = args.content;
          writes.push({ rel: key, content: args.content, created });
          return { bytes: String(args.content).length, created };
        }
        throw new Error('未实现的命令 ' + cmd);
      },
    };
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((seed) => localStorage.setItem('zxz.state.v1', JSON.stringify(seed)), SEED);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });

  /* ------------------------------------------------------------ 技能库面板 */
  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel');

  const items = await page.$$eval('#skillList .skill-item', (els) => els.map((e) => e.dataset.id));
  const builtinIds = ['code-style', 'react-ts', 'node-api', 'python-service', 'sql-schema', 'test-cases', 'code-review', 'security-check', 'dangerous-ops', 'module-boundaries', 'debug-first', 'verify-before-done'];
  check('内建 12 个技能全部列出', builtinIds.every((id) => items.includes(id)), items.length + ' 项');
  check('外部技能库被扫描到', items.includes('ext-skill'), items.join(', '));
  check('非技能目录被跳过', !items.includes('notes'), 'notes 未出现');
  check('坏技能不冒充可用技能', !items.includes('broken'), 'broken 未出现在列表');

  const cats = await page.$$eval('#skillList .skill-group', (els) => els.map((e) => e.dataset.cat));
  check('内建技能按分类分组', cats.includes('前端') && cats.includes('后端') && cats.includes('数据'), cats.join(', '));
  check('新增架构类技能独立成组', cats.includes('架构'), cats.join(', '));

  const quality = await page.$$eval('.skill-group[data-cat="质量"] .skill-item', (els) =>
    els.map((e) => ({ id: e.dataset.id, stage: e.dataset.stage || '' }))
  );
  check(
    '同组内按流水线阶段排',
    quality.some((s) => s.id === 'test-cases') && quality.some((s) => s.id === 'verify-before-done'),
    quality.map((s) => s.id + ':' + s.stage).join(', ')
  );
  const ORDER = ['plan', 'write', 'test', 'review', 'ship', 'infra', 'release', 'other'];
  const idx = quality.map((s) => ORDER.indexOf(s.stage));
  check('组内阶段序单调不减', idx.every((v, i) => i === 0 || v >= idx[i - 1]), idx.join(','));

  const extCat = await page.$$eval('.skill-group[data-cat="未分类"] .skill-item', (els) => els.map((e) => e.dataset.id));
  check('第三方技能没写分类时归到未分类', extCat.includes('ext-skill'), extCat.join(', '));

  const title = await page.textContent('.skill-item[data-id="ext-skill"] .skill-title');
  check('读到外部技能的 name 与 version', title.includes('外部口径') && title.includes('v2.1.0'), title.trim());

  const triggers = await page.textContent('.skill-item[data-id="ext-skill"] .skill-triggers');
  check('读到触发词', triggers.includes('口径') && triggers.includes('数据库命名'), triggers.trim());

  /* ------------------------------------------------------------ 本地技能扫描 */
  const riskyBadge = (await page.textContent('.skill-item[data-id="risky-skill"] .scan-badge')) || '';
  check('代码块里的危险指令被扫出来', riskyBadge.includes('2 处危险指令'), riskyBadge.trim());

  const cleanBadge = (await page.textContent('.skill-item[data-id="clean-skill"] .scan-badge')) || '';
  check('干净的技能也标出来，不是不显示', cleanBadge.trim() === '干净', cleanBadge.trim());

  const builtinBadges = await page.locator('.skill-item[data-id="code-style"] .scan-badge').count();
  check('内建技能不参与扫描', builtinBadges === 0, 'code-style 无徽章');

  const head = (await page.textContent('#scanHeadline')) || '';
  check('汇总点出有几个技能代码块里有命令', head.includes('1 个技能'), head.trim());

  await page.click('.skill-item[data-id="risky-skill"] .skill-scan summary');
  const rows = await page.$$eval('.skill-item[data-id="risky-skill"] .scan-list li', (els) =>
    els.map((e) => ({
      kind: e.dataset.kind,
      label: (e.querySelector('.scan-label') || {}).textContent,
      line: (e.querySelector('.scan-line') || {}).textContent,
    }))
  );
  // 不写死行号：样例正文改一个字行号就变，那种断言维护成本比收益高
  check(
    '明细写明是哪条规则、什么语境',
    rows.length === 2 && rows.every((r) => r.kind === 'code') &&
      rows.some((r) => r.label === '递归删除') && rows.some((r) => r.label === '覆盖远端历史'),
    rows.map((r) => r.label + '@' + r.line).join(' / ')
  );
  check('每条命中都带行号', rows.every((r) => /^\d+$/.test(String(r.line || '').trim())), rows.map((r) => r.line).join(','));

  const scanNote = (await page.textContent('.skill-item[data-id="risky-skill"] .scan-note')) || '';
  check('界面写明扫描口径与人工复核', scanNote.includes('不扫 refs/') && scanNote.includes('自己看原文'), scanNote.trim().slice(0, 40));

  // 单独拍这张卡片：徽章、命中明细、扫描口径一屏能看全
  await page.locator('.skill-item[data-id="risky-skill"]').screenshot({ path: path.join(OUT, 'skill-scan.png') });

  const errText = (await page.textContent('#skillErrors')) || '';
  check('解析失败的技能单独报错', /broken/.test(errText) && /description/.test(errText), errText.replace(/\s+/g, ' ').slice(0, 60));

  const bodyText = await page.textContent('.skill-item[data-id="react-ts"] .skill-body pre');
  check('能就地预览规则正文', bodyText.includes('useEffect') && bodyText.length > 200, bodyText.length + ' 字符');

  await page.screenshot({ path: path.join(OUT, 'skill-panel.png') });

  /* ------------------------------------------------------------ 来源清单 */
  await page.click('#tabSources');
  await page.waitForSelector('#sourceList');

  const srcIds = await page.$$eval('#sourceList .src-item', (els) => els.map((e) => e.dataset.id));
  check('来源清单 29 条全部渲染', srcIds.length === 29, srcIds.length + ' 条');
  check(
    '两批清单都在里面',
    srcIds.includes('obra/superpowers') && srcIds.includes('jakubkrehel/skills') && srcIds.includes('cloudflare/security-audit-skill'),
    '流水线 + 热榜 + 上批'
  );

  const hooks = await page.$$eval('#sourceList .src-item', (els) => els.map((e) => e.dataset.hook));
  const countHook = (h) => hooks.filter((x) => x === h).length;
  check(
    '接入方式分类正确',
    countHook('attach') === 15 && countHook('mcp') === 1 && countHook('action') === 1,
    `attach ${countHook('attach')} / mcp ${countHook('mcp')} / action ${countHook('action')} / readonly ${countHook('readonly')}`
  );

  const sumText = ((await page.textContent('#sourceSummary')) || '').replace(/\s+/g, ' ');
  check(
    '汇总与数据一致',
    /登记 29/.test(sumText) && /可接入 15/.test(sumText) && /需宿主 2/.test(sumText) && /仅参考 12/.test(sumText),
    sumText.trim()
  );

  const attachBadges = ((await page.textContent('.src-item[data-id="obra/superpowers"] .src-badges')) || '').replace(/\s+/g, ' ');
  check('可接入的标出类型与接入方式', attachBadges.includes('技能包') && attachBadges.includes('可接入技能库'), attachBadges.trim());

  const risky = ((await page.textContent('.src-item[data-id="hashicorp/agent-skills"] .src-badges')) || '').replace(/\s+/g, ' ');
  check('高风险单独标出', risky.includes('高风险'), risky.trim());

  const movedText = (await page.textContent('.src-item[data-id="ruvnet/claude-flow"]')) || '';
  check('改名的仓库用新地址并注明', movedText.includes('ruvnet/ruflo') && movedText.includes('已改名'), 'claude-flow → ruflo');

  const stages = await page.$$eval('#sourceList .src-group', (els) => els.map((e) => e.dataset.stage));
  check('按流水线阶段分组', stages.indexOf('write') < stages.indexOf('test') && stages.includes('release'), stages.join(', '));

  await page.click('.src-item[data-id="hashicorp/agent-skills"] .src-more summary');
  const auditItems = await page.$$eval('.src-item[data-id="hashicorp/agent-skills"] .src-audit li', (els) => els.map((e) => e.textContent));
  check('审计项可以展开逐条看', auditItems.length >= 3 && auditItems.some((t) => t.includes('apply')), auditItems.length + ' 条');

  /* ------------------------------------------------------------ 实测审计结论 */
  const verdictBadges = await page.$$eval('#sourceList .src-badge[class*="verdict-"]', (els) =>
    els.map((e) => e.className.replace(/.*verdict-/, ''))
  );
  check(
    '4 条实测结论都标在卡片上',
    verdictBadges.length === 4 && verdictBadges.filter((v) => v === 'reject').length === 1,
    verdictBadges.join(', ')
  );

  await page.click('.src-item[data-id="garrytan/gstack"] .src-more summary');
  const gstackHits = await page.$$eval('.src-item[data-id="garrytan/gstack"] .src-hits tbody tr', (els) =>
    els.map((e) => ({ kind: e.dataset.kind, text: (e.querySelector('td code') || {}).textContent || '' }))
  );
  check(
    '同一条 rm -rf 按上下文拆成多条',
    gstackHits.filter((r) => r.text === 'rm -rf').length === 4,
    gstackHits.filter((r) => r.text === 'rm -rf').length + ' 条'
  );
  check(
    '防护规则与执行指令分开标',
    gstackHits.some((r) => r.kind === 'guard') && gstackHits.some((r) => r.kind === 'instruction'),
    gstackHits.map((r) => r.kind).join(',')
  );
  const gstackEvid = await page.$$eval('.src-item[data-id="garrytan/gstack"] .src-evidence li', (els) =>
    els.map((e) => e.textContent || '')
  );
  check('要求执行的给出文件:行证据', gstackEvid.some((e) => /uninstall\.md:\d+/.test(e)), gstackEvid.length + ' 条证据');
  const gstackVerdict = (await page.textContent('.src-item[data-id="garrytan/gstack"] .src-verdict-text')) || '';
  check('结论说清为什么不接', gstackVerdict.includes('bun') && gstackVerdict.includes('84868'), gstackVerdict.slice(0, 40) + '…');

  const addyBadges = await page.$$eval('.src-item[data-id="addyosmani/agent-skills"] .src-badge', (els) =>
    els.map((e) => e.textContent)
  );
  check('预判被推翻的划掉并留痕', addyBadges.includes('预判高风险') && addyBadges.includes('挑着接'), addyBadges.join('|'));

  const notAudited = await page.$$eval('#sourceList .src-item:not(.audited) summary', (els) =>
    els.filter((e) => (e.textContent || '').includes('待实测')).length
  );
  check('没实测的明确标待实测，不假装查过', notAudited === 25, notAudited + ' 条');

  const appliedText = await page.$$eval('#sourceList .src-applied', (els) => els.map((e) => e.textContent || ''));
  check(
    '审计结论落地成技能后会在卡片上标出来',
    appliedText.length === 2 && appliedText.every((t) => t.includes('dangerous-ops')),
    appliedText.join(' | ')
  );

  await page.evaluate(() => {
    const l = document.querySelector('#sourceList');
    if (l) l.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(OUT, 'skill-sources.png') });

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportAudit')]);
  const auditPath = path.join(OUT, 'audit-preview.md');
  await download.saveAs(auditPath);
  const auditMd = fs.readFileSync(auditPath, 'utf8');
  check('导出的文件名带时间戳', /^source-audit-.*\.md$/.test(download.suggestedFilename()), download.suggestedFilename());
  check('导出内容有汇总表', auditMd.includes('# 技能来源审计清单') && auditMd.includes('| 登记来源 | 29 |'), auditMd.split('\n')[0]);
  check('导出内容可勾选', (auditMd.match(/- \[ \]/g) || []).length > 29, (auditMd.match(/- \[ \]/g) || []).length + ' 个复选框');
  check('清单里没有第三方正文', !auditMd.includes('## 硬规则') && !auditMd.includes('useEffect'), '只有事实与检查项');
  check(
    '底稿里带上了实测报告',
    auditMd.includes('# 技能来源实测审计报告') && auditMd.includes('预判 high，已修正'),
    '清单 + 实测两节'
  );

  await page.click('#tabSkills');
  await page.waitForSelector('#skillList');

  await page.evaluate(() => {
    const el = document.getElementById('scanHeadline');
    if (el) el.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'skill-scan-list.png') });

  const [scanDl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportScan')]);
  const scanPath = path.join(OUT, 'scan-preview.md');
  await scanDl.saveAs(scanPath);
  const scanMd = fs.readFileSync(scanPath, 'utf8');
  check('扫描结果文件名带时间戳', /^skill-scan-.+\.md$/.test(scanDl.suggestedFilename()), scanDl.suggestedFilename());
  check(
    '扫描结果含行号与规则名',
    scanMd.includes('# 本地技能扫描结果') && scanMd.includes('递归删除') && /SKILL\.md:\d+/.test(scanMd),
    scanMd.split('\n')[0]
  );
  check(
    '扫描结果不含技能正文，可以直接发人',
    !scanMd.includes('函数要短，命名要准') && !scanMd.includes('表名统一小写复数'),
    '只有行号与命中片段'
  );
  check('干净的技能单独归到一节', scanMd.includes('## 没扫到命中的技能'), 'clean-skill / ext-skill');

  /* ------------------------------------------------------------ 启用 + 注入 */
  await page.click('.skill-item[data-id="react-ts"] .switch');
  const chipOn = await page.$$eval('#skillChips .skill-chip', (els) => els.map((e) => e.dataset.id));
  check('启用后输入框上方出现技能胶囊', chipOn.includes('react-ts'), chipOn.join(', '));

  await page.click('#btnSkillDone');
  await page.waitForSelector('#skillPanel', { state: 'detached' });

  await page.fill('#input', '写个 react 组件');
  await page.click('#btnSend');
  await page.waitForFunction(() => {
    const s = document.querySelector('#btnStop');
    return !s || s.hidden;
  }, null, { timeout: 60000 });

  const req1 = await (await fetch(MOCK_ROOT + '/_last')).json();
  const sys1 = (req1.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
  check('系统提示词注入技能正文', sys1.includes('【已加载技能') && sys1.includes('技能 react-ts｜'), sys1.length + ' 字符');
  check('注入的是勾选的那份规则', sys1.includes('useEffect') && sys1.includes('依赖数组必须完整'), 'react-ts 正文命中');
  check('未启用技能的正文不进上下文', !sys1.includes('===== 技能 code-style'), '只带正文，不带别人的');
  check('附上技能目录供按需取用', sys1.includes('【技能库】') && sys1.includes('python-service'), '目录含其它 id');

  const foot1 = await page.textContent('.msg.assistant .msg-foot');
  check('消息尾部标出本次用了哪个技能', foot1.includes('react-ts'), foot1.replace(/\s+/g, ' ').trim());

  /* ------------------------------------------------------------ 关闭 + 自动匹配 */
  await page.click('#skillChips .skill-chip-x');
  const afterOff = await page.$$eval('#skillChips .skill-chip', (els) => els.length);
  check('胶囊可以单独关掉', afterOff === 0, afterOff + ' 个');

  await page.fill('#input', '帮我建一张订单表，需要索引');
  await page.click('#btnSend');
  await page.waitForFunction(() => {
    const s = document.querySelector('#btnStop');
    return !s || s.hidden;
  }, null, { timeout: 60000 });

  const req2 = await (await fetch(MOCK_ROOT + '/_last')).json();
  const sys2 = (req2.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n---\n');
  check('命中触发词自动加载技能', sys2.includes('技能 sql-schema｜'), '建表 + 索引 → sql-schema');
  const foot2 = await page.textContent('.msg.assistant:last-of-type .msg-foot').catch(() => '');
  check('自动加载也会记在消息上', /sql-schema/.test(foot2), foot2.replace(/\s+/g, ' ').trim());

  const chipAfterAuto = await page.$$eval('#skillChips .skill-chip', (els) => els.length);
  check('自动加载只是本次生效，不改用户设置', chipAfterAuto === 0, chipAfterAuto + ' 个胶囊');

  /* ------------------------------------------------------------ @@ref 取附件 */
  await page.fill('#input', '[[ref]] 按细则改');
  await page.click('#btnSend');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .md')].some((m) => m.textContent.includes('细则看过了')),
    null,
    { timeout: 60000 }
  );

  const req3 = await (await fetch(MOCK_ROOT + '/_last')).json();
  const tool3 = (req3.messages || []).filter((m) => m.role === 'user').pop();
  check('程序按 @@ref 读了技能附件', String(tool3 && tool3.content).includes('技能 ext-skill/refs/detail.md'), String(tool3 && tool3.content).slice(0, 40));
  check('回传的是附件真实内容', String(tool3 && tool3.content).includes('verbNoun'), 'refs/detail.md 命中');

  const reads = await page.evaluate(() => window.__READS);
  check('读的是技能目录下的相对路径', reads.includes('ext-skill/refs/detail.md'), reads.join(', '));

  const visible = await page.textContent('#chat');
  check('@@ref 指令不出现在对话里', !visible.includes('@@ref:'), '已剥离');
  check('回传内容不刷屏', !visible.includes('<<<FILE') && !visible.includes('[程序回传]'), '隐藏消息');

  await page.screenshot({ path: path.join(OUT, 'skill-chat.png') });

  /* ------------------------------------------------------------ 上限与持久化 */
  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel');
  for (const id of ['code-style', 'react-ts', 'test-cases', 'code-review']) {
    await page.click(`.skill-item[data-id="${id}"] .switch`);
    await page.waitForTimeout(120);
  }
  const onCount = await page.$$eval('.skill-item.on', (els) => els.length);
  const toastText = (await page.textContent('#toastHost').catch(() => '')) || '';
  check('最多同时启用 3 个', onCount === 3, onCount + ' 个已启用');
  check('超出时给出提示', /最多同时启用/.test(toastText), toastText.replace(/\s+/g, ' ').trim().slice(0, 40));

  await page.click('#btnSkillDone');
  const chips3 = await page.$$eval('#skillChips .skill-chip', (els) => els.length);
  check('输入条同步显示 3 个胶囊', chips3 === 3, chips3 + ' 个');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('zxz.state.v1') || '{}'));
  check('技能选择写进本地设置', saved.settings && (saved.settings.skills || []).length === 3, JSON.stringify((saved.settings || {}).skills));

  const chipsAfterReload = await page.$$eval('#skillChips .skill-chip', (els) => els.length);
  check('刷新后技能仍然启用', chipsAfterReload === 3, chipsAfterReload + ' 个');

  /* ------------------------------------------------------------ 有工程目录时写盘 */
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
    st.settings.workspace = { root: window.__SKILL_ROOT, name: 'skills', tree: '' };
    localStorage.setItem('zxz.state.v1', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });
  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel');
  await page.click('#tabSources');
  await page.waitForSelector('#sourceList');
  // 等工程目录真正恢复（state 从 localStorage 恢复是异步 effect，抢跑会读到空 workspace）
  await page.waitForFunction(() => (document.querySelector('#btnWorkspace')?.textContent || '').includes('skills'), null, {
    timeout: 15000,
  });
  await page.click('#btnExportAudit');
  await page.waitForFunction(() => (document.querySelector('#toastHost')?.textContent || '').includes('审计底稿已写入'), null, {
    timeout: 15000,
  });
  const writes = await page.evaluate(() => window.__WRITES || []);
  const auditWrite = writes.find((w) => /^\.zxz\/audit\/source-audit-.*\.md$/.test(w.rel));
  check('有工程目录时写进 .zxz/audit/', Boolean(auditWrite), writes.map((w) => w.rel).join(', ') || '没有写入');
  check(
    '写进磁盘的是真清单',
    Boolean(auditWrite && auditWrite.content.includes('# 技能来源审计清单') && auditWrite.content.includes('# 技能来源实测审计报告')),
    auditWrite ? auditWrite.content.length + ' 字符' : ''
  );
  await page.click('#btnSkillDone');

  const real = errors.filter((e) => !/favicon|manifest/i.test(e));
  check('无 JS 运行时错误', real.length === 0, real.slice(0, 2).join(' | '));

  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n合计 ${results.length} 项，PASS ${pass}，FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(2);
});
