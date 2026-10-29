// 実際のツール (norminette / clang / clang-tidy / scan-build / gcc / valgrind) を使う結合テスト。
// 無いツールは pipeline 側で skip になるので、ここでは「あるツールの結果」だけを検証する。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { createContext } from '../src/core/context';
import { runPipeline } from '../src/core/pipeline';
import { DEFAULT_CHECKS, STEP_IDS, type Context, type StepId, type Tools } from '../src/core/types';
import { sampleContext } from './helpers';

// 既定で ON の項目 (c_formatter_42 / TSan / MSan / CBMC / Frama-C は既定 OFF)
const DEFAULT_ON = STEP_IDS.filter((id) => DEFAULT_CHECKS[id]) as StepId[];

const status = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id)?.status;
const need = (ctx: Context, key: keyof Tools) => ctx.tools[key] !== undefined;

test('正常なサンプル: 段階 0〜2 がすべて通る (skip は許容するが fail はない)', async () => {
  const { ctx, cleanup } = sampleContext('ok');
  const r = await runPipeline(ctx, { selected: DEFAULT_ON, debugBuild: true });
  const summary = r.results.map((x) => `${x.id}=${x.status}${x.reason ? `(${x.reason})` : ''}`).join(', ');
  assert.equal(r.ok, true, summary);
  assert.equal(status(r, 'debug-build'), 'pass', 'デバッグ用ビルドまで到達する');
  if (need(ctx, 'cc')) {
    assert.equal(status(r, 'asanUbsan'), 'pass');
    assert.equal(status(r, 'warnings'), 'pass');
  }
  if (need(ctx, 'valgrind')) assert.equal(status(r, 'valgrind'), 'pass');
  cleanup();
});

test('norminette に落ちるサンプル: 段階 2 とデバッグ用ビルドは実行されない', async (t) => {
  const { ctx, cleanup } = sampleContext('norm-ng');
  if (!need(ctx, 'norminette')) return t.skip('norminette が無い');
  const r = await runPipeline(ctx, { selected: DEFAULT_ON, debugBuild: true });
  assert.equal(r.ok, false);
  assert.equal(r.stoppedAt?.id, 'norminette');
  assert.ok(r.results.every((x) => x.stage <= 1), '段階 2 以降の結果が無い');
  assert.deepEqual(r.notRun.filter((n) => n.id === 'asanUbsan' || n.id === 'valgrind').length, 2);
  assert.equal(r.results.find((x) => x.id === 'debug-build'), undefined);
  const norm = r.results.find((x) => x.id === 'norminette')!;
  assert.ok(norm.diags.length >= 3, 'norminette の診断が Problems 用に取れている');
  assert.ok(norm.diags.every((d) => path.basename(d.file) === 'main.c' && d.line > 0));
  cleanup();
});

test('同じ段階の全項目を実行してから止める (norm-ng でも警告強化ビルド等は走る)', async (t) => {
  const { ctx, cleanup } = sampleContext('norm-ng');
  if (!need(ctx, 'norminette') || !need(ctx, 'cc')) return t.skip('norminette / clang が無い');
  const r = await runPipeline(ctx, { selected: DEFAULT_ON });
  assert.equal(status(r, 'warnings'), 'pass');
  cleanup();
});

test('実行時バグ (heap-buffer-overflow): 段階 1 は通り、段階 2 の ASan と valgrind が fail して診断が付く', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-asan');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: DEFAULT_ON });
  const summary = r.results.map((x) => `${x.id}=${x.status}`).join(', ');
  assert.equal(r.stoppedAt?.stage, 2, `段階 1 は通る想定: ${summary}`);
  const asan = r.results.find((x) => x.id === 'asanUbsan')!;
  assert.equal(asan.status, 'fail');
  const bugLine = fs.readFileSync(path.join(ctx.root, 'main.c'), 'utf8').split('\n').findIndex((l) => l.includes('buf[argc + 3]')) + 1;
  assert.ok(bugLine > 0);
  assert.ok(asan.diags.some((d) => d.file.endsWith('main.c') && d.line === bugLine), `main.c:${bugLine} に診断`);
  if (need(ctx, 'valgrind')) assert.equal(status(r, 'valgrind'), 'fail', '同じ段階の valgrind も実行される');
  cleanup();
});

test('メモリリーク + fd リーク: いずれかの段階で fail し、リーク箇所に診断が付く', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-leak');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: DEFAULT_ON });
  assert.equal(r.ok, false);
  const diags = r.results.flatMap((x) => x.diags).filter((d) => d.file.endsWith('main.c'));
  assert.ok(diags.length > 0);
  cleanup();
});

