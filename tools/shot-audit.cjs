/* 拍一张「实测审计」展开状态的截图，用来人眼确认命中表、证据、可以拿/必须排除的排版。
 *
 *   NODE_PATH=/tmp/zxz-e2e/node_modules node tools/shot-audit.cjs
 */
'use strict';

const path = require('path');
const { launchBrowser } = require('./browser.cjs');

const BASE = process.env.ZXZ_BASE || 'http://localhost:1420';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:19888/v1';
const OUT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots';

const SEED = {
  settings: {
    preset: 'custom', baseUrl: MOCK, apiKey: 'mock-key', model: 'mock-gpt-4o',
    temperature: 0, maxTokens: null, contextTurns: 10, systemPrompt: '', stream: true,
    theme: 'dark', workspace: null, skills: [], skillAuto: true,
  },
  threads: [{ id: 't1', title: '审计', messages: [], createdAt: 1, updatedAt: 1 }],
  activeId: 't1',
};

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
  await page.addInitScript((seed) => {
    if (!localStorage.getItem('zxz.state.v1')) localStorage.setItem('zxz.state.v1', JSON.stringify(seed));
  }, SEED);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew', { timeout: 15000 });
  await page.click('#btnSkills');
  await page.waitForSelector('#skillPanel');
  await page.click('#tabSources');
  await page.waitForSelector('#sourceList');

  // 展开 gstack（不接入）与 addy（预判被下调）两张，正好覆盖两种结论形态
  await page.click('.src-item[data-id="garrytan/gstack"] .src-more summary');
  await page.click('.src-item[data-id="addyosmani/agent-skills"] .src-more summary');
  // 滚到「已落地为内建技能」那一行，否则卡片太长底部拍不到
  await page.evaluate(() => {
    const el = document.querySelector('.src-item[data-id="garrytan/gstack"] .src-applied');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'audit-gstack.png') });

  await page.evaluate(() => {
    const el = document.querySelector('.src-item[data-id="addyosmani/agent-skills"]');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'audit-addy.png') });

  console.log('已保存 audit-gstack.png / audit-addy.png');
  await browser.close();
})().catch((e) => {
  console.error('截图失败：', e);
  process.exit(1);
});
