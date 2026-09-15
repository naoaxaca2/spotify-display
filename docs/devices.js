/*
 * 再生先の端末を決める層。
 *
 * 毎回の操作で端末一覧を取りに行くと、再生ボタンの反応が鈍くなる。
 * そこで通常は「記憶している端末ID」をそのまま添えて送り、
 * 操作対象が無い（404）と言われたときだけ一覧を取りに行って選び直す。
 *
 * 将来 Pi に librespot を入れた場合も、一覧に1件増えるだけで
 * このロジックはそのまま使える。
 */

const LAST_DEVICE_KEY = "spotify_display_last_device";

function loadLastDevice() {
  try {
    return localStorage.getItem(LAST_DEVICE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberDevice(deviceId) {
  if (!deviceId) return;
  try {
    localStorage.setItem(LAST_DEVICE_KEY, deviceId);
  } catch {
    /* 保存できなくても、そのセッション中の動作には影響しない */
  }
}

/** 設定タブでの手動指定。空なら「自動」 */
function manualDeviceId() {
  try {
    return currentSettings?.device || "";
  } catch {
    // settings.js の初期化前に呼ばれた場合
    return "";
  }
}

/** 操作に添える端末ID。手動指定 > 前回再生した端末 */
function preferredDeviceId() {
  return manualDeviceId() || loadLastDevice() || "";
}

/**
 * 404 が返ったときの選び直し。
 * 記憶している端末 → 現在アクティブな端末 → 候補が1つだけならそれ、の順。
 * どれにも当てはまらなければ null を返し、呼び出し元がエラー表示に回す。
 */
async function resolveFallbackDevice() {
  let result;
  try {
    result = await NowPlayingSource.getDevices();
  } catch {
    return null;
  }
  if (result.status !== "ok" || !result.items.length) return null;

  const usable = result.items.filter((d) => !d.is_restricted);
  if (!usable.length) return null;

  const preferred = preferredDeviceId();
  const remembered = usable.find((d) => d.id === preferred);
  if (remembered) return remembered.id;

  const active = usable.find((d) => d.is_active);
  if (active) return active.id;

  // 候補が1つしかないなら迷う余地がない
  if (usable.length === 1) return usable[0].id;

  return null;
}

/**
 * 端末IDを引数に取る処理を実行し、操作対象が無ければ選び直して1回だけ再試行する。
 * run は { status, reason } を返すこと。
 */
async function withDevice(run) {
  const preferred = preferredDeviceId();
  let result = await run(preferred || null);

  if (result.status === "ok") {
    rememberDevice(preferred);
    return result;
  }

  if (result.status !== "error" || result.reason !== "no_active_device") {
    return result;
  }

  const fallback = await resolveFallbackDevice();
  if (!fallback) return result;

  result = await run(fallback);
  if (result.status === "ok") rememberDevice(fallback);
  return result;
}
