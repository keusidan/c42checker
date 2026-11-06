import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { exec } from '../src/core/exec';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { parseTags } from '../src/core/ctags';
import { runPipeline } from '../src/core/pipeline';
import {
  MARKER_BEGIN,
  MARKER_END,
  alignExisting,
  applyDeclEdits,
  buildEntries,
  normalizeParams,
  normalizeReturnType,
  planSync,
  proposeInsertion,
  renderBlock,
  replaceBlock,
  syncAuto,
  typeKey,
} from '../src/core/proto';
import { sampleContext } from './helpers';

/* ───────── ctags の出力を norm 形式に直す (純粋関数) ───────── */

test('戻り値の型: ポインタを関数名側に寄せるため、基底の型と * に分ける', () => {
  assert.deepEqual(normalizeReturnType('typename:char *'), { base: 'char', stars: '*' });
  assert.deepEqual(normalizeReturnType('typename:t_list **'), { base: 't_list', stars: '**' });
  assert.deepEqual(normalizeReturnType('typename:unsigned long long'), { base: 'unsigned long long', stars: '' });
  assert.deepEqual(normalizeReturnType('typename:const char *'), { base: 'const char', stars: '*' });
  assert.deepEqual(normalizeReturnType('struct:s_list *'), { base: 'struct s_list', stars: '*' });
  assert.equal(normalizeReturnType('typename:int (*)(int)'), undefined, '関数ポインタを返す関数は宣言に直せない');
  assert.equal(normalizeReturnType('typename:char * const'), undefined);
  assert.equal(normalizeReturnType(undefined), undefined);
});

test('引数: ctags が正規化した空白を norm 形式 (* は名前側) に整える', () => {
  assert.equal(normalizeParams('(const char * s)'), '(const char *s)');
  assert.equal(normalizeParams('(t_list * lst,void * (* f)(void *),void (* del)(void *))'), '(t_list *lst, void *(*f)(void *), void (*del)(void *))');
  assert.equal(normalizeParams('(int a[],char * const names[3])'), '(int a[], char *const names[3])');
  assert.equal(normalizeParams('(const char * fmt,...)'), '(const char *fmt, ...)');
  assert.equal(normalizeParams('(const char *)'), '(const char *)', '名前なしの引数');
  assert.equal(normalizeParams('(int (*f)(int,int),char c)'), '(int (*f)(int, int), char c)', '入れ子のカンマで分割しない');
  assert.equal(normalizeParams('()'), '(void)', '引数なしは (void) にする (norm)');
  assert.equal(normalizeParams('(void)'), '(void)');
  assert.equal(normalizeParams(undefined), undefined);
});

const TAGS = [
  'dup\tt.c\t69;"\tfunction\ttyperef:typename:int\tsignature:(void)',
  'dup\tt.c\t72;"\tfunction\ttyperef:typename:int\tsignature:(void)',
  'ft_strdup\tt.c\t9;"\tfunction\ttyperef:typename:char *\tsignature:(const char * s)',
  'helper\tt.c\t14;"\tfunction\ttyperef:typename:int\tfile:\tsignature:(int a)',
  'main\tt.c\t44;"\tfunction\ttyperef:typename:int\tsignature:(int argc,char ** argv)',
  'ft_fp\tt.c\t49;"\tfunction\ttyperef:typename:int (*)(int)\tsignature:(int x)',
  'ctags: Warning: cannot open input file "nope.c" : No such file or directory',
].join('\n');

test('tag 形式の出力: static は file: で判定し、警告は分けて持つ', () => {
  const { funcs, warnings } = parseTags(TAGS, '/w');
  assert.equal(funcs.length, 6);
  assert.equal(funcs.find((f) => f.name === 'helper')?.isStatic, true);
  assert.equal(funcs.find((f) => f.name === 'ft_strdup')?.isStatic, false);
  assert.equal(funcs[0].file, '/w/t.c');
  assert.equal(warnings.length, 1);
});

test('static と main は除外し、同名 (#ifdef) は 1 つにし、直せない関数は unsupported に集める', () => {
  const built = buildEntries(parseTags(TAGS, '/w').funcs);
  assert.deepEqual(built.entries.map((e) => e.name), ['dup', 'ft_strdup']);
  assert.equal(built.excluded, 2, 'helper (static) と main');
  assert.deepEqual(built.unsupported.map((u) => u.name), ['ft_fp']);
});

test('出力: 戻り値の型の後ろはタブ、* は関数名側、関数名の桁を全体で揃える。コメントや空行は入れず詰める', () => {
  const mk = (name: string, base: string, stars = '', file = '/w/a.c') => ({ name, file, base, stars, params: '(void)' });
  const { lines } = renderBlock([mk('f1', 'char', '*'), mk('f2', 'size_t'), mk('f3', 'unsigned long long'), mk('f4', 'void', '', '/w/b.c')]);
  assert.deepEqual(lines, [
    'char\t\t\t\t*f1(void);', // 'char'(4) → 20 桁まで: タブ 4 つ
    'size_t\t\t\t\tf2(void);', // 6 → 20 桁: ceil(14/4) = 4
    'unsigned long long\tf3(void);', // 18 → 20 桁: 1
    'void\t\t\t\tf4(void);', // ファイルが変わっても、コメントも空行も入らない
  ]);
});

