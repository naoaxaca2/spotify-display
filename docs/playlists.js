/*
 * プレイリスト画面。
 *
 * 一覧 → 曲一覧 → タップで再生、の2階層。
 * 所有していないプレイリスト（フォローしているだけのもの）は Spotify が
 * 曲一覧を 403 で拒否するため、その場合は「まるごと再生」だけを提示する。
 *
 * NowPlayingSource が server / pkce の差を吸収しているので、
 * このファイルは実行環境を意識しない。
 */

const tabsEl = document.getElementById("tabs");
const tabNowEl = document.getElementById("tab-now");
const tabPlaylistsEl = document.getElementById("tab-playlists");
const tabSettingsEl = document.getElementById("tab-settings");
const viewNowEl = document.getElementById("view-now");
const viewPlaylistsEl = document.getElementById("view-playlists");
const viewSettingsEl = document.getElementById("view-settings");

const plListPaneEl = document.getElementById("pl-list-pane");
const plTracksPaneEl = document.getElementById("pl-tracks-pane");
const plListEl = document.getElementById("pl-list");
const plTracksEl = document.getElementById("pl-tracks");
const plTitleEl = document.getElementById("pl-title");
const plBackEl = document.getElementById("pl-back");
const plPlayAllEl = document.getElementById("pl-play-all");
const plReloadEl = document.getElementById("pl-reload");
const plShuffleEl = document.getElementById("pl-shuffle");

let playlistsLoaded = false;
let currentPlaylist = null;
// 開いているプレイリストの曲一覧。ランダム開始位置の決定に使う
let currentTracks = [];

// -------------------------------
// ランダム再生トグル
//
// Spotify 側の現在値を読むには user-read-playback-state が要るため、
// ここでは画面側で状態を持ち、再生を開始する直前に必ず送り直す。
// 再読み込みしても選択が残るよう localStorage に保存する。
// -------------------------------

const SHUFFLE_KEY = "spotify_display_shuffle";

function loadShufflePref() {
  try {
    return localStorage.getItem(SHUFFLE_KEY) === "1";
  } catch {
    return false;
  }
}

let shuffleOn = loadShufflePref();

function renderShuffleButton() {
  plShuffleEl.classList.toggle("is-on", shuffleOn);
  plShuffleEl.setAttribute("aria-checked", String(shuffleOn));
}

plShuffleEl.addEventListener("click", () => {
  shuffleOn = !shuffleOn;
  try {
    localStorage.setItem(SHUFFLE_KEY, shuffleOn ? "1" : "0");
  } catch {
    /* プライベートモードなどで保存できなくても動作は続ける */
  }
  renderShuffleButton();
});

renderShuffleButton();

// -------------------------------
// タブ切り替え
// -------------------------------

const TABS = {
  now: { tab: tabNowEl, view: viewNowEl },
  playlists: { tab: tabPlaylistsEl, view: viewPlaylistsEl },
  settings: { tab: tabSettingsEl, view: viewSettingsEl },
};

function showTab(name) {
  for (const [key, { tab, view }] of Object.entries(TABS)) {
    const active = key === name;
    tab.classList.toggle("is-active", active);
    view.classList.toggle("is-active", active);
  }

  // 初回表示時にだけ読み込む（毎回叩くとレート制限に近づくため）
  if (name === "playlists" && !playlistsLoaded) loadPlaylists();
}

for (const name of Object.keys(TABS)) {
  TABS[name].tab.addEventListener("click", () => showTab(name));
}

/** 未ログイン時はタブを隠して再生中画面に固定する */
function setTabsVisible(visible) {
  tabsEl.hidden = !visible;
  if (!visible) showTab("now");
}

// -------------------------------
// 一覧
// -------------------------------

function renderMessage(container, text) {
  container.classList.add("is-message");
  container.replaceChildren(
    Object.assign(document.createElement("div"), {
      className: "pl-empty",
      textContent: text,
    })
  );
}

async function loadPlaylists() {
  renderMessage(plListEl, "読み込み中…");

  let result;
  try {
    result = await NowPlayingSource.getPlaylists();
  } catch {
    renderMessage(plListEl, "通信エラー");
    return;
  }

  if (result.status === "login") {
    renderMessage(plListEl, "ログインが必要です");
    return;
  }
  if (result.status !== "ok") {
    renderMessage(
      plListEl,
      COMMAND_ERRORS[result.reason] || "プレイリストを取得できませんでした"
    );
    return;
  }
  if (!result.items.length) {
    renderMessage(plListEl, "プレイリストがありません");
    playlistsLoaded = true;
    return;
  }

  plListEl.classList.remove("is-message");
  plListEl.replaceChildren(...result.items.map(buildPlaylistRow));
  playlistsLoaded = true;
}

/** サムネイル。画像が無い、または読み込めない場合は代替の枠を出す */
function buildThumb(imageUrl) {
  if (!imageUrl) {
    const placeholder = document.createElement("span");
    placeholder.className = "pl-thumb pl-thumb-empty";
    placeholder.textContent = "♪";
    return placeholder;
  }
  const img = document.createElement("img");
  img.className = "pl-thumb";
  img.src = imageUrl;
  img.alt = "";
  // 一覧は行数が多くなるので、見えている分だけ読み込ませる
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => {
    img.replaceWith(buildThumb(null));
  });
  return img;
}

