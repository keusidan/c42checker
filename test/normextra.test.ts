// Norm v4.1 の (*) 規則 (norminette が検査しない規則) の、自動で判定できる部分。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runCtagsSymbols } from '../src/core/ctags';
import { syncAuto } from '../src/core/proto';
import { findFunctions, localNames, parameterNames, preprocessorLines, scanC, withoutPreprocessor } from '../src/core/cscan';
import { MANUAL_ITEMS, normExtra, RULES, type Finding, type RuleId } from '../src/core/normextra';
import { runPipeline } from '../src/core/pipeline';
import { DEFAULT_CHECKS, DEFAULT_SETTINGS, STEP_IDS } from '../src/core/types';
import { findOnPath } from '../src/core/tools';
import { sampleContext } from './helpers';

const FIELDS = (name: string, by = 'ponzu <ponzu@student.42tokyo.jp>', created = '2026/10/07 12:00:00 by ponzu', updated = '2026/10/07 12:00:00 by ponzu') => `/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   ${name.padEnd(51)}:+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ${by.padEnd(43)}+#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: ${created.padEnd(38)}#+#    #+#             */
/*   Updated: ${updated.padEnd(37)}###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'c42-nx-'));


/** 一時ディレクトリにファイルを書き、normExtra を実行する。 */
async function run(
  files: Record<string, string>,
  opts: { disabled?: string[]; header?: boolean; now?: Date; only?: string[] } = {},
): Promise<{ findings: Finding[]; dir: string; ctags: boolean }> {
  const dir = tmp();
  const abs: Record<string, string> = {};
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, opts.header === false ? body : FIELDS(path.basename(name)) + body);
    abs[name] = p;
  }
  const sources = Object.values(abs).filter((f) => f.endsWith('.c'));
  const headers = Object.values(abs).filter((f) => f.endsWith('.h'));
  const ct = findOnPath('ctags');
  const sym = ct ? await runCtagsSymbols('ctags', headers, dir, 20_000) : undefined;
  const findings = normExtra({
    root: dir,
    files: opts.only ? opts.only.map((n) => abs[n]) : [...sources, ...headers],
    allSources: sources,
    allHeaders: headers,
    includeDirs: [dir],
    disabled: new Set(opts.disabled ?? []),
    shortNames: new Set(DEFAULT_SETTINGS.normExtraShortNames),
    headerSymbols: sym?.ok ? sym.byFile : undefined,
    now: opts.now ?? new Date('2026-10-14T00:00:00'),
  });
  return { findings, dir, ctags: !!sym?.ok };
}

const of = (fs_: Finding[], rule: RuleId) => fs_.filter((f) => f.rule === rule);
const clean = (p: { dir: string }) => fs.rmSync(p.dir, { recursive: true, force: true });

/* ───────────── 字句読み取り ───────────── */

test('scanC: コメントと文字列の中身を空白にし、位置 (文字数・改行) は変えない。コメントの行と行末コメントを記録する', () => {
  const src = 'int a; /* c1 */\n// c2\nchar *s = "/* not */ // x";\nchar c = \'"\';\n';
  const r = scanC(src);
  assert.equal(r.code.length, src.length);
  assert.equal(r.code.split('\n').length, src.split('\n').length);
  assert.ok(!/c1|c2|not/.test(r.code), 'コメントと文字列の中身は消える');
  assert.ok(r.codeWithStrings.includes('"/* not */ // x"'), 'codeWithStrings は文字列を残す');
  assert.deepEqual(r.comments.map((c) => [c.line, c.kind, c.trailing, c.text.trim()]), [
    [1, 'block', true, 'c1'],
    [2, 'line', false, 'c2'],
  ]);
});

test('関数定義の検出: struct / enum / 初期化の波括弧は関数ではない。引数名とローカル変数 (最初の空行まで) を取り出す', () => {
  const src = [
    'struct s_a { int x; };',
    'static int g_arr[2] = { 1, 2 };',
    '#define M(x) { x }',
    'int\tft_foo(const char *str, int (*fn)(int), char buf[4])',
    '{',
    '\tint\t\ti;',
    '\tchar\t*tmp;',
    '\tint\t\t(*cb)(int);',
    '\tunsigned int\tlen = 0;',
    '',
    '\tif (i)',
    '\t{',
    '\t\ti = 2;',
    '\t}',
    '\treturn (0);',
    '}',
    '',
    'void\tft_bar(void)',
    '{',
    '}',
  ].join('\n');
  const s = scanC(src);
  const fns = findFunctions(withoutPreprocessor(s.code));
  assert.deepEqual(fns.map((f) => f.name), ['ft_foo', 'ft_bar']);
  assert.deepEqual(parameterNames(fns[0].params), ['str', 'fn', 'buf']);
  assert.deepEqual(parameterNames('void'), []);
  assert.deepEqual(parameterNames(''), []);
  assert.deepEqual(parameterNames('int, char *'), [], '型だけ (名前なし) は norminette の担当');
  assert.deepEqual(localNames(withoutPreprocessor(s.code).slice(fns[0].bodyStart, fns[0].bodyEnd)).map((v) => v.name), ['i', 'tmp', 'cb', 'len']);
  assert.equal(preprocessorLines(s.codeWithStrings)[0].directive, 'define');
});

/* ───────────── III.5 ヘッダ ───────────── */

test('header-content: ヘッダに関数の定義があれば error。プロトタイプ・struct・マクロだけなら問題なし', async () => {
  const p = await run({
    'a.h': '#ifndef A_H\n# define A_H\n\ntypedef struct s_a\n{\n\tint\tx;\n}\tt_a;\n\nint\tft_proto(int x);\n\nstatic inline int\tft_inline(int x)\n{\n\treturn (x);\n}\n\n#endif\n',
    'b.h': '#ifndef B_H\n# define B_H\n\nint\tft_ok(int x);\n\n#endif\n',
  });
  const f = of(p.findings, 'header-content');
  assert.equal(f.length, 1);
  assert.equal(f[0].strength, 'error');
  assert.match(f[0].message, /ft_inline/);
  assert.ok(f[0].file.endsWith('a.h'));
  clean(p);
});

test('unused-include (標準ヘッダ): 使っていなければ error。使っている / コメントで理由がある / 表にないヘッダは問題なし', async () => {
  const p = await run({
    'a.c': '#include <stdlib.h>\n#include <unistd.h>\n#include <string.h>\n#include <stdio.h>\n#include <readline/readline.h>\n#include <limits.h> // for INT_MAX in the macro below\n/* needed by the tests */\n#include <ctype.h>\n\nint\tft_a(char *s)\n{\n\tchar\t*p;\n\n\tp = malloc(2);\n\twrite(1, s, 1);\n\treturn (0);\n}\n',
  });
  const f = of(p.findings, 'unused-include');
  assert.deepEqual(f.map((x) => /<(\w+\.h)>/.exec(x.message)![1]).sort(), ['stdio.h', 'string.h'], 'stdlib (malloc) と unistd (write) は使用、limits と ctype はコメントで理由あり、readline は判定しない');
  assert.ok(f.every((x) => x.strength === 'error'));
  clean(p);
});

test('unused-include (標準ヘッダ): 複数のヘッダが提供する名前 (size_t / NULL) だけを使っているなら、使っているとみなす (甘い側)', async () => {
  const p = await run({ 'a.c': '#include <stdlib.h>\n\nsize_t\tft_a(void)\n{\n\treturn (0);\n}\n' });
  assert.deepEqual(of(p.findings, 'unused-include'), []);
  clean(p);
});

test('unused-include (プロジェクトのヘッダ): ctags で名前を取り出し、使っていなければ error。ヘッダ経由 (入れ子) の使用や、ヘッダの include を使う .c があれば問題なし', async (t) => {
  const p = await run({
    'dep.h': '#ifndef DEP_H\n# define DEP_H\n\n# include <stdlib.h>\n\nint\tdep_fn(int x);\n\n#endif\n',
    'unused.h': '#ifndef UNUSED_H\n# define UNUSED_H\n\nint\tunused_fn(int x);\n\n#endif\n',
    'a.c': '#include "dep.h"\n#include "unused.h"\n\nint\tft_a(void)\n{\n\treturn (dep_fn(1));\n}\n',
    'b.c': '#include "dep.h"\n\nvoid\t*ft_b(void)\n{\n\treturn (malloc(1));\n}\n',
  });
  if (!p.ctags) {
    clean(p);
    return t.skip('universal-ctags が無い');
  }
  const f = of(p.findings, 'unused-include');
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].message, /"unused\.h"/);
  assert.ok(f[0].file.endsWith('a.c'));
  assert.equal(f[0].strength, 'error');
  // dep.h の <stdlib.h> は、dep.h 自身では使っていないが、dep.h を include する b.c が malloc を使っているので問題なし
  assert.deepEqual(f.filter((x) => x.file.endsWith('dep.h')), []);
  clean(p);
});

test('unused-include: ctags が無いとき (headerSymbols なし) は、プロジェクトのヘッダの include を判定しない', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.h'), FIELDS('x.h') + '#ifndef X_H\n# define X_H\nint\tx_fn(void);\n#endif\n');
  fs.writeFileSync(path.join(dir, 'a.c'), FIELDS('a.c') + '#include "x.h"\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n');
  const f = normExtra({
    root: dir,
    files: [path.join(dir, 'a.c')],
    allSources: [path.join(dir, 'a.c')],
    allHeaders: [path.join(dir, 'x.h')],
    includeDirs: [dir],
    disabled: new Set(),
    shortNames: new Set(),
  });
  assert.deepEqual(of(f, 'unused-include'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ───────────── III.6 42 ヘッダ ───────────── */

test('42header: 既定の marvin / 学生メールでない / 日時が不正 / 更新が作成より前 → error。正しいヘッダは問題なし', async () => {
  const mk = (name: string, by: string, created: string, updated: string) => FIELDS(name, by, created, updated) + 'int\tg_x;\n';
  const dir = tmp();
  const w = (n: string, body: string) => fs.writeFileSync(path.join(dir, n), body);
  w('good.h', mk('good.h', 'ponzu <ponzu@student.42tokyo.jp>', '2026/10/07 12:00:00 by ponzu', '2026/10/08 12:00:00 by ponzu'));
  w('marvin.h', mk('marvin.h', 'marvin <marvin@42.fr>', '2026/10/07 12:00:00 by marvin', '2026/10/07 12:00:00 by marvin'));
  w('mail.h', mk('mail.h', 'ponzu <ponzu@gmail.com>', '2026/10/07 12:00:00 by ponzu', '2026/10/07 12:00:00 by ponzu'));
  w('date.h', mk('date.h', 'ponzu <ponzu@student.42tokyo.jp>', '2026/13/40 12:00:00 by ponzu', '2026/10/07 12:00:00 by ponzu'));
  w('order.h', mk('order.h', 'ponzu <ponzu@student.42tokyo.jp>', '2026/10/09 12:00:00 by ponzu', '2026/10/07 12:00:00 by ponzu'));
  w('future.h', mk('future.h', 'ponzu <ponzu@student.42tokyo.jp>', '2026/10/07 12:00:00 by ponzu', '2030/01/01 00:00:00 by ponzu'));
  w('name.h', mk('other.h', 'ponzu <ponzu@student.42tokyo.jp>', '2026/10/07 12:00:00 by ponzu', '2026/10/07 12:00:00 by ponzu'));
  const files = fs.readdirSync(dir).map((n) => path.join(dir, n));
  const f = normExtra({ root: dir, files, allSources: [], allHeaders: files, includeDirs: [dir], disabled: new Set(), shortNames: new Set(), now: new Date('2026-10-14T00:00:00') });
  const by = (n: string) => f.filter((x) => x.file.endsWith(n) && x.rule === '42header');
  assert.deepEqual(by('good.h'), []);
  assert.equal(by('marvin.h')[0].strength, 'error');
  assert.match(by('marvin.h')[0].message, /既定の値/);
  assert.equal(by('mail.h')[0].strength, 'error');
  assert.match(by('mail.h')[0].message, /学生メール/);
  assert.equal(by('date.h')[0].strength, 'error');
  assert.match(by('order.h')[0].message, /作成日時より前/);
  assert.equal(by('future.h')[0].strength, 'review');
  assert.match(by('name.h')[0].message, /other\.h/);
  assert.equal(by('name.h')[0].strength, 'review');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('42header: ヘッダが読み取れないファイルは review (形式そのものは norminette の担当)', async () => {
  const p = await run({ 'a.h': '#ifndef A_H\n# define A_H\n#endif\n' }, { header: false });
  const f = of(p.findings, '42header');
  assert.equal(f.length, 1);
  assert.equal(f[0].strength, 'review');
  clean(p);
});

/* ───────────── III.7 マクロ ───────────── */

test('define: 制御構文・文・三項演算子・代入を隠したものは error、関数形式は review、定数でない値は review、リテラルや既知の定数は問題なし', async () => {
  const p = await run({
    'm.h': [
      '#ifndef M_H',
      '# define M_H',
      '',
      '# define BUFFER_SIZE 42',
      '# define GREETING "hello"',
      '# define SEP \'/\'',
      '# define TWICE (BUFFER_SIZE * 2)',
      '# define BYTES (sizeof(int) * BUFFER_SIZE)',
      '# define BIG INT_MAX',
      '# define NIL ((void *)0)',
      '# define MAXSZ ((size_t)-1)',
      '# define RET return',
      '# define LOOP while (1)',
      '# define MAX(a, b) ((a) > (b) ? (a) : (b))',
      '# define SET x = 3',
      '# define STMT do_it();',
      '# define SQUARE(x) ((x) * (x))',
      '# define NOW time(0)',
      '# define UNKNOWN other_thing',
      '# define EQ (BUFFER_SIZE == 42)',
      '',
      '#endif',
      '',
    ].join('\n'),
  });
  const by = (name: string) => p.findings.filter((x) => x.message.includes(`#define ${name} `) || x.message.includes(`マクロ ${name}(`));
  for (const ok of ['BUFFER_SIZE', 'GREETING', 'SEP', 'TWICE', 'BYTES', 'BIG', 'NIL', 'MAXSZ', 'EQ']) assert.deepEqual(by(ok), [], ok);
  for (const bad of ['RET', 'LOOP', 'MAX', 'SET', 'STMT']) {
    assert.equal(by(bad)[0]?.rule, 'define-bypass', bad);
    assert.equal(by(bad)[0].strength, 'error');
  }
  assert.match(by('MAX')[0].message, /三項演算子/);
  assert.match(by('SET')[0].message, /代入/);
  assert.equal(by('SQUARE')[0].rule, 'define-function-like');
  assert.equal(by('SQUARE')[0].strength, 'review');
  assert.equal(by('NOW')[0].rule, 'define-nonconst');
  assert.match(by('NOW')[0].message, /time/);
  assert.equal(by('UNKNOWN')[0].rule, 'define-nonconst');
  assert.equal(by('UNKNOWN')[0].strength, 'review');
  clean(p);
});

