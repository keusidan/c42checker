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
  contributes: {
    configuration: { properties: Record<string, { default: unknown; type: string }> };
    commands: { command: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
};

test('「設定」グループに、真偽値の設定 8 つが並ぶ (5 つは指定されたもの + include の削除と二重指定の検出 + Makefile を無視する)', () => {
  const t = tree();
  assert.deepEqual(
    settingItems(t).map((x) => x.item.label),
    [
      'failFast を step にする',
      'ASan 付きデバッグ',
      'Makefile を無視する',
      'Makefile の check ターゲットを使う',
      '実行時 (段階 0) にプロトタイプを同期',
      '保存時にプロトタイプを同期',
      '使っていない #include を削除',
      'include の二重指定を検出',
    ],
  );
});

test('既定: 8 つともすべて OFF (プロトタイプの同期は実行時・保存時とも OFF。ソースを書き換える設定は全て OFF)', () => {
  const t = tree();
  assert.ok(settingItems(t).every((x) => x.item.checkboxState === U.Unchecked));
  assert.equal(DEFAULT_SETTINGS.protoSyncOnRun, false);
  assert.equal(DEFAULT_SETTINGS.protoSyncOnSave, false);
  for (const k of ['c42checker.proto.syncOnRun', 'c42checker.proto.syncOnSave']) {
    assert.equal(pkg.contributes.configuration.properties[k].default, false, `${k} の既定は false`);
  }
});

test('設定 → チェックボックス: settings.json の値の変更が、ツリーの表示に反映される', () => {
  const t = tree();
  state.config['c42checker.failFast'] = 'step';
  state.config['c42checker.debug.sanitizer'] = true;
  state.config['c42checker.ignoreMakefile'] = true;
  state.config['c42checker.useMakeCheckTarget'] = true;
  state.config['c42checker.proto.syncOnRun'] = true;
  state.config['c42checker.proto.syncOnSave'] = true;
  state.config['c42checker.normExtra.removeUnusedIncludes'] = true;
  state.config['c42checker.normExtra.detectDuplicateIncludes'] = true;
  assert.ok(settingItems(t).every((x) => x.item.checkboxState === U.Checked));
  state.config['c42checker.failFast'] = 'stage';
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
  await t.onCheckbox([[items[5].node, U.Checked]]);
  await t.onCheckbox([[items[6].node, U.Checked]]);
  await t.onCheckbox([[items[7].node, U.Checked]]);
  assert.deepEqual(state.updates, [
    { key: 'c42checker.failFast', value: 'step' },
    { key: 'c42checker.debug.sanitizer', value: true },
    { key: 'c42checker.ignoreMakefile', value: true },
    { key: 'c42checker.useMakeCheckTarget', value: true },
    { key: 'c42checker.proto.syncOnRun', value: true },
    { key: 'c42checker.proto.syncOnSave', value: true },
    { key: 'c42checker.normExtra.removeUnusedIncludes', value: true },
    { key: 'c42checker.normExtra.detectDuplicateIncludes', value: true },
  ]);
  await t.onCheckbox([[items[0].node, U.Unchecked]]);
  assert.deepEqual(state.updates.at(-1), { key: 'c42checker.failFast', value: 'stage' });
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
  assert.equal((state.config['c42checker.checks'] as Record<string, boolean>).tsan, true);
  assert.equal(t.getTreeItem(tsan).checkboxState, U.Checked);
});

test('「ヘッダ」グループに「ヘッダにプロトタイプを反映」があり、クリックでコマンドを実行する', () => {
  const t = tree();
  const [action] = t.getChildren(group(t, 'gp'));
  const item = t.getTreeItem(action);
  assert.equal(item.label, 'ヘッダにプロトタイプを反映');
  assert.equal(item.command?.command, 'c42checker.syncPrototypes');
  assert.equal(item.checkboxState, undefined, 'チェックボックスではなくアクション');
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'c42checker.syncPrototypes'));
});

test('トグルの対応表: すべてのキーが package.json の設定に存在し、型が合っている', () => {
  for (const t of TOGGLES) {
    const prop = pkg.contributes.configuration.properties[`c42checker.${t.key}`];
    assert.ok(prop, `c42checker.${t.key} が package.json に無い`);
    // 往復しても同じ: チェック → 設定値 → チェック
    for (const checked of [true, false]) assert.equal(t.fromConfig(t.toConfig(checked)), checked, t.id);
    assert.equal(prop.type === 'boolean' ? typeof t.toConfig(true) === 'boolean' : typeof t.toConfig(true) === 'string', true, t.id);
    assert.equal(t.fromConfig(prop.default), t.defaultValue, `${t.id}: 既定値が package.json と一致`);
  }
});

test('各検証項目に「この項目だけ実行」のボタンがある (ツリーの項目 → コマンド。実行中は出さない)', () => {
  const t = tree();
  for (const g of ['g1', 'g2', 'g3']) {
    for (const n of t.getChildren(group(t, g))) assert.equal(t.getTreeItem(n).contextValue, 'step', '項目の contextValue が menus の条件と一致');
  }
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'c42checker.runStep'));
  const menus = pkg.contributes.menus['view/item/context'].filter((m) => m.command === 'c42checker.runStep');
  assert.ok(menus.some((m) => m.group?.startsWith('inline')), 'ホバーで出るボタン');
  assert.ok(menus.every((m) => /viewItem == step/.test(m.when ?? '') && /!c42checker\.running/.test(m.when ?? '')));
  assert.equal(t.getTreeItem(t.getChildren(group(t, 'gp'))[0]).contextValue, undefined, 'ヘッダの反映は、項目自体のクリックで単独実行できる (ボタンは不要)');
});

test('「ヘッダ」グループに「反映先のヘッダ」があり、現在の指定を見せ、クリックで選択コマンドを実行する', () => {
  const t = tree();
  const nodes = t.getChildren(group(t, 'gp'));
  const item = t.getTreeItem(nodes[1]);
  assert.equal(item.label, '反映先のヘッダ');
  assert.match(String(item.description), /自動/);
  assert.equal(item.command?.command, 'c42checker.selectProtoHeader');
  assert.equal(item.checkboxState, undefined);
  state.config = { 'c42checker.proto.header': 'includes/libft.h' };
  assert.equal(t.getTreeItem(nodes[1]).description, 'includes/libft.h', '設定した値が表示される');
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'c42checker.selectProtoHeader'));
});