test('valgrind 単独: メモリリークと閉じていない fd を検出する', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-leak');
  if (!need(ctx, 'valgrind') || !need(ctx, 'cc')) return t.skip('valgrind / clang が無い');
  const r = await runPipeline(ctx, { selected: ['valgrind'] });
  const v = r.results.find((x) => x.id === 'valgrind')!;
  assert.equal(v.status, 'fail', v.log);
  assert.ok(v.diags.some((d) => /Open file descriptor/.test(d.message)), 'fd リーク');
  assert.ok(v.diags.some((d) => /lost/.test(d.message)), 'リーク');
  cleanup();
});

test('ライブラリ課題: main が無く mainFile も未指定なら動的チェックは skip (理由と対処案つき)', async (t) => {
  const { ctx, cleanup } = sampleContext('lib-ok', { mainFile: '' }, ['tests']);
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  assert.equal(ctx.mainFile, undefined);
  const r = await runPipeline(ctx, { selected: ['asanUbsan', 'valgrind'] });
  assert.equal(r.ok, true, 'skip は失敗ではない');
  const asan = r.results.find((x) => x.id === 'asanUbsan')!;
  assert.equal(asan.status, 'skip');
  assert.match(asan.reason ?? '', /main がありません/);
  assert.match(asan.hint ?? '', /mainFile/);
  cleanup();
});

test('main を含むファイルが tree 内にあれば、mainFile 未指定でも通常のソースとして main を検出する', async () => {
  const { ctx, cleanup } = sampleContext('lib-ok', { mainFile: '' });
  assert.equal(ctx.hasMain, true);
  assert.equal(ctx.mainFile, undefined);
  cleanup();
});

test('ライブラリ課題: mainFile を指定すると動的チェックが通り、デバッグ用ビルドもできる', async (t) => {
  const { ctx, cleanup } = sampleContext('lib-ok', { mainFile: 'tests/test_main.c' });
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: ['asanUbsan', 'valgrind'], debugBuild: true });
  const summary = r.results.map((x) => `${x.id}=${x.status}${x.reason ? `(${x.reason})` : ''}`).join(', ');
  assert.equal(r.ok, true, summary);
  assert.equal(status(r, 'asanUbsan'), 'pass', summary);
  assert.equal(status(r, 'debug-build'), 'pass', summary);
  cleanup();
});

test('"Debug (skip checks)" 相当: debugBuildOnly は段階 1・2 を飛ばしてビルドだけ行う', async (t) => {
  const { ctx, cleanup } = sampleContext('norm-ng');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: DEFAULT_ON, debugBuildOnly: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.id), ['prepare', 'debug-build']);
  cleanup();
});

/* ───────── TSan / MSan (選択式。複数選ぶと項目ごとに別ビルドで順に実行される) ───────── */

const lineOf = (file: string, needle: string) =>
  fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(needle)) + 1;

/** 環境の都合 (ランタイム未導入 / ASLR 設定) で起動できない場合は、失敗ではなく skip になる */
const cannotRun = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => {
  const x = r.results.find((y) => y.id === id);
  return x?.status === 'skip' && /ランタイム|起動できません/.test(x.reason ?? '');
};

test('TSan: データ競合を検出し、競合の位置に診断が付く', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-tsan');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: ['tsan'] });
  if (cannotRun(r, 'tsan')) return t.skip('この環境では TSan が使えない');
  const x = r.results.find((y) => y.id === 'tsan')!;
  assert.equal(x.status, 'fail', x.log);
  const line = lineOf(path.join(ctx.root, 'main.c'), '(*count)++');
  assert.ok(x.diags.some((d) => d.file.endsWith('main.c') && d.line === line && /ThreadSanitizer: data race/.test(d.message)), `main.c:${line}`);
  cleanup();
});

test('MSan: 初期化していないヒープの読み取りを検出し、診断が付く', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-msan');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: ['msan'] });
  if (cannotRun(r, 'msan')) return t.skip('この環境では MSan が使えない');
  const x = r.results.find((y) => y.id === 'msan')!;
  assert.equal(x.status, 'fail', x.log);
  const line = lineOf(path.join(ctx.root, 'main.c'), "buf[argc] == 'x'");
  assert.ok(x.diags.some((d) => d.file.endsWith('main.c') && d.line === line && /MemorySanitizer/.test(d.message)), `main.c:${line}`);
  cleanup();
});

test('正常なサンプルは TSan / MSan も通る', async (t) => {
  const { ctx, cleanup } = sampleContext('ok');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: ['tsan', 'msan'] });
  if (cannotRun(r, 'tsan') || cannotRun(r, 'msan')) return t.skip('この環境では TSan / MSan が使えない');
  assert.equal(r.ok, true, r.results.map((x) => `${x.id}=${x.status}(${x.reason ?? ''})`).join(', '));
  cleanup();
});

