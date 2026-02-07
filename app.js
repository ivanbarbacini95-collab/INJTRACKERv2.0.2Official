/* =========================================================
   Injective Portfolio • v2.0.2
   app.js — FULL FILE (Definitivo + Advanced settings + crosshair + per-address isolation)
   ========================================================= */

/* ================= CONFIG ================= */
const INITIAL_SETTLE_TIME = 4200;

const ACCOUNT_POLL_MS = 2000;
const REST_SYNC_MS = 60000;
const CHART_SYNC_MS = 60000;

const DAY_MINUTES = 24 * 60;
const ONE_MIN_MS = 60_000;

const STAKE_TARGET_MAX = 1000;
const REWARD_WITHDRAW_THRESHOLD = 0.0002; // INJ

/* persistence versions */
const STAKE_LOCAL_VER = 3;
const REWARD_WD_LOCAL_VER = 2;
const NW_LOCAL_VER = 2;
const EV_LOCAL_VER = 1;

/* net worth limits */
const NW_MAX_POINTS = 4800;

/* Net Worth live window */
const NW_LIVE_WINDOW_MS = 15 * 60 * 1000; // ✅ 15 minutes live window

/* cloud */
const CLOUD_API = "/api/point";
const CLOUD_PUSH_DEBOUNCE_MS = 1200;
const CLOUD_PULL_INTERVAL_MS = 45_000;

/* refresh mode staging */
const REFRESH_RED_MS = 220;

/* perf throttles */
const NW_DRAW_MIN_MS = 650;
const NW_POINT_MIN_MS = 2500;

/* ================= HELPERS ================= */
const $ = (id) => document.getElementById(id);
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);
const safe = (n) => (Number.isFinite(+n) ? +n : 0);

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtHHMM(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fmtHHMMSS(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

function tsLabel(ms = Date.now()) { return String(Math.floor(ms)); }
function labelToTs(lbl) {
  if (lbl == null) return 0;
  const s = String(lbl).trim();
  if (/^\d{10,13}$/.test(s)) return safe(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function nowLabel() { return new Date().toLocaleTimeString(); }
function shortAddr(a) { return a && a.length > 18 ? (a.slice(0, 10) + "…" + a.slice(-6)) : (a || ""); }
function setText(id, txt) {
  const el = $(id);
  if (!el) return;
  // Privacy mode: mask only the elements explicitly marked as sensitive
  if (document.body?.classList?.contains("privacy-on") && el.classList.contains("privacy-mask")) {
    el.textContent = el.dataset.privacyPlaceholder || "•••";
    return;
  }
  el.textContent = txt;
}

function fmtSmart(v){
  v = safe(v);
  const av = Math.abs(v);
  if (av >= 1000) return v.toFixed(0);
  if (av >= 100) return v.toFixed(1);
  if (av >= 10) return v.toFixed(2);
  if (av >= 1) return v.toFixed(3);
  if (av >= 0.1) return v.toFixed(4);
  return v.toFixed(6);
}

function hasInternet() { return navigator.onLine === true; }

/* ================= GLOBAL ERROR GUARDS ================= */
function setStatusError(msg){
  const statusText = $("statusText");
  const statusDot = $("statusDot");
  if (statusText) statusText.textContent = msg || "Error";
  if (statusDot) statusDot.style.background = "#ef4444";
}
window.addEventListener("error", (e) => {
  setStatusError("JS Error");
  console.error("JS Error:", e?.error || e);
});
window.addEventListener("unhandledrejection", (e) => {
  setStatusError("Promise Error");
  console.error("Promise Error:", e?.reason || e);
});

/* ================= THEME / MODE ================= */
const THEME_KEY = "inj_theme";
const MODE_KEY  = "inj_mode"; // live | refresh

let theme = localStorage.getItem(THEME_KEY) || "dark";
let liveMode = (localStorage.getItem(MODE_KEY) || "live") === "live";

function axisGridColor() {
  return (document.body.dataset.theme === "light") ? "rgba(15,23,42,.14)" : "rgba(249,250,251,.10)";
}
function axisTickColor() {
  return (document.body.dataset.theme === "light") ? "rgba(15,23,42,.65)" : "rgba(249,250,251,.60)";
}

function applyTheme(t){
  theme = (t === "light") ? "light" : "dark";
  document.body.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const themeIcon = $("themeIcon");
  if (themeIcon) themeIcon.textContent = theme === "dark" ? "🌙" : "☀️";
  refreshChartsTheme();
  renderSettingsSnapshot(); // keep settings updated
}

/* ================= CHARTJS ZOOM REGISTER (NO CRASH) ================= */
let ZOOM_OK = false;
function tryRegisterZoom(){
  try{
    if (!window.Chart) return false;
    const plug = window.ChartZoom || window["chartjs-plugin-zoom"];
    if (plug) Chart.register(plug);
    const has = !!(Chart?.registry?.plugins?.get && Chart.registry.plugins.get("zoom"));
    return has;
  } catch (e){
    console.warn("Zoom plugin not available:", e);
    return false;
  }
}

/* ================= CONNECTION UI ================= */
const statusDot  = $("statusDot");
const statusText = $("statusText");

let wsTradeOnline = false;
let wsKlineOnline = false;
let accountOnline = false;

let refreshLoaded = false;
let refreshLoading = false;
let modeLoading = false;

function liveReady(){
  const socketsOk = wsTradeOnline && wsKlineOnline;
  const accountOk = !address || accountOnline;
  return socketsOk && accountOk;
}

function refreshConnUI() {
  if (!statusDot || !statusText) return;

  // Blink phase helper
  const setBlink = (mode) => {
    if (!statusDot) return;
    statusDot.classList.remove("blink-ok","blink-loading","blink-offline");
    if (mode === "ok") statusDot.classList.add("blink-ok");
    else if (mode === "loading") statusDot.classList.add("blink-loading");
    else if (mode === "offline") statusDot.classList.add("blink-offline");
  };

  if (!hasInternet()) {
    statusText.textContent = "Offline";
    statusDot.style.background = "#ef4444";
    setBlink("offline");
    return;
  }

  const loadingNow =
    modeLoading ||
    refreshLoading ||
    (!liveMode && !refreshLoaded) ||
    (liveMode && !liveReady());

  if (loadingNow) {
    statusText.textContent = "Loading...";
    statusDot.style.background = "#f59e0b";
    setBlink("loading");
    return;
  }

  statusText.textContent = "Online";
  statusDot.style.background = "#22c55e";
  setBlink("ok");
}

/* ================= SAFE FETCH ================= */
async function fetchJSON(url, opts = {}) {
  try {
    const res = await fetch(url, { cache: "no-store", ...opts });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* ================= SMOOTH DISPLAY ================= */
let settleStart = Date.now();
function scrollSpeed() {
  const t = Math.min((Date.now() - settleStart) / INITIAL_SETTLE_TIME, 1);
  const base = 0.08;
  const maxExtra = 0.80;
  return base + (t * t) * maxExtra;
}
function tick(cur, tgt) {
  if (!Number.isFinite(tgt)) return cur;
  return cur + (tgt - cur) * scrollSpeed();
}

/* ================= COLORED DIGITS ================= */
function colorNumber(el, n, o, d) {
  if (!el) return;
  // Privacy mode: do not render digits (keep charts visible)
  if (document.body?.classList?.contains("privacy-on") && el.classList.contains("privacy-mask")) {
    el.textContent = el.dataset.privacyPlaceholder || "•••";
    return;
  }
  n = safe(n); o = safe(o);
  const ns = n.toFixed(d), os = o.toFixed(d);
  if (ns === os) { el.textContent = ns; return; }
  el.innerHTML = [...ns].map((c, i) => {
    const col = c !== os[i]
      ? (n > o ? "#22c55e" : "#ef4444")
      : (document.body.dataset.theme === "light" ? "#0f172a" : "#f9fafb");
    return `<span style="color:${col}">${c}</span>`;
  }).join("");
}
function colorMoney(el, n, o, decimals = 2){
  if (!el) return;
  // Privacy mode: do not render digits (keep charts visible)
  if (document.body?.classList?.contains("privacy-on") && el.classList.contains("privacy-mask")) {
    el.textContent = el.dataset.privacyPlaceholder || "$•••";
    return;
  }
  n = safe(n); o = safe(o);
  const ns = n.toFixed(decimals);
  const os = o.toFixed(decimals);
  if (ns === os) { el.textContent = `$${ns}`; return; }

  const baseCol = (document.body.dataset.theme === "light") ? "#0f172a" : "#f9fafb";
  const upCol = "#22c55e";
  const dnCol = "#ef4444";
  const dir = (n > o) ? "up" : "down";

  const out = [`<span style="color:${baseCol}">$</span>`];
  for (let i = 0; i < ns.length; i++){
    const c = ns[i];
    const oc = os[i];
    const col = (c !== oc) ? (dir === "up" ? upCol : dnCol) : baseCol;
    out.push(`<span style="color:${col}">${c}</span>`);
  }
  el.innerHTML = out.join("");
}

/* ================= PERF ================= */
function pctChange(price, open) {
  const p = safe(price), o = safe(open);
  if (!o) return 0;
  const v = ((p - o) / o) * 100;
  return Number.isFinite(v) ? v : 0;
}
function updatePerf(arrowId, pctId, v) {
  const arrow = $(arrowId), pct = $(pctId);
  if (!arrow || !pct) return;

  if (v > 0) { arrow.textContent = "▲"; arrow.className = "arrow up"; pct.className = "pct up"; }
  else if (v < 0) { arrow.textContent = "▼"; arrow.className = "arrow down"; pct.className = "pct down"; }
  else { arrow.textContent = "►"; arrow.className = "arrow flat"; pct.className = "pct flat"; }

  pct.textContent = Math.abs(v).toFixed(2) + "%";
}

/* ================= BAR RENDER ================= */
function renderBar(bar, line, val, open, low, high, gradUp, gradDown) {
  if (!bar || !line) return;

  open = safe(open); low = safe(low); high = safe(high); val = safe(val);

  if (!open || !Number.isFinite(low) || !Number.isFinite(high) || high === low) {
    line.style.left = "50%";
    bar.style.width = "0%";
    return;
  }

  const range = Math.max(Math.abs(high - open), Math.abs(open - low));
  const min = open - range;
  const max = open + range;

  const pos = clamp(((val - min) / (max - min)) * 100, 0, 100);
  const center = 50;

  line.style.left = pos + "%";

  if (val >= open) {
    bar.style.left = center + "%";
    bar.style.width = Math.max(0, pos - center) + "%";
    bar.style.background = gradUp;
  } else {
    bar.style.left = pos + "%";
    bar.style.width = Math.max(0, center - pos) + "%";
    bar.style.background = gradDown;
  }
}

/* ================= ADDRESS / SEARCH ================= */
const searchWrap = $("searchWrap");
const searchBtn = $("searchBtn");
const addressInput = $("addressInput");
const addressDisplay = $("addressDisplay");
const menuBtn = $("menuBtn");

let address = localStorage.getItem("inj_address") || "";
let pendingAddress = address || "";

function setAddressDisplay(addr) {
  if (!addressDisplay) return;
  if (!addr) { addressDisplay.innerHTML = ""; return; }
  // Privacy mode: do not reveal address
  if (document.body?.classList?.contains("privacy-on") && addressDisplay.classList.contains("privacy-mask")) {
    addressDisplay.textContent = addressDisplay.dataset.privacyPlaceholder || "Address hidden";
    return;
  }
  addressDisplay.innerHTML = `<span class="tag"><strong>Wallet:</strong> ${shortAddr(addr)}</span>`;
}
setAddressDisplay(address);

function openSearch() {
  if (!searchWrap) return;
  searchWrap.classList.add("open");
  document.body.classList.add("search-open");

  // ✅ Prefill with last address so it stays "permanent" across reloads
  if (addressInput) {
    addressInput.value = address || "";
    pendingAddress = addressInput.value.trim();
    try { addressInput.select(); } catch {}
  }

  setTimeout(() => addressInput?.focus(), 20);
}
function closeSearch() {
  if (!searchWrap) return;
  searchWrap.classList.remove("open");
  document.body.classList.remove("search-open");
  addressInput?.blur();
}

if (addressInput) addressInput.value = "";

searchBtn?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  if (!searchWrap.classList.contains("open")) openSearch();
  else addressInput?.focus();
}, { passive: false });

addressInput?.addEventListener("focus", () => openSearch(), { passive: true });
addressInput?.addEventListener("input", (e) => { pendingAddress = e.target.value.trim(); }, { passive: true });

addressInput?.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const v = pendingAddress;
    await commitAddress(v);
    addressInput.value = "";
    pendingAddress = "";
    closeSearch(); /* ✅ torna normale dopo ricerca */
  } else if (e.key === "Escape") {
    e.preventDefault();
    addressInput.value = "";
    pendingAddress = "";
    closeSearch();
  }
});

document.addEventListener("click", (e) => {
  if (!searchWrap) return;
  if (searchWrap.contains(e.target)) return;
  closeSearch();
}, { passive: true });


/* ================= DASHBOARD ORDER (Preferences) ================= */
const DASH_ORDER_KEY = "inj_dash_order_v1";
let dashDefaultOrder = [];

function getCardsWrapper(){
  return $("cardsWrapper") || document.querySelector("#cardsWrapper") || document.querySelector(".cards-wrapper") || document.querySelector(".cards");
}
function getDashCards(){
  const w = getCardsWrapper();
  return w ? Array.from(w.querySelectorAll(".card[data-card]")) : [];
}
function getOrderFromDom(){
  return getDashCards().map(c => c.dataset.card);
}
function applyDashOrder(order){
  const w = getCardsWrapper();
  if (!w) return;
  const cards = getDashCards();
  const map = new Map(cards.map(c => [c.dataset.card, c]));
  const frag = document.createDocumentFragment();
  const used = new Set();

  (order || []).forEach(k => {
    const c = map.get(k);
    if (c) { frag.appendChild(c); used.add(k); }
  });
  for (const [k,c] of map.entries()){
    if (!used.has(k)) frag.appendChild(c);
  }
  w.appendChild(frag);

  // resize charts after DOM move
  setTimeout(() => {
    try{ chart?.resize?.(); }catch{}
    try{ netWorthChart?.resize?.(); }catch{}
    try{ stakeChart?.resize?.(); }catch{}
    try{ rewardChart?.resize?.(); }catch{}
    try{ aprChart?.resize?.(); }catch{}
  }, 80);
}
function loadDashOrder(){
  try{
    const raw = localStorage.getItem(DASH_ORDER_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter(Boolean);
  }catch{}
  return null;
}
function saveDashOrder(arr){
  try{ localStorage.setItem(DASH_ORDER_KEY, JSON.stringify(arr)); }catch{}
}

function renderDashOrderUI(){
  const list = $("dashOrderList");
  if (!list) return;
  list.innerHTML = "";

  const cards = getDashCards();
  const order = getOrderFromDom();

  const titleByKey = {};
  cards.forEach(c => {
    const key = c.dataset.card;
    const title = c.dataset.title || c.querySelector(".label")?.textContent?.trim() || key;
    titleByKey[key] = title;
  });

  for (const key of order){
    const row = document.createElement("div");
    row.className = "order-item";
    row.dataset.key = key;

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = titleByKey[key] || key;

    const tools = document.createElement("div");
    tools.className = "tools";

    // Touch-friendly: up/down buttons always visible (mobile friendly)
    const up = document.createElement("button");
    up.className = "mini";
    up.type = "button";
    up.textContent = "↑";
    up.addEventListener("click", () => {
      const prev = row.previousElementSibling;
      if (prev) row.parentElement.insertBefore(row, prev);
    });

    const down = document.createElement("button");
    down.className = "mini";
    down.type = "button";
    down.textContent = "↓";
    down.addEventListener("click", () => {
      const next = row.nextElementSibling;
      if (next) row.parentElement.insertBefore(next, row);
    });

    tools.appendChild(up);
    tools.appendChild(down);

    row.appendChild(name);
    row.appendChild(tools);
    list.appendChild(row);
  }
}

function readOrderFromUI(){
  const list = $("dashOrderList");
  if (!list) return getOrderFromDom();
  return Array.from(list.querySelectorAll(".order-item")).map(el => el.dataset.key).filter(Boolean);
}

function initDashOrder(){
  dashDefaultOrder = getOrderFromDom();
  const saved = loadDashOrder();
  if (saved && saved.length) applyDashOrder(saved);

  renderDashOrderUI();

  $("dashOrderApply")?.addEventListener("click", () => {
    const order = readOrderFromUI();
    applyDashOrder(order);
    saveDashOrder(order);
  });

  $("dashOrderReset")?.addEventListener("click", () => {
    applyDashOrder(dashDefaultOrder);
    saveDashOrder(dashDefaultOrder);
    renderDashOrderUI();
  });
}

/* Settings tabs (Settings vs Preferences) */
function bindSettingsTabs(){
  const btnApp = $("settingsTabApp");
  const btnPrefs = $("settingsTabPrefs");
  const paneApp = $("settingsPaneApp");
  const panePrefs = $("settingsPanePrefs");
  if (!btnApp || !btnPrefs || !paneApp || !panePrefs) return;

  const show = (which) => {
    const prefs = which === "prefs";
    btnApp.classList.toggle("active", !prefs);
    btnPrefs.classList.toggle("active", prefs);

    paneApp.style.display = prefs ? "none" : "block";
    panePrefs.style.display = prefs ? "block" : "none";
    paneApp.setAttribute("aria-hidden", prefs ? "true" : "false");
    panePrefs.setAttribute("aria-hidden", prefs ? "false" : "true");

    if (prefs) renderDashOrderUI();
  };

  btnApp.addEventListener("click", () => show("app"));
  btnPrefs.addEventListener("click", () => show("prefs"));
  show("app");
}


/* ================= DRAWER MENU ================= */
const backdrop = $("backdrop");
const drawer = $("drawer");
const drawerNav = $("drawerNav");
const themeToggle = $("themeToggle");
const liveToggle = $("liveToggle");
const liveIcon = $("liveIcon");
const modeHint = $("modeHint");

const cloudDotMenu = $("cloudMenuDot");
const cloudTextMenu = $("cloudMenuStatus");
const cloudLastMenu = $("cloudMenuLast");

let isDrawerOpen = false;
function openDrawer(){
  isDrawerOpen = true;
  document.body.classList.add("drawer-open");
  drawer?.setAttribute("aria-hidden", "false");
  backdrop?.setAttribute("aria-hidden", "false");
}
function closeDrawer(){
  isDrawerOpen = false;
  document.body.classList.remove("drawer-open");
  drawer?.setAttribute("aria-hidden", "true");
  backdrop?.setAttribute("aria-hidden", "true");
}
function toggleDrawer(){ isDrawerOpen ? closeDrawer() : openDrawer(); }

menuBtn?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  toggleDrawer();
}, { passive: false });

