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

**実機で確認した構成**: Raspberry Pi 3B + Raspberry Pi OS Lite 64-bit
(Debian 13 trixie) + Waveshare 64×32 P3 パネル + Bonnet。

---

## セットアップ

LED 版はブラウザを使わないので、専用機なら Raspberry Pi OS Lite でよい。
以下は Lite を入れた直後の状態から始める。

### 1. パッケージ

```bash
sudo apt update
sudo apt install -y git python3-dev python3-venv python3-pip \
                    cython3 build-essential cmake ninja-build \
                    fonts-noto-cjk
```

`cmake` と `ninja-build` はパネル駆動ライブラリのビルドに使う。
`fonts-noto-cjk` は 300MB 近くあるので時間がかかる。別のフォントを
使いたい場合は入れずに `LED_FONT_PATH` を指定してもよい。

### 2. アプリと venv

Web 版と同じリポジトリ。すでに clone してあるならそのまま使える。
`led/requirements.txt` はルートの `requirements.txt` を取り込んだうえで
Pillow を足すだけなので、これ1本で両方の依存が揃う。

```bash
cd ~
git clone https://github.com/naoaxaca2/spotify-display.git
cd spotify-display
python3 -m venv .venv
source .venv/bin/activate
pip install -r led/requirements.txt
```

**`source .venv/bin/activate` を忘れると `ModuleNotFoundError: No module
named 'PIL'` になる。** システムの python3 には Pillow が入っていない。

### 3. パネル駆動ライブラリ

