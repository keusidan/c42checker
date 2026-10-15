// include の判定の高速化 (名前による絞り込み・並列化) と、include の二重指定の検出 (オプション)。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createContext } from '../src/core/context';
import { runCtagsSymbols } from '../src/core/ctags';
import { normExtra, suspectIncludes, type NormExtraInput } from '../src/core/normextra';
import { runPipeline } from '../src/core/pipeline';
import { WEAK_SYMBOLS } from '../src/core/stdsyms';
import { detectTools, findOnPath } from '../src/core/tools';
import { DEFAULT_SETTINGS, type Context, type Settings } from '../src/core/types';

function project(files: Record<string, string>, settings: Partial<Settings> = {}): { ctx: Context; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-perf-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  const ctx = createContext({ root: dir, settings: { ...DEFAULT_SETTINGS, normExclude: [], ...settings }, tools: detectTools(), io: { log: () => undefined } });
  return { ctx, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const step = (r: Awaited<ReturnType<typeof runPipeline>>) => r.results.find((x) => x.id === 'normExtra')!;
const compiles = (log: string) => Number(/構文チェック (\d+) 回/.exec(log)?.[1] ?? 0);
const need = (ctx: Context) => ctx.tools.cc !== undefined;
const unusedLines = (s: { diags: { message: string; line: number; file: string }[] }, file?: string) =>
  s.diags.filter((d) => d.message.startsWith('[unused-include]') && (!file || d.file.endsWith(file))).map((d) => d.line).sort((a, b) => a - b);

async function input(files: Record<string, string>, extra: Partial<NormExtraInput> = {}): Promise<{ input: NormExtraInput; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-dup-'));
  const abs: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
    abs.push(path.join(dir, name));
  }
  const headers = abs.filter((f) => f.endsWith('.h'));
  const sym = findOnPath('ctags') ? await runCtagsSymbols('ctags', headers, dir, 20_000) : undefined;
  return {
    dir,
    input: {
      root: dir,
      files: abs,
      allSources: abs.filter((f) => f.endsWith('.c')),
      allHeaders: headers,
      includeDirs: [dir],
      disabled: new Set(),
      shortNames: new Set(['i']),
      headerSymbols: sym?.ok ? sym.byFile : undefined,
      ...extra,
    },
  };
}

const dupMessages = (f: ReturnType<typeof normExtra>) => f.filter((x) => x.rule === 'duplicate-include');

/* ───────────── 高速化 ───────────── */

test('名前の表で「使っている」と分かる include はコンパイルしない。使っていないように見えるものと、表にないヘッダだけを確かめる', async () => {
  const { input: i, dir } = await input({
    'a.c': '#include <stdlib.h>\n#include <stdio.h>\n#include <ctype.h>\n#include <readline/readline.h>\n\nint\tft_a(void)\n{\n\tchar\t*p;\n\n\tp = malloc(1);\n\tfree(p);\n\treturn (0);\n}\n',
  });
  const s = suspectIncludes(i).get(path.join(dir, 'a.c'))!;
  assert.deepEqual(s.map((x) => x.name).sort(), ['ctype.h', 'readline/readline.h', 'stdio.h'], 'stdlib (malloc / free) は使っていると分かるので、確かめない');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('size_t / NULL のように複数のヘッダが提供する名前だけを使っているときは、証拠にしない (コンパイラで確かめる)。強い名前を使っていれば証拠になる', async () => {
  assert.ok(WEAK_SYMBOLS.has('size_t') && WEAK_SYMBOLS.has('NULL'));
  assert.ok(!WEAK_SYMBOLS.has('malloc') && !WEAK_SYMBOLS.has('printf'));
  const { input: i, dir } = await input({
    'a.c': '#include <stdlib.h>\n#include <string.h>\n#include <stdio.h>\n\nsize_t\tft_a(void)\n{\n\treturn (strlen("x"));\n}\n',
  });
  const s = suspectIncludes(i).get(path.join(dir, 'a.c'))!;
  assert.deepEqual(s.map((x) => x.name).sort(), ['stdio.h', 'stdlib.h'], 'string.h は strlen を使っているので確かめない。size_t だけでは stdlib / stdio の証拠にならない');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('全ての include が使われているのを名前から確認できれば、コピーもコンパイルもしない', async () => {
  const { ctx, cleanup } = project({
    'a.c': '#include <stdlib.h>\n#include <unistd.h>\n\nint\tft_a(void)\n{\n\tchar\t*p;\n\n\tp = malloc(1);\n\twrite(1, p, 1);\n\tfree(p);\n\treturn (0);\n}\n',
  });
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(s.status, 'pass', s.log);
  assert.match(s.log, /コンパイルは不要/);
  assert.ok(!fs.existsSync(path.join(ctx.workDir, 'include-check')));
  cleanup();
});

test('使っていない include のあるファイルだけをコンパイルする (ファイルごとに、外す前 1 回 + 疑わしい include の数)', async (t) => {
  const files: Record<string, string> = {};
  for (let n = 0; n < 12; n++) {
    files[`m${String(n).padStart(2, '0')}.c`] = `#include <stdlib.h>\n#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n#include <ctype.h>\n\nint\tmod_${n}(const char *str)\n{\n\tchar\t*dup;\n\n\tdup = malloc(strlen(str) + 1);\n\tprintf("%s", str);\n\twrite(1, str, 1);\n\tfree(dup);\n\treturn (0);\n}\n`;
  }
  const { ctx, cleanup } = project(files);
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.equal(s.status, 'fail');
  // 12 ファイル × (外す前 1 回 + ctype を外す 1 回) = 24 回。全ての include を 1 つずつ外していれば 12 × 6 = 72 回
  assert.equal(compiles(s.log), 24, s.log);
  assert.deepEqual(unusedLines(s), Array(12).fill(5), '全てのファイルで <ctype.h> (5 行目) だけが未使用');
  assert.equal(new Set(s.diags.filter((d) => /unused-include/.test(d.message)).map((d) => d.file)).size, 12);
  cleanup();
});

test('並列に判定しても、結果は毎回同じ (ファイルの数が多くても)', async (t) => {
  const files: Record<string, string> = {};
  for (let n = 0; n < 20; n++) {
    files[`f${String(n).padStart(2, '0')}.c`] = `#include <stdlib.h>\n${n % 2 ? '#include <ctype.h>\n' : ''}#include <stdio.h>\n\nint\tft_${n}(void)\n{\n\tchar\t*p;\n\n\tp = malloc(1);\n\tfree(p);\n\treturn (0);\n}\n`;
  }
  const { ctx, cleanup } = project(files);
  if (!need(ctx)) return t.skip('clang が無い');
  const key = (s: ReturnType<typeof step>) => s.diags.filter((d) => /unused-include/.test(d.message)).map((d) => `${path.basename(d.file)}:${d.line}:${/<(\w+\.h)>/.exec(d.message)![1]}`).sort();
  const a = key(step(await runPipeline(ctx, { selected: ['normExtra'] })));
  const b = key(step(await runPipeline(ctx, { selected: ['normExtra'] })));
  assert.deepEqual(a, b);
  assert.equal(a.length, 30, '20 ファイルの stdio (未使用) + 10 ファイルの ctype (未使用)');
  assert.ok(a.every((x) => /:(stdio|ctype)\.h$/.test(x)));
  cleanup();
});

test('include-what-you-use: ヘッダも include している <stdlib.h> を、ソースが使うために書いていても、未使用とは判定しない', async (t) => {
  const { ctx, cleanup } = project({
    'ft.h': '#ifndef FT_H\n# define FT_H\n\n# include <stdlib.h>\n\nvoid\t*ft_alloc(void);\n\n#endif\n',
    'a.c': '#include <stdlib.h>\n#include "ft.h"\n\nvoid\t*ft_alloc(void)\n{\n\treturn (malloc(1));\n}\n',
  });
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.deepEqual(unusedLines(s), []);
  assert.equal(s.status, 'pass', s.log);
  cleanup();
});

test('size_t だけを使うファイルの未使用の include は、コンパイラで確かめて検出する (名前だけで見逃さない)', async (t) => {
  const { ctx, cleanup } = project({ 'a.c': '#include <stdio.h>\n#include <string.h>\n\nsize_t\tft_a(void)\n{\n\treturn (0);\n}\n' });
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  assert.deepEqual(unusedLines(s), [1, 2]);
  cleanup();
});

/* ───────────── include の二重指定 (オプション) ───────────── */

const FT_H = '#ifndef FT_H\n# define FT_H\n\n# include <stdlib.h>\n# include <string.h>\n\nvoid\t*ft_alloc(void);\n\n#endif\n';

test('二重指定: 既定 (OFF) では検出しない。ヘッダとソースの両方に書いてあっても問題にしない', async () => {
  const { input: i, dir } = await input({ 'ft.h': FT_H, 'a.c': '#include <stdlib.h>\n#include "ft.h"\n\nvoid\t*ft_alloc(void)\n{\n\treturn (malloc(1));\n}\n' });
  assert.deepEqual(dupMessages(normExtra(i)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('二重指定: ON なら、ヘッダがすでに include しているものを、ソースでも include している場合を検出する (ソース側の行を指す)', async () => {
  const { input: i, dir } = await input(
    { 'ft.h': FT_H, 'a.c': '#include <stdlib.h>\n#include <stdio.h>\n#include "ft.h"\n\nvoid\t*ft_alloc(void)\n{\n\treturn (malloc(1));\n}\n' },
    { detectDuplicateIncludes: true },
  );
  const d = dupMessages(normExtra(i));
  assert.equal(d.length, 1);
  assert.ok(d[0].file.endsWith('a.c'));
  assert.equal(d[0].line, 1);
  assert.equal(d[0].strength, 'error');
  assert.match(d[0].message, /<stdlib\.h> は、include している ft\.h \(4 行目\) がすでに include しています/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('二重指定: ヘッダの先のヘッダ (推移的) も見る。プロジェクトのヘッダ同士の二重指定も検出する', async () => {
  const { input: i, dir } = await input(
    {
      'ft.h': FT_H,
      'ft2.h': '#ifndef FT2_H\n# define FT2_H\n\n# include "ft.h"\n\n#endif\n',
      'a.c': '#include "ft2.h"\n#include "ft.h"\n#include <string.h>\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n',
    },
    { detectDuplicateIncludes: true },
  );
  const d = dupMessages(normExtra(i)).filter((x) => x.file.endsWith('a.c'));
  assert.deepEqual(d.map((x) => x.line).sort(), [2, 3], '"ft.h" (ft2.h 経由) と <string.h> (ft2.h → ft.h 経由)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('二重指定: 同じファイルの中で同じヘッダを 2 回 include しているものを検出する (後ろの行を指す)', async () => {
  const { input: i, dir } = await input({ 'a.c': '#include <stdio.h>\n#include <stdlib.h>\n#include <stdio.h>\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n' }, { detectDuplicateIncludes: true });
  const d = dupMessages(normExtra(i));
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 3);
  assert.match(d[0].message, /1 行目ですでに include されています/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('二重指定: コメントで理由を書いた include / 別のヘッダだけを include しているファイル / 規則を disable した場合は検出しない', async () => {
  const files = {
    'ft.h': FT_H,
    'a.c': '#include <stdlib.h> // used directly, kept on purpose\n#include "ft.h"\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n',
    'b.c': '#include <stdio.h>\n#include "ft.h"\n\nint\tft_b(void)\n{\n\treturn (0);\n}\n',
  };
  const { input: i, dir } = await input(files, { detectDuplicateIncludes: true });
  assert.deepEqual(dupMessages(normExtra(i)), [], 'a.c はコメントで理由あり。b.c の <stdio.h> は ft.h にない');
  const { input: j, dir: dir2 } = await input({ ...files, 'a.c': '#include <stdlib.h>\n#include "ft.h"\n\nint\tft_a(void)\n{\n\treturn (0);\n}\n' }, { detectDuplicateIncludes: true });
  assert.equal(dupMessages(normExtra(j)).length, 1);
  assert.deepEqual(dupMessages(normExtra({ ...j, disabled: new Set(['duplicate-include']) })), [], 'disable で外せる');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('二重指定: step に反映される (error なら fail、Problems の診断は行つき)。設定は package.json と一致し、既定は OFF', async () => {
  const files = { 'ft.h': FT_H.replace('# include <string.h>\n', ''), 'a.c': '#include <stdlib.h>\n#include "ft.h"\n\nvoid\t*ft_alloc(void)\n{\n\treturn (malloc(1));\n}\n' };
  const off = project(files);
  assert.equal(step(await runPipeline(off.ctx, { selected: ['normExtra'] })).status, 'pass');
  off.cleanup();
  const on = project(files, { normExtraDetectDuplicateIncludes: true });
  const s = step(await runPipeline(on.ctx, { selected: ['normExtra'] }));
  assert.equal(s.status, 'fail');
  const d = s.diags.find((x) => x.message.startsWith('[duplicate-include]'))!;
  assert.equal(d.line, 1);
  assert.equal(d.severity, 'error');
  assert.match(s.log, /\[duplicate-include\] Norm III\.5/);
  // 削除のオプションも ON でも、二重指定は削除しない (検出だけ。どちらを残すかは人が決める)
  on.ctx.settings.normExtraRemoveUnusedIncludes = true;
  await runPipeline(on.ctx, { selected: ['normExtra'] });
  assert.equal(fs.readFileSync(path.join(on.dir, 'a.c'), 'utf8'), files['a.c']);
  on.cleanup();

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { type: string; default: unknown; items?: { enum?: string[] } }> } };
  };
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['c42check.normExtra.detectDuplicateIncludes'].default, false);
  assert.equal(DEFAULT_SETTINGS.normExtraDetectDuplicateIncludes, false);
  assert.ok(props['c42check.normExtra.disable'].items!.enum!.includes('duplicate-include'));
});

test('ヘッダの include を確かめるとき、先頭の単位 (そのヘッダだけを include する .c) で「必要」と分かれば、include 元の .c はコンパイルしない', async (t) => {
  const files: Record<string, string> = {
    'ft.h': '#ifndef FT_H\n# define FT_H\n\n# include <stddef.h>\n\nsize_t\tft_len(const char *str);\n\n#endif\n',
  };
  for (let n = 0; n < 15; n++) files[`m${String(n).padStart(2, '0')}.c`] = `#include "ft.h"\n\nsize_t\tft_len(const char *str)\n{\n\treturn (${n});\n}\n`;
  const { ctx, cleanup } = project(files);
  if (!need(ctx)) return t.skip('clang が無い');
  const s = step(await runPipeline(ctx, { selected: ['normExtra'] }));
  // <stddef.h> は size_t だけが証拠なので確かめる: ft.h だけを include する .c で size_t が未宣言になるため、include 元 15 件は不要
  // (15 ファイルの "ft.h" は ctags で ft_len を使っていると分かるので確かめない)
  assert.ok(compiles(s.log) <= 2, `構文チェックは ${compiles(s.log)} 回\n${s.log}`);
  assert.deepEqual(unusedLines(s), []);
  cleanup();
});
