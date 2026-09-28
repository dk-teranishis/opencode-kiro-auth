# Kiro ACP 移行・評価計画

作成日: 2026-09-28  
対象: このリポジトリの OpenCode V2 用 Kiro プラグイン

## 目的と判断基準

AWS CodeWhisperer Streaming SDK 経路に加え、公式 `kiro-cli` と ACP で通信する経路を実装した。模擬試験と限定的な実通信評価を踏まえ、ACP を既定経路、SDK を明示的な互換経路とした。移行の目的は、断続的な `Error: aborted` の発生箇所を切り分け、安定した通信経路を選ぶことである。ACP 化だけで障害が解消すると断定しない。

現行コードは `src/plugin.ts` の `session.hook('http.response')` から `RequestHandler` に処理を渡し、`src/plugin/sdk-client.ts` の AWS SDK で Kiro に接続する。ヘッダー受信と最初のイベント取得後にもストリームが中断する事例がある。`src/core/request/response-handler.ts` の SSE keepalive は OpenCode 側への出力であり、上流 SDK の中断を防ぐものではない。

参考実装は [NachoFLizaur/opencode-kiro v0.5.0-beta.5](https://github.com/NachoFLizaur/opencode-kiro/tree/v0.5.0-beta.5)。同版は `kiro-acp-ai-provider@3.2.0` と特定の OpenCode V2 開発版を対象としており、現行の `@opencode/plugin@2.0.18` での動作は未確認である。設計を参考にするが、依存関係・認証・ツール許可設定をそのままコピーしない。

## 変更の境界

- ACP と既存 SDK は設定で排他的に選択する。ACP を既定値とし、SDK は `transport: "sdk"` または `KIRO_TRANSPORT=sdk` を指定した場合だけ使用する。同一リクエストに両方の経路を登録・送信せず、実行中リクエストの自動切替もしない。
- 既存の Kiro アカウント DB、認証トークン、OpenCode の認証保存領域は移動・上書き・削除しない。ACP の認証と更新は `kiro-cli` に任せる。既存の複数アカウント選択・利用状況表示が ACP で同じように提供できるとは仮定しない。
- 現行の変更済みファイル（`src/core/request/request-handler.ts`、`src/core/request/response-handler.ts`、`src/plugin/sdk-client.ts`、`src/plugin/streaming/sdk-stream-transformer.ts`）を基準として扱い、作業開始時に差分を確認する。既存作業を reset しない。
- ログにはモデル ID、処理段階、時刻・経過時間、エラー種別だけを残す。メールアドレス、認証情報、プロンプト、リクエスト本文、生成内容、ACP メッセージ本文は記録しない。
- Nacho 版の `trustAllTools: true` は採用を前提としない。OpenCode の許可設定と ACP 側ツール実行の対応を検証し、安全な設定を決める。

## 実装と評価の工程

### 1. 実行環境の互換性ゲート

**実装状態（2026-09-28）:** `kiro-acp-ai-provider@3.2.0` を固定し、`src/plugin/acp-compatibility-gate.ts` とその模擬試験を追加した。試験は認証・`kiro-cli`・推論を起動せず、現行 V2 の `sdk`／`language` フック契約、選択モデル、effort、正常・エラー・キャンセルの模擬結果、後始末の順序を検証する。実際の OpenCode ホストによるフック発火確認と実 ACP 通信はフェーズ2以降の評価対象とする。

1. 現行 OpenCode V2、`@opencode/plugin`、Node.js、`kiro-cli` のバージョンと導入状態を記録する。`kiro-acp-ai-provider` の対応するバージョン・ライセンス・依存関係を確認し、使用する場合は固定する。検証中にグローバル設定や認証ファイルは変更しない。
2. 認証不要の模擬 ACP プロバイダーを使い、現行 V2 で `provider.package` の ACP 用指定と `aisdk.hook('sdk')`／`aisdk.hook('language')` が発火し、選択されたモデルの呼び出しに使われるか確認する。モデル一覧表示だけでは通過とみなさない。旧試作では OpenAI-compatible 経路で `language` フックが呼ばれなかったため、ここを先に確かめる。
3. 模擬呼び出しでフックが使われなければ ACP 本実装を保留し、現行 V2 に対応する登録方式またはプロバイダー・アダプターを調査する。動作しないまま SDK 経路を外さない。

**通過条件:** 模擬モデル呼び出しが ACP アダプターを通り、正常応答・エラー・キャンセルの各経路が観測できる。

### 2. ACP 経路を追加

**実装状態（2026-09-28）:** `transport` 設定を追加し、既定値を `acp` とした。`acp` のときだけ `aisdk` フックと ACP provider package を登録し、SDK の認証初期化、HTTP 応答フック、Web 検索ツールは登録しない。ACP provider は最初の SDK フックまで遅延生成され、終了時には両フックを解除して provider を停止する。モデル ID は既存の Kiro 実行 ID に正規化し、reasoning variant の budget を ACP effort に変換する。未評価の ACP ツール許可は `trustAllTools: false` と permission cancel で拒否する。

1. `src/plugin.ts` のプロバイダー定義・認証・通信登録を分離し、設定で `sdk`／`acp` の一方だけを有効化する。SDK 側の `http.response` フックは `sdk` 時だけ登録する。
2. ACP 側に `kiro-cli` を使用するプロバイダー生成、モデル選択、effort 反映を実装する。Nacho 版の [AISDK フックと後始末](https://github.com/NachoFLizaur/opencode-kiro/blob/v0.5.0-beta.5/src/server/aisdk.ts)を参照し、キャッシュキーには秘密や無関係なホスト設定を含めない。プラグイン解除時は登録を破棄し、所有する ACP 子プロセス・セッションを終了する。
3. ACP の生成が途中で切れた場合、出力済みテキストや実行済みツールを含む呼び出しを無条件に再送しない。再試行の責任範囲（`kiro-cli`／ACP プロバイダー／OpenCode）と、利用者キャンセル時の停止処理を明示する。

**通過条件:** 一つのリクエストにつき選択した経路のみが動き、通常終了・エラー・利用者キャンセルの後に登録と子プロセスが残らない。

### 3. 認証・モデル・機能差を整理

**実装状態（2026-09-28）:** ACP 起動時に `verifyAuthAsync()` で `kiro-cli` の導入・ログイン状態を確認し、状態を秘密情報なしで記録する。OpenCode の **Kiro CLI Login** は `kiro-cli` にログインを委譲し、OpenCode へは非秘密の存在記録だけを返す。認証済みの場合だけ runtime model discovery を実行し、返却されたモデル ID と一致する既存カタログ項目だけを公開する。未導入、未ログイン、空の discovery、失敗、タイムアウトではモデルを公開しない。ACP では SDK 認証、複数アカウント選択、利用量表示、`kiro_web_search`、ツール実行を提供しない（ツール権限は引き続き拒否）。

1. ACP 側では `kiro-cli` のログイン状態を確認する統合を登録する。未導入、未ログイン、失効、再ログイン、ログアウトを扱う。現行の IDC 認証フローとアカウント DB は SDK 側に保持し、ACP の認証情報へ自動変換しない。
2. `kiro-cli` が返すモデルを発見して OpenCode のプロバイダー定義に反映する。発見失敗時には最後の正常な一覧をどう扱うか、ログアウト時に一覧をいつ無効化するかを決める。固定モデル定義との差を確認し、未提供モデルを実行可能として表示しない。
3. 既存の複数アカウント選択、利用量表示、effort／thinking、ツール・画像、`kiro_web_search` の提供条件を機能ごとに確認する。ACP で同等性を確認できない機能は非表示または制限を明示する。

**通過条件:** 利用者が経路ごとの認証方法と機能差を確認でき、未ログイン・未対応モデルを選んだ際に原因を特定できる。

### 4. 模擬試験と回帰試験

**実装状態（2026-09-28）:** `src/__tests__/acp-phase4.test.ts` で、ACP 起動失敗、出力前・出力後の中断、長時間無通信、キャンセルを表す模擬結果を、再送せずそのまま言語モデルへ渡すことを確認する。`primary`、title、compaction、generate は同一の AISDK 経路を使うこと、異なる SDK を上書きしないこと、登録失敗時と二重の再読込 cleanup 時にリソースを一度だけ解放することも検証する。認証失効と discovery の失敗・タイムアウトはフェーズ3の `acp-auth`・`acp-discovery` テストで引き続き検証する。いずれも `kiro-cli`、認証情報、実推論、ACP 本文を使用しない。

- ACP 起動失敗、認証失効、モデル発見の遅延・失敗、出力前と出力後の切断、長時間無通信、キャンセル、ツール実行後の切断を模擬する。部分出力・ツール副作用がある呼び出しの自動再送は許可しない。
- `primary` に加え、title・compaction・generate でも ACP 経路を確認する。モデル変更、effort、連続リクエスト、プラグイン再読込、OpenCode サービス再起動時の資源解放を確認する。
- プロンプトや ACP 本文をログに出さないこと、ACP のツール操作が既存の許可設定を迂回しないことを試験する。
- 既存 SDK 経路の試験、`npm run typecheck`、`npm run build`、対象テスト、`git diff --check` を実行する。既存の無関係なテスト失敗は新規回帰と区別して記録する。

**通過条件:** 模擬故障と停止処理の試験が通り、SDK 経路にも新規回帰がない。

### 5. 限定的な実通信評価

**実施結果（2026-09-27 UTC）:** 利用者承認の下、隔離ディレクトリで `claude-sonnet-5` に短い固定の疎通確認を SDK／ACP 各1回送信した。SDK は正常終了（5,290 ms、最初の出力 5,129 ms）、ACP は正常終了（20,387 ms、最初の出力 11,703 ms、最終出力 20,192 ms）した。認証情報、入力本文、出力本文は記録しなかった。いずれも終了コードは 0 で、計測対象の標準エラーは 0 bytes だった。この1回の結果は ACP の基本接続が成立した証拠に限られ、断続的な `aborted` の解消、性能優位、ツール利用可否を証明しない。ACP の実行時刻帯に native HTTP フックのログも観測されたため、完全な経路分離の証明にも使わない。利用者判断により ACP を既定経路とし、SDK は明示的な互換経路として維持する。追加評価は隔離済みホスト設定と明示的な利用量上限の下で行う。

模擬試験を通過した後、利用者の了承を得て、隔離した設定で同一モデル・同程度の入力を SDK と ACP に少数回ずつ送る。エージェントは無断で推論を実行しない。両者の実行環境、モデル ID、開始・最終イベント・終了時刻、完了／中断、エラー種別を比較する。認証情報と本文は収集しない。

ACP のみ完了する場合は SDK 経路を重点調査する。両者とも失敗する場合はネットワーク、Kiro 側、OpenCode 側の共通条件も調べる。短い試験で一度成功しても、まれな `aborted` の解消が証明されたとは扱わない。実通信の回数と利用量の上限は実行前に利用者と決める。

**採用判断:** 利用者判断により ACP を既定経路とする。SDK は `transport: "sdk"` または `KIRO_TRANSPORT=sdk` により明示的に選択する互換経路として維持する。ツール権限と長時間・高負荷時の安定性は継続評価対象とする。

## 切り戻し

ACP は既定値とする。不具合時は設定を `sdk` に戻すか `KIRO_TRANSPORT=sdk` を指定してプラグインを再読み込みし、既存の Kiro アカウント DB をそのまま使う。ACP 登録と子プロセスが停止したことを確認する。SDK 経路・依存関係の削除は、別途の互換性判断まで行わない。

## 参照資料

- 現行: `src/plugin.ts`、`src/plugin/sdk-client.ts`、`src/core/request/request-handler.ts`、`src/core/request/response-handler.ts`。
- [OpenCode V2 プラグイン仕様](https://opencode.ai/v2/docs/build/plugins)。
- [Nacho 版 `v0.5.0-beta.5` の AISDK 実装](https://github.com/NachoFLizaur/opencode-kiro/blob/v0.5.0-beta.5/src/server/aisdk.ts)、[モデル発見](https://github.com/NachoFLizaur/opencode-kiro/blob/v0.5.0-beta.5/src/server/discovery.ts)、[検証済みバージョン](https://github.com/NachoFLizaur/opencode-kiro/blob/v0.5.0-beta.5/docs/COMPATIBILITY.md)。
- [tickernelz 版 `08f06b4` の既存 SDK 経路](https://github.com/tickernelz/opencode-kiro-auth/blob/08f06b4d74204df32133801c537428d78cea298f/src/core/request/request-handler.ts)。
