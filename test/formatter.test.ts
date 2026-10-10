// c_formatter_42: norminette の前に走らせる整形。本物の c_formatter_42 と norminette が PATH にあれば実行する。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runPipeline } from '../src/core/pipeline';
import { isSanitizerStartupCrash } from '../src/core/steps';
import { DEFAULT_CHECKS, STEP_IDS } from '../src/core/types';
import { sampleContext } from './helpers';

const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const sample = (name: string) => path.join(__dirname, '..', 'samples', name);
const normErrors = (r: Awaited<ReturnType<typeof runPipeline>>) => r.results.find((x) => x.id === 'norminette')!.diags;

/** norm-ng の長すぎる文字列リテラルを短くする (c_formatter_42 が壊さない形にする) */
function shortenLiteral(dir: string): void {
  const f = path.join(dir, 'main.c');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('is the length of the string that was given on the command line', 'len'));
}

test('c_formatter_42 は既定 OFF (ソースを書き換えるため)、段階 1 の先頭 = norminette の前に置かれる', () => {
  assert.equal(DEFAULT_CHECKS.cFormatter, false);
  const stage1 = STEP_IDS.slice(0, STEP_IDS.indexOf('norminette') + 1);
  assert.deepEqual(stage1, ['cFormatter', 'norminette']);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: Record<string, boolean> }> } };
  };
  assert.equal(pkg.contributes.configuration.properties['c42check.checks'].default.cFormatter, false);
});

test('チェックされていなければ、ファイルは 1 バイトも書き換えない', async () => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng');
  const before = read(dir, 'main.c');
  await runPipeline(ctx, { selected: ['norminette'] });
  assert.equal(read(dir, 'main.c'), before);
  cleanup();
});

test('norminette の前に実行され、norm 違反が減る (42 ヘッダは付かない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng');
  if (!ctx.tools.cFormatter || !ctx.tools.norminette) return t.skip('c_formatter_42 / norminette が無い');
  shortenLiteral(dir);
  const plain = sampleContext('norm-ng');
  shortenLiteral(plain.dir);
  const without = await runPipeline(plain.ctx, { selected: ['norminette'] });
  plain.cleanup();

  const order: string[] = [];
  const r = await runPipeline(ctx, { selected: ['norminette', 'cFormatter'] }, { onStepStart: (id) => order.push(id) });
  assert.deepEqual(order.filter((x) => x !== 'prepare'), ['cFormatter', 'norminette'], '選択順ではなく、norminette の前');
  const fmt = r.results.find((x) => x.id === 'cFormatter')!;
  assert.equal(fmt.status, 'pass', fmt.log);
  assert.match(fmt.log, /整形で変更したファイル \d+ 件/);
  assert.match(fmt.log, /^ {2}main\.c$/m);

  const after = normErrors(r).map((d) => d.message.split(':')[0]);
  assert.ok(after.length < normErrors(without).length, `整形前 ${normErrors(without).length} 件 → 整形後 ${after.length} 件`);
  assert.ok(!after.includes('SPACE_BEFORE_FUNC') && !after.includes('BRACE_NEWLINE') && !after.includes('SPACE_REPLACE_TAB'));
  assert.ok(after.includes('INVALID_HEADER'), '42 ヘッダは c_formatter_42 では付かない');
  assert.deepEqual([...new Set(after)].sort(), ['INVALID_HEADER'], '短い文字列なら、header 以外の norm 違反はすべて直る');
  assert.match(read(dir, 'main.c'), /^int\tmain\(int argc, char \*\*argv\)$/m, '実際にファイルが書き換わっている');
  cleanup();
});

test('整形前の内容を .42check/format-backup/ に退避する', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng');
  if (!ctx.tools.cFormatter) return t.skip('c_formatter_42 が無い');
  shortenLiteral(dir);
  const original = read(dir, 'main.c');
  await runPipeline(ctx, { selected: ['cFormatter'] });
  assert.equal(read(dir, '.42check/format-backup/main.c'), original, '退避は整形前の内容');
  assert.notEqual(read(dir, 'main.c'), original);
  cleanup();
});

test('冪等: 2 回目は変更なし、退避も作られない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng');
  if (!ctx.tools.cFormatter) return t.skip('c_formatter_42 が無い');
  shortenLiteral(dir);
  await runPipeline(ctx, { selected: ['cFormatter'] });
  const once = read(dir, 'main.c');
  const r = await runPipeline(ctx, { selected: ['cFormatter'] }); // 段階 0 で .42check/ は作り直される
  const fmt = r.results.find((x) => x.id === 'cFormatter')!;
  assert.match(fmt.log, /整形による変更はありません/);
  assert.equal(read(dir, 'main.c'), once);
  assert.equal(fs.existsSync(path.join(dir, '.42check', 'format-backup')), false);
  cleanup();
});

