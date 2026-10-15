/**
 * Norm v4.1 で `(*)` が付いた規則 = norminette が検査しない規則 の、自動で判定できる部分。
 * 出典: The Norm, Version 4.1 (42 Network) の Chapter I "Foreword" (`(*)` は norminette が検査せず、評価で見つかるとプロジェクト失敗になりうる)。
 *
 * 判定の強さは 2 段階:
 *  - error  : 規則の文面から機械的に決まるもの。fail にする
 *  - review : 疑わしいだけで、人の目で確かめる必要があるもの。warning として出し、既定では fail にしない
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findFunctions, identifiers, localNames, parameterNames, preprocessorLines, scanC, withoutPreprocessor, type CScan } from './cscan';
import { isKnownSystemHeader, STD_CONSTANTS, STD_HEADERS } from './stdsyms';

export type RuleId =
  | 'header-content'
  | 'unused-include'
  | '42header'
  | 'define-bypass'
  | 'define-nonconst'
  | 'define-function-like'
  | 'comment-non-english'
  | 'comment-useless'
  | 'comment-norm-excuse'
  | 'bad-function-name'
  | 'bad-variable-name'
  | 'bad-file-name';

export type Strength = 'error' | 'review';

export interface RuleInfo {
  id: RuleId;
  /** Norm の章 */
  norm: string;
  title: string;
}

export const RULES: RuleInfo[] = [
  { id: 'header-content', norm: 'III.5', title: 'ヘッダに置けるのは include / 宣言 / define / プロトタイプ / マクロだけ (関数の定義を置かない)' },
  { id: 'unused-include', norm: 'III.5', title: '使っていないヘッダの include は禁止 (コメントで理由を書けば許される。clang で include を外して確かめる)' },
  { id: '42header', norm: 'III.6', title: '42 ヘッダの内容が最新 (作成者の login とメール、作成・更新の日時)' },
  { id: 'define-bypass', norm: 'III.7', title: 'norm を回避・難読化する #define の禁止 (制御構文・文・三項演算子・代入を隠したもの)' },
  { id: 'define-nonconst', norm: 'III.7', title: '#define はリテラルと定数の値にだけ使う' },
  { id: 'define-function-like', norm: 'III.7', title: '関数形式のマクロは、課題で許可されている場合だけ使える' },
  { id: 'comment-non-english', norm: 'III.9', title: 'コメントは英語' },
  { id: 'comment-useless', norm: 'III.9', title: 'コメントは役に立つ内容にする (空・TODO・コメントアウトしたコードなどを除く)' },
  { id: 'comment-norm-excuse', norm: 'III.9', title: 'norm のためだけの関数 (carryall / bad function) を、コメントで正当化しない' },
  { id: 'bad-function-name', norm: 'III.1 / III.9', title: '関数名は明示的で意味が分かること (f1、func2、_part2 のような名前は不可)' },
  { id: 'bad-variable-name', norm: 'III.1', title: '変数名・引数名は明示的で意味が分かること (a、b、x1 のような名前は不可)' },
  { id: 'bad-file-name', norm: 'III.1', title: 'ファイル名は明示的で意味が分かること' },
];

export const RULE_IDS: RuleId[] = RULES.map((r) => r.id);

/**
 * 機械では判定できない (= 評価で人が見る) 規則。ログの末尾に、毎回チェックリストとして出す。
 * 「完全に自動で検査できる」とは言えない部分を、黙って落とさないため。
 */
export const MANUAL_ITEMS: { norm: string; text: string }[] = [
  { norm: 'III.1 (*)', text: '全ての識別子 (関数・型・変数) の名前が explicit / mnemonic で、英語として読め、単語が _ で区切られている (機械で見ているのは、1 文字・a1 / f2 型・連番の名前だけです)' },
  { norm: 'III.5 (*)', text: '使っていない include が無い (clang で include を 1 行ずつ外して確かめています。#ifdef のマクロにだけ効く include は、外しても診断が変わらないため、未使用と判定されます。clang が無い / 外す前から fatal error のファイルは、標準ヘッダの名前の表で判定します)' },
  { norm: 'III.6 (*)', text: '42 ヘッダの日時が、ファイルを保存するたびに自動で更新されている (日時の整合までは見ますが、保存のたびに更新されているかは分かりません)' },
  { norm: 'III.7 (*)', text: '標準ライブラリのマクロ (NULL、INT_MAX、O_RDONLY など) が、課題で許可された範囲に収まっている' },
  { norm: 'III.7 (*)', text: '#define が、norm を回避・難読化するために作られていない (制御構文・文・三項演算子・代入を隠したものだけ検出します)' },
  { norm: 'III.9 (*)', text: 'コメントが英語で、役に立つ内容になっている (ASCII 以外の文字・空のコメント・TODO・コメントアウトしたコードだけ検出します)' },
  { norm: 'III.9 (*)', text: 'carryall / bad function (norm を避けるためだけの、論理的な目的が無い関数) が無い' },
];

