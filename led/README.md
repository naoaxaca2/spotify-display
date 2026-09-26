# LED マトリクス版

再生中の曲名とアーティスト名を、HUB75 の RGB LED マトリクスパネルに表示する。
ブラウザも画面も使わない。Web 版とは独立して動くが、**認証情報は共用する**。

```
Raspberry Pi
└── main.py  ← systemd で自動起動
        ↓ Adafruit RGB Matrix Bonnet
   64×32 LED マトリクスパネル
```

Web 版（`app.py` / `docs/`）には一切手を入れていない。GitHub Pages は `docs/`
から配信されるので、このディレクトリを足しても Pages 版は影響を受けない。

---

## 表示

上段に曲名（白）、下段にアーティスト名（緑）。それぞれ幅に収まらなければ
横スクロールする。2行は独立して動くので、短いほうは止まったままになる。

再生していないときは「停止中」、未ログインや通信不良のときはその旨を、
1行で大きく出す。この2つは画面に収まるサイズが選ばれるのでスクロールしない。

漢字は 14px で表示される。**ビットマップフォントではなく TTF を
アンチエイリアス付きで描画している。** パネルはフルカラーなので、
中間調がそのまま明るさとして出て、画数の多い字が潰れにくい。

---

## 必要なもの

| | |
|---|---|
| パネル | HUB75 の 64×32 RGB LED マトリクス（P3 / P4 など） |
| 変換基板 | Adafruit RGB Matrix Bonnet（品番 3211） |
| 本体 | 40ピン GPIO ヘッダを持つ Raspberry Pi（Zero 2 W / 3 / 4 / 5） |
| 電源（パネル） | 5V 4A、DCプラグ 外径5.5mm / 内径2.1mm / センタープラス |
| 電源（本体） | Pi の推奨値に従う。Zero 2 W なら Bonnet から給電できる |

Bonnet の DC ジャックに AC アダプタを挿し、ネジ端子台にパネル付属の電源
ケーブル（赤黒・フォーク端子）を留める。データは付属のリボンケーブルで
Bonnet の 16ピン IDC ヘッダとパネルの HUB75 コネクタを繋ぐ。

64×32 のパネルなら、Bonnet 側のはんだ付けは不要。

---

## セットアップ

### 1. パネル駆動ライブラリ