backdrop?.addEventListener("click", () => closeDrawer(), { passive:true });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDrawer();
    closeComingSoon();
    exitFullscreenCard();
    closeSearch();
  }
});

themeToggle?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  applyTheme(theme === "dark" ? "light" : "dark");
}, { passive:false });

/* ================= COMING SOON overlay ================= */
const comingSoon = $("comingSoon");
const comingTitle = $("comingTitle");
const comingSub = $("comingSub");
const comingClose = $("comingClose");

function pageLabel(key){
  if (key === "home") return "HOME";
  if (key === "market") return "MARKET";
  return "PAGE";
}
function openComingSoon(pageKey){
  if (!comingSoon) return;
  if (comingTitle) comingTitle.textContent = `COMING SOON 🚀`;
  if (comingSub) comingSub.textContent = `${pageLabel(pageKey)} is coming soon.`;
  comingSoon.classList.add("show");
  comingSoon.setAttribute("aria-hidden", "false");
}
function closeComingSoon(){
  if (!comingSoon) return;
  comingSoon.classList.remove("show");
  comingSoon.setAttribute("aria-hidden", "true");
}
comingClose?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  closeComingSoon();
}, { passive:false });
comingSoon?.addEventListener("click", (e) => {
  if (e.target === comingSoon) closeComingSoon();
}, { passive:true });

/* ================= PAGES ================= */
const pageDashboard = $("pageDashboard");
const pageEvents = $("pageEvents");
const pageSettings = $("pageSettings");

function showPage(key){
  pageDashboard?.classList.remove("active");
  pageEvents?.classList.remove("active");
  pageSettings?.classList.remove("active");

  if (key === "events") pageEvents?.classList.add("active");
  else if (key === "settings") pageSettings?.classList.add("active");
  else pageDashboard?.classList.add("active");
}
function setActivePage(pageKey){
  const items = drawerNav?.querySelectorAll(".nav-item") || [];
  items.forEach(btn => btn.classList.toggle("active", btn.dataset.page === pageKey));
}

drawerNav?.addEventListener("click", (e) => {
  const btn = e.target?.closest(".nav-item");
  if (!btn) return;

  const page = btn.dataset.page || "dashboard";
  setActivePage(page);
  closeDrawer();

  if (page === "dashboard") {
    closeComingSoon();
    showPage("dashboard");
  } else if (page === "event" || page === "events") {
    closeComingSoon();
    showPage("events");
    renderEvents();
  } else if (page === "settings") {
    closeComingSoon();
    showPage("settings");
    renderSettingsSnapshot();
  } else {
    showPage("dashboard");
    openComingSoon(page);
  }
}, { passive:true });

/* ================= FULLSCREEN CARD ================= */
let expandedCard = null;
let expandedBackdrop = null;
const expandedHiddenMap = new Map();

function buildExpandedBackdrop(){
  if (expandedBackdrop) return;
  const bd = document.createElement("div");
  bd.style.position = "fixed";
  bd.style.inset = "0";
  bd.style.background = "rgba(0,0,0,0.50)";
  bd.style.backdropFilter = "blur(10px)";
  bd.style.zIndex = "190";
  bd.addEventListener("click", () => exitFullscreenCard(), { passive:true });
  document.body.appendChild(bd);
  expandedBackdrop = bd;
}
function hideNonChartContent(card){
  const hidden = [];
  const keepSet = new Set();
  const tools = card.querySelector(".card-tools");
  if (tools) keepSet.add(tools);

  const canvases = card.querySelectorAll("canvas");
  canvases.forEach(cv => {
    keepSet.add(cv);
    let p = cv.parentElement;
    while (p && p !== card) { keepSet.add(p); p = p.parentElement; }
  });

  [...card.children].forEach(ch => {
    if (keepSet.has(ch)) return;
    let ok = false;
    for (const k of keepSet) {
      if (k && k !== ch && k.contains && k.contains(ch)) { ok = true; break; }
    }
    if (ok) return;
    hidden.push([ch, ch.style.display]);
    ch.style.display = "none";
  });

  expandedHiddenMap.set(card, hidden);
}
function restoreNonChartContent(card){
  const hidden = expandedHiddenMap.get(card) || [];
  hidden.forEach(([el, disp]) => { el.style.display = disp || ""; });
  expandedHiddenMap.delete(card);
}

function setExpandBtnUI(card, expanded){
  const btn = card?.querySelector?.(".card-expand");
  if (!btn) return;

  if (expanded) {
    if (!btn.dataset.prevIcon) btn.dataset.prevIcon = btn.textContent || "⤢";
    if (!btn.dataset.prevLabel) btn.dataset.prevLabel = btn.getAttribute("aria-label") || "";
    btn.textContent = "✕";
    btn.setAttribute("aria-label", "Close");
  } else {
    btn.textContent = btn.dataset.prevIcon || "⤢";
    const prev = btn.dataset.prevLabel;
    if (prev) btn.setAttribute("aria-label", prev);
  }
}

function enterFullscreenCard(card){
  if (!card) return;
  if (expandedCard) exitFullscreenCard();
  expandedCard = card;

  buildExpandedBackdrop();
  expandedBackdrop.style.display = "block";

  document.body.classList.add("card-expanded");
  card.classList.add("fullscreen");
  setExpandBtnUI(card, true);
  hideNonChartContent(card);

  setTimeout(() => {
    try { chart?.resize?.(); } catch {}
    try { stakeChart?.resize?.(); } catch {}
    try { rewardChart?.resize?.(); } catch {}
    try { netWorthChart?.resize?.(); } catch {}
  }, 120);
}
function exitFullscreenCard(){
  if (!expandedCard) return;
  restoreNonChartContent(expandedCard);
  setExpandBtnUI(expandedCard, false);
  expandedCard.classList.remove("fullscreen");
  document.body.classList.remove("card-expanded");
  expandedBackdrop && (expandedBackdrop.style.display = "none");
  expandedCard = null;

  setTimeout(() => {
    try { chart?.resize?.(); } catch {}
    try { stakeChart?.resize?.(); } catch {}
    try { rewardChart?.resize?.(); } catch {}
    try { netWorthChart?.resize?.(); } catch {}
  }, 120);
}
function bindExpandButtons(){
  const btns = document.querySelectorAll(".card-expand");
  btns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".card");
      if (!card) return;
      if (card === expandedCard) exitFullscreenCard();
      else enterFullscreenCard(card);
    }, { passive:false });
  });
}

/* ================= EVENTS SYSTEM (per-address isolation + cloud) ================= */
let eventsAll = [];

function evStoreKey(addr){
  const a = (addr || "").trim();
  return a ? `inj_events_v${EV_LOCAL_VER}_${a}` : null;
}
function loadEvents(){
  const key = evStoreKey(address);
  if (!key) { eventsAll = []; return; }
  try{
    const raw = localStorage.getItem(key);
    if (!raw) { eventsAll = []; return; }
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj?.events)) { eventsAll = []; return; }
    eventsAll = obj.events.slice(0, 1200);
  } catch { eventsAll = []; }
}
function saveEvents(){
  const key = evStoreKey(address);
  if (!key) return;
  try{
    localStorage.setItem(key, JSON.stringify({ v: EV_LOCAL_VER, t: Date.now(), events: eventsAll.slice(0, 1200) }));
  } catch {}
  cloudBumpLocal(1);
  cloudMarkDirty({ events:true });
}
function showToast(ev){
  const host = $("toastHost");
  if (!host) return;

  const el = document.createElement("div");
  el.className = "toast";

  const when = fmtHHMMSS(ev.ts || Date.now());
  const title = ev.title || "Event";
  const sub = ev.detail || "";

  el.innerHTML = `
    <div class="toast-row">
      <div class="toast-title">${title}</div>
      <div style="font-weight:900;opacity:.82;font-size:.82rem">${when}</div>
    </div>
    <div class="toast-sub">${sub}</div>
  `;
  host.appendChild(el);
  setTimeout(() => { try { host.removeChild(el); } catch {} }, 2600);
}
function pushEvent(ev){
  if (!address) return;
  const obj = {
    id: ev.id || (String(Date.now()) + "_" + Math.random().toString(16).slice(2)),
    ts: ev.ts || Date.now(),
    kind: ev.kind || "info",
    title: ev.title || "Event",
    detail: ev.detail || "",
    dir: ev.dir || null,
    status: ev.status || "pending"
  };
  eventsAll.unshift(obj);
  eventsAll = eventsAll.slice(0, 1200);
  saveEvents();
  renderEvents();
  showToast(obj);

  if (obj.status === "pending" && obj.kind !== "price") {
    setTimeout(() => {
      const idx = eventsAll.findIndex(x => x.id === obj.id);
      if (idx >= 0) {
        eventsAll[idx].status = hasInternet() ? "ok" : "err";
        saveEvents();
        renderEvents();
      }
    }, 1500);
  }
}
function renderEvents(){
  const body = $("eventsTbody");
  const empty = $("eventsEmpty");
  if (!body) return;

  body.innerHTML = "";
  const list = eventsAll || [];

  if (empty) empty.style.display = list.length ? "none" : "block";
  if (!list.length) return;

  for (const ev of list){
    const tr = document.createElement("tr");
    const dt = new Date(ev.ts || Date.now());
    const when = `${dt.toLocaleDateString()} ${fmtHHMMSS(ev.ts || Date.now())}`;

    const k = (ev.kind || "info").toUpperCase();
    const st = (ev.status || "pending").toUpperCase();

    tr.innerHTML = `
      <td>${k}</td>
      <td style="white-space:nowrap">${when}</td>
      <td>${ev.detail || ev.title || ""}</td>
      <td>${st}</td>
    `;
    body.appendChild(tr);
  }
}
$("eventsClearBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  eventsAll = [];
  saveEvents();
  renderEvents();
}, { passive:false });

/* ================= MODE SWITCH ================= */
let accountPollTimer = null;
let restSyncTimer = null;
let chartSyncTimer = null;
let ensureChartTimer = null;
let cloudPullTimer = null;

function stopAllTimers(){
  if (accountPollTimer) { clearInterval(accountPollTimer); accountPollTimer = null; }
  if (restSyncTimer) { clearInterval(restSyncTimer); restSyncTimer = null; }
  if (chartSyncTimer) { clearInterval(chartSyncTimer); chartSyncTimer = null; }
  if (ensureChartTimer) { clearInterval(ensureChartTimer); ensureChartTimer = null; }
  if (cloudPullTimer) { clearInterval(cloudPullTimer); cloudPullTimer = null; }
}
function startAllTimers(){
  stopAllTimers();
  accountPollTimer = setInterval(loadAccount, ACCOUNT_POLL_MS);
  restSyncTimer = setInterval(loadCandleSnapshot, REST_SYNC_MS);
  chartSyncTimer = setInterval(loadChartToday, CHART_SYNC_MS);
  ensureChartTimer = setInterval(ensureChartBootstrapped, 1500);
  cloudPullTimer = setInterval(() => { if (address) cloudPull(); }, CLOUD_PULL_INTERVAL_MS);
}

async function refreshLoadAllOnce(){
  if (refreshLoading) return;
  if (!hasInternet()) { refreshLoaded = false; refreshConnUI(); cloudSetState("synced"); return; }

  refreshLoading = true;
  refreshLoaded = false;
  modeLoading = true;
  refreshConnUI();

  try{
    await loadCandleSnapshot(true);
    await loadChartToday(true);
    if (address) await loadAccount(true);
    refreshLoaded = true;
    modeLoading = false;
    refreshConnUI();
    cloudSetState("synced");
  } finally {
    refreshLoading = false;
    refreshConnUI();
  }
}

function setMode(isLive){
  liveMode = !!isLive;
  localStorage.setItem(MODE_KEY, liveMode ? "live" : "refresh");

  if (liveIcon) liveIcon.textContent = liveMode ? "📡" : "⟳";
  if (modeHint) modeHint.textContent = `Mode: ${liveMode ? "LIVE" : "REFRESH"}`;

  modeLoading = true;
  refreshConnUI();
  renderSettingsSnapshot();

  if (!liveMode) {
    stopAllTimers();
    stopAllSockets();
    wsTradeOnline = false;
    wsKlineOnline = false;
    accountOnline = false;

    refreshLoaded = false;
    refreshLoading = false;

    setTimeout(() => {
      refreshConnUI();
      refreshLoadAllOnce();
    }, REFRESH_RED_MS);

  } else {
    refreshLoaded = false;
    refreshLoading = false;

    startTradeWS();
    startKlineWS();
    loadCandleSnapshot();
    loadChartToday();
    if (address) loadAccount();
    startAllTimers();
    refreshConnUI();
  }
}

$("liveToggle")?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  setMode(!liveMode);
}, { passive:false });

/* ================= STATE ================= */
let targetPrice = 0;
let displayed = { price: 0, available: 0, stake: 0, rewards: 0, netWorthUsd: 0, apr: 0 };

