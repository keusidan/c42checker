# 動作確認の結果

指示された 6 項目について、**何をどこまで実行したか**を分けて記録する。
この開発環境 (Linux sandbox) には VS Code 本体が無く、VS Code / Marketplace / Open VSX への通信も遮断されているため、
VS Code 上でしか確認できない項目は実行できていない。それらは「未実行」と明記し、実機での手順を付けた。

## 実行環境と、校舎との差

| ツール | 本環境 (Ubuntu 24.04) | 校舎 (Ubuntu 22.04) の想定 |
|---|---|---|
| norminette | 3.3.60 (pip) | 校舎の標準版 |
| clang / clang-tidy / scan-build | 18.1.3 (`-18` 付きのみ。素の `clang-tidy` は PATH に無かったため、`-12` → 素の名前 → 入っている最新版の順で検出する実装にした) | `-12` 系 |
| gcc | 13.3.0 (`gcc-13`) | gcc-12 |
| valgrind | 3.22.0 | 校舎のもの |
| clangd | 18.1.3 (バイナリ単体) | 校舎には無い |
| Node.js | v22.22.0 | — |

チェック内容の判定は版によって差が出うる (特に clang-tidy / gcc -fanalyzer の検出)。校舎では `-12` 系で再確認すること。

## 自動テスト (46 件)

```sh
# norminette が PATH に必要。無い場合は該当項目が skip になる
npm test        # = node esbuild.mjs --test && node --test "out-test/*.test.js"
```

結果: **46 件中 46 件 pass、0 fail、0 skip** (2026-10-07、上記の環境)。

- `test/parse.test.ts`: 出力の parser (gcc / clang / UBSan / norminette (ANSI カラー除去) / ASan / LSan / valgrind)
- `test/pipeline.test.ts`: fail-fast の制御 (fake step で、段階 1 失敗 → 段階 2 非実行 / `failFast: "step"` / skip は失敗ではない / 空き容量不足 / `.42check/` 上限超過)
- `test/compdb.test.ts`: `compile_commands.json` の生成 (files / make-n / clang-MJ / auto の 4 方式)、`mainFile` の include 切り替え、`.clangd` を他人のものは上書きしない
- `test/integration.test.ts`: **実際のツール**で samples を検証 (下表)
- `test/launch.test.ts`: launch.json / tasks.json の生成とマージ (既存項目は変更しない)
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
**導入時の自動解決の挙動は未確認**。

**実機での手順** (校舎マシンと自分のメイン機の両方で):

1. 何も入っていない状態を作る: `code --uninstall-extension vadimcn.vscode-lldb` と `code --uninstall-extension llvm-vs-code-extensions.vscode-clangd` (または `--user-data-dir` / `--extensions-dir` を空の場所に指定した `code` で試す)
2. `code --install-extension c42checker-0.1.0.vsix` を実行
3. `code --list-extensions --show-versions` で、`vadimcn.vscode-lldb` と `llvm-vs-code-extensions.vscode-clangd` が増えたかを確認し、結果を記録
4. 増えなかった側について、採用する宣言方法を決める (`extensionDependencies` / `extensionPack` / README で明示的に `--install-extension`)。
   その結果を [existing-extensions.md](existing-extensions.md) の「依存の宣言方法」に追記する
5. 補足: `samples/*/.vscode/extensions.json` の recommendations は、サンプルをフォルダとして開いたときに「推奨拡張をインストールしますか」の通知が出るかを確認

### 6. 完成品の合計サイズが 500MB 以内 — ✅

約 **147MB** (`node_modules` 144MB を含む)。詳細は [size-report.md](size-report.md)。
CodeLLDB と clangd (拡張とバイナリ) は別計測で、未計測。

## その他、VS Code 上で確認してほしいこと (未実行)

- View のチェックボックスの状態が `.vscode/settings.json` (`c42check.checks`) に保存され、再読み込み後も残る
- View タイトルの「実行」ボタン / ステータスバー / コマンドパレットから実行でき、実行中は中止ボタンに変わる
- 成功 / 失敗 / skip のアイコンが各項目に付く。未検出のツールは「未検出」と出て、実行すると skip になる
- Problems パネルに、ファイル・行・列つきの診断が出る (ツールごとに `42check:<tool>` の source)
- `ms-vscode.cpptools` を入れた状態で、競合の通知が出る (設定は書き換わらない)
- `clangd` が PATH に無い状態で、容量の注意 (`df -h ~`) が通知される
- 既存の `launch.json` がある状態で `launch.json / tasks.json を生成・更新` を実行すると、上書きされずに差分が表示され、承認後にだけ追記される
