# 動作確認の結果

指示された 6 項目について、**何をどこまで実行したか**を分けて記録する。
この開発環境 (Linux sandbox) には VS Code 本体が無く、VS Code / Marketplace / Open VSX への通信も遮断されているため、
VS Code 上でしか確認できない項目は私の環境では実行できていない。それらは「未実行」と明記し、実機での手順を付けた。

**校舎の実機での確認 (2026-10-08、ユーザーが共有した検証報告に基づく。私は再現していない)** は、次の節にまとめた。

## 実行環境と、校舎との差

| ツール | 本環境 (Ubuntu 24.04) | 校舎 (Ubuntu 22.04) の実測 |
|---|---|---|
| norminette | 3.3.60 (pip) | 3.3.59 |
| clang / clang-tidy / scan-build | 18.1.3 (`-18` 付きのみ。素の `clang-tidy` は PATH に無かったため、`-12` → 素の名前 → 入っている最新版の順で検出する実装にした) | 12.0.1 (`-12` 付き) |
| gcc | 13.3.0 (`gcc-13`) | gcc-12 は 12.3.0。素の `gcc` は 10.5 だが、`gcc-12` が優先して選ばれる |
| valgrind | 3.22.0 | 3.18.1 |
| clangd | 18.1.3 (バイナリ単体) | PATH に無い (拡張がダウンロードしたものを使う) |
| Node.js | v22.22.0 | **v12.22.9** (ビルド・テストは不可。拡張の実行は VS Code 同梱の Node なので影響なし) |
| VS Code / CodeLLDB | — | VS Code 1.140、CodeLLDB 1.12.2 |

### 校舎の実機での確認 (ユーザー報告、2026-10-08)

- ツール検出は想定どおり (`clang-12` / `clang-tidy-12` / `scan-build-12` / `gcc-12` / `valgrind` / `norminette` / `make`)。素の gcc 10.5 ではなく gcc-12 が選ばれた
- 5 つのサンプル (`ok` / `norm-ng` / `bug-asan` / `bug-leak` / `lib-ok`) に対して、全チェック項目を 1 つずつ実行:
  正常なサンプルは全項目が成功し、バグ入りのサンプルは想定した項目で失敗として検出された。**`-12` 系での再確認は済み**
- 拡張のコードを、この環境に合わせて直す必要のある箇所は見つからなかった。直すべきだったのはビルド手順、容量見積もり、ドキュメント上の環境の想定 (このコミットで修正)
- `gcc-12 -fanalyzer` は `bug-leak` のリークを**見逃した** (clang-tidy と scan-build、ASan、valgrind は検出)。テストは gcc が検出することを前提にしていないので、全件成功のまま。gcc の analyzer の限界と思われる
- `code --install-extension *.vsix` で、clangd 拡張 (`extensionPack`) が自動で入ることを確認。CodeLLDB (`extensionDependencies`) は、もともと入っていたため確かめられていない
- clangd 拡張は、`.vsix` のインストールの約 1 分後にバイナリを `~/.config/Code/User/globalStorage/llvm-vs-code-extensions.vscode-clangd/install/` へダウンロードし、`clangd.path` をユーザー設定に書き込んだ

**まだ確認できていない**: VS Code の画面上の動作 (F5 でのデバッガの停止、Problems パネルへの表示、clangd の補完)。

チェック内容の判定は版によって差が出うる (特に clang-tidy / gcc -fanalyzer の検出)。上記の校舎の実測で、`-12` 系でも想定どおりだったことは確認済み。

## 自動テスト (236 件)

```sh
# norminette が PATH に必要。無い場合は該当項目が skip になる
npm test        # = node esbuild.mjs --test && node --test "out-test/*.test.js"
```

結果: **236 件中 236 件 pass、0 fail、0 skip** (2026-10-07、上記の環境)。

