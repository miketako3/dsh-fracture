# dsh-self-harness

DeepSeek Harness（DSH）のための自己改善ループを、DSH プラグインとして配布する。
エージェントは自分のセッション履歴を読み、ハーネスの弱点を診断し、サブエージェントに改善案を書かせ、**同じタスクを2回**実行して比較する。
現行ハーネスでの結果と候補を入れた結果を並べ、それから採用を決める。

[English](README.md) | 日本語

```text
self_diagnose ──► self_propose ──► self_probe ──► self_adopt
     │                │                 │              │
 セッションログ      候補の生成         2回の実行      バンドルと
   の証拠         rows とファイル       の比較        教訓
```

実行中のプロファイルを勝手に書き換えることはない。
各ステップはファイルを書くだけで、読むのも差分を取るのも削除するのも人間ができる。
ホストコードの導入だけは人間の承認を経由する。

## なぜこの形か

DSH のエージェントは Cordis プラグインの行の並びで組み立てられる。
つまりハーネスは**データ**であり、プロンプトの一節、スキルディレクトリ、ツール、ポリシーの追加は行の編集になる。
この性質のおかげで、2つのハーネスを同時に持ち、同じタスクを両方で走らせて比べる、という操作が安くなる。

[Harness²](https://github.com/google-research/harness2)（Google Research、Apache-2.0）から借りたのは3点。

- **内省より対比**。ハーネスの変更は、モデルに感想を聞いて判断しない。同じタスクを新旧のハーネスで走らせて判断する。
- **証拠つきの教訓の蓄積**。採用のたびに、きっかけ、変更、試行の判定、根拠を `lessons.md` に追記する。
- **弱いレバーから順に上げる**。プロンプト、スキル、スクリプト、ツール、フックの順。

Harness² の8ファイル構成のハーネスは採用しない。
DSH の行リストがすでにその構成であり、ローダーも付いている。

## 導入

```bash
dsh plugin --profile web add dsh-self-harness
```

セッションを再起動すると、5つのツールが登録される。
設定なしで動く。

設定はプロファイルのパッチに書く。

```yaml
- id: self-harness
  name: dsh-self-harness
  config:
    baseDir: .dsh/self-harness      # 候補、実行、教訓の置き場所
    provider: spawn                 # 提案役とプロセス内試行のサブエージェント
    dshCommand: dsh                 # プロセス外試行で使う実行ファイル
    profile: headless               # プロセス外試行が起動するプロファイル
    timeoutMs: 900000               # 子エージェント1回の上限
    isolate: true                   # 試行のたびにワークスペースを複製する
    maxSessions: 12                 # 診断が読むセッション数
    packagePrefix: dsh-self-harness-candidate
    profilePatch: ""                # self_adopt が追記してよいプロファイルパッチ
```

## 使い方

対象のリポジトリでセッションを開き、次のように頼む。

```text
self_diagnose を実行して、いちばん強い指摘を選んでから
「ページネーションモジュールにテストを足す」というタスクで self_propose して。
採用の前に必ず self_probe で試行して。
```

自分で1ステップずつ動かすこともできる。

| ツール | 役割 |
| --- | --- |
| `self_diagnose` | 直近のセッションを読み、ツールの失敗率、同一ファイルの読み直し、拒否された承認、圧縮の頻度、メッセージ評価を指摘として順位づけする。スナップショットを保存する。 |
| `self_propose` | 提案役のサブエージェントに `candidates/<id>/candidate.json` と、必要なら `skills/` や `plugin/` を書かせる。受理の前に必ず検査する。 |
| `self_probe` | 現行ハーネスと候補で同じタスクを実行し、ワークスペースを分けたうえで軌跡と決定論的チェックを比較する。`runs/<id>/report.md` を書く。 |
| `self_adopt` | 試行済みの候補を導入可能なバンドルにし、教訓を追記する。`improved` 以外は `force` なしでは拒否する。 |
| `self_status` | 候補の一覧と、直近の試行の判定を返す。 |

候補はわざと小さい。

```json
{
  "id": "read-before-edit",
  "title": "既存ファイルの編集前に読み取りを必須にする",
  "rationale": "開いていないファイルへの編集が9回中6回失敗した。",
  "finding": "tool-failures:edit",
  "lever": "prompt",
  "verify": "pnpm test",
  "rows": [
    {
      "id": "system-prompt",
      "name": "@deepseek-ai/dsh-system-prompt",
      "config": { "personaSuffix": "編集の前に必ずファイルを読むこと。" }
    }
  ]
}
```

行は最大3つまでとする。
効果を候補に帰属できるようにするため。

## 書き出されるもの

```text
.dsh/self-harness/
├── diagnoses/2026-10-20T02-11-08-471Z.json   # 診断のスナップショット
├── candidates/read-before-edit/
│   ├── candidate.json                        # 正本
│   ├── cordis.patch.yml                      # 生成物。人間が読む用
│   ├── skills/…, plugin/…                    # 必要なら
│   └── bundle/                               # self_adopt が作る
├── runs/2026-10-20T02-14…-read-before-edit/
│   ├── baseline/, changed/                   # ワークスペースの複製
│   ├── result.json
│   └── report.md                             # 両方の軌跡、判定、注意書き
└── lessons.md                                # 追記のみ
```

データベースに隠すものはない。
ディレクトリを消せばループの記憶も消える。

## 安全側の設計

自分を動かしているハーネスをエージェント自身が編集するのだから、危険を前提に作る。

- **承認の面は編集させない**。`dsh-user-approval`、`dsh-sandbox-policy`、`plugin_manager`、`dsh-self-harness` に触れる候補は、保存の前に拒否する。
- **検証していないコードを判定側のプロセスに載せない**。プラグインを含む候補は、別の `dsh` プロセスで生成パッチを与えて試行する。プロセス内で走るのは、既に読み込まれたモジュールを参照する行だけ。
- **採用は導入ではない**。バンドルと手順を出力するだけにし、導入は `dsh plugin add` か `plugin_manager` に任せる。その呼び出しごとの承認が人間の関門になる。
- **試行は隔離する**。左右それぞれにワークスペースを複製し、`node_modules` と `.git` は複製せずシンボリックリンクにする。
- **巻き戻しは引き算**。バンドルか行を消せば元に戻る。ほどく状態がない。

## 既知の限界

- 試行は**1タスク1組**の観測にすぎない。`improved` は「このタスクでは良かった」を意味する。採用の前に、試行が触れていないタスクでもう一度走らせる。
- `verify` がない候補の判定は `needs-review` になる。両方の軌跡を見せて、人間かルーブリックが決める。これを証拠と取り違えないこと。
- 診断が見るのはセッションに記録された事実だけ。静かに失敗するツールや、遅さだけが問題の弱点は、指摘として現れない。
- プロセス外試行には `PATH` の通った `dsh` と、対話なしで起動できるプロファイルが要る。ヘッドレスには承認の応答者がいないため、承認が要るタスクは設計どおり失敗する。
- コストは候補あたり2回のロールアウトと1回の診断。候補は小さく保つ。

## 先行研究

- [Harness²](https://github.com/google-research/harness2)。編集可能なハーネスの面を通した再帰的なエージェント構成。対比による評価、教訓の蓄積、弱いレバーからの引き上げはここから来ている。本プロジェクトが借りたのは思想で、コードではない。
- Cordis と DSH の合成モデル。ハーネスを宣言的な行リストにしたのはこの設計のおかげ。

## 開発

```bash
npm install
npm run typecheck
npm test
npm run build
```

`src/diagnose.ts` と `src/trajectory.ts` は純粋で、ホストなしで試験できる。
`src/probe.ts`、`src/propose.ts`、`src/adopt.ts` がループを組み立て、`src/index.ts` がツールを登録する。

設計の判断と、Harness² を同梱しなかった理由は [docs/DESIGN.md](docs/DESIGN.md) にある。

## ライセンス

MIT。[LICENSE](LICENSE) を参照。
