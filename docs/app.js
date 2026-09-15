const statusEl = document.getElementById("status");
const marqueeEl = document.getElementById("marquee");
const coverEl = document.getElementById("cover");
const albumMetaEl = document.getElementById("album-meta");
const albumTypeEl = document.getElementById("album-type");
const albumNameEl = document.getElementById("album-name");
const albumArtistsEl = document.getElementById("album-artists");
const releaseDateEl = document.getElementById("release-date");
const trackKeyEl = document.getElementById("track-key");
const trackDurationEl = document.getElementById("track-duration");
const detailKeyEl = document.getElementById("detail-key");
const detailDurationEl = document.getElementById("detail-duration");
const controlsEl = document.getElementById("controls");
const btnPrevEl = document.getElementById("btn-prev");
const btnPlayEl = document.getElementById("btn-play");
const btnNextEl = document.getElementById("btn-next");
const iconPlayEl = document.getElementById("icon-play");
const iconPauseEl = document.getElementById("icon-pause");
const toastEl = document.getElementById("toast");
const loginBoxEl = document.getElementById("login-box");
const loginButtonEl = document.getElementById("login-button");

function showLoginBox(visible) {
  loginBoxEl.hidden = !visible;
}

const ALBUM_TYPE_LABEL = {
  album: "ALBUM",
  single: "SINGLE",
  compilation: "COMPILATION",
};

function formatReleaseDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} / ${parts[1]}`;
  return `${parts[0]} / ${parts[1]} / ${parts[2]}`;
}

function setAlbumInfo(data) {
  albumTypeEl.textContent = ALBUM_TYPE_LABEL[data.album_type] ?? data.album_type ?? "";
  albumNameEl.textContent = data.album ?? "";
  albumArtistsEl.textContent = data.album_artists ?? "";
  releaseDateEl.textContent = formatReleaseDate(data.release_date);
  albumMetaEl.style.display = "";
}

function clearAlbumInfo() {
  albumMetaEl.style.display = "none";
}

function setTrackDetails(data) {
  // キー（取得できない曲は非表示）
  if (data.key) {
    trackKeyEl.textContent = data.key;
    detailKeyEl.style.display = "";
  } else {
    trackKeyEl.textContent = "";
    detailKeyEl.style.display = "none";
  }
  // 曲の長さ
  if (data.duration) {
    trackDurationEl.textContent = data.duration;
    detailDurationEl.style.display = "";
  } else {
    detailDurationEl.style.display = "none";
  }
}

function clearTrackDetails() {
  detailKeyEl.style.display = "none";
  detailDurationEl.style.display = "none";
}

const SCROLL_SPEED = 90; // px/s（表示幅 800px のときの速度。上げると速くなる）
// 速度を決める基準幅。表示幅がこれより広いと、その比率で自動的に速くなる。
// 帯型ディスプレイで「曲名が右から出てくるまで延々待つ」のを防ぐための調整。
const SPEED_REFERENCE_WIDTH = 800;
// コンテナ幅の何割分、最後の文字が消えたあとも流し続けるか
const TAIL_RATIO = 0.3;

let rafId = null;
let marqueeX = null;
let lastTs = null;
let currentMarqueeText = null;

function stopMarquee() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  marqueeX = null;
  lastTs = null;
  // transform はここではリセットしない（画面フラッシュの原因になる）
}

function tickMarquee(ts) {
  // 毎フレーム寸法を読み直す → ウィンドウリサイズにも自動対応
  const containerW = marqueeEl.parentElement.offsetWidth;
  const textW = marqueeEl.scrollWidth; // flex-shrink を無効化した上で scrollWidth を使う
  const startX = containerW;                          // 右端の外から入る
  const endX = -(textW + containerW * TAIL_RATIO);   // テキスト全体が消えた少し先

  if (marqueeX === null) marqueeX = startX;

  if (lastTs !== null) {
    const dt = (ts - lastTs) / 1000;
    marqueeX -= scrollSpeedFor(containerW) * dt;
    if (marqueeX <= endX) {
      marqueeX = startX; // 先頭に戻る
    }
  }
  lastTs = ts;

  marqueeEl.style.transform = `translateX(${marqueeX}px)`;
  rafId = requestAnimationFrame(tickMarquee);
}


// -------------------------------
// 再生制御
// -------------------------------

let isPlayingNow = false;
// ボタンを押した直後、Spotify 側の状態が追いつくまでの「先に見せる」値。
// これが無いと、押してから最大5秒間アイコンが元に戻ったままになる。
let pendingPlayState = null;
let pendingUntil = 0;
let toastTimer = null;

const COMMAND_ERRORS = {
  no_active_device: "操作できる端末がありません。Spotify アプリで一度再生してください",
  premium_required: "再生制御には Spotify Premium が必要です",
  insufficient_scope: "権限が不足しています。token_store.json を削除して再ログインしてください",
};

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}

function renderPlayIcon(isPlaying) {
  isPlayingNow = isPlaying;
  iconPlayEl.hidden = isPlaying;
  iconPauseEl.hidden = !isPlaying;
}

/** ポーリング結果を反映する。押した直後の表示は一定時間だけ優先する */
function applyPlayState(fromServer) {
  if (pendingPlayState !== null) {
    if (fromServer === pendingPlayState || Date.now() > pendingUntil) {
      pendingPlayState = null; // Spotify 側が追いついた、または諦める
    } else {
      return;
    }
  }
  renderPlayIcon(fromServer);
}

function setButtonsEnabled(enabled) {
  for (const el of [btnPrevEl, btnPlayEl, btnNextEl]) el.disabled = !enabled;
}

async function runCommand(action) {
  setButtonsEnabled(false);
  try {
    const result = await withDevice((deviceId) =>
      NowPlayingSource.sendCommand(action, deviceId)
    );

    if (result.status === "login") {
      showToast("ログインが必要です");
      return;
    }
    if (result.status === "error") {
      showToast(COMMAND_ERRORS[result.reason] || "操作に失敗しました");
      // 失敗したので楽観的な表示を取り消す
      pendingPlayState = null;
      fetchNowPlaying();
      return;
    }

    // Spotify 側の反映には少し間があるので、2回に分けて取り直す
    setTimeout(fetchNowPlaying, 400);
    setTimeout(fetchNowPlaying, 1500);
  } catch (err) {
    showToast("通信エラー");
  } finally {
    setButtonsEnabled(true);
  }
}

btnPlayEl.addEventListener("click", () => {
  const wantPlay = !isPlayingNow;
  pendingPlayState = wantPlay;
  pendingUntil = Date.now() + 3000;
  renderPlayIcon(wantPlay); // 押した瞬間にアイコンを切り替える
  runCommand(wantPlay ? "play" : "pause");
});

btnPrevEl.addEventListener("click", () => runCommand("previous"));
btnNextEl.addEventListener("click", () => runCommand("next"));

function scrollSpeedFor(containerW) {
  // 表示幅に比例して速くする。狭い画面では従来どおり 90px/s のまま
  return SCROLL_SPEED * Math.max(1, containerW / SPEED_REFERENCE_WIDTH);
}

function startMarquee() {
  stopMarquee();

  const containerW = marqueeEl.parentElement.offsetWidth;
  const textW = marqueeEl.scrollWidth;

  // 収まりきるなら静止表示にする。
  // 帯型ディスプレイでは大半の曲名がここに入り、無駄なスクロール待ちが消える。
  // requestAnimationFrame も回さないので Pi Zero 2 W の負荷も下がる。
  if (textW <= containerW) {
    marqueeEl.style.transform = "translateX(0)";
    return;
  }

  rafId = requestAnimationFrame(tickMarquee);
}

function setMarqueeText(text) {
  // テキストが変わっていなければ何もしない（5秒ポーリングで毎回呼ばれるため必須）
  if (text === currentMarqueeText) return;
  currentMarqueeText = text;

  stopMarquee();
  // テキスト変更中に画面外へ退避
  marqueeEl.style.transform = `translateX(9999px)`;
  marqueeEl.textContent = text;
  // 2フレーム待ってレイアウトを確定させてから開始
  requestAnimationFrame(() => requestAnimationFrame(startMarquee));
}

// 静止表示中は rAF が止まっているため、リサイズは明示的に拾い直す
window.addEventListener("resize", () => {
  if (currentMarqueeText !== null) startMarquee();
});

function setCover(url) {
  if (url) {
    coverEl.src = url;
    coverEl.style.display = "block";
  } else {
    coverEl.removeAttribute("src");
    coverEl.style.display = "none";
  }
}

async function fetchNowPlaying() {
  try {
    const result = await NowPlayingSource.getNowPlaying();

    if (result.status === "login") {
      statusEl.textContent = "Spotify ログインが必要です";
      statusEl.className = "status error";
      setMarqueeText("画面下のログインボタンから Spotify にログインしてください。");
      setCover(null);
      clearAlbumInfo();
      clearTrackDetails();
      showLoginBox(true);
      controlsEl.hidden = true;
      setTabsVisible(false); // 未ログインではプレイリストも使えない
      return;
    }

    showLoginBox(false);
    controlsEl.hidden = false;
    setTabsVisible(true);

    if (result.status === "error") {
      statusEl.textContent = "取得エラー";
      statusEl.className = "status error";
      setMarqueeText(result.message || "現在再生情報の取得に失敗しました。");
      setCover(null);
      clearAlbumInfo();
      clearTrackDetails();
      return;
    }

    const data = result.data;

    applyPlayState(Boolean(data.is_playing));

    // 一時停止中も Spotify は曲情報を返してくる。
    // 本当に何も無いとき（204）だけ display_text が存在しない。
    const hasTrack = Boolean(data.display_text);

    if (!data.is_playing) {
      if (hasTrack) {
        // 一時停止：曲の表示はそのまま残し、ステータスだけ切り替える
        statusEl.textContent = "PAUSED";
        statusEl.className = "status paused";
        setMarqueeText(data.display_text);
        setCover(data.image_url || null);
        if (data.type !== "episode") {
          setAlbumInfo(data);
          setTrackDetails(data);
        } else {
          clearAlbumInfo();
          clearTrackDetails();
        }
      } else {
        statusEl.textContent = "Not Playing";
        statusEl.className = "status stopped";
        setMarqueeText(data.message || "現在、再生中のコンテンツはありません");
        setCover(null);
        clearAlbumInfo();
        clearTrackDetails();
      }
      return;
    }

    statusEl.textContent = data.type === "episode" ? "Podcast" : "NOW PLAYING";
    statusEl.className = "status playing";
    setMarqueeText(data.display_text || "再生中");
    setCover(data.image_url || null);
    if (data.type !== "episode") {
      setAlbumInfo(data);
      setTrackDetails(data);
    } else {
      clearAlbumInfo();
      clearTrackDetails();
    }

  } catch (err) {
    statusEl.textContent = "通信エラー";
    statusEl.className = "status error";
    setMarqueeText(String(err.message || err));
    setCover(null);
    clearAlbumInfo();
    clearTrackDetails();
  }
}

loginButtonEl.addEventListener("click", () => NowPlayingSource.login());

(async () => {
  try {
    await NowPlayingSource.init();
  } catch (err) {
    statusEl.textContent = "認証エラー";
    statusEl.className = "status error";
    setMarqueeText(String(err.message || err));
    showLoginBox(true);
    return;
  }
  fetchNowPlaying();
  setInterval(fetchNowPlaying, 5000);
})();
