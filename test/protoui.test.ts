// 「ヘッダにプロトタイプを反映」の UI の流れ (差分エディタのボタン)。vscode は test/vscode-stub.ts に差し替わる。
// VS Code 本体でのボタンの表示・押下は検証できない (制御フローと、通知を出さないこと、無題のドキュメントを作らないこと)。
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { MARKER_BEGIN } from '../src/core/proto';
import { Problems } from '../src/ui/diagnostics';
import { Outputs } from '../src/ui/output';
import { PROPOSAL_SCHEME, ProtoSync } from '../src/ui/protoCommand';
import { Runner } from '../src/ui/runner';
import { sampleContext } from './helpers';

type Stub = {
  folders: unknown[];
  config: Record<string, unknown>;
  messages: string[];
  calls: { cmd: string; args: unknown[] }[];
  context: Record<string, unknown>;
  dirty: Set<string>;
  statusBar: string[];
  openedDocs: number;
  warnChoice?: string;
};
const state = (vscode as unknown as { state: Stub }).state;
const tabGroup = (vscode as unknown as { tabGroup: { tabs: unknown[]; activeTab: unknown } }).tabGroup;

function setup(overrides: Record<string, unknown> = {}) {
  const c = sampleContext('proto-ok', overrides);
  state.folders = [{ uri: { fsPath: c.dir } }];
  state.config = {};
  state.messages = [];
  state.calls = [];
  state.context = {};
  state.dirty = new Set();
  state.statusBar = [];
  state.openedDocs = 0;
  state.warnChoice = undefined;
  tabGroup.tabs = [];
  tabGroup.activeTab = undefined;
  const outputs = new Outputs();
  const runner = new Runner(outputs, new Problems(), { text: '' } as unknown as vscode.StatusBarItem);
  const proto = new ProtoSync(outputs, new Problems(), runner);
  const header = path.join(c.dir, 'includes', 'proj.h');
  return { ...c, proto, header, read: () => fs.readFileSync(header, 'utf8'), diffCalls: () => state.calls.filter((x) => x.cmd === 'vscode.diff') };
}

const hasCtags = async (e: ReturnType<typeof setup>): Promise<boolean> => {
  await e.proto.runCommand();
  return e.diffCalls().length > 0;
};

test('コマンド: 差分エディタを開くだけ。ヘッダは変えず、通知も出さず、無題のドキュメントも作らない', async (t) => {
  const e = setup();
  const before = e.read();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  assert.equal(e.read(), before, '承認するまで、ヘッダは変わらない');
  assert.deepEqual(state.messages, [], '通知 (「反映する / キャンセル」) を出さない');
  assert.equal(state.openedDocs, 0, 'openTextDocument で無題のドキュメントを作らない (保存ダイアログ "Untitled-1.c" の原因)');
  const [left, right] = e.diffCalls()[0].args as { scheme: string; path: string }[];
  assert.equal(left.scheme, 'file');
  assert.equal(right.scheme, PROPOSAL_SCHEME, '右側は、読み取り専用の仮想ドキュメント');
  assert.ok(right.path.endsWith('/includes/proj.h'), '拡張子が .h なので、C として色が付く');
  assert.equal(state.context['c42check.proposalActive'], true, 'タイトルバーのボタンの表示条件');
  assert.match(String(e.diffCalls()[0].args[2]), /^includes\/proj\.h ↔ プロトタイプ反映案 \(5 件\)$/);
  e.proto.dispose();
  e.cleanup();
});

test('仮想ドキュメントは、反映案の全文を返す', async (t) => {
  const e = setup();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  const right = e.diffCalls()[0].args[1] as vscode.Uri;
  const text = e.proto.provider.provideTextDocumentContent(right);
  assert.ok(text.includes(MARKER_BEGIN) && text.includes('ft_strdup'));
  assert.ok(text.startsWith('/* ****'), '42 ヘッダを含むヘッダ全文');
  e.proto.dispose();
  e.cleanup();
});

test('「反映する」ボタン: ヘッダを書き換え、差分エディタを閉じ、通知は出さない', async (t) => {
  const e = setup();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  await e.proto.applyProposal();
  assert.match(e.read(), /char\t+\*ft_strdup\(const char \*s\);/);
  assert.equal(tabGroup.tabs.length, 0, '差分エディタが閉じる (反映後に差分が残りっぱなしにならない)');
  assert.deepEqual(state.messages, [], '成功時は通知を出さない');
  assert.equal(state.context['c42check.proposalActive'], false);
  const after = e.read();
  await e.proto.applyProposal(); // 2 回目は何もしない
  assert.equal(e.read(), after);
  assert.deepEqual(state.messages, []);
  e.proto.dispose();
  e.cleanup();
});

test('「キャンセル」ボタン: ヘッダは変えず、差分エディタを閉じ、通知は出さない', async (t) => {
  const e = setup();
  const before = e.read();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  e.proto.cancelProposal();
  assert.equal(e.read(), before);
  assert.equal(tabGroup.tabs.length, 0);
  assert.deepEqual(state.messages, []);
  await e.proto.applyProposal();
  assert.equal(e.read(), before, 'キャンセルした案は、もう反映できない');
  e.proto.dispose();
  e.cleanup();
});

