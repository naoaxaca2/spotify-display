"""フレームの組み立て。

出力先に依存しない。ここが作るのは Pillow の RGB 画像で、それを実機に
出すのが panel.py。おかげで Mac 上でも同じ描画結果を確認できる。
"""

import logging
import time

from PIL import Image, ImageDraw, ImageFont

import config

# 上下の詰まり具合を決める基準の文字。
# 仮名・漢字・英大文字・下に出る英小文字・数字を混ぜて、
# このフォントで実際に使う範囲の上端と下端を測る。
_REFERENCE = "あアA縦gy1"


def find_font_path():
    """設定の候補を順に試して、最初に開けたフォントのパスを返す"""
    tried = []
    for path in config.FONT_CANDIDATES:
        if not path:
            continue
        tried.append(path)
        try:
            ImageFont.truetype(path, 12)
            return path
        except OSError:
            continue

    raise SystemExit(
        "日本語フォントが見つかりません。\n"
        "  Raspberry Pi OS / Debian: sudo apt install fonts-noto-cjk\n"
        "  別の場所にある場合: 環境変数 LED_FONT_PATH にフルパスを指定\n"
        "探した場所:\n  " + "\n  ".join(tried)
    )


def _ink_band(font):
    """このフォントで文字が実際に占める上端と下端を測る。

    曲ごとに使う文字が違っても行の位置がずれないよう、テキストごとではなく
    フォントごとに一度だけ決める。
    """
    bbox = font.getbbox(_REFERENCE)
    return bbox[1], bbox[3]


def fit_font(path, target_height, max_size, text=None, target_width=None):
    """枠に収まる最大のフォントを返す。

    同じ pt 数でも字面の大きさはフォントによって違う。Noto で合わせた値は
    ヒラギノでははみ出す、ということが起きるので、実際に測って決める。

    text と target_width を渡すと、横幅にも収める。停止中の表示のように
    長く出しっぱなしになるものは、スクロールさせないほうが落ち着く。

    戻り値は (font, ink_top, ink_bottom)。
    """
    if config.FONT_SIZE:
        font = ImageFont.truetype(path, config.FONT_SIZE)
        top, bottom = _ink_band(font)
        return font, top, bottom

    smallest = None
    for size in range(max_size, 5, -1):
        font = ImageFont.truetype(path, size)
        top, bottom = _ink_band(font)
        if bottom - top > target_height:
            smallest = (font, top, bottom)
            continue
        if target_width and text and font.getlength(text) > target_width:
            smallest = (font, top, bottom)
            continue
        return font, top, bottom

    # 収まるサイズが無かった。最小まで下げたものを返し、あとはスクロールに任せる
    return smallest


class TextStrip:
    """1行分のテキストを描いた横長の画像と、その表示位置。

    画面に収まる長さなら左寄せで固定。はみ出すなら横スクロールする。
    """

    def __init__(self, text, font, color, ink_top, ink_bottom, view_width):
        self.text = text
        self.view_width = view_width
        self.offset = 0.0
        self.paused_until = time.monotonic() + config.SCROLL_PAUSE

        height = ink_bottom - ink_top
        width = max(1, int(font.getlength(text)))

        strip = Image.new("RGB", (width, height), (0, 0, 0))
        # ink_top のぶん上へずらして描くと、余白を切り落とした状態になる
        ImageDraw.Draw(strip).text((0, -ink_top), text, font=font, fill=color)

        self.strip = strip
        self.scrolls = width > view_width
        # 一巡の長さ。末尾のあとに隙間を置いて先頭に戻る
        self.cycle = width + config.SCROLL_GAP

    def advance(self, dt):
        """経過時間ぶんスクロールを進める"""
        if not self.scrolls:
            return

        now = time.monotonic()
        if now < self.paused_until:
            return

        self.offset += config.SCROLL_SPEED * dt
        if self.offset >= self.cycle:
            # 一巡した。先頭でひと呼吸置く
            self.offset = 0.0
            self.paused_until = now + config.SCROLL_PAUSE

    def paste_into(self, frame, y):
        """フレームの y 行目にこの行を書き込む"""
        if not self.scrolls:
            frame.paste(self.strip, (0, y))
            return

        start = int(self.offset)
        # 1枚目。末尾まで来たら足りないぶんを2枚目で埋めるので、
        # 文字が切れずに先頭へ繋がって見える
        frame.paste(self.strip.crop((start, 0, start + self.view_width,
                                     self.strip.height)), (0, y))

        shown = self.strip.width - start
        if shown < self.view_width:
            frame.paste(self.strip, (shown + config.SCROLL_GAP, y))


class Renderer:
    """再生状態を 1枚のフレームにする"""

    def __init__(self):
        path = find_font_path()

        self.font_path = path

        # 2行のとき。枠の高さから行間を引いたぶんに収める
        self.row_font, self.row_top, self.row_bottom = fit_font(
            path, config.ROW_HEIGHT - config.ROW_GAP, config.FONT_SIZE_MAX
        )

        logging.info("フォント: %s (曲名 %dpx)", path, self.row_font.size)

        self.rows = []
        self.row_height = self.row_bottom - self.row_top
        # 直前に描いた内容。変わったときだけ行を作り直す
        self._key = None

    def _strip(self, text, color):
        """2行レイアウトの1行を作る"""
        return TextStrip(text, self.row_font, color, self.row_top,
                         self.row_bottom, config.WIDTH)

    def _single(self, text, color):
        """1行だけ出すときの行を作る。

        高さも幅も使えるだけ使い、画面に収まるなら大きく静止させる。
        """
        font, top, bottom = fit_font(
            self.font_path, config.HEIGHT, config.SINGLE_FONT_SIZE_MAX,
            text=text, target_width=config.WIDTH,
        )
        return TextStrip(text, font, color, top, bottom, config.WIDTH)

    def update(self, status):
        """Spotify の状態を受け取る。内容が変わったら行を作り直す"""
        state = status.get("state")

        if state == "playing":
            key = ("playing", status.get("title"), status.get("artists"))
        elif state == "idle":
            key = ("idle",)
        else:
            key = ("error", status.get("message"))

        if key == self._key:
            return
        self._key = key

        if state == "playing":
            self.rows = [
                self._strip(status.get("title") or "-", config.TITLE_COLOR),
                self._strip(status.get("artists") or "", config.ARTIST_COLOR),
            ]
        elif state == "idle":
            self.rows = [self._single("停止中", config.IDLE_COLOR)]
        else:
            self.rows = [
                self._single(status.get("message") or "エラー", config.ERROR_COLOR)
            ]

    def render(self, dt):
        """フレームを 1枚返す"""
        frame = Image.new("RGB", (config.WIDTH, config.HEIGHT), (0, 0, 0))

        if len(self.rows) == 1:
            # 1行だけのときは上下の中央に置く
            h = self.rows[0].strip.height
            positions = [(config.HEIGHT - h) // 2]
        else:
            # 2行。各行を自分の枠の中央に置く
            pad = (config.ROW_HEIGHT - self.row_height) // 2
            positions = [pad, config.ROW_HEIGHT + pad]

        for row, y in zip(self.rows, positions):
            row.advance(dt)
            row.paste_into(frame, max(0, y))

        return frame