- `test/parse.test.ts`: 出力の parser (gcc / clang / UBSan / norminette (ANSI カラー除去) / ASan / LSan / valgrind)。norminette の出力から、関数の引数についての指摘 (`TOO_MANY_ARGS` など) だけを除き、残らなくなったファイルを `OK!` にする処理
- `test/pipeline.test.ts`: fail-fast の制御 (fake step で、段階 1 失敗 → 段階 2 非実行 / `failFast: "step"` / skip は失敗ではない / 空き容量不足 / `.42check/` 上限超過)
- `test/compdb.test.ts`: `compile_commands.json` の生成 (files / make-n / clang-MJ / auto の 4 方式)、`mainFile` の include 切り替え、`.clangd` を他人のものは上書きしない
- `test/integration.test.ts`: **実際のツール**で samples を検証 (下表)。本物の norminette で、`norminette.ignoreParameterErrors` が引数の指摘 (5 個の引数・空の引数) だけを除き、他の指摘が残れば fail のままであること
- `test/launch.test.ts`: launch.json / tasks.json の生成とマージ (既存項目は変更しない)
- `test/setarch.test.ts` の「案内文」: TSan / MSan が起動できず skip になったときの対処案が、setarch -R で回避済みか・setarch が無いか・setarch が使えないか、に合わせて変わること (古い「sudo sysctl (校舎では不可)」を出さないこと)
- `test/protoui.test.ts`: 「ヘッダにプロトタイプを反映」の UI の流れ。差分エディタを開くだけでヘッダは変えないこと、**通知を出さないこと**、**無題のドキュメントを作らないこと** (`Untitled-1.c` の保存ダイアログの原因)、「反映する」でヘッダが書き換わり差分エディタが閉じること、「キャンセル」と × で閉じたときの扱い、前の案を閉じて 1 つだけ開くこと、差分を開いている間のヘッダの変更・未保存の変更の検出、norminette が指摘したときだけ通知して「元に戻す」で戻ること
- `test/exclude.test.ts`: `c42check.normExclude` (既定 `main.c`)。パターンの一致規則 (ファイル名 / 相対パス / ディレクトリ / glob)、norminette と c_formatter_42 から外れること、サブディレクトリの `main.c` と `/main.c` の違い、**他のチェック (警告強化ビルド) は除外したファイルにも効くこと**、全て除外されたときの skip、**プロトタイプ同期でも除外したファイルの関数を拾わないこと**、既定値と VS Code の設定からの読み込み
- `test/setarch.test.ts`: TSan / MSan の `setarch -R` 経由の起動。本物の setarch で ASLR が実際に止まること (スタック位置が毎回同じ)、`setarch <arch> -R <prog>` の引数、personality を変えられない環境での再実行、setarch が無い環境、ASan と valgrind は使わないこと、繰り返し実行しても毎回検出すること
- `test/compileargs.test.ts`: コンパイル引数の設定。引数の正規化 (`${workspaceFolder}` の展開、shell 風の分割、shell を介さないこと)、静的ライブラリ `libfoo.a` を使った `-L` / `-l` の検証 (指定が無ければリンク失敗、`ldflags` に `-l` を書くと失敗、`libs` なら成功)、`-D` が必須の課題が全ての項目で通ること、`compile_commands.json` への反映、`perStep` / `warningFlags` / `clangTidy.checks` / `valgrind.args`、VS Code の設定からの読み込みと型が違うときの既定値への戻り、package.json の既定値と DEFAULT_SETTINGS の一致、`ignoreMakefile` (壊れた Makefile があっても `compile_commands.json` と scan-build が `compile.cflags` で動く。偽の scan-build の引数で、`make` を呼ばず `.c` を直接コンパイルすることを確認)
- `test/formatter.test.ts`: c_formatter_42 (0.2.8)。norminette の前に実行される順序、norm 違反が減ること、退避、冪等性、**整形でコードが壊れたら元に戻して fail** (長い文字列リテラル / include の順序依存)、未保存ファイルの skip、ツール無しの skip、`.clang-format` に触れないこと、TSan / MSan の起動時 SEGV の判定
- `test/normextra.test.ts`: Norm v4.1 の (*) 規則の検査。字句読み取り (コメント / 文字列 / 関数定義 / 引数 / ローカル変数)、規則ごとの error と review の判定 (ヘッダの関数定義、使っていない include (標準ヘッダ・**本物の ctags** によるプロジェクトのヘッダ・コメントによる理由づけ)、42 ヘッダ (marvin・学生メール・日時・更新 < 作成)、`#define` (制御構文・三項演算子・代入・関数形式・定数でない値)、コメント (日本語・空・TODO・コメントアウトしたコード・norm の言い訳)、名前 (関数・変数・ファイル))、`normExtra.disable`、引数名を検査するかのオプション (`ft_memcmp` の `s1` / `s2`。ローカル変数は引き続き検査)、全サンプルで error が出ないこと、error / review / `reviewAsFail` / `normExclude` / 全て除外で skip / 段階 1 の fail が段階 2 を止めること、規則の一覧と package.json の一致
- `test/includecheck.test.ts`: 使っていない include のコンパイラによる判定 (**本物の clang**)。関数・型・マクロ・定数 (`malloc` / `write` / `uint8_t` / `INT_MAX`)、名前の表にないプロジェクトのヘッダ (ctags 不要)、自分のヘッダを include する `.c`、提供する名前が重なる include (review)、重なりと未使用の混在、コメントによる理由づけ、ヘッダファイル (include 元の `.c` での使用)、外す前から fatal error のファイル、元のファイルを書き換えない・コピーを消す、clang が無いときの切り替え、step への反映
- `test/includefix.test.ts`: 使っていない include の削除 (`normExtra.removeUnusedIncludes`)。行の削除と空行の詰め方 (CRLF 含む)・行番号のずれの補正、既定 (OFF) では書き換えない、ON で未使用だけを削除して変更前を退避・冪等、ヘッダ経由で使う include は残す、review (重なる include)・コメントで理由のある include・clang が無いときの表による判定は削除しない、未保存のファイルは書き換えない、**削除後の構文チェックが通らなければ全て元に戻す** (clang を差し替えて再現)、`normExtra.disable` で削除もしない
- `test/includeperf.test.ts`: include の判定の高速化と二重指定の検出。名前で「使っている」と分かる include はコンパイルしない (絞り込み)・`size_t` のような複数ヘッダが提供する名前は証拠にしない・全て使っていればコピーもコンパイルもしない・コンパイル回数 (12 ファイルで 72 → 24 回)・並列でも結果が毎回同じ・include-what-you-use (ヘッダとソースの両方に書いた `<stdlib.h>` を未使用にしない)・ヘッダの確認で先頭の単位で必要と分かれば include 元をコンパイルしない、二重指定 (既定 OFF / ON で検出・推移的・同じファイルで 2 回・コメントによる理由・disable・step への反映・自動削除しない)
- `test/generated.test.ts`: 生成ファイルを実行のたびに書き直さないこと。初回に `compile_commands.json` / `.clangd` / 記録を作る・2 回目以降は**中身も更新時刻も変わらない** (clangd が読み直さない)・記録 (`.42check/state/`) が `.42check/` の作り直しで消えない・対象の `.c` の増減 / cflags / Makefile (`make -n`) の変更では作り直し、`.c` の中身の編集 / 既存ディレクトリへのヘッダ追加 / 実行時の設定の変更では作り直さない・消したときは作る・自分で用意したファイルや手で直した `.clangd` は上書きしない・再生成コマンド (force) の挙動・指紋
- `test/makefile.test.ts`: Makefile (Norm III.11) の検査。静的な読み取り (必須の規則・wildcard・同梱ライブラリの自動ビルド) と、**本物の make** での relink・all が既定・clean / fclean / re・make 自体の失敗の検出、元のプロジェクトにビルド成果物を作らないこと、Makefile が無いときの skip
- `test/proto.test.ts`: プロトタイプ同期。ctags の出力の整形 (純粋関数)、マーカー処理、**本物の universal-ctags 5.9.0** での抽出 → norm 形式で書き込み → **norminette 通過** → 生成したヘッダでプロジェクトがコンパイルできる、冪等性、マーカー無し・壊れ・結果が空・宣言に直せない関数・ctags 無し / Exuberant 版・未保存のヘッダでヘッダが変わらないこと、段階 0 での同期
- `test/toggles.test.ts`: 「設定」グループ 5 項目の双方向同期 (settings → チェック / チェック → settings、failFast の "step" / "stage" 変換)、既定がすべて OFF、トグルの対応表と package.json の整合
- `test/workdir.test.ts`: rclone マウントの判定、`.gitignore` への追記、`.42check/` の作り直しと安全装置、容量計測、scan-build 用コピー
- `test/ui.test.ts`: Runner / TaskProvider の制御フロー。`vscode` module を**最小の stub に差し替えて**実行する。VS Code 本体の挙動は検証していない