test('define: プロジェクト内で定義した別のマクロを使う値は、定数として扱う', async () => {
  const p = await run({
    'a.h': '#ifndef A_H\n# define A_H\n\n# define WIDTH 10\n\n#endif\n',
    'b.h': '#ifndef B_H\n# define B_H\n\n# define AREA (WIDTH * WIDTH)\n\n#endif\n',
  });
  assert.deepEqual(of(p.findings, 'define-nonconst'), []);
  clean(p);
});

/* ───────────── III.9 コメント ───────────── */

test('comment: ASCII 以外 (日本語など) は error。空・TODO・コメントアウトしたコードは review。普通の英語のコメントと、プロトタイプのマーカーは問題なし', async () => {
  const p = await run({
    'a.c': [
      '/* Counts the characters of a string. */',
      '/* ライブラリのテスト */',
      '/* */',
      '/* ------------------ */',
      '// TODO: handle NULL',
      '// i++;',
      '/* if (x) { */',
      '/* ---- auto prototypes begin ---- */',
      '/* ---- auto prototypes end ---- */',
      '',
      'int\tft_a(void)',
      '{',
      '\treturn (0); // always zero',
      '}',
      '',
    ].join('\n'),
  });
  const f = p.findings.filter((x) => x.rule.startsWith('comment-'));
  const at = (line: number) => f.filter((x) => x.line === line + 12); // 42 ヘッダ 11 行 + 空行 1 行ぶん下がる
  assert.deepEqual(at(1), [], '普通の英語');
  assert.equal(at(2)[0]?.rule, 'comment-non-english');
  assert.equal(at(2)[0].strength, 'error');
  assert.equal(at(3)[0]?.rule, 'comment-useless');
  assert.equal(at(4)[0]?.rule, 'comment-useless');
  assert.equal(at(5)[0]?.rule, 'comment-useless');
  assert.match(at(5)[0].message, /TODO/);
  assert.equal(at(6)[0]?.rule, 'comment-useless');
  assert.match(at(6)[0].message, /コメントアウト/);
  assert.equal(at(7)[0]?.rule, 'comment-useless');
  assert.deepEqual(at(8).concat(at(9)), [], 'auto prototypes のマーカー');
  assert.deepEqual(at(13), [], '行末の英語のコメント');
  assert.equal(f.filter((x) => x.line <= 11).length, 0, '42 ヘッダの中は見ない');
  assert.ok(at(3)[0].strength === 'review');
  clean(p);
});