let availableInj = 0, stakeInj = 0, rewardsInj = 0, apr = 0;

const candle = {
  d: { t: 0, open: 0, high: 0, low: 0 },
  w: { t: 0, open: 0, high: 0, low: 0 },
  m: { t: 0, open: 0, high: 0, low: 0 },
};
const tfReady = { d: false, w: false, m: false };

/* ================= WS (price + klines) ================= */
let wsTrade = null;
let wsKline = null;
let tradeRetryTimer = null;
let klineRetryTimer = null;

function stopAllSockets(){
  try { wsTrade?.close(); } catch {}
  try { wsKline?.close(); } catch {}
  wsTrade = null; wsKline = null;
  if (tradeRetryTimer) { clearTimeout(tradeRetryTimer); tradeRetryTimer = null; }
  if (klineRetryTimer) { clearTimeout(klineRetryTimer); klineRetryTimer = null; }
}
function scheduleTradeRetry() {
  if (tradeRetryTimer) clearTimeout(tradeRetryTimer);
  tradeRetryTimer = setTimeout(() => { if (liveMode) startTradeWS(); }, 1200);
}
function startTradeWS() {
  if (!liveMode) return;
  try { wsTrade?.close(); } catch {}

  wsTradeOnline = false;
  refreshConnUI();
  if (!hasInternet()) return;

  wsTrade = new WebSocket("wss://stream.binance.com:9443/ws/injusdt@trade");

  wsTrade.onopen = () => {
    wsTradeOnline = true;
    modeLoading = address ? !accountOnline : false;
    refreshConnUI();
  };
  wsTrade.onclose = () => { wsTradeOnline = false; refreshConnUI(); scheduleTradeRetry(); };
  wsTrade.onerror = () => { wsTradeOnline = false; refreshConnUI(); try { wsTrade.close(); } catch {} scheduleTradeRetry(); };

  wsTrade.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const p = safe(msg?.p);
    if (!p) return;

    targetPrice = p;

    if (tfReady.d) { candle.d.high = Math.max(candle.d.high, p); candle.d.low = Math.min(candle.d.low, p); }
    if (tfReady.w) { candle.w.high = Math.max(candle.w.high, p); candle.w.low = Math.min(candle.w.low, p); }
    if (tfReady.m) { candle.m.high = Math.max(candle.m.high, p); candle.m.low = Math.min(candle.m.low, p); }
  };
}
function scheduleKlineRetry() {
  if (klineRetryTimer) clearTimeout(klineRetryTimer);
  klineRetryTimer = setTimeout(() => { if (liveMode) startKlineWS(); }, 1200);
}
function applyKline(intervalKey, k) {
  const t = safe(k.t);
  const o = safe(k.o);
  const h = safe(k.h);
  const l = safe(k.l);
  if (o && h && l) {
    candle[intervalKey].t = t || candle[intervalKey].t;
    candle[intervalKey].open = o;
    candle[intervalKey].high = h;
    candle[intervalKey].low  = l;
    if (!tfReady[intervalKey]) {
      tfReady[intervalKey] = true;
      settleStart = Date.now();
    }
  }
}
function startKlineWS() {
  if (!liveMode) return;
  try { wsKline?.close(); } catch {}

  wsKlineOnline = false;
  refreshConnUI();
  if (!hasInternet()) return;

  const url =
    "wss://stream.binance.com:9443/stream?streams=" +
    "injusdt@kline_1m/" +
    "injusdt@kline_1d/" +
    "injusdt@kline_1w/" +
    "injusdt@kline_1M";

  wsKline = new WebSocket(url);

  wsKline.onopen = () => {
    wsKlineOnline = true;
    modeLoading = address ? !accountOnline : false;
    refreshConnUI();
  };
  wsKline.onclose = () => { wsKlineOnline = false; refreshConnUI(); scheduleKlineRetry(); };
  wsKline.onerror = () => { wsKlineOnline = false; refreshConnUI(); try { wsKline.close(); } catch {} scheduleKlineRetry(); };

  wsKline.onmessage = (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    const data = payload?.data;
    const stream = payload?.stream || "";
    const k = data?.k;
    if (!k) return;

    if (stream.includes("@kline_1m")) {
      updateChartFrom1mKline(k);
      return;
    }

    if (stream.includes("@kline_1d")) applyKline("d", k);
    else if (stream.includes("@kline_1w")) applyKline("w", k);
    else if (stream.includes("@kline_1M")) applyKline("m", k);
  };
}

/* ================= ACCOUNT (Injective LCD) ================= */
async function loadAccount(isRefresh=false) {
  if (!isRefresh && !liveMode) return;

  if (!address || !hasInternet()) {
    accountOnline = false;
    refreshConnUI();
    return;
  }

  const base = "https://lcd.injective.network";
  const [b, s, r, i] = await Promise.all([
    fetchJSON(`${base}/cosmos/bank/v1beta1/balances/${address}`),
    fetchJSON(`${base}/cosmos/staking/v1beta1/delegations/${address}`),
    fetchJSON(`${base}/cosmos/distribution/v1beta1/delegators/${address}/rewards`),
    fetchJSON(`${base}/cosmos/mint/v1beta1/inflation`)
  ]);

  if (!b || !s || !r || !i) {
    accountOnline = false;
    refreshConnUI();
    return;
  }

  accountOnline = true;
  modeLoading = false;
  refreshConnUI();

  const bal = b.balances?.find(x => x.denom === "inj");
  availableInj = safe(bal?.amount) / 1e18;

  const del = (s.delegation_responses || []);
  stakeInj = del.reduce((a, d) => a + safe(d?.balance?.amount), 0) / 1e18;

  // ✅ Validator card (top delegation)
  try { updateValidatorFromDelegations(del); } catch {}

  const newRewards = (r.rewards || []).reduce((a, x) => a + (x.reward || []).reduce((s2, y) => s2 + safe(y.amount), 0), 0) / 1e18;
  rewardsInj = newRewards;

  apr = safe(i.inflation) * 100;

  // ✅ APR change event
  if (lastAprSeen == null) lastAprSeen = apr;
  else {
    const dApr = apr - lastAprSeen;
    if (Math.abs(dApr) >= 0.05) {
      pushEvent({
        kind: "apr",
        title: dApr > 0 ? "APR increased" : "APR decreased",
        detail: `${(dApr>0?"+":"")}${dApr.toFixed(2)}% • Now ${apr.toFixed(2)}%`,
        dir: dApr > 0 ? "up" : "down",
        status: "done"
      });
      lastAprSeen = apr;
    }
  }

  try { recordAprPoint(); } catch {}

  maybeAddStakePoint(stakeInj);
  maybeRecordRewardWithdrawal(rewardsInj);
  recordNetWorthPoint();
}

/* ================= BINANCE REST: snapshot candele 1D/1W/1M ================= */
async function loadCandleSnapshot(isRefresh=false) {
  if (!isRefresh && !liveMode) return;
  if (!hasInternet()) return;

  const [d, w, m] = await Promise.all([
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1d&limit=1"),
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1w&limit=1"),
    fetchJSON("https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1M&limit=1"),
  ]);

  if (Array.isArray(d) && d[0]) {
    candle.d.t = safe(d[0][0]);
    candle.d.open = safe(d[0][1]);
    candle.d.high = safe(d[0][2]);
    candle.d.low  = safe(d[0][3]);
    if (candle.d.open && candle.d.high && candle.d.low) tfReady.d = true;
  }
  if (Array.isArray(w) && w[0]) {
    candle.w.t = safe(w[0][0]);
    candle.w.open = safe(w[0][1]);
    candle.w.high = safe(w[0][2]);
    candle.w.low  = safe(w[0][3]);
    if (candle.w.open && candle.w.high && candle.w.low) tfReady.w = true;
  }
  if (Array.isArray(m) && m[0]) {
    candle.m.t = safe(m[0][0]);
    candle.m.open = safe(m[0][1]);
    candle.m.high = safe(m[0][2]);
    candle.m.low  = safe(m[0][3]);
    if (candle.m.open && candle.m.high && candle.m.low) tfReady.m = true;
  }
}

/* ================= PRICE CHART (1D) ================= */
let chart = null;
let chartLabels = [];
let chartData = [];
let lastChartMinuteStart = 0;
let chartBootstrappedToday = false;

let hoverActive = false;
let hoverHideTimer = null;
let hoverIndex = null;
let pinnedIndex = null;
let isPanning = false;

const verticalLinePlugin = {
  id: "verticalLinePlugin",
  afterDraw(ch) {
    if (!hoverActive || hoverIndex == null) return;
    const meta = ch.getDatasetMeta(0);
    const el = meta?.data?.[hoverIndex];
    if (!el) return;
    const ctx = ch.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(el.x, ch.chartArea.top);
    ctx.lineTo(el.x, ch.chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(250,204,21,0.9)";
    ctx.stroke();
    ctx.restore();
  }
};


/* === Shared trend colors (line + last dot) === */
const SIGN_COLORS = {
  up:   { border: "#22c55e", fill: "rgba(34,197,94,.20)", dot: "rgba(34,197,94,0.95)" },
  down: { border: "#ef4444", fill: "rgba(239,68,68,.18)", dot: "rgba(239,68,68,0.95)" },
  flat: { border: "#3b82f6", fill: "rgba(59,130,246,.14)", dot: "rgba(59,130,246,0.95)" }
};
const LIVE_LINE = { border: "#3b82f6", fill: "rgba(59,130,246,.14)" };

function seriesSign(arr){
  const a = Array.isArray(arr) ? arr : [];
  if (a.length < 2) return "flat";
  const first = safe(a[0]);
  const last  = safe(a[a.length - 1]);
  if (last > first) return "up";
  if (last < first) return "down";
  return "flat";
}
function applyDatasetColors(ds, sign){
  if (!ds) return;
  const c = SIGN_COLORS[sign] || SIGN_COLORS.flat;
  ds.borderColor = c.border;
  ds.backgroundColor = c.fill;
}
function applyDatasetBlue(ds){
  if (!ds) return;
  ds.borderColor = LIVE_LINE.border;
  ds.backgroundColor = LIVE_LINE.fill;
}

function applyChartColorBySign(sign) {
  if (!chart) return;
  const ds = chart.data.datasets?.[0];
  if (!ds) return;
  applyDatasetColors(ds, sign);
  chart.update("none");
}


let lastPriceTrendAt = 0;
function updatePriceChartTrend(force=false){
  if (!chart) return;
  const now = Date.now();
  if (!force && (now - lastPriceTrendAt) < 350) return;
  lastPriceTrendAt = now;

  const ds = chart.data.datasets?.[0];
  const data = ds?.data || [];
  const sign = seriesSign(data);

  // ✅ Price Chart: LIVE = blue line (15m). Other TFs = performance color.
  if (ds) {
    if (priceTf === "live") applyDatasetBlue(ds);
    else applyDatasetColors(ds, sign);
  }

  // ✅ Last dot: red/green based on performance of the selected TF
  chart.$lastPointColor = (SIGN_COLORS[sign] || SIGN_COLORS.flat).dot;

  try { chart.update("none"); } catch {}
}


function updatePinnedOverlay() {
  const overlay = $("chartOverlay");
  const chartEl = $("chartPrice");
  if (!overlay || !chartEl || !chart) return;

  if (pinnedIndex == null) {
    overlay.classList.remove("show");
    chartEl.textContent = "--";
    return;
  }

  const ds = chart.data.datasets?.[0]?.data || [];
  const lbs = chart.data.labels || [];
  if (!ds.length || !lbs.length) {
    overlay.classList.remove("show");
    chartEl.textContent = "--";
    return;
  }

  let idx = Number.isFinite(+pinnedIndex) ? +pinnedIndex : null;
  if (idx == null) return;

  idx = clamp(Math.round(idx), 0, ds.length - 1);
  const price = safe(ds[idx]);
  const label = lbs[idx];
  if (!Number.isFinite(price) || !label) return;

  const ts = labelToTs(label);
  const span = spanMsFromLabels(lbs);
  const lbl = ts ? fmtAxisX(ts, span) : String(label);
  chartEl.textContent = `${lbl} • $${price.toFixed(4)}`;
  overlay.classList.add("show");
}

async function fetchKlines1mRange(startTime, endTime) {
  const out = [];
  let cursor = startTime;
  const end = endTime || Date.now();

  while (cursor < end && out.length < DAY_MINUTES) {
    const url = `https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=1m&limit=1000&startTime=${cursor}&endTime=${end}`;
    const d = await fetchJSON(url);
    if (!Array.isArray(d) || !d.length) break;

    out.push(...d);
    const lastOpenTime = safe(d[d.length - 1][0]);
    cursor = lastOpenTime + ONE_MIN_MS;

    if (!lastOpenTime) break;
    if (d.length < 1000) break;
  }
  return out.slice(0, DAY_MINUTES);
}

function initChartToday() {
  const canvas = $("priceChart");
  if (!canvas || !window.Chart) return;

  const zoomBlock = ZOOM_OK ? {
    zoom: {
      pan: {
        enabled: true,
        mode: "x",
        threshold: 2,
        onPanStart: () => { isPanning = true; },
        onPanComplete: ({ chart }) => {
          isPanning = false;
          const xScale = chart.scales.x;
          const center = (chart.chartArea.left + chart.chartArea.right) / 2;
          pinnedIndex = xScale.getValueForPixel(center);
          updatePinnedOverlay();
        }
      },
      zoom: {
        wheel: { enabled: true },
        pinch: { enabled: true },
        mode: "x",
        onZoomComplete: ({ chart }) => {
          const xScale = chart.scales.x;
          const center = (chart.chartArea.left + chart.chartArea.right) / 2;
          pinnedIndex = xScale.getValueForPixel(center);
          updatePinnedOverlay();
        }
      }
    }
  } : {};

  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartData,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.14)",
        fill: true,
        pointRadius: 0,
        tension: 0.3,
        cubicInterpolationMode: "monotone",
        spanGaps: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        ...zoomBlock
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { display: true, ticks: { color: axisTickColor(), maxRotation: 0, autoSkip: true, maxTicksLimit: 6,
          callback: (v) => {
            const lbs = chart?.data?.labels || [];
            const span = spanMsFromLabels(lbs);
            const lbl = (lbs?.[v] ?? v);
            const ts = labelToTs(lbl);
            return fmtAxisX(ts, span);
          }
        }, grid: { color: axisGridColor() }, border:{ display:false } },
        y: {
          ticks: { color: axisTickColor() },
          grid: { color: axisGridColor() }
        }
      }
    },
    plugins: [verticalLinePlugin, lastDotPlugin]
  });

  setupChartInteractions();
}

async function loadChartToday(isRefresh=false) {
  if (!isRefresh && !liveMode) return;
  if (!hasInternet()) return;
  if (!tfReady.d || !candle.d.t) return;

  const kl = await fetchKlines1mRange(candle.d.t, Date.now());
  if (!kl.length) return;

  chartLabels = kl.map(k => tsLabel(safe(k[0])));
  chartData   = kl.map(k => safe(k[4]));
  lastChartMinuteStart = safe(kl[kl.length - 1][0]) || 0;

  const lastClose = safe(kl[kl.length - 1][4]);
  if (!targetPrice && lastClose) targetPrice = lastClose;

  if (!chart) initChartToday();
  if (chart) {
    chart.data.labels = chartLabels;
    chart.data.datasets[0].data = chartData;
    chart.update("none");
  }

  chartBootstrappedToday = true;
}

