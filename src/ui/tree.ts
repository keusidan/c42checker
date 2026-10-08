import * as vscode from 'vscode';
import { INSTALL_HINTS, STEP_TOOL, detectTools } from '../core/tools';
import { STEPS } from '../core/steps';
import type { StepId, Tools } from '../core/types';
import { TOGGLES } from '../core/toggles';
import { readChecks, readToggle, toggleById, writeCheck, writeToggle } from './config';
import type { NodeStatus, Runner } from './runner';

const OPTIONAL: ReadonlySet<StepId> = new Set(['cbmc', 'framaC']);

type Node =
  | { kind: 'group'; id: string; label: string; ids?: StepId[]; items?: Node[] }
  | { kind: 'step'; id: StepId }
  | { kind: 'setting'; id: string }
  | { kind: 'action'; id: 'syncPrototypes' };

const GROUPS: Node[] = [
  { kind: 'group', id: 'g1', label: '段階 1: 事前チェック (静的)', ids: STEPS.filter((s) => s.stage === 1).map((s) => s.id) },
  {
    kind: 'group',
    id: 'g2',
    label: '段階 2: 動的チェック',
    ids: STEPS.filter((s) => s.stage === 2 && !OPTIONAL.has(s.id)).map((s) => s.id),
  },
  { kind: 'group', id: 'g3', label: '任意 (ネイティブのみ)', ids: [...OPTIONAL] },
  { kind: 'group', id: 'gp', label: 'ヘッダ', items: [{ kind: 'action', id: 'syncPrototypes' }] },
  { kind: 'group', id: 'gs', label: '設定', items: TOGGLES.map((t) => ({ kind: 'setting', id: t.id }) as Node) },
];

const STATUS_TEXT: Record<NodeStatus, string> = {
  pending: '',
  running: '実行中…',
  pass: '成功',
  fail: '失敗',
  skip: 'skip',
};

function iconFor(status: NodeStatus, missing: boolean): vscode.ThemeIcon {
  switch (status) {
    case 'running':
      return new vscode.ThemeIcon('sync~spin');
    case 'pass':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'fail':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'skip':
      return new vscode.ThemeIcon('debug-step-over', new vscode.ThemeColor('testing.iconSkipped'));
    default:
      return new vscode.ThemeIcon(missing ? 'circle-slash' : 'circle-outline');
  }
}

export class CheckTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tools: Tools = detectTools();
  private readonly sub: vscode.Disposable;

  constructor(private readonly runner: Runner) {
    this.sub = runner.onDidChange(() => this.emitter.fire(undefined));
  }

  /** ツールを再検出して描画し直す。 */
  refresh(): void {
    this.tools = detectTools();
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return GROUPS;
    if (node.kind === 'group') return node.items ?? (node.ids ?? []).map((id) => ({ kind: 'step', id }) as Node);
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      return item;
    }
    if (node.kind === 'setting') return this.settingItem(node.id);
    if (node.kind === 'action') return this.actionItem();
    const step = STEPS.find((s) => s.id === node.id)!;
    const status = this.runner.statusOf(node.id);
    const toolKey = STEP_TOOL[node.id];
    const missing = !this.tools[toolKey];
    const result = this.runner.resultOf(node.id);

    const item = new vscode.TreeItem(step.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.checkboxState = readChecks()[node.id]
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.iconPath = iconFor(status, missing);
    item.description =
      status === 'pending' && missing
        ? `未検出 (${toolKey})`
        : status === 'skip' || status === 'fail'
          ? `${STATUS_TEXT[status]}: ${result?.reason ?? ''}`
          : STATUS_TEXT[status];
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${step.label}** (段階 ${step.stage})`);
    if (missing) tip.appendMarkdown(`\n\n未検出: ${INSTALL_HINTS[toolKey]}`);
    if (result?.reason) tip.appendMarkdown(`\n\n${result.reason}`);
    if (result?.hint) tip.appendMarkdown(`\n\n対処案: ${result.hint}`);
    item.tooltip = tip;
    item.command = { command: 'c42check.showLog', title: 'ログを表示', arguments: [step.label] };
    return item;
  }

  /** 真偽値の設定。チェック状態は settings.json の対応キーの値そのもの (設定側を直接編集しても、再描画で追従する)。 */
  private settingItem(id: string): vscode.TreeItem {
    const def = toggleById(id)!;
    const item = new vscode.TreeItem(def.label, vscode.TreeItemCollapsibleState.None);
    item.id = `setting:${id}`;
    item.checkboxState = readToggle(def)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.iconPath = new vscode.ThemeIcon('settings-gear');
    item.description = `c42check.${def.key}`;
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${def.label}**\n\n${def.description}\n\n設定キー: \`c42check.${def.key}\` (ワークスペースの settings.json と双方向に同期)`);
    item.tooltip = tip;
    return item;
  }

  /** 「ヘッダにプロトタイプを反映」。クリックでコマンドを実行する (チェックボックスなし)。 */
  private actionItem(): vscode.TreeItem {
    const missing = !this.tools.ctags;
    const item = new vscode.TreeItem('ヘッダにプロトタイプを反映', vscode.TreeItemCollapsibleState.None);
    item.id = 'action:syncPrototypes';
    item.iconPath = new vscode.ThemeIcon(missing ? 'circle-slash' : 'symbol-method');
    item.description = missing ? '未検出 (ctags)' : '差分を確認して反映';
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown('**ヘッダにプロトタイプを反映**\n\nuniversal-ctags で .c の関数定義を抽出し、ヘッダの auto prototypes の区間だけを書き換えます (書き換え前に差分を表示)。');
    if (missing) tip.appendMarkdown(`\n\n未検出: ${INSTALL_HINTS.ctags}`);
    item.tooltip = tip;
    item.command = { command: 'c42check.syncPrototypes', title: 'ヘッダにプロトタイプを反映' };
    return item;
  }

  /** チェックボックスの変更をワークスペース設定に保存する。 */
  async onCheckbox(items: readonly (readonly [Node, vscode.TreeItemCheckboxState])[]): Promise<void> {
    for (const [node, state] of items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if (node.kind === 'step') await writeCheck(node.id, checked);
      else if (node.kind === 'setting') await writeToggle(toggleById(node.id)!, checked);
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