test('出力は関数名の順 (ファイルや定義の順には依存しない)。文字コード順で、ロケールに依存しない', () => {
  const mk = (name: string, file: string) => ({ name, file, base: 'int', stars: '', params: '(void)' });
  const names = (es: ReturnType<typeof mk>[]) => renderBlock(es).lines.map((l) => /(\w+)\(void\)/.exec(l)![1]);
  const input = [mk('ft_strlen', '/w/z.c'), mk('ft_bzero', '/w/a.c'), mk('ft_Atoi', '/w/m.c'), mk('ft_atoi', '/w/a.c'), mk('ft_calloc', '/w/m.c')];
  const expected = ['ft_Atoi', 'ft_atoi', 'ft_bzero', 'ft_calloc', 'ft_strlen']; // 大文字は小文字より前
  assert.deepEqual(names(input), expected);
  assert.deepEqual(names([...input].reverse()), expected, '入力の順序によらず同じ出力になる');
  assert.equal(input[0].name, 'ft_strlen', '入力の配列は書き換えない');
});

test('マーカーの間だけを置き換える (外側は 1 バイトも変えない / CRLF も保つ)', () => {
  const text = `#ifndef H\n# define H\nint manual(void);\n${MARKER_BEGIN}\nold line\n${MARKER_END}\nint tail(void);\n#endif\n`;
  const r = replaceBlock(text, ['int\tnew(void);']);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, `#ifndef H\n# define H\nint manual(void);\n${MARKER_BEGIN}\nint\tnew(void);\n${MARKER_END}\nint tail(void);\n#endif\n`);
  const crlf = replaceBlock(text.replace(/\n/g, '\r\n'), ['x']);
  assert.ok(crlf.ok && crlf.text.includes(`${MARKER_BEGIN}\r\nx\r\n${MARKER_END}`));
});

test('マーカーが無い / 壊れている: 置き換えない (勝手に挿入しない)', () => {
  const none = replaceBlock('#ifndef H\n#endif\n', ['x']);
  assert.deepEqual([none.ok, !none.ok && none.reason], [false, 'no-markers']);
  for (const bad of [`${MARKER_BEGIN}\n`, `${MARKER_END}\n${MARKER_BEGIN}\n`, `${MARKER_BEGIN}\n${MARKER_BEGIN}\n${MARKER_END}\n`]) {
    const r = replaceBlock(bad, ['x']);
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'broken-markers']);
  }
});