/** サムネ + 2行テキストの共通レイアウト */
function buildRow(imageUrl, mainText, subText) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "pl-row";

  const text = document.createElement("span");
  text.className = "pl-row-text";

  const main = document.createElement("span");
  main.className = "pl-row-main";
  main.textContent = mainText;

  const sub = document.createElement("span");
  sub.className = "pl-row-sub";
  sub.textContent = subText;

  text.append(main, sub);
  row.append(buildThumb(imageUrl), text);
  // 「ジャケットのみ」表示では文字が隠れるため、名前を属性で残す
  row.title = mainText;
  return row;
}

function buildPlaylistRow(pl) {
  const sub = [pl.owner, pl.total != null ? `${pl.total} 曲` : ""]
    .filter(Boolean)
    .join(" · ");
  const row = buildRow(pl.image_url, pl.name, sub);
  row.addEventListener("click", () => openPlaylist(pl));
  return row;
}

// -------------------------------
// 曲一覧
// -------------------------------

function showPane(pane) {
  plListPaneEl.hidden = pane !== "list";
  plTracksPaneEl.hidden = pane !== "tracks";
}

plBackEl.addEventListener("click", () => showPane("list"));
plReloadEl.addEventListener("click", () => {
  playlistsLoaded = false;
  loadPlaylists();
});

async function openPlaylist(pl) {
  currentPlaylist = pl;
  currentTracks = [];
  plTitleEl.textContent = pl.name;
  plTracksEl.scrollTop = 0;
  renderMessage(plTracksEl, "読み込み中…");
  showPane("tracks");

  let result;
  try {
    result = await NowPlayingSource.getPlaylistItems(pl.id);
  } catch {
    renderMessage(plTracksEl, "通信エラー");
    return;
  }

  if (result.status === "login") {
    renderMessage(plTracksEl, "ログインが必要です");
    return;
  }
  // 自分が所有していないプレイリストは曲一覧を取得できない仕様
  if (result.status === "forbidden") {
    renderMessage(
      plTracksEl,
      "このプレイリストは曲一覧を取得できません（Spotify の制限）。右上の「まるごと再生」から再生できます。"
    );
    return;
  }
  if (result.status !== "ok") {
    renderMessage(plTracksEl, "曲一覧を取得できませんでした");
    return;
  }
  if (!result.items.length) {
    renderMessage(plTracksEl, "曲がありません");
    return;
  }

  currentTracks = result.items;
  plTracksEl.classList.remove("is-message");
  plTracksEl.replaceChildren(...result.items.map(buildTrackRow));
}

function buildTrackRow(track) {
  const sub = [track.artists, track.duration].filter(Boolean).join(" · ");
  const row = buildRow(track.image_url, track.name, sub);
  // プレイリストを文脈として渡し、その中の1曲から開始する
  row.addEventListener("click", () =>
    startPlayback(currentPlaylist.uri, { uri: track.uri }, track.name)
  );
  return row;
}

/**
 * まるごと再生の開始位置。
 *
 * シャッフルを設定するだけでは1曲目が必ず先頭になるため、開始位置自体をずらす。
 * 曲一覧を取得できていれば URI で、できない（所有していない）プレイリストでも
 * 曲数が分かれば位置番号で指定できる。
 */
function randomStartOffset() {
  if (!shuffleOn) return null;

  if (currentTracks.length) {
    const track = currentTracks[Math.floor(Math.random() * currentTracks.length)];
    return { uri: track.uri };
  }
  if (currentPlaylist?.total > 0) {
    return { position: Math.floor(Math.random() * currentPlaylist.total) };
  }
  return null;
}

plPlayAllEl.addEventListener("click", () => {
  if (currentPlaylist) {
    startPlayback(currentPlaylist.uri, randomStartOffset(), currentPlaylist.name);
  }
});

// -------------------------------
// 再生
// -------------------------------

async function startPlayback(contextUri, offset, label) {
  let result;
  let shuffleFailed = false;
  try {
    // 端末が見つからなければ withDevice が一度だけ選び直して再試行する。
    result = await withDevice(async (deviceId) => {
      const playResult = await NowPlayingSource.playContext(contextUri, offset, deviceId);
      if (playResult.status !== "ok") return playResult;

      // シャッフルは再生開始の「後」に設定する。
      // 先に設定しても、新しいコンテキストの再生開始でキューが組み直され、
      // 設定が引き継がれないため順番どおりに再生されてしまう。
      const shuffleResult = await NowPlayingSource.setShuffle(shuffleOn, deviceId);
      // すでに音は鳴っているので、ここでの失敗は再生自体の失敗にはしない
      shuffleFailed = shuffleResult.status !== "ok";
      return playResult;
    });
  } catch {
    showToast("通信エラー");
    return;
  }

  if (result.status === "login") {
    showToast("ログインが必要です");
    return;
  }
  if (result.status !== "ok") {
    showToast(COMMAND_ERRORS[result.reason] || "再生を開始できませんでした");
    return;
  }

  if (shuffleFailed) {
    showToast(`${label} を再生します（ランダム設定は反映できませんでした）`);
  } else {
    showToast(`${label} を${shuffleOn ? "ランダムで" : ""}再生します`);
  }
  // 再生中画面へ戻し、反映を待って取り直す
  showTab("now");
  setTimeout(fetchNowPlaying, 500);
  setTimeout(fetchNowPlaying, 1600);
}
