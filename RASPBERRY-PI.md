# Raspberry Pi へのデプロイ

Raspberry Pi に設置し、HDMI ディスプレイへ全画面表示する手順。

想定する構成は次のとおり。

```
Raspberry Pi
├── Flask（127.0.0.1:5000）      ← systemd で自動起動
└── Chromium（kiosk モード）      ← 自分自身の 127.0.0.1:5000 を表示
        ↓ HDMI
   小型ディスプレイ（タッチ対応）
```

Flask は自分自身からしか見えないので、外部に再生制御を晒さない。

---

## 1. アプリを配置する

```bash
cd ~
git clone https://github.com/<ユーザー名>/<リポジトリ名>.git spotify-display
cd spotify-display
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`.env` は Git 管理外なので、Pi 側で新たに作る。内容は README のセットアップを参照。Pi では次の2行を加える。

```
FLASK_DEBUG=0
FLASK_HOST=127.0.0.1
```

`FLASK_DEBUG=0` は必須。デバッグモードのままだと、例外発生時に任意のコードを実行できるデバッガが露出する。

---

## 2. 初回ログイン

トークンの取得だけはブラウザが必要になる。Pi のデスクトップで一度だけ行う。

```bash
source .venv/bin/activate
python app.py
```

Chromium で http://127.0.0.1:5000 を開き、Spotify にログインする。`token_store.json` が作られたら `Ctrl+C` で止めてよい。

---

## 3. systemd で自動起動する

`/etc/systemd/system/spotify-display.service` を作る。

```ini
[Unit]
Description=Spotify Display
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/spotify-display
Environment="FLASK_DEBUG=0"
Environment="FLASK_HOST=127.0.0.1"
ExecStart=/home/pi/spotify-display/.venv/bin/python /home/pi/spotify-display/app.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` は必ず指定する。`token_store.json` を相対パスで読み書きしているため、これがないと別の場所を見に行く。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spotify-display
systemctl status spotify-display
journalctl -u spotify-display -f
```

---

## 4. Chromium を kiosk モードで起動する

`~/.config/autostart/spotify-display.desktop` を作る。

```ini
[Desktop Entry]
Type=Application
Name=Spotify Display
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --force-device-scale-factor=1.2 --check-for-update-interval=31536000 http://127.0.0.1:5000
X-GNOME-Autostart-enabled=true
```

マウスカーソルを消したい場合は `unclutter` を入れる。

```bash
sudo apt install unclutter
```

### スケールファクタの決め方

`--force-device-scale-factor` の値は、ディスプレイの画素密度に応じて調整する。この画面は 800×480 / 5インチ（約187 PPI）を基準に作られている。

| ディスプレイ | 画素密度 | 目安 |
|---|---|---|
| 800×480 / 5インチ | 約187 PPI | 1.0 |
| 1280×720 / 5.2インチ | 約282 PPI | 1.6 |
| 1920×480 / 8.8インチ | 約229 PPI | 1.2 |

文字が小さすぎる場合は値を上げる。実機で見比べて決めるのが早い。

横縦比が 3:1 以上のディスプレイでは、帯型向けのレイアウトに自動で切り替わる。

---

## 5. Pi 自身を再生端末にする（任意）

Spotify Connect の仕組み上、どこかで Spotify アプリが動いていないと再生を開始できない。スマホの Spotify を閉じていると、リロード直後に再生ボタンが効かないことがある。

Pi 自身を Spotify Connect の受信側にすると、この問題がなくなる。ディスプレイと再生機が1台に収まる。

- **librespot** — 本体。Spotify Connect の非公式クライアント
- **Raspotify** — librespot を systemd サービスとして包んだ Debian パッケージ。ヘッドレス環境向け
- **spotifyd** — デスクトップ環境向け。Chromium を動かす本構成にはこちらが合う

導入すると SET タブの端末一覧に現れ、再生先として選べるようになる。本アプリ側の変更は不要。

**注意点**

- Spotify Premium が必要
- Pi に音声出力（HDMI 音声、イヤホンジャック、USB DAC 等）とスピーカーが必要
- librespot は解析により実装された非公式クライアントであり、作者自身が Spotify に禁止されている可能性が高いと明記している。個人の私的利用に限ること。公開の場や商用での使用は想定されていない

---

## 運用上の注意

**リフレッシュトークンの期限。** Spotify のリフレッシュトークンには有効期限が設けられている。失効すると再ログインが必要になる。失効時はログイン画面に戻る作りになっているので、Pi のディスプレイでログインボタンを押して認証し直す。

**ネットワーク断。** Spotify に到達できない場合は画面にその旨が表示される。復旧すれば自動で再取得する。

**更新のしかた。**

```bash
cd ~/spotify-display
git pull
sudo systemctl restart spotify-display
```

フロントエンドだけの更新なら Chromium のリロード（`F5`）で足りる。`app.py` を更新した場合はサービスの再起動が必要。

**ログの確認。**

```bash
journalctl -u spotify-display -n 50
```

正常なアクセスログは抑制してあるので、出るのは 4xx / 5xx と警告だけになる。