test('挿入案: 最後の #endif の直前 / ガードが無ければ末尾。提案を作るだけで元の文字列は変えない', () => {
  const guard = '#ifndef H\n# define H\n\nint a(void);\n\n#endif\n';
  const g = proposeInsertion(guard, ['x']);
  assert.equal(g.text, `#ifndef H\n# define H\n\nint a(void);\n\n${MARKER_BEGIN}\nx\n${MARKER_END}\n\n#endif\n`);
  assert.match(g.where, /#endif/);
  assert.equal(g.text.split('\n')[g.line - 1], MARKER_BEGIN);
  const noGuard = proposeInsertion('int a(void);\n', ['x']);
  assert.equal(noGuard.text, `int a(void);\n\n${MARKER_BEGIN}\nx\n${MARKER_END}\n`);
  assert.match(noGuard.where, /末尾/);
});

/* ───────── 本物の ctags / norminette / clang での検証 ───────── */

const headerOf = (dir: string) => path.join(dir, 'includes', 'proj.h');
const read = (p: string) => fs.readFileSync(p, 'utf8');

test('同期: 再帰で抽出し (static と main を除く)、42 Norm 形式で書き、norminette を通り、ヘッダがコンパイルできる', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip(`ctags が使えない: ${r.message}`);
  assert.equal(r.status, 'updated', r.message + r.log);
  const h = read(headerOf(dir));
  const inner = h.slice(h.indexOf(MARKER_BEGIN), h.indexOf(MARKER_END));
  assert.match(inner, /^size_t\t+ft_strlen\(const char \*s\);$/m);
  assert.match(inner, /^char\t+\*ft_strdup\(const char \*s\);$/m, 'ポインタは関数名側');
  assert.match(inner, /^t_list\t+\*ft_lstnew\(void \*content\);$/m);
  assert.match(inner, /^t_list\t+\*\*ft_lstpick\(t_list \*\*lst, void \*\(\*f\)\(void \*\)\);$/m, '関数ポインタの引数');
  assert.match(inner, /^unsigned long long\tft_big\(unsigned int a, long b\);$/m);
  assert.ok(!/\/\*|\*\//.test(inner.slice(MARKER_BEGIN.length)), 'ファイル名などのコメントは入れない');
  const body = inner.slice(MARKER_BEGIN.length).split('\n').slice(1, -1);
  assert.ok(body.length === 5 && body.every((l) => l.trim() !== ''), `空行なしで詰めて並ぶ (${body.length} 行)`);
  assert.deepEqual(
    body.map((l) => /(\w+)\(/.exec(l)![1]),
    ['ft_big', 'ft_lstnew', 'ft_lstpick', 'ft_strdup', 'ft_strlen'],
    '関数名の順 (別々のファイルにあっても)',
  );
  assert.ok(h.includes(`${MARKER_BEGIN}\n`) && h.includes(`\n${MARKER_END}\n`), 'マーカーは残る');
  assert.match(h, new RegExp(`${MARKER_BEGIN.replace(/[*/]/g, '\\$&')}\\n`), 'マーカーは残る');
  assert.ok(!inner.includes('ft_hidden'), 'static は除外');
  assert.ok(!/\bmain\b/.test(inner), 'main は除外');
  // マーカーの外は変わっていない
  assert.ok(h.startsWith(read(path.join(__dirname, '..', 'samples', 'proto-ok', 'includes', 'proj.h')).split(MARKER_BEGIN)[0]));
  assert.ok(h.endsWith(`${MARKER_END}\n\n#endif\n`));
  // norminette
  if (ctx.tools.norminette) {
    assert.equal(r.norm?.status, 'pass', r.norm?.log);
    assert.deepEqual(r.norm?.diags, []);
  }
  // 生成したヘッダで、実際にプロジェクトがコンパイルできる (宣言が定義と食い違っていない)
  if (ctx.tools.cc) {
    const c = await exec(ctx.tools.cc, ['-Wall', '-Wextra', '-Werror', '-fsyntax-only', `-I${path.join(dir, 'includes')}`, ...ctx.sources], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    assert.equal(c.code, 0, c.output);
  }
  cleanup();
});

test('同期は冪等: 2 回目は変更なし', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  if ((await syncAuto(ctx)).status === 'skip') return t.skip('ctags が無い');
  const once = read(headerOf(dir));
  const r = await syncAuto(ctx);
  assert.equal(r.status, 'unchanged');
  assert.equal(read(headerOf(dir)), once);
  cleanup();
});

test('設定: proto.sourceDir で抽出対象を絞れる / proto.header で書き換え先を指定できる', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { protoSourceDir: 'src/str', protoHeader: 'includes/proj.h' });
  if ((await syncAuto(ctx)).status === 'skip') return t.skip('ctags が無い');
  const h = read(headerOf(dir));
  assert.match(h, /ft_strdup/);
  assert.ok(!h.includes('ft_lstnew') && !h.includes('ft_strlen'), 'sourceDir の外は含めない');
  cleanup();
});

test('マーカーが無いヘッダ: 何も書かず、挿入位置の提案だけを返す。syncAuto も触らない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const file = headerOf(dir);
  fs.writeFileSync(file, read(file).replace(MARKER_BEGIN + '\n', '').replace(MARKER_END + '\n', ''));
  const before = read(file);
  const plan = await planSync(ctx);
  if (plan.kind === 'skip') return t.skip('ctags が無い');
  assert.equal(plan.kind, 'needs-markers');
  if (plan.kind === 'needs-markers') {
    assert.match(plan.insertion.where, /#endif/);
    assert.ok(plan.newText.includes(MARKER_BEGIN) && plan.newText.includes('ft_strdup'));
  }
  assert.equal(read(file), before, '計画を作っただけではヘッダに触らない');
  const auto = await syncAuto(ctx);
  assert.equal(auto.status, 'needs-markers');
  assert.equal(read(file), before, '確認なしの同期もマーカーを挿入しない');
  cleanup();
});

test('ctags の結果が空 (全て static / .c が無い): ヘッダに触らずエラー', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { protoSourceDir: 'only-static' });
  fs.mkdirSync(path.join(dir, 'only-static'));
  fs.writeFileSync(path.join(dir, 'only-static', 'a.c'), 'static int f(void)\n{\n\treturn (1);\n}\n');
  const file = headerOf(dir);
  const before = read(file);
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'error');
  assert.match(r.message, /ctags の結果が空/);
  assert.equal(read(file), before);
  const none = await syncAuto(sampleContext('proto-ok', { protoSourceDir: 'nothing-here' }).ctx);
  assert.equal(none.status, 'error');
  cleanup();
});

test('宣言に直せない関数 (関数ポインタを返す) があれば、ヘッダに触らずエラーにして一覧を出す', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  fs.writeFileSync(path.join(dir, 'src', 'fp.c'), 'int\t(*ft_fp(int x))(int)\n{\n\treturn (0);\n}\n');
  const file = headerOf(dir);
  const before = read(file);
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'error');
  assert.match(r.message, /宣言に直せない関数が 1 件/);
  assert.match(r.log, /ft_fp/);
  assert.equal(read(file), before);
  cleanup();
});

