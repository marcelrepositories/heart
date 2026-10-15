(() => {
  "use strict";

  // Pre-paint: flag JS and apply the stored theme before the first frame
  const root = document.documentElement;
  root.classList.add("js");
  try {
    const stored = localStorage.getItem("putaway-theme");
    if (stored === "light" || stored === "dark") root.dataset.theme = stored;
  } catch {
    // Storage is optional; the system preference applies
  }

  // Constants
  const COUNT = 36;
  const COLS = 6;
  const BORDER = 1;
  const Z_LIFT = 60;
  const HOLD_MS = 150;
  const HASH_MS = 150;
  const STEP = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -COLS,
    ArrowDown: COLS,
  };
  const ICON_HEAD =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cstyle%3Erect%7Bfill:%231a1a1a%7D@media(prefers-color-scheme:dark)%7Brect%7Bfill:%23f2f2f0%7D%7D%3C/style%3E%3Crect x='1' y='1' width='6' height='6'/%3E%3Crect x='9' y='1' width='6' height='6'/%3E%3Crect x='1' y='9' width='6' height='6'/%3E";
  const ICON_TIDY = `${ICON_HEAD}%3Crect x='9' y='9' width='6' height='6'/%3E%3C/svg%3E`;
  const ICON_LOOSE = `${ICON_HEAD}%3Crect x='9' y='9' width='6' height='6' transform='rotate(15 12 12)'/%3E%3C/svg%3E`;
  const STILL = { dur: "0ms", ease: "linear", step: 0 };
  const EDITABLE = "input:not([type='radio']), textarea, [contenteditable]";

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Pure helpers
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad2 = (n) => String(n).padStart(2, "0");
  const homeIndex = (tile, sort) =>
    sort === "colour" ? tile.shade * COLS + tile.hue : tile.id;
  const slotXY = (index, g) => ({
    x: g.inset + (index % COLS) * (g.tile + g.gap),
    y: g.inset + Math.floor(index / COLS) * (g.tile + g.gap),
  });
  const snapRadius = (tilePx) => Math.max(24, 0.45 * tilePx);
  const motion = (dur, ease, step = 0) => ({
    dur: `var(--dur-${dur})`,
    ease: `var(--ease-${ease})`,
    step,
  });

  // Scatter draws per tile, in id order: fx, fy, rot. Change this and every mess changes
  function scatterDraw(seed) {
    const rng = mulberry32(seed);
    return Array.from({ length: COUNT }, () => {
      const fx = rng();
      const fy = rng();
      return { fx, fy, rot: (rng() * 2 - 1) * 35 };
    });
  }

  // Nudge draws, in order: angle, distance, rot
  function nudgeDraw(seed, tilePx) {
    const rng = mulberry32(seed);
    const angle = rng() * Math.PI * 2;
    const dist = (0.7 + 0.5 * rng()) * tilePx;
    const rot = (rng() * 2 - 1) * 20;
    return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist, rot };
  }

  // State and tile collection
  const state = {
    sort: "number",
    scatterCount: 0,
    nudgeCount: 0,
    zTop: COUNT,
    messActive: false,
    drag: null,
    tabbable: null,
    side: 0,
    tile: 0,
    gap: 0,
    inset: 0,
  };
  const tiles = [];
  const dom = {};
  const timers = {};
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");
  const free = () => state.side - state.tile;
  const homeSlot = (tile) => slotXY(homeIndex(tile, state.sort), state);
  const msOf = (name) =>
    parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
  let order = [];
  let tick = null;
  let lastCount = -1;

  // Layout
  function layout() {
    const side = Math.min(480, Math.floor(dom.figure.clientWidth / 8) * 8);
    const inner = side - 2 * BORDER;
    const gap = side < 400 ? 4 : 8;
    const tile = Math.floor((inner - 7 * gap) / COLS);
    const inset = Math.floor((inner - COLS * tile - (COLS - 1) * gap) / 2);
    const next = { side, gap, tile, inset };
    const keys = Object.keys(next);
    if (keys.every((k) => state[k] === next[k])) return false;
    Object.assign(state, next);
    keys.forEach((k) => dom.board.style.setProperty(`--${k}`, `${next[k]}px`));
    renderStats();
    return true;
  }

  function placeAll() {
    tiles.forEach((tile) => {
      const m = { ...STILL, z: tile.z };
      if (tile.status === "home") setHome(tile, m);
      else setLoose(tile, tile.fx, tile.fy, tile.rot, m);
    });
    syncMarker();
  }

  // Render
  function applyTarget(tile, t) {
    const s = tile.el.style;
    s.setProperty("--x", `${t.x}px`);
    s.setProperty("--y", `${t.y}px`);
    s.setProperty("--r", `${reduced.matches ? 0 : t.rot}deg`);
    s.setProperty("--dur", t.dur);
    s.setProperty("--ease", t.ease);
    s.setProperty("--delay", `calc(var(--stagger) * ${t.step})`);
    s.zIndex = t.z;
    const status = tile.status === "home" ? "in place" : "loose";
    tile.el.setAttribute("aria-label", `Tile ${pad2(tile.id + 1)}, ${status}`);
  }

  function renderStatus() {
    const home = tiles.filter((t) => t.status === "home").length;
    if (home === COUNT && state.messActive) {
      state.messActive = false;
      writeHash();
    }
    const shown = tick ? COUNT - tick.ids.size : home;
    const mess = tick ? tick.mess : state.messActive && state.scatterCount;
    const all = shown === COUNT;
    dom.pre.nodeValue = all ? "All " : mess ? `Mess #${mess} · ` : "";
    dom.count.textContent = shown;
    dom.post.nodeValue = all ? " in place." : ` of ${COUNT} in place.`;
    if (shown !== lastCount && lastCount >= 0) flash(all);
    lastCount = shown;
    document.title = all ? "Putaway" : `Putaway · ${COUNT - shown} loose`;
    const icon = all ? ICON_TIDY : ICON_LOOSE;
    if (dom.icon.getAttribute("href") !== icon)
      dom.icon.setAttribute("href", icon);
    dom.scatter.classList.toggle("btn--primary", all);
    dom.tidy.classList.toggle("btn--primary", !all);
    syncMarker();
  }

  // Restart the counter's accent-to-ink fade; at 36 the board border flashes too
  function flash(all) {
    dom.count.classList.add("is-fresh");
    void dom.count.offsetWidth;
    dom.count.classList.remove("is-fresh");
    if (!all) return;
    clearTimeout(timers.flash);
    dom.board.classList.add("is-complete");
    const off = () => dom.board.classList.remove("is-complete");
    timers.flash = setTimeout(off, msOf("--dur-flash"));
  }

  function renderStats() {
    dom.stats.forEach((el) => {
      el.textContent = state[el.dataset.stat];
    });
  }

  function announce(text) {
    dom.live.textContent = text;
  }

  function setLifted(tile, on) {
    tile.el.classList.toggle("is-lifted", on);
    tile.el.style.zIndex = on ? Z_LIFT : tile.z;
  }

  function showMarker(tile, opacity) {
    const slot = homeSlot(tile);
    dom.marker.style.setProperty("--x", `${slot.x}px`);
    dom.marker.style.setProperty("--y", `${slot.y}px`);
    dom.marker.style.opacity = opacity;
  }

  function syncMarker() {
    if (state.drag) return;
    const el = document.activeElement;
    const tile = el.matches(".tile:focus-visible") && tiles[el.dataset.id];
    if (tile && tile.status === "loose") showMarker(tile, 0.4);
    else dom.marker.style.opacity = 0;
  }

  // Actions
  function setHome(tile, m) {
    const slot = homeSlot(tile);
    Object.assign(tile, { status: "home", rot: 0, z: m.z });
    applyTarget(tile, { x: slot.x, y: slot.y, rot: 0, ...m });
  }

  function setLoose(tile, fx, fy, rot, m) {
    cancelTick();
    Object.assign(tile, { status: "loose", fx, fy, rot, z: m.z });
    applyTarget(tile, { x: fx * free(), y: fy * free(), rot, ...m });
  }

  function placeScatter(m) {
    const draws = scatterDraw(state.scatterCount);
    tiles.forEach((tile, i) => {
      const d = draws[i];
      setLoose(tile, d.fx, d.fy, d.rot, { ...m, z: i + 1 });
    });
    state.zTop = COUNT;
  }

  function scatter() {
    state.scatterCount += 1;
    state.messActive = true;
    placeScatter(motion("scatter", "out"));
    announce(`Mess ${state.scatterCount}. None in place.`);
    writeHash();
    renderStatus();
  }

  function tidy() {
    cancelTick();
    const moving = tiles.filter((t) => t.status !== "home").map((t) => t.id);
    const mess = state.messActive && state.scatterCount;
    tiles.forEach((tile) => {
      const idx = homeIndex(tile, state.sort);
      setHome(tile, { ...motion("tidy", "snap", idx), z: idx + 1 });
    });
    state.zTop = COUNT;
    if (moving.length && !reduced.matches) {
      const ms = msOf("--dur-tidy") + (COUNT - 1) * msOf("--stagger") + 50;
      tick = { ids: new Set(moving), mess, timer: setTimeout(finishTick, ms) };
    }
    renderStatus();
    if (moving.length && !tick) announce("All 36 in place.");
  }

  function finishTick() {
    cancelTick();
    renderStatus();
    announce("All 36 in place.");
  }

  function cancelTick() {
    if (!tick) return;
    clearTimeout(tick.timer);
    tick = null;
  }

  function onTransitionEnd(e) {
    const isTile = e.target.classList.contains("tile");
    if (!tick || !isTile || e.propertyName !== "transform") return;
    tick.ids.delete(Number(e.target.dataset.id));
    if (tick.ids.size) renderStatus();
    else finishTick();
  }

  function nudge(tile) {
    state.nudgeCount += 1;
    const d = nudgeDraw(state.nudgeCount * 37 + tile.id, state.tile);
    const slot = homeSlot(tile);
    const max = free();
    const fx = clamp(slot.x + d.dx, 0, max) / max;
    const fy = clamp(slot.y + d.dy, 0, max) / max;
    const m = { ...motion("nudge", "out"), z: ++state.zTop };
    setLoose(tile, fx, fy, d.rot, m);
  }

  function tap(tile) {
    if (tile.status === "loose") {
      setHome(tile, { ...motion("snap", "snap"), z: ++state.zTop });
      vibrate(8);
    } else nudge(tile);
    renderStatus();
  }

  function setSort(sort) {
    if (sort === state.sort) return;
    state.sort = sort;
    dom.sorts[sort].checked = true;
    tiles.forEach((tile) => {
      const idx = homeIndex(tile, sort);
      if (tile.status === "home")
        setHome(tile, { ...motion("tidy", "snap", idx), z: idx + 1 });
    });
    buildOrder();
    syncMarker();
    announce(`Sorted by ${sort}.`);
    writeHash();
  }

  const vibrate = (ms) => navigator.vibrate && navigator.vibrate(ms);

  // Drag recogniser
  function onPointerDown(e) {
    const el = e.target.closest(".tile");
    if (!el || e.button !== 0 || state.drag) return;
    const tile = tiles[el.dataset.id];
    const at =
      tile.status === "home"
        ? homeSlot(tile)
        : { x: tile.fx * free(), y: tile.fy * free() };
    const touch = e.pointerType === "touch";
    state.drag = {
      tile,
      id: e.pointerId,
      touch,
      start: [e.clientX, e.clientY],
      base: at,
      raw: at,
      origin: { ...tile },
    };
    if (touch) state.drag.timer = setTimeout(lift, HOLD_MS);
    else lift();
  }

  function lift() {
    const d = state.drag;
    if (!d || d.lifted) return;
    d.lifted = true;
    d.tile.el.setPointerCapture(d.id);
    setLifted(d.tile, true);
    if (d.touch) vibrate(5);
  }

  function onPointerMove(e) {
    const d = state.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.start[0];
    const dy = e.clientY - d.start[1];
    const travel = Math.max(Math.abs(dx), Math.abs(dy));
    if (!d.lifted) {
      // Sideways the page cannot pan, so lift; a vertical move is the page's until it says otherwise
      if (Math.abs(dx) <= 8 || Math.abs(dx) <= Math.abs(dy)) return;
      clearTimeout(d.timer);
      lift();
    }
    if (travel > 4) d.moved = true;
    if (!d.moved) return;
    const max = free();
    d.raw = {
      x: clamp(d.base.x + dx, 0, max),
      y: clamp(d.base.y + dy, 0, max),
    };
    const slot = homeSlot(d.tile);
    d.near =
      Math.hypot(d.raw.x - slot.x, d.raw.y - slot.y) < snapRadius(state.tile);
    const lean = d.near ? 0.2 : 0;
    const x = d.raw.x + (slot.x - d.raw.x) * lean;
    const y = d.raw.y + (slot.y - d.raw.y) * lean;
    applyTarget(d.tile, { x, y, rot: 0, ...STILL, z: Z_LIFT });
    showMarker(d.tile, d.near ? 1 : 0.4);
  }

  function onPointerUp(e) {
    const d = state.drag;
    if (!d || e.pointerId !== d.id) return;
    endDrag(d.lifted || e.type === "pointerup" ? "drop" : "abandon");
  }

  // Ends the drag: drop (a tap, a snap home or a loose drop), cancel (Escape, back to the origin) or abandon (the page took the gesture)
  function endDrag(how) {
    const d = state.drag;
    clearTimeout(d.timer);
    state.drag = null;
    if (d.lifted) {
      try {
        d.tile.el.releasePointerCapture(d.id);
      } catch {
        // The pointer may already be gone
      }
      setLifted(d.tile, false);
    }
    const max = free();
    const z = ++state.zTop;
    if (how === "cancel") {
      const m = { ...motion("snap", "snap"), z: d.tile.z };
      if (d.origin.status === "home") setHome(d.tile, m);
      else setLoose(d.tile, d.origin.fx, d.origin.fy, 0, m);
    } else if (how === "abandon") return;
    else if (!d.moved) return tap(d.tile);
    else if (!d.lifted) return;
    else if (d.near) {
      setHome(d.tile, { ...motion("snap", "snap"), z });
      vibrate(8);
    } else {
      const m = { ...motion("lift", "ui"), z };
      setLoose(d.tile, d.raw.x / max, d.raw.y / max, 0, m);
    }
    renderStatus();
  }

  // Keyboard
  const keyName = (e) =>
    e.key === " " ? "Space" : e.key.length === 1 ? e.key.toLowerCase() : e.key;

  function pressKeycap(key, down) {
    (dom.kbds.get(key) || []).forEach((el) =>
      el.classList.toggle("is-down", down),
    );
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = keyName(e);
    pressKeycap(key, true);
    if (state.drag) {
      if (key === "Escape") endDrag("cancel");
      return;
    }
    if (e.target.matches(EDITABLE)) return;
    const el = e.target.closest(".tile");
    if (el && (key in STEP || key === "Home" || key === "End")) {
      const i = order.indexOf(tiles[el.dataset.id]);
      const to = key === "Home" ? 0 : key === "End" ? COUNT - 1 : i + STEP[key];
      focusTile(order[clamp(to, 0, COUNT - 1)]);
    } else if (el && (key === "Space" || key === "Enter"))
      tap(tiles[el.dataset.id]);
    else if (e.repeat) return;
    else if (key === "s") scatter();
    else if (key === "t") tidy();
    else if (key === "1") setSort("number");
    else if (key === "2") setSort("colour");
    else return;
    e.preventDefault();
  }

  function onBlur() {
    dom.kbds.forEach((list) =>
      list.forEach((el) => el.classList.remove("is-down")),
    );
    if (state.drag) endDrag(state.drag.lifted ? "drop" : "abandon");
  }

  function buildOrder() {
    const key = (tile) => homeIndex(tile, state.sort);
    order = [...tiles].sort((a, b) => key(a) - key(b));
  }

  function focusTile(tile) {
    state.tabbable.el.tabIndex = -1;
    tile.el.tabIndex = 0;
    state.tabbable = tile;
    tile.el.focus({ preventScroll: true });
  }

  // URL: replaceState, so a mess never piles up in the history
  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const n = parseInt(params.get("mess"), 10);
    if (params.get("sort") === "colour") {
      state.sort = "colour";
      dom.sorts.colour.checked = true;
    }
    if (n >= 1 && n <= 9999) {
      state.scatterCount = n;
      state.messActive = true;
    }
  }

  function writeHash() {
    clearTimeout(timers.hash);
    timers.hash = setTimeout(flushHash, HASH_MS);
  }

  function flushHash() {
    clearTimeout(timers.hash);
    const parts = [];
    if (state.messActive) parts.push(`mess=${state.scatterCount}`);
    if (state.sort === "colour") parts.push("sort=colour");
    const hash = parts.length ? `#${parts.join("&")}` : "";
    if (hash === location.hash) return;
    history.replaceState(null, "", location.pathname + location.search + hash);
  }

  // Copy link
  async function copyLink() {
    flushHash();
    let ok = true;
    try {
      await navigator.clipboard.writeText(location.href);
    } catch {
      ok = copyFallback();
    }
    clearTimeout(timers.label);
    dom.copy.textContent = ok ? "Copied" : "Use the address bar";
    const reset = () => (dom.copy.textContent = "Copy link");
    timers.label = setTimeout(reset, ok ? 1200 : 2000);
    if (ok) announce("Link copied.");
  }

  function copyFallback() {
    const area = document.createElement("textarea");
    area.className = "sr-only";
    area.value = location.href;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      // Nothing copied; the label says to use the address bar
    }
    area.remove();
    dom.copy.focus();
    return ok;
  }

  // Theme toggle
  const effectiveTheme = () =>
    root.dataset.theme || (darkScheme.matches ? "dark" : "light");
  const otherTheme = () => (effectiveTheme() === "dark" ? "light" : "dark");

  function renderTheme() {
    dom.theme.setAttribute("aria-label", `Switch to ${otherTheme()} theme`);
  }

  function toggleTheme() {
    const next = otherTheme();
    root.classList.add("theming");
    root.dataset.theme = next;
    try {
      localStorage.setItem("putaway-theme", next);
    } catch {
      // Storage is optional; the choice lasts for this page
    }
    renderTheme();
    setTimeout(() => root.classList.remove("theming"), msOf("--dur-theme"));
  }

  function init() {
    const $ = (s) => document.querySelector(s);
    dom.figure = $(".figure");
    dom.board = $(".board");
    dom.marker = $(".slot-marker");
    dom.live = $("[aria-live]");
    dom.scatter = $(".btn--scatter");
    dom.tidy = $(".btn--tidy");
    dom.theme = $(".btn--theme");
    dom.copy = $(".status__copy");
    dom.status = $("#board-status");
    dom.icon = $("link[rel='icon']");
    dom.stats = [...document.querySelectorAll("[data-stat]")];
    dom.sorts = {};
    document.querySelectorAll("input[name='sort']").forEach((r) => {
      dom.sorts[r.value] = r;
      r.addEventListener("change", () => setSort(r.value));
    });
    dom.kbds = new Map();
    document.querySelectorAll("kbd[data-key]").forEach((el) => {
      const list = dom.kbds.get(el.dataset.key) || [];
      dom.kbds.set(el.dataset.key, list.concat(el));
    });
    dom.pre = document.createTextNode("");
    dom.count = document.createElement("span");
    dom.count.className = "status__count";
    dom.post = document.createTextNode("");
    dom.status.replaceChildren(dom.pre, dom.count, dom.post);
    document.querySelectorAll(".tile").forEach((el, i) => {
      const { id, hue, shade } = el.dataset;
      el.tabIndex = i ? -1 : 0;
      tiles.push({ el, id: +id, hue: +hue, shade: +shade, status: "home" });
    });
    state.tabbable = tiles[0];
    readHash();
    buildOrder();
    layout();
    if (state.messActive) placeScatter(STILL);
    else order.forEach((tile, i) => setHome(tile, { ...STILL, z: i + 1 }));
    renderStatus();
    renderTheme();
    dom.board.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // Non-passive so a finger that has lifted a tile moves the tile, not the page; before the lift it scrolls freely
    const guard = (e) => state.drag && state.drag.lifted && e.preventDefault();
    dom.board.addEventListener("touchmove", guard, { passive: false });
    const noMenu = (e) => e.target.closest(".tile") && e.preventDefault();
    dom.board.addEventListener("contextmenu", noMenu);
    dom.board.addEventListener("transitionend", onTransitionEnd);
    dom.board.addEventListener("focusin", syncMarker);
    dom.board.addEventListener("focusout", syncMarker);
    dom.scatter.addEventListener("click", scatter);
    dom.tidy.addEventListener("click", tidy);
    dom.copy.addEventListener("click", copyLink);
    dom.theme.addEventListener("click", toggleTheme);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", (e) => pressKeycap(keyName(e), false));
    window.addEventListener("blur", onBlur);
    darkScheme.addEventListener("change", renderTheme);
    reduced.addEventListener("change", placeAll);
    new ResizeObserver(() => layout() && placeAll()).observe(dom.figure);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
