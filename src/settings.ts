import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Settings {
  shortcut: string;
  shortcut2: string;
  autoHideOnBlur: boolean;
  autostart: boolean;
  theme: "system" | "light" | "dark";
  accent: string;
  historySize: number;
  pasteOnSelect: boolean;
  ignoreConcealed: boolean;
  windowHeight: number;
  popupPosition: "cursor" | "center";
  pinnedPosition: "top" | "bottom";
  showAppName: boolean;
  showSourceIcon: boolean;
  showNumbers: boolean;
  highlightMatch: "bold" | "underline" | "none";
  imageThumbHeight: number;
}

const DEFAULT_SETTINGS: Settings = {
  shortcut: "Cmd+Shift+V",
  shortcut2: "",
  autoHideOnBlur: true,
  autostart: false,
  theme: "system",
  accent: "#0a84ff",
  historySize: 200,
  pasteOnSelect: true,
  ignoreConcealed: true,
  windowHeight: 760,
  popupPosition: "cursor",
  pinnedPosition: "top",
  showAppName: true,
  showSourceIcon: true,
  showNumbers: true,
  highlightMatch: "bold",
  imageThumbHeight: 18,
};

const ACCENT_PRESETS = [
  "#0a84ff",
  "#5e5ce6",
  "#bf5af2",
  "#ff375f",
  "#ff9f0a",
  "#30d158",
  "#64d2ff",
  "#8e8e93",
];

function clampHistorySize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.historySize;
  return Math.min(1000, Math.max(10, Math.round(n)));
}

function clampWindowHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.windowHeight;
  return Math.min(1400, Math.max(360, Math.round(n)));
}

function clampThumbHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.imageThumbHeight;
  return Math.min(48, Math.max(14, Math.round(n)));
}

let settings: Settings = { ...DEFAULT_SETTINGS };
let recording = false;
/** 当前正在录制的目标快捷键。 */
type ShortcutKey = "shortcut" | "shortcut2";
let recordTarget: ShortcutKey = "shortcut";

// ===== DOM 引用 =====
let shortcutDisplay: HTMLElement;
let shortcutRecordBtn: HTMLButtonElement;
let shortcut2Display: HTMLElement;
let shortcut2RecordBtn: HTMLButtonElement;
let shortcut2ClearBtn: HTMLButtonElement;
let pasteInput: HTMLInputElement;
let concealedInput: HTMLInputElement;
let autohideInput: HTMLInputElement;
let autostartInput: HTMLInputElement;
let historyRange: HTMLInputElement;
let historyNum: HTMLInputElement;
let winHeightRange: HTMLInputElement;
let winHeightNum: HTMLInputElement;
let thumbRange: HTMLInputElement;
let thumbNum: HTMLInputElement;
let themeSeg: HTMLElement;
let accentSwatches: HTMLElement;
let clearUnpinnedBtn: HTMLButtonElement;
let clearAllBtn: HTMLButtonElement;
let popupPositionSel: HTMLSelectElement;
let pinnedPositionSel: HTMLSelectElement;
let highlightSel: HTMLSelectElement;
let appNameInput: HTMLInputElement;
let sourceIconInput: HTMLInputElement;
let numbersInput: HTMLInputElement;
let resetBtn: HTMLButtonElement;

// ===== 主题 =====
let mql: MediaQueryList | null = null;

function effectiveTheme(): "light" | "dark" {
  if (settings.theme === "system") {
    return mql && mql.matches ? "dark" : "light";
  }
  return settings.theme;
}

function applyTheme(): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", effectiveTheme());
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--accent-soft", hexToSoft(settings.accent, 0.14));
}

function hexToSoft(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(10, 132, 255, ${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function setupSystemThemeListener(): void {
  if (!window.matchMedia) return;
  mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (settings.theme === "system") applyTheme();
  };
  if (mql.addEventListener) mql.addEventListener("change", handler);
  else if ((mql as any).addListener) (mql as any).addListener(handler);
}

// ===== Tab 切换 =====
function setupTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>(".pref-tab"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".tab-panel"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const p of panels) p.classList.toggle("active", p.dataset.tab === name);
    });
  }
}

// ===== 设置 UI 同步 =====
function buildAccentSwatches(): void {
  accentSwatches.replaceChildren();
  const presets = [...ACCENT_PRESETS];
  if (!presets.some((c) => c.toLowerCase() === settings.accent.toLowerCase())) {
    presets.unshift(settings.accent);
  }
  for (const color of presets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch";
    btn.style.background = color;
    btn.dataset.accent = color;
    btn.setAttribute("role", "radio");
    btn.title = color;
    btn.addEventListener("click", () => {
      if (settings.accent.toLowerCase() === color.toLowerCase()) return;
      settings = { ...settings, accent: color };
      applyTheme();
      syncSettingsUI();
      persistSettings();
    });
    accentSwatches.appendChild(btn);
  }
}

