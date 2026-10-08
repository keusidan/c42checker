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

## 自動テスト (94 件)

```sh
# norminette が PATH に必要。無い場合は該当項目が skip になる
npm test        # = node esbuild.mjs --test && node --test "out-test/*.test.js"
```

結果: **94 件中 94 件 pass、0 fail、0 skip** (2026-10-07、上記の環境)。

- `test/parse.test.ts`: 出力の parser (gcc / clang / UBSan / norminette (ANSI カラー除去) / ASan / LSan / valgrind)
- `test/pipeline.test.ts`: fail-fast の制御 (fake step で、段階 1 失敗 → 段階 2 非実行 / `failFast: "step"` / skip は失敗ではない / 空き容量不足 / `.42check/` 上限超過)
- `test/compdb.test.ts`: `compile_commands.json` の生成 (files / make-n / clang-MJ / auto の 4 方式)、`mainFile` の include 切り替え、`.clangd` を他人のものは上書きしない
- `test/integration.test.ts`: **実際のツール**で samples を検証 (下表)
- `test/launch.test.ts`: launch.json / tasks.json の生成とマージ (既存項目は変更しない)
- `test/formatter.test.ts`: c_formatter_42 (0.2.8)。norminette の前に実行される順序、norm 違反が減ること、退避、冪等性、**整形でコードが壊れたら元に戻して fail** (長い文字列リテラル / include の順序依存)、未保存ファイルの skip、ツール無しの skip、`.clang-format` に触れないこと、TSan / MSan の起動時 SEGV の判定
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

