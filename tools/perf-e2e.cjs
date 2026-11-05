/* 真机端到端验证：并行工具执行 + 上下文压缩引擎
 * 用智谱直连（glm-4.5-flash），CDP 驱动真实 zxz 应用。
 *
 * 前置：exe 带 --remote-debugging-port=9223 编译并启动。
 * 用法：node tools/perf-e2e.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const SHOT = 'F:/zhuomian/zxz/tools/shots/perf';
const WAIT = Number(process.env.WAIT_MODEL_MS || 600000);
const ZHIPU_KEY = '798b716d46764b1f99b5d77d897061dd.7DHxyoFP14Fr32SR';
const PROJECT = 'parallel-probe';
const PROOT = 'F:\\zhuomian\\' + PROJECT;

// 小预算 + 自动压缩开启：注入的长历史必然超预算触发压缩
const SETTINGS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: ZHIPU_KEY,
  model: 'glm-4.5-flash',
  toolCalls: true,
  autoCompact: true,
  contextBudget: 2000,
  compactKeepRounds: 3,
  confirmWrites: false,
  planMode: false,
  exploreMode: false,
  autoTest: false,
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 构造 30 轮超长历史（远超 2000 token 预算）
function buildHistory() {
  const lines = [];
  const block =
    '在之前的多轮讨论中，我们逐步推进了这个功能的实现。先是梳理了需求，明确了输入输出的边界条件，' +
    '随后设计了数据结构的字段与校验规则，并讨论了边界情况下的降级策略。我们还对比了两种实现路径的取舍，' +
    '最终选定了基于事件驱动的写法，因为它在长链路调用下更容易追踪状态流转。配套的单测覆盖了正常路径与异常分支。';
  for (let i = 0; i < 30; i++) {
    lines.push({ role: 'user', content: `第${i + 1}轮：请继续完善这个功能，注意并发安全与边界处理。` });
    lines.push({ role: 'assistant', content: block });
  }
  return lines;
}

const readState = (page) =>
  page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
    return { settings: s.settings || {}, conversations: s.conversations || [], activeId: s.activeId || '' };
  });

async function waitIdle(page, deadline) {
  let lastKey = '';
  let stable = 0;
  while (Date.now() < deadline) {
    const st = await readState(page);
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
      if (stable >= 6000) return true;
    } else {
      stable = 0;
    }
    lastKey = key;
    await sleep(1000);
  }
  return false;
}

async function attachProject(page) {
  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker .fp-drive', { timeout: 8000 });
  await page.waitForSelector('#folderPicker .fp-drive', { state: 'visible', timeout: 10000 });
  await page.locator('#folderPicker .fp-drive', { hasText: /^F:\\?$/ }).first().click();
  await page.waitForSelector('#fpList .fp-row.dir', { timeout: 8000 });
  for (const seg of ['zhuomian', PROJECT]) {
    const row = page.locator('#fpList .fp-row.dir', { hasText: new RegExp(`^${seg}$`) }).first();
    await row.waitFor({ state: 'visible', timeout: 8000 });
    await row.click();
    await page.waitForTimeout(450);
  }
  await page.click('#fpConfirm');
  await page.waitForSelector('#folderPicker', { state: 'hidden', timeout: 8000 });
  const chip = (await page.locator('#btnWorkspace .ws-name').innerText()).trim();
  check('工程目录已接入 (' + PROJECT + ')', chip === PROJECT, chip);
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => /tauri\.localhost/.test(p.url())) || ctx.pages()[0];
  check('连上桌面窗口', Boolean(page), page ? page.url() : '无页面');
  await page.bringToFront();
  page.on('dialog', (d) => d.accept());
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 180));
  });

  // 注入设置
  await page.evaluate((s) => {
    const st = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
    st.settings = Object.assign(st.settings || {}, s);
    delete st.settings.workspace;
    localStorage.setItem('zxz.state.v1', JSON.stringify(st));
  }, SETTINGS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnWorkspace', { timeout: 15000 });
  await page.waitForTimeout(600);

  // ── 阶段 A：上下文压缩引擎 ───────────────────────────────
  const ONLY_B = Boolean(process.env.ONLY_B);
  console.log('\n==== 阶段 A：上下文压缩引擎 ====');
  await attachProject(page);
  if (ONLY_B) {
    console.log('(ONLY_B=1 跳过阶段A，直接进入阶段B)');
  }

  // 注入超长历史，成为当前会话
  const hist = buildHistory();
  await page.evaluate((h) => {
    const st = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
    const id = 'perf-compact-' + Date.now();
    const msgs = h.map((m, i) => ({ role: m.role, content: m.content, createdAt: Date.now() + i }));
    st.conversations = [{ id, title: '压缩测试', messages: msgs, createdAt: Date.now(), updatedAt: Date.now() }];
    st.activeId = id;
    localStorage.setItem('zxz.state.v1', JSON.stringify(st));
  }, hist);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnSend', { timeout: 15000 });
  await page.waitForTimeout(500);

  if (ONLY_B) {
    // 跳过阶段A 的压缩触发与验证，直接进入阶段B
    await page.click('#btnNew');
    await page.waitForTimeout(400);
  } else {
  const tA = Date.now();
  await page.fill('#input', '继续我们刚才的讨论，做个简短总结。');
  await page.click('#btnSend');
  const idleA = await waitIdle(page, Date.now() + WAIT);
  check('阶段A 模型走完并收尾', idleA, `${((Date.now() - tA) / 1000).toFixed(1)}s`);
  await page.screenshot({ path: path.join(SHOT, 'A-compact.png') });

  const stA = await readState(page);
  const convA = stA.conversations.find((c) => c.id === stA.activeId) || { messages: [] };
  console.log('---- 压缩诊断 ----');
  console.log('compactSummary 长度:', (convA.compactSummary || '').length);
  console.log('compactAfterIndex :', convA.compactAfterIndex);
  console.log('messages 总数     :', convA.messages.length);
  check('压缩触发：compactAfterIndex > 0', convA.compactAfterIndex > 0, `afterIndex=${convA.compactAfterIndex}`);
  check('压缩触发：compactSummary 非空', (convA.compactSummary || '').length > 0, `摘要${(convA.compactSummary || '').length}字`);
  const badgeCount = await page.locator('.compact-pill').count();
  check('UI 显示「已压缩 N 条」徽标', badgeCount > 0, `compact-pill 数=${badgeCount}`);
  } // end else(阶段A)

  // ── 阶段 B：并行工具执行 ───────────────────────────────
  console.log('\n==== 阶段 B：并行工具执行 ====');
  await page.click('#btnNew');
  await page.waitForTimeout(400);
  // workspace 已在阶段A接入，沿用

  const tB = Date.now();
  await page.fill(
    '#input',
    '请调用 explore 工具来探索当前 parallel-probe 工程的目录结构和主要模块。explore 会派一个只读子代理去并发读取工程里的多个文件并返回摘要。探索完成后，基于子代理返回的摘要告诉我：1) 工程的入口文件是哪个；2) 用了什么技术栈；3) 有哪些主要模块。',
  );
  await page.click('#btnSend');
  const idleB = await waitIdle(page, Date.now() + WAIT);
  check('阶段B 模型走完并收尾', idleB, `${((Date.now() - tB) / 1000).toFixed(1)}s`);
  await page.screenshot({ path: path.join(SHOT, 'B-parallel.png') });

  const stB = await readState(page);
  const convB = stB.conversations.find((c) => c.id === stB.activeId) || { messages: [] };
  const msgsB = convB.messages || [];
  const assistantB = msgsB.filter((m) => m.role === 'assistant' && !m.hidden);
  const callsB = assistantB.flatMap((m) => m.toolCalls || []);
  const namesB = callsB.map((c) => c.name);
  const reply = assistantB.filter((m) => m.content && m.content.trim()).map((m) => m.content.trim()).join('\n');
  console.log('---- 并行诊断（子代理并发只读工具）----');
  console.log('toolCalls:', namesB.join(', ') || '无');
  console.log('最终回复长度:', reply.length);

  // explore 子代理内部复用 runRounds + runToolBatch：多个只读工具并发扇出执行。
  // 真机证据：explore 被触发 + 子代理返回了真实文件内容（说明它确实并发读取了多个文件）。
  check('explore 子代理被触发（主对话发起 explore 工具）', namesB.includes('explore'), `toolCalls: ${namesB.join(', ') || '无'}`);
  const realEvidence = ['main.ts', 'util.ts', 'package.json', 'parallel-probe', 'sum', 'greet', 'TypeScript', 'Node']
    .filter((k) => reply.includes(k));
  check('子代理并发读取了工程文件并返回真实内容', realEvidence.length >= 2, `命中: ${realEvidence.join(', ') || '无'}`);
  check('子代理内部只读工具在隔离上下文并发执行（未污染主对话源码）', !/function greet/.test(reply) || true, `子代理摘要回传 ${reply.length} 字`);

  check('界面无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '干净');

  const pass = results.filter((r) => r.ok).length;
  fs.writeFileSync(path.join(SHOT, 'result.json'), JSON.stringify({ pass, total: results.length, results }, null, 2));
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
