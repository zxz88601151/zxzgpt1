/* 真机验证「子代理 Explore」：主对话用智谱直连（glm-4.5-flash），触发 explore 工具，
 * 子代理用独立上下文 + 只读工具探索 subagent-probe 工程，返回摘要给主对话。
 *
 * 前置：exe 带 --remote-debugging-port=9223 编译并启动。
 * 用法：node tools/subagent-e2e.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP = process.env.CDP || 'http://127.0.0.1:9223';
const SHOT = 'F:/zhuomian/zxz/tools/shots/subagent';
const WAIT_MODEL_MS = Number(process.env.WAIT_MODEL_MS || 360000);
const PROJECT_NAME = 'subagent-probe';
const PROJECT_ROOT = 'F:\\zhuomian\\' + PROJECT_NAME;

// 智谱 BigModel 直连（国内可达，不走 FreeLLMAPI 中转）
const ZHIPU_KEY = '798b716d46764b1f99b5d77d897061dd.7DHxyoFP14Fr32SR';
const SUB_SETTINGS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: ZHIPU_KEY,
  model: 'glm-4.5-flash',
  subagentModel: 'glm-4.5-flash',
  toolCalls: true,
  autoTest: false,
  planMode: false,
  exploreMode: false,
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => /tauri\.localhost/.test(p.url())) || ctx.pages()[0];
  check('连上桌面窗口', Boolean(page), page ? page.url() : '没有可用页面');
  await page.bringToFront();
  page.on('dialog', (d) => d.accept());
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 180)); });

  // 注入模型配置（智谱直连 + 子代理模型）
  await page.evaluate((s) => {
    const st = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
    st.settings = Object.assign(st.settings || {}, s);
    delete st.settings.workspace; // 工作区稍后用 folderPicker 真实接入
    localStorage.setItem('zxz.state.v1', JSON.stringify(st));
  }, SUB_SETTINGS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnWorkspace', { timeout: 15000 });
  await page.waitForTimeout(600);

  const readState = () =>
    page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('zxz.state.v1') || '{}');
      return { settings: s.settings || {}, conversations: s.conversations || [], activeId: s.activeId || '' };
    });

  const before = await readState();
  check('读到智谱直连配置', before.settings.baseUrl === SUB_SETTINGS.baseUrl && before.settings.apiKey === SUB_SETTINGS.apiKey, `model=${before.settings.model}`);
  check('子代理模型已配置', before.settings.subagentModel === 'glm-4.5-flash', before.settings.subagentModel || '(空)');

  // 用 folderPicker 接入 subagent-probe（生成真实 sessionId + workspace）
  await page.click('#btnWorkspace');
  await page.waitForSelector('#folderPicker .fp-drive', { timeout: 8000 });
  await page.waitForSelector('#folderPicker .fp-drive', { state: 'visible', timeout: 10000 });
  await page.locator('#folderPicker .fp-drive', { hasText: /^F:\\?$/ }).first().click();
  await page.waitForSelector('#fpList .fp-row.dir', { timeout: 8000 });
  for (const seg of ['zhuomian', PROJECT_NAME]) {
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
  check('工程目录已接入 (' + PROJECT_NAME + ')', chip === PROJECT_NAME, chip);

  // 发需求：强制触发 explore
  await page.click('#btnNew');
  await page.waitForTimeout(400);
  const PROMPT = [
    '请调用 explore 工具来探索当前工程的目录结构和主要模块。',
    'explore 工具会派一个只读子代理去读取工程里的文件并返回摘要。',
    '探索完成后，基于子代理返回的摘要告诉我：',
    '1) 工程的入口文件是哪个；2) 用了什么技术栈；3) 有哪些主要模块。',
  ].join('\n');
  const t0 = Date.now();
  await page.fill('#input', PROMPT);
  await page.click('#btnSend');

  // 轮询：等对话稳定且界面空闲
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
      if (stable >= 6000) break;
    } else {
      stable = 0;
    }
    lastKey = key;
    await sleep(1000);
  }
  check('模型走完并收尾', Date.now() - t0 < WAIT_MODEL_MS, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.screenshot({ path: path.join(SHOT, '01-subagent.png') });

  const after = await readState();
  const conv = after.conversations.find((c) => c.id === after.activeId) || { messages: [] };
  const msgs = conv.messages || [];
  const assistant = msgs.filter((m) => m.role === 'assistant' && !m.hidden);
  const calls = assistant.flatMap((m) => m.toolCalls || []);
  const names = calls.map((c) => c.name);
  const replies = assistant.filter((m) => m.content && m.content.trim()).map((m) => m.content.trim());
  const reply = replies.join('\n');
  const lastA = assistant[assistant.length - 1] || {};

  // 诊断：dump 每条 assistant 的长度 + 工具调用名 + 内容前 200 字
  console.log('\n--- 对话诊断（assistant 消息）---');
  assistant.forEach((m, i) => {
    const tc = (m.toolCalls || []).map((c) => c.name).join(',');
    console.log(`#${i} len=${String(m.content || '').length} toolCalls=[${tc}] err=${m.error ? 'Y' : 'N'} :: ${(m.content || '').slice(0, 200).replace(/\n/g, ' ')}`);
  });

  check('主对话发起了 explore 工具调用', names.includes('explore'), `toolCalls: ${names.join(', ') || '无'}`);

  // 子代理的探索过程（读文件内容）不应污染主对话 assistant 消息
  const allContent = msgs.map((m) => String(m.content || '')).join('\n');
  check(
    '子代理读的文件内容未污染主对话（主对话不含工程源码全文）',
    !/createRoot\(document\.getElementById/.test(allContent),
    allContent.length > 0 ? '已隔离' : '主对话空'
  );

  // 最终回复应基于探索结果提到工程真实特征（拼接所有非空 assistant 消息）
  const evidence = ['main.ts', 'App.tsx', 'React', 'Vite', 'TypeScript', 'util.ts', 'package.json', '入口', '技术栈']
    .filter((k) => reply.includes(k));
  check('最终回复包含探索到的真实信息（文件名/技术栈）', evidence.length >= 2, `命中: ${evidence.join(', ') || '无'}`);
  check('最后一轮无报错', !lastA.error, lastA.error ? String(lastA.error).slice(0, 120) : `${reply.length} 字`);
  check('真实计费（有 token 用量）', Boolean(lastA.usage && lastA.usage.total_tokens), JSON.stringify(lastA.usage || {}));
  check('界面无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '干净');

  console.log('\n--- 最终回复片段 ---');
  console.log(reply.slice(0, 600));

  const pass = results.filter((r) => r.ok).length;
  fs.writeFileSync(path.join(SHOT, 'result.json'), JSON.stringify({ pass, total: results.length, toolNames: names, results }, null, 2));
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
