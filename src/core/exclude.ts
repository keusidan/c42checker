import * as path from 'node:path';

/**
 * 除外パターンの一致判定 (ファイル名 / パスの簡単な glob)。
 *  - `/` を含まないパターンは、**ファイル名**に一致 (どの深さのディレクトリにあっても): `main.c` は `src/main.c` にも一致する
 *  - `/` を含むパターンは、ワークスペースルートからの**相対パス**に一致 (先頭の `/` と `./` は無視): `/main.c` は直下の main.c だけ
 *  - `/` で終わるパターンは、そのディレクトリ以下の全て: `tests/`
 *  - `*` は `/` 以外の任意の文字列、`**` は `/` を含む任意の文字列、`?` は `/` 以外の 1 文字
 */
export function matchesPattern(relPath: string, pattern: string): boolean {
  const rel = relPath.split(path.sep).join('/');
  let pat = pattern.trim();
  if (pat === '') return false;
  if (pat.endsWith('/')) pat += '**';
  const hasSlash = pat.replace(/\*\*$/, '').includes('/');
  const target = hasSlash ? rel : path.posix.basename(rel);
  if (hasSlash) pat = pat.replace(/^\.?\//, '');
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(target);
}

export function isExcluded(absPath: string, root: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const rel = path.relative(root, absPath);
  return patterns.some((p) => matchesPattern(rel, p));
}