test('マーカーが壊れている: エラー (ヘッダは触らない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const file = headerOf(dir);
  fs.writeFileSync(file, read(file).replace(MARKER_END + '\n', ''));
  const before = read(file);
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'error');
  assert.match(r.message, /マーカーが不正/);
  assert.equal(read(file), before);
  cleanup();
});

test('ctags が無い / Universal Ctags ではない: skip + 理由 (ヘッダは触らない)', async () => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const before = read(headerOf(dir));
  const none = await planSync(ctx, { envPath: '/nonexistent-dir' });
  assert.equal(none.kind, 'skip');
  assert.match(none.kind === 'skip' ? none.reason : '', /PATH にありません/);

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fakectags-'));
  fs.writeFileSync(path.join(bin, 'ctags'), '#!/bin/sh\necho "Exuberant Ctags 5.8, Copyright (C) 1996-2009 Darren Hiebert"\n', { mode: 0o755 });
  const fake = await planSync(ctx, { envPath: bin });
  assert.equal(fake.kind, 'skip');
  assert.match(fake.kind === 'skip' ? fake.reason : '', /Universal Ctags ではありません/);
  assert.equal(read(headerOf(dir)), before);
  fs.rmSync(bin, { recursive: true });
  cleanup();
});

test('未保存の変更があるヘッダは書き換えない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  ctx.isFileDirty = (p) => p === headerOf(dir);
  const before = read(headerOf(dir));
  const r = await syncAuto(ctx);
  if (r.status === 'skip' && /ctags/.test(r.message)) return t.skip('ctags が無い');
  assert.equal(r.status, 'skip');
  assert.match(r.message, /未保存/);
  assert.equal(read(headerOf(dir)), before);
  cleanup();
});

/* ───────── 実行時 (段階 0) の同期 ───────── */

test('段階 0: protoSyncOnRun が ON ならヘッダを同期する / 既定 (OFF) では触らない', async (t) => {
  const off = sampleContext('proto-ok');
  const before = read(headerOf(off.dir));
  await runPipeline(off.ctx, { selected: [] });
  assert.equal(read(headerOf(off.dir)), before, '既定は OFF');
  off.cleanup();

  const on = sampleContext('proto-ok', { protoSyncOnRun: true });
  const r = await runPipeline(on.ctx, { selected: [] });
  if (!on.ctx.tools.cc && r.results[0].log.includes('skip')) return t.skip('ctags が無い');
  const prepare = r.results.find((x) => x.id === 'prepare')!;
  if (/ctags/.test(prepare.log) && /\[skip\]/.test(prepare.log)) return t.skip('ctags が無い');
  assert.equal(r.ok, true, prepare.log);
  assert.match(read(headerOf(on.dir)), /ft_strdup/);
  assert.match(prepare.log, /プロトタイプ同期: \[updated\]/);
  on.cleanup();
});

test('段階 0: 同期がエラー (結果が空) なら、後続の段階を実行せずに止める', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { protoSyncOnRun: true, protoSourceDir: 'only-static' });
  fs.mkdirSync(path.join(dir, 'only-static'));
  fs.writeFileSync(path.join(dir, 'only-static', 'a.c'), 'static int f(void)\n{\n\treturn (1);\n}\n');
  const r = await runPipeline(ctx, { selected: ['norminette', 'warnings'] });
  const prepare = r.results[0];
  if (/\[skip\]/.test(prepare.log)) return t.skip('ctags が無い');
  assert.equal(r.ok, false);
  assert.equal(r.stoppedAt?.id, 'prepare');
  assert.match(r.stoppedAt?.reason ?? '', /プロトタイプの同期に失敗/);
  assert.equal(r.results.length, 1, '段階 1 以降は実行されない');
  cleanup();
});

/* ───────── 手書きの宣言との重複 (proto.skipExisting) ───────── */

import { findMarkerLines } from '../src/core/proto';

const HAND_WRITTEN = `size_t\tft_strlen(const char *s);
char\t*ft_strdup(const char *s);
`;

