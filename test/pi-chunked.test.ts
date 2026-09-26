// 分块读的回归测试（src/sources/pi.ts 的 scanLines）。
//
// 锁死三个最容易改坏的点：
//  1. 多字节字符跨 512KB 读取块边界时不能被解码成 U+FFFD；
//  2. 末行没有换行符（pi 正在写入的半行）不计入，补齐后只计一次；
//  3. 增量扫描的结果必须和「对最终文件做一次全量扫描」逐字段相等
//     —— 这条同时验证了 offset 推进的字节口径没错。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READ_CHUNK = 512 * 1024; // 必须与 src/sources/pi.ts 的 READ_CHUNK 一致
const work = mkdtempSync(join(tmpdir(), "pits-chunk-"));
const sessionsDir = join(work, "sessions");
const projDir = join(sessionsDir, "--proj--");
const sessionFile = join(projDir, "2026-08-20T01-00-00Z_chunk-a.jsonl");

process.env.PI_SESSIONS_DIR = sessionsDir;
process.env.OPENCODE_DB = join(work, "nonexistent-opencode.db");
process.env.PI_SCAN_DB = join(work, "store-incremental.db");

const { scan, useStore } = await import("../src/scan.ts");

const HEAD = '{"type":"session","id":"chunk-a","cwd":"/tmp/chunk"}\n';
const USER =
  '{"type":"message","timestamp":"2026-08-20T01:00:00.000Z","message":{"role":"user","content":"chunk boundary"}}\n';
// 多字节模型名放在一行里，前面用一个 pad 字段把它顶到 512KB 边界上
const BIG_PRE =
  '{"type":"message","timestamp":"2026-08-20T01:01:00.000Z","message":{"pad":"';
const BIG_KEY = '","role":"assistant","model":"'; // CJK 之前的部分
const CJK = "模型-中文";
const BIG_TAIL =
  '","provider":"p","usage":{"input":100,"output":10,"totalTokens":110}}}\n';
// 把 CJK 的首字节放到第 READ_CHUNK 个字节前一位，使这个 3 字节字符横跨块边界。
// padLen 必须按「文件里 CJK 之前的全部字节」倒推（HEAD / USER / BIG_PRE / BIG_KEY 都要算）
const cjkFileOffset = READ_CHUNK - 1;
const padLen =
  cjkFileOffset - Buffer.byteLength(HEAD + USER + BIG_PRE + BIG_KEY);
const BIG = `${BIG_PRE}${"x".repeat(padLen)}${BIG_KEY}${CJK}${BIG_TAIL}`;
// 故意不写换行符：这就是 pi 正在写入的「半行」，本轮不该被计入
const HALF =
  '{"type":"message","timestamp":"2026-08-20T01:02:00.000Z","message":{"role":"assistant","model":"tail-model","provider":"p","usage":{"input":999,"output":1,"totalTokens":1000}}';

before(() => {
  mkdirSync(projDir, { recursive: true });
  assert.ok(padLen > 0, "padLen 必须是正数");
  // 文件 = 三行完整事件 + 一行没有换行的半截事件
  const file =
    HEAD +
    USER +
    BIG_PRE +
    "x".repeat(padLen) +
    BIG_KEY +
    CJK +
    BIG_TAIL +
    HALF;
  // 断言构造正确：CJK 首字节确实落在块边界前一位
  assert.equal(
    Buffer.byteLength(HEAD + USER + BIG_PRE + "x".repeat(padLen) + BIG_KEY),
    cjkFileOffset,
    "构造有误：CJK 没有落在预期的字节边界上",
  );
  writeFileSync(sessionFile, file);
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

test("半行不计入；跨块多字节字符完整保留", async () => {
  const r = await scan({});
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.id, "chunk-a");
  assert.equal(s.input, 100, "末行半截不应被计入");
  assert.equal(s.output, 10);
  assert.equal(s.messages, 1);
  // 多字节模型名必须原样保留（若被解码成 U+FFFD，这里会挂）
  assert.deepEqual(Object.keys(s.modelUsage), [CJK]);
  assert.equal(s.modelUsage[CJK].totalTokens, 110);
  assert.equal(s.modelUsage["tail-model"], undefined);
});

test("补齐半行后只计一次，且增量结果 == 全量结果", async () => {
  // 补齐被截断的那一行，并再追加一行
  appendFileSync(
    sessionFile,
    "}\n" +
      '{"type":"message","timestamp":"2026-08-20T01:03:00.000Z","message":{"role":"assistant","model":"last-model","provider":"p","usage":{"input":7,"output":3,"totalTokens":10}}}\n',
  );

  // 增量：沿用上面那个已有游标的库
  const incremental = await scan({});
  assert.equal(incremental.sessions.length, 1);
  const inc = incremental.sessions[0];
  assert.equal(inc.input, 100 + 999 + 7);
  assert.equal(inc.output, 10 + 1 + 3);
  assert.equal(inc.messages, 3);
  assert.equal(
    inc.modelUsage["tail-model"].totalTokens,
    1000,
    "补齐后的行只应计入一次",
  );
  assert.equal(inc.modelUsage["last-model"].totalTokens, 10);
  assert.equal(inc.modelUsage[CJK].totalTokens, 110);

  // 全量：换一个空库重扫同一个文件，结果必须逐字段一致
  useStore(join(work, "store-full.db"));
  const full = await scan({});
  assert.equal(full.sessions.length, 1);
  assert.deepEqual(
    full.sessions[0],
    inc,
    "增量扫描与全量扫描的结果必须完全一致",
  );
});
