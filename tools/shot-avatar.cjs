/* 只做截图：验证人像落位（欢迎页 hero + 用户消息头像）
 *
 *   node tools/shot-avatar.cjs
 */
'use strict';

const { launchBrowser } = require('./browser.cjs');

const BASE = process.env.ZXZ_BASE || 'http://localhost:1420';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:19888/v1';
const OUT = process.env.SHOT_DIR || 'F:/zhuomian/zxz/tools/shots';

(async () => {
  const browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnNew');
  await page.screenshot({ path: `${OUT}/avatar-welcome.png` });

  // 配置模拟上游
  await page.click('#modelPill');
  await page.waitForSelector('#drawer:not([hidden])');
  await page.fill('#baseUrl', MOCK);
  await page.fill('#apiKey', 'mock-key');
  await page.fill('#model', 'mock-gpt-4o');
  await page.click('#btnSave');
  await page.waitForSelector('#drawer', { state: 'hidden' });

  // 发一条短消息，让用户消息 + 头像出现
  await page.fill('#input', '帮我看下这个头像放进来的效果');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.user .avatar.user img', { timeout: 15000 });
  await page.waitForTimeout(2500);

  // 滚到顶，让用户消息连同头像一起入镜
  await page.evaluate(() => {
    const el = document.querySelector('#chat');
    if (el) el.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/avatar-chat.png` });

  const box = await page.locator('.msg.user .avatar.user').first().boundingBox();
  const size = await page.evaluate(() => {
    const img = document.querySelector('.msg.user .avatar.user img');
    if (!img) return null;
    const r = img.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), complete: img.complete };
  });
  console.log('user avatar box:', JSON.stringify(box));
  console.log('user avatar img:', JSON.stringify(size));

  await browser.close();
})();
