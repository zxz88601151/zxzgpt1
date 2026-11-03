/* 浏览器启动：不再把 `channel: 'msedge'` 写死在每个脚本里。
 *
 * 为什么值得单开一个文件：
 *   写死 msedge 的失败方式很坑——playwright 在 launch 阶段直接抛
 *   "Chromium distribution 'msedge' is not found"，而这个错跟用例内容毫无关系，
 *   看出来像"e2e 挂了"，实际是"这台机器没装 Edge"。CI 上尤其容易踩。
 *
 * 顺序：ZXZ_BROWSER_CHANNEL 指定 → msedge（本机最快，已有）→ chrome →
 *       不带 channel（用 playwright 自带的 Chromium）。
 * 前一个起不来就试下一个，全都不行才报错，且报错里带上每一次的真实原因。
 *
 * 用法：await launchBrowser({ headless: true })
 */
'use strict';

const { chromium } = require('playwright');

/** 传给 launch 的 channel；空串/null 表示不指定 channel */
function candidates() {
  const forced = (process.env.ZXZ_BROWSER_CHANNEL || '').trim();
  // 支持逗号列表（"nope,msedge"）。不只是方便：它是"回落逻辑真的生效"
  // 唯一能在装了 Edge 的机器上验证的入口。
  if (forced) return forced.split(',').map((s) => s.trim());
  return ['msedge', 'chrome', ''];
}

async function launchBrowser(opts = {}) {
  const tried = [];
  for (const ch of candidates()) {
    try {
      const browser = ch ? await chromium.launch({ ...opts, channel: ch }) : await chromium.launch({ ...opts });
      if (ch) console.log(`[browser] 用 ${ch} 启动`);
      return browser;
    } catch (e) {
      tried.push(`${ch || 'playwright 自带 chromium'}：${String(e.message || e).split('\n')[0]}`);
    }
  }
  throw new Error(
    '没有可用的浏览器。试过：\n  ' +
      tried.join('\n  ') +
      '\n可以装 Edge/Chrome，或执行 `npx playwright install chromium`，' +
      '或用 ZXZ_BROWSER_CHANNEL 指定一个已装好的 channel。'
  );
}

module.exports = { launchBrowser };
