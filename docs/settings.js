/*
 * 設定タブ。
 *
 * 実際のレイアウト切り替えは CSS 側のクラスで行う。
 * ここは「選ばれた値を保存し、#view-playlists にクラスを付け直す」だけを担当する。
 *
 *   表示方法     mode-text / mode-cover / mode-both
 *   スクロール   scroll-vertical / scroll-horizontal
 */

const SETTINGS_KEY = "spotify_display_settings";

const SETTINGS_SPEC = {
  display: { values: ["text", "cover", "both"], fallback: "both", prefix: "mode-" },
  scroll: { values: ["vertical", "horizontal"], fallback: "vertical", prefix: "scroll-" },
};

// 端末は候補が動的なので SETTINGS_SPEC には入れず、別に扱う。
// 空文字は「自動（前回再生した端末）」を意味する。

const setDisplayEl = document.getElementById("set-display");
const setScrollEl = document.getElementById("set-scroll");
const SETTING_GROUPS = { display: setDisplayEl, scroll: setScrollEl };

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    /* 未保存・壊れている場合は既定値で続行 */
  }
  const settings = {};
  for (const [key, spec] of Object.entries(SETTINGS_SPEC)) {
    // 保存値が想定外でも壊れないよう、必ず候補の中から選ぶ
    settings[key] = spec.values.includes(stored[key]) ? stored[key] : spec.fallback;
  }
  settings.device = typeof stored.device === "string" ? stored.device : "";
  return settings;
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 保存できない環境でも、そのセッション中は反映される */
  }
}

function applySettings(settings) {
  for (const [key, spec] of Object.entries(SETTINGS_SPEC)) {
    // 同じグループの他のクラスを外してから付け直す
    for (const value of spec.values) {
      viewPlaylistsEl.classList.toggle(spec.prefix + value, settings[key] === value);
    }
    for (const button of SETTING_GROUPS[key].querySelectorAll(".set-opt")) {
      const active = button.dataset.value === settings[key];
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
}

let currentSettings = loadSettings();

for (const [key, container] of Object.entries(SETTING_GROUPS)) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest(".set-opt");
    if (!button || !SETTINGS_SPEC[key].values.includes(button.dataset.value)) return;
    currentSettings = { ...currentSettings, [key]: button.dataset.value };
    saveSettings(currentSettings);
    applySettings(currentSettings);
  });
}

applySettings(currentSettings);


// -------------------------------
// 再生する端末
// -------------------------------

const setDeviceEl = document.getElementById("set-device");
const setDeviceReloadEl = document.getElementById("set-device-reload");

const DEVICE_TYPE_LABELS = {
  Computer: "パソコン",
  Smartphone: "スマートフォン",
  Speaker: "スピーカー",
  TV: "テレビ",
  CastVideo: "キャスト",
  CastAudio: "キャスト",
  AVR: "アンプ",
  Tablet: "タブレット",
  Automobile: "車",
};

function buildDeviceOption(value, label, detail) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "set-opt";
  button.dataset.value = value;

  const name = document.createElement("span");
  name.textContent = label;
  button.append(name);

  if (detail) {
    const sub = document.createElement("span");
    sub.className = "set-opt-sub";
    sub.textContent = detail;
    button.append(sub);
  }

  button.classList.toggle("is-active", currentSettings.device === value);
  button.setAttribute("aria-pressed", String(currentSettings.device === value));
  return button;
}

async function loadDevices() {
  setDeviceEl.replaceChildren(
    Object.assign(document.createElement("div"), {
      className: "set-empty",
      textContent: "読み込み中…",
    })
  );

  let result;
  try {
    result = await NowPlayingSource.getDevices();
  } catch {
    result = { status: "error" };
  }

  const options = [buildDeviceOption("", "自動", "前回再生した端末")];

  if (result.status === "ok" && result.items.length) {
    for (const device of result.items) {
      const parts = [DEVICE_TYPE_LABELS[device.type] || device.type];
      if (device.is_active) parts.push("再生中");
      if (device.is_restricted) parts.push("操作不可");
      options.push(buildDeviceOption(device.id, device.name, parts.filter(Boolean).join(" · ")));
    }
  }

  setDeviceEl.replaceChildren(...options);

  if (result.status === "login") {
    setDeviceEl.append(
      Object.assign(document.createElement("div"), {
        className: "set-empty",
        textContent: "ログインが必要です",
      })
    );
  } else if (result.status !== "ok") {
    setDeviceEl.append(
      Object.assign(document.createElement("div"), {
        className: "set-empty",
        textContent: COMMAND_ERRORS[result.reason] || "端末一覧を取得できませんでした",
      })
    );
  } else if (!result.items.length) {
    setDeviceEl.append(
      Object.assign(document.createElement("div"), {
        className: "set-empty",
        textContent: "利用できる端末がありません。どこかで Spotify アプリを開いてください。",
      })
    );
  }
}

setDeviceEl.addEventListener("click", async (event) => {
  const button = event.target.closest(".set-opt");
  if (!button) return;

  const deviceId = button.dataset.value;
  currentSettings = { ...currentSettings, device: deviceId };
  saveSettings(currentSettings);

  for (const option of setDeviceEl.querySelectorAll(".set-opt")) {
    const active = option.dataset.value === deviceId;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-pressed", String(active));
  }

  if (!deviceId) {
    showToast("再生先を自動に戻しました");
    return;
  }

  // play: false で転送する。再生中に切り替えても2か所から同時に鳴らない。
  // 何も再生していない場合は 404 が返るが、指定自体は保存済みなので問題ない。
  const result = await NowPlayingSource.transferPlayback(deviceId, false);
  if (result.status === "ok") {
    rememberDevice(deviceId);
    showToast(`${button.textContent.trim()} に切り替えました`);
  } else if (result.reason === "no_active_device") {
    rememberDevice(deviceId);
    showToast("再生先として記憶しました");
  } else {
    showToast(COMMAND_ERRORS[result.reason] || "端末を切り替えられませんでした");
  }
});

setDeviceReloadEl.addEventListener("click", loadDevices);

// 設定タブを開くたびに取り直す。端末の顔ぶれは頻繁に変わるため。
tabSettingsEl.addEventListener("click", loadDevices);
