# spotify-display

Spotify で再生中の曲を表示し、再生を操作するための Web アプリ。
小型 HDMI ディスプレイ（横長の帯型を含む）にタッチ操作で使うことを想定している。

同じ画面が2通りの動かし方に対応する。

| | ローカル版 | Pages 版 |
|---|---|---|
| 実行 | Flask（`app.py`） | GitHub Pages（静的配信のみ） |
| 認証 | サーバ側で保持（`token_store.json`） | ブラウザ内で PKCE（localStorage） |
| Client Secret | 使う | 使わない |
| 用途 | Raspberry Pi の専用機 | スマホや外出先から |

フロントエンドは `docs/` の一式を両者で共用する。起動時に `api/mode` を1回叩き、応答があればローカル版、404 なら Pages 版と判定して動作を切り替える。

**Spotify Premium が必須。** 再生制御の API は Premium アカウントでないと動作しない。

---

## 画面

タブは3つ。帯型ディスプレイ（横縦比 3:1 以上）では左端に縦並び、通常の画面では上部に横並びになる。

### NOW（再生中）

ジャケット、アルバム情報、曲名のスクロール表示、再生時間、前へ / 再生・一時停止 / 次へ のボタン、再生元（プレイリスト等）の名前。

一時停止中も曲の情報は表示したままになる。本当に何も再生していないときだけ「再生中のコンテンツはありません」に変わる。

再生元は他の端末から再生を始めた場合も表示される。Spotify が返す `context` を使っているため、このアプリから再生したかどうかは問わない。

### LIST（プレイリスト）

プレイリスト一覧 → 曲一覧 → タップで再生、の2階層。再生中のプレイリストは一覧で強調表示される。

「ランダム演奏」を ON にすると、開始する曲を抽選したうえでシャッフル再生する。

### SET（設定）

- **一覧の表示** — テキストのみ / ジャケットのみ / 両方
- **スクロール方向** — 縦 / 横
- **再生する端末** — 自動（前回再生した端末）または手動指定

設定はブラウザの localStorage に保存される。端末を手動で選ぶと、再生中であっても停止状態で転送されるため、2か所から同時に音が出ることはない。

---

## セットアップ

### 1. Spotify のアプリ登録

[Developer Dashboard](https://developer.spotify.com/dashboard) でアプリを作り、Redirect URIs に次の2つを登録する。

```
http://127.0.0.1:5000/callback
https://<ユーザー名>.github.io/<リポジトリ名>/
```

`localhost` 表記は Spotify 側で拒否されるため、ループバックは `127.0.0.1` を使う。Pages 版の URI は末尾のスラッシュまで完全一致が必要。

### 2. .env を用意する

リポジトリ直下に `.env` を作る（Git 管理外）。

```
SPOTIFY_CLIENT_ID=<Client ID>
SPOTIFY_CLIENT_SECRET=<Client Secret>
SPOTIFY_REDIRECT_URI=http://127.0.0.1:5000/callback
FLASK_SECRET_KEY=<ランダムな文字列>
```

`FLASK_SECRET_KEY` は次のコマンドで生成できる。

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

任意で次の2つも指定できる。

| 変数 | 既定値 | 説明 |
|---|---|---|
| `FLASK_HOST` | `127.0.0.1` | `0.0.0.0` にすると同一 LAN の他端末から開ける |
| `FLASK_DEBUG` | `1` | `0` でデバッグモードを無効化。Pi では `0` にする |

再生制御 API を持つため、既定では外部からの接続を受け付けない。

### 3. 起動

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

http://127.0.0.1:5000 を開き、初回は Spotify にログインする。以降は `token_store.json` に保存され、自動で更新される。

### 4. Pages 版を公開する（任意）

`docs/config.js` の `clientId` に Client ID を書く。PKCE では Client ID は公開前提の値なので、コミットして問題ない（Client Secret は書かない）。

GitHub の Settings → Pages で、Source を `Deploy from a branch`、Branch を `main` の `/docs` に設定する。

---

## 構成

```
app.py              Flask。認証、トークン管理、Spotify API の中継
requirements.txt
.env                認証情報（Git 管理外）
token_store.json    ローカル版のトークン（Git 管理外）
docs/               フロントエンド一式。GitHub Pages の公開元も兼ねる
├── index.html
├── style.css       帯型レイアウトは @media (min-aspect-ratio: 3/1) で切り替え
├── config.js       Pages 版の Client ID
├── source.js       取得元の抽象化。ローカル版と Pages 版の差をここで吸収する
├── devices.js      再生先の端末の決定とフォールバック
├── app.js          NOW 画面の描画と再生制御
├── playlists.js    LIST 画面
├── settings.js     SET 画面
├── fonts/
├── .nojekyll       GitHub Pages の Jekyll 処理を無効化する
└── design.md       初期バージョンの設計メモ
```

`source.js` が実行環境の差を吸収しているので、`app.js` / `playlists.js` / `settings.js` はローカル版か Pages 版かを意識しない。

### ローカル版の API

| パス | 用途 |
|---|---|
| `GET /api/mode` | 動作モードの判定（Pages では 404） |
| `GET /api/now-playing` | 再生中の曲と再生元 |
| `POST /api/command/<play\|pause\|next\|previous>` | 再生制御 |
| `POST /api/play` | プレイリスト等の再生開始 |
| `POST /api/shuffle` | ランダム再生の切り替え |
| `GET /api/playlists` | プレイリスト一覧 |
| `GET /api/playlists/<id>/items` | 曲一覧 |
| `GET /api/devices` | 再生先の端末一覧 |
| `POST /api/transfer` | 再生先の切り替え |

### 使用しているスコープ

```
user-read-currently-playing
user-modify-playback-state
playlist-read-private
playlist-read-collaborative
user-read-playback-state
```

スコープを変更したら再認証が必要になる。ローカル版は `token_store.json` を削除、Pages 版は localStorage の `spotify_display_tokens` を削除してからログインし直す。

---

## 仕様上の制約

Spotify API 側の都合で、どうにもならない点がいくつかある。

**フォローしているだけのプレイリストは曲一覧を取得できない。** 自分が所有または共同編集しているプレイリスト以外は 403 が返る。一覧には表示されるが、開くと理由を表示して「まるごと再生」だけを提示する。再生自体はできる。

**Spotify 製プレイリストは名前も取得できない。** Discover Weekly のような自動生成プレイリストはメタデータの取得自体が不可。再生元の表示は種別だけになる。

**キー（KEY）は表示されない。** Audio Features のエンドポイントが提供終了になったため。取得に失敗しても表示を隠すだけで、動作には影響しない。

**再生には操作対象の端末が必要。** Spotify Connect の仕組み上、どこかで Spotify アプリが動いていないと再生を開始できない。本アプリは端末一覧から自動で選び直す処理を持つが、どの端末でもアプリが起動していない場合は再生できない。Raspberry Pi 自身を再生端末にする方法は [RASPBERRY-PI.md](RASPBERRY-PI.md) を参照。

**取得件数の上限。** プレイリスト500件、1プレイリストあたり500曲まで。`app.py` の `MAX_PLAYLISTS` / `MAX_PLAYLIST_ITEMS` と `docs/source.js` の同名の定数で変更できる。

---

## Raspberry Pi へのデプロイ

[RASPBERRY-PI.md](RASPBERRY-PI.md) を参照。
