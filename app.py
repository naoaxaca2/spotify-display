"""
Spotify 再生情報表示アプリ（Flask）

機能:
- Spotify OAuth認証
- 現在再生中の曲取得
- トークン自動更新
- API提供（フロントエンド用）

Mac / Raspberry Pi 両対応
"""

import base64
import json
import logging
import os
import re
import time
from pathlib import Path
from urllib.parse import urlencode

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, send_from_directory

# .env読み込み
load_dotenv()

# フロントエンドは docs/ に一式置き、GitHub Pages と共用する。
# static_url_path="" にすることで、Pages と同じ相対パスでファイルが解決される。
app = Flask(__name__, static_folder="docs", static_url_path="")

# 正常レスポンス（2xx）のアクセスログを抑制する
class _SuppressSuccess(logging.Filter):
    def filter(self, record):
        m = re.search(r'" (\d{3}) ', record.getMessage())
        if m:
            return int(m.group(1)) >= 400  # 4xx/5xx のみ出力
        return True  # 起動メッセージ・例外など他のログは通す

logging.getLogger("werkzeug").addFilter(_SuppressSuccess())
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "change-me")

# 環境変数
CLIENT_ID = os.environ["SPOTIFY_CLIENT_ID"]
CLIENT_SECRET = os.environ["SPOTIFY_CLIENT_SECRET"]
REDIRECT_URI = os.environ["SPOTIFY_REDIRECT_URI"]

# トークン保存ファイル
TOKEN_FILE = Path("token_store.json")

# Spotify API エンドポイント
AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing"
AUDIO_FEATURES_URL = "https://api.spotify.com/v1/audio-features/{}"

# 必要な権限
# 再生制御には user-modify-playback-state が必要。
# スコープを変更したら token_store.json を消して再ログインすること。
SCOPES = (
    "user-read-currently-playing "
    "user-modify-playback-state "
    "playlist-read-private "
    "playlist-read-collaborative "
    # 端末一覧の取得に必要
    "user-read-playback-state"
)

# キー名（Pitch Class 0〜11）
KEY_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]


# -------------------------------
# トークン管理
# -------------------------------

def load_tokens():
    """保存済みトークンを読み込む"""
    if TOKEN_FILE.exists():
        return json.loads(TOKEN_FILE.read_text())
    return None


def save_tokens(tokens):
    """トークンをファイル保存"""
    TOKEN_FILE.write_text(json.dumps(tokens, indent=2))


def basic_auth_header():
    """Client ID / Secret をBase64エンコード"""
    raw = f"{CLIENT_ID}:{CLIENT_SECRET}".encode()
    encoded = base64.b64encode(raw).decode()
    return {"Authorization": f"Basic {encoded}"}


def token_expired(tokens):
    """トークン有効期限チェック"""
    return time.time() > tokens.get("expires_at", 0) - 60


def refresh_access_token(tokens):
    """refresh_token を使ってアクセストークン更新"""
    response = requests.post(
        TOKEN_URL,
        headers=basic_auth_header(),
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
    )
    response.raise_for_status()
    data = response.json()

    new_tokens = {
        "access_token": data["access_token"],
        "expires_at": time.time() + data["expires_in"],
        "refresh_token": data.get("refresh_token", tokens["refresh_token"]),
    }

    save_tokens(new_tokens)
    return new_tokens


def get_valid_tokens():
    """常に有効なトークンを取得"""
    tokens = load_tokens()
    if not tokens:
        return None

    if token_expired(tokens):
        return refresh_access_token(tokens)

    return tokens


# -------------------------------
# OAuth処理
# -------------------------------

def build_auth_url():
    """SpotifyログインURL生成"""
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code_for_token(code):
    """認可コード → アクセストークン変換"""
    response = requests.post(
        TOKEN_URL,
        headers=basic_auth_header(),
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
    )
    response.raise_for_status()
    data = response.json()

    tokens = {
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
        "expires_at": time.time() + data["expires_in"],
    }

    save_tokens(tokens)


# -------------------------------
# Spotify API
# -------------------------------