test('norm 準拠のサンプルは、#include の並び替えが入っても、norminette と警告強化ビルドを通る', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!ctx.tools.cFormatter || !ctx.tools.norminette || !ctx.tools.cc) return t.skip('c_formatter_42 / norminette / clang が無い');
  const r = await runPipeline(ctx, { selected: ['cFormatter', 'norminette', 'warnings'] });
  const summary = r.results.map((x) => `${x.id}=${x.status}`).join(', ');
  assert.equal(r.ok, true, summary);
  // c_formatter_42 は "..." の include を <...> より前に並べ替える
  assert.match(read(dir, 'main.c'), /#include "str_utils\.h"\n#include <stdio\.h>/);
  cleanup();
});

test('整形でコンパイルが通らなくなったら、変更したファイルを元に戻して fail (include の順序に依存したコード)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!ctx.tools.cFormatter || !ctx.tools.cc) return t.skip('c_formatter_42 / clang が無い');
  // str_utils.h は size_t を使うのに <stddef.h> を自分では include していない (先に include される前提のコード)
  fs.writeFileSync(path.join(dir, 'str_utils.h'), read(dir, 'str_utils.h').replace('# include <stddef.h>\n', ''));
  fs.writeFileSync(path.join(dir, 'main.c'), read(dir, 'main.c').replace('#include <stdio.h>', '#include <stddef.h>\n#include <stdio.h>'));
  const snapshot = ['main.c', 'str_utils.c', 'str_utils.h'].map((f) => read(dir, f));
  const r = await runPipeline(ctx, { selected: ['cFormatter', 'norminette'] });
  const fmt = r.results.find((x) => x.id === 'cFormatter')!;
  assert.equal(fmt.status, 'fail');
  assert.match(fmt.reason ?? '', /壊れたため、元に戻しました/);
  assert.match(fmt.hint ?? '', /文字列リテラル/);
  assert.ok(fmt.diags.length > 0, '壊れた箇所の診断が Problems 用に取れている');
  assert.deepEqual(['main.c', 'str_utils.c', 'str_utils.h'].map((f) => read(dir, f)), snapshot, '全ファイルが 1 バイトも変わっていない');
  assert.equal(fs.existsSync(path.join(dir, '.42check', 'format-backup')), false, '戻したので退避も残さない');
  assert.ok(r.results.some((x) => x.id === 'norminette'), '同じ段階の norminette は実行される (failFast: stage)');
  cleanup();
});

test('80 桁を超える文字列リテラルは c_formatter_42 が壊す: 検出して元に戻し、fail にする', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng'); // main.c に長い文字列リテラルがある
  if (!ctx.tools.cFormatter || !ctx.tools.cc) return t.skip('c_formatter_42 / clang が無い');
  const before = ['main.c', 'str_utils.c', 'str_utils.h'].map((f) => read(dir, f));
  const r = await runPipeline(ctx, { selected: ['cFormatter', 'warnings'] });
  const fmt = r.results.find((x) => x.id === 'cFormatter')!;
  assert.equal(fmt.status, 'fail', fmt.log);
  assert.match(fmt.reason ?? '', /main\.c/);
  assert.deepEqual(['main.c', 'str_utils.c', 'str_utils.h'].map((f) => read(dir, f)), before, '壊れたまま残らない');
  assert.equal(status(r, 'warnings'), 'pass', '元のコードはコンパイルできるので、同じ段階の警告強化ビルドは通る');
  assert.equal(r.stoppedAt?.id, 'cFormatter');
  cleanup();
});

test('ワークスペース直下の .clang-format には触れない (c_formatter_42 は cwd の .clang-format を差し替えるため)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng');
  if (!ctx.tools.cFormatter) return t.skip('c_formatter_42 が無い');
  shortenLiteral(dir);
  const mine = 'BasedOnStyle: LLVM\n# 自分の設定\n';
  fs.writeFileSync(path.join(dir, '.clang-format'), mine);
  const r = await runPipeline(ctx, { selected: ['cFormatter'] });
  assert.equal(status(r, 'cFormatter'), 'pass', r.results[1]?.log);
  assert.equal(fs.lstatSync(path.join(dir, '.clang-format')).isSymbolicLink(), false, 'シンボリックリンクに差し替わっていない');
  assert.equal(read(dir, '.clang-format'), mine);
  assert.match(read(dir, 'main.c'), /^int\tmain\(/m, '整形自体は norm 用の設定で行われている (自分の LLVM 設定ではない)');
  assert.equal(fs.existsSync(path.join(dir, '.42check', 'format-cwd')), false, '一時ディレクトリは後始末される');
  cleanup();
});