export interface Finding {
  file: string; // 絶対パス
  line: number;
  rule: RuleId;
  strength: Strength;
  message: string;
}

export interface NormExtraInput {
  root: string;
  /** 検査する .c / .h (normExclude を除いたもの) */
  files: string[];
  /** プロジェクト内の全ての .c / .h (除外したものも含む)。ヘッダが他のファイルから使われているかの判定に使う */
  allSources: string[];
  allHeaders: string[];
  includeDirs: string[];
  disabled: ReadonlySet<string>;
  shortNames: ReadonlySet<string>;
  /** ctags で取り出したヘッダごとの名前。undefined なら、プロジェクト内のヘッダの include は判定しない */
  headerSymbols?: Map<string, Set<string>>;
  /** コンパイラで include の使用を判定した結果 (includecheck.ts)。judged のファイルは、名前の表による判定をしない */
  includeVerdicts?: { judged: ReadonlySet<string>; findings: readonly Finding[] };
  now?: Date;
}

interface Parsed {
  file: string;
  isHeader: boolean;
  text: string;
  scan: CScan;
  structure: string;
  idents: Set<string>;
  includes: IncludeRef[];
}

export interface IncludeRef {
  line: number;
  name: string;
  system: boolean;
  justified: boolean;
}

function parseFile(file: string): Parsed | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const scan = scanC(text);
  const pp = preprocessorLines(scan.codeWithStrings);
  const lineCount = text.split('\n').length;
  // コメントがどの行を占めるか (include の理由づけコメントの判定)
  const commentLines = new Set<number>();
  for (const c of scan.comments) {
    const span = (c.text.match(/\n/g) ?? []).length;
    if (!c.trailing) for (let l = c.line; l <= c.line + span && l <= lineCount; l++) commentLines.add(l);
  }
  const trailingLines = new Set(scan.comments.filter((c) => c.trailing).map((c) => c.line));
  const includes: IncludeRef[] = [];
  for (const p of pp) {
    if (p.directive !== 'include') continue;
    const m = /^(?:<([^>]+)>|"([^"]+)")/.exec(p.rest);
    if (!m) continue;
    const justified = trailingLines.has(p.line) || commentLines.has(p.line - 1);
    includes.push({ line: p.line, name: m[1] ?? m[2], system: m[1] !== undefined, justified });
  }
  return {
    file,
    isHeader: file.endsWith('.h'),
    text,
    scan,
    structure: withoutPreprocessor(scan.code),
    idents: identifiers(withoutPreprocessor(scan.code)),
    includes,
  };
}

/** ファイルの #include の一覧 (読めなければ空) */
export function listIncludes(file: string): IncludeRef[] {
  return parseFile(file)?.includes ?? [];
}

/** #include "x.h" が指すプロジェクト内のヘッダを探す (include 元からの相対 → include path → 同名の唯一のヘッダ)。 */
export function resolveLocal(from: string, name: string, input: Pick<NormExtraInput, 'allHeaders' | 'includeDirs'>): string | undefined {
  const known = new Set(input.allHeaders);
  const tries = [path.resolve(path.dirname(from), name), ...input.includeDirs.map((d) => path.resolve(d, name))];
  for (const t of tries) if (known.has(t)) return t;
  const same = input.allHeaders.filter((h) => h.endsWith(path.sep + name) || path.basename(h) === name);
  return same.length === 1 ? same[0] : undefined;
}

const KEYWORDS_AND_TYPES = new Set(
  'sizeof int char short long unsigned signed float double void const static volatile struct enum union'.split(' '),
);

/* ───────────── 規則ごとの判定 ───────────── */