test('利用者が差分のタブを × で閉じたら、反映案も捨てる', async (t) => {
  const e = setup();
  const before = e.read();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  await vscode.window.tabGroups.close(tabGroup.tabs[0] as vscode.Tab);
  await e.proto.applyProposal();
  assert.equal(e.read(), before);
  e.proto.dispose();
  e.cleanup();
});

test('もう一度コマンドを実行したら、前の案は閉じて 1 つだけ開く', async (t) => {
  const e = setup();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  await e.proto.runCommand();
  assert.equal(e.diffCalls().length, 2);
  assert.equal(tabGroup.tabs.length, 1, '差分エディタが増えない');
  e.proto.dispose();
  e.cleanup();
});

test('差分を表示している間にヘッダが変わっていたら、上書きせずエラー (案も捨てる)', async (t) => {
  const e = setup();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  const edited = e.read() + '/* 別の変更 */\n';
  fs.writeFileSync(e.header, edited);
  await e.proto.applyProposal();
  assert.equal(e.read(), edited, '他の変更を上書きしない');
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /変更されました/);
  assert.equal(tabGroup.tabs.length, 0);
  e.proto.dispose();
  e.cleanup();
});

test('ヘッダに未保存の変更があるとき: 開く前も、ボタンを押したときも、書き換えない', async (t) => {
  const e = setup();
  state.dirty.add(e.header);
  await e.proto.runCommand();
  if (e.diffCalls().length === 0 && state.messages.some((m) => /ctags/.test(m))) return t.skip('ctags が無い');
  assert.equal(e.diffCalls().length, 0, '未保存なら、案を開かない');
  assert.match(state.messages.at(-1) ?? '', /未保存の変更/);

  state.dirty.clear();
  state.messages = [];
  await e.proto.runCommand();
  assert.equal(e.diffCalls().length, 1);
  state.dirty.add(e.header);
  const before = e.read();
  await e.proto.applyProposal();
  assert.equal(e.read(), before, '案を開いた後に未保存になっても、書き換えない');
  assert.match(state.messages.at(-1) ?? '', /未保存の変更/);
  assert.equal(tabGroup.tabs.length, 1, '案は残るので、保存してからもう一度ボタンを押せる');
  state.dirty.clear();
  await e.proto.applyProposal();
  assert.match(e.read(), /ft_strdup/);
  e.proto.dispose();
  e.cleanup();
});

test('変更なし: 差分は開かず、通知ではなくステータスバーに短く出す', async (t) => {
  const e = setup();
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  await e.proto.applyProposal();
  state.calls = [];
  state.messages = [];
  await e.proto.runCommand();
  assert.equal(e.diffCalls().length, 0);
  assert.deepEqual(state.messages, []);
  assert.match(state.statusBar.at(-1) ?? '', /最新です/);
  e.proto.dispose();
  e.cleanup();
});

test('norminette が指摘したときだけ通知する (元に戻せる)', async (t) => {
  const e = setup();
  if (!e.ctx.tools.norminette) return t.skip('norminette が無い');
  // 80 桁を超える宣言になる関数を足す (norm 違反: LINE_TOO_LONG)
  fs.writeFileSync(
    path.join(e.dir, 'src', 'long.c'),
    'int\tft_function_with_a_really_long_name_for_alignment_test(unsigned long long first_parameter, unsigned long long second_one)\n{\n\treturn (0);\n}\n',
  );
  const { createContext } = await import('../src/core/context');
  void createContext;
  if (!(await hasCtags(e))) return t.skip('ctags が無い');
  const before = e.read();
  state.warnChoice = '元に戻す';
  await e.proto.applyProposal();
  assert.equal(state.messages.length, 1, '通知はこの 1 件だけ');
  assert.match(state.messages[0], /norminette が .* 件を指摘/);
  assert.equal(e.read(), before, '「元に戻す」で、反映前の内容に戻る');
  assert.match(String(e.diffCalls()[0].args[2]), /⚠ 80 桁超 1 件/, '差分のタイトルで、事前に分かる');
  e.proto.dispose();
  e.cleanup();
});

test('package.json: 差分エディタのタイトルバーに「反映する」「キャンセル」ボタンがある (反映案が開いているときだけ、コマンドパレットからも実行できる)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    contributes: {
      commands: { command: string; icon?: string }[];
      menus: Record<string, { command: string; when: string }[]>;
    };
  };
  const cmds = pkg.contributes.commands.map((c) => c.command);
  for (const c of ['c42check.applyProposal', 'c42check.cancelProposal']) {
    assert.ok(cmds.includes(c));
    const m = pkg.contributes.menus['editor/title'].find((x) => x.command === c);
    assert.equal(m?.when, 'c42check.proposalActive');
    assert.ok(pkg.contributes.menus.commandPalette.some((x) => x.command === c && x.when === 'c42check.proposalActive'), 'ボタンが出ない場合の逃げ道: 反映案が開いているときだけ、コマンドパレットから実行できる');
  }
});