test('comment-norm-excuse: norm のために関数を分けた、という説明は review', async () => {
  const p = await run({ 'a.c': '/* Split from ft_x because norm limits functions to 25 lines. */\nint\tft_x_tail(void)\n{\n\treturn (0);\n}\n' });
  const f = of(p.findings, 'comment-norm-excuse');
  assert.equal(f.length, 1);
  assert.equal(f[0].strength, 'review');
  clean(p);
});

/* ───────────── 名前 ───────────── */

test('bad-function-name / bad-variable-name / bad-file-name: 意味の分からない名前・連番の名前は review。許可した 1 文字・普通の名前・main は問題なし', async () => {
  const p = await run({
    'a.c': [
      'int\tf1(int a, int count)',
      '{',
      '\tint\ti;',
      '\tint\tx1;',
      '\tchar\t*str;',
      '',
      '\treturn (count);',
      '}',
      '',
      'int\tft_split2(char *s)',
      '{',
      '\treturn (0);',
      '}',
      '',
      'int\tft_split_part2(char *s)',
      '{',
      '\treturn (0);',
      '}',
      '',
      'int\tft_base64_len(char *s)',
      '{',
      '\treturn (0);',
      '}',
      '',
      'int\tft_utf8(char *s)',
      '{',
      '\treturn (0);',
      '}',
      '',
      'int\tmain(void)',
      '{',
      '\treturn (0);',
      '}',
      '',
    ].join('\n'),
    'b.c': 'int\tft_b(void)\n{\n\treturn (0);\n}\n',
    'x.c': 'int\tft_x(void)\n{\n\treturn (0);\n}\n',
  });
  const fn = of(p.findings, 'bad-function-name').map((x) => /関数名 (\w+)/.exec(x.message)![1]).sort();
  assert.deepEqual(fn, ['f1', 'ft_split2', 'ft_split_part2']);
  const vars = of(p.findings, 'bad-variable-name').map((x) => /名 (\w+)/.exec(x.message)![1]).sort();
  assert.deepEqual(vars, ['a', 'x1'], 'i は許可。count / str は普通の名前');
  assert.deepEqual(of(p.findings, 'bad-file-name').map((x) => path.basename(x.file)).sort(), ['a.c', 'b.c', 'x.c']);
  assert.ok([...of(p.findings, 'bad-function-name'), ...of(p.findings, 'bad-variable-name'), ...of(p.findings, 'bad-file-name')].every((x) => x.strength === 'review'));
  clean(p);
});