function checkHeaderContent(p: Parsed, out: Finding[]): void {
  if (!p.isHeader) return;
  for (const f of findFunctions(p.structure)) {
    out.push({
      file: p.file,
      line: f.line,
      rule: 'header-content',
      strength: 'error',
      message: `ヘッダに関数 ${f.name} の定義 (本体) があります。ヘッダに置けるのは include / 宣言 / define / プロトタイプ / マクロだけです (Norm III.5)`,
    });
  }
}

const HEADER_FIELDS = {
  by: /By:\s*(\S+)\s*<([^>]*)>/,
  created: /Created:\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+by\s+(\S+)/,
  updated: /Updated:\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+by\s+(\S+)/,
  fileName: /^\/\*\s{3}(\S+)\s/,
};

function toDate(m: RegExpExecArray): Date | undefined {
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  const same = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && h < 24 && mi < 60 && s < 60;
  return same ? date : undefined;
}

function check42Header(p: Parsed, out: Finding[], now: Date): void {
  const head = p.text.split('\n').slice(0, 12);
  const joined = head.join('\n');
  const by = HEADER_FIELDS.by.exec(joined);
  const created = HEADER_FIELDS.created.exec(joined);
  const updated = HEADER_FIELDS.updated.exec(joined);
  const add = (line: number, strength: Strength, message: string) => out.push({ file: p.file, line, rule: '42header', strength, message });
  if (!by || !created || !updated) {
    // 42 ヘッダが無い / 形式が違うことは norminette が指摘する。ここでは、読めなかったことだけを伝える
    add(1, 'review', '42 ヘッダの By / Created / Updated を読み取れませんでした (形式は norminette が検査します)');
    return;
  }
  const lineOfField = (re: RegExp) => Math.max(1, head.findIndex((l) => re.test(l)) + 1);
  const [, login, email] = by;
  if (/^marvin$/i.test(login) || /^marvin@/i.test(email)) {
    add(lineOfField(HEADER_FIELDS.by), 'error', `42 ヘッダが既定の値 (${login} <${email}>) のままです。自分の login と学生メール (@student.…) に直してください (Norm III.6)`);
  } else if (!/^[^@\s]+@student\.[\w.-]+$/.test(email)) {
    add(lineOfField(HEADER_FIELDS.by), 'error', `42 ヘッダのメール ${email} が、学生メール (login@student.<キャンパス>) の形ではありません (Norm III.6)`);
  }
  const c = toDate(created);
  const u = toDate(updated);
  if (!c) add(lineOfField(HEADER_FIELDS.created), 'error', `42 ヘッダの作成日時が不正です: ${created[0].trim()}`);
  if (!u) add(lineOfField(HEADER_FIELDS.updated), 'error', `42 ヘッダの更新日時が不正です: ${updated[0].trim()}`);
  if (c && u && u.getTime() < c.getTime()) {
    add(lineOfField(HEADER_FIELDS.updated), 'error', '42 ヘッダの更新日時が、作成日時より前になっています');
  }
  const dayMs = 24 * 3600 * 1000;
  for (const [d, re, label] of [[c, HEADER_FIELDS.created, '作成'], [u, HEADER_FIELDS.updated, '更新']] as const) {
    if (d && d.getTime() > now.getTime() + dayMs) add(lineOfField(re), 'review', `42 ヘッダの${label}日時が未来です (端末の時計か、ヘッダの自動更新の設定を確認してください)`);
  }
  const nameLine = head.find((l) => HEADER_FIELDS.fileName.test(l));
  const written = nameLine ? HEADER_FIELDS.fileName.exec(nameLine)![1] : undefined;
  if (written && written !== path.basename(p.file)) {
    add(lineOfField(HEADER_FIELDS.fileName), 'review', `42 ヘッダのファイル名 ${written} が、実際のファイル名 ${path.basename(p.file)} と違います (コピーしたファイルのヘッダが更新されていない可能性)`);
  }
}

function stripLiterals(s: string): string {
  return s.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ');
}