function setupChartInteractions() {
  const canvas = $("priceChart");
  if (!canvas || !chart) return;

  const getIndexFromEvent = (evt) => {
    try{
      const points = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, false);
      if (!points || !points.length) return null;
      return points[0].index;
    } catch { return null; }
  };

  const armHide = () => {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      hoverActive = false;
      hoverIndex = null;
      pinnedIndex = null;
      updatePinnedOverlay();
      try { chart && chart.update("none"); } catch {}
    }, 950);
  };

  const start = (evt) => {
    if (!chart || isPanning) return;
    const idx = getIndexFromEvent(evt);
    if (idx == null) return;

    hoverActive = true;
    hoverIndex = idx;
    pinnedIndex = idx;

    updatePinnedOverlay();
    try { chart.update("none"); } catch {}
    armHide();
  };

  const move = (evt) => {
    if (!hoverActive) return; // only after click/tap
    const idx = getIndexFromEvent(evt);
    if (idx == null) return;

    hoverIndex = idx;
    pinnedIndex = idx;

    updatePinnedOverlay();
    try { chart.update("none"); } catch {}
    armHide();
  };

  const end = () => {
    hoverActive = false;
    hoverIndex = null;
    pinnedIndex = null;
    updatePinnedOverlay();
    try { chart && chart.update("none"); } catch {}
  };

  // click/tap to show
  canvas.addEventListener("click", start, { passive:true });
  canvas.addEventListener("touchstart", start, { passive:true });

  // allow short drag while active
  canvas.addEventListener("mousemove", move, { passive:true });
  canvas.addEventListener("touchmove", move, { passive:true });

  canvas.addEventListener("mouseleave", end, { passive:true });
  canvas.addEventListener("touchend", end, { passive:true });
  canvas.addEventListener("touchcancel", end, { passive:true });
}

function updateChartFrom1mKline(k) {
  if (!liveMode) return;
  if (!(priceTf === "live" || priceTf === "1d")) return;
  if (!chart || !chartBootstrappedToday || !tfReady.d || !candle.d.t) return;

  const openTime = safe(k.t);
  const close = safe(k.c);
  if (!openTime || !close) return;
  if (openTime < candle.d.t) return;

  // Update last candle (same minute)
  if (lastChartMinuteStart === openTime) {
    const idx = chart.data.datasets[0].data.length - 1;
    if (idx >= 0) {
      chart.data.datasets[0].data[idx] = close;
      updatePriceChartTrend(false);
    }
    return;
  }

  // New minute candle
  lastChartMinuteStart = openTime;
  chart.data.labels.push(tsLabel(openTime));
  chart.data.datasets[0].data.push(close);

  const maxPts = (priceTf === "live") ? 32 : DAY_MINUTES;

  while (chart.data.labels.length > maxPts) chart.data.labels.shift();
  while (chart.data.datasets[0].data.length > maxPts) chart.data.datasets[0].data.shift();

  // Hard cutoff for LIVE 15m window (defensive, in case of gaps)
  if (priceTf === "live") {
    const cutoff = Date.now() - 15*60*1000 - 2*ONE_MIN_MS;
    while (chart.data.labels.length) {
      const t0 = labelToTs(chart.data.labels[0]);
      if (!t0 || t0 >= cutoff) break;
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
    }
  }

  updatePriceChartTrend(true);
}

/* ================= STAKE CHART (persist) ================= */
let stakeChart = null;
let stakeLabels = [];
let stakeData = [];
let stakeMoves = [];
let stakeTypes = [];
let lastStakeRecordedRounded = null;
let stakeBaselineCaptured = false;

function stakeStoreKey(addr) {
  const a = (addr || "").trim();
  return a ? `inj_stake_series_v${STAKE_LOCAL_VER}_${a}` : null;
}
function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}
function saveStakeSeriesLocal() {
  const key = stakeStoreKey(address);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      v: STAKE_LOCAL_VER, t: Date.now(),
      labels: stakeLabels, data: stakeData, moves: stakeMoves, types: stakeTypes
    }));
    cloudBumpLocal(1);
  } catch {}
  cloudMarkDirty({ stake:true });
}
function loadStakeSeriesLocal() {
  const key = stakeStoreKey(address);
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== STAKE_LOCAL_VER) return false;

    stakeLabels = Array.isArray(obj.labels) ? obj.labels : [];
    stakeData   = Array.isArray(obj.data)   ? obj.data   : [];
    stakeMoves  = Array.isArray(obj.moves)  ? obj.moves  : [];
    stakeTypes  = Array.isArray(obj.types)  ? obj.types  : [];

    const n = stakeData.length;
    stakeLabels = stakeLabels.slice(0, n);
    stakeMoves  = stakeMoves.slice(0, n);
    stakeTypes  = stakeTypes.slice(0, n);

    while (stakeMoves.length < n) stakeMoves.push(0);
    while (stakeTypes.length < n) stakeTypes.push("Stake update");

    stakeBaselineCaptured = stakeData.length > 0;
    lastStakeRecordedRounded = stakeData.length ? Number(safe(stakeData[stakeData.length - 1]).toFixed(6)) : null;
    return true;
  } catch { return false; }
}

function initStakeChart() {
  const canvas = $("stakeChart");
  if (!canvas || !window.Chart) return;

  stakeChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: stakeLabels,
      datasets: [{
        data: stakeData,
        borderColor: "#22c55e",
        backgroundColor: "rgba(34,197,94,.18)",
        fill: true,
        tension: 0.25,
        cubicInterpolationMode: "monotone",
        spanGaps: true,
        pointRadius: 3,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        ...(ZOOM_OK ? { zoom: { pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } } } : {})
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: axisTickColor(), maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { color: axisGridColor() } },
        y: { ticks: { color: axisTickColor() }, grid: { color: axisGridColor() } }
      }
    },
    plugins: [lastDotPlugin]
  });

  // ✅ Staked: last point always blinks green
  stakeChart.$lastPointColor = SIGN_COLORS.up.dot;

  attachCrosshair2(stakeChart, $("stakeReadout"), (i, lbs, ds) => {
    const t = labelToTs(lbs?.[i]);
    const v = safe(ds?.[i]);
    return `${t ? new Date(t).toLocaleString() : "—"} • ${v.toFixed(4)} INJ`;
  });
}
function drawStakeChart() {
  if (!stakeChart) initStakeChart();
  if (stakeChart) {
    stakeChart.data.labels = stakeLabels;
    stakeChart.data.datasets[0].data = stakeData;

    // dynamic x-axis labels
    try{
      stakeChart.options.scales.x.ticks = stakeChart.options.scales.x.ticks || {};
      stakeChart.options.scales.x.ticks.callback = (v, i) => {
        const span = spanMsFromLabels(stakeLabels);
        const lbl = (stakeLabels?.[v] ?? v);
        const ts = labelToTs(lbl);
        return fmtAxisX(ts, span);
      };
    } catch {}

    stakeChart.update("none");
  }
}

function maybeAddStakePoint(currentStake) {
  const s = safe(currentStake);
  if (!Number.isFinite(s)) return;
  const rounded = Number(s.toFixed(6));

  if (!stakeBaselineCaptured) {
    stakeLabels.push(tsLabel());
    stakeData.push(rounded);
    stakeMoves.push(1);
    stakeTypes.push("Baseline (current)");
    lastStakeRecordedRounded = rounded;
    stakeBaselineCaptured = true;
    saveStakeSeriesLocal();
    drawStakeChart();
    return;
  }

  if (lastStakeRecordedRounded == null) { lastStakeRecordedRounded = rounded; return; }
  if (rounded === lastStakeRecordedRounded) return;

  const delta = rounded - lastStakeRecordedRounded;
  lastStakeRecordedRounded = rounded;

  stakeLabels.push(tsLabel());
  stakeData.push(rounded);
  stakeMoves.push(delta > 0 ? 1 : -1);
  stakeTypes.push(delta > 0 ? "Delegate / Compound" : "Undelegate");

  saveStakeSeriesLocal();
  drawStakeChart();

  pushEvent({
    kind: "tx",
    title: delta > 0 ? "Stake increased" : "Stake decreased",
    detail: `${delta > 0 ? "+" : ""}${delta.toFixed(6)} INJ`,
    status: "pending"
  });
}

/* ================= REWARD WITHDRAWALS (persist) ================= */
let wdLabelsAll = [];
let wdValuesAll = [];
let wdTimesAll  = [];

let wdLabels = [];
let wdValues = [];
let wdTimes  = [];

let wdLastRewardsSeen = null;
let wdMinFilter = 0;

function wdStoreKey(addr) {
  const a = (addr || "").trim();
  return a ? `inj_reward_withdrawals_v${REWARD_WD_LOCAL_VER}_${a}` : null;
}
function saveWdAllLocal() {
  const key = wdStoreKey(address);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      v: REWARD_WD_LOCAL_VER, t: Date.now(),
      labels: wdLabelsAll, values: wdValuesAll, times: wdTimesAll
    }));
    cloudBumpLocal(1);
  } catch {}
  cloudMarkDirty({ wd:true });
}
function loadWdAllLocal() {
  const key = wdStoreKey(address);
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== REWARD_WD_LOCAL_VER) return false;

    wdLabelsAll = Array.isArray(obj.labels) ? obj.labels : [];
    wdValuesAll = Array.isArray(obj.values) ? obj.values : [];
    wdTimesAll  = Array.isArray(obj.times)  ? obj.times  : [];

    rebuildWdView();
    return true;
  } catch { return false; }
}

function rebuildWdView() {
  wdLabels = [];
  wdValues = [];
  wdTimes  = [];

  for (let i = 0; i < wdValuesAll.length; i++) {
    const v = safe(wdValuesAll[i]);
    if (v >= wdMinFilter) {
      wdLabels.push(wdLabelsAll[i]);
      wdValues.push(v);
      wdTimes.push(wdTimesAll[i] || 0);
    }
  }

  drawRewardWdChart();
  syncRewardTimelineUI(true);
}

let rewardChart = null;

function initRewardWdChart() {
  const canvas = $("rewardChart");
  if (!canvas || !window.Chart) return;

  rewardChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: wdLabels,
      datasets: [{
        data: wdValues,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.14)",
        fill: true,
        tension: 0.25,
        cubicInterpolationMode: "monotone",
        spanGaps: true,
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        ...(ZOOM_OK ? { zoom: { pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } } } : {})
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: axisTickColor(), maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { color: axisGridColor() } },
        y: { position:"right", ticks: { color: axisTickColor(), callback: (v) => fmtSmart(v) }, grid: { color: axisGridColor() } }
      }
    },
    plugins: [lastDotPlugin]
  });

  // ✅ Rewards: last point always blinks green
  rewardChart.$lastPointColor = SIGN_COLORS.up.dot;

  attachCrosshair2(rewardChart, $("rewardReadout"), (i, lbs, ds) => {
    const t = labelToTs(lbs?.[i]) || (wdTimes?.[i] || 0);
    const v = safe(ds?.[i]);
    return `${t ? new Date(t).toLocaleString() : "—"} • +${v.toFixed(6)} INJ`;
  });
}
function drawRewardWdChart() {
  if (!rewardChart) initRewardWdChart();
  if (rewardChart) {
    rewardChart.data.labels = wdLabels;
    rewardChart.data.datasets[0].data = wdValues;

    // dynamic x-axis labels
    try{
      rewardChart.options.scales.x.ticks = rewardChart.options.scales.x.ticks || {};
      rewardChart.options.scales.x.ticks.callback = (v, i) => {
        const span = spanMsFromLabels(wdLabels);
        const lbl = (wdLabels?.[v] ?? v);
        const ts = labelToTs(lbl);
        return fmtAxisX(ts, span);
      };
    } catch {}

    rewardChart.update("none");
  }
}

function syncRewardTimelineUI(forceToEnd=false) {
  const slider = $("rewardTimeline");
  const meta = $("rewardTimelineMeta");
  if (!slider || !meta) return;

  const n = wdValues.length;
  if (!n) {
    slider.min = 0; slider.max = 0; slider.value = 0;
    meta.textContent = "—";
    if (rewardChart) {
      rewardChart.options.scales.x.min = undefined;
      rewardChart.options.scales.x.max = undefined;
      rewardChart.update("none");
    }
    return;
  }

  slider.min = 0;
  slider.max = String(n - 1);
  if (forceToEnd) slider.value = String(n - 1);

  const idx = clamp(parseInt(slider.value || "0", 10), 0, n - 1);
  const win = Math.min(60, n);
  const minIdx = Math.max(0, idx - win + 1);
  const maxIdx = idx;

  if (rewardChart) {
    rewardChart.options.scales.x.min = minIdx;
    rewardChart.options.scales.x.max = maxIdx;
    rewardChart.update("none");
  }

  const fromTs = wdTimes[minIdx] || labelToTs(wdLabels[minIdx]);
  const toTs   = wdTimes[maxIdx] || labelToTs(wdLabels[maxIdx]);
  const from = fromTs ? fmtHHMM(fromTs) : (wdLabels[minIdx] || "");
  const to   = toTs ? fmtHHMM(toTs) : (wdLabels[maxIdx] || "");
  meta.textContent = n <= 1 ? `${to}` : `${from} → ${to}`;
}

$("rewardTimeline")?.addEventListener("input", () => syncRewardTimelineUI(false), { passive: true });
$("rewardLiveBtn")?.addEventListener("click", () => {
  const slider = $("rewardTimeline");
  if (slider) slider.value = String(Math.max(0, wdValues.length - 1));
  if (rewardChart?.resetZoom) rewardChart.resetZoom();
  syncRewardTimelineUI(true);
}, { passive: true });

$("rewardFilter")?.addEventListener("change", (e) => {
  wdMinFilter = safe(e.target.value);
  rebuildWdView();
  const slider = $("rewardTimeline");
  if (slider) slider.value = String(Math.max(0, wdValues.length - 1));
  syncRewardTimelineUI(true);
}, { passive: true });

function maybeRecordRewardWithdrawal(newRewards) {
  const r = safe(newRewards);
  if (wdLastRewardsSeen == null) { wdLastRewardsSeen = r; return; }

  const diff = wdLastRewardsSeen - r;
  if (diff > REWARD_WITHDRAW_THRESHOLD) {
    const ts = Date.now();
    wdTimesAll.push(ts);
    wdLabelsAll.push(tsLabel(ts));
    wdValuesAll.push(diff);
    saveWdAllLocal();
    rebuildWdView();

    pushEvent({
      kind: "tx",
      title: "Rewards withdrawn",
      detail: `+${diff.toFixed(6)} INJ`,
      status: "pending"
    });
  }
  wdLastRewardsSeen = r;
}

/* ================= NET WORTH (persist + chart) ================= */
let nwTf = "live";
let nwScale = "linear";
let nwTAll = [];
let nwUsdAll = [];
let nwInjAll = [];

let netWorthChart = null;
let lastNWDrawAt = 0;
let lastNWPointAt = 0;

function nwStoreKey(addr){
  const a = (addr || "").trim();
  return a ? `inj_networth_v${NW_LOCAL_VER}_${a}` : null;
}
function clampNWArrays(){
  const n = Math.min(nwTAll.length, nwUsdAll.length, nwInjAll.length);
  nwTAll = nwTAll.slice(-n);
  nwUsdAll = nwUsdAll.slice(-n);
  nwInjAll = nwInjAll.slice(-n);
  if (nwTAll.length > NW_MAX_POINTS){
    nwTAll = nwTAll.slice(-NW_MAX_POINTS);
    nwUsdAll = nwUsdAll.slice(-NW_MAX_POINTS);
    nwInjAll = nwInjAll.slice(-NW_MAX_POINTS);
  }
}
function saveNWLocal(){
  const key = nwStoreKey(address);
  if (!key) return;
  try{
    localStorage.setItem(key, JSON.stringify({
      v: NW_LOCAL_VER, t: Date.now(),
      tAll: nwTAll,
      usdAll: nwUsdAll,
      injAll: nwInjAll,
      tf: nwTf,
      scale: nwScale
    }));
    cloudBumpLocal(1);
  } catch {}
  cloudMarkDirty({ nw:true });
}
function loadNWLocal(){
  const key = nwStoreKey(address);
  if (!key) return false;
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== NW_LOCAL_VER) return false;

    nwTAll = Array.isArray(obj.tAll) ? obj.tAll.map(Number) : [];
    nwUsdAll = Array.isArray(obj.usdAll) ? obj.usdAll.map(Number) : [];
    nwInjAll = Array.isArray(obj.injAll) ? obj.injAll.map(Number) : [];
    nwTf = typeof obj.tf === "string" ? obj.tf : "live";
    nwScale = (obj.scale === "log") ? "log" : "linear";

    clampNWArrays();
    return true;
  } catch { return false; }
}

