import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ClipItem {
  id: number;
  kind: "text" | "image" | "files";
  text: string | null;
  files: string[] | null;
  thumbnail: string | null;
  imagePath: string | null;
  width?: number | null;
  height?: number | null;
  size?: number | null;
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

/** 字节数格式化为可读大小（B/KB/MB），供图片项展示。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
    // 点缩略图 → 弹出大图预览（不冒泡到整行的粘贴）。
    icon.classList.add("previewable");
    icon.title = "点击预览";
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      void openImagePreview(item.id);
    });
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
    // 用有用信息替代占位：尺寸 + 大小（如 1920×1080 · 256 KB），都取不到才退回「图片」。
    const dim = item.width && item.height ? `${item.width}×${item.height}` : "";
    const sz = item.size ? formatBytes(item.size) : "";
    textEl.textContent = [dim, sz].filter(Boolean).join(" · ") || "图片";
    textEl.classList.add("meta"); // 用强调色，和正常文字区分开（选中态由 CSS 自动转白）
  } else if (item.kind === "files") {
    const files = item.files ?? [];
    const first = files.length ? basename(files[0]) : "文件";
    const label =
      files.length > 1 ? `${first} 等 ${files.length} 个文件` : first;
    appendMaybeHighlighted(textEl, label, highlight);
  } else {
    // 折叠空白为单行展示；先截断到 ~300 字符再处理，防超长文本的正则/DOM 拖慢渲染。
    const raw = item.text ?? "";
    const label = (raw.length > 300 ? raw.slice(0, 300) : raw).replace(/\s+/g, " ").trim();
    appendMaybeHighlighted(textEl, label, highlight);
  }
  row.appendChild(textEl);
}

async function openImagePreview(id: number): Promise<void> {
  try {
    const dataUrl = await invoke<string | null>("get_image_data_url", { id });
    if (dataUrl) showLightbox(dataUrl);
  } catch (err) {
    console.error("get_image_data_url failed", err);
  }
}

let lightboxEl: HTMLElement | null = null;
function onLightboxKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation(); // 先于全局 Esc（否则会去隐藏窗口）
    closeLightbox();
  }
}
function closeLightbox(): void {
  if (lightboxEl) {
    lightboxEl.remove();
    lightboxEl = null;
    window.removeEventListener("keydown", onLightboxKey, true);
  }
}
function showLightbox(src: string): void {
  closeLightbox();
  const ov = document.createElement("div");
  ov.className = "lightbox";

  // 舞台：定位容器（overflow hidden），图片用 transform 缩放 + 平移，可拖动看全图。
  const stage = document.createElement("div");
  stage.className = "lightbox-stage";
  stage.addEventListener("click", () => closeLightbox()); // 点空白处关闭

  const img = document.createElement("img");
  img.className = "lightbox-img";
  img.draggable = false;

  let k = 1; // 显示缩放（1 = 图片自然像素）
  let panX = 0;
  let panY = 0;
  let fitted = true; // 适应窗口模式
  let dragging = false;
  let moved = false; // 本次按下是否发生了拖动（用于区分拖动与点击）
  let sx = 0;
  let sy = 0;
  let basePanX = 0;
  let basePanY = 0;

  const fitK = (): number => {
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    return Math.min((stage.clientWidth * 0.98) / nw, (stage.clientHeight * 0.98) / nh, 1);
  };
  const render = () => {
    img.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${k})`;
    img.style.cursor = dragging ? "grabbing" : fitted ? "zoom-in" : "grab";
  };
  img.addEventListener("load", () => {
    img.style.width = `${img.naturalWidth}px`; // 基准尺寸=自然像素，缩放交给 transform
    k = fitK();
    panX = 0;
    panY = 0;
    fitted = true;
    render();
  });

  // 拖拽平移（放大后看全图）。
  img.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    moved = false;
    sx = e.clientX;
    sy = e.clientY;
    basePanX = panX;
    basePanY = panY;
    render();
  });
  ov.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    panX = basePanX + dx;
    panY = basePanY + dy;
    render();
  });
  ov.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      render();
    }
  });
  // 点图片（非拖动）：适应窗口 <-> 实际像素 来回切换。
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    if (moved) {
      moved = false;
      return; // 刚才是拖动，不当作点击
    }
    if (fitted) {
      fitted = false;
      k = 1; // 实际像素（放大）
    } else {
      fitted = true;
      k = fitK();
    }
    panX = 0;
    panY = 0;
    render();
  });
  // 滚轮自由缩放（围绕中心）。
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      fitted = false;
      k = Math.min(8, Math.max(0.05, k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      render();
    },
    { passive: false },
  );
  img.src = src;
  stage.appendChild(img);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "lightbox-close";
  close.textContent = "✕";
  close.title = "关闭 (Esc)";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });

  ov.appendChild(stage);
  ov.appendChild(close);
  document.body.appendChild(ov);
  lightboxEl = ov;
  window.addEventListener("keydown", onLightboxKey, true);
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
    if (!trackPointer(e.clientX, e.clientY)) return; // 弹出后未真正移动鼠标：不跟随，保持第 0 行
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
  if (item.pinned) row.classList.add("pinned");
  row.dataset.favId = String(item.id);
  row.setAttribute("role", "button");
  row.tabIndex = -1;

  // 拖拽手动排序：用鼠标事件实现（WKWebView 对 HTML5 draggable 支持差）。
  row.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    favDrag = { id: item.id, startY: e.clientY, active: false, row, targetId: null, after: false };
  });

  appendIconCell(row, item);
  appendTextCell(row, item);
  if (item.pinned) {
    const pin = document.createElement("span");
    pin.className = "item-pin";
    pin.title = "已置顶";
    pin.textContent = "📌";
    row.appendChild(pin);
  }

  // 移除走右键菜单，不再放 hover ✕ 按钮。
  row.addEventListener("click", () => {
    if (suppressFavClick) {
      suppressFavClick = false;
      return; // 刚才是拖拽，吞掉这次点击（不粘贴）
    }
    pasteFavorite(item.id);
  });
  row.addEventListener("mousemove", (e) => {
    if (favDrag && favDrag.active) return; // 拖拽中不跟随高亮
    if (!trackPointer(e.clientX, e.clientY)) return; // 弹出后未真正移动鼠标：不跟随
    setFavHover(row);
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: item.pinned ? "取消置顶" : "置顶",
        run: () => toggleFavPin(item.id),
      },
      { label: "从常用移除", danger: true, run: () => removeFavorite(item.id) },
    ]);
  });

  return row;
}

/** 常用拖拽手动排序状态（鼠标事件实现；WKWebView 对 HTML5 draggable 支持差）。 */
let favDrag:
  | { id: number; startY: number; active: boolean; row: HTMLElement; targetId: number | null; after: boolean }
  | null = null;
/** 拖拽结束后吞掉紧随的 click，避免误触发粘贴。 */
let suppressFavClick = false;

function clearDropMarks(): void {
  favEl
    .querySelectorAll(".drop-before, .drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

/** 文档级拖拽移动：判定拖拽激活、计算落点、画插入线。 */
function onFavDragMove(e: MouseEvent): void {
  if (!favDrag) return;
  if (!favDrag.active) {
    if (Math.abs(e.clientY - favDrag.startY) < 4) return; // 未超阈值：还算点击
    favDrag.active = true;
    favDrag.row.classList.add("dragging");
    document.body.style.userSelect = "none";
  }
  e.preventDefault();
  const rows = Array.from(favEl.querySelectorAll<HTMLElement>(".fav-item"));
  clearDropMarks();
  favDrag.targetId = null;
  let target: HTMLElement | null = null;
  let after = false;
  for (const r of rows) {
    if (r === favDrag.row) continue;
    const rect = r.getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
      target = r;
      after = e.clientY > rect.top + rect.height / 2;
      break;
    }
  }
  // 指针在所有行下方 → 落到末尾
  if (!target && rows.length) {
    const last = rows[rows.length - 1];
    if (last !== favDrag.row && e.clientY > last.getBoundingClientRect().bottom) {
      target = last;
      after = true;
    }
  }
  if (target) {
    target.classList.toggle("drop-after", after);
    target.classList.toggle("drop-before", !after);
    favDrag.targetId = Number(target.dataset.favId);
    favDrag.after = after;
  }
}

/** 文档级拖拽松手：激活则执行重排，否则当普通点击。 */
function onFavDragUp(): void {
  if (!favDrag) return;
  const d = favDrag;
  favDrag = null;
  clearDropMarks();
  document.body.style.userSelect = "";
  if (d.active) {
    d.row.classList.remove("dragging");
    suppressFavClick = true;
    setTimeout(() => {
      suppressFavClick = false;
    }, 0);
    if (d.targetId != null && d.targetId !== d.id) {
      void reorderFavorite(d.id, d.targetId, d.after);
    }
  }
}

/** 常用项展示顺序：置顶项排最前（稳定排序，保留手动/规则排序的相对顺序）。 */
function sortedFavItems(items: ClipItem[]): ClipItem[] {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned));
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
  const raw = activeGroup()?.items ?? [];
  if (raw.length === 0) {
    const empty = document.createElement("div");
    empty.className = "fav-empty";
    empty.textContent = "右键历史项加入常用，或右键此处新建";
    favEl.appendChild(empty);
    return;
  }
  const its = sortedFavItems(raw);
  const frag = document.createDocumentFragment();
  its.forEach((it) => frag.appendChild(buildFavEl(it)));
  favEl.appendChild(frag);
}

