// 設定 c42check.normExtra.removeUnusedIncludes: コンパイラで未使用と確かめた #include を、ファイルから削除する。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createContext } from '../src/core/context';
import { removeLines, shiftLine } from '../src/core/includefix';
import { runPipeline } from '../src/core/pipeline';
import { detectTools } from '../src/core/tools';
import { DEFAULT_SETTINGS, type Context, type Settings } from '../src/core/types';

function project(
  files: Record<string, string>,
  settings: Partial<Settings> = {},
  extra: { dirty?: (f: string) => boolean; tools?: Partial<ReturnType<typeof detectTools>> } = {},
): { ctx: Context; dir: string; read: (f: string) => string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fix-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  const ctx = createContext({
    root: dir,
    settings: { ...DEFAULT_SETTINGS, normExclude: [], normExtraRemoveUnusedIncludes: true, ...settings },
    tools: { ...detectTools(), ...extra.tools },
    io: { log: () => undefined },
    isFileDirty: extra.dirty,
  });
  return { ctx, dir, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const step = (r: Awaited<ReturnType<typeof runPipeline>>) => r.results.find((x) => x.id === 'normExtra')!;
const need = (ctx: Context) => ctx.tools.cc !== undefined;

const A_C = '#include <stdlib.h>\n#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n\nsize_t\tft_a(void)\n{\n\tchar\t*p;\n\n\tp = malloc(2);\n\twrite(1, "x", 1);\n\tfree(p);\n\treturn (0);\n}\n';

test('removeLines: 指定した行を消す。削除の跡に空行が連続しないよう、直後の空行を詰める', () => {
  const text = 'a\n#include <x.h>\n#include <y.h>\n\nint\tf(void);\n';
  assert.equal(removeLines(text, new Set([2, 3])), 'a\n\nint\tf(void);\n', 'include のブロックを全部消すと、前後の空行が 1 つになる');
  assert.equal(removeLines(text, new Set([2])), 'a\n#include <y.h>\n\nint\tf(void);\n', '一部だけなら詰めない');
  assert.equal(removeLines('#include <x.h>\n\nint x;\n', new Set([1])), 'int x;\n', 'ファイルの先頭に空行を残さない');
  assert.equal(removeLines('a\n\n#include <x.h>\n\nb\n', new Set([3])), 'a\n\nb\n', '前後が空行なら 1 つにする');
  assert.equal(removeLines('a\n\n\nb\n', new Set()), 'a\n\n\nb\n', '削除がなければ、元から連続している空行には触らない');
  assert.equal(removeLines('a\r\n#include <x.h>\r\n\r\nb\r\n', new Set([2])).includes('\r\n\r\n\r\n'), false, 'CRLF でも空行が連続しない');
});

test('shiftLine: 削除した行より後ろの行番号は、削除した数だけ前に詰まる', () => {
  assert.equal(shiftLine(10, new Set([2, 3])), 8);
  assert.equal(shiftLine(3, new Set([2, 3])), 2, '手前の削除分だけ詰める');
  assert.equal(shiftLine(1, new Set([2, 3])), 1);
});

test('既定 (OFF) では、未使用の include があっても、ファイルは書き換えない (error のまま)', async (t) => {
  const { ctx, read, cleanup } = project({ 'a.c': A_C }, { normExtraRemoveUnusedIncludes: false });
  if (!need(ctx)) return t.skip('clang が無い');
  assert.equal(DEFAULT_SETTINGS.normExtraRemoveUnusedIncludes, false);
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(s.status, 'fail');
  assert.equal(read('a.c'), A_C);
  assert.ok(!fs.existsSync(path.join(ctx.workDir, 'include-backup')));
  cleanup();
});

test('ON: 未使用の include だけを削除し、変更前を .42check/include-backup/ に退避する。使っているものは残り、step は pass になる', async (t) => {
  const { ctx, read, cleanup } = project({ 'a.c': A_C });
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('a.c'), A_C.replace('#include <stdio.h>\n#include <string.h>\n', ''), 'stdio と string だけが消える');
  assert.equal(s.status, 'pass', s.log + JSON.stringify(s.diags));
  assert.match(s.reason ?? '', /使っていない #include を 2 個削除しました/);
  assert.match(s.log, /a\.c:1 #include <stdio\.h>|a\.c:2 #include <stdio\.h>/);
  assert.match(s.log, /include-backup/);
  assert.equal(fs.readFileSync(path.join(ctx.workDir, 'include-backup', 'a.c'), 'utf8'), A_C, '変更前の内容');
  assert.deepEqual(s.diags.filter((d) => /unused-include/.test(d.message)), []);
  // 2 回目は何も削除しない (冪等)
  const s2 = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(s2.status, 'pass');
  assert.doesNotMatch(s2.reason ?? '', /削除しました/);
  assert.equal(read('a.c'), A_C.replace('#include <stdio.h>\n#include <string.h>\n', ''));
  cleanup();
});

test('ON: include のブロックを全部消しても、空行が連続しない (Norm: 連続する空行は禁止)', async (t) => {
  const src = '#include <stdio.h>\n#include <string.h>\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n';
  const { ctx, read, cleanup } = project({ 'a.c': src });
  if (!need(ctx)) return t.skip('clang が無い');
  await runPipeline(ctx, { selected: ['normExtra'] });
  assert.equal(read('a.c'), 'int\tft_a(void)\n{\n\treturn (0);\n}\n');
  cleanup();
});

test('ON: ヘッダファイルの未使用 include も削除する。include 元 (ヘッダ経由を含む) が使っているものは残す', async (t) => {
  const { ctx, read, cleanup } = project({
    'ft.h': '#ifndef FT_H\n# define FT_H\n\n# include <stdlib.h>\n# include <string.h>\n\nvoid\t*ft_alloc(void);\n\n#endif\n',
    'ft2.h': '#ifndef FT2_H\n# define FT2_H\n\n# include "ft.h"\n\n#endif\n',
    'a.c': '#include "ft2.h"\n\nvoid\t*ft_alloc(void)\n{\n\treturn (malloc(1));\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('ft.h'), '#ifndef FT_H\n# define FT_H\n\n# include <stdlib.h>\n\nvoid\t*ft_alloc(void);\n\n#endif\n', 'string だけが消える。stdlib は ft2.h 経由で a.c が malloc に使う');
  assert.equal(s.status, 'pass', s.log);
  cleanup();
});

test('ON: 提供する名前が重なる include (review) / コメントで理由を書いた include は削除しない', async (t) => {
  const src = '#include <stdlib.h>\n#include <stdio.h>\n#include <ctype.h> // kept on purpose\n\nsize_t\tft_a(void)\n{\n\treturn (0);\n}\n';
  const { ctx, read, cleanup } = project({ 'a.c': src });
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('a.c'), src, '重なる (stdlib / stdio) は、どちらを残すかを人が決める');
  assert.equal(s.status, 'pass', 'review だけなので fail にならない');
  assert.ok(s.diags.some((d) => d.severity === 'warning' && /重なって/.test(d.message)));
  cleanup();
});

test('ON: 削除した行より後ろの review の行番号は、削除後のファイルのものに直る', async (t) => {
  const src = '#include <ctype.h>\n#include <stdlib.h>\n#include <stdio.h>\n\nsize_t\tft_a(void)\n{\n\treturn (0);\n}\n';
  const { ctx, read, cleanup } = project({ 'a.c': src });
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('a.c'), src.replace('#include <ctype.h>\n', ''), 'ctype だけが消える');
  const lines = s.diags.filter((d) => /重なって/.test(d.message)).map((d) => d.line).sort();
  assert.deepEqual(lines, [1, 2], '<stdlib.h> は 1 行目、<stdio.h> は 2 行目になった');
  assert.equal(read('a.c').split('\n')[0], '#include <stdlib.h>');
  cleanup();
});

test('ON: clang が無いとき (名前の表による判定) は、削除しない', async () => {
  const src = A_C.replace('size_t\tft_a', 'int\tft_a'); // size_t は複数のヘッダが提供する名前なので、表でも「使っている」とみなされる。使わない形にする
  const { ctx, read, cleanup } = project({ 'a.c': src }, {}, { tools: { cc: undefined } });
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('a.c'), src, '表による判定は確かめていないので、ファイルは書き換えない');
  assert.equal(s.status, 'fail', 'error のまま');
  cleanup();
});

test('ON: エディタに未保存の変更があるファイルは書き換えない (error のまま)。他のファイルは削除する', async (t) => {
  const { ctx, dir, read, cleanup } = project(
    { 'a.c': A_C, 'b.c': '#include <stdio.h>\n\nint\tft_b(void)\n{\n\treturn (0);\n}\n' },
    {},
    { dirty: (f) => f.endsWith('a.c') },
  );
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('a.c'), A_C);
  assert.equal(read('b.c'), 'int\tft_b(void)\n{\n\treturn (0);\n}\n');
  assert.equal(s.status, 'fail');
  assert.match(s.log, /未保存の変更があるため、削除しなかった include: a\.c:2/);
  assert.ok(s.diags.some((d) => d.file.endsWith('a.c') && /unused-include/.test(d.message)));
  assert.ok(fs.existsSync(path.join(dir, '.42check', 'include-backup', 'b.c')));
  cleanup();
});

test('ON: 削除した後にプロジェクト全体の構文チェックが通らなくなったら、全て元に戻す', async (t) => {
  // 実際の clang に委ねつつ、プロジェクト全体の構文チェック (.42check の外) だけ、a.c が <stdio.h> を include していなければ失敗させる
  const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fakecc-'));
  const realCc = detectTools().cc;
  if (!realCc) return t.skip('clang が無い');
  const fake = path.join(dir0, 'fakecc');
  fs.writeFileSync(
    fake,
    `#!/bin/sh\nfor a in "$@"; do case "$a" in */include-check/*) exec ${realCc} "$@";; esac; done\ngrep -q 'include <stdio.h>' a.c && exec ${realCc} "$@"\necho "a.c:1:1: error: forced failure" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  const { ctx, read, cleanup } = project({ 'a.c': A_C }, {}, { tools: { cc: fake } });
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('a.c'), A_C, '元に戻っている');
  assert.match(s.log, /構文チェックが通らなくなったため、全て元に戻しました/);
  assert.equal(s.status, 'fail', 'error は残る');
  assert.ok(!fs.existsSync(path.join(ctx.workDir, 'include-backup')), '退避も消える');
  cleanup();
  fs.rmSync(dir0, { recursive: true, force: true });
});

test('設定 normExtra.disable に unused-include があれば、削除もしない', async (t) => {
  const { ctx, read, cleanup } = project({ 'a.c': A_C }, { normExtraDisable: ['unused-include'] });
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(read('a.c'), A_C);
  assert.equal(s.status, 'pass');
  cleanup();
});

test('設定と toggle: package.json と一致し、「設定」グループに並ぶ', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { type: string; default: unknown }> } };
  };
  const prop = pkg.contributes.configuration.properties['c42check.normExtra.removeUnusedIncludes'];
  assert.equal(prop.type, 'boolean');
  assert.equal(prop.default, false, '既定は OFF (ソースを書き換えるため)');
});