## 指示された 6 項目

### 1. 正常なサンプルで段階 0〜3 がすべて通る — 段階 0〜2 とデバッグ用ビルドまで ✅ / 段階 3 (デバッガ起動) ❌ 未実行

`samples/ok` で、準備 → norminette → 警告強化ビルド → clang-tidy → scan-build → gcc -fanalyzer → ASan + UBSan → valgrind → デバッグ用ビルド (`.42check/debug/prog`) が**すべて pass**
(テスト `正常なサンプル: 段階 0〜2 がすべて通る` と `pre-debug (正常)`)。
`samples/lib-ok` (main 無しのライブラリ課題) も、`c42check.mainFile` を指定すると動的チェックとデバッグ用ビルドまで pass。

段階 3 (CodeLLDB によるデバッガ起動そのもの) は VS Code が必要なため**未実行**。実機の手順は下記。

### 2. norminette に落ちるサンプルで、段階 2 とデバッガが実行されない — ✅ (デバッガは項目 3 を参照)

`samples/norm-ng` (動作は正常だが norm 違反):

- 段階 1 の norminette が fail。同じ段階の警告強化ビルドなどは実行され pass (`failFast: "stage"`)
- 段階 2 (ASan / valgrind) とデバッグ用ビルドは**実行されない** (結果に出ず、「実行していません (前の失敗のため)」と表示)
- norminette の診断 (`INVALID_HEADER`、`SPACE_BEFORE_FUNC` など) が行・列つきで取れる
- Task 経由 (`pre-debug`) の終了コードは **1**、`.42check/debug/prog` は**作られない**

