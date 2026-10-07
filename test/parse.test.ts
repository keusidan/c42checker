import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseCompilerOutput,
  parseNorminette,
  parseSanitizer,
  parseValgrind,
  stripAnsi,
} from '../src/core/parse';

test('gcc/clang 形式を file:line:col で取り出す', () => {
  const out = [
    'src/a.c:12:5: warning: unused variable ‘x’ [-Wunused-variable]',
    'src/a.c:13:1: error: expected ‘;’',
    'src/a.c:13:1: note: ignore me',
    'src/a.c:12:5: warning: unused variable ‘x’ [-Wunused-variable]',
  ].join('\n');
  const d = parseCompilerOutput(out, '/w', 'gcc');
  assert.equal(d.length, 2, 'note は除外・重複は 1 件にまとめる');
  assert.deepEqual([d[0].file, d[0].line, d[0].col, d[0].severity], ['/w/src/a.c', 12, 5, 'warning']);
  assert.equal(d[1].severity, 'error');
});

test('UBSan の runtime error を error として取り出す', () => {
  const d = parseCompilerOutput('m.c:7:12: runtime error: signed integer overflow', '/w', 'ubsan');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
  assert.match(d[0].message, /runtime error: signed integer overflow/);
});

test('norminette: ANSI カラーを除去して line/col を取り出す', () => {
  const out = [
    'main.c: Error!',
    '\u001b[91mError: INVALID_HEADER       (line:   1, col:   1):\tMissing or invalid 42 header\u001b[0m'.replace('\u001b[91m', ''),
    'Error: SPACE_BEFORE_FUNC    (line:   5, col:   4):\t\u001b[94mFound space\u001b[0m',
    'ok.c: OK!',
  ].join('\n');
  const d = parseNorminette(out, '/w');
  assert.equal(d.length, 2);
  assert.deepEqual([d[1].file, d[1].line, d[1].col], ['/w/main.c', 5, 4]);
  assert.match(d[1].message, /^SPACE_BEFORE_FUNC: Found space$/);
  assert.equal(stripAnsi('\u001b[97mx\u001b[0m'), 'x');
});

test('ASan: 最初の root 内フレームに診断を付ける', () => {
  const out = [
    '==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x1',
    'WRITE of size 1 at 0x1 thread T0',
    '    #0 0x1 in main /w/main.c:13:12',
    '    #1 0x2 in __libc_start_main /lib/x86_64-linux-gnu/libc.so.6',
  ].join('\n');
  const d = parseSanitizer(out, '/w');
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].file, d[0].line, d[0].col], ['/w/main.c', 13, 12]);
  assert.match(d[0].message, /heap-buffer-overflow/);
});

test('LeakSanitizer の Direct leak を取り出す (システムのフレームは飛ばす)', () => {
  const out = [
    'ERROR: LeakSanitizer: detected memory leaks',
    'Direct leak of 16 byte(s) in 1 object(s) allocated from:',
    '    #0 0x1 in malloc (/usr/lib/libclang_rt.asan.so+0x1)',
    '    #1 0x2 in keep /w/main.c:9:10',
  ].join('\n');
  const d = parseSanitizer(out, '/w');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 9);
});

test('valgrind: エラー位置と、継承されていない fd のリークを数える', () => {
  const out = [
    '==10== Invalid write of size 1',
    '==10==    at 0x1: main (/w/main.c:13)',
    '==10== ',
    '==10== Open file descriptor 3: /dev/null',
    '==10==    at 0x2: open (open64.c:41)',
    '==10==    by 0x3: main (/w/main.c:20)',
    '==10== ',
    '==10== Open file descriptor 4: /tmp/inherited',
    '==10==    <inherited from parent>',
  ].join('\n');
  const r = parseValgrind(out, '/w');
  assert.equal(r.fdLeaks, 1, '継承された fd は数えない');
  assert.deepEqual(r.diags.map((d) => d.line), [13, 20]);
});
