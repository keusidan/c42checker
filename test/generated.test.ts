// compile_commands.json / .clangd は、実行のたびには書き直さない (初回と、必要なときだけ)。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLANGD_MARKER, compdbFingerprint, ensureGenerated, STATE_DIR } from '../src/core/compdb';
import { createContext } from '../src/core/context';
import { runPipeline } from '../src/core/pipeline';
import { detectTools } from '../src/core/tools';
import { resetWorkDir } from '../src/core/workdir';
import type { Context, Settings } from '../src/core/types';
import { sampleContext } from './helpers';

const rebuild = (ctx: Context, over: Partial<Settings> = {}): Context =>
  createContext({ root: ctx.root, settings: { ...ctx.settings, ...over }, tools: detectTools(), io: { log: () => undefined } });
const prepareLog = async (ctx: Context) => (await runPipeline(ctx, { selected: [] })).results[0].log;
const stat = (dir: string, f: string) => fs.statSync(path.join(dir, f), { bigint: true }).mtimeNs;
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STATE = path.join('.42check', STATE_DIR, 'compdb.json');

test('初回は compile_commands.json / .clangd / 生成の記録を作る。2 回目以降は、中身も更新時刻も変えない', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  const first = await prepareLog(ctx);
  assert.match(first, /compile_commands\.json を生成しました \(初回/);
  assert.match(first, /\.clangd を生成しました/);
  assert.ok(fs.existsSync(path.join(dir, STATE)), '生成の記録');
  const before = { db: read(dir, 'compile_commands.json'), clangd: read(dir, '.clangd'), t1: stat(dir, 'compile_commands.json'), t2: stat(dir, '.clangd') };
  await sleep(30);
  for (let n = 0; n < 3; n++) {
    const log = await prepareLog(ctx);
    assert.match(log, /compile_commands\.json: 生成済みで、対象のファイルや設定に変更がないため、そのままにしました/);
    assert.match(log, /\.clangd: 既にあるため、そのままにしました/);
  }
  assert.equal(read(dir, 'compile_commands.json'), before.db);
  assert.equal(read(dir, '.clangd'), before.clangd);
  assert.equal(stat(dir, 'compile_commands.json'), before.t1, '更新時刻が変わらない = clangd が読み直さない');
  assert.equal(stat(dir, '.clangd'), before.t2);
  cleanup();
});

test('記録 (.42check/state/) は、実行のたびの .42check/ の作り直しで消えない。他の成果物は消える', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  await prepareLog(ctx);
  fs.mkdirSync(path.join(dir, '.42check', 'asan'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.42check', 'asan', 'prog'), 'x');
  await prepareLog(ctx);
  assert.ok(fs.existsSync(path.join(dir, STATE)));
  assert.ok(!fs.existsSync(path.join(dir, '.42check', 'asan')));
  resetWorkDir(ctx.workDir, [STATE_DIR]);
  assert.ok(fs.existsSync(path.join(dir, STATE)), '「.42check/ を削除」コマンドでも、記録は残る');
  cleanup();
});

test('必要なときだけ作り直す: 対象の .c が増えた / cflags を変えた / Makefile を変えた', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  await prepareLog(ctx);
  const names = () => (JSON.parse(read(dir, 'compile_commands.json')) as { file: string }[]).map((e) => path.basename(e.file)).sort();
  assert.deepEqual(names(), ['main.c', 'str_utils.c']);

  fs.writeFileSync(path.join(dir, 'extra.c'), 'int\tft_extra(void)\n{\n\treturn (0);\n}\n');
  fs.writeFileSync(path.join(dir, 'Makefile'), read(dir, 'Makefile').replace('SRCS = main.c str_utils.c', 'SRCS = main.c str_utils.c extra.c'));
  const log1 = await prepareLog(rebuild(ctx));
  assert.match(log1, /compile_commands\.json を作り直しました \(対象のファイルや設定が変わったため/);
  assert.deepEqual(names(), ['extra.c', 'main.c', 'str_utils.c']);

  assert.match(await prepareLog(rebuild(ctx)), /そのままにしました/, '直した後は、また書き直さない');

  const log2 = await prepareLog(rebuild(ctx, { compileCflags: ['-DDEBUG'] }));
  assert.match(log2, /作り直しました/);
  assert.match(read(dir, 'compile_commands.json'), /-DDEBUG/);
  assert.match(await prepareLog(rebuild(ctx, { compileCflags: ['-DDEBUG'] })), /そのままにしました/);

  fs.writeFileSync(path.join(dir, 'Makefile'), read(dir, 'Makefile').replace('CFLAGS = -Wall -Wextra -Werror', 'CFLAGS = -Wall -Wextra -Werror -DFROM_MAKEFILE'));
  const log3 = await prepareLog(rebuild(ctx, { compileCflags: ['-DDEBUG'] }));
  assert.match(log3, /作り直しました/);
  assert.match(read(dir, 'compile_commands.json'), /-DFROM_MAKEFILE/, 'Makefile (make -n) の内容が反映される');
  cleanup();
});

test('必要がないときは作り直さない: .c の中身の編集・既存のディレクトリへのヘッダの追加・実行時の設定の変更', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  await prepareLog(ctx);
  const t = stat(dir, 'compile_commands.json');
  await sleep(30);
  fs.writeFileSync(path.join(dir, 'main.c'), read(dir, 'main.c') + '\n/* edited */\n');
  fs.writeFileSync(path.join(dir, 'new.h'), '#ifndef NEW_H\n# define NEW_H\n#endif\n');
  const log = await prepareLog(rebuild(ctx, { runTimeoutSec: 99, failFast: 'step', clangTidyChecks: 'bugprone-*', staticTimeoutSec: 7 }));
  assert.match(log, /そのままにしました/);
  assert.equal(stat(dir, 'compile_commands.json'), t);
  cleanup();
});

