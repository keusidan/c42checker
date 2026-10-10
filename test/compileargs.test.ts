// コンパイル引数の設定 (c42check.compile.* / clangTidy.checks / valgrind.args) の検証。
// 本物の clang / clang-tidy / gcc / valgrind があれば使う。
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { normalizeArgs, shellSplit } from '../src/core/args';
import { generateCompdb } from '../src/core/compdb';
import { runPipeline } from '../src/core/pipeline';
import { DEFAULT_SETTINGS, STEP_IDS, type Context, type Settings, type StepId, type Tools } from '../src/core/types';
import { readSettings } from '../src/ui/config';
import { sampleContext } from './helpers';

const need = (ctx: Context, key: keyof Tools) => ctx.tools[key] !== undefined;
const status = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id)?.status;
const log = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id)?.log ?? '';
const writeMain = (dir: string, text: string) => fs.writeFileSync(path.join(dir, 'main.c'), text);

const REMOVE_STR_UTILS = ['str_utils.c', 'str_utils.h'];

/**
 * 静的ライブラリ lib/libfoo.a (foo_value() を提供) を作り、それを呼ぶ main を書く。リンクに `-L<lib> -lfoo` が要る。
 * (clang は sanitizer 付きのリンクで -lm を自動で付けるため、libm では「無いと失敗する」状況を作れない。
 *  静的ライブラリは、リンクの順序にも厳密なので、-l を入力の後ろに置く設計の検証にも向く)
 */
function setupFooLib(dir: string, cc: string): void {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'foo.c'), 'int\tfoo_value(void)\n{\n\treturn (42);\n}\n');
  execFileSync(cc, ['-c', path.join(dir, 'lib', 'foo.c'), '-o', path.join(dir, 'lib', 'foo.o')]);
  execFileSync('ar', ['rcs', path.join(dir, 'lib', 'libfoo.a'), path.join(dir, 'lib', 'foo.o')]);
  writeMain(dir, 'int foo_value(void);\nint main(void)\n{\n\treturn (foo_value() - 42);\n}\n');
}
const hasAr = (): boolean => {
  try {
    execFileSync('ar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/* ───────── 引数の正規化 ───────── */

test('normalizeArgs: shell 風に分割し、${workspaceFolder} を展開する (shell は介さない)', () => {
  assert.deepEqual(normalizeArgs(['-lbsd -lm', '-DNAME="a b"', "-I'/p q/inc'", '-I${workspaceFolder}/x', '', '   '], '/w'), [
    '-lbsd',
    '-lm',
    '-DNAME=a b',
    '-I/p q/inc',
    '-I/w/x',
  ]);
  assert.deepEqual(normalizeArgs(['$HOME/*.c', '`id`'], '/w'), ['$HOME/*.c', '`id`'], '$VAR や * やバッククォートは展開・実行されない');
  assert.deepEqual(normalizeArgs(undefined, '/w'), []);
  assert.deepEqual(normalizeArgs([1, null, '-lm'] as unknown as string[], '/w'), ['-lm'], '文字列以外は無視');
  assert.deepEqual(shellSplit(`a 'b c' "d e" f\\ g`), ['a', 'b c', 'd e', 'f g']);
});

/* ───────── -l / -L (リンク) ───────── */

test('libs: -lfoo が無いとリンクできず fail。ldflags に -L、libs に -lfoo を指定すると pass (デバッグ用ビルドにも効く)', async (t) => {
  const probe = sampleContext('ok', {}, REMOVE_STR_UTILS);
  if (!need(probe.ctx, 'cc') || !hasAr()) return t.skip('clang / ar が無い');
  setupFooLib(probe.dir, probe.ctx.tools.cc!);
  const r0 = await runPipeline(probe.ctx, { selected: ['asanUbsan', 'valgrind'], debugBuild: true });
  assert.equal(status(r0, 'asanUbsan'), 'fail');
  assert.match(log(r0, 'asanUbsan'), /foo_value/, 'undefined reference to foo_value');
  probe.cleanup();

  const ok = sampleContext('ok', { compileLdflags: ['-L${workspaceFolder}/lib'], compileLibs: ['-lfoo'] }, REMOVE_STR_UTILS);
  setupFooLib(ok.dir, ok.ctx.tools.cc!);
  const r1 = await runPipeline(ok.ctx, { selected: ['asanUbsan', 'tsan', 'valgrind'], debugBuild: true });
  const summary = r1.results.map((x) => `${x.id}=${x.status}(${x.reason ?? ''})`).join(', ');
  for (const id of ['asanUbsan', 'valgrind', 'debug-build']) assert.equal(status(r1, id), 'pass', `${id}: ${summary}`);
  ok.cleanup();
});

test('順序: -lfoo を ldflags (入力の前) に書くとリンクできない。libs (入力の後ろ) に書くのが正しい', async (t) => {
  const wrong = sampleContext('ok', { compileLdflags: ['-L${workspaceFolder}/lib', '-lfoo'] }, REMOVE_STR_UTILS);
  if (!need(wrong.ctx, 'cc') || !hasAr()) return t.skip('clang / ar が無い');
  setupFooLib(wrong.dir, wrong.ctx.tools.cc!);
  const r = await runPipeline(wrong.ctx, { selected: ['asanUbsan'] });
  assert.equal(status(r, 'asanUbsan'), 'fail', '静的ライブラリは、参照する側より前に置くと解決されない');
  wrong.cleanup();
});

test('引数の並び順: ldflags は入力ファイルの前、libs は入力ファイルの後ろ (-l は後ろに置かないと解決されない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok', {
    compileLdflags: ['-L${workspaceFolder}/lib', '-Wl,-rpath,/nonexistent-rpath'],
    compileLibs: ['-lm -lpthread'],
  });
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: ['asanUbsan'] });
  const line = log(r, 'asanUbsan').split('\n').find((l) => l.startsWith('$ ') && l.includes(' -o '))!;
  const at = (s: string) => line.indexOf(s);
  assert.ok(at(`-L${dir}/lib`) > 0 && at('-Wl,-rpath,/nonexistent-rpath') > 0, '${workspaceFolder} が展開されている');
  assert.ok(at('-L') < at(' -o ') && at(' -o ') < at('main.c'), 'ldflags → -o → 入力');
  assert.ok(at('main.c') < at('-lm') && at('-lm') < at('-lpthread'), 'libs は入力ファイルより後ろに、指定した順で並ぶ (1 要素に複数書いても分割される)');
  cleanup();
});