test('設定 normExtra.disable: 指定した規則は検査しない', async () => {
  const files = { 'a.c': '/* ライブラリ */\nint\tf1(void)\n{\n\treturn (0);\n}\n' };
  const all = await run(files);
  assert.ok(of(all.findings, 'comment-non-english').length > 0 && of(all.findings, 'bad-function-name').length > 0);
  const off = await run(files, { disabled: ['comment-non-english', 'bad-function-name'] });
  assert.deepEqual(of(off.findings, 'comment-non-english').concat(of(off.findings, 'bad-function-name')), []);
  clean(all);
  clean(off);
});

/* ───────────── 規則の一覧と設定 ───────────── */

test('規則の一覧: id が重複せず、package.json の enum と同じ。Norm (*) の 11 項目に対応する説明がある', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown; items?: { enum?: string[] } }> } };
  };
  const props = pkg.contributes.configuration.properties;
  assert.deepEqual([...(props['c42check.normExtra.disable'].items?.enum ?? [])].sort(), [...ids].sort());
  assert.deepEqual(props['c42check.normExtra.disable'].default, DEFAULT_SETTINGS.normExtraDisable);
  assert.equal(props['c42check.normExtra.reviewAsFail'].default, DEFAULT_SETTINGS.normExtraReviewAsFail);
  assert.deepEqual(props['c42check.normExtra.shortNames'].default, DEFAULT_SETTINGS.normExtraShortNames);
  assert.ok(MANUAL_ITEMS.length >= 5, '機械では判定できない項目をチェックリストとして持つ');
  assert.ok(STEP_IDS.includes('normExtra') && STEP_IDS.includes('makefile'));
  assert.equal(DEFAULT_CHECKS.normExtra, true);
  assert.equal(DEFAULT_CHECKS.makefile, true);
  assert.deepEqual(
    Object.entries(props['c42check.checks'].default as Record<string, boolean>).sort(),
    Object.entries(DEFAULT_CHECKS).sort(),
    'package.json の checks の既定値が DEFAULT_CHECKS と一致',
  );
});

