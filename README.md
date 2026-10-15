# 42 Check

42 Tokyo の課題 (C 言語、42 Norm 準拠) 向けに、検証ツール一式をチェックボックスで選び、ワンクリックで**段階的に (fail-fast で)** 実行する VS Code 拡張機能です。
F5 で CodeLLDB のデバッガを起動でき、**事前チェックに落ちたらデバッガも後続の手順も実行されません**。

この拡張は、既存の信頼できる拡張 (CodeLLDB、clangd) をつなぐ「司令塔」で、デバッガも言語サーバも自作していません。
方針と採用理由は [docs/existing-extensions.md](docs/existing-extensions.md)、動作確認の結果は [docs/verification.md](docs/verification.md)、容量の実測は [docs/size-report.md](docs/size-report.md) を参照してください。

> **状況**: コア (検証の実行、fail-fast、`compile_commands.json` 生成、launch / tasks の生成) は実際のツールでテスト済みです。
> 校舎マシン (Ubuntu 22.04、`-12` 系のツール) の実機で、サンプル 5 つに対して全チェック項目を 1 つずつ実行し、期待どおりの結果になることが報告されています
> (詳細は [docs/verification.md](docs/verification.md))。
> **VS Code の画面上の動作** (F5 でデバッガが止まること、Problems への表示、clangd の補完) は、まだ確認できていません。

## 実行の段階

前の段階が 1 つでも失敗したら、後続の段階は一切実行しません。skip (ツール未検出など) は失敗ではありませんが、結果一覧で明示されます。

| 段階 | 内容 |
|---|---|
| 0 準備 | 空き容量の確認 → `.42check/` の作り直し → ツール検出 → `compile_commands.json` / `.clangd` の生成 (**初回と、必要なときだけ**。実行のたびには書き直しません) |
| 1 事前チェック (静的) | (任意) c_formatter_42 による整形 → norminette / **Norm の (*) 規則** / **Makefile (Norm III.11)** / 警告強化ビルド (`-Wall -Wextra -Werror -Wshadow -Wconversion`) / clang-tidy (`clang-analyzer-*,bugprone-*`) / scan-build / `gcc -fanalyzer` |
| 2 動的チェック | ASan(AddressSanitizer) + UBSan(UndefinedBehaviorSanitizer) / TSan(ThreadSanitizer) / MSan(MemorySanitizer) / valgrind を、**項目ごとに別ビルド**で実行。任意で CBMC / Frama-C Eva (ネイティブにある場合のみ) |
| 3 デバッガ | F5 経由のときのみ。デバッグ用ビルド (`.42check/debug/prog`) の後、CodeLLDB が起動 |

- 同じ段階の中は全項目を実行して結果をまとめます (`c42check.failFast: "stage"`、既定)。`"step"` にすると最初の失敗で止まります。
- 止まった場所 (どの段階のどの項目か) は、通知と Output Channel (`42 Check`) に出ます。
- 校舎のツール名 (`clang-12`、`clang-tidy-12`、`scan-build-12`、`gcc-12`) を優先して検出し、無ければ素の名前、それも無ければ入っている最新版を使います (メイン機の Arch 向け)。

### 合否判定の補正 (ツールの既定の終了コードだけでは fail にならないもの)

| ツール | 補正 |
|---|---|
| clang-tidy | `--warnings-as-errors='*'` を付け、warning も fail |
| scan-build | `--status-bugs` を付け、バグ検出で非 0 |
| `gcc -fanalyzer` | `-Wanalyzer-*` の診断を error 扱い |
| UBSan | `-fno-sanitize-recover=undefined` で最初の違反で止める |
| valgrind | `--error-exitcode=99`、閉じていない (継承されていない) fd も fail |
| TSan | `WARNING: ThreadSanitizer` の報告で fail (データ競合の位置に診断)。制限時間は他の 3 倍 |
| MSan | `WARNING: MemorySanitizer` の報告で fail (未初期化値の使用位置に診断、origins を追跡)。制限時間は他の 3 倍 |
| 動的チェックの実行 | stdin は `/dev/null`、制限時間 (`c42check.runTimeoutSec`) を超えると**検査が完了していないので skip** (失敗にはしません) |

プログラムが正常に `exit(1)` するだけでは、ASan / valgrind 側では失敗にしません (sanitizer / valgrind の報告があるかで判定)。

### norminette / 整形の対象から外すファイル (既定: `main.c`)

`c42check.normExclude` に一致するファイルは、**norminette の検査と、c_formatter_42 の整形の対象から外れ、ヘッダへのプロトタイプ同期でも関数を拾いません**。既定は `["main.c"]` です (テスト用関数を書いた `main.c` など、norm に合わせたくない・ヘッダに載せたくないファイル向け)。

- **外れるのは、この 3 つだけです。** 警告強化ビルド、clang-tidy、`gcc -fanalyzer`、scan-build、sanitizer、valgrind は、除外したファイルにも行われます。
- パターンの書き方: `/` を含まなければ**ファイル名**に一致 (どの深さでも。`main.c` は `src/main.c` にも一致)、含めば**ルートからの相対パス**に一致 (`/main.c` は直下だけ)、`/` で終われば**そのディレクトリ以下の全て** (`tests/`)。`*` は `/` 以外の任意の文字列、`**` は `/` も含む任意の文字列。
- 例: `"c42check.normExclude": ["main.c", "tests/", "*_test.c"]`。空にすると、全ての `.c` / `.h` が対象です。
- 対象が全て除外されたときは、失敗ではなく skip になります。

### Norm の (*) 規則と Makefile の検査 (norminette が検査しないもの)

