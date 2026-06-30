import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ClipItem {
  id: number;
  kind: "text" | "image" | "files";
  text: string | null;
  files: string[] | null;
  thumbnail: string | null;
  imagePath: string | null;
  timestamp: number;
  pinned: boolean;
  sourceApp?: string | null;
  sourceIcon?: string | null;
}

interface FavGroup {
  id: number;
  name: string;
  items: ClipItem[];
}

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

let items: ClipItem[] = [];
/** 常用收藏分组。 */
let favGroups: FavGroup[] = [];
/** 当前激活分组 id（null 表示用第一个分组）。 */
let activeGroupId: number | null = null;
/** 新建分组后，待 favorites-updated 到达时自动进入内联重命名。 */
let renameNewGroupPending = false;
let query = "";
let settings: Settings = { ...DEFAULT_SETTINGS };

/**
 * 来源 App 图标映射：`sourceApp 名称 -> 图标 dataURL`。
 * 后端去重：图标不再随每条 ClipItem 内嵌下发，而是单独经 get_icons 拉取、
 * icons-updated 事件增量更新；渲染时按 item.sourceApp 键查表。
 */
let iconMap: Record<string, string> = {};

/** 取某条记录的来源 App 图标 dataURL（优先映射；兼容旧内嵌字段）。 */
function sourceIconFor(it: ClipItem): string | null {
  if (it.sourceApp && iconMap[it.sourceApp]) return iconMap[it.sourceApp];
  return it.sourceIcon ?? null;
}

/** 当前过滤后的可见列表（render 时刷新）。 */
let visible: ClipItem[] = [];
/** 当前选中索引（基于 visible）。 */
let selected = 0;

// ===== DOM 引用 =====
let listEl: HTMLElement;
let favEl: HTMLElement;
let favTabsEl: HTMLElement;
let searchEl: HTMLInputElement;
let settingsBtn: HTMLButtonElement;
let appTitleEl: HTMLElement | null = null;

/** 从绝对路径取文件名。 */
function basename(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 用于搜索/匹配的可读文本。 */
function searchableText(it: ClipItem): string {
  if (it.kind === "text") return it.text ?? "";
  if (it.kind === "files") return (it.files ?? []).map(basename).join(" ");
  return "";
}

function filtered(): ClipItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => searchableText(it).toLowerCase().includes(q));
}