/** proto-ok のヘッダを、「マーカーの外に手書きの宣言があり、ブロックには古い内容が残っている」状態にする */
function withHandWrittenDecls(dir: string, extra = ''): void {
  const f = headerOf(dir);
  const t = read(f);
  fs.writeFileSync(
    f,
    t.replace(`${MARKER_BEGIN}\n`, `//part1\n${HAND_WRITTEN}${extra}\n${MARKER_BEGIN}\nint\t\tft_stale(void);\nunsigned long long\tft_big(unsigned int a, long b);\n`),
  );
}
const blockOf = (text: string) => text.slice(text.indexOf(MARKER_BEGIN) + MARKER_BEGIN.length, text.indexOf(MARKER_END)).split('\n').filter((l) => l.trim() !== '');
const names = (lines: string[]) => lines.map((l) => /(\w+)\(/.exec(l)![1]);

test('マーカーの行番号を返す (1 組で、順序が正しいときだけ)', () => {
  assert.deepEqual(findMarkerLines(`a\n${MARKER_BEGIN}\nx\n${MARKER_END}\n`), { begin: 2, end: 4 });
  assert.equal(findMarkerLines('a\n'), undefined);
  assert.equal(findMarkerLines(`${MARKER_END}\n${MARKER_BEGIN}\n`), undefined);
  assert.equal(findMarkerLines(`${MARKER_BEGIN}\n${MARKER_BEGIN}\n${MARKER_END}\n`), undefined);
});

test('手書きの宣言 (マーカーの外) がある関数は、ブロックに入れない。ブロックの中の古い宣言は、判定に使わない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  withHandWrittenDecls(dir);
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'updated', r.message);
  const h = read(headerOf(dir));
  assert.deepEqual(names(blockOf(h)), ['ft_big', 'ft_lstnew', 'ft_lstpick'], 'ft_strlen / ft_strdup は手書きがあるので入らない。ft_big は古いブロックにあったが、手書きではないので入る');
  assert.ok(!h.includes('ft_stale'), '定義の無い古い宣言はブロックから消える');
  assert.equal((h.match(/ft_strlen/g) ?? []).length, 1, '重複しない');
  assert.equal((h.match(/ft_strdup/g) ?? []).length, 1);
  assert.ok(h.includes(HAND_WRITTEN), '手書きの宣言には触らない');
  cleanup();
});

test('proto.skipExisting が OFF なら、手書きの宣言があっても全てブロックに入れる', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { protoSkipExisting: false });
  withHandWrittenDecls(dir);
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.deepEqual(names(blockOf(read(headerOf(dir)))), ['ft_big', 'ft_lstnew', 'ft_lstpick', 'ft_strdup', 'ft_strlen']);
  cleanup();
});

const MAIN_WITH_TESTS = 'int\todd_modifytoupper(void)\n{\n\treturn (0);\n}\n\nint\tmain(void)\n{\n\treturn (0);\n}\n';

test('main.c (normExclude) のテスト用関数は、ブロックに入れない。サブディレクトリの main.c も同じ', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { normExclude: ['main.c'] });
  fs.writeFileSync(path.join(dir, 'main.c'), MAIN_WITH_TESTS);
  fs.writeFileSync(path.join(dir, 'src', 'main.c'), MAIN_WITH_TESTS.replace('odd_modifytoupper', 'odd_sub'));
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'updated', r.message);
  const h = read(headerOf(dir));
  assert.ok(!h.includes('odd_modifytoupper') && !h.includes('odd_sub'), 'main.c の関数は入らない');
  assert.ok(names(blockOf(h)).includes('ft_strlen'), '他のファイルの関数は入る');
  cleanup();
});

test('normExclude を空にすれば、main.c の関数も入る', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { normExclude: [] });
  fs.writeFileSync(path.join(dir, 'main.c'), MAIN_WITH_TESTS);
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.ok(names(blockOf(read(headerOf(dir)))).includes('odd_modifytoupper'));
  cleanup();
});

test('全ての .c が normExclude で除外されていれば、理由を言ってエラー (ヘッダは触らない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { normExclude: ['*.c'] });
  const before = read(headerOf(dir));
  const plan = await planSync(ctx);
  if (plan.kind === 'skip') return t.skip('ctags が無い');
  assert.equal(plan.kind, 'error');
  assert.match((plan as { reason: string }).reason, /normExclude で除外/);
  assert.equal(read(headerOf(dir)), before);
  cleanup();
});

test('既定は ON (DEFAULT_SETTINGS と package.json が一致)', () => {
  assert.equal(DEFAULT_SETTINGS.protoSkipExisting, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  assert.equal(pkg.contributes.configuration.properties['c42checker.proto.skipExisting'].default, true);
});

test('全ての関数が手書きで宣言済みなら、ブロックは空になる (エラーではない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const all = ['size_t\tft_strlen(const char *s);', 'char\t*ft_strdup(const char *s);', 'unsigned long long\tft_big(unsigned int a, long b);', 't_list\t*ft_lstnew(void *content);', 't_list\t**ft_lstpick(t_list **lst, void *(*f)(void *));'];
  fs.writeFileSync(headerOf(dir), read(headerOf(dir)).replace(`${MARKER_BEGIN}\n`, `${all.join('\n')}\n\n${MARKER_BEGIN}\n`));
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'unchanged', 'ブロックは元から空');
  assert.deepEqual(blockOf(read(headerOf(dir))), []);
  cleanup();
});