/* ───────────── step として ───────────── */

const stepOf = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id)!;

test('step: 全てのサンプル (norm 準拠) で error が出ない。log に規則の一覧と、機械では判定できない項目のチェックリストが出る', async () => {
  for (const [name, over] of [['ok', {}], ['norm-ng', {}], ['bug-asan', {}], ['proto-ok', {}], ['lib-ok', { mainFile: 'tests/test_main.c' }]] as const) {
    const { ctx, cleanup } = sampleContext(name, over);
    // proto-ok は、ヘッダの自動ブロックが空のままだと「ヘッダが何も宣言していない = include は不要」と正しく判定される。同期してから検査する
    if (name === 'proto-ok' && (await syncAuto(ctx)).status === 'skip') {
      cleanup();
      continue;
    }
    const r = await runPipeline(ctx, { selected: ['normExtra'] });
    const s = stepOf(r, 'normExtra');
    assert.notEqual(s.status, 'fail', `${name}: ${s.log}`);
    assert.ok(s.diags.every((d) => d.severity !== 'error'), `${name}: ${JSON.stringify(s.diags)}`);
    for (const rule of RULES) assert.ok(s.log.includes(`[${rule.id}]`), `${name}: log に ${rule.id}`);
    assert.match(s.log, /機械では判定できない項目/);
    assert.match(s.log, /\[ \] III\.1 \(\*\)/);
    cleanup();
  }
});

