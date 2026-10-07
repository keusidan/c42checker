import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { generateClangd, generateCompdb, parseMakeDryRun, shellSplit } from '../src/core/compdb';
import { sampleContext } from './helpers';

test('shellSplit: クォートとエスケープを扱う', () => {
  assert.deepEqual(shellSplit(`cc -DNAME="a b" -I'x y' 'p'\\ q`), ['cc', '-DNAME=a b', '-Ix y', 'p q']);
});

test('make -n の出力から flags だけを取り出す (-c/-o/-M*/入力/リンクは除く)', () => {
  const out = [
    "make[1]: Entering directory '/w/libft'",
    'cc -Wall -Wextra -Werror -I../includes -MMD -MF obj/a.d -c src/a.c -o obj/a.o',
    "make[1]: Leaving directory '/w/libft'",
    'mkdir -p obj && cc -DDEBUG=1 -isystem /opt/inc -g -c main.c -o obj/main.o',
    'cc obj/main.o libft/libft.a -lm -Llibft -o prog',
    'ar rcs libft.a a.o',
    'clang-12 -O2 \\',
    '  -c util.c -o util.o',
  ].join('\n');
  const e = parseMakeDryRun(out, '/w');
  assert.equal(e.length, 3);
  assert.deepEqual(e[0], {
    directory: '/w/libft',
    file: '/w/libft/src/a.c',
    arguments: ['cc', '-Wall', '-Wextra', '-Werror', '-I../includes', '-c', '/w/libft/src/a.c'],
  });
  assert.deepEqual(e[1].arguments, ['cc', '-DDEBUG=1', '-isystem', '/opt/inc', '-g', '-c', '/w/main.c']);
  assert.deepEqual(e[2].arguments, ['clang-12', '-O2', '-c', '/w/util.c'], '行継続を結合する');
});

for (const source of ['files', 'make-n', 'clang-MJ', 'auto'] as const) {
  test(`compile_commands.json を生成できる (${source})`, async () => {
    const { ctx, dir, cleanup } = sampleContext('ok', { compdbSource: source });
    fs.mkdirSync(ctx.workDir, { recursive: true });
    const r = await generateCompdb(ctx);
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'compile_commands.json'), 'utf8')) as {
      file: string;
      arguments: string[];
      directory: string;
    }[];
    assert.equal(db.length, 2, `${r.method}: main.c と str_utils.c`);
    for (const e of db) {
      assert.ok(path.isAbsolute(e.file) && fs.existsSync(e.file));
      assert.ok(e.arguments.includes('-c') || e.arguments.includes(e.file), 'files/make-n は -c、clang -MJ は入力ファイルを含む');
    }
    if (source === 'make-n' || source === 'auto') assert.equal(r.method, 'make-n');
    cleanup();
  });
}

test('mainFile は compdb.includeMain で含める / 含めないを切り替えられる', async () => {
  for (const includeMain of [true, false]) {
    const { ctx, dir, cleanup } = sampleContext('lib-ok', { compdbSource: 'files', compdbIncludeMain: includeMain });
    assert.ok(ctx.mainFile, 'settings.json の mainFile を読めている');
    fs.mkdirSync(ctx.workDir, { recursive: true });
    await generateCompdb(ctx);
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'compile_commands.json'), 'utf8')) as { file: string }[];
    assert.equal(
      db.some((e) => e.file.endsWith('tests/test_main.c')),
      includeMain,
    );
    assert.equal(
      ctx.sources.some((s) => s.endsWith('test_main.c')),
      false,
      'mainFile は静的チェックの対象 (sources) に入らない',
    );
    cleanup();
  }
});

test('.clangd: 自作のものは更新し、他人のものは上書きしない', () => {
  const { dir, cleanup } = sampleContext('ok');
  assert.equal(generateClangd(dir).written, true);
  assert.equal(generateClangd(dir).written, true, '自作は再生成できる');
  fs.writeFileSync(path.join(dir, '.clangd'), 'CompileFlags:\n  Add: [-DMINE]\n');
  const r = generateClangd(dir);
  assert.equal(r.written, false);
  assert.match(fs.readFileSync(path.join(dir, '.clangd'), 'utf8'), /-DMINE/);
  cleanup();
});