function checkDefines(p: Parsed, out: Finding[], projectMacros: ReadonlySet<string>): void {
  for (const l of preprocessorLines(p.scan.codeWithStrings)) {
    if (l.directive !== 'define') continue;
    const m = /^(\w+)(\(([^)]*)\))?\s*(.*)$/.exec(l.rest);
    if (!m) continue;
    const [, name, paren, , rawBody] = m;
    const body = stripLiterals(rawBody).trim();
    if (body === '') continue; // include guard や、値のない define
    const add = (rule: RuleId, strength: Strength, message: string) => out.push({ file: p.file, line: l.line, rule, strength, message });
    const control = /\b(for|while|do|if|else|switch|case|goto|return|break|continue)\b/.exec(body);
    const bypass = control?.[1] ?? (/[;{}]/.test(body) ? '; / { / }' : /\?/.test(body) ? '?' : /(^|[^=!<>+\-*/%&|^])=($|[^=])/.test(body) ? '=' : undefined);
    if (bypass) {
      add('define-bypass', 'error', `#define ${name} に ${bypass === '?' ? '三項演算子 (?)' : bypass === '=' ? '代入 (=)' : `\`${bypass}\``} が含まれています。制御構文・文・三項演算子・代入を #define に隠すのは、norm の回避・難読化として禁止です (Norm III.7)`);
      continue;
    }
    if (paren !== undefined) {
      add('define-function-like', 'review', `関数形式のマクロ ${name}(…) です。課題でマクロの使用が許可されているか確認してください (Norm III.7)`);
      continue;
    }
    // 値が定数か: 関数呼び出し・未知の識別子があれば疑う
    for (const t of body.matchAll(/([A-Za-z_]\w*)(\s*\()?/g)) {
      const id = t[1];
      if (KEYWORDS_AND_TYPES.has(id)) continue;
      const isCall = t[2] !== undefined;
      const known = projectMacros.has(id) || STD_CONSTANTS.has(id) || Object.values(STD_HEADERS).some((s) => s.includes(id) && !isCall);
      if (isCall || !known) {
        add('define-nonconst', 'review', `#define ${name} の値に、${isCall ? `関数呼び出し ${id}(…)` : `定数と確認できない識別子 ${id}`} があります。#define はリテラルと定数の値にだけ使います (Norm III.7)`);
        break;
      }
    }
  }
}

/** 先頭の 42 ヘッダ (11 行のコメント) の行数。ヘッダが無ければ 0 */
function headerLines(text: string): number {
  return /^\/\*\s*\*{20,}\s*\*\/\s*\n/.test(text) ? 11 : 0;
}

