import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonc } from '../src/core/jsonc';
import {
  BUILD_DEBUG_LABEL,
  buildLaunchConfigs,
  buildTasks,
  mergeJsonFile,
  PRE_DEBUG_LABEL,
  shellQuoteArgs,
  usesC42check,
} from '../src/core/launchConfig';

const opts = { cwd: '${workspaceFolder}', terminal: 'integrated' };

test('parseJsonc: コメント・末尾カンマ・文字列内の // を扱う', () => {
  const v = parseJsonc(`{
    // line
    "url": "http://x/y", /* block */
    "a": [1, 2,],
  }`) as { url: string; a: number[] };
  assert.equal(v.url, 'http://x/y');
  assert.deepEqual(v.a, [1, 2]);
});

test('launch 構成: lldb / launch、F5 の既定は事前チェックあり、別名で事前チェックなしも用意する', () => {
  const [pre, skip] = buildLaunchConfigs(opts);
  assert.deepEqual([pre.type, pre.request, pre.terminal], ['lldb', 'launch', 'integrated']);
  assert.equal(pre.preLaunchTask, PRE_DEBUG_LABEL);
  assert.equal(skip.preLaunchTask, BUILD_DEBUG_LABEL);
  assert.match(String(skip.name), /skip checks/);
  assert.notEqual(pre.name, skip.name, '名前で明確に区別する');
  assert.match(String(pre.program), /\.42check\/debug\/prog$/);
});

test('tasks: c42check type の 2 つ。label は launch の preLaunchTask と一致する', () => {
  const t = buildTasks();
  assert.deepEqual(t.map((x) => x.label), [PRE_DEBUG_LABEL, BUILD_DEBUG_LABEL]);
  assert.deepEqual(t.map((x) => [x.type, x.mode]), [['c42check', 'pre-debug'], ['c42check', 'build-debug']]);
});

test('マージ: ファイルが無ければ新規、既存の項目は変更せず、無いものだけ先頭に足す', () => {
  const fresh = mergeJsonFile(undefined, 'configurations', 'name', buildLaunchConfigs(opts), '0.2.0');
  assert.equal(fresh.added.length, 2);
  const existing = `{
    // 自分の構成
    "version": "0.2.0",
    "configurations": [ { "name": "mine", "type": "lldb", "request": "launch", "program": "a.out" }, ],
  }`;
  const m = mergeJsonFile(existing, 'configurations', 'name', buildLaunchConfigs(opts), '0.2.0');
  const doc = JSON.parse(m.merged!) as { configurations: { name: string }[] };
  assert.equal(doc.configurations.length, 3);
  assert.equal(doc.configurations.at(-1)?.name, 'mine', '既存の構成はそのまま残る');
  // 2 回目は変更なし
  const again = mergeJsonFile(m.merged!, 'configurations', 'name', buildLaunchConfigs(opts), '0.2.0');
  assert.equal(again.merged, null);
  assert.equal(again.kept.length, 2);
});

test('usesC42check / shellQuoteArgs', () => {
  assert.equal(usesC42check('{"configurations":[{"preLaunchTask":"c42check: pre-debug"}]}'), true);
  assert.equal(usesC42check('{"configurations":[]}'), false);
  assert.equal(shellQuoteArgs(['a b', "it's"]), `'a b' 'it'\\''s'`);
  assert.equal(shellQuoteArgs([]), '');
});
