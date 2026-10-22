// c42check.normExclude: norminette と c_formatter_42 の対象から外すファイル (既定: main.c)。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { isExcluded, matchesPattern } from '../src/core/exclude';
import { runPipeline } from '../src/core/pipeline';
import { DEFAULT_SETTINGS, type Context, type Tools } from '../src/core/types';
import { readSettings } from '../src/ui/config';
import { sampleContext } from './helpers';

const need = (ctx: Context, key: keyof Tools) => ctx.tools[key] !== undefined;
const get = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id);
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

test('パターン: / を含まなければファイル名 (どの深さでも)、含めば相対パス、/ で終われば配下すべて', () => {
  assert.ok(matchesPattern('main.c', 'main.c'));
  assert.ok(matchesPattern('src/main.c', 'main.c'), 'ファイル名に一致するので、サブディレクトリの main.c も除外される');
  assert.ok(matchesPattern('a/b/main.c', 'main.c'));
  assert.ok(!matchesPattern('domain.c', 'main.c'), '部分一致はしない');
  assert.ok(!matchesPattern('main.cpp', 'main.c'));
  assert.ok(matchesPattern('main.c', '/main.c') && !matchesPattern('src/main.c', '/main.c'), '/main.c は直下だけ');
  assert.ok(matchesPattern('main.c', './main.c'));
  assert.ok(matchesPattern('tests/a/b.c', 'tests/') && !matchesPattern('src/tests/b.c', 'tests/'), 'tests/ はルート直下の tests 以下');
  assert.ok(matchesPattern('src/legacy/x.c', 'src/legacy/'));
  assert.ok(matchesPattern('src/x_test.c', '*_test.c') && !matchesPattern('src/x_test.h', '*_test.c'));
  assert.ok(matchesPattern('src/a/b.c', 'src/**') && !matchesPattern('lib/a.c', 'src/**'));
  assert.ok(matchesPattern('ab.c', 'a?.c') && !matchesPattern('a/.c', 'a?.c'));
  assert.ok(!matchesPattern('main.c', '') && !matchesPattern('main.c', '   '), '空のパターンは何にも一致しない');
  assert.ok(matchesPattern('a.b.c', 'a.b.c') && !matchesPattern('aXb.c', 'a.b.c'), '. は文字どおりに扱う (正規表現のメタ文字を無効化)');
  assert.ok(isExcluded('/w/src/main.c', '/w', ['main.c']) && !isExcluded('/w/src/main.c', '/w', []) && !isExcluded('/w/src/main.c', '/w', undefined));
});

test('既定は main.c (DEFAULT_SETTINGS と package.json が一致)。VS Code の設定から読め、型が違えば既定に戻る', () => {
  assert.deepEqual(DEFAULT_SETTINGS.normExclude, ['main.c']);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  assert.deepEqual(pkg.contributes.configuration.properties['c42check.normExclude'].default, ['main.c']);
  const state = (vscode as unknown as { state: { config: Record<string, unknown> } }).state;
  state.config = {};
  assert.deepEqual(readSettings().normExclude, ['main.c']);
  state.config = { 'c42check.normExclude': ['main.c', 'tests/'] };
  assert.deepEqual(readSettings().normExclude, ['main.c', 'tests/']);
  state.config = { 'c42check.normExclude': 'main.c' };
  assert.deepEqual(readSettings().normExclude, ['main.c'], '文字列 (配列でない) は既定に戻る');
  state.config = { 'c42check.normExclude': [] };
  assert.deepEqual(readSettings().normExclude, [], '空にすれば除外しない');
  state.config = {};
});

test('norminette: main.c は検査しない。他のファイルは検査する', async (t) => {
  const withMain = sampleContext('norm-ng'); // main.c が norm 違反
  if (!need(withMain.ctx, 'norminette')) return t.skip('norminette が無い');
  const r0 = await runPipeline(withMain.ctx, { selected: ['norminette'] });
  assert.equal(get(r0, 'norminette')!.status, 'fail', '除外しなければ main.c の違反で fail');
  withMain.cleanup();

  const ex = sampleContext('norm-ng', { normExclude: ['main.c'] });
  const r1 = await runPipeline(ex.ctx, { selected: ['norminette'] });
  const n = get(r1, 'norminette')!;
  assert.equal(n.status, 'pass', n.log);
  assert.doesNotMatch(n.log.split('\n')[0], /main\.c/, 'norminette に渡すファイルから外れている');
  assert.match(n.log.split('\n')[0], /str_utils\.c/);
  assert.deepEqual(n.diags, []);
  ex.cleanup();

  // main.c 以外の違反は、引き続き検出される
  const other = sampleContext('norm-ng', { normExclude: ['main.c'] });
  fs.writeFileSync(path.join(other.dir, 'str_utils.c'), read(other.dir, 'str_utils.c').replace('size_t\tsu_strlen', 'size_t su_strlen'));
  const r2 = await runPipeline(other.ctx, { selected: ['norminette'] });
  assert.equal(get(r2, 'norminette')!.status, 'fail');
  assert.ok(get(r2, 'norminette')!.diags.every((d) => d.file.endsWith('str_utils.c')));
  other.cleanup();
});

