"""出力先。

実機（rpi-rgb-led-matrix）と、手元で確認するためのプレビューを同じ
インターフェイスで扱う。Web 版の source.js が取得元の差を吸収している
のと同じ考え方で、こちらは出力先の差を吸収する。
"""

import logging

from PIL import Image

import config


class MatrixPanel:
    """rpi-rgb-led-matrix 経由で実機に出す"""

    def __init__(self):
        # ライブラリは Pi にしか入らないので、ここで読む
        from rgbmatrix import RGBMatrix, RGBMatrixOptions

        options = RGBMatrixOptions()
        options.rows = config.PANEL_HEIGHT
        options.cols = config.PANEL_WIDTH
        options.chain_length = config.PANEL_CHAIN
        options.parallel = 1
        options.brightness = config.BRIGHTNESS
        options.gpio_slowdown = config.GPIO_SLOWDOWN
        options.hardware_mapping = config.HARDWARE_MAPPING
        # ループを専有するスレッドを作らせない。描画はこちらで回す
        options.drop_privileges = False

        self.matrix = RGBMatrix(options=options)
        # ちらつきを抑えるため、裏で描いて一度に差し替える
        self.canvas = self.matrix.CreateFrameCanvas()

    def show(self, frame):
        self.canvas.SetImage(frame.convert("RGB"))
        self.canvas = self.matrix.SwapOnVSync(self.canvas)

    def close(self):
        self.matrix.Clear()


class PreviewPanel:
    """フレームを溜めて、最後に拡大した GIF で書き出す。

    パネルが手元に無くても、日本語の出かたとスクロールを確認できる。
    """

    def __init__(self, out_path, scale=8, max_frames=300):
        self.out_path = out_path
        self.scale = scale
        self.max_frames = max_frames
        self.frames = []

    def show(self, frame):
        if len(self.frames) >= self.max_frames:
            return

        w, h = frame.size
        # ドットの粒が見えるように、補間なしで拡大する
        self.frames.append(
            frame.resize((w * self.scale, h * self.scale), Image.NEAREST)
        )

    def close(self):
        if not self.frames:
            logging.warning("フレームがありません")
            return

        self.frames[0].save(
            self.out_path,
            save_all=True,
            append_images=self.frames[1:],
            duration=int(1000 / config.FPS),
            loop=0,
        )
        logging.info("%s に %d フレーム書き出しました", self.out_path, len(self.frames))


def open_panel(preview_path=None, scale=8, max_frames=300):
    """実機があれば実機、無ければプレビューを返す"""
    if preview_path:
        return PreviewPanel(preview_path, scale, max_frames)

    try:
        return MatrixPanel()
    except ImportError:
        raise SystemExit(
            "rgbmatrix が見つかりません。\n"
            "Raspberry Pi では rpi-rgb-led-matrix をインストールしてください"
            "（led/README.md 参照）。\n"
            "パネルなしで表示を確認したいときは --preview out.gif を付けてください。"
        )