def fetch_audio_features(track_id, access_token):
    """Audio Features からキー情報を取得（取得できない場合は空dict）"""
    try:
        res = requests.get(
            AUDIO_FEATURES_URL.format(track_id),
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if not res.ok:
            return {}
        data = res.json()
        key_num = data.get("key", -1)
        mode = data.get("mode", -1)
        if key_num == -1 or mode == -1:
            return {}
        mode_name = "Major" if mode == 1 else "minor"
        return {"key": f"{KEY_NAMES[key_num]} {mode_name}"}
    except Exception:
        return {}


PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists"
# 1リクエストの上限は プレイリスト50件 / 曲100件。
# それ以上はページングが必要なので、取得する総数の上限もここで決めておく。
PLAYLISTS_PAGE_SIZE = 50
PLAYLIST_ITEMS_PAGE_SIZE = 100
MAX_PLAYLISTS = 500
MAX_PLAYLIST_ITEMS = 500
# 2026-02 の変更で /tracks → /items にリネームされた
PLAYLIST_ITEMS_URL = "https://api.spotify.com/v1/playlists/{}/items"
PLAY_URL = "https://api.spotify.com/v1/me/player/play"
SHUFFLE_URL = "https://api.spotify.com/v1/me/player/shuffle"
DEVICES_URL = "https://api.spotify.com/v1/me/player/devices"
# 再生先の転送。device_ids と play を渡す
PLAYER_URL = "https://api.spotify.com/v1/me/player"


def pick_thumbnail(images):
    """一覧のサムネに使う画像を選ぶ。

    Spotify は複数サイズを返すので、最大の画像を並べると
    Pi Zero では描画とダウンロードが重くなる。64px 以上で最小のものを使う。
    """
    if not images:
        return None
    sized = [i for i in images if i.get("height")]
    if not sized:
        return images[-1].get("url")
    for img in sorted(sized, key=lambda i: i["height"]):
        if img["height"] >= 64:
            return img.get("url")
    return sorted(sized, key=lambda i: i["height"])[-1].get("url")


def fetch_all_pages(url, access_token, page_size, max_items):
    """ページングして全件集める。

    戻り値は (items, error_response)。error_response が None なら成功。
    """
    items = []
    offset = 0
    while len(items) < max_items:
        res = requests.get(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            params={"limit": page_size, "offset": offset},
        )
        if not res.ok:
            return None, res

        data = res.json()
        page = data.get("items", [])
        items.extend(page)

        # next が無い、または空ページなら終わり
        if not data.get("next") or not page:
            break
        offset += page_size

    return items[:max_items], None


def simplify_playlist(pl):
    """一覧表示に必要な項目だけ抜き出す"""
    # playlist オブジェクトの tracks も 2026-02 に items へリネームされた。
    # 移行期のため両方を見る。
    counts = pl.get("items") or pl.get("tracks") or {}
    return {
        "id": pl.get("id"),
        "name": pl.get("name") or "(名称なし)",
        "uri": pl.get("uri"),
        "owner": (pl.get("owner") or {}).get("display_name") or "",
        "total": counts.get("total"),
        "image_url": pick_thumbnail(pl.get("images") or []),
    }


def simplify_playlist_item(entry):
    """プレイリストの1行 → 表示用の辞書。取得できない行は None"""
    # PlaylistTrackObject の track も item にリネームされたため両対応
    track = entry.get("item") or entry.get("track")
    if not track or not track.get("uri"):
        return None
    if track.get("type") == "episode":
        artists = (track.get("show") or {}).get("name", "")
        images = track.get("images") or (track.get("show") or {}).get("images") or []
    else:
        artists = ", ".join(a["name"] for a in track.get("artists", []))
        images = (track.get("album") or {}).get("images") or []
    duration_ms = track.get("duration_ms", 0)
    minutes, seconds = divmod(duration_ms // 1000, 60)
    return {
        "uri": track["uri"],
        "name": track.get("name", ""),
        "artists": artists,
        "duration": f"{minutes}:{seconds:02d}",
        "image_url": pick_thumbnail(images),
    }


def spotify_error(res):
    """Spotify のレスポンス → (返すHTTPステータス, 本文)

    403 は「Premium が必要」と「スコープ不足」の両方で返ってくる。
    本文の reason を見て区別しないと、原因の切り分けができなくなる。
    """
    status_code = res.status_code

    if status_code == 404:
        return 409, {"error": "no_active_device"}

    if status_code == 403:
        try:
            reason = (res.json().get("error") or {}).get("reason", "")
        except Exception:
            reason = ""
        if reason == "PREMIUM_REQUIRED":
            return 403, {"error": "premium_required"}
        # スコープが足りない場合はここに来る。再ログインで解消する
        return 403, {"error": "insufficient_scope"}

    return 502, {"error": f"spotify {status_code}"}


# 再生制御コマンド → (HTTPメソッド, エンドポイント)
PLAYER_COMMANDS = {
    "play": ("PUT", "https://api.spotify.com/v1/me/player/play"),
    "pause": ("PUT", "https://api.spotify.com/v1/me/player/pause"),
    "next": ("POST", "https://api.spotify.com/v1/me/player/next"),
    "previous": ("POST", "https://api.spotify.com/v1/me/player/previous"),
}


def send_player_command(action, access_token, device_id=None):
    """再生制御コマンドを送る。(HTTPステータス, 返す辞書) を返す"""
    if action not in PLAYER_COMMANDS:
        return 400, {"error": "unknown command"}

    method, url = PLAYER_COMMANDS[action]
    res = requests.request(
        method,
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        params={"device_id": device_id} if device_id else None,
    )

    # 成功時は 204 No Content
    if res.status_code in (200, 202, 204):
        return 200, {"ok": True}

    # 404 は「操作対象の端末が定まっていない」。Spotify アプリで一度再生すると解消する
    return spotify_error(res)


def fetch_now_playing(access_token):
    """現在再生中の曲を取得"""
    res = requests.get(
        CURRENTLY_PLAYING_URL,
        headers={"Authorization": f"Bearer {access_token}"},
    )

    # 再生していない場合
    if res.status_code == 204:
        return {"is_playing": False}

    res.raise_for_status()
    data = res.json()

    item = data.get("item")
    if not item:
        return {"is_playing": False}

    item_type = item.get("type", "track")  # "track" or "episode"

    if item_type == "episode":
        title = item["name"]
        artists = item.get("show", {}).get("name", "")
        album = ""
        images = item.get("images") or item.get("show", {}).get("images", [])
    else:
        title = item["name"]
        artists = ", ".join(a["name"] for a in item["artists"])
        album_obj = item["album"]
        album = album_obj["name"]
        album_type = album_obj.get("album_type", "")   # "album" / "single" / "compilation"
        release_date = album_obj.get("release_date", "")
        album_artists = ", ".join(a["name"] for a in album_obj.get("artists", []))
        images = album_obj.get("images", [])

    image_url = images[0]["url"] if images else None

    # 曲の長さ（分:秒）
    duration_ms = item.get("duration_ms", 0)
    minutes, seconds = divmod(duration_ms // 1000, 60)
    duration = f"{minutes}:{seconds:02d}"

    display_text = f"{title}  —  {artists}"

    result = {
        "is_playing": data["is_playing"],
        "type": item_type,
        "track_id": item["id"],
        "title": title,
        "artists": artists,
        "album": album,
        "image_url": image_url,
        "display_text": display_text,
        "duration": duration,
    }

    if item_type != "episode":
        result["album_type"] = album_type
        result["release_date"] = release_date
        result["album_artists"] = album_artists

    return result


# -------------------------------
# Flask Routes
# -------------------------------

@app.route("/")
def index():
    """メイン画面（docs/index.html をそのまま返す）"""
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/mode")
def mode():
    """フロントエンドがサーバの有無を判定するためのエンドポイント。

    GitHub Pages ではこのパスが 404 になるため、フロント側は PKCE モードに切り替わる。
    """
    return jsonify({"mode": "server", "logged_in": load_tokens() is not None})


@app.route("/login")
def login():
    """Spotifyログインへリダイレクト"""
    return redirect(build_auth_url())


@app.route("/callback")
def callback():
    """OAuthコールバック"""
    code = request.args.get("code")
    exchange_code_for_token(code)
    return redirect("/")


@app.route("/api/command/<action>", methods=["POST"])
def command(action):
    """再生制御API（フロントエンドから呼ばれる）"""
    tokens = get_valid_tokens()
    if not tokens:
        return jsonify({"error": "not authenticated"}), 401

    body = request.get_json(silent=True) or {}
    status, payload = send_player_command(
        action, tokens["access_token"], body.get("device_id")
    )
    return jsonify(payload), status


@app.route("/api/playlists")
def playlists():
    """自分のプレイリスト一覧（所有＋フォロー中）"""
    tokens = get_valid_tokens()
    if not tokens:
        return jsonify({"error": "not authenticated"}), 401

    raw, error = fetch_all_pages(
        PLAYLISTS_URL, tokens["access_token"], PLAYLISTS_PAGE_SIZE, MAX_PLAYLISTS
    )
    if error is not None:
        status, payload = spotify_error(error)
        return jsonify(payload), status

    items = [simplify_playlist(p) for p in raw if p]
    return jsonify({"items": items})


@app.route("/api/playlists/<playlist_id>/items")
def playlist_items(playlist_id):
    """プレイリストの曲一覧。

    自分が所有していない（フォローしているだけの）プレイリストは
    Spotify 側が 403 を返す。呼び出し元はこれを受けて
    「まるごと再生」だけを提示する。
    """
    tokens = get_valid_tokens()
    if not tokens:
        return jsonify({"error": "not authenticated"}), 401

    raw, error = fetch_all_pages(
        PLAYLIST_ITEMS_URL.format(playlist_id),
        tokens["access_token"],
        PLAYLIST_ITEMS_PAGE_SIZE,
        MAX_PLAYLIST_ITEMS,
    )
    if error is not None:
        if error.status_code == 403:
            return jsonify({"error": "not_accessible"}), 403
        status, payload = spotify_error(error)
        return jsonify(payload), status

    rows = [simplify_playlist_item(e) for e in raw if e]
    return jsonify({"items": [r for r in rows if r]})


@app.route("/api/shuffle", methods=["POST"])
def set_shuffle():
    """ランダム再生の ON / OFF を切り替える"""
    tokens = get_valid_tokens()
    if not tokens:
        return jsonify({"error": "not authenticated"}), 401

    body = request.get_json(silent=True) or {}
    state = "true" if body.get("state") else "false"

    params = {"state": state}
    if body.get("device_id"):
        params["device_id"] = body["device_id"]

    res = requests.put(
        SHUFFLE_URL,
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
        params=params,
    )
    if res.status_code in (200, 202, 204):
        return jsonify({"ok": True}), 200

    status, err = spotify_error(res)
    return jsonify(err), status


@app.route("/api/play", methods=["POST"])
def play_context():
    """プレイリスト（任意で開始位置の曲を指定）を再生する"""
    tokens = get_valid_tokens()
    if not tokens:
        return jsonify({"error": "not authenticated"}), 401

    body = request.get_json(silent=True) or {}
    payload = {}
    if body.get("context_uri"):
        payload["context_uri"] = body["context_uri"]

    # 開始位置は曲のURI、または0始まりの位置番号のどちらかで指定する。
    # 曲一覧を取得できないプレイリストでも、位置番号なら指定できる。
    if body.get("offset_uri"):
        payload["offset"] = {"uri": body["offset_uri"]}
    elif isinstance(body.get("offset_position"), int) and body["offset_position"] >= 0:
        payload["offset"] = {"position": body["offset_position"]}

    if not payload:
        return jsonify({"error": "context_uri required"}), 400

    res = requests.put(
        PLAY_URL,
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
        params={"device_id": body["device_id"]} if body.get("device_id") else None,
        json=payload,
    )
    if res.status_code in (200, 202, 204):
        return jsonify({"ok": True}), 200

    status, err = spotify_error(res)
    return jsonify(err), status


@app.route("/api/devices")
def devices():
    """再生先として選べる端末の一覧。

    Spotify アプリが起動している端末しか出てこない点に注意。
    将来 Pi に librespot を入れた場合も、ここに1件増えるだけで済む。
    """
    tokens = get_valid_tokens()
    if not tokens:
        return jsonify({"error": "not authenticated"}), 401

    res = requests.get(
        DEVICES_URL,
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    if not res.ok:
        status, payload = spotify_error(res)
        return jsonify(payload), status

    items = [
        {
            "id": d.get("id"),
            "name": d.get("name") or "(名称なし)",
            "type": d.get("type") or "",
            "is_active": bool(d.get("is_active")),
            "is_restricted": bool(d.get("is_restricted")),
        }
        for d in res.json().get("devices", [])
        if d.get("id")
    ]
    return jsonify({"items": items})


@app.route("/api/transfer", methods=["POST"])
def transfer_playback():
    """再生先を切り替える。

    play=False で転送すると、移動先で停止した状態になる。
    再生中に手動で端末を変えたとき、2か所から同時に鳴るのを防げる。
    """
    tokens = get_valid_tokens()
    if not tokens:
        return jsonify({"error": "not authenticated"}), 401

    body = request.get_json(silent=True) or {}
    device_id = body.get("device_id")
    if not device_id:
        return jsonify({"error": "device_id required"}), 400

    res = requests.put(
        PLAYER_URL,
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
        json={"device_ids": [device_id], "play": bool(body.get("play"))},
    )
    if res.status_code in (200, 202, 204):
        return jsonify({"ok": True}), 200

    status, err = spotify_error(res)
    return jsonify(err), status


@app.route("/api/now-playing")
def now_playing():
    """フロントエンド用API"""
    tokens = get_valid_tokens()

    if not tokens:
        return jsonify({"error": "not authenticated", "login_url": "/login"}), 401

    data = fetch_now_playing(tokens["access_token"])

    # 再生中のトラックのみキー情報を追加取得
    if data.get("is_playing") and data.get("type") == "track":
        features = fetch_audio_features(data["track_id"], tokens["access_token"])
        data.update(features)

    return jsonify(data)


# -------------------------------
# 起動
# -------------------------------

if __name__ == "__main__":
    # 再生制御を持つようになったため、既定では外部からの接続を受け付けない。
    # 同一LANの他端末から開きたい場合のみ FLASK_HOST=0.0.0.0 を指定する。
    host = os.getenv("FLASK_HOST", "127.0.0.1")
    debug = os.getenv("FLASK_DEBUG", "1") == "1"
    app.run(host=host, port=5000, debug=debug)