function looksLikeCode(t: string): boolean {
  if (/^#\s*(include|define|if|ifdef|ifndef|endif)\b/.test(t)) return true;
  if (/[;{}]$/.test(t) && /[()=]|\+\+|--|->/.test(t)) return true;
  return /^(if|else|while|return|int|char|void|size_t|free|printf)\b.*[;){]$/.test(t);
}

function checkComments(p: Parsed, out: Finding[]): void {
  const headerEnd = headerLines(p.text);
  for (const c of p.scan.comments) {
    if (c.line <= headerEnd || /auto prototypes/.test(c.text)) continue;
    const add = (rule: RuleId, strength: Strength, message: string) => out.push({ file: p.file, line: c.line, rule, strength, message });
    const na = /[^\x00-\x7f]/.exec(c.text);
    if (na) {
      add('comment-non-english', 'error', `コメントに ASCII 以外の文字 (${na[0]}) があります。コメントは英語で書きます (Norm III.9)`);
      continue;
    }
    const lines = c.text.split('\n').map((l) => l.replace(/^[\s*]+|[\s*]+$/g, '').trim());
    const body = lines.filter((l) => l !== '');
    if (body.length === 0 || body.every((l) => /^[-=_*#~.\s/]+$/.test(l))) {
      add('comment-useless', 'review', '中身のないコメントです (空、または区切り線だけ)。役に立つ内容にするか、消してください (Norm III.9)');
      continue;
    }
    const todo = /\b(TODO|FIXME|XXX|HACK)\b/i.exec(c.text);
    if (todo) {
      add('comment-useless', 'review', `${todo[1].toUpperCase()} のコメントが残っています。提出前に解決して消してください (Norm III.9)`);
      continue;
    }
    if (body.some(looksLikeCode)) {
      add('comment-useless', 'review', 'コメントアウトしたコードに見えます。使わないコードは消してください (Norm III.9)');
      continue;
    }
    if (/\b(norm|norme|norminette)\b/i.test(c.text) && /(split|cut|lines?|too (many|long)|because|avoid|due to|limit|25)/i.test(c.text)) {
      add('comment-norm-excuse', 'review', 'norm のために関数を分けた、という説明に読めます。コメントで carryall / bad function を正当化することはできません (Norm III.9)');
    }
  }
}

const BAD_FUNCTION = /^(f|fn|func|function|foo|bar|baz|test|tmp|temp|helper|aux|doit|do_it)\d*$/;
const NUMBERED_OK = /(base|sha|md|utf|ipv|int|uint|crc|aes|des|x|mlx|vec|mat)\d+$/;
const NORM_SPLIT = /(^|_)(norm|norme|norminette|bis|suite)(_|$)|_part\d*$|_pt\d+$/;

function checkFunctionNames(p: Parsed, out: Finding[]): void {
  if (p.isHeader) return;
  for (const f of findFunctions(p.structure)) {
    if (f.name === 'main') continue;
    let why: string | undefined;
    if (BAD_FUNCTION.test(f.name)) why = '意味の分からない名前です';
    else if (/[A-Za-z_]\d+$/.test(f.name) && !NUMBERED_OK.test(f.name)) why = '連番の名前 (func2 型) です。norm に合わせて関数を分けた跡に見えます';
    else if (NORM_SPLIT.test(f.name)) why = 'norm のために分けた関数に見える名前です';
    if (why) {
      out.push({
        file: p.file,
        line: f.line,
        rule: 'bad-function-name',
        strength: 'review',
        message: `関数名 ${f.name}: ${why}。関数名は明示的で、役割が分かるものにします (Norm III.1 / III.9)`,
      });
    }
  }
}

function badVariable(name: string, shortNames: ReadonlySet<string>): string | undefined {
  if (name.length === 1 && !shortNames.has(name)) return '1 文字の名前です';
  if (/^[a-z]\d+$/.test(name)) return '文字 + 数字だけの名前です';
  if (/^(var|val|temp|tmp|thing|stuff|data)\d+$/.test(name)) return '連番の名前です';
  if (/^(foo|bar|baz|asdf|qwerty)$/.test(name)) return '意味の分からない名前です';
  return undefined;
}

function checkVariableNames(p: Parsed, out: Finding[], shortNames: ReadonlySet<string>): void {
  if (p.isHeader) return;
  const lineAt = (offset: number) => p.structure.slice(0, offset).split('\n').length;
  for (const f of findFunctions(p.structure)) {
    const bodyLine = lineAt(f.bodyStart);
    const names = [
      ...parameterNames(f.params).map((name) => ({ name, line: f.line, kind: '引数' })),
      ...localNames(p.structure.slice(f.bodyStart, f.bodyEnd)).map((v) => ({ name: v.name, line: bodyLine + v.line, kind: '変数' })),
    ];
    for (const v of names) {
      const why = badVariable(v.name, shortNames);
      if (why) {
        out.push({
          file: p.file,
          line: v.line,
          rule: 'bad-variable-name',
          strength: 'review',
          message: `${v.kind}名 ${v.name}: ${why}。名前は explicit / mnemonic にします (Norm III.1)${v.name.length === 1 ? ` (許可する 1 文字の名前は設定 c42check.normExtra.shortNames)` : ''}`,
        });
      }
    }
  }
}

function checkFileName(p: Parsed, out: Finding[]): void {
  const stem = path.basename(p.file).replace(/\.[ch]$/, '');
  if (stem.length <= 2 || /^[a-z]\d+$/.test(stem) || /^(foo|bar|baz|test\d*|tmp\d*|temp\d*|file\d*|new\d*|untitled\d*)$/.test(stem)) {
    out.push({
      file: p.file,
      line: 1,
      rule: 'bad-file-name',
      strength: 'review',
      message: `ファイル名 ${path.basename(p.file)} が、中身を表す名前に見えません (Norm III.1: ファイル名も explicit / mnemonic)`,
    });
  }
}

/** include 先が提供する名前 (プロジェクト内のヘッダは、そのヘッダが include するヘッダの分も含める) */
function symbolsOf(header: string, input: NormExtraInput, parsedCache: Map<string, Parsed | undefined>, seen = new Set<string>()): Set<string> {
  const out = new Set<string>(input.headerSymbols?.get(header) ?? []);
  if (seen.has(header)) return out;
  seen.add(header);
  if (!parsedCache.has(header)) parsedCache.set(header, parseFile(header));
  const parsed = parsedCache.get(header);
  for (const inc of parsed?.includes ?? []) {
    if (inc.system) {
      for (const s of STD_HEADERS[inc.name] ?? []) out.add(s);
    } else {
      const target = resolveLocal(header, inc.name, input);
      if (target) for (const s of symbolsOf(target, input, parsedCache, seen)) out.add(s);
    }
  }
  return out;
}

function checkUnusedIncludes(
  p: Parsed,
  out: Finding[],
  input: NormExtraInput,
  cache: Map<string, Parsed | undefined>,
  includers: Map<string, Parsed[]>,
): void {
  // 判定に使う識別子: そのファイル自身 + (ヘッダなら) そのヘッダを include している全ファイル
  const used = new Set(p.idents);
  if (p.isHeader) for (const u of includers.get(p.file) ?? []) for (const id of u.idents) used.add(id);
  for (const inc of p.includes) {
    if (inc.justified) continue; // コメントで理由が書かれている (Norm III.5)
    let provided: Set<string> | undefined;
    if (inc.system) {
      if (isKnownSystemHeader(inc.name)) provided = new Set(STD_HEADERS[inc.name]);
    } else {
      const target = resolveLocal(p.file, inc.name, input);
      if (target && input.headerSymbols) provided = symbolsOf(target, input, cache);
    }
    if (!provided) continue; // 判定できない (表にない / ctags が無い / プロジェクト外)
    if ([...provided].some((s) => used.has(s))) continue;
    out.push({
      file: p.file,
      line: inc.line,
      rule: 'unused-include',
      strength: 'error',
      message: `#include ${inc.system ? `<${inc.name}>` : `"${inc.name}"`} が使われていません。使っていないヘッダの include は禁止です。理由があるなら、その行にコメントで書いてください (Norm III.5)`,
    });
  }
}

export function normExtra(input: NormExtraInput): Finding[] {
  const now = input.now ?? new Date();
  const out: Finding[] = [];
  const cache = new Map<string, Parsed | undefined>();
  const parse = (f: string) => {
    if (!cache.has(f)) cache.set(f, parseFile(f));
    return cache.get(f);
  };

  // 「ヘッダ → それを include しているファイル」(ヘッダの include が、include 元で使われているかの判定用)
  const includers = new Map<string, Parsed[]>();
  const everything = [...new Set([...input.allSources, ...input.allHeaders])];
  const projectMacros = new Set<string>();
  for (const f of everything) {
    const p = parse(f);
    if (!p) continue;
    for (const l of preprocessorLines(p.scan.codeWithStrings)) {
      if (l.directive === 'define') {
        const m = /^(\w+)/.exec(l.rest);
        if (m) projectMacros.add(m[1]);
      }
    }
    for (const inc of p.includes) {
      if (inc.system) continue;
      const target = resolveLocal(f, inc.name, input);
      if (target) includers.set(target, [...(includers.get(target) ?? []), p]);
    }
  }

  const on = (id: RuleId) => !input.disabled.has(id);
  for (const file of input.files) {
    const p = parse(file);
    if (!p) continue;
    if (on('header-content')) checkHeaderContent(p, out);
    if (on('unused-include')) {
      if (input.includeVerdicts?.judged.has(file)) out.push(...input.includeVerdicts.findings.filter((f) => f.file === file));
      else checkUnusedIncludes(p, out, input, cache, includers);
    }
    if (on('42header')) check42Header(p, out, now);
    if (on('define-bypass') || on('define-nonconst') || on('define-function-like')) {
      const tmp: Finding[] = [];
      checkDefines(p, tmp, projectMacros);
      out.push(...tmp.filter((f) => on(f.rule)));
    }
    if (on('comment-non-english') || on('comment-useless') || on('comment-norm-excuse')) {
      const tmp: Finding[] = [];
      checkComments(p, tmp);
      out.push(...tmp.filter((f) => on(f.rule)));
    }
    if (on('bad-function-name')) checkFunctionNames(p, out);
    if (on('bad-variable-name')) checkVariableNames(p, out, input.shortNames);
    if (on('bad-file-name')) checkFileName(p, out);
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}