test('関数名の桁は、手書きの宣言の桁に揃える (狭くしない)。複数行の宣言も数える', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  withHandWrittenDecls(dir, 'unsigned long long\tft_wide(unsigned int a,\n\t\tlong b);\n'); // 名前は 20 桁目
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  const lines = blockOf(read(headerOf(dir)));
  assert.ok(lines.some((l) => /^t_list\t{4}\*ft_lstnew\(/.test(l)), `t_list (6) は 20 桁まで: タブ 4 つ\n${lines.join('\n')}`);
  assert.ok(lines.some((l) => /^unsigned long long\tft_big\(/.test(l)));
  cleanup();
});

test('手書きの宣言が 20 桁で揃っていれば、ブロックも 20 桁に揃い、norminette (MISALIGNED_FUNC_DECL) を通る', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const f = headerOf(dir);
  const hand = 'size_t\t\t\t\tft_strlen(const char *s);\nchar\t\t\t\t*ft_strdup(const char *s);\nunsigned long long\tft_wide(unsigned int a, long b);\n'; // どれも名前が 20 桁目
  fs.writeFileSync(f, read(f).replace(`${MARKER_BEGIN}\n`, `${hand}\n${MARKER_BEGIN}\n`));
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.deepEqual(names(blockOf(read(f))), ['ft_big', 'ft_lstnew', 'ft_lstpick']);
  if (ctx.tools.norminette) assert.equal(r.norm?.status, 'pass', r.norm?.log);
  cleanup();
});

test('手書きの桁 (8 桁) より、ブロックに必要な桁 (20 桁) が広いと揃えられない: norminette が指摘する (手書きの側は直せない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  withHandWrittenDecls(dir); // 手書きは 8 桁。ブロックの ft_big は unsigned long long で 20 桁が要る
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  if (!ctx.tools.norminette) return t.skip('norminette が無い');
  assert.equal(r.norm?.status, 'fail');
  assert.match(r.norm?.log ?? '', /MISALIGNED_FUNC_DECL/);
  assert.match(r.message, /norminette が指摘/, '反映後に、指摘があることが分かる');
  cleanup();
});

test('マーカーが無いヘッダ: 手書きの宣言は全て「既存」とみなし、提案からも除く', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const f = headerOf(dir);
  fs.writeFileSync(f, read(f).replace(`${MARKER_BEGIN}\n${MARKER_END}\n`, HAND_WRITTEN));
  const before = read(f);
  const plan = await planSync(ctx);
  if (plan.kind === 'skip') return t.skip('ctags が無い');
  assert.equal(plan.kind, 'needs-markers');
  if (plan.kind === 'needs-markers') {
    assert.equal(plan.skippedExisting, 2);
    assert.deepEqual(names(blockOf(plan.newText)), ['ft_big', 'ft_lstnew', 'ft_lstpick']);
  }
  assert.equal(read(f), before);
  cleanup();
});

/* ───────── 手書きの宣言を、ソースの型に合わせる (proto.updateExisting) ───────── */

test('型の比較: 引数の名前と空白の違いは無視し、型の違いは見分ける', () => {
  const key = (base: string, stars: string, params: string) => typeKey(base, stars, params);
  assert.equal(key('size_t', '', '(const char *s)'), key('size_t', '', '(const char *)'), '名前の有無');
  assert.equal(key('char', '*', '(const char *s)'), key('char', '*', '(const char* str)'), '名前と空白');
  assert.equal(key('int', '', '(void)'), key('int', '', '(void)'));
  assert.equal(key('int', '', '(unsigned int a, long b)'), key('int', '', '(unsigned int, long)'), 'unsigned int の int を名前と取り違えない');
  assert.equal(key('t_list', '*', '(void *(*f)(void *), int n)'), key('t_list', '*', '(void *(*)(void *), int)'), '関数ポインタの名前');
  assert.equal(key('int', '', '(struct s_list *lst)'), key('int', '', '(struct s_list *)'), 'struct の タグ名を名前と取り違えない');
  assert.notEqual(key('int', '', '(char *s)'), key('int', '', '(const char *s)'), 'const の違い');
  assert.notEqual(key('int', '', '(int a)'), key('long', '', '(int a)'), '戻り値の型');
  assert.notEqual(key('int', '', '(int a)'), key('int', '*', '(int a)'), '戻り値のポインタ');
  assert.notEqual(key('int', '', '(int a, int b)'), key('int', '', '(int a)'), '引数の数');
  assert.notEqual(key('int', '', '(struct s_a *p)'), key('int', '', '(struct s_b *p)'), 'struct のタグ');
});