test('エディタに未保存の変更があるファイルがあれば、何も書き換えず skip する', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng');
  if (!ctx.tools.cFormatter) return t.skip('c_formatter_42 が無い');
  ctx.isFileDirty = (p) => p === path.join(dir, 'main.c');
  const before = read(dir, 'main.c');
  const r = await runPipeline(ctx, { selected: ['cFormatter'] });
  const fmt = r.results.find((x) => x.id === 'cFormatter')!;
  assert.equal(fmt.status, 'skip');
  assert.match(fmt.reason ?? '', /未保存/);
  assert.equal(r.ok, true, 'skip は失敗ではない');
  assert.equal(read(dir, 'main.c'), before);
  assert.equal(read(dir, 'str_utils.c'), fs.readFileSync(path.join(sample('norm-ng'), 'str_utils.c'), 'utf8'), '他のファイルも触らない');
  cleanup();
});

test('c_formatter_42 が無ければ skip + 理由 + 対処案 (失敗にしない)', async () => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng');
  ctx.tools = { ...ctx.tools, cFormatter: undefined };
  const before = read(dir, 'main.c');
  const r = await runPipeline(ctx, { selected: ['cFormatter'] });
  const fmt = r.results.find((x) => x.id === 'cFormatter')!;
  assert.equal(fmt.status, 'skip');
  assert.match(fmt.reason ?? '', /c_formatter_42 が見つかりません/);
  assert.match(fmt.hint ?? '', /pipx install c-formatter-42/);
  assert.equal(r.ok, true);
  assert.equal(read(dir, 'main.c'), before);
  cleanup();
});

test('mainFile (テスト用の main) は整形の対象にしない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('lib-ok', { mainFile: 'tests/test_main.c' });
  if (!ctx.tools.cFormatter) return t.skip('c_formatter_42 が無い');
  const before = read(dir, 'tests/test_main.c');
  await runPipeline(ctx, { selected: ['cFormatter'] });
  assert.equal(read(dir, 'tests/test_main.c'), before);
  cleanup();
});

test('プロトタイプ同期のブロックと干渉しない: 同期 → 整形 → 同期で、ブロックは変わらない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { protoSyncOnRun: true });
  if (!ctx.tools.cFormatter) return t.skip('c_formatter_42 が無い');
  const r1 = await runPipeline(ctx, { selected: ['cFormatter'] });
  if (/\[skip\]/.test(r1.results[0].log)) return t.skip('ctags が無い');
  const h1 = read(dir, 'includes/proj.h');
  const r2 = await runPipeline(ctx, { selected: ['cFormatter'] });
  assert.match(r2.results[0].log, /プロトタイプ同期: \[unchanged\]/, '整形の後でも、同期は変更なし');
  assert.equal(read(dir, 'includes/proj.h'), h1);
  cleanup();
});

/* ───────── MSan / TSan が起動時に落ちる環境 (実機の報告) ───────── */

test('起動時の SEGV: 報告が無い / sanitizer のランタイム内で落ちた → 環境の問題 (skip)', () => {
  assert.equal(isSanitizerStartupCrash('', 'SIGSEGV', false), true, '何も出さずに SEGV');
  assert.equal(isSanitizerStartupCrash('==1==ERROR: MemorySanitizer: SEGV on unknown address\n    #0 0x1 in __msan_init (/p+0x1)', null, false), true, 'ランタイム内');
  assert.equal(isSanitizerStartupCrash('MemorySanitizer:DEADLYSIGNAL\n    #0 0x1 in msan::InitShadow ()', 'SIGSEGV', false), true);
});

test('ユーザーのコードが落ちたときは、環境の問題にしない (fail のまま)', () => {
  assert.equal(isSanitizerStartupCrash('MemorySanitizer:DEADLYSIGNAL\n    #0 0x1 in main /w/main.c:5:3', 'SIGSEGV', true), false, 'スタックにプロジェクトのフレームがある');
  assert.equal(isSanitizerStartupCrash('MemorySanitizer:DEADLYSIGNAL\n    #0 0x1 in strlen\n    #1 0x2 in foo', 'SIGSEGV', false), false, 'ランタイム外 (libc など) で落ちた');
  assert.equal(isSanitizerStartupCrash('', 'SIGABRT', false), false, 'abort() などの SEGV 以外');
  assert.equal(isSanitizerStartupCrash('hello\n', null, false), false, '正常終了');
});

const status = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id)?.status;