function nwWindowMs(tf){
  if (tf === "live") return NW_LIVE_WINDOW_MS;
  if (tf === "1w") return 7 * 24 * 60 * 60 * 1000;
  if (tf === "1m") return 30 * 24 * 60 * 60 * 1000;
  if (tf === "1y") return 365 * 24 * 60 * 60 * 1000;
  if (tf === "all") return 10 * 365 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}
function nwHasSpan(tf){
  if (!nwTAll.length) return false;
  const first = nwTAll[0];
  const span = Date.now() - first;
  return span >= nwWindowMs(tf) * 0.8;
}
function nwBuildView(tf){
  const now = Date.now();
  const w = nwWindowMs(tf);
  const minT = (tf === "all") ? 0 : (now - w);

  const labels = [];
  const data = [];

  for (let i = 0; i < nwTAll.length; i++){
    const t = safe(nwTAll[i]);
    const u = safe(nwUsdAll[i]);
    if (t >= minT && Number.isFinite(u) && u > 0) {
      labels.push(tsLabel(t));
      data.push(u);
    }
  }
  return { labels, data };
}

const nwLastDotPlugin = {
  id: "nwLastDotPlugin",
  afterDatasetsDraw(ch) {
    const meta = ch.getDatasetMeta(0);
    const pts = meta?.data || [];
    if (!pts.length) return;

    const el = pts[pts.length - 1];
    if (!el) return;

    const t = Date.now();
    const pulse = 0.35 + 0.65 * Math.abs(Math.sin(t / 320));

    const ctx = ch.ctx;
    ctx.save();
    ctx.shadowColor = `rgba(250,204,21,${0.35 * pulse})`;
    ctx.shadowBlur = 10;

    ctx.beginPath();
    ctx.arc(el.x, el.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(250,204,21,${0.22 * pulse})`;
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(el.x, el.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(250,204,21,${0.95 * pulse})`;
    ctx.fill();

    ctx.restore();
  }
};

function initNWChart(){
  const canvas = $("netWorthChart");
  if (!canvas || !window.Chart) return;

  const view = nwBuildView(nwTf);

  netWorthChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: view.labels,
      datasets: [{
        data: view.data,
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,.12)",
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        cubicInterpolationMode: "monotone",
        pointRadius: 0,
        pointHitRadius: 18,
        spanGaps: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        ...(ZOOM_OK ? { zoom: { pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" } } } : {})
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          display: true,
          ticks: {
            color: axisTickColor(),
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            callback: (val, idx) => {
              const lbs = netWorthChart?.data?.labels || [];
              const span = spanMsFromLabels(lbs);
              const lbl = (lbs?.[val] ?? val);
              const ts = labelToTs(lbl);
              return fmtAxisX(ts, span);
            }
          },
          grid: { display: false },
          border: { display: false }
        },
        y: {
          type: (nwScale === "log") ? "logarithmic" : "linear",
          position: "right",
          afterFit: (scale) => { scale.width = Math.min(scale.width, 56); },
          ticks: {
            color: axisTickColor(),
            maxTicksLimit: 5,
            callback: (v) => `$${fmtSmart(v)}`
          },
          grid: { color: axisGridColor() },
          border: { display: false }
        }
      }
    },
    plugins: [lastDotPlugin]
  });

  attachCrosshair2(netWorthChart, $("nwReadout"), (i, lbs, ds) => {
    const t = labelToTs(lbs?.[i]);
    const v = safe(ds?.[i]);
    return `${t ? fmtHHMM(t) : "—"} • $${v.toFixed(2)}`;
  });
}

function updateNWTFButtons(){
  const wrap = $("nwTfSwitch");
  if (!wrap) return;
  const btns = wrap.querySelectorAll(".tf-btn");
  btns.forEach(b => {
    const tf = b.dataset.tf || "";
    const enabled = (tf === "live") ? true
      : (tf === "1d") ? true
      : (tf === "1w") ? nwHasSpan("1w")
      : (tf === "1m") ? nwHasSpan("1m")
      : (tf === "1y") ? nwHasSpan("1y")
      : (tf === "all") ? (nwTAll.length > 20)
      : true;

    b.disabled = !enabled;
    b.style.opacity = enabled ? "1" : "0.42";
    b.style.pointerEvents = enabled ? "auto" : "none";
    b.classList.toggle("active", (b.dataset.tf === nwTf));
  });
}

function drawNW(force=false){
  const now = Date.now();
  if (!force && (now - lastNWDrawAt) < NW_DRAW_MIN_MS) return;
  lastNWDrawAt = now;

  if (!netWorthChart) initNWChart();
  if (!netWorthChart) return;

  const view = nwBuildView(nwTf);

  netWorthChart.data.labels = view.labels;
  netWorthChart.data.datasets[0].data = view.data;
  netWorthChart.options.scales.y.type = (nwScale === "log") ? "logarithmic" : "linear";

  // ✅ Net Worth: LIVE = blue line (15m). Other TFs = performance color.
  const nwSign = seriesSign(view.data);
  const nwDs = netWorthChart.data.datasets?.[0];
  if (nwDs) {
    if (nwTf === "live") applyDatasetBlue(nwDs);
    else applyDatasetColors(nwDs, nwSign);
  }
  // ✅ Last dot: red/green based on performance of the selected TF
  netWorthChart.$lastPointColor = (SIGN_COLORS[nwSign] || SIGN_COLORS.flat).dot;

  netWorthChart.update("none");

  const pnlEl = $("netWorthPnl");
  if (view.data.length >= 2){
    const first = safe(view.data[0]);
    const last  = safe(view.data[view.data.length - 1]);
    const pnl = last - first;
    const pnlPct = first ? (pnl / first) * 100 : 0;

    if (pnlEl){
      // Privacy mode: hide PnL text only (chart stays visible)
      if (document.body?.classList?.contains("privacy-on") && pnlEl.classList.contains("privacy-mask")) {
        pnlEl.classList.remove("good","bad");
        pnlEl.classList.add("flat");
        pnlEl.textContent = pnlEl.dataset.privacyPlaceholder || "PnL: •••";
      } else {
        pnlEl.classList.remove("good","bad","flat");
        pnlEl.classList.add(pnl > 0 ? "good" : pnl < 0 ? "bad" : "flat");
        const sign = pnl > 0 ? "+" : "";
        pnlEl.textContent = `PnL: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`;
      }
    }
  } else {
    if (pnlEl){
      pnlEl.classList.remove("good","bad");
      pnlEl.classList.add("flat");
      if (document.body?.classList?.contains("privacy-on") && pnlEl.classList.contains("privacy-mask")) {
        pnlEl.textContent = pnlEl.dataset.privacyPlaceholder || "PnL: •••";
      } else {
        pnlEl.textContent = "PnL: —";
      }
    }
  }

  updateNWTFButtons();
  // keep readout alive
  if (netWorthChart && $("nwReadout")) {
    const ds = netWorthChart.data.datasets?.[0]?.data || [];
    const lbs = netWorthChart.data.labels || [];
    if (ds.length) {
      const i = ds.length - 1;
      const ts = labelToTs(lbs[i]);
      setText("nwReadout", `${ts ? fmtHHMM(ts) : "—"} • $${safe(ds[i]).toFixed(2)}`);
    } else {
      setText("nwReadout", "—");
    }
  }
}

$("nwTfSwitch")?.addEventListener("click", (e) => {
  const btn = e.target?.closest(".tf-btn");
  if (!btn) return;
  const tf = btn.dataset.tf || "live";
  if (!["live","1d","1w","1m","1y","all"].includes(tf)) return;
  if (btn.disabled) return;

  nwTf = tf;
  saveNWLocal();
  drawNW(true);
}, { passive:true });

$("nwScaleToggle")?.addEventListener("click", (e) => {
  e.preventDefault();
  nwScale = (nwScale === "log") ? "linear" : "log";
  const b = $("nwScaleToggle");
  if (b) b.textContent = (nwScale === "log") ? "LOG" : "LIN";
  saveNWLocal();
  drawNW(true);
}, { passive:false });

$("nwLiveToggle")?.addEventListener("click", (e) => {
  e.preventDefault();
  const b = $("nwLiveToggle");
  const on = (nwTf === "live") ? false : true;
  nwTf = on ? "live" : "1d";
  if (b) b.classList.toggle("active", on);
  saveNWLocal();
  drawNW(true);
}, { passive:false });

function updateNetWorthMiniRows(){
  const totalInj = safe(availableInj) + safe(stakeInj) + safe(rewardsInj);
  setText("netWorthInj", `${totalInj.toFixed(4)} INJ`);
}

function recordNetWorthPoint(){
  if (!address) return;

  const now = Date.now();
  if ((now - lastNWPointAt) < NW_POINT_MIN_MS) return;

  const px = safe(targetPrice);
  if (!Number.isFinite(px) || px <= 0) return;

  const totalInj = safe(availableInj) + safe(stakeInj) + safe(rewardsInj);
  const totalUsd = totalInj * px;
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return;

  const lastT = nwTAll.length ? safe(nwTAll[nwTAll.length - 1]) : 0;
  const lastUsd = nwUsdAll.length ? safe(nwUsdAll[nwUsdAll.length - 1]) : 0;

  const dt = now - lastT;
  const dUsd = Math.abs(totalUsd - lastUsd);

  if (lastT && dt < NW_POINT_MIN_MS && dUsd < 0.50) return;

  lastNWPointAt = now;
  nwTAll.push(now);
  nwUsdAll.push(totalUsd);
  nwInjAll.push(totalInj);
  clampNWArrays();
  saveNWLocal();
  drawNW(false);
}

/* ================= CLOUD SYNC ================= */
const CLOUD_VER = 2;
const CLOUD_KEY = `inj_cloudmeta_v${CLOUD_VER}`;
let cloudPts = 0;
let cloudLastSync = 0;
let cloudDirty = false;
let cloudPushTimer = null;

// track "what syncing" for Advanced settings
let cloudDirtyWhat = { stake:false, wd:false, nw:false, events:false };

function cloudLoadMeta(){
  try{
    const raw = localStorage.getItem(CLOUD_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    cloudPts = safe(obj?.pts);
    cloudLastSync = safe(obj?.lastSync);
  } catch {}
}
function cloudSaveMeta(){
  try{ localStorage.setItem(CLOUD_KEY, JSON.stringify({ v:CLOUD_VER, pts: cloudPts, lastSync: cloudLastSync })); } catch {}
}
function cloudSetState(state){
  const st = $("cloudStatus");
  if (st){
    if (state === "saving") st.textContent = hasInternet() ? "Cloud: Saving" : "Cloud: Offline cache";
    else if (state === "error") st.textContent = "Cloud: Error";
    else st.textContent = hasInternet() ? "Cloud: Synced" : "Cloud: Offline cache";
  }

  // menu
  if (cloudDotMenu) {
    cloudDotMenu.classList.remove("ok","saving","err");
    if (state === "saving") cloudDotMenu.classList.add("saving");
    else if (state === "error") cloudDotMenu.classList.add("err");
    else cloudDotMenu.classList.add("ok");
  }
  if (cloudTextMenu) {
    cloudTextMenu.textContent = (state === "saving") ? "Saving"
      : (state === "error") ? "Error"
      : hasInternet() ? "Synced" : "Offline cache";
  }
  if (cloudLastMenu){
    cloudLastMenu.textContent = cloudLastSync ? new Date(cloudLastSync).toLocaleString() : "—";
  }

  // Advanced settings monitor
  const advDot = $("cloudAdvDot");
  const advSt = $("cloudAdvState");
  const advLast = $("cloudAdvLast");
  const advPts = $("cloudAdvPts");
  const advWhat = $("cloudAdvWhat");

  if (advDot) {
    advDot.classList.remove("ok","saving","err");
    if (state === "saving") advDot.classList.add("saving");
    else if (state === "error") advDot.classList.add("err");
    else advDot.classList.add("ok");
  }
  if (advSt) {
    advSt.textContent =
      (state === "saving") ? (hasInternet() ? "Saving to Cloud…" : "Offline cache") :
      (state === "error") ? "Cloud error" :
      (hasInternet() ? "Cloud synced" : "Offline cache");
  }
  if (advLast) advLast.textContent = cloudLastSync ? new Date(cloudLastSync).toLocaleString() : "—";
  if (advPts) advPts.textContent = String(Math.max(0, Math.floor(safe(cloudPts))));
  if (advWhat){
    const list = [];
    if (cloudDirtyWhat.stake) list.push("Stake");
    if (cloudDirtyWhat.wd) list.push("Rewards");
    if (cloudDirtyWhat.nw) list.push("NetWorth");
    if (cloudDirtyWhat.events) list.push("Events");
    advWhat.textContent = list.length ? list.join(", ") : (state === "saving" ? "Preparing…" : "—");
  }
}
function cloudRenderMeta(){
  const hist = $("cloudHistory");
  if (hist) hist.textContent = `· ${Math.max(0, Math.floor(cloudPts))} pts`;
  if (cloudLastMenu){
    cloudLastMenu.textContent = cloudLastSync ? new Date(cloudLastSync).toLocaleString() : "—";
  }
  cloudSetState("synced");
}
function cloudBumpLocal(points = 1){
  cloudPts = safe(cloudPts) + safe(points);
  cloudLastSync = Date.now();
  cloudSaveMeta();
  cloudRenderMeta();
}
function cloudMarkDirty(what = {}){
  if (!address) return;
  cloudDirty = true;
  if (what?.stake) cloudDirtyWhat.stake = true;
  if (what?.wd) cloudDirtyWhat.wd = true;
  if (what?.nw) cloudDirtyWhat.nw = true;
  if (what?.events) cloudDirtyWhat.events = true;

  if (!hasInternet()) return;
  scheduleCloudPush();
}
function scheduleCloudPush(){
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => cloudPush(), CLOUD_PUSH_DEBOUNCE_MS);
}
function buildCloudPayload(){
  return {
    v: 2,
    t: Date.now(),
    stake: { labels: stakeLabels, data: stakeData, moves: stakeMoves, types: stakeTypes },
    wd: { labels: wdLabelsAll, values: wdValuesAll, times: wdTimesAll },
    nw: { times: nwTAll, usd: nwUsdAll, inj: nwInjAll },
    events: eventsAll
  };
}
function mergeUniqueByTs(baseTimes, baseVals, addTimes, addVals){
  const map = new Map();
  for (let i=0;i<baseTimes.length;i++){
    const t = safe(baseTimes[i]);
    if (!t) continue;
    map.set(t, safe(baseVals[i]));
  }
  for (let i=0;i<addTimes.length;i++){
    const t = safe(addTimes[i]);
    if (!t) continue;
    if (!map.has(t)) map.set(t, safe(addVals[i]));
  }
  const times = [...map.keys()].sort((a,b)=>a-b);
  const vals = times.map(t => map.get(t));
  return { times, vals };
}
function mergeStakeByLabel(payloadStake){
  if (!payloadStake) return;
  const pl = Array.isArray(payloadStake.labels) ? payloadStake.labels : [];
  const pd = Array.isArray(payloadStake.data) ? payloadStake.data : [];
  const pm = Array.isArray(payloadStake.moves) ? payloadStake.moves : [];
  const pt = Array.isArray(payloadStake.types) ? payloadStake.types : [];

  const map = new Map();
  for (let i=0;i<stakeLabels.length;i++){
    const k = String(stakeLabels[i]);
    map.set(k, { d: safe(stakeData[i]), m: safe(stakeMoves[i]), t: String(stakeTypes[i] || "Stake update") });
  }
  for (let i=0;i<pl.length;i++){
    const k = String(pl[i]);
    if (!map.has(k)) {
      map.set(k, { d: safe(pd[i]), m: safe(pm[i]), t: String(pt[i] || "Stake update") });
    }
  }

  const keys = [...map.keys()].sort((a,b)=>labelToTs(a)-labelToTs(b));
  stakeLabels = clampArray(keys, 2400);
  stakeData   = clampArray(keys.map(k => map.get(k).d), 2400);
  stakeMoves  = clampArray(keys.map(k => map.get(k).m), 2400);
  stakeTypes  = clampArray(keys.map(k => map.get(k).t), 2400);

  stakeBaselineCaptured = stakeData.length > 0;
  lastStakeRecordedRounded = stakeData.length ? Number(safe(stakeData[stakeData.length - 1]).toFixed(6)) : null;
}
function mergeWd(payloadWd){
  if (!payloadWd) return;
  const pl = Array.isArray(payloadWd.labels) ? payloadWd.labels : [];
  const pv = Array.isArray(payloadWd.values) ? payloadWd.values : [];
  const pt = Array.isArray(payloadWd.times) ? payloadWd.times : [];

  const map = new Map();
  for (let i=0;i<wdTimesAll.length;i++){
    const t = safe(wdTimesAll[i]) || labelToTs(wdLabelsAll[i]);
    if (!t) continue;
    map.set(t, { v: safe(wdValuesAll[i]), l: String(wdLabelsAll[i] || tsLabel(t)) });
  }
  for (let i=0;i<pt.length;i++){
    const t = safe(pt[i]) || labelToTs(pl[i]);
    if (!t) continue;
    if (!map.has(t)) map.set(t, { v: safe(pv[i]), l: String(pl[i] || tsLabel(t)) });
  }

  const times = [...map.keys()].sort((a,b)=>a-b);
  wdTimesAll  = clampArray(times, 2400);
  wdValuesAll = clampArray(times.map(t => map.get(t).v), 2400);
  wdLabelsAll = clampArray(times.map(t => map.get(t).l), 2400);
}
function mergeNW(payloadNw){
  if (!payloadNw) return;
  const t = Array.isArray(payloadNw.times) ? payloadNw.times : [];
  const u = Array.isArray(payloadNw.usd) ? payloadNw.usd : [];
  const j = Array.isArray(payloadNw.inj) ? payloadNw.inj : [];

  const m1 = mergeUniqueByTs(nwTAll, nwUsdAll, t, u);
  const m2 = mergeUniqueByTs(nwTAll, nwInjAll, t, j);

  nwTAll = m1.times;
  nwUsdAll = m1.vals;
  nwInjAll = m2.vals;

  clampNWArrays();
}
function mergeEvents(payloadEvents){
  if (!Array.isArray(payloadEvents)) return;

  const map = new Map();
  for (const ev of eventsAll) map.set(ev.id, ev);
  for (const ev of payloadEvents) map.set(ev.id, ev);

  const merged = Array.from(map.values()).sort((a,b)=>safe(b.ts)-safe(a.ts));
  eventsAll = merged.slice(0, 1200);
}