[rpi-rgb-led-matrix](https://github.com/hzeller/rpi-rgb-led-matrix) を入れる。

```bash
sudo apt update
sudo apt install -y python3-dev python3-pillow git
git clone https://github.com/hzeller/rpi-rgb-led-matrix.git
cd rpi-rgb-led-matrix
make build-python PYTHON=$(which python3)
sudo make install-python PYTHON=$(which python3)
```

**オンボードの音声出力を無効化する。** このライブラリは音声と同じ
ハードウェアを使うため、有効なままだと表示がちらつく。

```bash
echo "blacklist snd_bcm2835" | sudo tee /etc/modprobe.d/blacklist-rgb-matrix.conf
sudo update-initramfs -u
sudo reboot
```

Pi 自身を Spotify Connect の再生端末にする構成（`../RASPBERRY-PI.md` の
「Pi 自身を再生端末にする」）とは、この点で両立しない。音を出すなら
USB DAC を使う。

### 2. 日本語フォント

```bash
sudo apt install -y fonts-noto-cjk
```

別のフォントを使いたい場合は `LED_FONT_PATH` にフルパスを指定する。

### 3. アプリ

Web 版と同じリポジトリなので、すでに Pi に clone してあるならそのまま使える。
venv も Web 版と共用でよい。`led/requirements.txt` はルートの
`requirements.txt` を取り込んだうえで Pillow を足すだけなので、これ1本で
両方の依存が揃う。

```bash
cd ~/spotify-display
python3 -m venv --system-site-packages .venv    # 既にあるなら飛ばす
source .venv/bin/activate
pip install -r led/requirements.txt
```

**`source .venv/bin/activate` を忘れると `ModuleNotFoundError: No module
named 'PIL'` になる。** システムの python3 には Pillow が入っていないため。

`rgbmatrix` は `sudo make install-python` でシステム側に入るので、venv から
見えるように `--system-site-packages` を付けている。すでに付けずに作って
しまった場合は、`.venv` を消して作り直す。

### 4. ログイン

**LED 版に認証画面は無い。** リポジトリ直下の `.env` と `token_store.json` を
Web 版と共用するので、ログインは Web 版で一度済ませておく。

```bash
python3 app.py     # ブラウザで http://127.0.0.1:5000 を開いてログイン
```

`token_store.json` ができたら Ctrl+C で止めてよい。以降 LED 版が自動で
トークンを更新する。

### 5. 起動

```bash
sudo .venv/bin/python led/main.py
```

`sudo` が要るのは GPIO を直接叩くため。表示が出たら成功。

---

## 自動起動

`/etc/systemd/system/spotify-led.service` を作る。

```ini
[Unit]
Description=Spotify LED Matrix
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/pi/spotify-display
ExecStart=/home/pi/spotify-display/.venv/bin/python /home/pi/spotify-display/led/main.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` は必ず指定する。`.env` と `token_store.json` を
相対で解決しているため、これがないと見つけられない。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spotify-led
journalctl -u spotify-led -f
```

Web 版（`spotify-display.service`）と同時に動かしても構わない。トークンの
更新が重なった場合は、片方がファイルを読み直して追従する。

---

## パネル無しで表示を確認する

手元の Mac / PC でも、実機と同じ描画結果を GIF に書き出せる。パネルが届く
前に文字サイズやスクロール速度を詰めるのに使う。

```bash
source .venv/bin/activate
pip install -r led/requirements.txt

# 固定の曲名で確認する（Spotify に繋がない）
python3 led/main.py --preview out.gif --demo --seconds 12

# 実際に再生中の曲で確認する（.env と token_store.json が必要）
python3 led/main.py --preview out.gif --seconds 12
```

| オプション | 既定 | 説明 |
|---|---|---|
| `--preview OUT.gif` | — | 実機に出さず GIF に書き出す |
| `--demo` | — | Spotify に繋がず、固定の曲名を順に出す |
| `--seconds N` | 10 | 記録する秒数 |
| `--scale N` | 8 | 拡大率 |

---

## 設定

すべて環境変数で変えられる。`.env` に書けば起動時に読まれる。

### パネル

| 変数 | 既定 | 説明 |
|---|---|---|
| `LED_PANEL_WIDTH` | `64` | パネル1枚の横ドット数 |
| `LED_PANEL_HEIGHT` | `32` | 同、縦 |
| `LED_PANEL_CHAIN` | `1` | 横に連結した枚数。2 なら 128×32 |
| `LED_BRIGHTNESS` | `60` | 明るさ 0-100 |
| `LED_GPIO_SLOWDOWN` | `2` | 表示が乱れるときに上げる。Pi 4 以降は 3-4 |
| `LED_HARDWARE_MAPPING` | `adafruit-hat` | Bonnet の「quality」設定にした場合は `adafruit-hat-pwm` |

### 文字

| 変数 | 既定 | 説明 |
|---|---|---|
| `LED_FONT_PATH` | — | フォントのフルパス |
| `LED_FONT_SIZE_MAX` | `16` | 曲名のサイズ上限。ここから下げて枠に収まる最大値が選ばれる |
| `LED_FONT_SIZE` | — | 自動調整せず固定したいとき |
| `LED_ROW_GAP` | `0` | 行間のドット数。上げると文字が小さくなる |
| `LED_SINGLE_FONT_SIZE_MAX` | `26` | 1行表示のサイズ上限 |

### 動き

| 変数 | 既定 | 説明 |
|---|---|---|
| `LED_POLL_INTERVAL` | `5` | Spotify に問い合わせる間隔（秒） |
| `LED_FPS` | `30` | 描画のフレームレート |
| `LED_SCROLL_SPEED` | `22` | スクロール速度（ドット/秒） |
| `LED_SCROLL_PAUSE` | `1.5` | 先頭で止まる時間（秒） |
| `LED_SCROLL_GAP` | `16` | 末尾と先頭のあいだの空き（ドット） |

### 色

`"R,G,B"` 形式で指定する。

| 変数 | 既定 | 用途 |
|---|---|---|
| `LED_TITLE_COLOR` | `255,255,255` | 曲名 |
| `LED_ARTIST_COLOR` | `120,190,130` | アーティスト名 |
| `LED_IDLE_COLOR` | `70,70,80` | 停止中 |
| `LED_ERROR_COLOR` | `200,110,60` | 未ログイン・通信不良 |

---

## 構成

```
led/
├── main.py            ループ。問い合わせは別スレッドで行う
├── config.py          設定。環境変数の読み取り
├── spotify_source.py  トークン管理と再生中の曲の取得（app.py から流用）
├── renderer.py        フレームの組み立て。出力先に依存しない
├── panel.py           出力先。実機とプレビューを同じ形で扱う
└── requirements.txt
```

`renderer.py` が Pillow の画像を作り、`panel.py` がそれを実機か GIF に出す。
Web 版の `source.js` が取得元の差を吸収しているのと同じ考え方で、こちらは
出力先の差を吸収している。おかげで Pi が無くても描画を確認できる。

---

## うまくいかないとき

**表示がちらつく。** オンボード音声が無効になっていない。セットアップ 1 の
blacklist を確認する。それでも残る場合は `LED_GPIO_SLOWDOWN` を上げる。

**何も映らない。** Bonnet の DC ジャック横の緑 LED が点いているか見る。
消えていれば AC アダプタが挿さっていないか、極性が違う。

**`ModuleNotFoundError: No module named 'PIL'`。** venv を有効にしていない。
`source .venv/bin/activate` してから実行する。有効にしても出る場合は
`pip install -r led/requirements.txt` がまだ。

**`rgbmatrix が見つかりません`。** venv から見えていない。
`--system-site-packages` を付けて venv を作り直す。

**`未ログイン` のまま。** リポジトリ直下に `token_store.json` があるか確認する。
無ければ Web 版でログインする。あるのに直らない場合はリフレッシュトークンが
失効している（`../README.md` のトラブルシューティング参照）。

**曲名が途中で切れる。** `LED_SCROLL_GAP` を広げると末尾と先頭の区別が付く。
それでも読みにくければ `LED_SCROLL_SPEED` を下げる。

**GPIO を使うので `sudo` が要る。** systemd のユニットでも `User=root` に
している。これはライブラリの制約で、回避できない。
