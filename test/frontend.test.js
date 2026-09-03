// 前端 JS 守门测试：语法检查 + 模块可加载性 + 纯函数回归。
// 背景：前端零构建，浏览器加载 .js 才会暴露语法错误；这里用 node --check + 动态 import 提前拦住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const JS_DIR = fileURLToPath(new URL('../public/js/', import.meta.url));
const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));

test('public/js 所有文件语法合法（node --check）', () => {
  assert.ok(files.length >= 8, `应至少有 8 个 js 文件，实际 ${files.length}`);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', join(JS_DIR, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f} 语法错误:\n${r.stderr}`);
  }
});

// app.js 顶层就执行 load()/bind()（依赖 document），只对其余模块做真实 import
const IMPORTABLE = files.filter((f) => f !== 'app.js');

for (const f of IMPORTABLE) {
  test(`模块可加载：${f}`, async () => {
    const mod = await import(`${JS_DIR}${f}?t=${Date.now()}-${f}`); // 绕过 ESM 缓存
    assert.ok(mod && typeof mod === 'object');
  });
}

test('fmt：中文单位（万/亿）与边界', async () => {
  const { fmt } = await import(`${JS_DIR}format.js`);
  assert.equal(fmt(0), '0');
  assert.equal(fmt(9999), '9999');
  assert.equal(fmt(12345), '1.2万');
  assert.equal(fmt(35000000), '3500万');
  assert.equal(fmt(99990000), '9999万');
  assert.equal(fmt(1e8), '1亿'); // 尾零去掉
  assert.equal(fmt(1.4e8), '1.4亿');
  assert.equal(fmt(1.4e9), '14亿');
});

test('esc / money 基本行为', async () => {
  const { esc, money } = await import(`${JS_DIR}format.js`);
  assert.equal(esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.equal(money(3.14159), '¥3.14');
  assert.equal(money(7.2, '$', 7.2), '$1.00');
});
