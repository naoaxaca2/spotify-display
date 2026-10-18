# Spotify Display — 設計ドキュメント

最終更新: 2026-04-12

---

## 1. 概要

Spotify で再生中の楽曲情報をリアルタイムに取得し、小型ディスプレイへ全画面表示する専用デバイス向けアプリケーション。
バックエンドを Flask（Python）、フロントエンドを素の HTML / CSS / JS で構成し、Mac での開発確認後に Raspberry Pi へそのままデプロイできる設計。

---

## 2. システム構成

```
スマートフォン（Spotify 再生）
        ↓ Spotify Web API
Raspberry Pi（Flask アプリ）
        ↓ HTTP localhost
Chromium（全画面 kiosk モード）
        ↓
HDMI ディスプレイ
```

---

## 3. ハードウェア構成

| コンポーネント | 内容 |
|---|---|
| マイコン | Raspberry Pi Zero 2 W |
| ディスプレイ | 4.3〜5インチ HDMI LCD |
| 接続 | mini HDMI |
| 電源 | 5V / 2A USB |

---

## 4. ソフトウェア構成

| レイヤ | 技術 |
|---|---|
| バックエンド | Python 3 / Flask 3.1 |
| 認証 | Spotify OAuth 2.0 Authorization Code Flow |
| フロントエンド | HTML5 + CSS3 + Vanilla JS |
| フォント（欧文・数字） | Bebas Neue（`static/fonts/` に同梱・自己ホスト） |
| フォント（日本語・楽曲名） | M PLUS 2（Google Fonts CDN・weight 700/800） |
| 表示 | Chromium（kiosk モード） |

---

## 5. ディレクトリ構成

```
spotify-display/
├── app.py                  # Flask バックエンド
├── requirements.txt        # Python 依存パッケージ
├── .env                    # 認証情報（Git 管理外）
├── token_store.json        # トークン保存（初回ログイン後に自動生成）
├── templates/
│   └── index.html          # メイン画面テンプレート
├── static/
│   ├── style.css           # スタイルシート
│   └── app.js              # フロントエンドロジック
└── docs/
    └── design.md           # 本ドキュメント
```

---

## 6. 画面レイアウト

```
┌─────────────────────────────────────────┐
│ [アルバムアート]  ALBUM                  │  ← 1段目：アルバム情報
│    96×96px       アルバム名              │
│                  2024 / 03 / 15          │
├─────────────────────────────────────────│
│ NOW PLAYING ←バッジ                     │  ← 区切り線 + ステータスバッジ
│  アーティスト名 - 曲名  ←右から左へ流れる│  ← マーキーテキスト
├─────────────────────────────────────────│
│  KEY  A♯ Major      TIME  3:45          │  ← 3段目：楽曲詳細
└─────────────────────────────────────────┘
```

### 各エリアの詳細

| エリア | 内容 | 備考 |
|---|---|---|
| 1段目・左 | アルバムアート | 96×96px、角丸12px |
| 1段目・右 | アルバムタイプバッジ / アルバム名 / リリース日 | Podcast 時は非表示 |
| 2段目・上 | ステータスバッジ（NOW PLAYING など） | Bebas Neue、枠付き |
| 2段目・中 | 楽曲情報マーキー（アーティスト名 - 曲名） | 右→左スクロール |
| 3段目 | KEY（調性）/ TIME（演奏時間） | 取得不可の場合は非表示 |

---

## 7. Spotify API 利用

### 使用エンドポイント

| エンドポイント | 用途 |
|---|---|
| `GET /v1/me/player/currently-playing` | 再生中の楽曲情報取得 |
| `GET /v1/audio-features/{track_id}` | 調性（キー）取得 |
| `POST /api/token` | アクセストークン取得・更新 |

### 必要スコープ

```
user-read-currently-playing
```

### `/api/now-playing` レスポンス仕様

再生中（track）:
```json
{
  "is_playing": true,
  "type": "track",
  "track_id": "spotify_track_id",
  "title": "曲名",
  "artists": "アーティスト名",
  "album": "アルバム名",
  "album_type": "album | single | compilation",
  "release_date": "2024-03-15",
  "image_url": "https://...",
  "display_text": "アーティスト名 - 曲名",
  "duration": "3:45",
  "key": "A♯ Major"        // 検出できない場合はフィールドなし
}
```

