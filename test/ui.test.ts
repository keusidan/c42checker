// UI 層 (Runner / TaskProvider) の制御フローの検証。vscode は test/vscode-stub.ts に差し替わる。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { Problems } from '../src/ui/diagnostics';
import { Outputs } from '../src/ui/output';
import { Runner } from '../src/ui/runner';
import { CheckTaskProvider } from '../src/ui/taskProvider';
import { sampleContext } from './helpers';

// stub 側にだけある state (型定義は @types/vscode のため any 経由で触る)
const state = (vscode as unknown as { state: { folders: unknown[]; config: Record<string, unknown>; messages: string[] } }).state;

function setup(sample: string, remove: string[] = []) {
  const { dir, cleanup } = sampleContext(sample, {}, remove);
  state.folders = [{ uri: { fsPath: dir } }];
  state.config = { 'c42check.runTimeoutSec': 10 };
  state.messages = [];
  const outputs = new Outputs();
  const problems = new Problems();
  const runner = new Runner(outputs, problems, { text: '' } as unknown as vscode.StatusBarItem);
  return { dir, outputs, runner, cleanup };
}

/** task の CustomExecution を実行して、Pseudoterminal が通知する終了コードを受け取る。 */
async function runTask(runner: Runner, mode: string): Promise<{ code: number | void; output: string }> {
  const provider = new CheckTaskProvider(runner);
  const task = provider.resolveTask({ definition: { type: 'c42check', mode }, name: `c42check: ${mode}` } as unknown as vscode.Task)!;
  const pty = await (task.execution as unknown as { callback: () => Promise<vscode.Pseudoterminal> }).callback();
  let output = '';
  pty.onDidWrite?.((t) => (output += t));
  const closed = new Promise<number | void>((resolve) => pty.onDidClose?.(resolve));
  pty.open(undefined);
  return { code: await closed, output };
}

test('pre-debug (正常): 終了コード 0、デバッグ用バイナリが .42check/debug/prog にできる', async () => {
  const { dir, runner, cleanup } = setup('ok');
  const { code, output } = await runTask(runner, 'pre-debug');
  assert.equal(code, 0, output);
  assert.ok(fs.existsSync(path.join(dir, '.42check', 'debug', 'prog')));
  assert.match(output, /すべて通りました/);
  cleanup();
});

test('pre-debug (norminette 違反): 終了コード非 0 → preLaunchTask として F5 を止められる。デバッグ用バイナリは作られない', async () => {
  const { dir, runner, outputs, cleanup } = setup('norm-ng');
  const { code, output } = await runTask(runner, 'pre-debug');
  assert.equal(code, 1, output);
  assert.equal(fs.existsSync(path.join(dir, '.42check', 'debug', 'prog')), false);
  assert.match(output, /段階 1 の norminette で止まりました。後続の段階は実行していません/);
  assert.match(output, /実行していません \(前の失敗のため\)/);
  assert.ok(state.messages.some((m) => /段階 1 の norminette/.test(m)), '通知で止まった段階・項目を示す');
  const norm = (outputs.get('norminette') as unknown as { text: string }).text;
  assert.match(norm, /INVALID_HEADER/, 'ツールごとの Output Channel に生ログが出る');
  assert.equal(runner.statusOf('norminette'), 'fail');
  assert.equal(runner.statusOf('asanUbsan'), 'pending', '段階 2 は実行されていない');
  cleanup();
});

test('build-debug ("Debug (skip checks)"): norminette 違反でもビルドだけ行い 0 を返す', async () => {
  const { dir, runner, cleanup } = setup('norm-ng');
  const { code, output } = await runTask(runner, 'build-debug');
  assert.equal(code, 0, output);
  assert.ok(fs.existsSync(path.join(dir, '.42check', 'debug', 'prog')));
  cleanup();
});

test('check: Run ボタン相当。stage 2 のバグを検出すると 1 を返し、Problems に診断が出る', async () => {
  const { runner, cleanup } = setup('bug-asan');
  const code = await runner.run('check');
  assert.equal(code, 1);
  assert.equal(runner.statusOf('asanUbsan'), 'fail');
  assert.ok(runner.resultOf('asanUbsan')!.diags.length > 0);
  cleanup();
});

test('実行中の二重起動は拒否する', async () => {
  const { runner, cleanup } = setup('ok');
  const first = runner.run('check');
  const second = await runner.run('check');
  assert.equal(second, 1, '二重起動');
  assert.equal(await first, 0);
  cleanup();
});

test('不明な mode の task は解決しない', () => {
  const { runner, cleanup } = setup('ok');
  const p = new CheckTaskProvider(runner);
  assert.equal(p.resolveTask({ definition: { type: 'c42check', mode: 'nope' }, name: 'x' } as unknown as vscode.Task), undefined);
  assert.equal(p.provideTasks().length, 3);
  cleanup();
});