test('step: error があれば fail (診断は Problems 用に、規則の id と行つきで返る)。review だけなら pass、reviewAsFail なら fail', async () => {
  const bad = sampleContext('ok');
  fs.writeFileSync(path.join(bad.dir, 'str_utils.h'), fs.readFileSync(path.join(bad.dir, 'str_utils.h'), 'utf8').replace('#endif', 'int\tft_inline(int x)\n{\n\treturn (x);\n}\n\n#endif'));
  const r = await runPipeline(bad.ctx, { selected: ['normExtra'] });
  const s = stepOf(r, 'normExtra');
  assert.equal(s.status, 'fail');
  assert.equal(r.ok, false);
  assert.match(s.reason ?? '', /error 1 件/);
  assert.match(s.hint ?? '', /normExtra\.disable/);
  const d = s.diags.find((x) => x.message.startsWith('[header-content]'))!;
  assert.equal(d.severity, 'error');
  assert.ok(d.file.endsWith('str_utils.h') && d.line > 0);
  assert.equal(d.source, 'norm-extra');
  bad.cleanup();

  const rev = sampleContext('ok');
  fs.writeFileSync(path.join(rev.dir, 'str_utils.c'), fs.readFileSync(path.join(rev.dir, 'str_utils.c'), 'utf8') + '\nint\tf1(void)\n{\n\treturn (0);\n}\n');
  const r1 = await runPipeline(rev.ctx, { selected: ['normExtra'] });
  const s1 = stepOf(r1, 'normExtra');
  assert.equal(s1.status, 'pass', 'review だけなら fail にしない');
  assert.match(s1.reason ?? '', /review 1 件 \(fail にはしません\)/);
  assert.ok(s1.diags.some((x) => x.severity === 'warning' && /\[bad-function-name\]/.test(x.message)));
  rev.ctx.settings.normExtraReviewAsFail = true;
  const r2 = await runPipeline(rev.ctx, { selected: ['normExtra'] });
  assert.equal(stepOf(r2, 'normExtra').status, 'fail', 'reviewAsFail なら fail');
  rev.cleanup();
});

