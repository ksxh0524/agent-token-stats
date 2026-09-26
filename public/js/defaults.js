// 单价工具。历史上这个文件里还有一份硬编码的 DEFAULTS「官方默认价」（8 个模型、其中 3 个是 0），
// 是 models.dev 同步还没做通年代（prices-sync 读错字段，见 AGENTS.md）的兜底；
// 它按覆盖语义写入，会把用户手填的价冲掉，2026-09-12 连按钮一起删除。
// 现在价格的唯一来源：同步（pi 配置优先 → models.dev 目录）＋ 界面手填。
export function zeroPrice() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
