import * as vscode from 'vscode';
import { INSTALL_HINTS, STEP_TOOL, detectTools } from '../core/tools';
import { STEPS } from '../core/steps';
import type { StepId, Tools } from '../core/types';
import { readChecks, writeCheck } from './config';
import type { NodeStatus, Runner } from './runner';

const OPTIONAL: ReadonlySet<StepId> = new Set(['cbmc', 'framaC']);

type Node = { kind: 'group'; id: string; label: string; ids: StepId[] } | { kind: 'step'; id: StepId };

const GROUPS: Node[] = [
  { kind: 'group', id: 'g1', label: '段階 1: 事前チェック (静的)', ids: STEPS.filter((s) => s.stage === 1).map((s) => s.id) },
  {
    kind: 'group',
    id: 'g2',
    label: '段階 2: 動的チェック',
    ids: STEPS.filter((s) => s.stage === 2 && !OPTIONAL.has(s.id)).map((s) => s.id),
  },
  { kind: 'group', id: 'g3', label: '任意 (ネイティブのみ)', ids: [...OPTIONAL] },
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
    if (node.kind === 'group') return node.ids.map((id) => ({ kind: 'step', id }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.id;
      return item;
    }
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

  /** チェックボックスの変更をワークスペース設定に保存する。 */
  async onCheckbox(items: readonly (readonly [Node, vscode.TreeItemCheckboxState])[]): Promise<void> {
    for (const [node, state] of items) {
      if (node.kind === 'step') await writeCheck(node.id, state === vscode.TreeItemCheckboxState.Checked);
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
