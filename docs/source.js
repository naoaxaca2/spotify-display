/*
 * 再生情報の取得元を、実行環境に応じて切り替えるレイヤ。
 *
 *  server モード … ローカルの Flask が同じオリジンで動いている場合。
 *                  認証もトークン更新もサーバ側が持つので、/api/now-playing を叩くだけ。
 *
 *  pkce モード   … GitHub Pages などの静的ホスティングの場合。
 *                  Authorization Code with PKCE でブラウザ単体で認証し、
 *                  Spotify Web API を直接叩く。Client Secret は使わない。
 *
 * どちらのモードでも getNowPlaying() は同じ形のオブジェクトを返すので、
 * app.js の描画コードは一切分岐しない。
 */

const NowPlayingSource = (() => {
  // 再生制御には user-modify-playback-state が必要。
  // スコープを変更したら localStorage を消して再ログインすること。
  const SCOPES = "user-read-currently-playing user-modify-playback-state";
  const AUTH_URL = "https://accounts.spotify.com/authorize";
  const TOKEN_URL = "https://accounts.spotify.com/api/token";
  const CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";
  const PLAYER_COMMANDS = {
    play:     ["PUT",  "https://api.spotify.com/v1/me/player/play"],
    pause:    ["PUT",  "https://api.spotify.com/v1/me/player/pause"],
    next:     ["POST", "https://api.spotify.com/v1/me/player/next"],
    previous: ["POST", "https://api.spotify.com/v1/me/player/previous"],
  };
  const AUDIO_FEATURES_URL = "https://api.spotify.com/v1/audio-features/";

  const TOKEN_KEY = "spotify_display_tokens";
  const VERIFIER_KEY = "spotify_display_pkce_verifier";
  const STATE_KEY = "spotify_display_pkce_state";

  const KEY_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

  let mode = null;

  // -------------------------------
  // 共通ユーティリティ
  // -------------------------------

  function redirectUri() {
    // GitHub Pages なら https://<user>.github.io/<repo>/
    // ローカル静的サーバなら http://127.0.0.1:<port>/
    return location.origin + location.pathname.replace(/index\.html$/, "");
  }

  function randomString(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function base64UrlEncode(buffer) {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function codeChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64UrlEncode(digest);
  }

  // -------------------------------
  // トークン管理（PKCE モード）
  // -------------------------------

  function loadTokens() {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY));
    } catch {
      return null;
    }
  }

  function saveTokens(tokens) {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  }

  function clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function clientId() {
    const id = window.SPOTIFY_CONFIG?.clientId;
    if (!id || id.startsWith("PASTE_")) {
      throw new Error("config.js に Client ID が設定されていません");
    }
    return id;
  }

  async function requestToken(params) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`トークン取得に失敗しました (${res.status}) ${detail}`);
    }
    return res.json();
  }

  function storeTokenResponse(data, fallbackRefresh) {
    const tokens = {
      access_token: data.access_token,
      // PKCE では refresh_token がローテーションされることがあるので必ず上書き保存する
      refresh_token: data.refresh_token || fallbackRefresh,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    saveTokens(tokens);
    return tokens;
  }

  async function refreshTokens(tokens) {
    const data = await requestToken({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId(),
    });
    return storeTokenResponse(data, tokens.refresh_token);
  }

  async function getValidTokens() {
    const tokens = loadTokens();
    if (!tokens) return null;
    if (Date.now() > tokens.expires_at - 60_000) {
      return refreshTokens(tokens);
    }
    return tokens;
  }

  // -------------------------------
  // PKCE 認証フロー
  // -------------------------------

  async function startLogin() {
    const verifier = randomString(48);
    const state = randomString(8);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: SCOPES,
      code_challenge_method: "S256",
      code_challenge: await codeChallenge(verifier),
      state,
    });
    location.href = `${AUTH_URL}?${params}`;
  }

  /** リダイレクトで戻ってきた直後なら、認可コードをトークンに交換する */
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const error = params.get("error");
    if (!code && !error) return;

    // URL から認可コードを消す（リロードで再送されるのを防ぐ）
    history.replaceState({}, "", redirectUri());

    if (error) throw new Error(`Spotify が認証を拒否しました: ${error}`);

    const expectedState = sessionStorage.getItem(STATE_KEY);
    if (expectedState && params.get("state") !== expectedState) {
      throw new Error("state が一致しません。認証をやり直してください。");
    }

    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    if (!verifier) throw new Error("認証情報が失われました。もう一度ログインしてください。");

    const data = await requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: clientId(),
      code_verifier: verifier,
    });
    storeTokenResponse(data, null);

    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
  }

  // -------------------------------
  // Spotify レスポンスの整形（app.py と同じ形に揃える）
  // -------------------------------

  function normalize(data) {
    const item = data.item;
    if (!item) return { is_playing: false };

    const type = item.type || "track";
    let title, artists, album, images;
    const result = { is_playing: data.is_playing, type, track_id: item.id };

    if (type === "episode") {
      title = item.name;
      artists = item.show?.name ?? "";
      album = "";
      images = item.images || item.show?.images || [];
    } else {
      title = item.name;
      artists = item.artists.map((a) => a.name).join(", ");
      const albumObj = item.album;
      album = albumObj.name;
      images = albumObj.images || [];
      result.album_type = albumObj.album_type ?? "";
      result.release_date = albumObj.release_date ?? "";
      result.album_artists = (albumObj.artists ?? []).map((a) => a.name).join(", ");
    }

    const totalSeconds = Math.floor((item.duration_ms ?? 0) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");

    return Object.assign(result, {
      title,
      artists,
      album,
      image_url: images.length ? images[0].url : null,
      display_text: `${title}  —  ${artists}`,
      duration: `${minutes}:${seconds}`,
    });
  }

  /** キー情報。Spotify が新規アプリ向けに提供を終了したため、失敗しても黙って諦める */
  async function fetchAudioFeatures(trackId, accessToken) {
    try {
      const res = await fetch(AUDIO_FEATURES_URL + trackId, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return {};
      const data = await res.json();
      if (data.key === -1 || data.mode === -1) return {};
      return { key: `${KEY_NAMES[data.key]} ${data.mode === 1 ? "Major" : "minor"}` };
    } catch {
      return {};
    }
  }

  // -------------------------------
  // モードごとの取得処理
  // -------------------------------

  async function getNowPlayingFromServer() {
    const res = await fetch("api/now-playing", { cache: "no-store" });
    const data = await res.json();
    if (res.status === 401) return { status: "login" };
    if (!res.ok) return { status: "error", message: data.error };
    return { status: "ok", data };
  }

  async function getNowPlayingFromSpotify() {
    const tokens = await getValidTokens();
    if (!tokens) return { status: "login" };

    const res = await fetch(CURRENTLY_PLAYING_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      cache: "no-store",
    });

    if (res.status === 204) return { status: "ok", data: { is_playing: false } };
    if (res.status === 401) {
      clearTokens();
      return { status: "login" };
    }
    if (!res.ok) return { status: "error", message: `Spotify API エラー (${res.status})` };

    const data = normalize(await res.json());
    if (data.is_playing && data.type === "track") {
      Object.assign(data, await fetchAudioFeatures(data.track_id, tokens.access_token));
    }
    return { status: "ok", data };
  }

  // -------------------------------
  // 再生制御
  // -------------------------------

  async function sendCommandToServer(action) {
    const res = await fetch(`api/command/${action}`, { method: "POST" });
    if (res.ok) return { status: "ok" };
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return { status: "login" };
    return { status: "error", reason: body.error };
  }

  async function sendCommandToSpotify(action) {
    const entry = PLAYER_COMMANDS[action];
    if (!entry) return { status: "error", reason: "unknown command" };

    const tokens = await getValidTokens();
    if (!tokens) return { status: "login" };

    const [method, url] = entry;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (res.ok || res.status === 204) return { status: "ok" };
    if (res.status === 401) {
      clearTokens();
      return { status: "login" };
    }
    // 操作対象の端末が定まっていない。Spotify アプリで一度再生すると解消する
    if (res.status === 404) return { status: "error", reason: "no_active_device" };
    if (res.status === 403) return { status: "error", reason: "premium_required" };
    return { status: "error", reason: `spotify ${res.status}` };
  }

  // -------------------------------
  // 公開 API
  // -------------------------------

  /** Flask が同じオリジンに居るかを一度だけ確認する */
  async function detectMode() {
    try {
      const res = await fetch("api/mode", { cache: "no-store" });
      if (res.ok && (await res.json()).mode === "server") return "server";
    } catch {
      /* 静的ホスティングでは 404 かネットワークエラーになる */
    }
    return "pkce";
  }

  async function init() {
    mode = await detectMode();
    if (mode === "pkce") await handleRedirect();
    return mode;
  }

  async function getNowPlaying() {
    return mode === "server" ? getNowPlayingFromServer() : getNowPlayingFromSpotify();
  }

  async function sendCommand(action) {
    return mode === "server" ? sendCommandToServer(action) : sendCommandToSpotify(action);
  }

  function login() {
    if (mode === "server") {
      location.href = "login";
    } else {
      startLogin().catch((err) => alert(err.message));
    }
  }

  return { init, getNowPlaying, sendCommand, login, getMode: () => mode };
})();