/** 左侧图标单元：优先来源 App 图标；否则图片显示缩略图，文本/文件用类型字形。 */
/** 把文本写入元素；当 highlight 为真且有搜索词时，命中子串包进高亮 span（XSS 安全：仅文本节点 + span）。 */
function appendMaybeHighlighted(
  textEl: HTMLElement,
  text: string,
  highlight: boolean,
): void {
  const q = query.trim();
  if (!highlight || !q || settings.highlightMatch === "none") {
    textEl.textContent = text;
    return;
  }
  const cls =
    settings.highlightMatch === "underline" ? "hl-underline" : "hl-bold";
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let idx = lower.indexOf(ql, i);
  if (idx < 0) {
    textEl.textContent = text;
    return;
  }
  while (idx >= 0) {
    if (idx > i) textEl.appendChild(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement("span");
    mark.className = cls;
    mark.textContent = text.slice(idx, idx + q.length);
    textEl.appendChild(mark);
    i = idx + q.length;
    idx = lower.indexOf(ql, i);
  }
  if (i < text.length) textEl.appendChild(document.createTextNode(text.slice(i)));
}

function appendIconCell(row: HTMLElement, item: ClipItem): void {
  const icon = document.createElement("div");
  icon.className = "item-icon";
  // 图片项优先展示缩略图（占两行的大图预览），不被来源 App 图标顶替。
  if (item.kind === "image" && item.thumbnail) {
    const img = document.createElement("img");
    img.className = "item-icon-img";
    img.alt = "";
    img.draggable = false;
    img.src = item.thumbnail;
    icon.appendChild(img);
  } else {
    const appIcon = settings.showSourceIcon ? sourceIconFor(item) : null;
    if (appIcon) {
      const img = document.createElement("img");
      img.className = "item-app-icon";
      img.alt = item.sourceApp ?? "";
      if (item.sourceApp) img.title = item.sourceApp;
      img.draggable = false;
      img.src = appIcon;
      icon.appendChild(img);
    } else {
      icon.textContent = item.kind === "files" ? "🗂" : "📄";
    }
  }
  row.appendChild(icon);
}

/** 中间文本单元（单行省略）。highlight=true 时按搜索词高亮命中子串。 */
function appendTextCell(
  row: HTMLElement,
  item: ClipItem,
  highlight = false,
): void {
  const textEl = document.createElement("div");
  textEl.className = "item-text";
  if (item.kind === "image") {
    textEl.textContent = "图片";
    textEl.classList.add("dim");
  } else if (item.kind === "files") {
    const files = item.files ?? [];
    const first = files.length ? basename(files[0]) : "文件";
    const label =
      files.length > 1 ? `${first} 等 ${files.length} 个文件` : first;
    appendMaybeHighlighted(textEl, label, highlight);
  } else {
    // 折叠空白为单行展示；textContent/文本节点 防注入
    const label = (item.text ?? "").replace(/\s+/g, " ").trim();
    appendMaybeHighlighted(textEl, label, highlight);
  }
  row.appendChild(textEl);
}

function buildItemEl(item: ClipItem, index: number): HTMLElement {
  const row = document.createElement("div");
  // 用 kind-* 前缀做类型修饰，避免与内部 .item-text 类名冲突。
  row.className = `item kind-${item.kind}`;
  if (item.pinned) row.classList.add("pinned");
  if (index === selected) row.classList.add("selected");
  row.dataset.index = String(index);
  row.setAttribute("role", "button");
  row.tabIndex = -1;

  appendIconCell(row, item);
  appendTextCell(row, item, true);

  // 置顶标记
  if (item.pinned) {
    const pin = document.createElement("span");
    pin.className = "item-pin";
    pin.title = "已置顶";
    pin.textContent = "📌";
    row.appendChild(pin);
  }

  // 右侧 ⌘N 序号（前 9 项）。置顶/删除走右键菜单，不再放 hover 按钮。
  if (index < 9 && settings.showNumbers) {
    const badge = document.createElement("span");
    badge.className = "item-badge";
    badge.textContent = `⌘${index + 1}`;
    row.appendChild(badge);
  }

  row.addEventListener("click", () => {
    selected = index;
    pasteItem(item.id);
  });
  row.addEventListener("mousemove", (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (selected !== index) {
      selected = index;
      updateSelectionUI(false);
    }
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    selected = index;
    updateSelectionUI();
    showContextMenu(e.clientX, e.clientY, historyMenuActions(item));
  });

  return row;
}

/** 历史项右键菜单：「加入常用」展开为各分组列表 + 置顶 + 删除。 */
function historyMenuActions(item: ClipItem): MenuAction[] {
  const actions: MenuAction[] = [{ label: "加入常用", header: true }];
  for (const g of favGroups) {
    actions.push({ label: "　" + g.name, run: () => addFavorite(item.id, g.id) });
  }
  actions.push({ label: "", separator: true });
  actions.push({
    label: item.pinned ? "取消置顶" : "置顶",
    run: () => togglePin(item.id),
  });
  actions.push({ label: "删除", danger: true, run: () => deleteItem(item.id) });
  return actions;
}

// ===== 常用收藏列表 =====
/** 常用项行：复用紧凑单行样式；单击粘贴，hover ✕ 移除，右键菜单移除。 */
function buildFavEl(item: ClipItem): HTMLElement {
  const row = document.createElement("div");
  row.className = `item fav-item kind-${item.kind}`;
  row.setAttribute("role", "button");
  row.tabIndex = -1;

  appendIconCell(row, item);
  appendTextCell(row, item);

  // 移除走右键菜单，不再放 hover ✕ 按钮。
  row.addEventListener("click", () => pasteFavorite(item.id));
  row.addEventListener("mousemove", (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    setFavHover(row);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: "从常用移除", danger: true, run: () => removeFavorite(item.id) },
    ]);
  });

  return row;
}

/** 当前激活分组（activeGroupId 不存在则回退第一个）。 */
function activeGroup(): FavGroup | null {
  return favGroups.find((g) => g.id === activeGroupId) ?? favGroups[0] ?? null;
}

