/* 技能匹配的共用实现：直接照抄 src/lib/skill.ts 的口径，供测试脚本算「期望值」。
 *
 * 为什么单独拆出来：E2E 里断言「界面到底自动加载了谁」时，如果写死技能名，
 * 改一次触发词或调一次 index.ts 的 import 顺序就会假红。正确做法是从真实源码
 * 重建目录 + 用同一套打分规则重算，再去核对界面。
 * 这份逻辑一旦有两份副本就会漂移，所以只留这一处，脚本都 require 它。
 *
 * 对应源码：src/lib/skill.ts 的 escapeRe / hits / matchSkills / MAX_AUTO_MATCH
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BUILTIN_DIR = path.join(ROOT, 'src', 'skills', 'builtin');
const INDEX_TS = path.join(ROOT, 'src', 'skills', 'index.ts');

// 与 src/lib/skill.ts 保持一致
const MAX_ACTIVE_SKILLS = 3;
const MAX_AUTO_MATCH = 2;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 与 hits() 同构：中文子串匹配，英文/符号按词边界 */
function hits(hay, needle) {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  if (/[^\x00-\x7f]/.test(n)) return hay.includes(n);
  const re = new RegExp(`(^|[^a-z0-9_])${escapeRe(n)}([^a-z0-9_]|$)`);
  return re.test(hay);
}

/** 从 index.ts 的 import 顺序 + builtin/*.md 的 frontmatter 重建目录 */
function loadCatalog() {
  const order = fs
    .readFileSync(INDEX_TS, 'utf8')
    .split('\n')
    .map((line) => /\/builtin\/([a-z0-9-]+)\.md\?raw/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);

  const seen = new Set();
  return order
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .map((id) => {
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

/** 与 matchSkills() 同构：命中数降序 → 声明顺序 → 截断到 limit */
function autoMatched(catalog, text, active = [], limit = MAX_AUTO_MATCH) {
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return [];
  const picked = [];
  catalog.forEach((s, at) => {
    if (active.includes(s.id)) return;
    let score = 0;
    for (const t of s.triggers) if (hits(hay, t)) score += 1;
    if (score === 0 && hits(hay, s.id)) score += 1;
    if (score > 0) picked.push({ s, score, at });
  });
  return picked.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, Math.max(0, limit));
}

module.exports = {
  MAX_ACTIVE_SKILLS,
  MAX_AUTO_MATCH,
  escapeRe,
  hits,
  loadCatalog,
  autoMatched,
  BUILTIN_DIR,
  INDEX_TS,
};
