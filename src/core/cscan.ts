/**
 * Norm の (*) 規則の検査に使う、C ソースの簡易な字句読み取り。
 * 完全な C のパーサではない。42 の Norm に沿ったコード (関数定義は `)` の直後に `{`、1 行 1 宣言) を前提に、
 * コメント / 文字列 / 前処理行 / 関数定義 / 関数の宣言部を取り出す。読み取れなかったものは「無い」として扱う (誤検知より見逃しを選ぶ)。
 */

export interface CComment {
  /** コメントの開始行 (1 始まり) */
  line: number;
  /** コメント本文 (`/*` `*\/` `//` は除く)。複数行なら改行を含む */
  text: string;
  kind: 'block' | 'line';
  /** その行に、コメント以外のコードもあるか (行末コメント) */
  trailing: boolean;
}

export interface CScan {
  /** コメントを空白に、文字列 / 文字リテラルの中身を空白にしたコード。文字数と改行位置は元と同じ */
  code: string;
  /** コメントだけ空白にしたコード (文字列は残す)。#include "x.h" の読み取り用 */
  codeWithStrings: string;
  comments: CComment[];
}

export function scanC(src: string): CScan {
  let code = '';
  let withStr = '';
  const comments: CComment[] = [];
  let line = 1;
  let lineHasCode = false;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      const raw = src.slice(i, stop);
      comments.push({ line, text: raw.slice(2, end < 0 ? undefined : raw.length - 2), kind: 'block', trailing: lineHasCode });
      code += blank(raw);
      withStr += blank(raw);
      line += (raw.match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = n;
      const raw = src.slice(i, end);
      comments.push({ line, text: raw.slice(2), kind: 'line', trailing: lineHasCode });
      code += blank(raw);
      withStr += blank(raw);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, n);
      const raw = src.slice(i, stop);
      code += c + blank(raw.slice(1, raw.length - (raw.endsWith(c) && raw.length > 1 ? 1 : 0))) + (raw.endsWith(c) && raw.length > 1 ? c : '');
      withStr += raw;
      lineHasCode = true;
      line += (raw.match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === '\n') {
      line++;
      lineHasCode = false;
    } else if (c !== ' ' && c !== '\t' && c !== '\r') lineHasCode = true;
    code += c;
    withStr += c;
    i++;
  }
  return { code, codeWithStrings: withStr, comments };
}

export interface PreprocessorLine {
  line: number;
  /** `#` の後の指示 (include / define / ifndef ...) */
  directive: string;
  /** 指示より後ろ。`\` による行継続は 1 行につなぐ */
  rest: string;
  /** 行継続 (`\`) があったか (複数行マクロ) */
  continued: boolean;
}

/** 前処理行を取り出す。行の途中の # は対象外。 */
export function preprocessorLines(codeWithStrings: string): PreprocessorLine[] {
  const out: PreprocessorLine[] = [];
  const lines = codeWithStrings.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*#\s*(\w*)(.*)$/.exec(lines[i].replace(/\r$/, ''));
    if (!m) continue;
    let rest = m[2];
    let continued = false;
    let k = i;
    while (rest.trimEnd().endsWith('\\') && k + 1 < lines.length) {
      continued = true;
      rest = rest.trimEnd().slice(0, -1) + ' ' + lines[++k].replace(/\r$/, '');
    }
    out.push({ line: i + 1, directive: m[1], rest: rest.trim(), continued });
    i = k;
  }
  return out;
}