/** 在当前分组顶部插入一个内联输入框，手动新建一条文本常用（Enter 保存 / Esc 取消）。 */
function startNewFavInput(): void {
  closeContextMenu();
  const g = activeGroup();
  if (!g) return;
  const existing = favEl.querySelector<HTMLInputElement>(".fav-new-input");
  if (existing) {
    existing.focus();
    return;
  }
  // 有空占位则先移除，避免输入框和「右键历史项…」提示并存。
  favEl.querySelector(".fav-empty")?.remove();
  const input = document.createElement("input");
  input.className = "fav-new-input";
  input.placeholder = "输入常用内容，回车保存";
  favEl.prepend(input);
  input.focus();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    input.remove();
    if (save && text) {
      void addFavText(text, g.id); // 成功后 favorites-updated 会重渲染
    } else {
      renderFavorites(); // 取消：恢复空占位/原列表
    }
  };
  // stopPropagation：否则 onGlobalKeydown 会把字符抢去搜索框、方向键拿去导航历史。
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
 * 程序化滚动计数（>0 表示当前的 scroll 是我们自己触发的，如 kickListPaint 的补绘位移）。
 * 此类滚动不应触发「跟随光标选中」——否则会把选中从第 0 行抢到上次鼠标停留的那行。
 */
let programmaticScrolls = 0;
/**
 * 鼠标是否「真正移动过」。弹窗出现在光标处，光标此刻正压在列表中间某行上，系统会派发一个
 * 「原地」mousemove，若直接跟随就会把选中抢到中间行。故弹出后复位为 false，先锁定第 0 行；
 * 只有后续鼠标相对基准位置明显位移，才认定用户真的动了鼠标（arm），此后才跟随光标。
 */
