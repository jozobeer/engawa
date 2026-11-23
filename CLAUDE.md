# Engawa

Arc ブラウザから Chrome へ移行するための、Arc 風サイドパネル拡張 (Manifest V3、依存ライブラリなし、バニラ JS)。
ユーザーは Arc の「タブが増えない」「小さな使い勝手」を重視する。変更の判断は常に「Arc ならどう振る舞うか」を基準にする。

## 使い方 (開発)

- Node.js は mise 管理 (`mise exec node@lts -- node ...`)。シェルに `mise activate` が無い環境では `node` が PATH に無い
- 機能の仕様と判断の経緯は `README.md` に書く。設計上の決まりは `.claude/rules/` にある
- 置き場は ghq 配置 (`$(ghq root)/github.com/jozobeer/engawa`)。Chrome はこのディレクトリを直接「パッケージ化されていない拡張」として読み込んでいて、拡張 ID はこのパスから決まるので、読み込んだ後は移動・改名しない。リモートは GitHub の `jozobeer/engawa`

## 検証 (変更したら必ず)

```sh
mise exec node@lts -- node --check <変更した .js>
mise exec node@lts -- node scripts/check-i18n.mjs        # 翻訳キーの整合性 (0 error 必須)
mise exec node@lts -- node scripts/test-arc-import.mjs   # Arc 読み込み
mise exec node@lts -- node scripts/test-color.mjs        # 代表色
mise exec node@lts -- node scripts/test-layout.mjs       # グリッドの列数
python3 scripts/e2e/<suite>.py "$PWD"                    # ヘッドレス Chrome の E2E (下記)
```

E2E は使い捨てプロファイルのヘッドレス Chrome を `--remote-debugging-pipe` で起動する (`scripts/e2e/cdp.py`)。
サンドボックス内では Chrome が起動できないので、サンドボックス外で実行する。普段使いの Chrome には触れない。
`e2e.py` / `e2e_refresh.py` / `e2e_owned.py` / `e2e_today.py` は github.com への接続が必要。`e2e_reorder.py` / `e2e_pinned.py` / `e2e_dnd.py` / `e2e_pr_tabs.py` / `e2e_split.py` / `e2e_split_items.py` / `e2e_appearance.py` / `e2e_settings_sync.py` は不要 (`e2e_split.py` と `e2e_split_items.py` は Chrome 155 以降の分割表示 API を使う。後者は Part を選べる: `python3 scripts/e2e/e2e_split_items.py "$PWD" B C`)。E2E は 1 本ずつ順に流す (並行すると遅くなり、タイミング系が落ちる)。
UI を変えたら、該当するスイートを全部通してからコミットする。新機能には E2E を足す。

## 注意点

クラシックスクリプトなので、各ファイルのトップレベル関数はグローバル。他ファイルの `let` はトップレベルで参照しない (init 以降の関数内でのみ)。

## コミット

- 日本語で、何をなぜ変えたかを箇条書きで。レビューで直した場合はその旨を書く
- 作者情報はこのリポジトリのローカル git 設定 (`git config user.name` / `user.email`) に入れてある。CLAUDE.md などの追跡ファイルにメールアドレスを書かない
- GitHub (origin) への push はユーザーが明示的に頼んだときだけ。勝手に push しない
