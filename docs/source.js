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
  const SCOPES = [
    "user-read-currently-playing",
    "user-modify-playback-state",
    "playlist-read-private",
    "playlist-read-collaborative",
    // 端末一覧の取得に必要
    "user-read-playback-state",
  ].join(" ");
  const AUTH_URL = "https://accounts.spotify.com/authorize";
  const TOKEN_URL = "https://accounts.spotify.com/api/token";
  const CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";
  const PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists";
  // 2026-02 の変更で /tracks → /items にリネームされた
  const PLAYLIST_ITEMS_URL = "https://api.spotify.com/v1/playlists/{id}/items";
  // 1リクエストの上限は プレイリスト50件 / 曲100件。
  // それ以上はページングが必要なので、取得する総数の上限もここで決めておく。
  const PLAYLISTS_PAGE_SIZE = 50;
  const PLAYLIST_ITEMS_PAGE_SIZE = 100;
  const MAX_PLAYLISTS = 500;
  const MAX_PLAYLIST_ITEMS = 500;
  const PLAY_URL = "https://api.spotify.com/v1/me/player/play";
  const SHUFFLE_URL = "https://api.spotify.com/v1/me/player/shuffle";
  const DEVICES_URL = "https://api.spotify.com/v1/me/player/devices";
  // 再生先の転送
  const PLAYER_URL = "https://api.spotify.com/v1/me/player";
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

  async function sendCommandToServer(action, deviceId) {
    const res = await fetch(`api/command/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId || null }),
    });
    if (res.ok) return { status: "ok" };
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return { status: "login" };
    return { status: "error", reason: body.error };
  }

  function withDeviceParam(url, deviceId) {
    if (!deviceId) return url;
    return url + (url.includes("?") ? "&" : "?") + `device_id=${encodeURIComponent(deviceId)}`;
  }

  async function sendCommandToSpotify(action, deviceId) {
    const entry = PLAYER_COMMANDS[action];
    if (!entry) return { status: "error", reason: "unknown command" };

    const tokens = await getValidTokens();
    if (!tokens) return { status: "login" };

    const [method, url] = entry;
    const res = await fetch(withDeviceParam(url, deviceId), {
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
    if (res.status === 403) return { status: "error", reason: await classifyForbidden(res) };
    return { status: "error", reason: `spotify ${res.status}` };
  }

  // -------------------------------
  // プレイリスト
  // -------------------------------

  /**
   * 一覧のサムネに使う画像を選ぶ。
   * Spotify は複数サイズを返すので、64px 以上で最小のものを使い、
   * Pi Zero でのダウンロードと描画の負荷を抑える。
   */
  function pickThumbnail(images) {
    if (!images?.length) return null;
    const sized = images.filter((i) => i.height);
    if (!sized.length) return images[images.length - 1].url;
    const ascending = [...sized].sort((a, b) => a.height - b.height);
    return (ascending.find((i) => i.height >= 64) ?? ascending[ascending.length - 1]).url;
  }

  function simplifyPlaylist(pl) {
    // playlist オブジェクトの tracks も 2026-02 に items へリネームされた。
    // 移行期のため両方を見る。
    const counts = pl.items || pl.tracks || {};
    return {
      id: pl.id,
      name: pl.name || "(名称なし)",
      uri: pl.uri,
      owner: pl.owner?.display_name || "",
      total: counts.total,
      image_url: pickThumbnail(pl.images),
    };
  }

  function simplifyPlaylistItem(entry) {
    // PlaylistTrackObject の track も item にリネームされたため両対応
    const track = entry.item || entry.track;
    if (!track?.uri) return null;
    const isEpisode = track.type === "episode";
    const artists = isEpisode
      ? track.show?.name ?? ""
      : (track.artists ?? []).map((a) => a.name).join(", ");
    const images = isEpisode ? track.images ?? track.show?.images : track.album?.images;
    const totalSeconds = Math.floor((track.duration_ms ?? 0) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return {
      uri: track.uri,
      name: track.name ?? "",
      artists,
      duration: `${minutes}:${seconds}`,
      image_url: pickThumbnail(images),
    };
  }

  /** 403 の理由を読み分ける。Premium 不足とスコープ不足では対処が違う */
  async function classifyForbidden(res) {
    try {
      const body = await res.clone().json();
      if (body?.error?.reason === "PREMIUM_REQUIRED") return "premium_required";
    } catch {
      /* 本文が読めない場合はスコープ不足として扱う */
    }
    return "insufficient_scope";
  }

  async function authorizedGet(url) {
    const tokens = await getValidTokens();
    if (!tokens) return { status: "login" };
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      cache: "no-store",
    });
    if (res.status === 401) {
      clearTokens();
      return { status: "login" };
    }
    return { status: res.ok ? "ok" : "error", res };
  }

  /**
   * ページングして全件集める。
   * 戻り値は { status: "ok", items } か、失敗時のステータス。
   */
  async function fetchAllPages(baseUrl, pageSize, maxItems) {
    const items = [];
    let offset = 0;

    while (items.length < maxItems) {
      const url = `${baseUrl}?limit=${pageSize}&offset=${offset}`;
      const r = await authorizedGet(url);
      if (r.status !== "ok") return r;

      const data = await r.res.json();
      const page = data.items ?? [];
      items.push(...page);

      // next が無い、または空ページなら終わり
      if (!data.next || !page.length) break;
      offset += pageSize;
    }

    return { status: "ok", items: items.slice(0, maxItems) };
  }

  async function getPlaylistsFromSpotify() {
    const r = await fetchAllPages(PLAYLISTS_URL, PLAYLISTS_PAGE_SIZE, MAX_PLAYLISTS);
    if (r.status !== "ok") {
      if (r.status === "login") return r;
      if (r.res?.status === 403) return { status: "error", reason: await classifyForbidden(r.res) };
      return { status: "error" };
    }
    return { status: "ok", items: r.items.filter(Boolean).map(simplifyPlaylist) };
  }

  async function getPlaylistItemsFromSpotify(id) {
    const r = await fetchAllPages(
      PLAYLIST_ITEMS_URL.replace("{id}", id),
      PLAYLIST_ITEMS_PAGE_SIZE,
      MAX_PLAYLIST_ITEMS
    );
    if (r.status === "login") return r;
    if (r.status !== "ok") {
      // 所有していないプレイリストは 403。呼び出し元が「まるごと再生」に切り替える
      if (r.res?.status === 403) return { status: "forbidden" };
      return { status: "error" };
    }
    return { status: "ok", items: r.items.map(simplifyPlaylistItem).filter(Boolean) };
  }

  /** offset は { uri } か { position } のどちらか。null なら先頭から */
  async function playContextOnSpotify(contextUri, offset, deviceId) {
    const tokens = await getValidTokens();
    if (!tokens) return { status: "login" };

    const payload = { context_uri: contextUri };
    if (offset?.uri) payload.offset = { uri: offset.uri };
    else if (Number.isInteger(offset?.position) && offset.position >= 0) {
      payload.offset = { position: offset.position };
    }

    const res = await fetch(withDeviceParam(PLAY_URL, deviceId), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok || res.status === 204) return { status: "ok" };
    if (res.status === 401) {
      clearTokens();
      return { status: "login" };
    }
    if (res.status === 404) return { status: "error", reason: "no_active_device" };
    if (res.status === 403) return { status: "error", reason: "premium_required" };
    return { status: "error", reason: `spotify ${res.status}` };
  }

  async function setShuffleOnSpotify(state, deviceId) {
    const tokens = await getValidTokens();
    if (!tokens) return { status: "login" };

    const url = withDeviceParam(`${SHUFFLE_URL}?state=${state ? "true" : "false"}`, deviceId);
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (res.ok || res.status === 204) return { status: "ok" };
    if (res.status === 401) {
      clearTokens();
      return { status: "login" };
    }
    if (res.status === 404) return { status: "error", reason: "no_active_device" };
    if (res.status === 403) return { status: "error", reason: await classifyForbidden(res) };
    return { status: "error", reason: `spotify ${res.status}` };
  }

  async function setShuffleOnServer(state, deviceId) {
    const res = await fetch("api/shuffle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: Boolean(state), device_id: deviceId || null }),
    });
    if (res.ok) return { status: "ok" };
    if (res.status === 401) return { status: "login" };
    const body = await res.json().catch(() => ({}));
    return { status: "error", reason: body.error };
  }

  async function getPlaylistsFromServer() {
    const res = await fetch("api/playlists", { cache: "no-store" });
    if (res.status === 401) return { status: "login" };
    if (!res.ok) return { status: "error" };
    return { status: "ok", items: (await res.json()).items ?? [] };
  }

  async function getPlaylistItemsFromServer(id) {
    const res = await fetch(`api/playlists/${id}/items`, { cache: "no-store" });
    if (res.status === 401) return { status: "login" };
    if (res.status === 403) return { status: "forbidden" };
    if (!res.ok) return { status: "error" };
    return { status: "ok", items: (await res.json()).items ?? [] };
  }

  async function playContextOnServer(contextUri, offset, deviceId) {
    const res = await fetch("api/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context_uri: contextUri,
        offset_uri: offset?.uri ?? null,
        offset_position: Number.isInteger(offset?.position) ? offset.position : null,
        device_id: deviceId || null,
      }),
    });
    if (res.ok) return { status: "ok" };
    if (res.status === 401) return { status: "login" };
    const body = await res.json().catch(() => ({}));
    return { status: "error", reason: body.error };
  }

  // -------------------------------
  // 再生先の端末
  // -------------------------------

  function simplifyDevice(d) {
    return {
      id: d.id,
      name: d.name || "(名称なし)",
      type: d.type || "",
      is_active: Boolean(d.is_active),
      is_restricted: Boolean(d.is_restricted),
    };
  }

  async function getDevicesFromSpotify() {
    const r = await authorizedGet(DEVICES_URL);
    if (r.status !== "ok") {
      if (r.status === "login") return r;
      if (r.res?.status === 403) return { status: "error", reason: await classifyForbidden(r.res) };
      return { status: "error" };
    }
    const data = await r.res.json();
    return {
      status: "ok",
      items: (data.devices ?? []).filter((d) => d?.id).map(simplifyDevice),
    };
  }

  async function getDevicesFromServer() {
    const res = await fetch("api/devices", { cache: "no-store" });
    if (res.status === 401) return { status: "login" };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { status: "error", reason: body.error };
    }
    return { status: "ok", items: (await res.json()).items ?? [] };
  }

  async function transferOnSpotify(deviceId, play) {
    const tokens = await getValidTokens();
    if (!tokens) return { status: "login" };

    const res = await fetch(PLAYER_URL, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_ids: [deviceId], play: Boolean(play) }),
    });

    if (res.ok || res.status === 204) return { status: "ok" };
    if (res.status === 401) {
      clearTokens();
      return { status: "login" };
    }
    if (res.status === 404) return { status: "error", reason: "no_active_device" };
    if (res.status === 403) return { status: "error", reason: await classifyForbidden(res) };
    return { status: "error", reason: `spotify ${res.status}` };
  }

  async function transferOnServer(deviceId, play) {
    const res = await fetch("api/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, play: Boolean(play) }),
    });
    if (res.ok) return { status: "ok" };
    if (res.status === 401) return { status: "login" };
    const body = await res.json().catch(() => ({}));
    return { status: "error", reason: body.error };
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

  async function sendCommand(action, deviceId) {
    return mode === "server"
      ? sendCommandToServer(action, deviceId)
      : sendCommandToSpotify(action, deviceId);
  }

  async function getDevices() {
    return mode === "server" ? getDevicesFromServer() : getDevicesFromSpotify();
  }

  async function transferPlayback(deviceId, play) {
    return mode === "server"
      ? transferOnServer(deviceId, play)
      : transferOnSpotify(deviceId, play);
  }

  async function getPlaylists() {
    return mode === "server" ? getPlaylistsFromServer() : getPlaylistsFromSpotify();
  }

  async function getPlaylistItems(id) {
    return mode === "server" ? getPlaylistItemsFromServer(id) : getPlaylistItemsFromSpotify(id);
  }

  async function setShuffle(state, deviceId) {
    return mode === "server"
      ? setShuffleOnServer(state, deviceId)
      : setShuffleOnSpotify(state, deviceId);
  }

  async function playContext(contextUri, offset, deviceId) {
    return mode === "server"
      ? playContextOnServer(contextUri, offset, deviceId)
      : playContextOnSpotify(contextUri, offset, deviceId);
  }

  function login() {
    if (mode === "server") {
      location.href = "login";
    } else {
      startLogin().catch((err) => alert(err.message));
    }
  }

  return {
    init,
    getNowPlaying,
    sendCommand,
    getPlaylists,
    getPlaylistItems,
    playContext,
    setShuffle,
    getDevices,
    transferPlayback,
    login,
    getMode: () => mode,
  };
})();