test('step: normExclude (main.c) は検査しない。全て除外されれば skip。設定の disable で規則を外せる', async () => {
  const a = sampleContext('ok', { normExclude: [] });
  fs.writeFileSync(path.join(a.dir, 'main.c'), fs.readFileSync(path.join(a.dir, 'main.c'), 'utf8').replace('int\tmain', '/* メイン */\nint\tmain'));
  const bad = stepOf(await runPipeline(a.ctx, { selected: ['normExtra'] }), 'normExtra');
  assert.equal(bad.status, 'fail');
  a.ctx.settings.normExclude = ['main.c'];
  assert.equal(stepOf(await runPipeline(a.ctx, { selected: ['normExtra'] }), 'normExtra').status, 'pass', 'main.c は検査しない');
  a.ctx.settings.normExclude = [];
  a.ctx.settings.normExtraDisable = ['comment-non-english'];
  assert.equal(stepOf(await runPipeline(a.ctx, { selected: ['normExtra'] }), 'normExtra').status, 'pass', 'disable した規則は検査しない');
  a.ctx.settings.normExclude = ['*.c', '*.h'];
  a.ctx.settings.normExtraDisable = [];
  const sk = stepOf(await runPipeline(a.ctx, { selected: ['normExtra'] }), 'normExtra');
  assert.equal(sk.status, 'skip');
  assert.match(sk.reason ?? '', /normExclude で除外/);
  a.cleanup();
});

test('step: 段階 1 の fail は段階 2 を止める (normExtra の error も他の段階 1 と同じ)', async (t) => {
  const { ctx, dir, cleanup } = sampleContext('ok');
  if (!ctx.tools.cc) {
    cleanup();
    return t.skip('clang が無い');
  }
  fs.writeFileSync(path.join(dir, 'str_utils.c'), fs.readFileSync(path.join(dir, 'str_utils.c'), 'utf8').replace('size_t', '/* 日本語 */\nsize_t'));
  const r = await runPipeline(ctx, { selected: ['normExtra', 'asanUbsan'] });
  assert.equal(stepOf(r, 'normExtra').status, 'fail');
  assert.equal(r.results.find((x) => x.id === 'asanUbsan'), undefined, '段階 1 が fail なので段階 2 は実行しない');
  assert.deepEqual(r.notRun.map((x) => x.id), ['asanUbsan']);
  cleanup();
});


