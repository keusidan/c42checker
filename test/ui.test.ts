// UI 層 (Runner / TaskProvider) の制御フローの検証。vscode は test/vscode-stub.ts に差し替わる。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { migrateFromOldName, suggestMigration } from '../src/extension';
import { Problems } from '../src/ui/diagnostics';
import { Outputs } from '../src/ui/output';
import { Runner } from '../src/ui/runner';
import { CheckTaskProvider } from '../src/ui/taskProvider';
import { sampleContext } from './helpers';

// stub 側にだけある state (型定義は @types/vscode のため any 経由で触る)
const state = (vscode as unknown as { state: { folders: unknown[]; config: Record<string, unknown>; messages: string[]; warnChoice?: string; dirty: Set<string> } }).state;

function setup(sample: string, remove: string[] = []) {
  const { dir, cleanup } = sampleContext(sample, {}, remove);
  state.folders = [{ uri: { fsPath: dir } }];
  state.config = { 'c42checker.runTimeoutSec': 10, 'c42checker.normExclude': [] }; // 既定 (main.c を除外) だと norm-ng の違反が消えるため
  state.messages = [];
  const outputs = new Outputs();
  const problems = new Problems();
  const runner = new Runner(outputs, problems, { text: '' } as unknown as vscode.StatusBarItem);
  return { dir, outputs, runner, cleanup };
}

/** task の CustomExecution を実行して、Pseudoterminal が通知する終了コードを受け取る。 */
async function runTask(runner: Runner, mode: string): Promise<{ code: number | void; output: string }> {
  const provider = new CheckTaskProvider(runner);
  const task = provider.resolveTask({ definition: { type: 'c42checker', mode }, name: `c42checker: ${mode}` } as unknown as vscode.Task)!;
  const pty = await (task.execution as unknown as { callback: () => Promise<vscode.Pseudoterminal> }).callback();
  let output = '';
  pty.onDidWrite?.((t) => (output += t));
  const closed = new Promise<number | void>((resolve) => pty.onDidClose?.(resolve));
  pty.open(undefined);
  return { code: await closed, output };
}

test('pre-debug (正常): 終了コード 0、デバッグ用バイナリが .c42checker/debug/prog にできる', async () => {
  const { dir, runner, cleanup } = setup('ok');
  const { code, output } = await runTask(runner, 'pre-debug');
  assert.equal(code, 0, output);
  assert.ok(fs.existsSync(path.join(dir, '.c42checker', 'debug', 'prog')));
  assert.match(output, /すべて通りました/);
  cleanup();
});

test('pre-debug (norminette 違反): 終了コード非 0 → preLaunchTask として F5 を止められる。デバッグ用バイナリは作られない', async () => {
  const { dir, runner, outputs, cleanup } = setup('norm-ng');
  const { code, output } = await runTask(runner, 'pre-debug');
  assert.equal(code, 1, output);
  assert.equal(fs.existsSync(path.join(dir, '.c42checker', 'debug', 'prog')), false);
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
  assert.ok(fs.existsSync(path.join(dir, '.c42checker', 'debug', 'prog')));
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

test('単一実行: only を渡すと、チェックの状態に関係なく、その項目だけを実行する', async () => {
  const { runner, cleanup } = setup('ok');
  const code = await runner.run('check', undefined, ['norminette']);
  assert.equal(code, 0);
  assert.equal(runner.statusOf('norminette'), 'pass');
  assert.equal(runner.statusOf('asanUbsan'), 'pending', '既定でチェック済みの項目も、実行しない');
  assert.equal(runner.statusOf('warnings'), 'pending');
  cleanup();
});

test('単一実行: チェックを外している項目 (TSan) も実行できる。前の失敗も引きずらない', async () => {
  const { runner, cleanup } = setup('norm-ng');
  assert.equal(await runner.run('check', undefined, ['norminette']), 1);
  assert.equal(runner.statusOf('norminette'), 'fail');
  assert.equal(await runner.run('check', undefined, ['warnings']), 0, 'norminette が失敗するソースでも、警告強化ビルドだけなら通る');
  assert.equal(runner.statusOf('norminette'), 'pending', '前回の結果は入れ替わる');
  assert.equal(runner.statusOf('warnings'), 'pass');
  cleanup();
});

test('不明な mode の task は解決しない', () => {
  const { runner, cleanup } = setup('ok');
  const p = new CheckTaskProvider(runner);
  assert.equal(p.resolveTask({ definition: { type: 'c42checker', mode: 'nope' }, name: 'x' } as unknown as vscode.Task), undefined);
  assert.equal(p.provideTasks().length, 3);
  cleanup();
});

/* ───────── 旧名称からの移行コマンド ───────── */

function oldNamedProject(): string {
  const { dir } = sampleContext('ok');
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), '{"c42check.targetDir": "."}\n');
  state.folders = [{ uri: { fsPath: dir } }];
  state.messages = [];
  state.warnChoice = undefined;
  state.dirty = new Set();
  return dir;
}
const uiParts = () => {
  const outputs = new Outputs();
  return { outputs, runner: new Runner(outputs, new Problems(), { text: '' } as unknown as vscode.StatusBarItem) };
};

