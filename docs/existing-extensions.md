# 既存の拡張機能の利用方針

この拡張機能 (42 Check) は、すでにある信頼できる拡張機能で実現できる機能を**自作せず**、それらをつなぐ「司令塔」に徹する。

## 自作する範囲 / しない範囲

| 機能 | 担当 | 備考 |
|---|---|---|
| デバッガ (breakpoint、step 実行、変数表示) | CodeLLDB (`vadimcn.vscode-lldb`) | 自作しない。launch.json の `type: "lldb"` で呼ぶだけ |
| 言語サーバ (補完、定義ジャンプ、編集中の診断) | clangd (`llvm-vs-code-extensions.vscode-clangd`) | 自作しない。`compile_commands.json` と `.clangd` を渡すだけ |
| 段階的チェックの統括、fail-fast 制御 | 自作 | 既存の拡張に無い |
| チェックボックス UI、結果の集約、Problems / Output への出力 | 自作 | 同上 |
| launch.json / tasks.json の生成とマージ案の提示 | 自作 | 同上 |
| norminette / clang / clang-tidy / scan-build / gcc / valgrind の実行 | 各ツールの CLI を呼ぶ | ツール自体は校舎に入っているものを使う |

## 採用した既存拡張機能

確認日: **2026-10-07**。確認に使えた経路は GitHub の公開ページと検索結果のみ。
この環境からは Marketplace (`marketplace.visualstudio.com`)、Open VSX、VS Code 公式 docs への通信が遮断されており、
**Marketplace 上の項目 (verified publisher、インストール数、最終更新日) は未確認**。該当欄は実機での確認が必要。

### 1. CodeLLDB — `vadimcn.vscode-lldb`