/* ───────────── 引数名を検査するか (オプション) ───────────── */

const MEMCMP = 'int\tft_memcmp(const void *s1, const void *s2, size_t n)\n{\n\tunsigned char\t*p1;\n\n\tp1 = (unsigned char *)s1;\n\treturn (*p1 - *(unsigned char *)s2 + (int)n);\n}\n';

test('checkParameterNames: 既定は検査する。false なら引数名 (s1 / s2) は検査しないが、ローカル変数 (p1) は検査する', async () => {
  const names = (fs_: Finding[]) => of(fs_, 'bad-variable-name').map((x) => /(引数|変数)名 (\w+)/.exec(x.message)!.slice(1, 3).join(':')).sort();
  const on = await run({ 'ft_memcmp.c': MEMCMP }, { header: true });
  assert.deepEqual(names(on.findings), ['変数:p1', '引数:s1', '引数:s2'], 'ユーザーの例: s1 / s2 が引数として検出される');
  clean(on);

  const dir = tmp();
  const f = path.join(dir, 'ft_memcmp.c');
  fs.writeFileSync(f, FIELDS('ft_memcmp.c') + MEMCMP);
  const base = { root: dir, files: [f], allSources: [f], allHeaders: [], includeDirs: [dir], disabled: new Set<string>(), shortNames: new Set(DEFAULT_SETTINGS.normExtraShortNames) };
  assert.deepEqual(names(normExtra({ ...base, checkParameterNames: true })), ['変数:p1', '引数:s1', '引数:s2']);
  assert.deepEqual(names(normExtra(base)), ['変数:p1', '引数:s1', '引数:s2'], '未指定は true');
  assert.deepEqual(names(normExtra({ ...base, checkParameterNames: false })), ['変数:p1'], '引数は検査しない。ローカル変数は引き続き検査する');
  assert.deepEqual(names(normExtra({ ...base, checkParameterNames: false, disabled: new Set(['bad-variable-name']) })), [], '規則ごと disable すれば、変数も検査しない');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('設定 normExtra.checkParameterNames: 既定 true (DEFAULT_SETTINGS と package.json が一致)。step に反映される', async () => {
  assert.equal(DEFAULT_SETTINGS.normExtraCheckParameterNames, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { type: string; default: unknown }> } };
  };
  const prop = pkg.contributes.configuration.properties['c42check.normExtra.checkParameterNames'];
  assert.equal(prop.type, 'boolean');
  assert.equal(prop.default, true);

  const mk = (over: Partial<typeof DEFAULT_SETTINGS>) => {
    const { ctx, dir, cleanup } = sampleContext('ok', over);
    fs.writeFileSync(path.join(dir, 'str_utils.c'), fs.readFileSync(path.join(dir, 'str_utils.c'), 'utf8') + '\nint\tft_cmp(const char *s1, const char *s2)\n{\n\treturn (s1 == s2);\n}\n');
    return { ctx, cleanup };
  };
  const a = mk({});
  const sa = (await runPipeline(a.ctx, { selected: ['normExtra'] })).results.find((x) => x.id === 'normExtra')!;
  assert.deepEqual(sa.diags.filter((d) => /\[bad-variable-name\]/.test(d.message)).map((d) => /名 (\w+)/.exec(d.message)![1]).sort(), ['s1', 's2']);
  a.cleanup();
  const b = mk({ normExtraCheckParameterNames: false });
  const sb = (await runPipeline(b.ctx, { selected: ['normExtra'] })).results.find((x) => x.id === 'normExtra')!;
  assert.deepEqual(sb.diags.filter((d) => /\[bad-variable-name\]/.test(d.message)), []);
  b.cleanup();
});