/* ───────── cflags (-D / -I / -std) ───────── */

const NEEDS_DEFINE = '#ifndef NEEDED\n# error NEEDED is not defined\n#endif\nint main(void)\n{\n\treturn (0);\n}\n';

test('cflags: -D が無いとコンパイルできない課題が、warnings / clang-tidy / gcc / scan-build / ASan のすべてで通る', async (t) => {
  const ALL: StepId[] = ['warnings', 'clangTidy', 'gccAnalyzer', 'scanBuild', 'asanUbsan'];
  const without = sampleContext('ok', {}, ['Makefile', ...REMOVE_STR_UTILS]); // Makefile 無し = scan-build は 1 ファイルずつ直接コンパイル
  if (!need(without.ctx, 'cc')) return t.skip('clang が無い');
  writeMain(without.dir, NEEDS_DEFINE);
  const r0 = await runPipeline(without.ctx, { selected: ALL });
  for (const id of ['warnings', 'clangTidy'] as const) assert.equal(status(r0, id), 'fail', `${id} は -DNEEDED 無しでは fail`);
  assert.equal(status(r0, 'asanUbsan'), undefined, '段階 1 が fail なので、段階 2 の ASan は実行されない (fail-fast)');
  const r0b = await runPipeline(without.ctx, { selected: ['asanUbsan'] }); // 段階 2 だけを単独で
  assert.equal(status(r0b, 'asanUbsan'), 'fail', 'ASan のビルドも -DNEEDED 無しでは fail');
  without.cleanup();

  const withDef = sampleContext('ok', { compileCflags: ['-DNEEDED=1'] }, ['Makefile', ...REMOVE_STR_UTILS]);
  writeMain(withDef.dir, NEEDS_DEFINE);
  const r1 = await runPipeline(withDef.ctx, { selected: ALL });
  const bad = r1.results.filter((x) => x.status === 'fail').map((x) => `${x.id}: ${x.reason}\n${x.log.slice(0, 400)}`);
  assert.deepEqual(bad, [], '全項目が通る');
  withDef.cleanup();
});

