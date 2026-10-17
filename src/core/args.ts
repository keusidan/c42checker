import type { Context, StepId } from './types';

/** shell 風の分割 (クォート・バックスラッシュ対応)。コマンド置換などは扱わない。 */
export function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * 設定 (VS Code の settings.json) で指定された引数の配列を、実際に渡す引数に直す。
 *  - 各要素は shell 風に分割する: `"-lbsd -lm"` は `-lbsd` と `-lm` の 2 つになる。空白を含むパスは `'...'` で囲む
 *  - `${workspaceFolder}` をワークスペースのルートに置き換える (VS Code は独自の設定値の変数を展開してくれないため)
 * shell は介さないので、`$VAR` や `*` は展開されない。
 */
export function normalizeArgs(list: readonly string[] | undefined, root: string): string[] {
  const out: string[] = [];
  for (const item of list ?? []) {
    if (typeof item !== 'string') continue;
    for (const tok of shellSplit(item)) {
      const v = tok.split('${workspaceFolder}').join(root);
      if (v !== '') out.push(v);
    }
  }
  return out;
}

/** 全てのコンパイル (clang / gcc / clang-tidy / compile_commands.json) に足す引数。例: -DDEBUG, -std=gnu11 */
export const extraCflags = (ctx: Context): string[] => normalizeArgs(ctx.settings.compileCflags, ctx.root);

/** リンクする全ビルドの、入力ファイルの前に足す引数。例: -L/usr/local/lib, -Wl,-rpath,... */
export const extraLdflags = (ctx: Context): string[] => normalizeArgs(ctx.settings.compileLdflags, ctx.root);

/** リンクする全ビルドの、入力ファイルの後ろに足す引数。例: -lbsd, -lm (GNU ld は順序に依存する) */
export const extraLibs = (ctx: Context): string[] => normalizeArgs(ctx.settings.compileLibs, ctx.root);

/** 項目ごとの追加引数 (その項目のツールにだけ渡す) */
export const stepArgs = (ctx: Context, id: StepId): string[] =>
  normalizeArgs(ctx.settings.compilePerStep?.[id], ctx.root);
