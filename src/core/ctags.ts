import * as path from 'node:path';
import { exec } from './exec';
import { CANDIDATES, findOnPath } from './tools';

export interface CtagsFunction {
  name: string;
  file: string; // 絶対パス
  line: number;
  /** ctags の typeref (例: `typename:char *` / `struct:s_list *`) */
  typeref?: string;
  /** ctags の signature (例: `(const char * s,int n)`)。空白は ctags が正規化している */
  signature?: string;
  isStatic: boolean;
}

export interface CtagsResolved {
  bin?: string;
  reason?: string;
  hint?: string;
}

const verified = new Map<string, boolean>();

/**
 * Universal Ctags の実行ファイルを探す。`ctags` という名前は Exuberant Ctags や Emacs の etags のことがあり、
 * 出力の拡張フィールド (typeref / signature / file:) が無いため、--version で Universal Ctags であることを確認する。
 */
export async function resolveCtags(envPath = process.env.PATH ?? ''): Promise<CtagsResolved> {
  const present = CANDIDATES.ctags.filter((n) => findOnPath(n, envPath));
  if (present.length === 0) {
    return {
      reason: 'universal-ctags (ctags-universal) が PATH にありません',
      hint: 'Arch: `sudo pacman -S ctags` / Ubuntu: `sudo apt install universal-ctags`。sudo が使えない環境では、ソースから `--prefix=$HOME/.local` でビルドして PATH に通してください (容量に注意)',
    };
  }
  for (const name of present) {
    const key = `${envPath}\0${name}`;
    let ok = verified.get(key);
    if (ok === undefined) {
      const r = await exec(name, ['--version'], { cwd: process.cwd(), timeoutMs: 10_000, env: { ...process.env, PATH: envPath } });
      ok = /Universal Ctags/i.test(r.output);
      verified.set(key, ok);
    }
    if (ok) return { bin: name };
  }
  return {
    reason: `${present.join(', ')} は Universal Ctags ではありません (Exuberant / GNU 版は、戻り値の型と引数を取り出せないため使えません)`,
    hint: 'Universal Ctags を入れてください。Arch: `sudo pacman -S ctags` / Ubuntu: `sudo apt install universal-ctags`',
  };
}

export interface CtagsOutput {
  funcs: CtagsFunction[];
  /** ctags 自身の警告・エラー行 (`ctags: Warning: ...`) */
  warnings: string[];
}

/**
 * tag 形式の出力を読む。1 行 = `name<TAB>file<TAB>line;"<TAB>kind<TAB>key:value...`。
 * JSON 出力 (jansson 必須) には依存しない。
 */
export function parseTags(output: string, cwd: string, kinds: readonly string[] = ['function']): CtagsOutput {
  const funcs: CtagsFunction[] = [];
  const warnings: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('!_')) continue;
    if (line.startsWith('ctags') || line.startsWith('universal-ctags')) {
      warnings.push(line);
      continue;
    }
    const cols = line.split('\t');
    if (cols.length < 4) continue;
    const [name, file, addr, kind, ...fields] = cols;
    if (!kinds.includes(kind)) continue;
    const f: CtagsFunction = {
      name,
      file: path.resolve(cwd, file),
      line: Number.parseInt(addr, 10) || 0,
      isStatic: false,
    };
    for (const fld of fields) {
      if (fld === 'file:') f.isStatic = true; // file: = 定義したファイルの中だけで見える = static
      else if (fld.startsWith('typeref:')) f.typeref = fld.slice('typeref:'.length);
      else if (fld.startsWith('signature:')) f.signature = fld.slice('signature:'.length);
    }
    funcs.push(f);
  }
  return { funcs, warnings };
}

export interface CtagsRun extends CtagsOutput {
  ok: boolean;
  error?: string;
  log: string;
}

/** 関数定義 (kind f) だけを、与えたファイルの順に取り出す。 */
export async function runCtags(
  bin: string,
  files: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  /** ctags の kind 文字: f = 関数定義、p = プロトタイプ (ヘッダの宣言) */
  kinds = 'f',
): Promise<CtagsRun> {
  const args = [
    '--languages=C',
    '--langmap=C:.c.h',
    `--kinds-C=${kinds}`,
    '--fields=+KSt',
    '--excmd=number',
    '--sort=no',
    '-f',
    '-',
    ...files,
  ];
  const r = await exec(bin, args, { cwd, timeoutMs, signal, maxBytes: 16 * 1024 * 1024 });
  const log = `$ ${bin} ${args.slice(0, 9).join(' ')} ... (${files.length} files)\n${r.output.length > 4000 ? r.output.slice(0, 4000) + '\n[省略]\n' : r.output}`;
  if (r.error) return { ok: false, error: r.error, funcs: [], warnings: [], log };
  if (r.timedOut) return { ok: false, error: 'ctags が制限時間内に終わりませんでした', funcs: [], warnings: [], log };
  const parsed = parseTags(
    r.output,
    cwd,
    kinds.split('').map((k) => (k === 'p' ? 'prototype' : 'function')),
  );
  // ctags は読めない入力ファイルがあっても終了コード 0 で、stderr に警告を出すだけ
  const bad = parsed.warnings.filter((w) => /cannot open|error/i.test(w));
  if (r.code !== 0 || bad.length > 0) {
    return { ok: false, error: bad[0] ?? `ctags が終了コード ${r.code} で終了しました`, ...parsed, log };
  }
  return { ok: true, ...parsed, log };
}

const SYMBOL_KINDS = ['macro', 'function', 'prototype', 'enumerator', 'enum', 'member', 'struct', 'typedef', 'union', 'variable', 'externvar'];

/** ヘッダが宣言している名前 (マクロ / 関数 / 型 / 列挙子 / 変数 / メンバ) を、ファイルごとに集める。 */
export async function runCtagsSymbols(
  bin: string,
  files: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string; byFile: Map<string, Set<string>> }> {
  const byFile = new Map<string, Set<string>>();
  if (files.length === 0) return { ok: true, byFile };
  const args = ['--languages=C', '--langmap=C:.c.h', '--kinds-C=dfegmpstuvx', '--fields=+KSt', '--excmd=number', '--sort=no', '-f', '-', ...files];
  const r = await exec(bin, args, { cwd, timeoutMs, signal, maxBytes: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, error: r.error, byFile };
  if (r.timedOut) return { ok: false, error: 'ctags が制限時間内に終わりませんでした', byFile };
  const parsed = parseTags(r.output, cwd, SYMBOL_KINDS);
  const bad = parsed.warnings.filter((x) => /cannot open|error/i.test(x));
  if (r.code !== 0 || bad.length > 0) return { ok: false, error: bad[0] ?? `ctags が終了コード ${r.code} で終了しました`, byFile };
  for (const f of parsed.funcs) {
    if (!byFile.has(f.file)) byFile.set(f.file, new Set());
    byFile.get(f.file)!.add(f.name);
  }
  return { ok: true, byFile };
}
