"""LED マトリクスに再生中の曲を表示する。

  実機:       python3 main.py
  手元で確認: python3 main.py --preview out.gif --demo

Spotify への問い合わせは別スレッドで行う。描画ループと同じスレッドで待つと、
通信のたびにスクロールが引っかかる。
"""

import argparse
import logging
import threading
import time

import config
import panel as panel_module
from renderer import Renderer

# 問い合わせが失敗し続けるときに間隔を伸ばす上限（秒）。
# 圏外や未ログインのまま放置されても、無駄な通信を繰り返さない
MAX_BACKOFF = 60


class StatusPoller:
    """Spotify の状態を一定間隔で取り、最新のものを持っておく"""

    def __init__(self, fetch, interval):
        self.fetch = fetch
        self.interval = interval
        self.status = {"state": "error", "message": "起動中"}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()

    def latest(self):
        with self._lock:
            return self.status

    def _run(self):
        backoff = self.interval
        while not self._stop.is_set():
            try:
                status = self.fetch()
            except Exception:
                # 想定外の例外でも表示は続ける。止まった画面より、
                # 状態が出ているほうが原因を追いやすい
                logging.exception("状態の取得に失敗しました")
                status = {"state": "error", "message": "取得失敗"}

            with self._lock:
                self.status = status

            if status.get("state") == "error":
                backoff = min(backoff * 2, MAX_BACKOFF)
            else:
                backoff = self.interval

            self._stop.wait(backoff)


def demo_source():
    """パネルもログインも無しに表示を確認するための、固定の曲名。

    長い日本語・記号混じり・短い英字を順に出して、スクロールと
    折り返しの見えかたを確かめる。
    """
    tracks = [
        ("残響散歌", "Aimer"),
        ("Bohemian Rhapsody", "Queen"),
        ("春よ、来い", "松任谷由実"),
        ("夜に駆ける 〜 Racing Into The Night", "YOASOBI"),
    ]
    state = {"i": 0, "next": 0.0}

    def fetch():
        now = time.monotonic()
        if now >= state["next"]:
            state["i"] = (state["i"] + 1) % len(tracks)
            state["next"] = now + 8
        title, artists = tracks[state["i"]]
        return {"state": "playing", "is_playing": True,
                "title": title, "artists": artists}

    return fetch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--preview", metavar="OUT.gif",
        help="実機に出さず、拡大した GIF に書き出す",
    )
    parser.add_argument(
        "--demo", action="store_true",
        help="Spotify に接続せず、固定の曲名で表示を確認する",
    )
    parser.add_argument(
        "--seconds", type=float, default=10,
        help="--preview のときに記録する秒数（既定 10）",
    )
    parser.add_argument(
        "--scale", type=int, default=8,
        help="--preview のときの拡大率（既定 8）",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )

    if args.demo:
        fetch = demo_source()
    else:
        import spotify_source
        fetch = spotify_source.fetch_now_playing

    renderer = Renderer()
    display = panel_module.open_panel(
        args.preview, args.scale, int(args.seconds * config.FPS)
    )

    poller = StatusPoller(fetch, config.POLL_INTERVAL)
    poller.start()

    frame_time = 1.0 / config.FPS
    deadline = time.monotonic() + args.seconds if args.preview else None
    last = time.monotonic()

    try:
        while True:
            now = time.monotonic()
            dt = now - last
            last = now

            renderer.update(poller.latest())
            display.show(renderer.render(dt))

            if deadline and now >= deadline:
                break

            # 描画にかかった時間を差し引いて待つ
            time.sleep(max(0.0, frame_time - (time.monotonic() - now)))
    except KeyboardInterrupt:
        pass
    finally:
        poller.stop()
        display.close()


if __name__ == "__main__":
    main()
