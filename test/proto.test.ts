import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { exec } from '../src/core/exec';
import { parseTags } from '../src/core/ctags';
import { runPipeline } from '../src/core/pipeline';
import {
  MARKER_BEGIN,
  MARKER_END,
  buildEntries,
  normalizeParams,
  normalizeReturnType,
  planSync,
  proposeInsertion,
  renderBlock,
  replaceBlock,
  syncAuto,
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

test('出力: 戻り値の型の後ろはタブ、* は関数名側、関数名の桁を全体で揃える', () => {
  const mk = (name: string, base: string, stars = '', file = '/w/a.c') => ({ name, file, base, stars, params: '(void)' });
  const { lines } = renderBlock(
    [mk('f1', 'char', '*'), mk('f2', 'size_t'), mk('f3', 'unsigned long long'), mk('f4', 'void', '', '/w/b.c')],
    '/w',
  );
  assert.deepEqual(lines, [
    '/* a.c */',
    'char\t\t\t\t*f1(void);', // 'char'(4) → 20 桁まで: タブ 4 つ
    'size_t\t\t\t\tf2(void);', // 6 → 20 桁: ceil(14/4) = 4
    'unsigned long long\tf3(void);', // 18 → 20 桁: 1
    '',
    '/* b.c */',
    'void\t\t\t\tf4(void);',
  ]);
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
  assert.match(inner, /\/\* src\/str\/ft_strdup\.c \*\//, '再帰したファイルのパスで区切る');
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