let pointerArmed = false;
/** 弹出后第一个 mousemove 的坐标基准（即光标压住的静止位置），用于判定是否真的移动了。 */
let pointerBaseline: { x: number; y: number } | null = null;

/**
 * 处理一次 mousemove：更新坐标并判定是否应当跟随光标。
 * 首个事件只记为基准（不 arm）；相对基准位移超过阈值才 arm。已 arm 后恒为 true。
 */
function trackPointer(x: number, y: number): boolean {
  lastPointer = { x, y };
  if (pointerArmed) return true;
  if (!pointerBaseline) {
    pointerBaseline = { x, y };
    return false;
  }
  if (Math.abs(x - pointerBaseline.x) > 2 || Math.abs(y - pointerBaseline.y) > 2) {
    pointerArmed = true;
    return true;
  }
  return false;
}

/**
 * 用鼠标最后位置算出光标正下方的历史行并高亮。
 * WKWebView 在滚动时不更新 :hover/不触发鼠标事件，故在 scroll 事件里主动调用，
 * 让高亮在滚动过程中即时跟随光标所在行。
 */
function selectUnderPointer(): void {
  if (!pointerArmed || !lastPointer) return;
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

/** listEl 滚动时（rAF 节流）主动刷新光标下的高亮。程序化滚动跳过，避免抢占选中。 */
function onListScroll(): void {
  if (programmaticScrolls > 0) return;
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
  if (!pointerArmed || !lastPointer) return;
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

async function addFavText(text: string, groupId: number): Promise<void> {
  try {
    await invoke("add_fav_text", { text, groupId });
  } catch (err) {
    console.error("add_fav_text failed", err);
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

async function toggleFavPin(id: number): Promise<void> {
  try {
    await invoke("toggle_fav_pin", { id });
  } catch (err) {
    console.error("toggle_fav_pin failed", err);
  }
}

/** 拖拽后按「看到的顺序」重排：把 dragId 移到 targetId 前/后，整条新顺序发给后端。 */
async function reorderFavorite(dragId: number, targetId: number, after: boolean): Promise<void> {
  const g = activeGroup();
  if (!g) return;
  // 以渲染顺序（置顶在前）为基准计算，存回后端后再次置顶排序是幂等的。
  const ids = sortedFavItems(g.items)
    .map((i) => i.id)
    .filter((id) => id !== dragId);
  const ti = ids.indexOf(targetId);
  if (ti < 0) return;
  ids.splice(after ? ti + 1 : ti, 0, dragId);
  try {
    await invoke("reorder_favorites", { groupId: g.id, orderedIds: ids });
  } catch (err) {
    console.error("reorder_favorites failed", err);
  }
}

/** 按规则排序当前分组：by = "time" | "text" | "kind"。 */
async function sortFavorites(by: string): Promise<void> {
  const g = activeGroup();
  if (!g) return;
  try {
    await invoke("sort_favorites", { groupId: g.id, by });
  } catch (err) {
    console.error("sort_favorites failed", err);
  }
}

/** 常用排序菜单项（排序按钮 + 空白右键共用）。 */
function favSortActions(): MenuAction[] {
  return [
    { label: "排序方式", header: true },
    { label: "　按加入时间", run: () => sortFavorites("time") },
    { label: "　按字母", run: () => sortFavorites("text") },
    { label: "　按类型", run: () => sortFavorites("kind") },
  ];
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

/**
 * 逼 WKWebView 为历史列表 `#list` 生成绘制图块。
 *
 * 坑（已定位）：`#list` 是超一屏的 overflow 滚动容器，窗口刚显示时 WKWebView **不会**
 * 为它光栅化，非得一次**真实的滚动位移**才触发——所以手动滚一下就有。跟内容何时渲染无关
 * （右侧「常用」短、不足一屏，所以从不受影响）。
 *
 * 复刻用户手滚那一下：真提交一次 2px 位移、下一帧再复位（**不能同帧 0→2→0**，会被合成器
 * 合并成零位移、不触发绘制）。纯滚动、无重排 → 不卡；2px 一帧几乎不可见。
 * 在 rAF / 100ms / 250ms 各打一发，赢过「窗口显示动画未结束、webview 尚不可绘制」的时序竞态。
 */
function kickListPaint(): void {
  const el = listEl;
  const nudge = (): void => {
    if (!el || el.scrollHeight <= el.clientHeight) return; // 不足一屏本就没这坑
    const top = el.scrollTop;
    // 标记为程序化滚动，让 onListScroll 跳过「跟随光标选中」（否则会抢占第 0 行的选中）。
    programmaticScrolls++;
    el.scrollTop = top + 2;
    requestAnimationFrame(() => {
      el.scrollTop = top;
      // 再等一帧，确保这两次 scrollTop 触发的 scroll 事件都在守卫内被跳过后再解除。
      requestAnimationFrame(() => {
        programmaticScrolls--;
      });
    });
  };
  requestAnimationFrame(nudge);
  window.setTimeout(nudge, 100);
  window.setTimeout(nudge, 250);
}

/**
 * 每次窗口显示：聚焦搜索框、清空搜索、选中回第 0 项。
 *
 * 关键设计：**绝不在窗口显示的瞬间无谓地重建列表 DOM**。
 * 「显示瞬间对滚动容器 replaceChildren」会加剧 WKWebView 的显示时不合成问题；列表内容更新
 * 交给 history-updated 事件（那时窗口已稳定）。这里只做轻量复位：
 *   - 上次留有搜索词 → 清空会改变过滤结果，只能重建一次；
 *   - 否则内容与上次一致 → 一个节点都不动，让上次已绘制好的 DOM 直接显示，只移选中高亮回顶部。
 * 最后统一给 `#list` 补一次滚动位移，逼 WKWebView 出图块（避免超一屏历史首开空白）。
 */
function onWindowShown(): void {
  closeContextMenu();
  closeLightbox(); // 重新呼出窗口时不残留上次的图片预览弹框
  // 弹窗出现在光标处、光标正压在中间某行上：复位「鼠标未移动」状态，先锁定第 0 行，
  // 系统派发的「原地」mousemove 只记基准、不跟随；只有用户真的移动鼠标后才开始跟随光标。
  lastPointer = null;
  pointerArmed = false;
  pointerBaseline = null;
  const hadQuery = query.length > 0;
  searchEl.value = "";
  query = "";
  selected = 0;
  if (hadQuery) {
    render();
  } else {
    updateSelectionUI(false);
    listEl.scrollTop = 0;
  }
  searchEl.focus();
  searchEl.select();
  kickListPaint();
}

async function init(): Promise<void> {
  listEl = document.querySelector("#list") as HTMLElement;
  // 滚动时主动让高亮跟随光标（绕过 WKWebView 滚动期间不更新 :hover 的限制）。
  listEl.addEventListener("scroll", onListScroll, { passive: true });
  favEl = document.querySelector("#favorites") as HTMLElement;
  favEl.addEventListener("scroll", onFavScroll, { passive: true });
  // 常用拖拽排序的文档级监听（一次）。
  document.addEventListener("mousemove", onFavDragMove);
  document.addEventListener("mouseup", onFavDragUp);
  // 鼠标移出常用列时清掉高亮。
  favEl.addEventListener("mouseleave", () => setFavHover(null));
  // 常用列表空白处右键 → 新建 / 排序（点在某个常用项上时交给该项自己的菜单）。
  favEl.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".fav-item")) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: "新建常用记录", run: () => startNewFavInput() },
      { label: "", separator: true },
      ...favSortActions(),
    ]);
  });
  // 排序按钮：弹出排序菜单。
  const favSortBtn = document.querySelector("#fav-sort") as HTMLButtonElement;
  favSortBtn.addEventListener("click", () => {
    const r = favSortBtn.getBoundingClientRect();
    showContextMenu(r.right, r.bottom, favSortActions());
  });
  favTabsEl = document.querySelector("#fav-tabs") as HTMLElement;
  // 分组标签条横向溢出时，把竖直鼠标滚轮转成左右滚动（触控板的横向滑动 deltaX 仍走默认）。
  favTabsEl.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY === 0) return;
      if (favTabsEl.scrollWidth <= favTabsEl.clientWidth) return; // 没溢出不拦
      e.preventDefault();
      favTabsEl.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
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