/** 接收常用分组数据（启动 / favorites-updated）：更新状态并重渲染。 */
function setFavGroups(next: FavGroup[]): void {
  favGroups = Array.isArray(next) ? next : [];
  // 保持激活分组；不存在则：新建场景取最后一个，否则取第一个。
  if (!favGroups.some((g) => g.id === activeGroupId)) {
    activeGroupId =
      renameNewGroupPending && favGroups.length > 0
        ? favGroups[favGroups.length - 1].id
        : favGroups[0]?.id ?? null;
  }
  renderFavTabs();
  renderFavorites();
  // 新建分组后自动进入内联重命名。
  if (renameNewGroupPending) {
    renameNewGroupPending = false;
    const g = activeGroup();
    if (g) startTabRename(g.id, g.name);
  }
}

/** 渲染分组 Tab 行（含「+」新建按钮）。 */
function renderFavTabs(): void {
  favTabsEl.replaceChildren();
  const active = activeGroup();
  for (const g of favGroups) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "fav-tab" + (active && g.id === active.id ? " active" : "");
    tab.dataset.groupId = String(g.id);
    tab.textContent = g.name;
    tab.title = g.name;
    tab.addEventListener("click", () => {
      if (activeGroupId !== g.id) {
        activeGroupId = g.id;
        renderFavTabs();
        renderFavorites();
      }
    });
    tab.addEventListener("dblclick", (e) => {
      e.preventDefault();
      startTabRename(g.id, g.name);
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: "重命名", run: () => startTabRename(g.id, g.name) },
        { label: "删除分组", danger: true, run: () => deleteGroup(g.id) },
      ]);
    });
    favTabsEl.appendChild(tab);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "fav-tab-add";
  add.title = "新建分组";
  add.textContent = "+";
  add.addEventListener("click", () => addGroup());
  favTabsEl.appendChild(add);
}

