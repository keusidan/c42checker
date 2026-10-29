// 使っていない include の判定をコンパイラで行う (include を 1 行ずつ外して、診断が増えるかを見る)。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createContext } from '../src/core/context';
import { judgeIncludes } from '../src/core/includecheck';
import { listIncludes, resolveLocal, type Finding } from '../src/core/normextra';
import { runPipeline } from '../src/core/pipeline';
import { detectTools } from '../src/core/tools';
import { DEFAULT_SETTINGS, type Context } from '../src/core/types';

function project(files: Record<string, string>, settings: Partial<typeof DEFAULT_SETTINGS> = {}): { ctx: Context; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-inc-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  const ctx = createContext({ root: dir, settings: { ...DEFAULT_SETTINGS, normExclude: [], ...settings }, tools: detectTools(), io: { log: () => undefined } });
  return { ctx, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function judge(ctx: Context) {
  const includers = new Map<string, string[]>();
  for (const src of ctx.sources) {
    for (const inc of listIncludes(src)) {
      const t = inc.system ? undefined : resolveLocal(src, inc.name, { allHeaders: ctx.headers, includeDirs: ctx.includeDirs });
      if (t) includers.set(t, [...(includers.get(t) ?? []), src]);
    }
  }
  return judgeIncludes({
    ctx,
    files: [...ctx.sources, ...ctx.headers],
    includesOf: listIncludes,
    includersOf: (h) => includers.get(h) ?? [],
    flags: ctx.includeDirs.map((d) => `-I${d}`),
  });
}

const names = (fs_: Finding[], strength: 'error' | 'review', file?: string) =>
  fs_
    .filter((f) => f.strength === strength && (!file || f.file.endsWith(file)))
    .map((f) => /#include ([<"][^>"]+[>"])/.exec(f.message)![1])
    .sort();

const need = (ctx: Context) => ctx.tools.cc !== undefined;

test('関数: 使っている include は残り、使っていないものだけが未使用になる (malloc / write は必要、stdio / string は不要)', async (t) => {
  const { ctx, cleanup, dir } = project({
    'a.c': '#include <stdlib.h>\n#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n\nsize_t\tft_a(void)\n{\n\tchar\t*p;\n\n\tp = malloc(2);\n\twrite(1, "x", 1);\n\tfree(p);\n\treturn (0);\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.deepEqual(names(r.findings, 'error'), ['<stdio.h>', '<string.h>']);
  assert.deepEqual(names(r.findings, 'review'), []);
  assert.ok(r.findings.every((f) => f.rule === 'unused-include' && f.file.endsWith('a.c')));
  assert.deepEqual(r.findings.map((f) => f.line).sort(), [2, 3], '行番号は元のファイルのもの');
  assert.ok(r.judged.has(path.join(dir, 'a.c')));
  assert.match(r.log, /構文チェック \d+ 回/);
  cleanup();
});

test('型・マクロ・定数だけを使うヘッダも、使っていれば残る (uint8_t / INT_MAX / bool)。使っていなければ未使用', async (t) => {
  const { ctx, cleanup } = project({
    'a.c': '#include <stdint.h>\n#include <limits.h>\n#include <stdbool.h>\n#include <stddef.h>\n#include <ctype.h>\n\nstatic uint8_t\tlow(int c)\n{\n\treturn ((uint8_t)(c & 0xff));\n}\n\nint\tft_a(int c)\n{\n\tif (c > INT_MAX / 2)\n\t\treturn (0);\n\treturn (low(c));\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.deepEqual(names(r.findings, 'error'), ['<ctype.h>', '<stdbool.h>', '<stddef.h>'], 'stdint (uint8_t) と limits (INT_MAX) は必要');
  cleanup();
});

test('名前の表にないヘッダも判定できる (プロジェクトのヘッダ。ctags は不要)。自分のヘッダを include する .c は未使用にならない', async (t) => {
  const { ctx, cleanup } = project({
    'inc/dep.h': '#ifndef DEP_H\n# define DEP_H\n\nint\tdep_fn(int x);\n\n#endif\n',
    'inc/unused.h': '#ifndef UNUSED_H\n# define UNUSED_H\n\nint\tunused_fn(int x);\n\n#endif\n',
    'inc/a.h': '#ifndef A_H\n# define A_H\n\nint\tft_a(void);\n\n#endif\n',
    'a.c': '#include "dep.h"\n#include "unused.h"\n#include "a.h"\n\nint\tft_a(void)\n{\n\treturn (dep_fn(1));\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.deepEqual(names(r.findings, 'error', 'a.c'), ['"unused.h"'], 'a.h は自分のプロトタイプを宣言しているので、外すと「プロトタイプが無い」警告が出て、必要と判定される');
  cleanup();
});

test('提供する名前が重なる include (size_t だけを使うとき): 両方を外すと困るので、どちらも review (error にしない)', async (t) => {
  const { ctx, cleanup } = project({
    'a.c': '#include <stdlib.h>\n#include <stdio.h>\n\nsize_t\tft_a(void)\n{\n\treturn (0);\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.deepEqual(names(r.findings, 'error'), []);
  assert.deepEqual(names(r.findings, 'review'), ['<stdio.h>', '<stdlib.h>']);
  assert.match(r.findings[0].message, /提供する名前が重なっていて、どれか 1 つは必要/);
  cleanup();
});

test('重なる include と、本当に未使用の include が混ざっているとき: 未使用だけが error、重なる方は review', async (t) => {
  const { ctx, cleanup } = project({
    'a.c': '#include <ctype.h>\n#include <stdlib.h>\n#include <stdio.h>\n\nsize_t\tft_a(void)\n{\n\treturn (0);\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.deepEqual(names(r.findings, 'error'), ['<ctype.h>']);
  assert.deepEqual(names(r.findings, 'review'), ['<stdio.h>', '<stdlib.h>']);
  cleanup();
});

test('コメントで理由を書いた include は判定しない (Norm III.5)', async (t) => {
  const { ctx, cleanup } = project({
    'a.c': '#include <stdio.h> // for the debug output in the tests\n/* needed by the project */\n#include <string.h>\n#include <ctype.h>\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.deepEqual(names(r.findings, 'error'), ['<ctype.h>']);
  cleanup();
});

test('ヘッダファイル: そのヘッダを include する .c が使っている include は必要。誰も使っていないものは未使用', async (t) => {
  const { ctx, cleanup } = project({
    'ft.h': '#ifndef FT_H\n# define FT_H\n\n# include <stdlib.h>\n# include <string.h>\n# include <stdint.h>\n\nuint8_t\tft_low(int c);\n\n#endif\n',
    'a.c': '#include "ft.h"\n\nvoid\t*ft_a(void)\n{\n\treturn (malloc(1));\n}\n',
    'b.c': '#include "ft.h"\n\nuint8_t\tft_low(int c)\n{\n\treturn ((uint8_t)c);\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.deepEqual(names(r.findings, 'error', 'ft.h'), ['<string.h>'], 'stdlib は a.c が malloc に使う / stdint は ft.h 自身が uint8_t に使う / string は誰も使わない');
  cleanup();
});

test('外す前から fatal error (include が見つからない) のファイルは、コンパイラでは判定しない (表による判定に回す)', async (t) => {
  const { ctx, cleanup } = project({
    'a.c': '#include <stdio.h>\n#include "missing.h"\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n',
    'b.c': '#include <stdio.h>\n\nint\tft_b(void)\n{\n\treturn (0);\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const r = await judge(ctx);
  assert.ok(!r.judged.has(path.join(ctx.root, 'a.c')));
  assert.ok(r.judged.has(path.join(ctx.root, 'b.c')));
  assert.match(r.log, /a\.c: .*fatal error/);
  assert.deepEqual(names(r.findings, 'error'), ['<stdio.h>'], 'b.c の分だけ');
  assert.ok(r.findings.every((f) => f.file.endsWith('b.c')));
  cleanup();
});

test('元のファイルは書き換えない。作業用のコピーは消す', async (t) => {
  const { ctx, dir, cleanup } = project({
    'a.c': '#include <stdio.h>\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n',
    'a.h': '#ifndef A_H\n# define A_H\n# include <string.h>\n#endif\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const before = ['a.c', 'a.h'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  await judge(ctx);
  assert.deepEqual(['a.c', 'a.h'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), before);
  assert.ok(!fs.existsSync(path.join(ctx.workDir, 'include-check')));
  cleanup();
});

test('警告強化の flags (cflags) もそのまま使う / clang が無ければ何も判定しない (表による判定に回す)', async () => {
  const { ctx, cleanup } = project({ 'a.c': '#include <stdio.h>\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n' });
  ctx.tools = { ...ctx.tools, cc: undefined };
  const r = await judge(ctx);
  assert.equal(r.judged.size, 0);
  assert.deepEqual(r.findings, []);
  assert.match(r.log, /clang が無い/);
  cleanup();
});

test('step: コンパイラの判定結果が normExtra に反映される (error なら fail、Problems 用の診断は行つき)。clang が無ければ名前の表で判定する', async (t) => {
  const files = { 'a.c': '#include <stdlib.h>\n#include <stdio.h>\n\nvoid\t*ft_a(void)\n{\n\treturn (malloc(1));\n}\n' };
  const { ctx, cleanup } = project(files);
  if (!need(ctx)) {
    cleanup();
    return t.skip('clang が無い');
  }
  const r = await runPipeline(ctx, { selected: ['normExtra'] });
  const s = r.results.find((x) => x.id === 'normExtra')!;
  assert.equal(s.status, 'fail');
  const d = s.diags.find((x) => x.message.startsWith('[unused-include]'))!;
  assert.equal(d.line, 2);
  assert.match(d.message, /<stdio\.h>/);
  assert.match(d.message, /診断が増えません/);
  assert.match(s.log, /コンパイラによる include の判定/);

  const noCc = project(files);
  noCc.ctx.tools = { ...noCc.ctx.tools, cc: undefined };
  const r2 = await runPipeline(noCc.ctx, { selected: ['normExtra'] });
  const s2 = r2.results.find((x) => x.id === 'normExtra')!;
  assert.equal(s2.status, 'fail', '名前の表でも <stdio.h> は未使用と判定される');
  assert.match(s2.log, /clang が無いため/);
  assert.ok(s2.diags.some((x) => /<stdio\.h>/.test(x.message)));
  cleanup();
  noCc.cleanup();

  // 設定で unused-include を外せば、コンパイルもしない
  const off = project(files, { normExtraDisable: ['unused-include'] });
  const r3 = await runPipeline(off.ctx, { selected: ['normExtra'] });
  assert.doesNotMatch(r3.results.find((x) => x.id === 'normExtra')!.log, /コンパイラによる include の判定/);
  off.cleanup();
});