function syncSettingsUI(): void {
  shortcutDisplay.textContent = settings.shortcut || "(未设置)";
  shortcut2Display.textContent = settings.shortcut2 || "(未设置)";
  pasteInput.checked = settings.pasteOnSelect;
  concealedInput.checked = settings.ignoreConcealed;
  autohideInput.checked = settings.autoHideOnBlur;
  autostartInput.checked = settings.autostart;
  historyRange.value = String(settings.historySize);
  historyNum.value = String(settings.historySize);
  winHeightRange.value = String(settings.windowHeight);
  winHeightNum.value = String(settings.windowHeight);
  thumbRange.value = String(settings.imageThumbHeight);
  thumbNum.value = String(settings.imageThumbHeight);
  popupPositionSel.value = settings.popupPosition;
  pinnedPositionSel.value = settings.pinnedPosition;
  highlightSel.value = settings.highlightMatch;
  appNameInput.checked = settings.showAppName;
  sourceIconInput.checked = settings.showSourceIcon;
  numbersInput.checked = settings.showNumbers;

  for (const btn of Array.from(themeSeg.querySelectorAll<HTMLElement>(".seg-btn"))) {
    const active = btn.dataset.theme === settings.theme;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  }

  for (const sw of Array.from(accentSwatches.querySelectorAll<HTMLElement>(".swatch"))) {
    const active = (sw.dataset.accent || "").toLowerCase() === settings.accent.toLowerCase();
    sw.classList.toggle("active", active);
    sw.setAttribute("aria-checked", active ? "true" : "false");
  }
}

function applySettings(next: Settings): void {
  settings = {
    shortcut: next.shortcut || DEFAULT_SETTINGS.shortcut,
    shortcut2: next.shortcut2 ?? DEFAULT_SETTINGS.shortcut2,
    autoHideOnBlur: !!next.autoHideOnBlur,
    autostart: !!next.autostart,
    theme: next.theme || DEFAULT_SETTINGS.theme,
    accent: next.accent || DEFAULT_SETTINGS.accent,
    historySize: clampHistorySize(next.historySize ?? DEFAULT_SETTINGS.historySize),
    pasteOnSelect: next.pasteOnSelect ?? DEFAULT_SETTINGS.pasteOnSelect,
    ignoreConcealed: next.ignoreConcealed ?? DEFAULT_SETTINGS.ignoreConcealed,
    windowHeight: clampWindowHeight(next.windowHeight ?? DEFAULT_SETTINGS.windowHeight),
    popupPosition: next.popupPosition === "center" ? "center" : "cursor",
    pinnedPosition: next.pinnedPosition === "bottom" ? "bottom" : "top",
    showAppName: next.showAppName ?? DEFAULT_SETTINGS.showAppName,
    showSourceIcon: next.showSourceIcon ?? DEFAULT_SETTINGS.showSourceIcon,
    showNumbers: next.showNumbers ?? DEFAULT_SETTINGS.showNumbers,
    highlightMatch:
      next.highlightMatch === "underline" || next.highlightMatch === "none"
        ? next.highlightMatch
        : "bold",
    imageThumbHeight: clampThumbHeight(next.imageThumbHeight ?? DEFAULT_SETTINGS.imageThumbHeight),
  };
  applyTheme();
  buildAccentSwatches();
  syncSettingsUI();
}

async function persistSettings(): Promise<void> {
  try {
    await invoke("set_settings", { settings });
  } catch (err) {
    console.error("set_settings failed", err);
  }
}

// ===== 快捷键录制 =====
/** 把 keydown 事件格式化为 Tauri 加速键字符串，按实际按键用具体修饰键（如 "Cmd+Shift+V"）。 */
function formatAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push("Cmd");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const main = mainKeyFromCode(e);
  if (!main) return null; // 仅修饰键，等待主键
  return [...mods, main].join("+");
}

/** 从 KeyboardEvent.code 映射到 Tauri 主键标识。 */
function mainKeyFromCode(e: KeyboardEvent): string | null {
  const code = e.code;
  if (
    code === "MetaLeft" || code === "MetaRight" ||
    code === "ControlLeft" || code === "ControlRight" ||
    code === "AltLeft" || code === "AltRight" ||
    code === "ShiftLeft" || code === "ShiftRight"
  ) {
    return null;
  }
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return code;
  if (/^F\d{1,2}$/.test(code)) return code;
  const map: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: "Escape",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
  };
  return map[code] ?? null;
}