test('cflags は compile_commands.json にも入る (files / make-n どちらの方式でも、-c の前)', async (t) => {
  for (const source of ['files', 'make-n'] as const) {
    const { ctx, dir, cleanup } = sampleContext('ok', { compileCflags: ['-DNEEDED=1', '-std=gnu11'], compdbSource: source });
    if (source === 'make-n' && !need(ctx, 'make')) {
      cleanup();
      continue;
    }
    fs.mkdirSync(ctx.workDir, { recursive: true });
    await generateCompdb(ctx);
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'compile_commands.json'), 'utf8')) as { arguments: string[] }[];
    assert.ok(db.length > 0);
    for (const e of db) {
      const c = e.arguments.lastIndexOf('-c');
      assert.ok(e.arguments.indexOf('-DNEEDED=1') > 0 && e.arguments.indexOf('-DNEEDED=1') < c, `${source}: ${e.arguments.join(' ')}`);
      assert.ok(e.arguments.includes('-std=gnu11'));
    }
    cleanup();
  }
  void t;
});

test('cflags の ${workspaceFolder} と、1 要素に複数書いた引数の分割 (include パスと -D)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok', { compileCflags: ['-I${workspaceFolder}/extra', '-DA=1 -DB=2'] }, REMOVE_STR_UTILS);
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  fs.mkdirSync(path.join(dir, 'extra'));
  fs.writeFileSync(path.join(dir, 'extra', 'need.h'), '#if !defined(A) || !defined(B)\n# error missing\n#endif\n#define NEED_OK 1\n');
  writeMain(dir, '#include "need.h"\nint main(void)\n{\n\treturn (NEED_OK - 1);\n}\n');
  const r = await runPipeline(ctx, { selected: ['warnings'] });
  assert.equal(status(r, 'warnings'), 'pass', log(r, 'warnings'));
  assert.match(log(r, 'warnings'), / -DA=1 -DB=2 /);
  cleanup();
});

/* ───────── 項目ごと / 既定値の置き換え ───────── */

const UNUSED_PARAM = 'int main(int argc, char **argv)\n{\n\treturn (0);\n}\n';

test('perStep.warnings / warningFlags: 警告強化ビルドだけ、追加・置き換えできる', async (t) => {
  const mk = (o: Partial<Settings>) => {
    const c = sampleContext('ok', o, REMOVE_STR_UTILS);
    writeMain(c.dir, UNUSED_PARAM);
    return c;
  };
  const base = mk({});
  if (!need(base.ctx, 'cc')) return t.skip('clang が無い');
  assert.equal(status(await runPipeline(base.ctx, { selected: ['warnings'] }), 'warnings'), 'fail', '既定: -Wextra -Werror で未使用の引数は fail');

  const add = mk({ compilePerStep: { warnings: ['-Wno-unused-parameter'] } });
  assert.equal(status(await runPipeline(add.ctx, { selected: ['warnings'] }), 'warnings'), 'pass', 'perStep で打ち消す');

  const replace = mk({ compileWarningFlags: ['-Wall', '-Werror'] });
  const r = await runPipeline(replace.ctx, { selected: ['warnings'] });
  assert.equal(status(r, 'warnings'), 'pass', '-Wextra を外した警告フラグに置き換え');
  assert.doesNotMatch(log(r, 'warnings'), /-Wextra|-Wshadow|-Wconversion/);
  for (const c of [base, add, replace]) c.cleanup();
});

test('clangTidy.checks と perStep.clangTidy: clang-tidy に渡る (コンパイラ引数は cflags)', async (t) => {
  const { ctx, cleanup } = sampleContext('ok', { clangTidyChecks: 'bugprone-*,-bugprone-easily-swappable-parameters', compilePerStep: { clangTidy: ['--header-filter=.*'] }, compileCflags: ['-DX=1'] });
  if (!need(ctx, 'tidy')) return t.skip('clang-tidy が無い');
  const r = await runPipeline(ctx, { selected: ['clangTidy'] });
  const line = log(r, 'clangTidy').split('\n')[0];
  assert.match(line, /-checks=bugprone-\*,-bugprone-easily-swappable-parameters/);
  assert.match(line, / --header-filter=\.\* /);
  assert.ok(line.indexOf('--header-filter') < line.indexOf(' -- '), 'clang-tidy 自身のオプションは -- より前');
  assert.ok(line.indexOf(' -- ') < line.indexOf('-DX=1'), 'cflags は -- より後 (コンパイラへの引数)');
  cleanup();
});