Norm v4.1 の冒頭 (Chapter I Foreword) によると、`(*)` が付いた規則は **norminette が検査せず、評価で見つかるとプロジェクト失敗 (Norm flag) になりえます**。Makefile (III.11) も norminette は検査しません。
この拡張は、これらのうち**機械で判定できる部分**を、段階 1 の 2 つの項目で検査します。出典: [The Norm, Version 4.1](https://github.com/42School/norminette) (42 Network)。

**判定は 2 段階です。** `error` は規則の文面から機械的に決まるもので、**fail** です。`review` は疑わしいだけで、人の目で確かめるものです。Problems には warning として出ますが、既定では fail にしません (`c42check.normExtra.reviewAsFail: true` で fail にできます)。

| Norm | `(*)` の規則 | この拡張の検査 (規則の id) | 強さ |
|---|---|---|---|
| III.5 | ヘッダに置けるのは include / 宣言 / define / プロトタイプ / マクロだけ | ヘッダに関数の定義 (本体) がある (`header-content`) | error |
| III.5 | 使っていないヘッダの include は禁止 | 使っていない include。名前で絞り込み、残りを **clang で include を 1 行ずつ外して構文チェックをやり直し、診断が増えなければ未使用**と判定 (下記)。コメントで理由を書いた include は除く (`unused-include`) | error / review |
| include の二重指定 (同じヘッダを 2 回 / ヘッダとソースの両方)。設定が ON のときだけ (`duplicate-include`) | error |
| III.6 | 42 ヘッダの内容が最新 | 既定値 (`marvin`) のまま / 学生メール (`@student.…`) でない / 日時が不正 / 更新が作成より前 (`42header`)。ファイル名の食い違い・未来の日時は review | error / review |
| III.7 | `#define` はリテラルと定数の値だけ | 値に関数呼び出しや定数と確認できない識別子がある (`define-nonconst`)。関数形式のマクロ (`define-function-like`) | review |
| III.7 | norm を回避・難読化する `#define` の禁止 | 値に制御構文・文 (`;` `{` `}`)・三項演算子・代入を隠している (`define-bypass`) | error |
| III.9 | コメントは英語 | ASCII 以外の文字 (日本語など) がある (`comment-non-english`) | error |
| III.9 | コメントは役に立つ内容 | 空・区切り線だけ・TODO / FIXME・コメントアウトしたコード (`comment-useless`) | review |
| III.9 | コメントで carryall / bad function を正当化しない | 「norm のために分けた」という説明に読めるコメント (`comment-norm-excuse`) | review |
| III.1 / III.9 | 名前は explicit / mnemonic | 関数名: `f1` / `func2` / `_part2` など (`bad-function-name`)。変数・引数名: 許可していない 1 文字・`x1` 型・連番 (`bad-variable-name`)。ファイル名 (`bad-file-name`) | review |

**使っていない include の判定 (`unused-include`)**: 2 段階で判定します。

1. **名前による絞り込み (速い)**: ファイルが使っている識別子と、include 先が提供する名前 (標準ヘッダは内蔵の表、プロジェクトのヘッダは universal-ctags で取り出したもの) を突き合わせ、**使っていると分かる include は、それだけで「使っている」とします。コンパイルしません。**
   ほとんどの include はこちらで決まるので、速いです (40 ファイル・各 7 個の include の試験で、約 16 秒 → 約 1 秒。コンパイルの回数は 402 → 82)。`size_t` / `NULL` のように複数のヘッダが提供する名前だけを使っているときは、証拠にしません。
2. **コンパイラでの確認**: 残った include (使っていないように見えるものと、`mlx.h` など表にないヘッダ) だけを、プロジェクトのコピーの中で `#include` の行を空行にして `clang -fsyntax-only` を走らせ、**診断 (warning / error) が増えなければ未使用**と判定します (元のファイルは書き換えません)。ファイルごとに並列で走ります (最大 8 並列)。ヘッダは、そのヘッダだけを include する小さな `.c` で先に確かめ、必要と分かれば、include 元の `.c` はコンパイルしません。

名前で「使っている」と分かる include を未使用と判定することはありません。そのため、ヘッダとソースの両方で `<stdlib.h>` を include していて、ソースが `malloc` を使っている場合も、未使用とは判定しません (二重指定は次のオプションで検出します)。

- `.c` が自分のヘッダを include するのは、外すと「プロトタイプが無い」警告 (`-Wmissing-prototypes`) が出るので、必要と判定されます。
- `.h` は、そのヘッダだけを include する小さな `.c` と、そのヘッダを include している `.c` の構文チェックで判定します (`ft.h` が include する `<stdlib.h>` を、`ft.h` を使う `.c` が `malloc` に使っていれば必要)。
- 提供する名前が重なる include (`size_t` だけを使うときの `<stdlib.h>` と `<stdio.h>` など) は、外せるものを全部外すと通らないので、**review** にします (どれか 1 つは必要)。
- 外す前から fatal error (include が見つからない) のファイルや、clang が無いときは、名前による判定 (標準ヘッダの表と ctags) だけにします。
- **取りこぼし**: `#ifdef` で使うマクロだけを提供する include は、外しても診断が変わらないので、未使用と判定されます。理由があるなら、その行にコメントで書いてください (コメントのある include は判定しません)。
- include の数だけ構文チェックを走らせます (`c42check.staticTimeoutSec` の 3 倍で打ち切り、残りは名前の表で判定します)。

**include の二重指定を検出する (オプション、既定 OFF)**: `c42check.normExtra.detectDuplicateIncludes` を `true` にする (View の「設定」グループの「include の二重指定を検出」) と、次を **error** として検出します (規則の id: `duplicate-include`)。

- 同じファイルの中で、同じヘッダを 2 回以上 include している (後ろの行を指します)
- ファイルが X を include していて、同じファイルが include するプロジェクトのヘッダ (その先のヘッダも含む) が、すでに X を include している = **ヘッダとソースの両方に書いている** (ソース側の行を指します)
- コメントで理由を書いた include は除きます。`c42check.normExtra.disable` に `duplicate-include` を入れても、検出しません。

OFF のままなら、ヘッダとソースの両方に書いてあっても、使っていれば問題にしません (使うものを自分のファイルに明示する書き方もよく使われるため)。**検出するだけで、自動では削除しません** (どちらを残すかは人が決めます)。

**使っていない include を削除する (オプション、既定 OFF)**: `c42check.normExtra.removeUnusedIncludes` を `true` にする (View の「設定」グループの「使っていない #include を削除」) と、検査のときに、**コンパイラで未使用と確かめた `#include` をファイルから削除**します。ソースを書き換えるので、既定は OFF です。

- 削除するのは、上の方法で「外しても診断が増えない」と確かめた include (error) だけです。**提供する名前が重なる include (review)、コメントで理由を書いた include、clang が無いときなどの名前の表による判定のものは、削除しません。**
- include を全部消した跡に、空行が連続しないよう詰めます (Norm: 連続する空行は禁止)。
- 削除の前後で、プロジェクト全体の構文チェックをやり直します。**削除前は通っていたのに通らなくなったら、全て元に戻します** (その場合、未使用の include は error のまま残ります)。
- エディタに未保存の変更があるファイルは、書き換えません (error のまま残ります)。保存してから、もう一度実行してください。
- 変更前の内容は `.42check/include-backup/` に退避されます (次の実行で消えます)。Git で管理していれば、`git diff` / `git checkout` でも戻せます。
- 削除は、ディスク上のファイルを書き換えるだけです。42 ヘッダの `Updated:` は、エディタで保存したときのようには更新されません。
- `c42check.normExtra.disable` に `unused-include` を入れていれば、削除もしません。

**機械では判定できない項目は、毎回ログの末尾にチェックリストで出します** (`[ ] III.1 (*) …`)。たとえば「名前が英語として読める」「標準ライブラリのマクロが課題で許可された範囲か」「carryall / bad function が無い」「42 ヘッダが保存のたびに更新されている」は、人が見るしかありません。
つまり、この検査が通っても **`(*)` 規則を全て満たしたことにはなりません**。評価で見られる項目のうち、機械で拾える分を先に潰すためのものです。

**誤検知への対処**: 判定は、誤検知より見逃しを選ぶ側 (ヘッダが複数の標準ヘッダの名前を共有するときは「使っている」とみなす、など) に倒していますが、完全ではありません。
続く規則だけを、`c42check.normExtra.disable` (規則の id の配列) で外せます。使ってよい 1 文字の変数名は `c42check.normExtra.shortNames` (既定: `i j k c n s`) です。`c42check.normExclude` (既定: `main.c`) に一致するファイルは、この検査の対象外です。

**Makefile (Norm III.11)** は、プロジェクトの**コピー**で実際に `make` を動かして検査します (元のファイルは変えません)。

- `$(NAME)` / `all` / `clean` / `fclean` / `re` の規則がある (error)
- `make` だけで `all` が動く (`make -p` の `.DEFAULT_GOAL` で確認) (error)
- 2 回目の `make` で何も再ビルドされない = relink しない (1 回目と 2 回目の間で、ファイルの更新時刻が変わらないことで確認) (error)
- `make clean` で `.o` が消え、`make fclean` でビルドの成果物が全て消え、`make re` が通る (error)
- ソースを `wildcard` / `find` / `*.c` で列挙していない (error)
- 同梱のライブラリ (Makefile のあるディレクトリを `-L` で指定) を `$(MAKE) -C` などで自動ビルドしている (error)
- 複数のバイナリを作る課題で、バイナリごとの規則がある → **機械では判定できません** (ログのチェックリスト)

Makefile が無いプロジェクトでは skip です。Makefile が実行する命令 (`git clone` など) も、そのまま動く点に注意してください (コピーの中で実行し、`c42check.staticTimeoutSec` で打ち切ります)。

### コンパイル引数 (`-lbsd` など)

`-lbsd` / `-lm` / `-DDEBUG` / `-L...` のような引数は、VS Code の設定 (`settings.json`、または設定画面で「c42check」を検索) から指定できます。

```jsonc
{
  "c42check.compile.cflags": ["-DDEBUG", "-std=gnu11", "-I${workspaceFolder}/extra"],
  "c42check.compile.ldflags": ["-L/usr/local/lib"],
  "c42check.compile.libs": ["-lbsd", "-lm"],
  "c42check.compile.perStep": {
    "warnings": ["-Wno-unused-parameter"],
    "valgrind": ["--suppressions=${workspaceFolder}/readline.supp"]
  }
}
```

| 設定 | 渡し先 | 備考 |
|---|---|---|
| `c42check.compile.cflags` | **すべてのコンパイル**: 警告強化ビルド、clang-tidy (`--` の後)、`gcc -fanalyzer`、scan-build (Makefile が無いとき)、ASan / TSan / MSan / valgrind 用とデバッグ用のビルド、`compile_commands.json` (clangd) | `-D`、`-std`、`-I` など |
| `c42check.compile.ldflags` | リンクする全ビルド (ASan / TSan / MSan / valgrind / デバッグ) の、**入力ファイルの前** | `-L`、`-Wl,-rpath,...` など |
| `c42check.compile.libs` | リンクする全ビルドの、**入力ファイルの後ろ** | `-lbsd`、`-lm`、`-lreadline` など。**`-l` は必ずここに書く** |
| `c42check.compile.perStep` | **その項目のツールにだけ**渡す引数。キーは `c42check.checks` と同じ項目名 | 下の表 |
| `c42check.compile.warningFlags` | 警告強化ビルドの警告フラグ (既定値を**置き換える**) | 既定: `-Wall -Wextra -Werror -Wshadow -Wconversion` |
| `c42check.clangTidy.checks` | clang-tidy の `-checks=` (既定値を**置き換える**) | 既定: `clang-analyzer-*,bugprone-*` |
| `c42check.valgrind.args` | valgrind のオプション (既定値を**置き換える**) | 既定: `--leak-check=full --show-leak-kinds=all --track-fds=yes`。判定に必要な `--error-exitcode` は常に付く |

- **`-l` を `libs` に分けてあるのは、リンクの順序のためです。** 静的ライブラリ (`.a`) や、`--as-needed` で動くリンカーは、参照する側のファイルより**後ろ**にあるライブラリしか使いません。
  `ldflags` (入力の前) に `-lfoo` と書くと、`undefined reference` になります (静的ライブラリで実際に確認しています)。
- 各要素は **shell 風に分割**されます: `"-lbsd -lm"` は 2 つの引数になります。空白を含むパスは `'...'` で囲んでください。`${workspaceFolder}` が使えます。
  shell は介さないので、`$HOME` や `*` は展開されません。
- Makefile を使う項目 (Makefile があるときの scan-build) は、Makefile 自身のフラグで動きます (この設定は届きません)。

`c42check.compile.perStep` の各キーが、何に渡るか:

| キー | 渡し先 |
|---|---|
| `warnings` / `gccAnalyzer` / `asanUbsan` / `tsan` / `msan` | **コンパイラ**への引数 |
| `clangTidy` | **clang-tidy 自身**のオプション (`--` の前。コンパイラへの引数は `cflags`) |
| `scanBuild` | **scan-build** のオプション (例: `-enable-checker`) |
| `valgrind` | **valgrind** のオプション (例: `--suppressions=...`。ビルドには渡らない) |
| `norminette` / `cFormatter` / `cbmc` / `framaC` | 各コマンドの引数 |

設定の書き間違いは、VS Code が警告します (`perStep` のキーの補完と、未知のキーの警告、配列でない値の警告)。配列でない値は無視され、既定値になります。
デバッグ用ビルド (F5) には `cflags` / `ldflags` / `libs` が効きます (`perStep` は効きません)。

### c_formatter_42 による整形 (norminette の前)

段階 1 の**先頭** (norminette の前) に、`c_formatter_42` でソースを整形する項目があります。View の段階 1 の「c_formatter_42 (整形)」にチェックを入れると、
norminette の前に `.c` / `.h` を整形します (整形後のファイルを norminette が検査します)。

- **ソースをその場で書き換えます。そのため既定は OFF です。** `mainFile` (テスト用の main) は対象外です。
- 入れ方: `pipx install c-formatter-42` (または `pip install --user c-formatter-42`)。clang-format は c_formatter_42 に同梱なので、別に要りません。
  未導入なら、失敗ではなく skip + 対処案になります。動作確認は c_formatter_42 0.2.8 で行いました。
- 変更前の内容は `.42check/format-backup/` に退避します (次の実行で消えます。git で管理していれば `git diff` / `git checkout` でも戻せます)。
- エディタに**未保存の変更があるファイル**があれば、何も書き換えずに skip します。
- **整形でコードが壊れたら、変更したファイルをすべて元に戻して fail にします。** 整形の前にコンパイル (構文チェック) が通っていたのに、整形の後に通らなくなったときが対象です。
  実際に、次の 2 つで壊れることを確認しています。
  - **80 桁を超える文字列リテラル**: 1 回目の整形がリテラルの途中で改行してしまい、2 回目でさらに崩れます (`%zu` が `% zu` になる)。リテラルを `"..." "..."` のように手で分割してから使ってください。
  - **`#include` の順序に依存したコード**: c_formatter_42 は `#include` を並び替えます (`"..."` を `<...>` より前に)。ヘッダが自分で必要な `#include` を持たない場合、並び替えでコンパイルできなくなります。
- ワークスペース直下の `.clang-format` には触れません (c_formatter_42 は cwd の `.clang-format` を一時的に差し替えるため、`.42check/` 内の空のディレクトリで実行します)。
- 「ヘッダにプロトタイプを反映」が書いたブロックとは干渉しません (同期 → 整形 → 同期で、ブロックは変わらないことを確認済み)。

### sanitizer の選択 (ASan+UBSan / TSan / MSan)

sanitizer は互いに併用できないため、View の段階 2 に**別々のチェックボックス**として並んでいます (既定は ASan+UBSan が ON、TSan と MSan は OFF)。
複数にチェックすると、**複数回に分けて**、項目ごとに別ビルド (`.42check/asan/`、`tsan/`、`msan/`) で順番に実行され、結果も項目ごとに出ます。

- TSan はスレッドを使う課題 (philosophers など) で意味があります。MSan は clang 専用です。
- MSan は、プログラムが使うコードのすべてが instrument されている必要があり、そうでないと誤検出することがあります (libc は主な関数を interceptor が補います)。
  MSan の誤検出が疑わしいときは、valgrind の結果と照らして判断してください。出典: [MemorySanitizer — Clang docs (版つきの複製)](https://releases.llvm.org/3.6.2/tools/docs/MemorySanitizer.html)
- **TSan / MSan は `setarch -R` (ASLR 無効) 経由で起動します。** これらはメモリ配置が固定で、カーネルの ASLR の乱数が大きい環境では、**起動のたびに確率的に失敗**します
  (実機では、バグのあるコードでも MSan は約 3 割、TSan は約 9 割で起動できず、検出を見逃していました)。`setarch` は util-linux のコマンドで、sudo なしで使えます。
  `setarch` が無い、または personality を変えられない環境 (seccomp など) では、ASLR を無効にせずに直接起動します (ログに書きます)。ASan+UBSan と valgrind には使いません。
- sanitizer のランタイム (Ubuntu: `libclang-rt-<版>-dev`) が無い、または TSan / MSan がカーネルの ASLR 設定で起動できない環境では、**失敗ではなく skip + 理由 + 対処案**になります。
  TSan / MSan 付きのプログラムが、**プロジェクトのコードとは無関係に起動時に SEGV で落ちた**場合 (報告が無い、またはスタックが sanitizer のランタイム内だけ) も、環境の問題として skip にします。ユーザーのコードが落ちた場合はスタックにそのフレームが出るので、fail のままです。
  ASLR が原因の場合は、上の `setarch -R` で自動的に回避します。それでも起動できなかったときの案内文は、状況に合わせて変わります: `setarch -R` でも起動できない (ASLR 以外の原因) / `setarch` が無い (util-linux を入れる) / `setarch` が使えない (seccomp など。sudo が使える環境なら `sudo sysctl vm.mmap_rnd_bits=28` で回避できることがあります)。出典: [PX4 docs: Sanitizers](https://docs.px4.io/main/en/test_and_ci/sanitizers)、[ziggit: ThreadSanitizer: unexpected memory mapping error](https://ziggit.dev/t/threadsanitizer-unexpected-memory-mapping-error/4930)

## インストール

### ビルド済みの `.vsix` をダウンロードする (GitHub Releases)

どのブランチでも、push のたびに GitHub Actions (`.github/workflows/release.yml`) が型検査 → ビルド → `.vsix` の作成を行い、[Releases](https://github.com/keusidan/c42checker/releases) に公開します。ビルドが失敗したとき (型エラーなど) は、リリースは作られません。

- タグは `v<package.json の version>-build.<実行番号>` です (例: `v0.1.0-build.12`)。リリースの Assets の `.vsix` を取得して、`code --install-extension c42checker-<version>.vsix` で入れます。
- 既定のブランチ (`main`) のリリースは「Latest」になります。それ以外のブランチは pre-release です。
- テストは Actions では実行していません (norminette や sanitizer などの実ツールが必要なため)。リリースする前に手元で `npm test` を通してください。
- 古いリリースは自動では消しません。増えたら、Releases の画面か `gh release delete` で整理してください。

### 手元でビルドする

**推奨: メイン機 (Arch) で `.vsix` をビルドし、校舎には `.vsix` だけを持っていく。**
ビルドには **Node.js 22 以上**が要ります (`@vscode/vsce` は Node 22 以上、esbuild は Node 18 以上、テストの `node --test` も新しい Node が必要)。
校舎の Node は **v12.22.9** なので、校舎ではビルドもテストもできません (`node esbuild.mjs` は構文エラーで止まります)。
拡張そのものは VS Code 同梱の Node で動くため、校舎の Node の版は関係ありません。

```sh
# メイン機 (Node 22 以上):
git clone https://github.com/keusidan/c42checker.git
cd c42checker
npm ci
npm run package                      # c42checker-0.1.0.vsix ができる (約 73KB)

# 校舎 (sudo 不要。.vsix を Drive などで持ってくる):
code --install-extension c42checker-0.1.0.vsix
```

依存する 2 つの拡張のうち、clangd 拡張は `.vsix` のインストールで自動的に入ることが確認できています (`extensionPack`)。
CodeLLDB (`extensionDependencies`) は、確認した環境にすでに入っていたため、自動導入は未確認です。入っていなければ、次を実行してください。

```sh
code --install-extension vadimcn.vscode-lldb
code --install-extension llvm-vs-code-extensions.vscode-clangd
```

- 校舎でどうしてもビルドする場合は、sudo なしで Node 22 を入れる方法として、公式の `tar.xz` を home に展開できます
  (例: `https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz`)。ただし展開後は約 205MB あり、`node_modules` (約 144MB) も加わります。
  **校舎の home の空きは実測で約 1.1GB** (4.7GB 中 3.6GB 使用) でした。CodeLLDB (165MB) と clangd (拡張 1.5MB + バイナリ 225MB) を入れた状態で、さらに Node + `node_modules` で約 350MB 増えるため、余裕は小さくなります。
  内訳と合計は [docs/size-report.md](docs/size-report.md) を参照してください。
- ビルドした後は `rm -rf node_modules` で 144MB を解放できます。
- **rclone でマウントした Drive 上に、ソース / `node_modules` / `.42check/` を置かないでください。**
  小さなファイルが大量にあると極端に遅くなり、VFS キャッシュは home 側に溜まり、ログアウトでマウントも消えます。
  ソースは Git で管理し、Drive は `.vsix` の受け渡しとバックアップに限ります。実行時に、ワークスペースが rclone のマウント上にあれば警告します。
- clangd のバイナリが PATH に無いと、clangd 拡張がダウンロードします。実機では `.vsix` のインストールの約 1 分後にダウンロードされ、
  `~/.config/Code/User/globalStorage/llvm-vs-code-extensions.vscode-clangd/install/` に約 225MB が保存され、`clangd.path` がユーザー設定に自動で書き込まれました。
  容量を使うので、**`.vsix` を入れる前に `df -h ~` で空きを確認**してください (この拡張はダウンロードを代行しません)。
  容量が足りない場合は、clangd 拡張を入れなくても検証 (段階 0〜2) と F5 は使えます。

## 使い方

1. 課題のフォルダを VS Code で開く (信頼するかを聞かれたら、信頼する。Makefile の評価と対象プログラムの実行を行うため、信頼されていないワークスペースでは動きません)
2. アクティビティバーの **42 Check** を開く。段階ごとに項目が並び、チェックボックスで実行する項目を選ぶ (状態は `.vscode/settings.json` の `c42check.checks` に保存)
3. View タイトルの ▶、またはステータスバーの `42 Check` で実行。実行中は ■ で中止できる
4. 結果: 各項目に ✔ / ✘ / skip のアイコン。問題は Problems パネル (ファイル・行・列つき)、生ログはツールごとの Output Channel (`42 Check: <ツール名>`)
5. 未検出のツールは「未検出」と出て、実行すると **skip + 理由 + 対処案** になります (失敗ではありません)
6. View の下の方に、**「ヘッダ」**(プロトタイプの反映) と **「設定」**(真偽値の設定のチェックボックス) のグループがあります (次の 2 節)

### 設定のチェックボックス (View の「設定」グループ)

次の 7 つを、settings.json を開かずに ON / OFF できます。状態は**ワークスペースの settings.json の対応キーと双方向に同期**します
(View で変えると settings.json が書き換わり、settings.json を直接編集すると View のチェックが追従します)。**7 つとも既定は OFF** です。

| チェックボックス | 対応する設定キー |
|---|---|
| failFast を step にする | `c42check.failFast` (ON = `"step"` / OFF = `"stage"`) |
| ASan 付きデバッグ | `c42check.debug.sanitizer` |
| Makefile の check ターゲットを使う | `c42check.useMakeCheckTarget` |
| 実行時 (段階 0) にプロトタイプを同期 | `c42check.proto.syncOnRun` |
| 保存時にプロトタイプを同期 | `c42check.proto.syncOnSave` |
| 使っていない #include を削除 | `c42check.normExtra.removeUnusedIncludes` |
| include の二重指定を検出 | `c42check.normExtra.detectDuplicateIncludes` |

### ヘッダにプロトタイプを反映

`.c` の関数定義からプロトタイプを作り、ヘッダの**マーカーの間だけ**を書き換えます。抽出には **universal-ctags** (`ctags-universal`) を使い、C のパーサは自作していません。

```c
/* ---- auto prototypes begin ---- */
/* ---- auto prototypes end ---- */
```

- コマンドパレットの「42 Check: ヘッダにプロトタイプを反映」、または View の「ヘッダ」グループの項目から実行します。
- 対象は `c42check.proto.sourceDir` 以下の `.c` (再帰。空なら `c42check.targetDir`)。**static 関数と `main` は除外**します。同名の定義が複数あれば (`#ifdef`) 最初の 1 つだけです。
- 書き込み先は `c42check.proto.header` (空ならマーカーのあるヘッダを自動選択。複数あれば選択を求めます)。
- **書き換える前に、差分をプレビューで表示**し、承認してから書き込みます。承認は通知ではなく、**差分エディタのタイトルバーのボタン**です (✓ 反映する / ✕ キャンセル)。
  反映すると、ヘッダが書き換わり、差分エディタは閉じます (成功したときは、通知を出しません)。差分のタブを × で閉じると、キャンセルと同じです。
  差分の右側は読み取り専用の仮想ドキュメントなので、編集も保存もできません (Ctrl+S で保存ダイアログは出ません。反映は、ボタンで行います)。
  差分を開いている間に、ヘッダが別に変更された / 未保存の変更がある場合は、上書きせずにエラーを出します。norminette が指摘したときだけ、通知が出ます (「元に戻す」を選べます)。
- **手書きの宣言と重複させません** (`c42check.proto.skipExisting`、既定 ON): マーカーの**外**で、すでに宣言されている関数 (ヘッダにある宣言を、これも ctags で取得します) は、ブロックに入れません。
  ブロックの中にある古い宣言は、この判定には使いません (定義が無くなった宣言は、ブロックから消えます)。OFF にすると、手書きの宣言があっても全てブロックに入れます。
  関数名の桁は、手書きの宣言の桁に揃えます (norm はヘッダ全体で桁を揃える規則 `MISALIGNED_FUNC_DECL` のため)。手書きの桁より、ブロックに必要な桁 (`unsigned long long` など) が広いときは、手書きの側は変えられないので、norminette が指摘します。
- **マーカーが無いヘッダには、勝手に挿入しません。** 挿入位置 (最後の `#endif` の直前、ガードが無ければ末尾) と差分を見せて、承認を取ります。マーカーが壊れている (片方だけ、重複、順序が逆) 場合はエラーです。
- 42 Norm の形式で出力します: 戻り値の型の後ろはタブ、ポインタは関数名側に寄せ (`char\t*ft_strdup(const char *s);`)、関数名の桁を揃え、**ファイル名のコメントや空行は入れず、関数名の順 (文字コード順) に詰めて並べます**。引数なしは `(void)` にします。マーカーの 2 行はそのまま残ります。
- **書き込み後に `norminette` でヘッダを検査**します。指摘があれば Problems に出し、「元に戻す」を選べます。
- **ctags の結果が空** (対象に static / main しか無い、`.c` が無いなど)、ctags が失敗した、関数ポインタを返す関数など宣言に直せないものがある、ヘッダに未保存の変更がある、のいずれかなら、**ヘッダに触らずエラー**にします。
- ctags が無い、または Universal Ctags ではない (Exuberant / GNU 版) 環境では、**skip + 理由 + 対処案**を表示します。
- 「実行時 (段階 0)」と「保存時」の自動同期 (既定 OFF) は、承認を取れないため**差分プレビューを出さず**、マーカーがあるヘッダだけを書き換えます (マーカーが無ければ何もしません)。
  実行時の同期で、結果が空・ctags の失敗が起きたときは、段階 0 で失敗として止まります。ctags が無いときは skip で、実行は続きます。

### F5 でデバッグする

1. コマンドパレット → `42 Check: launch.json / tasks.json を生成・更新`
   - ファイルが無ければ作成。**既にあれば上書きせず**、差分 (マージ案) を見せて、承認後にだけ追記します (既存の項目は変更しません。JSON で書き出すため、既存のコメントは失われる点に注意)
   - 続けて、`debug.onTaskErrors` を `abort` にする提案が出ます。承認した場合だけ、このワークスペースの設定に書き込みます (勝手には書き換えません)
2. F5。既定の構成は **「Debug (42 Check: 事前チェック → LLDB)」**: 段階 0〜2 → デバッグ用ビルド → CodeLLDB の順。事前チェックに落ちると、デバッガは起動しません
3. 事前チェックを飛ばしたいときは、構成を **「Debug (skip checks) ※事前チェックを飛ばす」** に切り替える (デバッグ用ビルドだけ行う)
4. デバッグ用ビルドは `-g -O0 -fno-omit-frame-pointer` で `.42check/debug/prog` に出力します。ASan + UBSan 付きにするには `c42check.debug.sanitizer: true`
5. 引数は `c42check.runArgs` で変更できます。`cwd` と `terminal` は `c42check.debug.cwd` / `c42check.debug.terminal` (生成時に反映、既定は `${workspaceFolder}` と `integrated`)

### main を持たない課題 (libft など)

動的チェックとデバッグには `main` が要ります。`c42check.mainFile` にテスト用の main (`.c`) のパスを指定してください。

- 対象ソースに `main` が**無い**ときだけ、動的チェックとデバッグ用ビルドに追加されます (ソースに `main` があれば無視)
- `mainFile` は静的チェック (norminette など) の対象には**含まれません** (テスト用のコードなので)
- `c42check.compdb.includeMain` (既定 `true`) で、`compile_commands.json` に含めるかを切り替えられます (含めると clangd がテスト main も解析します)
- `main` が無く `mainFile` も無いときは、動的チェックは skip になり、理由と設定の案内が出ます
- テスト main を課題のフォルダ内 (`tests/` など) に置いたとき、`mainFile` を指定しないと、それは通常のソースとして扱われます (norminette の対象になります)

## clangd との関係 (重要)

- 言語サーバは既存の clangd 拡張を使います。この拡張は、段階 0 でワークスペースのルートに `compile_commands.json` と `.clangd` を生成するだけです。
  `bear` / `compiledb` は不要です。
- **生成は、初回と、必要なときだけです (実行のたびには書き直しません)。** clangd は、`compile_commands.json` が書き換わるたびに読み直して再解析するので、内容が同じなのに毎回書き直すと、無駄に待たされるためです。
  - `compile_commands.json`: 無ければ作ります。42 Check が作ったもの (`.42check/state/compdb.json` に記録があります) は、**中身が変わりうる入力が変わったときだけ**作り直します。入力は、対象の `.c` の一覧・include path・`mainFile`・clang の有無・設定 (`compdb.*` / `compile.cflags` / `includePaths` / `targetDir`)・Makefile の内容です。`.c` の中身の編集や、既存のディレクトリへのヘッダの追加では、作り直しません。
  - **記録がないのに既にある** `compile_commands.json` (自分で用意したものや、記録を入れる前の版が作ったもの) は、**上書きしません**。42 Check で作り直すには、コマンド「42 Check: compile_commands.json を再生成」を実行してください (必ず書き直します。以降は 42 Check が作ったものとして、必要なときだけ更新します)。
  - `.clangd`: **無いときだけ**作ります。既にあれば、42 Check 製のもの (`# generated by c42check` で始まる) も、自作のものも、書き直しません。作り直したいときは、ファイルを消してから再生成コマンドを実行してください。
  - 記録 (`.42check/state/`) は、実行のたびの `.42check/` の作り直しや、「42 Check: .42check/ を削除」コマンドでも消えません。手で `.42check/` を丸ごと消すと、記録も消え、既にある `compile_commands.json` は「自分で用意したもの」として扱われます (再生成コマンドで直せます)。
- 生成方式 (`c42check.compdb.source`): `auto` (既定: Makefile があれば `make -n -B` を解析、取れなければ `files`) / `files` (ソース一覧から直接) / `make-n` / `clang-MJ` (`clang -MJ` の断片を結合)。
  `make -n` は Makefile を評価します (`$(shell ...)` は実行されます)。
- **clangd 内蔵の clang-tidy は、編集中の参考表示です。段階 1 の合否判定は、42 Check が直接実行する clang-tidy (校舎では `clang-tidy-12`) の結果を正とします。**
  両者は版も設定も違うため、編集中に出た警告とここでの結果が一致しないことがあります。
- Microsoft C/C++ (`ms-vscode.cpptools`) は clangd と競合します。入っていれば通知しますが、設定は書き換えません。

## 設定

| 設定 | 既定値 | 内容 |
|---|---|---|
| `c42check.targetDir` | `.` | 検証対象のディレクトリ |
| `c42check.includePaths` | `[]` | 追加の include path (`.h` を含むディレクトリは自動で追加) |
| `c42check.runArgs` | `[]` | 動的チェックとデバッグの実行引数 |
| `c42check.useMakeCheckTarget` | `false` | Makefile に `check` ターゲットがあれば、scan-build は `make` の代わりに `make check` を包んで実行 |
| `c42check.failFast` | `"stage"` | `"stage"`: 段階内は全項目を実行 / `"step"`: 最初の失敗で止める |
| `c42check.minFreeSpaceMB` | `200` | 空き容量の下限 (MB)。下回ると警告して中断 |
| `c42check.workDirMaxMB` | `100` | `.42check/` の上限 (MB)。超えると警告して中断 |
| `c42check.runTimeoutSec` | `10` | 動的チェックの実行の制限時間 (秒。valgrind は 5 倍)。超過は skip |
| `c42check.staticTimeoutSec` | `120` | 静的チェック各ツールの制限時間 (秒) |
| `c42check.normExclude` | `["main.c"]` | norminette と c_formatter_42 の対象から外すファイル (ファイル名 / 相対パスの glob) |
| `c42check.mainFile` | `""` | main を持たない課題用のテスト main |
| `c42check.compdb.includeMain` | `true` | `mainFile` を `compile_commands.json` に含めるか |
| `c42check.compdb.source` | `"auto"` | `compile_commands.json` の生成方式 |
| `c42check.debug.sanitizer` | `false` | デバッグ用ビルドに ASan + UBSan を付ける |
| `c42check.proto.header` | `""` | プロトタイプを反映するヘッダ (空ならマーカーのあるヘッダを自動選択) |
| `c42check.proto.sourceDir` | `""` | 関数定義を抽出する `.c` のディレクトリ (空なら `targetDir`) |
| `c42check.proto.syncOnRun` | `false` | 実行時 (段階 0) にプロトタイプを同期 (プレビューなし) |
| `c42check.proto.syncOnSave` | `false` | `.c` の保存時にプロトタイプを同期 (プレビューなし) |
| `c42check.proto.skipExisting` | `true` | マーカーの外で手書きの宣言がある関数は、ブロックに入れない |
| `c42check.debug.cwd` / `.terminal` | `${workspaceFolder}` / `integrated` | launch 構成に反映 |
| `c42check.checks` | (全項目。TSan / MSan / CBMC / Frama-C のみ `false`) | チェックボックスの状態 (View から変更すると保存される) |

`.42check/` は実行のたびに削除して作り直し、`.gitignore` に自動で追記します。

## 動作確認用のサンプル

`samples/` の各フォルダを VS Code でフォルダとして開いて試せます (そのフォルダが課題のルートの想定)。

| サンプル | 内容 | 期待される結果 |
|---|---|---|
| `samples/ok` | norm 準拠で、バグ無し | 段階 0〜2 とデバッグ用ビルドがすべて pass |
| `samples/norm-ng` | 動作は正常だが norm 違反 | 段階 1 の norminette で fail、段階 2 は実行されない |
| `samples/bug-asan` | 実行時の heap-buffer-overflow (静的解析では見えにくい) | 段階 1 は pass、段階 2 で ASan と valgrind が fail |
| `samples/bug-leak` | メモリリーク + 閉じていない fd | 段階 1 の clang-tidy と scan-build が fail (段階 2 は実行されない) |
| `samples/lib-ok` | main の無いライブラリ課題。`tests/test_main.c` を `c42check.mainFile` で指定 | 動的チェックとデバッグ用ビルドまで pass |
| `samples/bug-tsan` | 2 スレッドが同じ変数を同期なしで更新 (データ競合) | TSan だけが fail (ASan / MSan は pass) |
| `samples/bug-msan` | 初期化していないヒープ領域の読み取り | MSan が fail |
| `samples/proto-ok` | `src/` 以下の複数ファイル (static 関数・関数ポインタ引数・`unsigned long long` を含む) と、マーカーつきのヘッダ `includes/proj.h` | 「ヘッダにプロトタイプを反映」で、norminette を通るヘッダができ、プロジェクトがコンパイルできる |

実機での確認手順 (F5、依存拡張の導入) は [docs/verification.md](docs/verification.md) を参照してください。

## 開発

Node.js 22 以上が必要です (`.nvmrc`、`package.json` の `engines`)。

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # esbuild で dist/extension.js に bundle
npm test            # 229 件。実際のツール (norminette / clang / valgrind など) があれば使い、無ければ該当項目は skip
npm run package     # .vsix を作る
```

構成: `src/core/` は VS Code に依存しない純 TypeScript (検証の実行、parser、`compile_commands.json` 生成、launch 構成の生成) で、
`src/ui/` が VS Code との接続 (TreeView、Task、Diagnostics、Output Channel) です。実行時の依存パッケージはありません。

## 既知の制限

- scan-build は、Makefile が `CC` を固定していても `make CC="$CC"` で上書きして ccc-analyzer を通しますが、レシピがコンパイラを直接 (`gcc` と) 書いている場合は解析されません。
  元のツリーを汚さないよう、`.42check/scan-build/src` にコピーして `make -B` で全ビルドします。
- GUI や無限ループの課題 (so_long、cub3d など) は、制限時間を超えるため動的チェックが skip になります。その項目のチェックを外してください。
- ツールの版が違うと検出結果が変わりえます。開発時の確認は clang 18 / gcc 13 / valgrind 3.22 で行っており、校舎の `-12` 系での確認は未実施です。
- `gcc -fanalyzer` (校舎の gcc-12 で確認) は、`samples/bug-leak` のメモリリークを見逃しました。同じリークを clang-tidy と scan-build、ASan、valgrind は検出しています。
  gcc の analyzer の検出範囲の限界と思われます。`gcc -fanalyzer` が pass でも、他の項目が fail することがあります。
- 校舎の clang-12 に sanitizer のランタイム (compiler-rt) が入っていない、または TSan / MSan が動かない場合は、その項目は skip になります (校舎の `-12` 系での TSan / MSan と、ctags は未確認です)。
- ctags は Universal Ctags でなければ使えません。校舎に無い場合は、プロトタイプの反映は skip になります (検証 本体には影響しません)。