補足の実測:

| サンプル | 結果 |
|---|---|
| `bug-asan` (heap-buffer-overflow、実行時の argc に依存) | 段階 1 は全 pass → 段階 2 で ASan が fail (`main.c:24:16`)、同じ段階の valgrind も fail (`main.c:24`) |
| `bug-leak` (リーク + 閉じていない fd) | 段階 1 で clang-tidy と scan-build が fail (`main.c:33:7 Potential leak`)、段階 2 は実行されない。valgrind を単独実行すると、リークと `Open file descriptor` の両方を検出 |

### 3. F5 で事前チェック失敗時にデバッガが起動しない — ❌ 未実行 (VS Code が必要)

確認できていること (stub での検証):

- `preLaunchTask` に相当する Task (`c42check` type) が、失敗時に**終了コード非 0** で閉じる
- 失敗時は `.42check/` を最初に削除するため、**`.42check/debug/prog` が存在しない**。
  万一 VS Code が「Debug Anyway」でデバッガを起動しても、CodeLLDB は存在しない `program` を起動できない (二重の保険)

確認できていないこと: VS Code 本体が、`preLaunchTask` の非 0 終了と `debug.onTaskErrors: "abort"` を受けてデバッガ起動を止めること。
(検索で「abort にしても止まらなかった」という報告が見つかったが、原文は別件 (microsoft/vscode#54397: background task + `dependsOn` の問題) で、`abort` が無効という裏付けは得られなかった。
いずれにせよ未検証。)

**実機での手順**:

1. `samples/norm-ng` をフォルダとして VS Code で開く
2. コマンドパレット → `42 Check: launch.json / tasks.json を生成・更新` → `debug.onTaskErrors` を `abort` にする提案を承認
3. `main.c` を開いて F5。「Debug (42 Check: 事前チェック → LLDB)」が選ばれていること
4. 期待: Problems に norminette の診断が出る / 通知に「段階 1 の norminette で失敗しました。後続の段階は実行していません」 / **デバッガは起動しない**
5. 対照: 構成を「Debug (skip checks) ※事前チェックを飛ばす」に切り替えて F5 → デバッガが起動する
6. `samples/ok` で F5 → 事前チェック通過後にデバッガが起動し、breakpoint で止まる

### 4. compile_commands.json が生成され、clangd が参照できる — 生成 ✅ / clangd バイナリ単体での参照 ✅ / 拡張経由 ❌ 未実行

- 4 方式 (`files` / `make-n` / `clang-MJ` / `auto`) すべてで `samples/ok` から 2 件のエントリを生成 (テスト)
- 生成物を実際の **clangd 18.1.3** に読ませた: `clangd --check=main.c` が
  `Loaded compilation database from .../compile_commands.json`、
  `Compile command from CDB is: ... cc -Wall -Wextra -Werror -c -Wall -Wextra -Wshadow -Wconversion ...` (Makefile の CFLAGS と `.clangd` の追加フラグが両方反映)、
  `All checks completed, 0 errors` で完了
- VS Code の clangd 拡張が実際にこれを参照する部分は未実行 (実機で、`main.c` を開いて補完 / ホバーが効き、`.clangd` の警告が表示されることを確認)

### 5. 依存の既存拡張機能が、.vsix のインストール後に想定どおり導入または推奨される — ❌ 未実行 (VS Code と Marketplace が必要)

`.vsix` のビルド (`npm run package`) は成功し、manifest に `extensionDependencies: ["vadimcn.vscode-lldb"]` と
`extensionPack: ["llvm-vs-code-extensions.vscode-clangd"]` が入っていることまでは確認した。
**導入時の自動解決の挙動**: 校舎の実機 (ユーザー報告) で、`code --install-extension *.vsix` により clangd 拡張 (`extensionPack`) が自動で入ることを確認。
CodeLLDB (`extensionDependencies`) は、もともと入っていたため未確認 (下記の手順の 1 で CodeLLDB も外せば確認できる)。

**実機での手順** (校舎マシンと自分のメイン機の両方で):

1. 何も入っていない状態を作る: `code --uninstall-extension vadimcn.vscode-lldb` と `code --uninstall-extension llvm-vs-code-extensions.vscode-clangd` (または `--user-data-dir` / `--extensions-dir` を空の場所に指定した `code` で試す)
2. `code --install-extension c42checker-0.1.0.vsix` を実行
3. `code --list-extensions --show-versions` で、`vadimcn.vscode-lldb` と `llvm-vs-code-extensions.vscode-clangd` が増えたかを確認し、結果を記録
4. 増えなかった側について、採用する宣言方法を決める (`extensionDependencies` / `extensionPack` / README で明示的に `--install-extension`)。
   その結果を [existing-extensions.md](existing-extensions.md) の「依存の宣言方法」に追記する
5. 補足: `samples/*/.vscode/extensions.json` の recommendations は、サンプルをフォルダとして開いたときに「推奨拡張をインストールしますか」の通知が出るかを確認

### 6. 完成品の合計サイズが 500MB 以内 — ✅

自作分は約 **147MB** (`node_modules` 144MB を含む) で、500MB の目標内。詳細は [size-report.md](size-report.md)。
CodeLLDB と clangd は別計測で、校舎の実機での実測は CodeLLDB 165MB、clangd 拡張 1.5MB、clangd バイナリ 225MB (ユーザー報告)。
依存込みの合計は約 540MB で、500MB は超えるが、校舎の home の実測の空き (約 1.1GB) には収まる。

## その他、VS Code 上で確認してほしいこと (未実行)

- View のチェックボックスの状態が `.vscode/settings.json` (`c42check.checks`) に保存され、再読み込み後も残る
- View タイトルの「実行」ボタン / ステータスバー / コマンドパレットから実行でき、実行中は中止ボタンに変わる
- 成功 / 失敗 / skip のアイコンが各項目に付く。未検出のツールは「未検出」と出て、実行すると skip になる
- Problems パネルに、ファイル・行・列つきの診断が出る (ツールごとに `42check:<tool>` の source)
- `ms-vscode.cpptools` を入れた状態で、競合の通知が出る (設定は書き換わらない)
- `clangd` が PATH に無い状態で、容量の注意 (`df -h ~`) が通知される
- 既存の `launch.json` がある状態で `launch.json / tasks.json を生成・更新` を実行すると、上書きされずに差分が表示され、承認後にだけ追記される

## 追加機能 (TSan / MSan、プロトタイプ同期、設定トグル) の確認状況

確認できたこと (本環境: clang 18.1.3、universal-ctags 5.9.0、norminette 3.3.60。上記の自動テストによる):

- TSan が `samples/bug-tsan` のデータ競合を、MSan が `samples/bug-msan` の未初期化読み取りを検出し、位置 (行・列) に診断が付く。正常なサンプルは両方とも pass
- TSan / MSan / ASan+UBSan を同時にチェックすると、項目ごとに別ビルド (`.42check/asan|tsan|msan/prog`) で順に実行され、判定も独立 (bug-tsan では TSan だけが fail)
- プロトタイプ同期は、生成されたヘッダが norminette を通り、プロジェクトがコンパイルできる。マーカーが無い / 結果が空などの異常系では、ヘッダが 1 バイトも変わらない

**まだ確認できていないこと**:

- 校舎の `-12` 系での TSan / MSan。clang-12 に compiler-rt が無い場合、または ASLR 設定で起動できない場合は **skip** になる設計だが、実機では未確認
- 校舎での universal-ctags (入っていない場合は skip)。メイン機の `ctags` が Universal Ctags であること
- VS Code の画面上の動作: 差分プレビュー (`vscode.diff`) と承認ボタン、「元に戻す」、保存時の自動同期、View の「設定」グループのチェックボックス、「ヘッダ」グループのクリック。
  UI の制御フローは `vscode` を stub に差し替えたテストで検証したが、VS Code 本体では未実行
- 保存時 / 実行時の同期で差分プレビューが出ないこと (承認を取れないため、意図した仕様)。マーカーがあるヘッダだけが対象

## c_formatter_42 の確認状況 (本環境: c_formatter_42 0.2.8)

確認できたこと (自動テスト):

- `samples/norm-ng` (文字列を短くしたもの) を整形すると、`INVALID_HEADER` 以外の norm 違反がすべて直る。norm 準拠の `samples/ok` は、`#include` の並びだけが変わり、norminette と警告強化ビルドを通る
- **80 桁を超える文字列リテラルでコードが壊れる** (1 回目でリテラルの途中に改行、2 回目でさらに崩れる) ことを実際に確認し、構文チェックで検出して元に戻す安全装置を入れた
- c_formatter_42 は cwd の `.clang-format` を差し替える実装 (ソースを確認) なので、`.42check/format-cwd/` で実行し、ワークスペースの `.clang-format` を保護している
- プロトタイプ同期のブロックと、c_formatter_42 は干渉しない

**未確認**: 校舎での c_formatter_42 の導入 (pip / pipx が使えるか、home の容量)、VS Code 上での操作。

## MSan / TSan が起動時に落ちる環境 (校舎の実機での報告)

実機で「MSan が起動時に SIGSEGV で落ち、fail 扱いになる」「テストが 1 件失敗する」という報告があった (ユーザーが共有した別セッションの調査ログ。原因の特定までは含まれていない)。
本環境では再現できていない。ログから原因は確認できていないため、次の**推測に基づく対応**を入れた:

- 起動時に SEGV で落ち、(a) sanitizer の報告が無い、または (b) スタックがプロジェクトのコードを含まず sanitizer のランタイム内だけ、の場合は、環境の問題として **skip** にする (`isSanitizerStartupCrash`)
- ユーザーのコードが落ちた場合 (スタックにプロジェクトのフレームがある) は、これまでどおり fail

実機の MSan のログ (`.42check/` の出力、または失敗した項目の Output Channel) を確認できたら、この判定を実際の出力に合わせて見直す。

## TSan / MSan の確率的な skip (校舎の実機での報告) と setarch -R

実機で、バグのあるコードでも MSan が約 3 割、TSan が約 9 割の確率で skip になり、バグを見逃す、という報告があった (ユーザー報告)。
起動のたびに結果が変わることから、カーネルの ASLR の乱数が原因と判断し、TSan / MSan の起動を `setarch <arch> -R <prog>` 経由にした。

- 本環境では、修正の前から TSan / MSan が毎回起動できた (`vm.mmap_rnd_bits` が 28) ため、**確率的な skip そのものは再現できていない**。
  そのため「修正で実機の skip が消えること」は、本環境では証明できない。**実機での確認が必要** (下記)
- 確認できたのは、修正の前提と挙動: 本物の `setarch -R` で ASLR が実際に止まること、引数の形、`setarch` が使えない環境でのフォールバック、TSan / MSan を 8 回繰り返して毎回検出すること

**実機での確認手順**: 校舎で `samples/bug-tsan` と `samples/bug-msan` を開き、TSan / MSan だけにチェックを入れて、20 回ほど続けて実行する。毎回 fail (検出) になり、skip が 1 回も出なければ解消している。
skip が残る場合は、その項目の Output Channel のログ (`$ setarch ... -R ...` の行と、その後の出力) を確認する。

## ヘッダへのプロトタイプ反映: 差分エディタのボタンと、手書きの宣言との重複 (実機のスクリーンショットの指摘)

- **`Untitled-1.c` の保存ダイアログ**: 実装の不備だった。差分の右側を「無題の新規ドキュメント」として開いていたため、保存すると保存ダイアログが出た。読み取り専用の仮想ドキュメント (`c42check-proposal:`) に変更し、無題のドキュメントを作らない (テストで確認)。
- **反映後に差分が残りっぱなし / 通知**: 承認を通知から、差分エディタのタイトルバーのボタンに変更。反映・キャンセルで差分エディタを閉じ、成功時は通知を出さない。
- **手書きの宣言との重複**: ヘッダの宣言を ctags で取得し、マーカーの外で宣言済みの関数をブロックに入れない (`c42check.proto.skipExisting`、既定 ON)。ご提示のヘッダと同じ形 (`//part1` と手書きの宣言、複数行の宣言、`static inline` の定義を含む) で ctags が宣言を取得できることを確認した。

**未確認 (VS Code 本体でしか確認できない)**: タイトルバーの「反映する / キャンセル」ボタンが、反映案の差分エディタを開いたときに**実際に表示されること**。
ボタンは、コンテキストキー `c42check.proposalActive` (「いま開いているタブが反映案の差分か」を拡張が設定する) で出し分けている。stub のテストでは、このキーが差分を開くと true、閉じると false になることまで確認した。
表示されない場合は、差分エディタのタイトルバー (右上の `…` を含む) を確認し、なければ教えてほしい。
**逃げ道**: 反映案の差分が開いているときだけ、コマンドパレット (Ctrl+Shift+P) から「42 Check: プロトタイプを反映する」「42 Check: 反映案をキャンセル」を実行できる (ボタンが出ない場合でも、反映できる)。


## Norm の (*) 規則と Makefile の検査 (norminette が検査しないもの)

出典: The Norm, Version 4.1 (Chapter I Foreword: `(*)` は norminette が検査せず、評価で見つかるとプロジェクト失敗になりうる / III.11: Makefile は norminette が検査しない)。

**確認できたこと** (自動テスト、本環境: universal-ctags 5.9.0、GNU Make、clang 18):
- 全サンプル (norm 準拠のもの) で `error` が出ない。`review` は出うる (サンプルの `f` `a` `b` という引数名など)
- 規則ごとに、違反を入れたファイルで error / review が出て、直すと出なくなる
- Makefile: 本物の `make` で、relink (毎回リビルド / 常に古い扱いの目標)・all が既定でない・clean で `.o` が残る・fclean で成果物が残る・規則が無い・make 自体の失敗・wildcard を検出する。元のプロジェクトにはビルド成果物を作らない

**確認できていないこと**:
- 実際の 42 の課題 (libft、minishell など) での**誤検知の率**。判定は、誤検知より見逃しを選ぶ側に倒していますが、実プロジェクトでの実測はしていません。続く誤検知は `c42check.normExtra.disable` で規則ごとに外せます
- 実際の VS Code / clangd で、`compile_commands.json` を書き直さなくなったことによる再解析の減少 (更新時刻が変わらないことまでは、自動テストで確認)
- 校舎の clang-12 での `unused-include` の判定 (本環境は clang 18)。診断が増えるかを比べる方式なので、版による warning / error の違い (暗黙の関数宣言など) には影響されない設計ですが、実機では未確認です
- 削除機能を、実際の 42 の課題の `.c` / `.h` に使ったときの結果 (どの include が消えるか)。削除前に構文チェックが通っていることを確かめ、通らなくなれば元に戻す安全弁はありますが、リンクや実行時の挙動 (`#ifdef` で切り替わる実装など) までは確かめません。Git で差分を確認してください
- VS Code のエディタが、書き換えたファイルを自動で読み直すこと (未保存の変更が無ければ、VS Code は外部の変更を読み直します)
- `unused-include` の取りこぼし: `#ifdef` で使うマクロだけを提供する include は、外しても診断が変わらず、未使用と判定されます
- 標準ヘッダの「提供する名前」の表 (`src/core/stdsyms.ts`) は、clang が無い / 外す前から fatal error のファイルだけの代わりです。表にあるのに名前が足りないと、その場合だけ誤って error になりえます
- 校舎の `make` (GNU Make 4.3) での動作 (本環境は GNU Make 4.4 系)
- VS Code の Problems パネルでの表示 (診断は `norm-extra` / `makefile` という source で出します)

**自動では判定できない項目** (ログの末尾にチェックリストで毎回出します。つまり、この検査が通っても `(*)` 規則を全て満たしたことにはなりません):
名前が英語として読める (III.1) / clang が無いとき・外す前から fatal error のファイルの、表にないヘッダの未使用 include (III.5) / 42 ヘッダが保存のたびに更新されている (III.6) / 標準ライブラリのマクロが課題で許可された範囲か (III.7) / norm 回避の `#define` のうち、制御構文・文・三項演算子・代入以外の手口 (III.7) / コメントが役に立つ内容か・英語か (ASCII 以外の文字を除く) (III.9) / carryall・bad function が無い (III.9) / 複数バイナリの課題でバイナリごとの規則がある (III.11)

## 速度

40 個の `.c` (各 7 個の include、うち 1 個が未使用) と 2 個のヘッダの合成プロジェクトで、`normExtra` の実行時間を測った (本環境、4 コア、clang 18):

| | 時間 | 構文チェックの回数 |
|---|---|---|
| 最初の実装 (全ての include を 1 つずつ外す) | 約 16.6 秒 | 402 |
| 名前による絞り込み + 並列化 + ヘッダの早期終了 | 約 0.9 秒 | 82 |

`makefile` の項目は、2 回目の `make` の前の待ちを 1.1 秒から 0.15 秒に縮めた (更新時刻をナノ秒で比べる)。同じプロジェクトの段階 1 全体では、`norminette` が約 0.4 秒、警告強化ビルドが約 1.4 秒、`clang-tidy` が約 2.3 秒。**校舎のマシンでの実測はしていません** (コア数や clang の版で変わります)。
