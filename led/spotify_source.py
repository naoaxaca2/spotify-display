"""Spotify から再生中の曲を取る。

app.py のトークン管理をそのまま持ってきている。認証情報とトークンは
リポジトリ直下の .env / token_store.json を Web 版と共用するので、
ログインは Web 版で一度済ませればよい。LED 版に認証画面はない。
"""

import base64
import json
import logging
import time

import requests
from dotenv import load_dotenv

import config

load_dotenv(config.REPO_ROOT / ".env")

import os  # noqa: E402  load_dotenv のあとに読む

CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")

TOKEN_FILE = config.REPO_ROOT / "token_store.json"

TOKEN_URL = "https://accounts.spotify.com/api/token"
CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing"

# 通信のタイムアウト。ここを指定しないと、返らない相手に当たったときに
# 描画ループごと止まる
TIMEOUT = 10


class NotLoggedIn(Exception):
    """token_store.json が無い、またはリフレッシュトークンが失効している"""


# -------------------------------
# トークン管理
# -------------------------------

def load_tokens():
    """保存済みトークンを読み込む。壊れていれば未ログイン扱い"""
    if not TOKEN_FILE.exists():
        return None
    try:
        return json.loads(TOKEN_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        logging.warning("token_store.json を読めませんでした。未ログインとして扱います")
        return None


def save_tokens(tokens):
    """トークンをファイル保存。

    同じファイルを Flask 版も読み書きするので、書きかけを読ませないよう
    一時ファイルに書いてから置き換える。
    """
    tmp = TOKEN_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(tokens, indent=2))
    tmp.replace(TOKEN_FILE)


def basic_auth_header():
    raw = f"{CLIENT_ID}:{CLIENT_SECRET}".encode()
    return {"Authorization": f"Basic {base64.b64encode(raw).decode()}"}


def token_expired(tokens):
    return time.time() > tokens.get("expires_at", 0) - 60


def refresh_access_token(tokens):
    """refresh_token を使ってアクセストークンを更新する。

    失敗したら None。Flask 版と違ってトークンを消さない。消すと Web 版まで
    ログアウトさせてしまうので、判断は利用者に任せて画面に状態を出す。
    """
    response = requests.post(
        TOKEN_URL,
        headers=basic_auth_header(),
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=TIMEOUT,
    )

    if not response.ok:
        # Flask 版が先に更新してリフレッシュトークンが差し替わった直後だと
        # ここに来る。ファイルを読み直して、新しいほうで一度やり直す。
        latest = load_tokens()
        if latest and latest.get("refresh_token") != tokens.get("refresh_token"):
            logging.info("トークンが別プロセスで更新されていました。読み直して再試行します")
            return latest if not token_expired(latest) else None

        logging.warning(
            "トークン更新に失敗しました (%s): %s",
            response.status_code,
            response.text[:200],
        )
        return None

    data = response.json()
    new_tokens = {
        "access_token": data["access_token"],
        "expires_at": time.time() + data["expires_in"],
        "refresh_token": data.get("refresh_token", tokens["refresh_token"]),
    }
    save_tokens(new_tokens)
    return new_tokens


def get_valid_tokens():
    tokens = load_tokens()
    if not tokens:
        return None
    if token_expired(tokens):
        return refresh_access_token(tokens)
    return tokens


# -------------------------------
# 再生中の曲
# -------------------------------

def fetch_now_playing():
    """再生中の曲を取る。

    戻り値は dict。
      {"state": "playing", "title": ..., "artists": ...}
      {"state": "idle"}                      再生していない
      {"state": "error", "message": ...}     未ログイン・通信不良など

    例外は投げない。描画ループを止めないため、異常も戻り値で表す。
    """
    tokens = get_valid_tokens()
    if not tokens:
        return {"state": "error", "message": "未ログイン"}

    try:
        res = requests.get(
            CURRENTLY_PLAYING_URL,
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
            timeout=TIMEOUT,
        )
    except requests.RequestException as err:
        logging.warning("Spotify に接続できませんでした: %s", err)
        return {"state": "error", "message": "接続不可"}

    # 何も再生していない
    if res.status_code == 204:
        return {"state": "idle"}

    if res.status_code == 401:
        return {"state": "error", "message": "未ログイン"}

    if res.status_code == 429:
        # Retry-After は秒。呼び出し側が間隔を空ける
        wait = res.headers.get("Retry-After", "?")
        logging.warning("レート制限に当たりました。%s 秒待ちます", wait)
        return {"state": "error", "message": "混雑中"}

    if not res.ok:
        logging.warning("Spotify が %s を返しました", res.status_code)
        return {"state": "error", "message": f"エラー {res.status_code}"}

    try:
        data = res.json()
    except ValueError:
        return {"state": "idle"}

    item = data.get("item")
    if not item:
        return {"state": "idle"}

    if item.get("type") == "episode":
        title = item.get("name", "")
        artists = item.get("show", {}).get("name", "")
    else:
        title = item.get("name", "")
        artists = ", ".join(a["name"] for a in item.get("artists", []))

    return {
        "state": "playing",
        "is_playing": data.get("is_playing", False),
        "title": title,
        "artists": artists,
    }