test('alignExisting: 型が違う宣言だけを、元の桁を保って書き換える (複数行の宣言は 1 行にまとめる)', () => {
  const lines = ['//part1', 'int\t\tft_a(char *s);', 'char\t*ft_b(const char *s,', '\t\t\tint n);', 'void\tft_c(void);', 'int\t\tft_same(int x);'];
  const want = (name: string, base: string, stars: string, params: string) => ({ name, file: 'x.c', base, stars, params });
  const existing = [
    { name: 'ft_a', file: 'h', line: 2, end: 2, typeref: 'typename:int', signature: '(char * s)', isStatic: false },
    { name: 'ft_b', file: 'h', line: 3, end: 4, typeref: 'typename:char *', signature: '(const char * s,int n)', isStatic: false },
    { name: 'ft_c', file: 'h', line: 5, end: 5, typeref: 'typename:void', signature: '(void)', isStatic: false },
    { name: 'ft_same', file: 'h', line: 6, end: 6, typeref: 'typename:int', signature: '(int x)', isStatic: false },
  ];
  const edits = alignExisting(lines, existing, [
    want('ft_a', 'size_t', '', '(const char *s)'),
    want('ft_b', 'char', '*', '(const char *s, size_t n)'),
    want('ft_c', 'void', '', '(void)'),
    want('ft_same', 'int', '', '(int y)'),
  ]);
  assert.deepEqual(edits.map((e) => e.name), ['ft_a', 'ft_b'], '型が同じ ft_c と、名前だけ違う ft_same は触らない');
  assert.equal(edits[0].after, 'size_t\tft_a(const char *s);', '桁 (8) を保つ (size_t は 6 桁なので、タブは 1 つ)');
  assert.equal(edits[1].after, 'char\t*ft_b(const char *s, size_t n);', '複数行が 1 行になる');
  assert.deepEqual([edits[1].line, edits[1].end], [3, 4]);
  assert.equal(applyDeclEdits(lines.join('\n'), edits), ['//part1', 'size_t\tft_a(const char *s);', 'char\t*ft_b(const char *s, size_t n);', 'void\tft_c(void);', 'int\t\tft_same(int x);'].join('\n'));
});

test('alignExisting: コメント・extern・インデントがある宣言や、1 行に複数の宣言は触らない', () => {
  const lines = ['int\tft_a(char *s); // memo', 'extern int\tft_b(char *s);', '  int\tft_c(char *s);', 'int\tft_d(char *s); int\tft_e(char *s);'];
  const mk = (name: string, line: number) => ({ name, file: 'h', line, end: line, typeref: 'typename:int', signature: '(char * s)', isStatic: false });
  const existing = ['ft_a', 'ft_b', 'ft_c', 'ft_d', 'ft_e'].map((n, i) => mk(n, Math.min(i + 1, 4)));
  const entries = existing.map((e) => ({ name: e.name, file: 'x.c', base: 'long', stars: '', params: '(char *s)' }));
  assert.deepEqual(alignExisting(lines, existing, entries), []);
});

const STALE_DECLS = 'int\t\tft_strlen(char *s);\nchar\t*ft_strdup(const char *s, int extra);\n';

test('手書きの宣言の型がソースと違えば、ソースの型に書き換える (名前だけ違う宣言は、そのまま)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  withHandWrittenDecls(dir);
  const f = headerOf(dir);
  fs.writeFileSync(f, read(f).replace(HAND_WRITTEN, STALE_DECLS.replace('(const char *s, int extra)', '(const char *str)')));
  const plan = await planSync(ctx);
  if (plan.kind === 'skip') return t.skip('ctags が無い');
  assert.equal(plan.kind, 'ready');
  const ready = plan as Extract<typeof plan, { kind: 'ready' }>;
  assert.deepEqual(ready.updatedExisting.map((e) => e.name), ['ft_strlen'], 'ft_strdup は引数の名前が違うだけ');
  assert.equal(read(f), ready.oldText, 'plan は書き込まない');

  const r = await syncAuto(ctx);
  assert.equal(r.status, 'updated', r.message);
  assert.match(r.message, /手書きの宣言 1 件をソースの型に合わせました/);
  const h = read(f);
  assert.ok(h.includes('size_t\tft_strlen(const char *s);'), h);
  assert.ok(!h.includes('int\t\tft_strlen(char *s)'));
  assert.ok(h.includes('char\t*ft_strdup(const char *str);'), '名前だけの違いは書き換えない');
  assert.equal((h.match(/ft_strlen/g) ?? []).length, 1, '重複しない');
  assert.equal((await syncAuto(ctx)).status, 'unchanged', '冪等');
  cleanup();
});

test('手書きの宣言が複数行でも、ソースの型に合わせて 1 つにまとめる', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  withHandWrittenDecls(dir);
  const f = headerOf(dir);
  fs.writeFileSync(f, read(f).replace('char\t*ft_strdup(const char *s);', 'char\t*ft_strdup(char *s,\n\t\t\tint extra);'));
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'updated', r.message);
  const h = read(f);
  assert.ok(h.includes('char\t*ft_strdup(const char *s);'), h);
  assert.ok(!h.includes('int extra'));
  cleanup();
});

test('proto.updateExisting が OFF なら、手書きの宣言は書き換えない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { protoUpdateExisting: false });
  withHandWrittenDecls(dir);
  const f = headerOf(dir);
  fs.writeFileSync(f, read(f).replace(HAND_WRITTEN, STALE_DECLS));
  const r = await syncAuto(ctx);
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.ok(read(f).includes(STALE_DECLS), '手書きは触らない');
  cleanup();
});

test('マーカーが無いヘッダでも、手書きの宣言の型の合わせ方を提案に含める (書き込みはしない)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const f = headerOf(dir);
  fs.writeFileSync(f, read(f).replace(/\/\* ---- auto prototypes begin[\s\S]*end ---- \*\/\n/, STALE_DECLS));
  const before = read(f);
  const plan = await planSync(ctx);
  if (plan.kind === 'skip') return t.skip('ctags が無い');
  assert.equal(plan.kind, 'needs-markers');
  const p = plan as Extract<typeof plan, { kind: 'needs-markers' }>;
  assert.ok(p.updatedExisting.some((e) => e.name === 'ft_strlen'));
  assert.ok(p.newText.includes('size_t\tft_strlen(const char *s);'));
  assert.equal(read(f), before);
  cleanup();
});