test('移行コマンド: 承認 (書き換える) すると書き換える / 承認しなければ何も変えない', async () => {
  const dir = oldNamedProject();
  const file = path.join(dir, '.vscode', 'settings.json');
  const { outputs, runner } = uiParts();

  state.warnChoice = undefined; // モーダルを閉じた (キャンセル)
  await migrateFromOldName(runner, outputs);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"c42check.targetDir": "."}\n', 'キャンセルでは変えない');

  state.warnChoice = '書き換える';
  await migrateFromOldName(runner, outputs);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"c42checker.targetDir": "."}\n');
  assert.match((outputs.get('移行') as unknown as { text: string }).text, /書き換えました: \.vscode\/settings\.json/);

  state.messages = [];
  await migrateFromOldName(runner, outputs);
  assert.ok(state.messages.some((m) => /見つかりませんでした/.test(m)), '2 回目は「見つかりません」と伝える');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('移行コマンド: 未保存の変更があるファイルは書き換えず、そう伝える', async () => {
  const dir = oldNamedProject();
  const file = path.join(dir, '.vscode', 'settings.json');
  state.dirty = new Set([file]);
  state.warnChoice = '書き換える';
  const { outputs, runner } = uiParts();
  await migrateFromOldName(runner, outputs);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"c42check.targetDir": "."}\n');
  assert.ok(state.messages.some((m) => /未保存の変更があるため/.test(m)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('起動時の案内: 旧名称があれば 1 度案内し、「今後は表示しない」で止まる。旧名称が無ければ何も言わない', async () => {
  const dir = oldNamedProject();
  const store = new Map<string, unknown>();
  const memento = { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => void store.set(k, v) } as unknown as vscode.Memento;
  let ran = 0;
  state.messages = [];
  await suggestMigration(memento, async () => void ran++);
  assert.ok(state.messages.some((m) => /旧名称 \(c42check\)/.test(m)));
  assert.equal(ran, 0, '選ばなければ実行しない');

  (vscode as unknown as { state: { infoChoice?: string } }).state.infoChoice = '今後は表示しない';
  await suggestMigration(memento, async () => void ran++);
  assert.equal(store.get('c42checker.migrationDeclined'), true);
  state.messages = [];
  await suggestMigration(memento, async () => void ran++);
  assert.deepEqual(state.messages, [], '「今後は表示しない」の後は案内しない');

  fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), '{"c42checker.targetDir": "."}\n');
  store.clear();
  await suggestMigration(memento, async () => void ran++);
  assert.deepEqual(state.messages, [], '旧名称が無ければ案内しない');
  (vscode as unknown as { state: { infoChoice?: string } }).state.infoChoice = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});
