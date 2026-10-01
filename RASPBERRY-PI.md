# Raspberry Pi へのデプロイ

Raspberry Pi に設置し、小型ディスプレイへ全画面表示する手順。

想定する構成は次のとおり。

```
Raspberry Pi
├── Flask（127.0.0.1:5000）      ← systemd で自動起動
└── Chromium（kiosk モード）      ← 自分自身の 127.0.0.1:5000 を表示
        ↓ DSI または HDMI
   小型ディスプレイ（タッチ対応）
```

Flask は自分自身からしか見えないので、外部に再生制御を晒さない。

---

## 0. ディスプレイを繋ぐ

HDMI のディスプレイなら挿すだけでよい。DSI のディスプレイは組み立てと
給電の考え方が違うので、ここで触れておく。

### DSI ディスプレイの場合

ここで前提にしているのは Freenove の 5インチ（800×480 IPS、静電容量式タッチ、
FNK0078）。接続は**リボンケーブル1本だけ**で、USB ケーブルは要らない。

1. 付属の真鍮スペーサー4本をディスプレイ基板に立てる
2. リボンケーブルを Pi の DSI コネクタとディスプレイの MIPI DSI コネクタに挿す
3. ネジ4本で Pi を固定する
4. 電源を入れる。数秒で表示される

ドライバの導入も `config.txt` の編集も要らない。

**電源は Pi の GPIO ヘッダから取る。** 基板上のコンタクトピン（スプリング式の
接点）が、固定したときに GPIO の 5V / GND に当たる仕組み。手順3で位置がずれる
と映らないので、ネジを締める前に接点の位置を見ること。

この給電方式のため、**Pi の電源は 5V 3A の microUSB を用意する。** Pi 3B 単体の
推奨は 2.5A だが、ディスプレイが 0.5A 前後を同じ 5V から引くので余裕がなくなる。
足りているかは起動後に確認できる。

```bash
vcgencmd get_throttled
```

`throttled=0x0` なら正常。`0x50000` のような値は低電圧が起きた履歴を表す。
ケーブルが細いと、アンペア数が足りていても電圧降下でここに出る。

LED マトリクス版（[led/README.md](led/README.md)）と併用する場合、DSI は専用
コネクタなので信号線はぶつからない。ただし**給電の接点が GPIO ヘッダに当たる。**
Bonnet も同じヘッダに挿すため、物理的に共存できるかは現物で確認すること。

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

### 画面を回転させる

Raspberry Pi 3 / 2 / 1 は traditional graphics mode で動く。Pi 4 以降の FKMS
モードとは設定場所が違うので、Pi 4 向けの記事をそのまま真似ても効かない。

`/boot/config.txt`（Bookworm 以降は `/boot/firmware/config.txt`）の末尾に追記して
再起動する。

```
display_lcd_rotate=0
```

| 値 | 向き |
|---|---|
| `0` | 標準 |
| `1` | 90° 時計回り |
| `2` | 180° |
| `3` | 270° 時計回り |
| `0x10000` | 左右反転 |
| `0x20000` | 上下反転 |

画面を回したら**タッチの向きも合わせる。** 揃っていないと、押した場所と反応する
場所がずれる。`/usr/share/X11/xorg.conf.d/40-libinput.conf` のタッチスクリーンの
`InputClass` に `Option "CalibrationMatrix"` を足す。

```
Section "InputClass"
        Identifier "libinput touchscreen catchall"
        MatchIsTouchscreen "on"
        Option "CalibrationMatrix" "1 0 0 0 1 0 0 0 1"
        MatchDevicePath "/dev/input/event*"
        Driver "libinput"
EndSection
```

| 画面の向き | CalibrationMatrix |
|---|---|
| 標準 | `1 0 0 0 1 0 0 0 1` |
| 90° 時計回り | `0 1 0 -1 0 1 0 0 1` |
| 180° | `-1 0 1 0 -1 1 0 0 1` |
| 270° 時計回り | `0 -1 1 1 0 0 0 0 1` |
| 左右反転 | `-1 0 1 0 1 0 0 0 1` |
| 上下反転 | `1 0 0 0 -1 1 0 0 1` |

180° だけは、画面とタッチをまとめて回す書き方もある。`config.txt` の
`dtoverlay=vc4-kms-v3d` をコメントアウトしたうえで、末尾に2行足す。

```
display_rotate=2
lcd_rotate=2
```

### バックライトの明るさ

Freenove の基板には側面にボタンがある。押すたびに 10% 上がり、100% の次は 10% に
戻る。長押しで消灯、もう一度押すと元の明るさに戻る。常設するならこれが一番手軽。

コマンドでも変えられるが、`config.txt` の `dtoverlay=vc4-kms-v3d` をコメントアウト
する必要がある。kiosk の表示に影響が出ないか確かめてから使うこと。

```bash
sudo chmod 777 /sys/class/backlight/rpi_backlight/brightness   # 起動ごとに1回
echo 128 > /sys/class/backlight/rpi_backlight/brightness       # 0〜255
```

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

**リフレッシュトークンの期限。** Spotify のリフレッシュトークンには有効期限がある。失効すると再ログインが必要になる。

失効を検知すると `token_store.json` を自動で破棄してログイン画面に戻るので、Pi のディスプレイでログインボタンを押して認証し直せばよい。エラー画面のまま固まることはない。

ただしタッチだけで完結しない点に注意する。Spotify の承認画面ではメールアドレスとパスワードの入力が必要になる場合があり、キーボードを繋ぐか、画面キーボードを用意しておくと詰まらない。

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