test('proto.updateExisting: 既定は ON (DEFAULT_SETTINGS と package.json が一致)', () => {
  assert.equal(DEFAULT_SETTINGS.protoUpdateExisting, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  assert.equal(pkg.contributes.configuration.properties['c42checker.proto.updateExisting'].default, true);
});

/* ───────── 他のヘッダが、すでに宣言している関数は入れない ───────── */

const OTHER_DECLS = `#ifndef LIST_H
# define LIST_H

# include "proj.h"

t_list\t*ft_lstnew(void *content);
t_list\t**ft_lstpick(t_list **lst,
\t\t\tvoid *(*f)(void *));

#endif
`;

test('他のヘッダで宣言済みの関数は、ブロックに入れない (他のヘッダは書き換えない)。複数行の宣言も拾う', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const other = path.join(dir, 'includes', 'list.h');
  fs.writeFileSync(other, OTHER_DECLS);
  const plan = await planSync(ctx, { header: headerOf(dir) });
  if (plan.kind === 'skip') return t.skip('ctags が無い');
  assert.equal(plan.kind, 'ready');
  const ready = plan as Extract<typeof plan, { kind: 'ready' }>;
  assert.deepEqual(ready.skippedElsewhere.map((e) => e.name).sort(), ['ft_lstnew', 'ft_lstpick']);
  assert.ok(ready.skippedElsewhere.every((e) => e.header === other));
  assert.match(ready.log, /他のヘッダで宣言済みのため、ブロックに入れません \(2 件\)[\s\S]*ft_lstnew {2}\(includes\/list\.h\)/);
  assert.equal(ready.skippedExisting, 0, '反映先の手書きの宣言ではない');

  const r = await syncAuto(ctx, { header: headerOf(dir) });
  assert.equal(r.status, 'updated', r.message);
  assert.deepEqual(names(blockOf(read(headerOf(dir)))), ['ft_big', 'ft_strdup', 'ft_strlen']);
  assert.equal(read(other), OTHER_DECLS, '他のヘッダは書き換えない');
  cleanup();
});

test('他のヘッダの auto prototypes のブロックの中 (別のヘッダが自動で入れたもの) も、宣言済みとして入れない', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const other = path.join(dir, 'includes', 'list.h');
  const otherText = `#ifndef LIST_H\n# define LIST_H\n${MARKER_BEGIN}\nt_list\t*ft_lstnew(void *content);\n${MARKER_END}\n#endif\n`;
  fs.writeFileSync(other, otherText);
  const r = await syncAuto(ctx, { header: headerOf(dir) });
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.equal(r.status, 'updated', r.message);
  assert.deepEqual(names(blockOf(read(headerOf(dir)))), ['ft_big', 'ft_lstpick', 'ft_strdup', 'ft_strlen'], 'ft_lstnew は他のヘッダのブロックにあるので入らない');
  assert.equal(read(other), otherText, '他のヘッダは書き換えない');
  cleanup();
});

test('両方のヘッダにマーカーがあっても、同じ関数を両方に入れない (先に同期した方に入り、後の方は重複を除く)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok');
  const second = path.join(dir, 'includes', 'second.h');
  fs.writeFileSync(second, `#ifndef SECOND_H\n# define SECOND_H\n${MARKER_BEGIN}\n${MARKER_END}\n#endif\n`);
  const a = await syncAuto(ctx, { header: headerOf(dir) });
  if (a.status === 'skip') return t.skip('ctags が無い');
  const first = names(blockOf(read(headerOf(dir))));
  assert.deepEqual(first, ['ft_big', 'ft_lstnew', 'ft_lstpick', 'ft_strdup', 'ft_strlen'], '先に同期した方に全て入る');
  const b = await syncAuto(ctx, { header: second });
  assert.notEqual(b.status, 'error', b.message);
  assert.deepEqual(names(blockOf(read(second))), [], '後から同期した方には、重複するものを入れない');
  assert.deepEqual(names(blockOf(read(headerOf(dir)))), first, '先の方は変わらない');
  cleanup();
});

test('proto.skipExisting が OFF なら、他のヘッダで宣言済みでも全てブロックに入れる', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('proto-ok', { protoSkipExisting: false });
  fs.writeFileSync(path.join(dir, 'includes', 'list.h'), OTHER_DECLS);
  const r = await syncAuto(ctx, { header: headerOf(dir) });
  if (r.status === 'skip') return t.skip('ctags が無い');
  assert.deepEqual(names(blockOf(read(headerOf(dir)))), ['ft_big', 'ft_lstnew', 'ft_lstpick', 'ft_strdup', 'ft_strlen']);
  cleanup();
});