function displayFor(t: ShortcutKey): HTMLElement {
  return t === "shortcut" ? shortcutDisplay : shortcut2Display;
}
function recordBtnFor(t: ShortcutKey): HTMLButtonElement {
  return t === "shortcut" ? shortcutRecordBtn : shortcut2RecordBtn;
}
function valueFor(t: ShortcutKey): string {
  return t === "shortcut" ? settings.shortcut : settings.shortcut2;
}

function startRecording(t: ShortcutKey): void {
  if (recording) stopRecording(); // 先停掉另一个
  recording = true;
  recordTarget = t;
  recordBtnFor(t).textContent = "按下组合…";
  recordBtnFor(t).classList.add("recording");
  displayFor(t).textContent = "录制中…";
}

function stopRecording(): void {
  recording = false;
  const t = recordTarget;
  recordBtnFor(t).textContent = "录制";
  recordBtnFor(t).classList.remove("recording");
  displayFor(t).textContent = valueFor(t) || "(未设置)";
}

function onRecordKeydown(e: KeyboardEvent): void {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  const t = recordTarget;
  const disp = displayFor(t);

  if (e.key === "Escape") {
    stopRecording();
    return;
  }

  const accel = formatAccelerator(e);
  if (!accel) {
    const preview: string[] = [];
    if (e.metaKey) preview.push("Cmd");
    if (e.ctrlKey) preview.push("Ctrl");
    if (e.altKey) preview.push("Alt");
    if (e.shiftKey) preview.push("Shift");
    disp.textContent = preview.length ? preview.join("+") + "+…" : "录制中…";
    return;
  }

  if (!(e.metaKey || e.ctrlKey || e.altKey)) {
    disp.textContent = "需含修饰键";
    return;
  }

  recording = false;
  recordBtnFor(t).textContent = "录制";
  recordBtnFor(t).classList.remove("recording");
  settings = { ...settings, [t]: accel };
  disp.textContent = accel;
  persistSettings();
}

