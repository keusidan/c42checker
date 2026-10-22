import { parseJsonc } from './jsonc';

export const PRE_DEBUG_LABEL = 'c42check: pre-debug';
export const BUILD_DEBUG_LABEL = 'c42check: build-debug';
export const DEBUG_PROGRAM = '${workspaceFolder}/.42check/debug/prog';

export interface LaunchOptions {
  cwd: string;
  terminal: string;
}

export type Json = Record<string, unknown>;

/** CodeLLDB (type: lldb) の launch 構成。上が F5 の既定 (事前チェックあり)。 */
export function buildLaunchConfigs(o: LaunchOptions): Json[] {
  const base = {
    type: 'lldb',
    request: 'launch',
    program: DEBUG_PROGRAM,
    // CodeLLDB は args が文字列なら shell 風に分割する。設定 c42check.runArgs を返すコマンドで差し込む。
    args: '${command:c42check.runArgs}',
    cwd: o.cwd,
    terminal: o.terminal,
  };
  return [
    { name: 'Debug (42 Check: 事前チェック → LLDB)', ...base, preLaunchTask: PRE_DEBUG_LABEL },
    { name: 'Debug (skip checks) ※事前チェックを飛ばす', ...base, preLaunchTask: BUILD_DEBUG_LABEL },
  ];
}

export function buildTasks(): Json[] {
  const mk = (label: string, mode: string): Json => ({
    label,
    type: 'c42check',
    mode,
    problemMatcher: [],
    presentation: { reveal: 'always', clear: true },
  });
  return [mk(PRE_DEBUG_LABEL, 'pre-debug'), mk(BUILD_DEBUG_LABEL, 'build-debug')];
}

export interface MergeResult {
  /** 既存に無く、追加する項目 */
  added: string[];
  /** 既に同名の項目があり、触らない項目 */
  kept: string[];
  /** 書き出す内容 (整形済み JSON)。added が空なら null */
  merged: string | null;
}

/**
 * 既存の launch.json / tasks.json に、無い項目だけを足したマージ案を作る。
 * 既存の項目は 1 つも変更しない。コメントは JSON に変換する際に失われる点に注意。
 */
export function mergeJsonFile(
  existingText: string | undefined,
  listKey: 'configurations' | 'tasks',
  idKey: 'name' | 'label',
  desired: Json[],
  version: string,
): MergeResult {
  let doc: Json = { version };
  if (existingText !== undefined && existingText.trim() !== '') {
    const parsed = parseJsonc(existingText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('トップレベルがオブジェクトではありません');
    }
    doc = parsed as Json;
  }
  const list = Array.isArray(doc[listKey]) ? [...(doc[listKey] as Json[])] : [];
  const added: string[] = [];
  const kept: string[] = [];
  const newItems: Json[] = [];
  for (const d of desired) {
    const id = String(d[idKey]);
    if (list.some((e) => e[idKey] === id)) kept.push(id);
    else {
      added.push(id);
      newItems.push(d);
    }
  }
  if (added.length === 0) return { added, kept, merged: null };
  // 私たちの構成を先頭に置く (F5 の既定にするため)。既存の順序は保つ。
  doc[listKey] = [...newItems, ...list];
  if (doc.version === undefined) doc.version = version;
  return { added, kept, merged: JSON.stringify(doc, null, 2) + '\n' };
}

/** launch.json の本文から、42 Check の構成が使われているか。 */
export function usesC42check(launchText: string): boolean {
  try {
    const doc = parseJsonc(launchText) as { configurations?: Json[] };
    return (doc.configurations ?? []).some((c) => String(c.preLaunchTask ?? '').startsWith('c42check:'));
  } catch {
    return false;
  }
}

/** c42check.runArgs を、CodeLLDB が shell 風に分割できる 1 つの文字列にする。 */
export function shellQuoteArgs(args: string[]): string {
  return args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
}