停止中:
```json
{
  "is_playing": false
}
```

未認証:
```json
{
  "error": "not authenticated",
  "login_url": "/login"
}
```

### キー表記

Pitch Class（0〜11）を音名に変換。`key: -1` の場合は非表示。

```
0=C  1=C♯  2=D  3=D♯  4=E  5=F  6=F♯  7=G  8=G♯  9=A  10=A♯  11=B
mode: 0=minor  1=Major
```

---

## 8. 認証フロー

```
ブラウザ → /login → Spotify 認可画面
                            ↓ 認可コード
         /callback ← Spotify
              ↓ コード → トークン交換（POST /api/token）
         token_store.json に保存
              ↓
         / へリダイレクト（ログイン済み状態）
```

トークンは `token_store.json` にファイル保存。
有効期限 60 秒前に `refresh_token` で自動更新。

---

## 9. マーキーアニメーション仕様

`requestAnimationFrame` による JS 制御（CSS アニメーション不使用）。

| 項目 | 値 |
|---|---|
| スクロール速度 | 90 px/s（`SCROLL_SPEED` 定数で調整可） |
| 開始位置 | コンテナ右端の外（`translateX(containerW)`） |
| 終了位置 | テキスト全体が消えた後、コンテナ幅の 30% 分余分にスクロール |
| ループ | 終点到達で開始位置へ即座にリセット |
| テキスト変更時 | 同一テキストなら何もしない（5秒ポーリング対策） |
| リサイズ対応 | 毎フレーム `containerW` / `textW` を再取得するため自動対応 |

---

## 10. フロントエンドの状態管理

5秒ごとに `/api/now-playing` をポーリング。
表示状態は以下の4パターン:

| 状態 | ステータスバッジ | バッジ色 |
|---|---|---|
| 再生中（track） | NOW PLAYING | 緑 #1ed760 |
| 再生中（podcast） | Podcast | 緑 #1ed760 |
| 停止・一時停止 | Paused / Not Playing | グレー |
| エラー / 未認証 | 取得エラー / ログインが必要です | 赤 #ff6b6b |

---

## 11. セキュリティ

- 認証情報は `.env` で管理（Git 管理外）
- `token_store.json` は Raspberry Pi 上では `chmod 600` を適用
- ネットワーク公開なし（LAN 限定ローカル運用）

```bash
chmod 600 token_store.json
```

---

## 12. セットアップ手順

### Spotify Developer Dashboard

1. https://developer.spotify.com/dashboard でアプリを作成
2. Redirect URI を登録:
   - Mac 開発用: `http://127.0.0.1:5000/callback`
   - Raspberry Pi 用: `http://raspberrypi.local:5000/callback`（必要に応じて）

### `.env` 設定

```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:5000/callback
FLASK_SECRET_KEY=任意のランダム文字列
```

### Mac での起動

```bash
cd spotify-display
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

ブラウザで `http://127.0.0.1:5000` を開き「Spotify でログイン」。

### Raspberry Pi へのデプロイ

実機の手順は [`../RASPBERRY-PI.md`](../RASPBERRY-PI.md) に分けた。ここに
書いてあった手順は古くなっていたので、重複を避けて一本化している
（`chromium-browser` は現在の Raspberry Pi OS には無く `chromium`、
ユーザー名も `pi` 固定ではない）。

LED マトリクス版は [`../led/README.md`](../led/README.md)。

---

## 13. 自動起動設定（systemd）

[`../RASPBERRY-PI.md`](../RASPBERRY-PI.md) の「systemd で自動起動する」を
参照。LED 版のユニットは [`../led/README.md`](../led/README.md) の
「自動起動」にある。

---

## 14. 今後の拡張候補

| 機能 | 概要 |
|---|---|
| MusicBrainz 連携 | ISRC を使った作詞・作曲・プロデューサークレジット表示 |
| 時計表示 | 非再生時のスクリーンセーバー代わり |
| 天気情報 | 外部 API 連携 |
| テーマ切替 | ジャンルや時間帯による配色変化 |
| 再生位置バー | `progress_ms` を使ったプログレスバー表示 |