/** コードから前処理行 (継続行を含む) を空白にしたもの。関数や波括弧の構造を読むため。 */
export function withoutPreprocessor(code: string): string {
  const orig = code.split('\n');
  const lines = [...orig];
  const blank = (t: string) => t.replace(/[^\r]/g, ' ');
  for (let i = 0; i < orig.length; i++) {
    if (!/^\s*#/.test(orig[i])) continue;
    lines[i] = blank(orig[i]);
    while (/\\\s*$/.test(orig[i].replace(/\r$/, '')) && i + 1 < orig.length) {
      i++;
      lines[i] = blank(orig[i]);
    }
  }
  return lines.join('\n');
}

export interface CFunction {
  name: string;
  /** 関数名がある行 (1 始まり) */
  line: number;
  /** 引数の宣言部 (括弧の中) */
  params: string;
  /** 本体の `{` の次の文字の位置と、対応する `}` の位置 */
  bodyStart: number;
  bodyEnd: number;
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/**
 * 関数の定義 (`name(params)` の直後に `{`) を、波括弧の深さ 0 の位置から探す。
 * `struct s {` / `enum e {` / `= {` などは、直前が `)` ではないので対象外。
 */
export function findFunctions(structure: string): CFunction[] {
  const out: CFunction[] = [];
  let depth = 0;
  for (let i = 0; i < structure.length; i++) {
    const c = structure[i];
    if (c === '{') {
      if (depth === 0) {
        let p = i - 1;
        while (p >= 0 && /\s/.test(structure[p])) p--;
        if (structure[p] === ')') {
          // 対応する ( を後ろから探す
          let level = 0;
          let q = p;
          for (; q >= 0; q--) {
            if (structure[q] === ')') level++;
            else if (structure[q] === '(' && --level === 0) break;
          }
          if (q > 0) {
            let r = q - 1;
            while (r >= 0 && /\s/.test(structure[r])) r--;
            let s = r;
            while (s >= 0 && /\w/.test(structure[s])) s--;
            const name = structure.slice(s + 1, r + 1);
            if (name && !/^(if|while|for|switch|return|sizeof)$/.test(name)) {
              // 本体の終わり
              let d = 0;
              let end = i;
              for (; end < structure.length; end++) {
                if (structure[end] === '{') d++;
                else if (structure[end] === '}' && --d === 0) break;
              }
              out.push({
                name,
                line: lineOf(structure, s + 1),
                params: structure.slice(q + 1, p),
                bodyStart: i + 1,
                bodyEnd: end,
              });
              i = end;
              continue;
            }
          }
        }
      }
      depth++;
    } else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return out;
}

/** 引数の宣言部から、引数名を取り出す (`void` だけ / 空 / `...` は無し)。 */
export function parameterNames(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of params) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const names: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (p === '' || p === 'void' || p === '...') continue;
    const fp = /\(\s*\*+\s*(\w+)\s*\)/.exec(p); // 関数ポインタ: void (*f)(int)
    if (fp) {
      names.push(fp[1]);
      continue;
    }
    const m = /(\w+)\s*(\[[^\]]*\]\s*)*$/.exec(p);
    // 型だけ (名前なし) は norminette が指摘する。ここでは 2 語以上のときだけ名前とみなす
    if (m && /[\w*]\s+[\s*]*\w+/.test(p.replace(/\[[^\]]*\]/g, ''))) names.push(m[1]);
  }
  return names;
}

const NOT_A_DECLARATION = /^(return|break|continue|goto|else|if|while|for|do|switch|case|default)\b/;

/**
 * 関数本体の先頭にある宣言 (最初の空行まで) から、変数名を取り出す。
 * Norm では「宣言は関数の先頭に置き、空行で区切る」ので、その範囲だけを読む。
 */
export function localNames(body: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const lines = body.split('\n');
  let seenAny = false;
  for (let i = 0; i < lines.length; i++) {
    const stmt = lines[i].replace(/\r$/, '').trim();
    if (stmt === '') {
      if (seenAny) break;
      continue;
    }
    seenAny = true;
    if (!stmt.endsWith(';') || NOT_A_DECLARATION.test(stmt)) break; // 宣言の範囲が終わった
    const decl = stmt.replace(/\s*=.*;$/, ';').replace(/\[[^\]]*\]/g, '').replace(/;$/, '').trim();
    const fp = /^[\w\s*]+\(\s*\*+\s*(\w+)\s*\)\s*\(.*\)$/.exec(decl); // void (*f)(int)
    if (fp) {
      out.push({ name: fp[1], line: i });
      continue;
    }
    if (/[()]/.test(decl)) break; // 関数呼び出しなどの式
    const m = /^[A-Za-z_][\w\s*]*?[\s*]+([A-Za-z_]\w*)$/.exec(decl);
    if (!m) break;
    out.push({ name: m[1], line: i });
  }
  return out;
}

/** コード中の識別子 (キーワードも含む) の集合 */
export function identifiers(code: string): Set<string> {
  const set = new Set<string>();
  for (const m of code.matchAll(/[A-Za-z_]\w*/g)) set.add(m[0]);
  return set;
}