test('複数選択: ASan+UBSan / TSan / MSan は別ビルド・別バイナリで順に実行され、それぞれ独立に判定される', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('bug-tsan');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const order: string[] = [];
  const r = await runPipeline(ctx, { selected: ['msan', 'tsan', 'asanUbsan'] }, { onStepStart: (id) => order.push(id) });
  if (cannotRun(r, 'tsan') || cannotRun(r, 'msan')) return t.skip('この環境では TSan / MSan が使えない');
  assert.deepEqual(order.filter((x) => x !== 'prepare'), ['asanUbsan', 'tsan', 'msan'], '選択順ではなく、定義順で 1 項目ずつ');
  for (const sub of ['asan', 'tsan', 'msan']) assert.ok(fs.existsSync(path.join(dir, '.42check', sub, 'prog')), `${sub} は別ビルド`);
  assert.equal(status(r, 'asanUbsan'), 'pass', 'ASan にはデータ競合は見えない');
  assert.equal(status(r, 'tsan'), 'fail');
  assert.equal(status(r, 'msan'), 'pass');
  assert.equal(r.stoppedAt?.id, 'tsan');
  cleanup();
});

test('既定では TSan / MSan は OFF (チェックを入れたときだけ実行される)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: Record<string, boolean> }> } };
  };
  const d = pkg.contributes.configuration.properties['c42check.checks'].default;
  assert.deepEqual([d.tsan, d.msan, d.asanUbsan], [false, false, true]);
});

test('norminette.ignoreParameterErrors: 引数についての指摘 (TOO_MANY_ARGS / NO_ARGS_VOID) だけを除く。他の指摘は残る', async (t) => {
  const probe = sampleContext('ok');
  if (!need(probe.ctx, 'norminette')) {
    probe.cleanup();
    return t.skip('norminette が無い');
  }
  const header = fs.readFileSync(path.join(probe.dir, 'str_utils.c'), 'utf8').split('\n').slice(0, 11).join('\n').replace('str_utils.c   ', 'args.c       ');
  const argsOnly = `${header}\n\nint\tadd_five(int first, int second, int third, int fourth, int fifth)\n{\n\treturn (first + second + third + fourth + fifth);\n}\n\nint\tzero()\n{\n\treturn (0);\n}\n`;
  const withOther = argsOnly.replace('int\tzero()', 'int \tzero()'); // SPACE_BEFORE_FUNC など、引数以外の指摘も加える
  const run = async (text: string, ignore: boolean) => {
    const { ctx, dir, cleanup } = sampleContext('ok');
    fs.writeFileSync(path.join(dir, 'args.c'), text);
    const c = createContext({ root: dir, settings: { ...ctx.settings, norminetteIgnoreParameterErrors: ignore }, tools: ctx.tools, io: ctx.io });
    const r = await runPipeline(c, { selected: ['norminette'] });
    cleanup();
    return r.results.find((x) => x.id === 'norminette')!;
  };
  probe.cleanup();

  const off = await run(argsOnly, false);
  assert.equal(off.status, 'fail');
  assert.deepEqual(off.diags.map((d) => d.message.split(':')[0]).sort(), ['NO_ARGS_VOID', 'TOO_MANY_ARGS']);
  // ログ: 問題のないファイルは出さず、指摘は Ctrl+クリックで開ける パス:行:列 の形で出す
  // (VS Code の Output は、ワークスペースの絶対パスで始まるものだけをリンクにするので、絶対パスで出す)
  assert.match(off.log, /^(?:\/|[A-Za-z]:\\).*args\.c:13:70: TOO_MANY_ARGS: Function has more than 4 arguments$/m);
  assert.match(off.log, /^(?:\/|[A-Za-z]:\\).*args\.c:18:10: NO_ARGS_VOID: /m);
  assert.doesNotMatch(off.log.split('\n').slice(1).join('\n'), /OK!|str_utils|main\.c/, '問題のないファイルは出さない (1 行目はコマンドライン)');
  assert.match(off.log, /2 件の指摘 \(1 \/ 4 ファイル\)/);

  const on = await run(argsOnly, true);
  assert.equal(on.status, 'pass', on.log);
  assert.match(on.log, /問題はありません \(4 ファイル\)/);
  assert.deepEqual(on.diags, []);
  assert.match(on.log, /引数についての指摘を 2 件、結果から除きました/);

  const mixed = await run(withOther, true);
  assert.equal(mixed.status, 'fail', '引数以外の指摘が残れば fail のまま');
  assert.ok(mixed.diags.length > 0 && mixed.diags.every((d) => !/TOO_MANY_ARGS|NO_ARGS_VOID/.test(d.message)), mixed.diags.map((d) => d.message).join('\n'));
});
