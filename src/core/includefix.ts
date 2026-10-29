/**
 * 使っていない #include の削除 (設定 c42check.normExtra.removeUnusedIncludes)。
 * 削除するのは、コンパイラで「外しても診断が増えない」と確かめた include (includecheck.ts の error) だけ。
 * 元の内容は .42check/include-backup/ に退避する。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from './normextra';
import type { Context } from './types';

/**
 * 指定した行 (1 始まり) を削除する。削除の跡に空行が連続しないよう、削除した範囲の直後の空行は 1 つだけ詰める
 * (Norm: 連続した空行は禁止)。
 */
export function removeLines(text: string, lines: ReadonlySet<number>): string {
  const src = text.split('\n');
  const out: string[] = [];
  let afterDeletion = false;
  for (let i = 0; i < src.length; i++) {
    if (lines.has(i + 1)) {
      afterDeletion = true;
      continue;
    }
    const blank = src[i].trim() === '';
    // 削除の直後の空行が、直前の空行 (またはファイルの先頭) と連続するなら捨てる
    if (afterDeletion && blank && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    afterDeletion = false;
    out.push(src[i]);
  }
  return out.join('\n');
}

/** 削除した後の行番号。削除した行より後ろの行は、削除した数だけ前に詰まる。 */
export function shiftLine(line: number, removed: ReadonlySet<number>): number {
  let n = 0;
  for (const r of removed) if (r < line) n++;
  return line - n;
}

export interface RemovalResult {
  /** 削除した findings */
  removed: Finding[];
  /** エディタで未保存の変更があるため、削除しなかった findings */
  dirty: Finding[];
  /** 変更したファイル → 削除した元の行番号 */
  changed: Map<string, Set<number>>;
  /** 変更したファイルを元に戻す (.42check/include-backup/ も消す) */
  restore(): void;
}

export function applyRemovals(ctx: Context, findings: readonly Finding[]): RemovalResult {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const result: RemovalResult = { removed: [], dirty: [], changed: new Map(), restore: () => undefined };
  const originals = new Map<string, string>();
  const backup = path.join(ctx.workDir, 'include-backup');

  for (const [file, list] of byFile) {
    if (ctx.isFileDirty?.(file)) {
      result.dirty.push(...list);
      continue;
    }
    const original = fs.readFileSync(file, 'utf8');
    const lines = new Set(list.map((f) => f.line));
    const next = removeLines(original, lines);
    if (next === original) continue;
    const dest = path.join(backup, path.relative(ctx.root, file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, original);
    fs.writeFileSync(file, next);
    originals.set(file, original);
    result.changed.set(file, lines);
    result.removed.push(...list);
  }
  result.restore = () => {
    for (const [file, original] of originals) fs.writeFileSync(file, original);
    fs.rmSync(backup, { recursive: true, force: true });
  };
  return result;
}