- 役割: C / C++ / Rust のデバッガ。LLDB を同梱する。
  [MANUAL](https://github.com/vadimcn/codelldb/blob/master/MANUAL.md) に「CodeLLDB bundles a complete LLDB package for every supported platform」とある。
  このため lldb-mi / gdb への自動 fallback は実装していない。
- 採用理由: 校舎マシンは sudo が無く、lldb / gdb を別途入れられない。LLDB を同梱する拡張なら `code --install-extension` だけで完結する。
  `args` が文字列なら shell 風に分割され、`terminal` は `integrated` (既定) / `external` / `console` を取れる (同 MANUAL)。
  これらは launch 構成の生成 (`src/core/launchConfig.ts`) で使っている。

| 基準 | 結果 | 出典 |
|---|---|---|
| verified publisher、またはプロジェクト公式 | 発行元は `vadimcn` (プロジェクトの作者本人)。Marketplace の verified 表示は **未確認** | [リポジトリ](https://github.com/vadimcn/codelldb)、[Spectra Assure の記録](https://secure.software/vscode/packages/vadimcn/vscode-lldb) |
| ソース公開・ライセンス | 公開、MIT | [リポジトリ](https://github.com/vadimcn/codelldb) |
| 継続的な保守 | 3.3k stars、open issue 167、commit 1,445 件、open PR 7 件、discussions あり。リリース: v1.12.3。**日付に食い違いあり**(下記) | [リポジトリ](https://github.com/vadimcn/codelldb)、[releases](https://github.com/vadimcn/codelldb/releases) |
| インストール数 | **未確認** | — |
| 不審な挙動 | 該当情報なし。Spectra Assure では既知の脆弱性なしとの記載 | [Spectra Assure](https://secure.software/vscode/packages/vadimcn/vscode-lldb) |

**日付の食い違い (未解決)**: GitHub の releases ページを取得した結果は「v1.12.3 — 2024-08-23」だった。
一方、ユーザーが別の AI 回答として共有した内容は「v1.12.3 は 2026-08-23、最終 push は 2026-10-01、archived ではない」だった。
どちらが正しいかはこの環境から確定できていない (この AI 回答自体も未検証)。
ユーザーは拡張機能を新規にインストールする予定のため、導入時点で Marketplace に表示される最新版を使う。
**導入後に `code --list-extensions --show-versions` で版を記録し、この表に追記すること。**

### 2. clangd — `llvm-vs-code-extensions.vscode-clangd`

- 役割: clangd (LSP: Language Server Protocol 実装) のクライアント。補完・定義ジャンプ・編集中の診断を提供する。
- 採用理由: LLVM プロジェクトの公式クライアント。42 Check は `compile_commands.json` と `.clangd` を生成して渡すだけでよい。

| 基準 | 結果 | 出典 |
|---|---|---|
| verified publisher、またはプロジェクト公式 | 発行元 `llvm-vs-code-extensions` は clangd 開発者が管理する公式アカウント。Marketplace の verified 表示は **未確認** | [LLVM: vscode-clangd DEVELOPING.md](https://llvm.googlesource.com/clang-tools-extra/+/refs/heads/master/clangd/clients/clangd-vscode/DEVELOPING.md) |
| ソース公開・ライセンス | 公開、MIT | [リポジトリ](https://github.com/clangd/vscode-clangd) |
| 継続的な保守 | 828 stars、open issue 241。最新リリースは 0.6.0 (May 21) と表示されたが、**年が取得できず新しさは未確認** | [releases](https://github.com/clangd/vscode-clangd/releases) |
| インストール数 | **未確認** | — |
| 不審な挙動 | clangd が PATH に無いとダウンロードを促す (x86-64 Linux / Windows / Mac で自動インストール可)。これ以外の外部通信は確認できていない | [README](https://github.com/clangd/vscode-clangd) |

実機で動作確認できたもの: 実際の clangd 18.1.3 (Ubuntu パッケージ) が、42 Check の生成した `compile_commands.json` と `.clangd` を読み込み、
`clangd --check=main.c` が `All checks completed, 0 errors` で完了した (拡張経由ではなくバイナリ単体での確認)。

## 不採用にした候補

| 候補 | 理由 |
|---|---|
| Microsoft C/C++ (`ms-vscode.cpptools`) | 指示により依存しない。clangd と IntelliSense / 診断が競合する。入っていれば通知のみ行い、設定は書き換えない (`src/ui/envCheck.ts`)。デバッガも gdb / lldb-mi 経由のため、「LLDB 同梱で追加インストール不要」という CodeLLDB の利点が無い |
| LLDB DAP (DAP: Debug Adapter Protocol) 系の拡張 | 未調査。システムの lldb (`lldb-dap`) が別途必要と考えられ、sudo の無い校舎では導入が難しい。依存先が使えなくなった場合の代替候補として残す (下記) |
| 他の clang-tidy / clang-format 系の拡張 | 不要。clang-tidy は 42 Check が `clang-tidy-12` を直接実行して合否を判定する。clangd 内蔵の clang-tidy は編集中の参考表示。clang-format は校舎に無い |

## 依存の宣言方法

`package.json` に次のように宣言している (暫定)。

```json
"extensionDependencies": ["vadimcn.vscode-lldb"],
"extensionPack": ["llvm-vs-code-extensions.vscode-clangd"]
```

| 方法 | 意味 (出典) | 今回の使いどころ |
|---|---|---|
| `extensionDependencies` | 依存する拡張の ID の配列。公式 docs の説明は、主拡張のインストール時に依存先も入る、という趣旨 (検索結果の要約) | CodeLLDB。F5 が成立しないと困るので必須扱い |
| `extensionPack` | 一緒にインストールできる拡張の ID の配列。まとめて入れる用途 (個別に外せるかは未確認) | clangd。無くても検証 (段階 0〜2) は動くため任意扱い |
| `.vscode/extensions.json` の `recommendations` | ワークスペースを開いたときに「推奨拡張をインストールしますか」と通知する | 課題リポジトリ側。`samples/*/.vscode/extensions.json` に同梱 |

出典: [Extension Manifest (VS Code docs)](https://code.visualstudio.com/api/references/extension-manifest) (本文は取得できず検索結果の要約のみ)、
[different ways to create vscode extension dependencies](https://docs.lextudio.com/blog/different-ways-to-create-vscode-extension-dependencies/) (取得不可、検索結果の要約のみ)。

**未確認 (実機で要検証)**: 「`.vsix` をローカルから `code --install-extension` で入れたときに、依存先が Marketplace から自動で入るか」は、この環境に VS Code と Marketplace への経路が無いため**実行できていない**。
手順は [verification.md](verification.md) の項目 5。結果によって、`extensionDependencies` を維持するか、README で依存 2 つを明示的に `--install-extension` する手順に倒すかを決める。
どちらの場合でも、README のインストール手順は依存 2 つを明示的に入れる形で書いてあるので、自動導入に失敗しても利用できる。

## 新しい機能を足すときの手順 (既存の拡張で足りないか、先に調べる)

1. やりたいことを 1 行で書く。「UI / 表示」「言語機能」「デバッグ」「ファイル生成」「外部ツール実行」のどれかに分類する。
2. 次の順に、既存の手段で足りないか調べる。
   1. VS Code 標準の機能・設定 (task、problem matcher、`files.*` 等)
   2. すでに採用している 2 つの拡張 (CodeLLDB: launch 構成の項目 / clangd: `.clangd` の設定項目)
   3. 他の拡張 (下記の基準で評価)
3. 他の拡張を候補にするときは、次をすべて確認して**日付つきで**この文書に記録する。
   - Marketplace の verified publisher か、プロジェクト公式の発行元か
   - ソースが公開され、ライセンスが明確か
   - 最終更新日、open issue の状況 (継続的に保守されているか)
   - インストール数
   - 要求する権限、挙動に不審な点が無いか (任意コード実行、外部送信)
4. 1 つでも満たさない、または判断に迷うときは採用せず、代替案と理由を記録して、判断をユーザーに仰ぐ。
5. 採用するときは拡張 ID (`publisher.name`) で固定する。名前の似た別拡張を取り違えない。
6. 自作するのは、上記 1〜5 で足りなかった部分だけ。

## 依存先が使えなくなった場合の対処

| 状況 | 対処 |
|---|---|
| CodeLLDB が Marketplace から消えた / 保守終了 | (1) 導入済みの `.vsix` を Drive に退避しておき (`~/.vscode/extensions/vadimcn.vscode-lldb-*` を zip、または GitHub releases の `.vsix`)、`code --install-extension <file>.vsix` で再導入する。(2) 代替のデバッガ拡張に切り替える。launch 構成の生成は `src/core/launchConfig.ts` の `buildLaunchConfigs` だけに閉じているので、`type` と必要な項目を差し替え、`extensionDependencies` を更新する。検証 (段階 0〜2) と fail-fast は影響を受けない |
| CodeLLDB の挙動が変わって launch 構成が通らない | `package.json` の `extensionDependencies` は版を固定できないため、問題の版を避けて旧版の `.vsix` を入れる (VS Code の「特定バージョンのインストール」) |
| clangd が使えない / 校舎でダウンロードできない | 42 Check の検証 (段階 0〜2) と F5 は clangd に依存しないので、そのまま使える。補完と編集中の診断だけが無くなる。`compile_commands.json` / `.clangd` は生成され続けるので、clangd が使えるようになればそのまま効く |
| 拡張の自動導入に失敗する | README の手順どおり、`code --install-extension vadimcn.vscode-lldb llvm-vs-code-extensions.vscode-clangd` を明示的に実行する |