[rpi-rgb-led-matrix](https://github.com/hzeller/rpi-rgb-led-matrix) を、
**手順 2 で作った venv の中に**入れる。

```bash
cd ~
git clone https://github.com/hzeller/rpi-rgb-led-matrix.git
cd ~/spotify-display
source .venv/bin/activate
pip install ~/rpi-rgb-led-matrix
```

C++ を CMake でビルドするので、Pi 3B では5〜10分かかる。終わったら
確認する。

```bash
python3 -c "import rgbmatrix; print('OK')"
```

**上流のビルド方法が変わっている。** 以前は `make build-python` /
`sudo make install-python` でシステム側に入れていたが、現在は
`pyproject.toml`（scikit-build-core + Cython）による `pip install .` に
置き換わった。古い手順を実行すると
`make: *** No rule to make target 'build-python'` で止まる。

venv の中に入れるので `--system-site-packages` は不要で、システム側の
Python を触らないため `--break-system-packages` も要らない。

配線の種類（Bonnet か否か）は実行時に `hardware_mapping` で渡すので、
上流 README にある `lib/Makefile` の編集は不要。`led/config.py` が
`adafruit-hat` を既定で渡している。

### 4. オンボード音声を無効化する

このライブラリは音声出力と同じハードウェアを使うため、有効なままだと
表示がちらつく。

```bash
echo "blacklist snd_bcm2835" | sudo tee /etc/modprobe.d/blacklist-rgb-matrix.conf
sudo update-initramfs -u
sudo reboot
```

再起動後、効いていることを確認する。何も出力されなければよい。

```bash
lsmod | grep snd_bcm2835
```

Pi 自身を Spotify Connect の再生端末にする構成（`../RASPBERRY-PI.md` の
「Pi 自身を再生端末にする」）とは、この点で両立しない。音を出すなら
USB DAC を使う。

DSI ディスプレイと併用する場合も確認がいる。信号線はぶつからない（DSI は専用
コネクタで GPIO を使わない）が、ディスプレイが GPIO ヘッダの接点から給電を
受ける作りのものがあり、Bonnet と同じヘッダを取り合う。`../RASPBERRY-PI.md`
の「ディスプレイを繋ぐ」を参照。

### 5. 認証情報

リポジトリ直下に `.env` を置く。Client ID と Secret は Spotify Developer
Dashboard のアプリのもので、**液晶版と同じ値でよい**。これはアプリを識別する
もので、端末ごとに分ける必要はない。

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:5000/callback
FLASK_SECRET_KEY=...
```

`FLASK_SECRET_KEY` は `python3 -c "import secrets; print(secrets.token_hex(32))"`
で作れる。

### 6. ログイン

**LED 版に認証画面は無い。** リポジトリ直下の `.env` と `token_store.json` を
Web 版と共用する。Web 版（`app.py`）で一度ログインして `token_store.json` を
作れば、以降は LED 版が自動でトークンを更新する。

#### デスクトップがある場合

Pi の画面でブラウザを開ける構成なら、そのまま起動してログインすればよい。

```bash
python3 app.py     # ブラウザで http://127.0.0.1:5000 を開いてログイン
```

`token_store.json` ができたら Ctrl+C で止めてよい。

#### ヘッドレスの場合（LED 専用機）

Lite にはブラウザが無いので、**手元の PC から SSH ポートフォワードで
トンネルを掘る。**

```bash
# 手元の PC から
ssh -L 5000:localhost:5000 naoaxaca@ledpi.local
```

繋がったら、その SSH 先（Pi 側）でアプリを起動する。

```bash
cd ~/spotify-display
source .venv/bin/activate
python3 app.py
```

手元の PC のブラウザで `http://127.0.0.1:5000` を開くと、通信がトンネルを
通って Pi に届く。ログインが終わって `token_store.json` ができたら Ctrl+C で
止め、SSH も切ってよい。

**リダイレクト URI は `http://127.0.0.1:5000/callback` のまま使える。** これが
トンネルを使う理由で、`http://192.168.x.x:5000/callback` のような LAN の
アドレスを Developer Dashboard に登録して済ませることはできない。Spotify は
ループバック以外の平文 HTTP を受け付けないため。

#### 複数台で動かす場合

液晶版と LED 版を別々の Pi に分けるときは、**それぞれの Pi で個別にログイン
する。** 同じアカウント・同じアプリに対して複数の認可を持つのは問題なく、
各機が独立したリフレッシュトークンを持つ。

**`token_store.json` を別の Pi からコピーして使い回してはいけない。** Spotify は
リフレッシュのたびにリフレッシュトークンを差し替えることがあり、片方が更新
すると、もう片方の持っている分が無効になる。2台が交互に相手を無効化し合う
状態になり、どちらも繰り返し再ログインが必要になる。

`.env`（Client ID / Secret）は逆に共用してよい。

### 7. 起動

パネルの電源が入っていることを確認してから実行する。

```bash
cd ~/spotify-display
sudo .venv/bin/python led/main.py
```

`sudo` が要るのは GPIO を直接叩くため。表示が出たら成功。

---

## 自動起動

`/etc/systemd/system/spotify-led.service` を作る。パスはユーザー名に
合わせて書き換える。

```ini
[Unit]
Description=Spotify LED Matrix
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/naoaxaca/spotify-display
ExecStart=/home/naoaxaca/spotify-display/.venv/bin/python /home/naoaxaca/spotify-display/led/main.py
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

### 電源を落とす

```bash
ssh naoaxaca@ledpi.local
sudo shutdown -h now
```

サービスが動いている最中でも構わない。systemd が停止信号を送ってから
アンマウントに進むし、このアプリが書くのは `token_store.json` だけで、
一時ファイルに書いてから置き換える作り（`save_tokens`）になっている。
緑の ACT LED が消えてから電源を抜く。

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

この用途なら `rgbmatrix` は要らない（`panel.py` が遅延 import している）。

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

**`make: *** No rule to make target 'build-python'`。** 上流がビルド方法を
変えた。`make` ではなく `pip install ~/rpi-rgb-led-matrix`（セットアップ 3）。

**表示がちらつく。** オンボード音声が無効になっていない。セットアップ 4 の
blacklist を確認する。それでも残る場合は `LED_GPIO_SLOWDOWN` を上げる。

**何も映らない。** Bonnet の DC ジャック横の緑 LED が点いているか見る。
消えていれば AC アダプタが挿さっていないか、極性が違う。

**`ModuleNotFoundError: No module named 'PIL'`。** venv を有効にしていない。
`source .venv/bin/activate` してから実行する。有効にしても出る場合は
`pip install -r led/requirements.txt` がまだ。

**`ModuleNotFoundError: No module named 'rgbmatrix'`。** venv の中に入って
いない。`source .venv/bin/activate` したうえで
`pip install ~/rpi-rgb-led-matrix` を実行する。systemd 経由なら
`ExecStart` が venv の python を指しているか確認する。

**`日本語フォントが見つかりません`。** `fonts-noto-cjk` が入っていないか、
ファイル名が `led/config.py` の候補と違う。
`ls /usr/share/fonts/opentype/noto/ | grep -i cjk` で実際の名前を見て、
`LED_FONT_PATH` にフルパスを指定する。

**`未ログイン` のまま。** リポジトリ直下に `token_store.json` があるか確認する。
無ければ Web 版でログインする。あるのに直らない場合はリフレッシュトークンが
失効している（`../README.md` のトラブルシューティング参照）。

**曲名が途中で切れる。** `LED_SCROLL_GAP` を広げると末尾と先頭の区別が付く。
それでも読みにくければ `LED_SCROLL_SPEED` を下げる。

**GPIO を使うので `sudo` が要る。** systemd のユニットでも `User=root` に
している。これはライブラリの制約で、回避できない。
