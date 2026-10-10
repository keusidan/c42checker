// TSan / MSan を setarch -R (ASLR 無効) 経由で起動する。ASLR の乱数が大きい環境では、これらは確率的に起動できないため。
import { execFileSync } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runPipeline } from '../src/core/pipeline';
import { findOnPath, machineArch } from '../src/core/tools';
import type { Context, Tools } from '../src/core/types';
import { sampleContext } from './helpers';

const need = (ctx: Context, key: keyof Tools) => ctx.tools[key] !== undefined;
const log = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id)?.log ?? '';
const result = (r: Awaited<ReturnType<typeof runPipeline>>, id: string) => r.results.find((x) => x.id === id)!;

/** 偽の setarch を作る。呼ばれた引数を called.txt に記録し、`<arch> -R` を外して残りを実行する。 */
function fakeSetarch(body: 'pass-through' | 'personality-error'): { bin: string; called: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fakesetarch-'));
  const bin = path.join(dir, 'setarch');
  const called = path.join(dir, 'called.txt');
  const script =
    body === 'pass-through'
      ? `#!/bin/sh\nprintf '%s\\n' "$*" >> "${called}"\nwhile [ "$1" != "-R" ]; do shift; done\nshift\nexec "$@"\n`
      : `#!/bin/sh\nprintf '%s\\n' "$*" >> "${called}"\necho "setarch: failed to set personality to x86_64: Operation not permitted" >&2\nexit 1\n`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, called, dir };
}

test('setarch -R は、ASLR を実際に無効にする (この修正の前提)', (t) => {
  const sa = findOnPath('setarch');
  if (!sa) return t.skip('setarch が無い');
  const maps = () => execFileSync(sa, [...machineArch(), '-R', 'sh', '-c', 'grep -m1 stack /proc/self/maps'], { encoding: 'utf8' }).split(' ')[0];
  let a: string;
  try {
    a = maps();
  } catch {
    return t.skip('この環境では setarch -R が使えない (personality が許可されていない)');
  }
  const plain = () => execFileSync('sh', ['-c', 'grep -m1 stack /proc/self/maps'], { encoding: 'utf8' }).split(' ')[0];
  assert.equal(maps(), a, 'setarch -R なら、起動するたびにスタックの位置が同じ');
  const seen = new Set([plain(), plain(), plain(), plain()]);
  assert.ok(seen.size > 1, '通常は、起動するたびにスタックの位置が変わる (ASLR が有効)');
});

for (const [id, sample] of [['tsan', 'bug-tsan'], ['msan', 'bug-msan']] as const) {
  test(`${id}: setarch -R 経由で起動する (setarch <arch> -R <prog>)。検出結果は変わらない`, async (t) => {
    const { ctx, dir, cleanup } = sampleContext(sample);
    if (!need(ctx, 'cc')) return t.skip('clang が無い');
    const fake = fakeSetarch('pass-through');
    ctx.tools = { ...ctx.tools, setarch: fake.bin };
    const r = await runPipeline(ctx, { selected: [id] });
    const x = result(r, id);
    if (x.status === 'skip') return t.skip(`この環境では ${id} が使えない: ${x.reason}`);
    assert.equal(x.status, 'fail', x.log);
    assert.ok(x.diags.length > 0, '位置つきの診断が付く');
    const called = fs.readFileSync(fake.called, 'utf8').trim().split('\n');
    assert.equal(called.length, 1);
    assert.equal(called[0], `${machineArch().join(' ')} -R ${path.join(dir, '.42check', id, 'prog')}`.trim());
    assert.match(log(r, id), new RegExp(`\\$ ${fake.bin.replace(/[/.]/g, '\\$&')} ${machineArch()[0] ?? ''} -R `));
    fs.rmSync(fake.dir, { recursive: true });
    cleanup();
  });
}

test('setarch が personality を変えられない環境 (seccomp など): ASLR 無効化なしで実行し直し、同じ結果になる', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-tsan');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const fake = fakeSetarch('personality-error');
  ctx.tools = { ...ctx.tools, setarch: fake.bin };
  const r = await runPipeline(ctx, { selected: ['tsan'] });
  const x = result(r, 'tsan');
  if (x.status === 'skip') return t.skip(`この環境では TSan が使えない: ${x.reason}`);
  assert.equal(x.status, 'fail', 'setarch の失敗を、バグ有りコードの結果に混ぜない (fail のまま)');
  assert.match(x.log, /setarch -R が使えない環境のため、ASLR を無効化せずに実行し直します/);
  assert.equal(fs.readFileSync(fake.called, 'utf8').trim().split('\n').length, 1, 'setarch は 1 回だけ試す');
  fs.rmSync(fake.dir, { recursive: true });
  cleanup();
});

test('setarch が無い環境: 直接起動する。起動できなければ skip の理由に「ASLR は無効にしていない」と出る', async (t) => {
  const { ctx, cleanup } = sampleContext('bug-msan');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  ctx.tools = { ...ctx.tools, setarch: undefined };
  const r = await runPipeline(ctx, { selected: ['msan'] });
  const x = result(r, 'msan');
  assert.ok(!/setarch/.test(x.log.split('\n').filter((l) => l.startsWith('$ ')).join('\n')), 'setarch を使わない');
  if (x.status === 'skip') assert.match(x.reason ?? '', /setarch -R を使えないため、ASLR は無効にしていません/);
  else assert.equal(x.status, 'fail');
  cleanup();
});

test('ASan+UBSan と valgrind は setarch を使わない (TSan / MSan だけ)', async (t) => {
  const { ctx, cleanup } = sampleContext('ok');
  if (!need(ctx, 'cc')) return t.skip('clang が無い');
  const fake = fakeSetarch('pass-through');
  ctx.tools = { ...ctx.tools, setarch: fake.bin };
  await runPipeline(ctx, { selected: ['asanUbsan', 'valgrind'] });
  assert.equal(fs.existsSync(fake.called), false);
  fs.rmSync(fake.dir, { recursive: true });
  cleanup();
});

test('TSan / MSan を繰り返し実行しても、バグのあるコードを毎回検出する (確率的な skip が起きない)', async (t) => {
  const ROUNDS = 8;
  for (const [id, sample] of [['tsan', 'bug-tsan'], ['msan', 'bug-msan']] as const) {
    const { ctx, cleanup } = sampleContext(sample);
    if (!need(ctx, 'cc')) return t.skip('clang が無い');
    const counts = { fail: 0, skip: 0, pass: 0 };
    for (let i = 0; i < ROUNDS; i++) counts[result(await runPipeline(ctx, { selected: [id] }), id).status]++;
    if (counts.skip === ROUNDS) {
      cleanup();
      return t.skip(`この環境では ${id} が使えない`);
    }
    assert.deepEqual(counts, { fail: ROUNDS, skip: 0, pass: 0 }, `${id}: ${JSON.stringify(counts)}`);
    cleanup();
  }
});