async function init(): Promise<void> {
  shortcutDisplay = document.querySelector("#shortcut-display") as HTMLElement;
  shortcutRecordBtn = document.querySelector("#shortcut-record") as HTMLButtonElement;
  shortcut2Display = document.querySelector("#shortcut2-display") as HTMLElement;
  shortcut2RecordBtn = document.querySelector("#shortcut2-record") as HTMLButtonElement;
  shortcut2ClearBtn = document.querySelector("#shortcut2-clear") as HTMLButtonElement;
  pasteInput = document.querySelector("#opt-paste") as HTMLInputElement;
  concealedInput = document.querySelector("#opt-concealed") as HTMLInputElement;
  autohideInput = document.querySelector("#opt-autohide") as HTMLInputElement;
  autostartInput = document.querySelector("#opt-autostart") as HTMLInputElement;
  historyRange = document.querySelector("#opt-historysize") as HTMLInputElement;
  historyNum = document.querySelector("#opt-historysize-num") as HTMLInputElement;
  winHeightRange = document.querySelector("#opt-winheight") as HTMLInputElement;
  winHeightNum = document.querySelector("#opt-winheight-num") as HTMLInputElement;
  thumbRange = document.querySelector("#opt-thumbheight") as HTMLInputElement;
  thumbNum = document.querySelector("#opt-thumbheight-num") as HTMLInputElement;
  themeSeg = document.querySelector("#theme-seg") as HTMLElement;
  accentSwatches = document.querySelector("#accent-swatches") as HTMLElement;
  clearUnpinnedBtn = document.querySelector("#clear-unpinned") as HTMLButtonElement;
  clearAllBtn = document.querySelector("#clear-all") as HTMLButtonElement;
  popupPositionSel = document.querySelector("#opt-popup-position") as HTMLSelectElement;
  pinnedPositionSel = document.querySelector("#opt-pinned-position") as HTMLSelectElement;
  highlightSel = document.querySelector("#opt-highlight") as HTMLSelectElement;
  appNameInput = document.querySelector("#opt-appname") as HTMLInputElement;
  sourceIconInput = document.querySelector("#opt-sourceicon") as HTMLInputElement;
  numbersInput = document.querySelector("#opt-numbers") as HTMLInputElement;
  resetBtn = document.querySelector("#reset-settings") as HTMLButtonElement;

  setupTabs();
  setupSystemThemeListener();
  applyTheme();
  buildAccentSwatches();
  syncSettingsUI();

  // ----- 快捷键 -----
  shortcutRecordBtn.addEventListener("click", () => {
    if (recording && recordTarget === "shortcut") stopRecording();
    else startRecording("shortcut");
  });
  shortcut2RecordBtn.addEventListener("click", () => {
    if (recording && recordTarget === "shortcut2") stopRecording();
    else startRecording("shortcut2");
  });
  shortcut2ClearBtn.addEventListener("click", () => {
    if (recording && recordTarget === "shortcut2") stopRecording();
    settings = { ...settings, shortcut2: "" };
    shortcut2Display.textContent = "(未设置)";
    persistSettings();
  });
  window.addEventListener("keydown", onRecordKeydown, true);

  // ----- 开关 -----
  pasteInput.addEventListener("change", () => {
    settings = { ...settings, pasteOnSelect: pasteInput.checked };
    persistSettings();
  });
  concealedInput.addEventListener("change", () => {
    settings = { ...settings, ignoreConcealed: concealedInput.checked };
    persistSettings();
  });
  autohideInput.addEventListener("change", () => {
    settings = { ...settings, autoHideOnBlur: autohideInput.checked };
    persistSettings();
  });
  autostartInput.addEventListener("change", () => {
    settings = { ...settings, autostart: autostartInput.checked };
    persistSettings();
  });
  appNameInput.addEventListener("change", () => {
    settings = { ...settings, showAppName: appNameInput.checked };
    persistSettings();
  });
  sourceIconInput.addEventListener("change", () => {
    settings = { ...settings, showSourceIcon: sourceIconInput.checked };
    persistSettings();
  });
  numbersInput.addEventListener("change", () => {
    settings = { ...settings, showNumbers: numbersInput.checked };
    persistSettings();
  });

  // ----- 下拉 -----
  popupPositionSel.addEventListener("change", () => {
    const v = popupPositionSel.value === "center" ? "center" : "cursor";
    settings = { ...settings, popupPosition: v };
    persistSettings();
  });
  pinnedPositionSel.addEventListener("change", () => {
    const v = pinnedPositionSel.value === "bottom" ? "bottom" : "top";
    settings = { ...settings, pinnedPosition: v };
    persistSettings();
  });
  highlightSel.addEventListener("change", () => {
    const v = highlightSel.value;
    settings = {
      ...settings,
      highlightMatch: v === "underline" || v === "none" ? v : "bold",
    };
    persistSettings();
  });

  // ----- 滑块 -----
  const onHistoryChange = (raw: number) => {
    const v = clampHistorySize(raw);
    settings = { ...settings, historySize: v };
    historyRange.value = String(v);
    historyNum.value = String(v);
    persistSettings();
  };
  historyRange.addEventListener("input", () => {
    historyNum.value = historyRange.value;
  });
  historyRange.addEventListener("change", () => onHistoryChange(Number(historyRange.value)));
  historyNum.addEventListener("change", () => onHistoryChange(Number(historyNum.value)));

  const onHeightChange = (raw: number) => {
    const v = clampWindowHeight(raw);
    settings = { ...settings, windowHeight: v };
    winHeightRange.value = String(v);
    winHeightNum.value = String(v);
    persistSettings();
  };
  winHeightRange.addEventListener("input", () => {
    winHeightNum.value = winHeightRange.value;
  });
  winHeightRange.addEventListener("change", () => onHeightChange(Number(winHeightRange.value)));
  winHeightNum.addEventListener("change", () => onHeightChange(Number(winHeightNum.value)));

  const onThumbChange = (raw: number) => {
    const v = clampThumbHeight(raw);
    settings = { ...settings, imageThumbHeight: v };
    thumbRange.value = String(v);
    thumbNum.value = String(v);
    persistSettings();
  };
  thumbRange.addEventListener("input", () => {
    thumbNum.value = thumbRange.value;
  });
  thumbRange.addEventListener("change", () => onThumbChange(Number(thumbRange.value)));
  thumbNum.addEventListener("change", () => onThumbChange(Number(thumbNum.value)));

  // ----- 清空 -----
  clearUnpinnedBtn.addEventListener("click", async () => {
    try {
      await invoke("clear_history", { clearPinned: false });
    } catch (err) {
      console.error("clear_history failed", err);
    }
  });
  clearAllBtn.addEventListener("click", async () => {
    try {
      await invoke("clear_history", { clearPinned: true });
    } catch (err) {
      console.error("clear_history failed", err);
    }
  });

  // ----- 恢复默认 -----
  resetBtn.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    applyTheme();
    buildAccentSwatches();
    syncSettingsUI();
    persistSettings();
  });

  // ----- 主题分段 -----
  for (const btn of Array.from(themeSeg.querySelectorAll<HTMLElement>(".seg-btn"))) {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.theme as Settings["theme"];
      if (settings.theme === theme) return;
      settings = { ...settings, theme };
      applyTheme();
      syncSettingsUI();
      persistSettings();
    });
  }

  // 跨窗口同步：其它窗口改了设置 → 本页面也更新。
  await listen<Settings>("settings-updated", (e) => {
    if (e.payload) applySettings(e.payload);
  });

  // 初始数据
  try {
    const s = await invoke<Settings>("get_settings");
    if (s) applySettings(s);
  } catch (err) {
    console.error("get_settings failed", err);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init();
});