async function cloudPull(){
  if (!address) return;
  if (!hasInternet()) { cloudSetState("synced"); return; }

  const url = `${CLOUD_API}?address=${encodeURIComponent(address)}`;
  const res = await fetchJSON(url);
  if (!res?.ok) { cloudSetState("error"); return; }
  if (!res.data) { cloudSetState("synced"); return; }

  try{
    const data = res.data;

    // ✅ merge solo del tuo address, payload è per-address già dal server
    mergeStakeByLabel(data.stake);
    mergeWd(data.wd);
    mergeNW(data.nw);
    mergeEvents(data.events);

    // salva local per questo address
    saveStakeSeriesLocal();
    saveWdAllLocal();
    saveNWLocal();
    saveEvents();

    rebuildWdView();
    drawNW(true);
    drawStakeChart();
    drawRewardWdChart();
    renderEvents();

    cloudLastSync = Date.now();
    cloudSaveMeta();
    cloudSetState("synced");
  } catch {
    cloudSetState("error");
  }
}

async function cloudPush(){
  if (!address) return;
  if (!hasInternet()) return;
  if (!cloudDirty) return;

  cloudSetState("saving");

  const url = `${CLOUD_API}?address=${encodeURIComponent(address)}`;
  const payload = buildCloudPayload();

  const res = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res?.ok) {
    cloudSetState("error");
    return;
  }

  cloudDirty = false;
  cloudDirtyWhat = { stake:false, wd:false, nw:false, events:false };

  cloudLastSync = Date.now();
  cloudSaveMeta();
  cloudRenderMeta();
  cloudSetState("synced");
}

/* ================= CHART THEME REFRESH ================= */
function refreshChartsTheme(){
  try{
    if (stakeChart) {
      stakeChart.options.scales.y.grid.color = axisGridColor();
      stakeChart.options.scales.y.ticks.color = axisTickColor();
      stakeChart.options.scales.x.grid.color = axisGridColor();
      stakeChart.options.scales.x.ticks.color = axisTickColor();
      stakeChart.update("none");
    }
    if (rewardChart) {
      rewardChart.options.scales.x.grid.color = axisGridColor();
      rewardChart.options.scales.y.grid.color = axisGridColor();
      rewardChart.options.scales.x.ticks.color = axisTickColor();
      rewardChart.options.scales.y.ticks.color = axisTickColor();
      rewardChart.update("none");
    }
    if (chart) {
      chart.options.scales.y.grid.color = axisGridColor();
      chart.options.scales.y.ticks.color = axisTickColor();
      chart.update("none");
    }
    if (netWorthChart) {
      netWorthChart.options.scales.y.grid.color = axisGridColor();
      netWorthChart.options.scales.y.ticks.color = axisTickColor();
      netWorthChart.options.scales.x.ticks.color = axisTickColor();
      netWorthChart.update("none");
    }
  } catch {}
}

/* ================= Crosshair (mouse+touch) for charts ================= */
const crosshairPlugin = {
  id: "crosshairPlugin",
  afterDraw(ch) {
    const idx = ch?.$crosshairIndex;
    if (idx == null) return;
    const meta = ch.getDatasetMeta(0);
    const el = meta?.data?.[idx];
    if (!el) return;

    const ctx = ch.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(el.x, ch.chartArea.top);
    ctx.lineTo(el.x, ch.chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(250,204,21,0.95)";
    ctx.stroke();
    ctx.restore();
  }
};

function attachCrosshair(ch, overlayEl, formatter){
  if (!ch || !overlayEl) return;
  try { Chart.register(crosshairPlugin); } catch {}

  const canvas = ch.canvas;

  const getIdx = (evt) => {
    try{
      const pts = ch.getElementsAtEventForMode(evt, "index", { intersect:false }, false);
      if (!pts || !pts.length) return null;
      return pts[0].index;
    } catch { return null; }
  };

  const update = (idx) => {
    const ds = ch.data.datasets?.[0]?.data || [];
    const lbs = ch.data.labels || [];
    if (!ds.length) return;
    const i = clamp(idx ?? (ds.length - 1), 0, ds.length - 1);
    ch.$crosshairIndex = i;
    overlayEl.textContent = formatter(i, lbs, ds);
    ch.update("none");
  };

  const move = (evt) => {
    const i = getIdx(evt);
    if (i == null) return;
    update(i);
  };

  const leave = () => {
    const ds = ch.data.datasets?.[0]?.data || [];
    if (!ds.length) return;
    update(ds.length - 1);
  };

  // init on last point
  leave();

  canvas.addEventListener("mousemove", move, { passive:true });
  canvas.addEventListener("mouseleave", leave, { passive:true });
  canvas.addEventListener("touchstart", move, { passive:true });
  canvas.addEventListener("touchmove", move, { passive:true });
  canvas.addEventListener("touchend", leave, { passive:true });
  canvas.addEventListener("touchcancel", leave, { passive:true });
}

/* ================= SETTINGS (Advanced settings) ================= */
const advBtn = $("advAccBtn");
const advBody = $("advAccBody");
advBtn?.addEventListener("click", () => {
  const open = advBtn.getAttribute("aria-expanded") === "true";
  advBtn.setAttribute("aria-expanded", open ? "false" : "true");
  advBody?.setAttribute("aria-hidden", open ? "true" : "false");
}, { passive:true });

async function fetchPublicIP(){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2200);
  try{
    const r = await fetch("https://api.ipify.org?format=json", { cache:"no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error("bad");
    const j = await r.json();
    return String(j?.ip || "—");
  } catch { return "—"; }
  finally { clearTimeout(t); }
}

async function renderSettingsSnapshot(){
  setText("settingsTheme", (document.body.dataset.theme || "dark").toUpperCase());
  setText("settingsMode", (liveMode ? "LIVE" : "REFRESH"));
  setText("settingsWallet", address || "—");

  setText("deviceTz", Intl.DateTimeFormat().resolvedOptions().timeZone || "—");
  setText("deviceLang", navigator.language || "—");
  setText("devicePlatform", navigator.platform || "—");
  setText("deviceScreen", `${window.screen?.width || "?"}×${window.screen?.height || "?"} • DPR ${window.devicePixelRatio || 1}`);

  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const conn = c ? `${c.effectiveType || "?"}${c.downlink ? ` • ${c.downlink}Mb/s` : ""}${c.rtt ? ` • ${c.rtt}ms` : ""}` : "—";
  setText("deviceConn", conn);

  const ipEl = $("deviceIp");
  if (ipEl && (ipEl.textContent === "—" || !ipEl.textContent)) {
    const ip = await fetchPublicIP();
    setText("deviceIp", ip);
  }
}

/* ================= ADDRESS COMMIT (FIX: no mixing between addresses) ================= */
function resetPerAddressStateUI(){
  // reset series arrays always before loading next address
  stakeLabels = []; stakeData = []; stakeMoves = []; stakeTypes = [];
  stakeBaselineCaptured = false;
  lastStakeRecordedRounded = null;

  wdLabelsAll = []; wdValuesAll = []; wdTimesAll = [];
  wdLabels = []; wdValues = []; wdTimes = [];
  wdLastRewardsSeen = null;

  nwTAll = []; nwUsdAll = []; nwInjAll = [];
  lastNWPointAt = 0;

  eventsAll = [];

  // reset charts without destroy to avoid flashing bugs
  try{
    if (stakeChart){
      stakeChart.data.labels = [];
      stakeChart.data.datasets[0].data = [];
      stakeChart.update("none");
    }
    if (rewardChart){
      rewardChart.data.labels = [];
      rewardChart.data.datasets[0].data = [];
      rewardChart.update("none");
    }
    if (netWorthChart){
      netWorthChart.data.labels = [];
      netWorthChart.data.datasets[0].data = [];
      netWorthChart.update("none");
    }
    // readouts
    setText("stakeReadout", "—");
    setText("rewardReadout", "—");
    setText("nwReadout", "—");
  } catch {}
}

async function commitAddress(newAddr) {
  const a = (newAddr || "").trim();
  if (!a) return;

  // Basic validation client-side to avoid confusion
  if (!/^inj[a-z0-9]{20,80}$/i.test(a)) {
    pushEvent({ kind:"info", title:"Invalid address", detail:"Address must start with inj...", status:"fail" });
    return;
  }

  address = a;
  localStorage.setItem("inj_address", address);

  setAddressDisplay(address);
  settleStart = Date.now();

  // ✅ FIX: reset all per-address in-memory state (prevents mixing)
  resetPerAddressStateUI();

  availableInj = 0; stakeInj = 0; rewardsInj = 0; apr = 0;
  displayed.available = 0; displayed.stake = 0; displayed.rewards = 0; displayed.netWorthUsd = 0; displayed.apr = 0;

  // load local per this address (or keep empty)
  const hadStake = loadStakeSeriesLocal();
  if (!hadStake) drawStakeChart(); else drawStakeChart();

  wdMinFilter = safe($("rewardFilter")?.value || 0);
  const hadWd = loadWdAllLocal();
  if (!hadWd) rebuildWdView(); else rebuildWdView();

  const hadNw = loadNWLocal();
  const scaleBtn = $("nwScaleToggle");
  if (scaleBtn) scaleBtn.textContent = (nwScale === "log") ? "LOG" : "LIN";
  const liveBtn = $("nwLiveToggle");
  if (liveBtn) liveBtn.classList.toggle("active", nwTf === "live");
  if (!hadNw) drawNW(true); else drawNW(true);

  loadEvents();
  renderEvents();
  renderTargetsNow();
  loadAprLocal();
  drawAprChart();
// cloud pull for this address
  cloudSetState("saving");
  await cloudPull();

  modeLoading = true;
  refreshConnUI();
  renderSettingsSnapshot();

  if (liveMode) await loadAccount();
  else {
    refreshLoaded = false;
    refreshConnUI();
    await refreshLoadAllOnce();
  }
}

/* ================= ONLINE / OFFLINE ================= */
window.addEventListener("online", () => {
  refreshConnUI();
  cloudSetState("synced");
  if (address) cloudPull();
  if (liveMode) {
    startTradeWS();
    startKlineWS();
    if (address) loadAccount();
  } else {
    refreshLoadAllOnce();
  }
}, { passive: true });

window.addEventListener("offline", () => {
  wsTradeOnline = false;
  wsKlineOnline = false;
  accountOnline = false;
  refreshLoaded = false;
  refreshLoading = false;
  modeLoading = false;
  refreshConnUI();
  cloudSetState("synced");
}, { passive: true });


/* ================= INTEGRATIONS_V20260206 =================
   Privacy toggle (A: blur) • Targets modal • Events PRO filters
   Price Chart Timeframes • APR Chart series • Validator card
   Dynamic axes + crosshair only on interaction + blinking last dot
   ========================================================= */

/* === Privacy === */
const PRIVACY_KEY = "inj_privacy_on";
let privacyOn = (localStorage.getItem(PRIVACY_KEY) || "0") === "1";

// Mask ONLY sensitive numeric fields (keep charts + 1D Price + bars visible)
const PRIVACY_MASK_MAP = {
  // header
  addressDisplay: "Address hidden",

  // net worth
  netWorthUsd: "$•••",
  netWorthPnl: "PnL: •••",
  netWorthInj: "••• INJ",
  nwReadout: "•••",

  // available
  available: "•••",
  availableUsd: "≈ $•••",

  // staked
  stake: "•••",
  stakeUsd: "≈ $•••",
  stakeReadout: "•••",

  // rewards
  rewards: "•••",
  rewardsUsd: "≈ $•••",
  rewardReadout: "•••",

  // validator
  validatorName: "•••",
  validatorMeta: "•••",
};

function privacyMarkTargets(){
  for (const [id, ph] of Object.entries(PRIVACY_MASK_MAP)){
    const el = $(id);
    if (!el) continue;
    el.classList.add("privacy-mask");
    el.dataset.privacyPlaceholder = ph;
  }
}

function applyPrivacyMaskNow(){
  // When ON: replace sensitive values with placeholders.
  // When OFF: restore the last known content (then live updates keep it fresh).
  for (const [id, ph] of Object.entries(PRIVACY_MASK_MAP)){
    const el = $(id);
    if (!el) continue;

    if (privacyOn){
      // If no wallet is set, keep the header empty (avoid confusing placeholder)
      if (id === "addressDisplay" && !address) {
        el.innerHTML = "";
        continue;
      }
      if (el.dataset.privacyBackupHtml == null) el.dataset.privacyBackupHtml = el.innerHTML;
      el.textContent = ph;
    } else {
      if (el.dataset.privacyBackupHtml != null){
        el.innerHTML = el.dataset.privacyBackupHtml;
        delete el.dataset.privacyBackupHtml;
      }
    }
  }
}

function applyPrivacy(on){
  privacyOn = !!on;
  document.body.classList.toggle("privacy-on", privacyOn);
  try { localStorage.setItem(PRIVACY_KEY, privacyOn ? "1" : "0"); } catch {}
  const ico = $("privacyIcon");
  if (ico) ico.textContent = privacyOn ? "🙈" : "👁️";
  applyPrivacyMaskNow();
  // When turning privacy off, re-render the visible address immediately
  if (!privacyOn) setAddressDisplay(address);
}
$("privacyToggle")?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  applyPrivacy(!privacyOn);
}, { passive:false });

