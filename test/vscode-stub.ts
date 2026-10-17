// テスト専用の `vscode` module 代替 (esbuild の alias で差し替える)。
// UI 層の制御フロー (Runner → Task の終了コード) を、VS Code 本体なしで検証するための最小実装。
// VS Code 本体の挙動 (preLaunchTask が非 0 でデバッガを止める等) は検証できない。

export const state = {
  folders: [] as { uri: { fsPath: string } }[],
  config: {} as Record<string, unknown>,
  trusted: true,
  messages: [] as string[],
  updates: [] as { key: string; value: unknown }[],
  /** executeCommand の呼び出し履歴 */
  calls: [] as { cmd: string; args: unknown[] }[],
  /** setContext で設定されたコンテキストキー */
  context: {} as Record<string, unknown>,
  /** エディタで未保存の変更がある (isDirty) ファイルの fsPath */
  dirty: new Set<string>(),
  statusBar: [] as string[],
  /** workspace.openTextDocument の呼び出し回数 (無題のドキュメントを作ると、保存ダイアログが出てしまう) */
  openedDocs: 0,
  /** showWarningMessage が選んだ項目 */
  warnChoice: undefined as string | undefined,
};

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => undefined };
  };
  fire(e?: T): void {
    for (const l of this.listeners) l(e as T);
  }
  dispose(): void {
    this.listeners = [];
  }
}

const ok = async (m: string): Promise<undefined> => {
  state.messages.push(m);
  return undefined;
};

interface Tab {
  input: unknown;
  label: string;
}
const tabEmitter = new EventEmitter<{ opened: Tab[]; closed: Tab[]; changed: Tab[] }>();
export const tabGroup = { tabs: [] as Tab[], activeTab: undefined as Tab | undefined };

export const window = {
  createOutputChannel: (name: string) => ({
    name,
    text: '',
    append(t: string) {
      this.text += t;
    },
    appendLine(t: string) {
      this.text += t + '\n';
    },
    clear() {
      this.text = '';
    },
    show: () => undefined,
    dispose: () => undefined,
  }),
  showErrorMessage: ok,
  showWarningMessage: async (m: string) => {
    state.messages.push(m);
    return state.warnChoice;
  },
  showInformationMessage: ok,
  setStatusBarMessage: (m: string) => {
    state.statusBar.push(m);
    return { dispose: () => undefined };
  },
  tabGroups: {
    get all() {
      return [tabGroup];
    },
    get activeTabGroup() {
      return tabGroup;
    },
    onDidChangeTabs: tabEmitter.event,
    close: async (tab: Tab) => {
      tabGroup.tabs = tabGroup.tabs.filter((t) => t !== tab);
      if (tabGroup.activeTab === tab) tabGroup.activeTab = tabGroup.tabs.at(-1);
      tabEmitter.fire({ opened: [], closed: [tab], changed: [] });
      return true;
    },
  },
};

export const workspace = {
  get workspaceFolders() {
    return state.folders;
  },
  get isTrusted() {
    return state.trusted;
  },
  get textDocuments() {
    return [...state.dirty].map((p) => ({ isDirty: true, uri: { fsPath: p } }));
  },
  openTextDocument: async () => {
    state.openedDocs++;
    throw new Error('無題のドキュメントは作らない (保存ダイアログが出る)');
  },
  registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  getConfiguration: (section: string) => ({
    get: (key: string) => state.config[`${section}.${key}`],
    update: async (key: string, value: unknown) => {
      state.config[`${section}.${key}`] = value;
      state.updates.push({ key: `${section}.${key}`, value });
    },
  }),
};

/** 差分エディタのタブ (vscode.diff を実行すると増える) */
export class TabInputTextDiff {
  constructor(
    public original: UriImpl,
    public modified: UriImpl,
  ) {}
}
export const commands = {
  executeCommand: async (cmd: string, ...args: unknown[]) => {
    state.calls.push({ cmd, args });
    if (cmd === 'setContext') state.context[String(args[0])] = args[1];
    if (cmd === 'vscode.diff') {
      const tab: Tab = { input: new TabInputTextDiff(args[0] as UriImpl, args[1] as UriImpl), label: String(args[2]) };
      tabGroup.tabs.push(tab);
      tabGroup.activeTab = tab;
      tabEmitter.fire({ opened: [tab], closed: [], changed: [] });
    }
    return undefined;
  },
};

export const languages = {
  createDiagnosticCollection: () => ({
    entries: new Map<string, unknown[]>(),
    clear() {
      this.entries.clear();
    },
    set(uri: { fsPath: string }, list: unknown[]) {
      this.entries.set(uri.fsPath, list);
    },
    dispose: () => undefined,
  }),
};

export class UriImpl {
  constructor(
    public scheme: string,
    public path: string,
    public query = '',
  ) {}
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}
export const Uri = {
  file: (fsPath: string) => new UriImpl('file', fsPath),
  from: (c: { scheme: string; path: string; query?: string }) => new UriImpl(c.scheme, c.path, c.query),
};
export class Range {
  constructor(
    public sl: number,
    public sc: number,
    public el: number,
    public ec: number,
  ) {}
}
export class Diagnostic {
  source?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity: number,
  ) {}
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const ConfigurationTarget = { Workspace: 2 };

export const TaskScope = { Workspace: 2 };
export class CustomExecution {
  constructor(public callback: () => Promise<unknown>) {}
}
export class Task {
  group: unknown;
  constructor(
    public definition: Record<string, unknown>,
    public scope: unknown,
    public name: string,
    public source: string,
    public execution: CustomExecution,
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 };
export class TreeItem {
  id?: string;
  checkboxState?: number;
  iconPath?: unknown;
  description?: string;
  tooltip?: unknown;
  command?: { command: string; title: string };
  constructor(
    public label: string,
    public collapsibleState: number,
  ) {}
}
export class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
export class MarkdownString {
  value = '';
  appendMarkdown(t: string) {
    this.value += t;
    return this;
  }
}
