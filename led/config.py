"""LED マトリクス表示の設定。

環境変数で上書きできる。既定値は 64x32 / P3 パネル 1枚を想定している。
"""

import os
from pathlib import Path

# リポジトリ直下。.env と token_store.json を Web 版と共用する
REPO_ROOT = Path(__file__).resolve().parent.parent


def _int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# -------------------------------
# パネル
# -------------------------------

# パネル 1枚の解像度
PANEL_WIDTH = _int("LED_PANEL_WIDTH", 64)
PANEL_HEIGHT = _int("LED_PANEL_HEIGHT", 32)

# 横に連結した枚数。2 なら 128x32 として扱う
PANEL_CHAIN = _int("LED_PANEL_CHAIN", 1)

# 明るさ（0-100）。夜間に眩しければ下げる
BRIGHTNESS = _int("LED_BRIGHTNESS", 60)

# GPIO のスロットダウン。Pi 3 以降はここを上げないと表示が乱れることがある
GPIO_SLOWDOWN = _int("LED_GPIO_SLOWDOWN", 2)

# Adafruit の Bonnet / HAT を使う場合は "adafruit-hat"。
# 「quality」設定（GPIO4-GPIO18 をはんだジャンパで接続）にした場合は
# "adafruit-hat-pwm" にする
HARDWARE_MAPPING = os.environ.get("LED_HARDWARE_MAPPING", "adafruit-hat")

WIDTH = PANEL_WIDTH * PANEL_CHAIN
HEIGHT = PANEL_HEIGHT


# -------------------------------
# フォント
# -------------------------------

# LED パネルはフルカラーなので、アンチエイリアスの階調がそのまま明るさとして出る。
# 16px の漢字はビットマップフォントより TTF のほうが読みやすい。
FONT_CANDIDATES = [
    os.environ.get("LED_FONT_PATH", ""),
    # Raspberry Pi OS: sudo apt install fonts-noto-cjk
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    # macOS
    "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]

# 2行レイアウトの1行分の高さ
ROW_HEIGHT = HEIGHT // 2

# 行と行のあいだに空けるドット数。0 なら文字の高さを最大に取る。
# 曲名とアーティスト名は色が違うので、0 でも読み分けられる
ROW_GAP = _int("LED_ROW_GAP", 0)

# フォントサイズの上限。実際の値は、この上限から下げていって
# 枠に収まった最大のものが選ばれる（フォントによって最適値が違うため）。
# 明示したいときは LED_FONT_SIZE に固定値を入れる
FONT_SIZE_MAX = _int("LED_FONT_SIZE_MAX", 16)

# 上限ではなくこのサイズで固定したい場合に指定する
FONT_SIZE = _int("LED_FONT_SIZE", 0) or None

# 1行だけ出すとき（再生していない・エラー）のサイズ上限。
# 高さをまるごと使えるので大きくできる
SINGLE_FONT_SIZE_MAX = _int("LED_SINGLE_FONT_SIZE_MAX", 26)


# -------------------------------
# 動き
# -------------------------------

# Spotify に問い合わせる間隔（秒）。短くしすぎるとレート制限に当たる
POLL_INTERVAL = _int("LED_POLL_INTERVAL", 5)

# 描画のフレームレート
FPS = _int("LED_FPS", 30)

# スクロール速度（ピクセル/秒）
SCROLL_SPEED = _int("LED_SCROLL_SPEED", 22)

# スクロールが一巡したあと、先頭で止まる時間（秒）
SCROLL_PAUSE = float(os.environ.get("LED_SCROLL_PAUSE", "1.5"))

# スクロールするときの、末尾と先頭のあいだの空き（ピクセル）
SCROLL_GAP = _int("LED_SCROLL_GAP", 16)


# -------------------------------
# 色
# -------------------------------

def _rgb(name, default):
    """"255,128,0" 形式の環境変数を (r, g, b) にする"""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        parts = tuple(int(p) for p in raw.split(","))
    except ValueError:
        return default
    return parts if len(parts) == 3 else default


# 曲名
TITLE_COLOR = _rgb("LED_TITLE_COLOR", (255, 255, 255))

# アーティスト名。曲名より落として、視線が曲名に行くようにする
ARTIST_COLOR = _rgb("LED_ARTIST_COLOR", (120, 190, 130))

# 再生していないときのメッセージ
IDLE_COLOR = _rgb("LED_IDLE_COLOR", (70, 70, 80))

# 通信不良・未ログインなど、利用者の対処が必要な状態
ERROR_COLOR = _rgb("LED_ERROR_COLOR", (200, 110, 60))