/* === Targets (stake/rewards) === */
let targetModalType = "stake"; // stake | reward
const TARGETS_VER = 1;

function targetKey(addr, type){
  const a = (addr || "").trim();
  return a ? `inj_target_v${TARGETS_VER}_${type}_${a}` : null;
}
function getTarget(addr, type, fallback){
  const k = targetKey(addr, type);
  if (!k) return fallback;
  try{
    const v = Number(localStorage.getItem(k));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch { return fallback; }
}
function setTarget(addr, type, v){
  const k = targetKey(addr, type);
  if (!k) return;
  try{ localStorage.setItem(k, String(v)); } catch {}
}

let stakeTargetMaxDyn = STAKE_TARGET_MAX;
let rewardTargetMaxDyn = 1;

function renderTargetsNow(){
  stakeTargetMaxDyn = getTarget(address, "stake", STAKE_TARGET_MAX);
  rewardTargetMaxDyn = getTarget(address, "reward", 1);

  setText("stakeMax", String(stakeTargetMaxDyn));
  setText("rewardMax", String(rewardTargetMaxDyn));
}

function openTargetModal(type){
  targetModalType = type === "reward" ? "reward" : "stake";

  const modal = $("targetModal");
  const bd = $("targetBackdrop");
  const close = $("targetClose");
  const apply = $("targetApply");
  const input = $("targetInput");
  const title = $("targetTitle");
  if (!modal || !input || !title) return;

  const cur = (targetModalType === "stake")
    ? getTarget(address, "stake", STAKE_TARGET_MAX)
    : getTarget(address, "reward", 1);

  title.textContent = targetModalType === "stake" ? "Set STAKE target" : "Set REWARDS target";
  input.value = String(cur);

  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");

  const closeFn = () => {
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  };

  const applyFn = () => {
    const v = safe(input.value);
    if (v > 0) {
      setTarget(address, targetModalType, v);
      renderTargetsNow();
    }
    closeFn();
  };

  bd?.addEventListener("click", closeFn, { passive:true, once:true });
  close?.addEventListener("click", closeFn, { passive:false, once:true });
  apply?.addEventListener("click", applyFn, { passive:false, once:true });

  input.focus();
}

$("stakeTargetBtn")?.addEventListener("click", (e) => { e?.preventDefault?.(); openTargetModal("stake"); }, { passive:false });
$("rewardTargetBtn")?.addEventListener("click", (e) => { e?.preventDefault?.(); openTargetModal("reward"); }, { passive:false });

/* === Dynamic axes helpers === */
function spanMsFromLabels(labels){
  if (!labels || labels.length < 2) return 0;
  const a = labelToTs(labels[0]);
  const b = labelToTs(labels[labels.length - 1]);
  const span = Math.abs((b || 0) - (a || 0));
  return Number.isFinite(span) ? span : 0;
}
function fmtAxisX(ts, spanMs){
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");

  const oneDay = 24 * 60 * 60 * 1000;
  const oneYear = 365 * oneDay;

  if (spanMs <= 2 * oneDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (spanMs <= 60 * oneDay) return `${pad(d.getDate())}/${pad(d.getMonth()+1)}`;
  if (spanMs <= 2 * oneYear) return `${pad(d.getMonth()+1)}/${String(d.getFullYear()).slice(-2)}`;
  return String(d.getFullYear());
}

/* === Crosshair: show yellow line only during interaction, then hide === */
const crosshairPlugin2 = {
  id: "crosshairPlugin2",
  afterDraw(ch) {
    const idx = ch?.$crosshairIndex;
    const active = ch?.$crosshairActive === true;
    if (!active || idx == null) return;

    const meta = ch.getDatasetMeta(0);
    const el = meta?.data?.[idx];
    if (!el) return;

    const ctx = ch.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(el.x, ch.chartArea.top);
    ctx.lineTo(el.x, ch.chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(250,204,21,0.95)";
    ctx.stroke();
    ctx.restore();
  }
};

function attachCrosshair2(ch, overlayEl, formatter){
  if (!ch || !overlayEl) return;
  try { Chart.register(crosshairPlugin2); } catch {}
  const canvas = ch.canvas;

  const getIdx = (evt) => {
    try{
      const pts = ch.getElementsAtEventForMode(evt, "index", { intersect:false }, false);
      if (!pts || !pts.length) return null;
      return pts[0].index;
    } catch { return null; }
  };

  const show = () => { overlayEl.classList.add("show"); };
  const hide = () => { overlayEl.classList.remove("show"); };

  const setIdx = (i, active) => {
    const ds = ch.data.datasets?.[0]?.data || [];
    const lbs = ch.data.labels || [];
    if (!ds.length) return;

    const idx = clamp(i ?? (ds.length - 1), 0, ds.length - 1);

    ch.$crosshairIndex = idx;
    ch.$crosshairActive = !!active;

    if (active) show(); else hide();

    // Privacy mode: keep charts visible but hide sensitive readouts
    if (document.body?.classList?.contains("privacy-on") && overlayEl.classList.contains("privacy-mask")) {
      overlayEl.textContent = overlayEl.dataset.privacyPlaceholder || "•••";
    } else {
      try{
        overlayEl.textContent = formatter(idx, lbs, ds);
      } catch {
        overlayEl.textContent = "—";
      }
    }

    try { ch.update("none"); } catch {}

    if (active){
      if (ch.$crosshairTimer) clearTimeout(ch.$crosshairTimer);
      ch.$crosshairTimer = setTimeout(() => {
        ch.$crosshairActive = false;
        ch.$crosshairIndex = null;
        hide();
        try { ch.update("none"); } catch {}
      }, 950);
    }
  };

  const start = (evt) => {
    const i = getIdx(evt);
    if (i == null) return;
    setIdx(i, true);
  };

  const move = (evt) => {
    if (!ch.$crosshairActive) return;
    const i = getIdx(evt);
    if (i == null) return;
    setIdx(i, true);
  };

  const end = () => {
    ch.$crosshairActive = false;
    ch.$crosshairIndex = null;
    hide();
    try { ch.update("none"); } catch {}
  };

  // start hidden
  end();

  // click/tap to show
  canvas.addEventListener("click", start, { passive:true });
  canvas.addEventListener("touchstart", start, { passive:true });

  // allow short drag while active (mobile/desktop)
  canvas.addEventListener("mousemove", move, { passive:true });
  canvas.addEventListener("touchmove", move, { passive:true });

  canvas.addEventListener("mouseleave", end, { passive:true });
  canvas.addEventListener("touchend", end, { passive:true });
  canvas.addEventListener("touchcancel", end, { passive:true });
}

/* === Blinking last dot plugin (trend-based) === */
const lastDotPlugin = {
  id: "lastDotPlugin",
  afterDatasetsDraw(ch){
    const meta = ch.getDatasetMeta(0);
    const pts = meta?.data || [];
    const ds = ch.data.datasets?.[0]?.data || [];
    if (!pts.length || ds.length < 1) return;

    const el = pts[pts.length - 1];
    if (!el) return;

    // Prefer explicit per-chart color (set by draw functions)
    let col = ch.$lastPointColor
      || ch.data.datasets?.[0]?.lastPointColor
      || ch.data.datasets?.[0]?.$lastPointColor;

    if (!col) {
      const last = safe(ds[ds.length - 1]);
      const prev = safe(ds.length > 1 ? ds[ds.length - 2] : last);
      col = "rgba(250,204,21,0.95)";
      if (last > prev) col = SIGN_COLORS.up.dot;
      else if (last < prev) col = SIGN_COLORS.down.dot;
    }

    const t = Date.now();
    const pulse = 0.35 + 0.65 * Math.abs(Math.sin(t / 320));

    const ctx = ch.ctx;
    ctx.save();
    ctx.shadowColor = col.replace("0.95", String(0.35 * pulse));
    ctx.shadowBlur = 10;

    ctx.beginPath();
    ctx.arc(el.x, el.y, 6.5, 0, Math.PI*2);
    ctx.fillStyle = col.replace("0.95", String(0.22 * pulse));
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(el.x, el.y, 3.2, 0, Math.PI*2);
    ctx.fillStyle = col.replace("0.95", String(0.95 * pulse));
    ctx.fill();
    ctx.restore();
  }
};
try { Chart.register(lastDotPlugin); } catch {}

/* === Events PRO filters === */
function eventsGetFilters(){
  const q = String($("eventsSearch")?.value || "").trim().toLowerCase();
  const kind = String($("eventsKind")?.value || "all").toLowerCase();
  const status = String($("eventsStatus")?.value || "all").toLowerCase();
  return { q, kind, status };
}
["eventsSearch","eventsKind","eventsStatus"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener(id === "eventsSearch" ? "input" : "change", () => renderEvents(), { passive:true });
});

/* === Price Chart timeframes === */
const PRICE_TF_KEY = "inj_price_tf_v1";
let priceTf = (localStorage.getItem(PRICE_TF_KEY) || "1d").toLowerCase();
if (!["live","1d","1w","1m","1y","all"].includes(priceTf)) priceTf = "1d";

/* === Price Chart scale (LIN/LOG) === */
const PRICE_SCALE_KEY = "inj_price_scale_v1";
let priceScale = (localStorage.getItem(PRICE_SCALE_KEY) || "lin").toLowerCase();
if (!["lin","log"].includes(priceScale)) priceScale = "lin";

function updatePriceScaleBtn(){
  const b = $("priceScaleToggle");
  if (!b) return;
  b.textContent = (priceScale === "log") ? "LOG" : "LIN";
  b.classList.toggle("active", priceScale === "log");
}
function applyPriceScale(){
  if (!chart) return;
  chart.options.scales.y = chart.options.scales.y || {};
  chart.options.scales.y.type = (priceScale === "log") ? "logarithmic" : "linear";
  try { chart.update("none"); } catch {}
}
function setPriceScale(next){
  priceScale = (next === "log") ? "log" : "lin";
  try { localStorage.setItem(PRICE_SCALE_KEY, priceScale); } catch {}
  updatePriceScaleBtn();
  applyPriceScale();
}
$("priceScaleToggle")?.addEventListener("click", (e) => {
  e?.preventDefault?.();
  setPriceScale(priceScale === "log" ? "lin" : "log");
}, { passive:false });


function updatePriceTitle(){
  const el = $("priceChartTitle");
  if (!el) return;
  const map = { live:"LIVE Price Chart (15m)", "1d":"1D Price Chart", "1w":"1W Price Chart", "1m":"1M Price Chart", "1y":"1Y Price Chart", all:"ALL Price Chart" };
  el.textContent = map[priceTf] || "Price Chart";
}
function updatePriceTFButtons(){
  const wrap = $("priceTfSwitch");
  if (!wrap) return;
  wrap.querySelectorAll(".tf-btn").forEach((b) => {
    b.classList.toggle("active", (b.dataset.tf === priceTf));
  });
}
function setPriceTf(tf){
  priceTf = tf;
  try { localStorage.setItem(PRICE_TF_KEY, priceTf); } catch {}
  updatePriceTFButtons();
  updatePriceTitle();
  loadPriceChart(true);
}
$("priceTfSwitch")?.addEventListener("click", (e) => {
  const btn = e.target?.closest(".tf-btn");
  if (!btn) return;
  const tf = String(btn.dataset.tf || "1d").toLowerCase();
  if (!["live","1d","1w","1m","1y","all"].includes(tf)) return;
  setPriceTf(tf);
}, { passive:true });

async function fetchKlinesRange(symbol, interval, startTime, endTime, maxTotal=2400){
  const out = [];
  let cursor = startTime || 0;
  const end = endTime || Date.now();
  let guard = 0;
  while (out.length < maxTotal && guard++ < 10){
    const limit = 1000;
    const url = cursor
      ? `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&startTime=${cursor}&endTime=${end}`
      : `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const d = await fetchJSON(url);
    if (!Array.isArray(d) || !d.length) break;
    out.push(...d);
    if (!cursor) break;
    const lastOpen = safe(d[d.length - 1][0]);
    if (!lastOpen) break;
    // step in ms (approx for 1M)
    const step =
      interval === "1m" ? ONE_MIN_MS :
      interval === "15m" ? 15*ONE_MIN_MS :
      interval === "1h" ? 60*ONE_MIN_MS :
      interval === "1d" ? 24*60*ONE_MIN_MS :
      interval === "1w" ? 7*24*60*ONE_MIN_MS :
      interval === "1M" ? 30*24*60*ONE_MIN_MS :
      ONE_MIN_MS;
    cursor = lastOpen + step;
    if (d.length < limit) break;
    if (cursor >= end) break;
  }
  return out.slice(0, maxTotal);
}

async function loadPriceChart(force=false){
  if (!hasInternet()) return;
  if (!chart) initChartToday();
  if (!chart) return;

  const now = Date.now();
  let interval = "1m";
  let start = 0;
  let maxTotal = 1440;

  if (priceTf === "live"){
    interval = "1m";
    start = now - 15*60*1000;
    maxTotal = 32;
  } else if (priceTf === "1d"){
    interval = "1m";
    start = now - 24*60*60*1000;
    maxTotal = 1440;
  } else if (priceTf === "1w"){
    interval = "15m";
    start = now - 7*24*60*60*1000;
    maxTotal = 672;
  } else if (priceTf === "1m"){
    interval = "1h";
    start = now - 30*24*60*60*1000;
    maxTotal = 720;
  } else if (priceTf === "1y"){
    interval = "1d";
    start = now - 365*24*60*60*1000;
    maxTotal = 365;
  } else {
    interval = "1w";
    start = 0;
    maxTotal = 1000;
  }

  const kl = await fetchKlinesRange("INJUSDT", interval, start, now, Math.min(2400, maxTotal));
  if (!kl.length) return;

  const labels = kl.map(k => tsLabel(safe(k[0])));
  const data = kl.map(k => safe(k[4]));

  if (interval === "1m") {
    chartBootstrappedToday = true;
    lastChartMinuteStart = safe(kl[kl.length - 1][0]) || lastChartMinuteStart;
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = data;

  // ensure axes are dynamic
  chart.options.scales.x.display = true;
  chart.options.scales.x.ticks = chart.options.scales.x.ticks || {};
  chart.options.scales.x.ticks.callback = (v, i) => {
    const lbs = chart.data.labels || [];
    const span = spanMsFromLabels(lbs);
    const lbl = (lbs?.[v] ?? v);
    const ts = labelToTs(lbl);
    return fmtAxisX(ts, span);
  };
  chart.options.scales.y.ticks = chart.options.scales.y.ticks || {};
  chart.options.scales.y.ticks.callback = (v) => `$${fmtSmart(v)}`;

  try{ applyPriceScale(); } catch {}

  // ✅ Apply correct trend color for the selected TF (LIVE stays blue)
  updatePriceChartTrend(true);

  pinnedIndex = null;
  updatePinnedOverlay();
}

/* === APR chart series === */
const APR_LOCAL_VER = 1;
let aprLabels = [];
let aprData = [];
let aprChart = null;
let lastAprPointAt = 0;
let lastAprSeen = null;

function aprStoreKey(addr){
  const a = (addr || "").trim();
  return a ? `inj_apr_series_v${APR_LOCAL_VER}_${a}` : null;
}
function loadAprLocal(){
  const k = aprStoreKey(address);
  if (!k) return false;
  try{
    const raw = localStorage.getItem(k);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== APR_LOCAL_VER) return false;
    aprLabels = Array.isArray(obj.labels) ? obj.labels : [];
    aprData = Array.isArray(obj.data) ? obj.data : [];
    const n = Math.min(aprLabels.length, aprData.length);
    aprLabels = aprLabels.slice(-n);
    aprData = aprData.slice(-n);
    return true;
  } catch { return false; }
}
function saveAprLocal(){
  const k = aprStoreKey(address);
  if (!k) return;
  try{
    localStorage.setItem(k, JSON.stringify({ v: APR_LOCAL_VER, t: Date.now(), labels: aprLabels, data: aprData }));
  } catch {}
}
function initAprChart(){
  const canvas = $("aprChart");
  if (!canvas || !window.Chart) return;

  aprChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: aprLabels,
      datasets: [{
        data: aprData,
        borderColor: "#facc15",
        backgroundColor: "rgba(250,204,21,.12)",
        fill: true,
        tension: 0.25,
        cubicInterpolationMode: "monotone",
        spanGaps: true,
        pointRadius: 0,
        pointHitRadius: 18
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display:false },
        tooltip: { enabled:false },
        ...(ZOOM_OK ? { zoom: { pan: { enabled:true, mode:"x", threshold:2 }, zoom: { wheel:{ enabled:true }, pinch:{ enabled:true }, mode:"x" } } } : {})
      },
      interaction: { mode:"index", intersect:false },
      scales: {
        x: {
          display:true,
          ticks: {
            color: axisTickColor(),
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            callback: (v, i) => {
              const span = spanMsFromLabels(aprLabels);
              const lbl = (aprLabels?.[v] ?? v);
              const ts = labelToTs(lbl);
              return fmtAxisX(ts, span);
            }
          },
          grid: { color: axisGridColor() },
          border: { display:false }
        },
        y: {
          ticks: {
            color: axisTickColor(),
            callback: (v) => `${fmtSmart(v)}%`
          },
          grid: { color: axisGridColor() },
          border: { display:false }
        }
      }
    },
    plugins: [lastDotPlugin]
  });

  attachCrosshair2(aprChart, $("aprReadout"), (i, lbs, ds) => {
    const t = labelToTs(lbs?.[i]);
    const v = safe(ds?.[i]);
    return `${t ? new Date(t).toLocaleString() : "—"} • ${v.toFixed(2)}%`;
  });
}
function drawAprChart(){
  if (!aprChart) initAprChart();
  if (!aprChart) return;
  aprChart.data.labels = aprLabels;
  aprChart.data.datasets[0].data = aprData;
  aprChart.update("none");
}
function recordAprPoint(){
  if (!address) return;
  const now = Date.now();
  if ((now - lastAprPointAt) < 2500) return;
  lastAprPointAt = now;

  const v = safe(apr);
  if (!Number.isFinite(v)) return;
  const last = aprData.length ? safe(aprData[aprData.length - 1]) : null;
  if (last != null && Math.abs(v - last) < 0.01) return;

  aprLabels.push(tsLabel(now));
  aprData.push(v);

  while (aprLabels.length > 2400){ aprLabels.shift(); aprData.shift(); }

  saveAprLocal();
  drawAprChart();
}

/* === Validator card === */
const validatorCache = new Map();
async function fetchValidator(valoper){
  if (!valoper) return null;
  if (validatorCache.has(valoper)) return validatorCache.get(valoper);
  const base = "https://lcd.injective.network";
  const j = await fetchJSON(`${base}/cosmos/staking/v1beta1/validators/${valoper}`);
  const v = j?.validator || null;
  validatorCache.set(valoper, v);
  return v;
}
async function updateValidatorFromDelegations(delegation_responses){
  const elName = $("validatorName");
  const elMeta = $("validatorMeta");
  if (!elName || !elMeta) return;

  // Privacy mode: do not reveal validator details
  if (document.body?.classList?.contains("privacy-on") && (elName.classList.contains("privacy-mask") || elMeta.classList.contains("privacy-mask"))) {
    elName.textContent = elName.dataset.privacyPlaceholder || "•••";
    elMeta.textContent = elMeta.dataset.privacyPlaceholder || "•••";
    return;
  }

  const del = Array.isArray(delegation_responses) ? delegation_responses : [];
  if (!del.length){
    elName.textContent = "—";
    elMeta.textContent = "No delegations";
    return;
  }
  let best = del[0];
  let bestAmt = safe(best?.balance?.amount);
  for (const d of del){
    const a = safe(d?.balance?.amount);
    if (a > bestAmt){ best = d; bestAmt = a; }
  }
  const val = String(best?.delegation?.validator_address || "");
  if (!val){
    elName.textContent = "—";
    elMeta.textContent = "Validator not found";
    return;
  }
  const v = await fetchValidator(val);
  const moniker = v?.description?.moniker || shortAddr(val);
  const rate = safe(v?.commission?.commission_rates?.rate) * 100;
  elName.textContent = moniker;
  elMeta.textContent = `${shortAddr(val)} • Commission ${Number.isFinite(rate) ? rate.toFixed(2) : "—"}%`;
}

/* === Cloud: color text where present (wrap) === */
function setCloudTextClass(el, state){
  if (!el) return;
  el.classList.remove("cloud-ok","cloud-saving","cloud-err");
  if (state === "saving") el.classList.add("cloud-saving");
  else if (state === "error") el.classList.add("cloud-err");
  else el.classList.add("cloud-ok");
}
const __cloudSetState_orig = cloudSetState;
cloudSetState = function(state){
  __cloudSetState_orig(state);
  setCloudTextClass($("cloudStatus"), state);
  setCloudTextClass($("cloudMenuStatus"), state);
  setCloudTextClass($("cloudAdvState"), state);
};

/* === RenderEvents PRO (wrap) === */
const __renderEvents_orig = renderEvents;
renderEvents = function(){
  const body = $("eventsTbody");
  const empty = $("eventsEmpty");
  const count = $("eventsCount");
  if (!body) return __renderEvents_orig();

  const { q, kind, status } = eventsGetFilters();
  const list = Array.isArray(eventsAll) ? eventsAll : [];

  const filtered = list.filter((ev) => {
    const k = String(ev?.kind || "info").toLowerCase();
    const st = String(ev?.status || "done").toLowerCase();
    if (kind !== "all" && k !== kind) return false;
    if (status !== "all" && st !== status) return false;

    if (q){
      const blob = `${ev?.title || ""} ${ev?.detail || ""} ${ev?.id || ""} ${k} ${st}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  if (count) count.textContent = String(filtered.length);

  body.innerHTML = "";
  if (empty) empty.style.display = filtered.length ? "none" : "block";
  if (!filtered.length) return;

  for (const ev of filtered){
    const tr = document.createElement("tr");

    const dt = new Date(ev.ts || Date.now());
    const when = `${dt.toLocaleDateString()} ${fmtHHMMSS(ev.ts || Date.now())}`;

    const k = String(ev.kind || "info").toUpperCase();
    const st = String(ev.status || "done").toLowerCase();

    const dir = (ev.dir === "up" || ev.dir === "down") ? ev.dir : "neu";
    const badgeClass = dir === "up" ? "up" : dir === "down" ? "down" : "neu";

    const title = ev.title || k;
    const detail = ev.detail || "";
    const id = ev.id ? String(ev.id).slice(0, 64) : "";

    tr.innerHTML = `
      <td>
        <div class="ev-title"><span class="ev-badge ${badgeClass}">${k}</span> ${title}</div>
        ${id ? `<div class="ev-id">${id}</div>` : ""}
      </td>
      <td style="white-space:nowrap">${when}</td>
      <td><div class="ev-detail">${detail}</div></td>
      <td style="white-space:nowrap">
        <span class="pill ${st === "ok" ? "ok" : st === "pending" ? "pending" : st === "err" ? "err" : "done"}">${st.toUpperCase()}</span>
      </td>
    `;
    body.appendChild(tr);
  }
};


/* ================= BOOT ================= */
(async function boot() {
  applyTheme(theme);
  // Ensure privacy mode never hides charts: mark sensitive numeric fields only
  privacyMarkTargets();
  applyPrivacy(privacyOn);
  updatePriceScaleBtn();
  ZOOM_OK = tryRegisterZoom();

  // Chart defaults: more "breathing room" above last points + smoother axes on all charts
  try{
    if (window.Chart && Chart.defaults){
      Chart.defaults.layout = Chart.defaults.layout || {};
      Chart.defaults.layout.padding = Chart.defaults.layout.padding || {};
      Chart.defaults.layout.padding.top = 12;

      Chart.defaults.scales = Chart.defaults.scales || {};
      if (Chart.defaults.scales.linear) Chart.defaults.scales.linear.grace = "16%";
      if (Chart.defaults.scales.logarithmic) Chart.defaults.scales.logarithmic.grace = "16%";
    }
  } catch {}


  cloudLoadMeta();
  cloudRenderMeta();
  cloudSetState("synced");
  refreshConnUI();

  bindExpandButtons();
  try{ initDashOrder(); }catch{}
  try{ bindSettingsTabs(); }catch{}
  setAddressDisplay(address);

  wdMinFilter = safe($("rewardFilter")?.value || 0);

  if (address) {
    // ✅ reset then load current address only
    resetPerAddressStateUI();

    loadStakeSeriesLocal(); drawStakeChart();
    loadWdAllLocal(); rebuildWdView();
    loadNWLocal();
    const scaleBtn = $("nwScaleToggle");
    if (scaleBtn) scaleBtn.textContent = (nwScale === "log") ? "LOG" : "LIN";
    const liveBtn = $("nwLiveToggle");
    if (liveBtn) liveBtn.classList.toggle("active", nwTf === "live");
    drawNW(true);

    loadEvents();
  renderEvents();
  renderTargetsNow();
  loadAprLocal();
  drawAprChart();
await cloudPull();
  }

  if (liveIcon) liveIcon.textContent = liveMode ? "📡" : "⟳";
  if (modeHint) modeHint.textContent = `Mode: ${liveMode ? "LIVE" : "REFRESH"}`;

  modeLoading = true;
  refreshConnUI();
  renderSettingsSnapshot();

  await loadCandleSnapshot(liveMode ? false : true);
  await loadChartToday(liveMode ? false : true);
  updatePriceTFButtons();
  updatePriceTitle();
  await loadPriceChart(true);

  if (liveMode) {
    startTradeWS();
    startKlineWS();
    if (address) await loadAccount();
    startAllTimers();
  } else {
    stopAllTimers();
    stopAllSockets();
    accountOnline = false;
    refreshLoaded = false;
    refreshConnUI();
    await refreshLoadAllOnce();
  }
})();

/* ================= LOOP ================= */
function animate() {
  const op = displayed.price;
  displayed.price = tick(displayed.price, targetPrice);
  colorNumber($("price"), displayed.price, op, 4);

  const pD = tfReady.d ? pctChange(targetPrice, candle.d.open) : 0;
  const pW = tfReady.w ? pctChange(targetPrice, candle.w.open) : 0;
  const pM = tfReady.m ? pctChange(targetPrice, candle.m.open) : 0;

  updatePerf("arrow24h", "pct24h", pD);
  updatePerf("arrowWeek", "pctWeek", pW);
  updatePerf("arrowMonth", "pctMonth", pM);

  const dUp   = "linear-gradient(90deg, rgba(34,197,94,.55), rgba(16,185,129,.32))";
  const dDown = "linear-gradient(270deg, rgba(239,68,68,.55), rgba(248,113,113,.30))";
  const wUp   = "linear-gradient(90deg, rgba(59,130,246,.55), rgba(99,102,241,.30))";
  const wDown = "linear-gradient(270deg, rgba(239,68,68,.40), rgba(59,130,246,.26))";
  const mUp   = "linear-gradient(90deg, rgba(249,115,22,.50), rgba(236,72,153,.28))";
  const mDown = "linear-gradient(270deg, rgba(239,68,68,.40), rgba(236,72,153,.25))";

  renderBar($("priceBar"), $("priceLine"), targetPrice, candle.d.open, candle.d.low, candle.d.high, dUp, dDown);
  renderBar($("weekBar"),  $("weekLine"),  targetPrice, candle.w.open, candle.w.low, candle.w.high, wUp, wDown);
  renderBar($("monthBar"), $("monthLine"), targetPrice, candle.m.open, candle.m.low, candle.m.high, mUp, mDown);

  if (tfReady.d) {
    setText("priceMin", safe(candle.d.low).toFixed(3));
    setText("priceOpen", safe(candle.d.open).toFixed(3));
    setText("priceMax", safe(candle.d.high).toFixed(3));
  } else { setText("priceMin", "--"); setText("priceOpen", "--"); setText("priceMax", "--"); }

  if (tfReady.w) {
    setText("weekMin", safe(candle.w.low).toFixed(3));
    setText("weekOpen", safe(candle.w.open).toFixed(3));
    setText("weekMax", safe(candle.w.high).toFixed(3));
  } else { setText("weekMin", "--"); setText("weekOpen", "--"); setText("weekMax", "--"); }

  if (tfReady.m) {
    setText("monthMin", safe(candle.m.low).toFixed(3));
    setText("monthOpen", safe(candle.m.open).toFixed(3));
    setText("monthMax", safe(candle.m.high).toFixed(3));
  } else { setText("monthMin", "--"); setText("monthOpen", "--"); setText("monthMax", "--"); }

  const oa = displayed.available;
  displayed.available = tick(displayed.available, availableInj);
  colorNumber($("available"), displayed.available, oa, 6);
  setText("availableUsd", `≈ $${(displayed.available * displayed.price).toFixed(2)}`);

  const os = displayed.stake;
  displayed.stake = tick(displayed.stake, stakeInj);
  colorNumber($("stake"), displayed.stake, os, 4);
  setText("stakeUsd", `≈ $${(displayed.stake * displayed.price).toFixed(2)}`);

  const stakePct = clamp((displayed.stake / Math.max(0.0001, stakeTargetMaxDyn)) * 100, 0, 100);
  const stakeBar = $("stakeBar");
  const stakeLine = $("stakeLine");
  if (stakeBar) stakeBar.style.width = stakePct + "%";
  if (stakeLine) stakeLine.style.left = stakePct + "%";
  setText("stakePercent", stakePct.toFixed(1) + "%");
  setText("stakeMin", "0");
  setText("stakeMax", String(stakeTargetMaxDyn));

  const or = displayed.rewards;
  displayed.rewards = tick(displayed.rewards, rewardsInj);
  colorNumber($("rewards"), displayed.rewards, or, 7);
  setText("rewardsUsd", `≈ $${(displayed.rewards * displayed.price).toFixed(2)}`);

  // Rewards bar: percent must reflect the user target (per-address)
  const rewardTarget = Math.max(0.0001, safe(rewardTargetMaxDyn) || 1);
  const rp = clamp((displayed.rewards / rewardTarget) * 100, 0, 100);

  const rewardBar = $("rewardBar");
  const rewardLine = $("rewardLine");
  if (rewardBar) rewardBar.style.width = rp + "%";
  if (rewardLine) rewardLine.style.left = rp + "%";
  setText("rewardPercent", rp.toFixed(1) + "%");
  setText("rewardMin", "0");
  setText("rewardMax", fmtSmart(rewardTarget));

  const oapr = displayed.apr;
  displayed.apr = tick(displayed.apr, apr);
  colorNumber($("apr"), displayed.apr, oapr, 2);

  setText("updated", "Last update: " + nowLabel());

  const totalInj = safe(availableInj) + safe(stakeInj) + safe(rewardsInj);
  const totalUsd = totalInj * safe(displayed.price);

  const onw = displayed.netWorthUsd;
  displayed.netWorthUsd = tick(displayed.netWorthUsd, totalUsd);
  colorMoney($("netWorthUsd"), displayed.netWorthUsd, onw, 2);

  drawNW(false);
  updateNetWorthMiniRows();

  if (address && liveMode) recordNetWorthPoint();
  if (cloudDirty && hasInternet()) scheduleCloudPush();

  refreshConnUI();

  requestAnimationFrame(animate);
}
animate();
