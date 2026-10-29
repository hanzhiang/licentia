#!/usr/bin/env node
/**
 * 校验 i18n 文案表:
 *   1. 中英两边的 key 完全一致(含嵌套)
 *   2. 所有 t('a.b') 静态 key 在两个语言里都存在
 *   3. t(`a.b.${x}`) 的动态前缀在文案表里存在
 * 用法: node scripts/check-i18n.mjs   (在 web/ 下或任意目录执行均可)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(web, 'src');

const MARK = 'export const messages =';
const src = readFileSync(join(SRC, 'i18n', 'messages.ts'), 'utf8');
if (!src.includes(MARK)) throw new Error('src/i18n/messages.ts 里找不到 messages 定义');
const body = src.slice(src.indexOf(MARK) + MARK.length);
const literal = body.slice(0, body.lastIndexOf('as const;'));
const messages = new Function(`return (${literal});`)();

function flat(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flat(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const zh = flat(messages['zh-CN']);
const en = flat(messages.en);

const errors = [];
const onlyZh = [...zh.keys()].filter((k) => !en.has(k));
const onlyEn = [...en.keys()].filter((k) => !zh.has(k));
for (const k of onlyZh) errors.push(`只有中文: ${k}`);
for (const k of onlyEn) errors.push(`只有英文: ${k}`);

/** 目录遍历 */
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(vue|ts)$/.test(n)) out.push(p);
  }
  return out;
}

const has = (map, dotted) => {
  if (map.has(dotted)) return true;
  // 前缀检查: a.b 存在则 a.b.c 也可能存在, 反之不算命中
  for (const k of map.keys()) if (k.startsWith(`${dotted}.`)) return true;
  return false;
};

const STATIC = /\bt\(\s*(['"])([A-Za-z][\w.]*)\1/g;
const DYNAMIC = /\bt\(\s*`([^`$]*)\$\{/g;
const files = walk(SRC).filter((p) => !relative(SRC, p).replace(/\\/g, '/').startsWith('i18n/'));
const prefixes = new Set();
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const where = relative(web, file);
  for (const m of text.matchAll(STATIC)) {
    const key = m[2];
    checked += 1;
    const line = text.slice(0, m.index).split('\n').length;
    if (!has(zh, key)) errors.push(`${where}:${line} 中文缺 ${key}`);
    if (!has(en, key)) errors.push(`${where}:${line} 英文缺 ${key}`);
  }
  for (const m of text.matchAll(DYNAMIC)) prefixes.add(m[1].replace(/\.$/, ''));
}

for (const p of prefixes) {
  if (!has(zh, p)) errors.push(`动态前缀缺中文: ${p}.*`);
  if (!has(en, p)) errors.push(`动态前缀缺英文: ${p}.*`);
}

console.log(
  `${files.length} 个文件, ${checked} 处静态 key, ${prefixes.size} 个动态前缀, ` +
    `中 ${zh.size} / 英 ${en.size} 条文案`,
);
if (errors.length) {
  for (const e of errors) console.error(' ✗', e);
  console.error(`\n共 ${errors.length} 处问题`);
  process.exit(1);
}
console.log('✓ 通过');