/** 就地把某个 tab 变成输入框重命名（Enter/失焦提交，Esc 取消）。 */
function startTabRename(groupId: number, current: string): void {
  closeContextMenu();
  const tab = favTabsEl.querySelector<HTMLElement>(
    `.fav-tab[data-group-id="${groupId}"]`,
  );
  if (!tab) return;
  const input = document.createElement("input");
  input.className = "fav-tab-input";
  input.value = current;
  tab.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== current) {
      renameGroup(groupId, name);
    } else {
      renderFavTabs(); // 取消/无变化：还原
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

function renderFavorites(): void {
  favEl.replaceChildren();
  favHoverEl = null; // 旧高亮行已被移除，重置引用
  const its = activeGroup()?.items ?? [];
  if (its.length === 0) {
    const empty = document.createElement("div");
    empty.className = "fav-empty";
    empty.textContent = "右键历史项 → 加入常用";
    favEl.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  its.forEach((it) => frag.appendChild(buildFavEl(it)));
  favEl.appendChild(frag);
}

// ===== 右键上下文菜单 =====
interface MenuAction {
  label: string;
  danger?: boolean;
  /** 非交互的小标题行。 */
  header?: boolean;
  /** 分隔线。 */
  separator?: boolean;
  run?: () => void;
}

let menuEl: HTMLElement | null = null;

function onDocClickForMenu(e: MouseEvent): void {
  if (menuEl && !menuEl.contains(e.target as Node)) closeContextMenu();
}

function closeContextMenu(): void {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("click", onDocClickForMenu, true);
    document.removeEventListener("contextmenu", onDocClickForMenu, true);
    window.removeEventListener("blur", closeContextMenu);
  }
}

function showContextMenu(x: number, y: number, actions: MenuAction[]): void {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  for (const a of actions) {
    if (a.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    if (a.header) {
      const h = document.createElement("div");
      h.className = "ctx-header";
      h.textContent = a.label;
      menu.appendChild(h);
      continue;
    }
    const it = document.createElement("button");
    it.type = "button";
    it.className = "ctx-item" + (a.danger ? " danger" : "");
    it.textContent = a.label;
    it.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeContextMenu();
      a.run?.();
    });
    menu.appendChild(it);
  }
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  menuEl = menu;

  // 夹紧到视口内
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 6);
  const py = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(4, px)}px`;
  menu.style.top = `${Math.max(4, py)}px`;
  menu.style.visibility = "visible";

  // 点击/右键空白处、失焦 → 关闭（capture 阶段，避免被 stopPropagation 挡住）
  setTimeout(() => {
    document.addEventListener("click", onDocClickForMenu, true);
    document.addEventListener("contextmenu", onDocClickForMenu, true);
    window.addEventListener("blur", closeContextMenu);
  }, 0);
}

/**
 * 重渲染列表。
 * @param keepId 若提供，渲染后让选中项跟随该条目身份（而非固定下标），
 *   用于 history-updated/置顶重排等场景，避免高亮落到错误条目。
 */
function render(keepId?: number): void {
  visible = filtered();
  if (keepId != null) {
    const i = visible.findIndex((it) => it.id === keepId);
    if (i >= 0) selected = i;
  }
  if (selected >= visible.length) selected = visible.length - 1;
  if (selected < 0) selected = 0;

  listEl.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";

    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = "📋";
    empty.appendChild(icon);

    const title = document.createElement("div");
    title.className = "empty-title";
    const hasQuery = query.trim().length > 0;
    title.textContent = hasQuery ? "没有匹配的记录" : "暂无剪切板历史";
    empty.appendChild(title);

    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = hasQuery ? "试试其他关键词" : "复制任意内容即可在此查看";
    empty.appendChild(hint);

    listEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  visible.forEach((item, i) => frag.appendChild(buildItemEl(item, i)));
  listEl.appendChild(frag);
  scrollSelectedIntoView();
}

/**
 * 仅更新选中高亮，不重建列表。O(1)：只移除旧高亮、给新选中项加高亮。
 * @param scroll 是否把选中项滚入视野。仅键盘导航传 true；鼠标 hover/滚动传 false，
 *   否则 scrollIntoView 会与用户滚动「打架」，导致高亮卡顿延迟。
 */
function updateSelectionUI(scroll = false): void {
  const prev = listEl.querySelector(".item.selected");
  if (prev) prev.classList.remove("selected");
  const cur = listEl.querySelector(`.item[data-index="${selected}"]`);
  if (cur) cur.classList.add("selected");
  if (scroll) scrollSelectedIntoView();
}

/** 鼠标最后位置（视口坐标），用于在滚动时主动判定光标下的行。 */
let lastPointer: { x: number; y: number } | null = null;
let pointerSelRaf = 0;

/**
 * 用鼠标最后位置算出光标正下方的历史行并高亮。
 * WKWebView 在滚动时不更新 :hover/不触发鼠标事件，故在 scroll 事件里主动调用，
 * 让高亮在滚动过程中即时跟随光标所在行。
 */
function selectUnderPointer(): void {
  if (!lastPointer) return;
  const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
  const row = el ? (el as HTMLElement).closest(".item") : null;
  if (row && listEl.contains(row)) {
    const idx = Number((row as HTMLElement).dataset.index);
    if (!Number.isNaN(idx) && idx !== selected) {
      selected = idx;
      updateSelectionUI(false);
    }
  }
}

/** listEl 滚动时（rAF 节流）主动刷新光标下的高亮。 */
function onListScroll(): void {
  if (pointerSelRaf) return;
  pointerSelRaf = requestAnimationFrame(() => {
    pointerSelRaf = 0;
    selectUnderPointer();
  });
}

// ===== 常用列：与历史一致的「滚动时高亮跟随光标」 =====
/** 当前常用列中被高亮（hover）的行。 */
let favHoverEl: HTMLElement | null = null;
let favSelRaf = 0;

/** 把常用列高亮切到指定行（与历史一致：整行强调色 .selected）。 */
function setFavHover(row: HTMLElement | null): void {
  if (favHoverEl === row) return;
  if (favHoverEl) favHoverEl.classList.remove("selected");
  if (row) row.classList.add("selected");
  favHoverEl = row;
}

/** 用鼠标最后位置算出常用列中光标下的行并高亮（绕过滚动期间 :hover 不更新）。 */
function favHoverUnderPointer(): void {
  if (!lastPointer) return;
  const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
  const row = el ? (el as HTMLElement).closest(".fav-item") : null;
  if (row && favEl.contains(row)) {
    setFavHover(row as HTMLElement);
  }
}

/** favEl 滚动时（rAF 节流）刷新光标下的高亮。 */
function onFavScroll(): void {
  if (favSelRaf) return;
  favSelRaf = requestAnimationFrame(() => {
    favSelRaf = 0;
    favHoverUnderPointer();
  });
}

function scrollSelectedIntoView(): void {
  const row = listEl.querySelector<HTMLElement>(`.item[data-index="${selected}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

function setItems(next: ClipItem[]): void {
  // 记录当前选中条目的 id，重排后让选中跟随其身份而非固定下标。
  const keepId = visible[selected]?.id;
  items = Array.isArray(next) ? next : [];
  render(keepId);
}

// ===== 操作命令 =====
async function pasteItem(id: number): Promise<void> {
  try {
    await invoke("paste_item", { id });
  } catch (err) {
    console.error("paste_item failed", err);
  }
}

async function togglePin(id: number): Promise<void> {
  try {
    await invoke("toggle_pin", { id });
  } catch (err) {
    console.error("toggle_pin failed", err);
  }
}

async function deleteItem(id: number): Promise<void> {
  try {
    await invoke("delete_item", { id });
  } catch (err) {
    console.error("delete_item failed", err);
  }
}

async function addFavorite(id: number, groupId: number): Promise<void> {
  try {
    await invoke("add_favorite", { id, groupId });
  } catch (err) {
    console.error("add_favorite failed", err);
  }
}

async function addGroup(): Promise<void> {
  renameNewGroupPending = true;
  try {
    await invoke("add_group", { name: "新分组" });
  } catch (err) {
    renameNewGroupPending = false;
    console.error("add_group failed", err);
  }
}

async function renameGroup(groupId: number, name: string): Promise<void> {
  try {
    await invoke("rename_group", { groupId, name });
  } catch (err) {
    console.error("rename_group failed", err);
  }
}

async function deleteGroup(groupId: number): Promise<void> {
  try {
    await invoke("delete_group", { groupId });
  } catch (err) {
    console.error("delete_group failed", err);
  }
}

async function removeFavorite(id: number): Promise<void> {
  try {
    await invoke("remove_favorite", { id });
  } catch (err) {
    console.error("remove_favorite failed", err);
  }
}

async function pasteFavorite(id: number): Promise<void> {
  try {
    await invoke("paste_favorite", { id });
  } catch (err) {
    console.error("paste_favorite failed", err);
  }
}

// ===== 主题（主窗口仍随设置换肤，但不再有表单） =====
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

/** 应用外观类设置：应用名显隐、图片缩略图高度（CSS 变量）。 */
function applyAppearance(): void {
  const root = document.documentElement;
  root.style.setProperty("--thumb-h", `${settings.imageThumbHeight}px`);
  if (appTitleEl) appTitleEl.hidden = !settings.showAppName;
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

/** 接收设置（启动 / settings-updated）：更新本地副本、换肤、应用外观并重渲染。 */
function applySettings(next: Settings): void {
  settings = { ...DEFAULT_SETTINGS, ...next };
  applyTheme();
  applyAppearance();
  // 重渲染以反映 showSourceIcon / showNumbers / highlightMatch / 缩略图高度等，保持选中项。
  if (listEl) render(visible[selected]?.id);
}

// ===== 全局键盘导航 =====
function moveSelection(delta: number): void {
  if (visible.length === 0) return;
  selected = (selected + delta + visible.length) % visible.length;
  updateSelectionUI(true);
}

function onGlobalKeydown(e: KeyboardEvent): void {
  // 右键菜单打开时，Esc 先关菜单。
  if (menuEl && e.key === "Escape") {
    e.preventDefault();
    closeContextMenu();
    return;
  }
  const current = visible[selected];

  // ⌘1..⌘9 快速粘贴可见项
  if (e.metaKey && !e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    if (idx < visible.length) {
      e.preventDefault();
      selected = idx;
      pasteItem(visible[idx].id);
    }
    return;
  }

  // ⌘⌫ 删除选中
  if (e.metaKey && (e.key === "Backspace" || e.key === "Delete")) {
    e.preventDefault();
    if (current) deleteItem(current.id);
    return;
  }

  // ⌘P 置顶/取消置顶
  if (e.metaKey && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    if (current) togglePin(current.id);
    return;
  }

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveSelection(1);
      return;
    case "ArrowUp":
      e.preventDefault();
      moveSelection(-1);
      return;
    case "Enter":
      e.preventDefault();
      if (current) pasteItem(current.id);
      return;
    case "Escape":
      e.preventDefault();
      if (searchEl.value) {
        searchEl.value = "";
        query = "";
        selected = 0;
        render();
      } else {
        invoke("hide_window").catch((err) => console.error("hide_window failed", err));
      }
      return;
  }

  // 普通可打印字符：聚焦搜索框继续输入。
  // 焦点不在搜索框（如停留在某行的置顶/删除按钮）时，keydown 阶段改焦点会丢掉本次字符，
  // 因此手动把该字符补进搜索框并立即过滤。
  if (
    document.activeElement !== searchEl &&
    e.key.length === 1 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  ) {
    e.preventDefault();
    searchEl.focus();
    searchEl.value += e.key;
    query = searchEl.value;
    selected = 0;
    render();
  }
}

/** 每次窗口显示：聚焦搜索框、清空搜索、选中第 0 项。 */
function onWindowShown(): void {
  closeContextMenu();
  searchEl.value = "";
  query = "";
  selected = 0;
  render();
  searchEl.focus();
  searchEl.select();
}

async function init(): Promise<void> {
  listEl = document.querySelector("#list") as HTMLElement;
  // 滚动时主动让高亮跟随光标（绕过 WKWebView 滚动期间不更新 :hover 的限制）。
  listEl.addEventListener("scroll", onListScroll, { passive: true });
  favEl = document.querySelector("#favorites") as HTMLElement;
  favEl.addEventListener("scroll", onFavScroll, { passive: true });
  // 鼠标移出常用列时清掉高亮。
  favEl.addEventListener("mouseleave", () => setFavHover(null));
  favTabsEl = document.querySelector("#fav-tabs") as HTMLElement;
  searchEl = document.querySelector("#search") as HTMLInputElement;
  settingsBtn = document.querySelector("#settings-btn") as HTMLButtonElement;
  appTitleEl = document.querySelector(".app-title");

  // 列表滚动时关闭右键菜单，避免菜单悬在错误位置。
  listEl.addEventListener("scroll", closeContextMenu);
  favEl.addEventListener("scroll", closeContextMenu);

  setupSystemThemeListener();
  applyTheme();

  // ----- 搜索 -----
  searchEl.addEventListener("input", () => {
    query = searchEl.value;
    selected = 0;
    render();
  });

  // ----- 全局键盘导航 -----
  window.addEventListener("keydown", onGlobalKeydown);

  // ----- 齿轮：打开独立设置窗口 -----
  settingsBtn.addEventListener("click", () => {
    invoke("open_settings").catch((err) => console.error("open_settings failed", err));
  });

  // ----- 事件监听 -----
  await listen<ClipItem[]>("history-updated", (e) => {
    setItems(e.payload);
  });
  await listen<Record<string, string>>("icons-updated", (e) => {
    if (e.payload) {
      iconMap = { ...iconMap, ...e.payload };
      // 新图标到达：仅当列表里有引用该来源的条目时重渲染补图。
      render(visible[selected]?.id);
    }
  });
  await listen<Settings>("settings-updated", (e) => {
    if (e.payload) applySettings(e.payload);
  });
  await listen<FavGroup[]>("favorites-updated", (e) => {
    setFavGroups(e.payload);
  });
  await listen("window-shown", () => {
    onWindowShown();
  });

  // ----- 初始数据 -----
  try {
    const s = await invoke<Settings>("get_settings");
    if (s) applySettings(s);
  } catch (err) {
    console.error("get_settings failed", err);
  }

  // 先拉来源图标映射，保证首屏渲染就能按 sourceApp 查到图标。
  try {
    const icons = await invoke<Record<string, string>>("get_icons");
    if (icons) iconMap = icons;
  } catch (err) {
    console.error("get_icons failed", err);
  }

  try {
    const history = await invoke<ClipItem[]>("get_history");
    setItems(history);
  } catch (err) {
    console.error("get_history failed", err);
    setItems([]);
  }

  try {
    const groups = await invoke<FavGroup[]>("get_favorites");
    setFavGroups(groups);
  } catch (err) {
    console.error("get_favorites failed", err);
    setFavGroups([]);
  }

  // 启动即聚焦搜索框
  searchEl.focus();
}

window.addEventListener("DOMContentLoaded", () => {
  init();
});