test('サブディレクトリの main.c も除外される (ファイル名に一致)。/main.c なら直下だけ', async (t) => {
  const mk = (patterns: string[]) => {
    const c = sampleContext('proto-ok', { normExclude: patterns });
    // src/main.c を、norm 違反のまま追加 (main は 1 つしか許されないので、内容は main を含まない)
    fs.writeFileSync(path.join(c.dir, 'src', 'main.c'), 'int x ;;\n');
    return c;
  };
  const a = mk(['main.c']);
  if (!need(a.ctx, 'norminette')) return t.skip('norminette が無い');
  // scanSources は起動時に走るので、ファイルを足した後で context を作り直す
  const { createContext } = await import('../src/core/context');
  const ctxA = createContext({ root: a.dir, settings: a.ctx.settings, tools: a.ctx.tools, io: a.ctx.io });
  const rA = await runPipeline(ctxA, { selected: ['norminette'] });
  assert.doesNotMatch(get(rA, 'norminette')!.log.split('\n')[0], /src\/main\.c/, 'main.c は src/main.c も除外');
  a.cleanup();

  const b = mk(['/main.c']);
  const ctxB = createContext({ root: b.dir, settings: b.ctx.settings, tools: b.ctx.tools, io: b.ctx.io });
  const rB = await runPipeline(ctxB, { selected: ['norminette'] });
  assert.match(get(rB, 'norminette')!.log.split('\n')[0], /src\/main\.c/, '/main.c は直下だけなので、src/main.c は検査される');
  b.cleanup();
});

test('c_formatter_42: main.c は整形しない (1 バイトも変わらない)。他のファイルは整形する', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('norm-ng', { normExclude: ['main.c'] });
  if (!need(ctx, 'cFormatter')) return t.skip('c_formatter_42 が無い');
  const mainBefore = read(dir, 'main.c');
  const suBefore = read(dir, 'str_utils.c'); // <stdlib.h> が "str_utils.h" より前 = c_formatter_42 が並べ替える並び
  const r = await runPipeline(ctx, { selected: ['cFormatter'] });
  const f = get(r, 'cFormatter')!;
  assert.equal(f.status, 'pass', f.log);
  assert.equal(read(dir, 'main.c'), mainBefore, 'main.c は整形されない');
  assert.doesNotMatch(f.log.split('\n')[0], /main\.c/, 'c_formatter_42 に渡すファイルから外れている');
  assert.notEqual(read(dir, 'str_utils.c'), suBefore, '他のファイルは整形される');
  assert.equal(fs.existsSync(path.join(dir, '.42check', 'format-backup', 'main.c')), false);
  cleanup();
});

test('main.c は、norminette と整形から外れるだけ: 警告強化ビルドなど他のチェックは main.c にも効く', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok', { normExclude: ['main.c'] });
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  fs.writeFileSync(path.join(dir, 'main.c'), 'int main(int argc, char **argv)\n{\n\treturn (0);\n}\n'); // 未使用の引数 (-Wextra -Werror で fail)
  const r = await runPipeline(ctx, { selected: ['warnings', 'clangTidy'] });
  const w = get(r, 'warnings')!;
  assert.equal(w.status, 'fail', '警告強化ビルドは main.c を検査する');
  assert.ok(w.diags.some((d) => d.file.endsWith('main.c')));
  cleanup();
});

test('対象が全て除外されたら、norminette も c_formatter_42 も skip (失敗にしない)', async () => {
  const { ctx, dir, cleanup } = sampleContext('ok', { normExclude: ['*.c', '*.h'] });
  const before = read(dir, 'main.c');
  const r = await runPipeline(ctx, { selected: ['cFormatter', 'norminette'] });
  ctx.tools = { ...ctx.tools, norminette: ctx.tools.norminette ?? 'norminette', cFormatter: ctx.tools.cFormatter ?? 'c_formatter_42' };
  const r2 = await runPipeline(ctx, { selected: ['cFormatter', 'norminette'] });
  for (const x of [r, r2]) assert.equal(x.ok, true);
  for (const id of ['cFormatter', 'norminette']) {
    const s = get(r2, id)!;
    assert.equal(s.status, 'skip', id);
    assert.match(s.reason ?? '', /normExclude で除外/);
    assert.match(s.hint ?? '', /c42check\.normExclude/);
  }
  assert.equal(read(dir, 'main.c'), before);
  cleanup();
});
