// 「設定」グループ (チェックボックス ↔ settings.json) と「ヘッダ」グループの検証。vscode は stub に差し替わる。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { TOGGLES } from '../src/core/toggles';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { Problems } from '../src/ui/diagnostics';
import { Outputs } from '../src/ui/output';
import { Runner } from '../src/ui/runner';
import { CheckTree } from '../src/ui/tree';

const state = (vscode as unknown as { state: { config: Record<string, unknown>; updates: { key: string; value: unknown }[] } }).state;
const U = vscode.TreeItemCheckboxState;

function tree() {
  state.config = {};
  state.updates = [];
  const runner = new Runner(new Outputs(), new Problems(), { text: '' } as unknown as vscode.StatusBarItem);
  return new CheckTree(runner);
}
const group = (t: CheckTree, id: string) => t.getChildren().find((n) => n.kind === 'group' && n.id === id)!;
const settingItems = (t: CheckTree) => t.getChildren(group(t, 'gs')).map((n) => ({ node: n, item: t.getTreeItem(n) }));

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { default: unknown; type: string }> }; commands: { command: string }[] };
};

test('「設定」グループに、指定された 5 つの真偽値の設定が並ぶ', () => {
  const t = tree();
  assert.deepEqual(
    settingItems(t).map((x) => x.item.label),
    [
      'failFast を step にする',
      'ASan 付きデバッグ',
      'Makefile の check ターゲットを使う',
      '実行時 (段階 0) にプロトタイプを同期',
      '保存時にプロトタイプを同期',
    ],
  );
});

test('既定: 5 つともすべて OFF (プロトタイプの同期は実行時・保存時とも OFF)', () => {
  const t = tree();
  assert.ok(settingItems(t).every((x) => x.item.checkboxState === U.Unchecked));
  assert.equal(DEFAULT_SETTINGS.protoSyncOnRun, false);
  assert.equal(DEFAULT_SETTINGS.protoSyncOnSave, false);
  for (const k of ['c42check.proto.syncOnRun', 'c42check.proto.syncOnSave']) {
    assert.equal(pkg.contributes.configuration.properties[k].default, false, `${k} の既定は false`);
  }
});

test('設定 → チェックボックス: settings.json の値の変更が、ツリーの表示に反映される', () => {
  const t = tree();
  state.config['c42check.failFast'] = 'step';
  state.config['c42check.debug.sanitizer'] = true;
  state.config['c42check.useMakeCheckTarget'] = true;
  state.config['c42check.proto.syncOnRun'] = true;
  state.config['c42check.proto.syncOnSave'] = true;
  assert.ok(settingItems(t).every((x) => x.item.checkboxState === U.Checked));
  state.config['c42check.failFast'] = 'stage';
  assert.equal(settingItems(t)[0].item.checkboxState, U.Unchecked, '"stage" は OFF');
});

test('チェックボックス → 設定: 対応するキーに書き込む (failFast は "step" / "stage" に変換)', async () => {
  const t = tree();
  const items = settingItems(t);
  await t.onCheckbox([[items[0].node, U.Checked]]);
  await t.onCheckbox([[items[1].node, U.Checked]]);
  await t.onCheckbox([[items[2].node, U.Checked]]);
  await t.onCheckbox([[items[3].node, U.Checked]]);
  await t.onCheckbox([[items[4].node, U.Checked]]);
  assert.deepEqual(state.updates, [
    { key: 'c42check.failFast', value: 'step' },
    { key: 'c42check.debug.sanitizer', value: true },
    { key: 'c42check.useMakeCheckTarget', value: true },
    { key: 'c42check.proto.syncOnRun', value: true },
    { key: 'c42check.proto.syncOnSave', value: true },
  ]);
  await t.onCheckbox([[items[0].node, U.Unchecked]]);
  assert.deepEqual(state.updates.at(-1), { key: 'c42check.failFast', value: 'stage' });
  // 書いた値が、そのままツリーに反映される (双方向)
  assert.equal(settingItems(t)[0].item.checkboxState, U.Unchecked);
  assert.equal(settingItems(t)[1].item.checkboxState, U.Checked);
});

test('チェック項目 (段階 1 / 2) の保存と、設定トグルは互いに干渉しない', async () => {
  const t = tree();
  const g2 = t.getChildren(group(t, 'g2'));
  const labels = g2.map((n) => t.getTreeItem(n).label);
  assert.deepEqual(labels, ['ASan + UBSan', 'TSan', 'MSan', 'valgrind'], 'TSan / MSan が選択式の項目として並ぶ');
  const tsan = g2[1];
  assert.equal(t.getTreeItem(tsan).checkboxState, U.Unchecked, 'TSan は既定 OFF');
  await t.onCheckbox([[tsan, U.Checked]]);
  assert.equal((state.config['c42check.checks'] as Record<string, boolean>).tsan, true);
  assert.equal(t.getTreeItem(tsan).checkboxState, U.Checked);
});

test('「ヘッダ」グループに「ヘッダにプロトタイプを反映」があり、クリックでコマンドを実行する', () => {
  const t = tree();
  const [action] = t.getChildren(group(t, 'gp'));
  const item = t.getTreeItem(action);
  assert.equal(item.label, 'ヘッダにプロトタイプを反映');
  assert.equal(item.command?.command, 'c42check.syncPrototypes');
  assert.equal(item.checkboxState, undefined, 'チェックボックスではなくアクション');
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'c42check.syncPrototypes'));
});

test('トグルの対応表: すべてのキーが package.json の設定に存在し、型が合っている', () => {
  for (const t of TOGGLES) {
    const prop = pkg.contributes.configuration.properties[`c42check.${t.key}`];
    assert.ok(prop, `c42check.${t.key} が package.json に無い`);
    // 往復しても同じ: チェック → 設定値 → チェック
    for (const checked of [true, false]) assert.equal(t.fromConfig(t.toConfig(checked)), checked, t.id);
    assert.equal(prop.type === 'boolean' ? typeof t.toConfig(true) === 'boolean' : typeof t.toConfig(true) === 'string', true, t.id);
    assert.equal(t.fromConfig(prop.default), t.defaultValue, `${t.id}: 既定値が package.json と一致`);
  }
});