test('valgrind.args と perStep.valgrind: 既定を置き換えても、判定に必要な --error-exitcode は常に付く', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-leak', { valgrindArgs: ['--leak-check=full'], compilePerStep: { valgrind: ['--num-callers=7'] } });
  if (!need(ctx, 'valgrind') || !need(ctx, 'cc')) return t.skip('valgrind / clang が無い');
  const r = await runPipeline(ctx, { selected: ['valgrind'] });
  const line = log(r, 'valgrind').split('\n').find((l) => l.startsWith('$ valgrind'))!;
  assert.doesNotMatch(line, /--track-fds|--show-leak-kinds/, '既定を置き換えた');
  assert.match(line, /--leak-check=full --error-exitcode=99 --fullpath-after= --num-callers=7 /);
  assert.equal(status(r, 'valgrind'), 'fail', 'メモリリークは検出される');
  const v = r.results.find((x) => x.id === 'valgrind')!;
  assert.ok(!v.diags.some((d) => /Open file descriptor/.test(d.message)), '--track-fds を外したので fd は追跡されない');
  cleanup();
});

test('perStep.norminette: norminette への引数として、ファイル名の前に渡る', async (t) => {
  const { ctx, cleanup } = sampleContext('ok', { compilePerStep: { norminette: ['--version'] } });
  if (!need(ctx, 'norminette')) return t.skip('norminette が無い');
  const r = await runPipeline(ctx, { selected: ['norminette'] });
  assert.match(log(r, 'norminette'), /^\$ norminette --version main\.c /);
  cleanup();
});

test('perStep.<sanitizer>: そのビルドにだけ追加される', async (t) => {
  const { ctx, cleanup } = sampleContext('ok', { compilePerStep: { asanUbsan: ['-DONLY_ASAN=1'] } });
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const r = await runPipeline(ctx, { selected: ['asanUbsan', 'valgrind'] });
  assert.match(log(r, 'asanUbsan'), /-DONLY_ASAN=1/);
  assert.doesNotMatch(log(r, 'valgrind'), /ONLY_ASAN/);
  cleanup();
});

/* ───────── VS Code の設定との対応 ───────── */

const state = (vscode as unknown as { state: { config: Record<string, unknown> } }).state;

test('VS Code の設定 → Settings: 新しい設定キーを読む。型が違う設定は既定値に戻す', () => {
  state.config = {
    'c42check.compile.cflags': ['-DDEBUG'],
    'c42check.compile.ldflags': ['-L/usr/local/lib'],
    'c42check.compile.libs': ['-lbsd', '-lm'],
    'c42check.compile.perStep': { warnings: ['-Wno-x'], valgrind: ['--v'], unknownStep: ['-z'], tsan: 'not-an-array' },
    'c42check.clangTidy.checks': 'bugprone-*',
    'c42check.valgrind.args': ['--leak-check=yes'],
    'c42check.compile.warningFlags': 'oops-a-string',
  };
  const s = readSettings();
  assert.deepEqual([s.compileCflags, s.compileLdflags, s.compileLibs], [['-DDEBUG'], ['-L/usr/local/lib'], ['-lbsd', '-lm']]);
  assert.deepEqual(s.compilePerStep, { warnings: ['-Wno-x'], valgrind: ['--v'] }, '未知の項目名と、配列でない値は無視');
  assert.deepEqual([s.clangTidyChecks, s.valgrindArgs], ['bugprone-*', ['--leak-check=yes']]);
  assert.deepEqual(s.compileWarningFlags, DEFAULT_SETTINGS.compileWarningFlags, '型が違えば既定値');
  state.config = {};
});

test('package.json のスキーマと既定値: DEFAULT_SETTINGS と一致し、perStep には全ての項目名がある', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown; properties?: Record<string, unknown>; additionalProperties?: unknown }> } };
  };
  const p = pkg.contributes.configuration.properties;
  const d: Settings = DEFAULT_SETTINGS;
  assert.deepEqual(p['c42check.compile.cflags'].default, d.compileCflags);
  assert.deepEqual(p['c42check.compile.ldflags'].default, d.compileLdflags);
  assert.deepEqual(p['c42check.compile.libs'].default, d.compileLibs);
  assert.deepEqual(p['c42check.compile.warningFlags'].default, d.compileWarningFlags);
  assert.equal(p['c42check.clangTidy.checks'].default, d.clangTidyChecks);
  assert.deepEqual(p['c42check.valgrind.args'].default, d.valgrindArgs);
  assert.deepEqual(Object.keys(p['c42check.compile.perStep'].properties ?? {}).sort(), [...STEP_IDS].sort(), '全ての項目名が補完に出る');
  assert.equal(p['c42check.compile.perStep'].additionalProperties, false, '項目名の書き間違いを警告できる');
});