test('消した / 無いときは作る (compile_commands.json も .clangd も、それぞれ)', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  await prepareLog(ctx);
  fs.rmSync(path.join(dir, 'compile_commands.json'));
  const log = await prepareLog(ctx);
  assert.match(log, /compile_commands\.json を生成しました/);
  assert.match(log, /\.clangd: 既にあるため/);
  fs.rmSync(path.join(dir, '.clangd'));
  assert.match(await prepareLog(ctx), /\.clangd を生成しました/);
  assert.ok(read(dir, '.clangd').startsWith(CLANGD_MARKER));
  assert.match(read(dir, '.clangd').split('\n')[0], /実行のたびには上書きしません/);
  cleanup();
});

test('自分で用意した compile_commands.json (生成の記録がない) は上書きしない。.clangd は、あれば (42 Check 製でも) 書き直さない', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  fs.writeFileSync(path.join(dir, 'compile_commands.json'), '[]\n');
  fs.writeFileSync(path.join(dir, '.clangd'), `${CLANGD_MARKER} — edited by hand\nCompileFlags:\n  Add: [-DMINE]\n`);
  const log = await prepareLog(ctx);
  assert.match(log, /既にあるファイル \(42 Check が作った記録がない\) を上書きしませんでした/);
  assert.match(log, /「42 Check: compile_commands\.json を再生成」/);
  assert.equal(read(dir, 'compile_commands.json'), '[]\n');
  assert.match(read(dir, '.clangd'), /-DMINE/, '42 Check 製の印があっても、手で直したものを実行のたびに戻さない');
  assert.ok(!fs.existsSync(path.join(dir, STATE)), '作っていないので記録も作らない');
  cleanup();
});

test('再生成コマンド (force): compile_commands.json は必ず書き直す。.clangd は 42 Check 製だけ書き直し、他人のものは残す', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  fs.writeFileSync(path.join(dir, 'compile_commands.json'), '[]\n');
  fs.writeFileSync(path.join(dir, '.clangd'), 'CompileFlags:\n  Add: [-DMINE]\n');
  fs.mkdirSync(ctx.workDir, { recursive: true });
  let g = await ensureGenerated(ctx, { force: true });
  assert.equal(g.compdb.action, 'regenerated');
  assert.ok(JSON.parse(read(dir, 'compile_commands.json')).length > 0);
  assert.equal(g.clangd.action, 'foreign');
  assert.match(read(dir, '.clangd'), /-DMINE/);
  assert.ok(fs.existsSync(path.join(dir, STATE)), '以降は 42 Check が作ったものとして、必要なときだけ更新する');
  assert.match(await prepareLog(ctx), /compile_commands\.json: 生成済みで/);

  fs.writeFileSync(path.join(dir, '.clangd'), `${CLANGD_MARKER}\nold\n`);
  g = await ensureGenerated(ctx, { force: true });
  assert.equal(g.clangd.action, 'generated');
  assert.match(read(dir, '.clangd'), /CompileFlags/);
  cleanup();
});

test('指紋: 同じ入力なら同じ。対象・設定・Makefile が変わると変わる', () => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  const a = compdbFingerprint(ctx);
  assert.equal(compdbFingerprint(rebuild(ctx)), a);
  assert.notEqual(compdbFingerprint(rebuild(ctx, { compdbIncludeMain: false })), a);
  assert.notEqual(compdbFingerprint(rebuild(ctx, { includePaths: ['inc'] })), a);
  assert.notEqual(compdbFingerprint(rebuild(ctx, { compdbSource: 'files' })), a);
  fs.appendFileSync(path.join(dir, 'Makefile'), '\n# changed\n');
  assert.notEqual(compdbFingerprint(rebuild(ctx)), a);
  cleanup();
});
