import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { exit } from "@tauri-apps/plugin-process";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { loadCatalog, savedSlug, saveSlug, getLibrary, addToLibrary, removeFromLibrary, petDisplayName, renamePet, type Pet, type LibPet } from "./catalog";
import { t, getLang, setLang, type Lang } from "./i18n";
import { agentIconUrl, uiIcon } from "./icons";
import { LAYOUT_PRESETS, readBubbleConfig, type TokenItem, type BubbleToken } from "./bubble";
import { initDemo } from "./demo";
import { slice, type Rect } from "./pet";
import * as care from "./care";
import * as usage from "./usage";
import * as projectpets from "./projectpets";
import * as sync from "./sync";
import * as history from "./history";

// ------------------------------------------------------------- segmented ----
// macOS-style segmented controls: <span class="seg" data-key data-default>.
function initSegs() {
  document.querySelectorAll<HTMLElement>(".seg[data-key]").forEach((seg) => {
    const key = seg.dataset.key!;
    const current = localStorage.getItem(key) || seg.dataset.default || "";
    const btns = seg.querySelectorAll<HTMLButtonElement>("button");
    btns.forEach((b) => {
      b.classList.toggle("sel", b.dataset.v === current);
      b.onclick = () => {
        localStorage.setItem(key, b.dataset.v!);
        btns.forEach((x) => x.classList.toggle("sel", x === b));
        emit("bubble-changed", null);
        document.dispatchEvent(new CustomEvent("seg-changed", { detail: key }));
      };
    });
  });
}

// ------------------------------------------------------------------ tabs ----
function initTabs() {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tabbar .tab");
  tabs.forEach((b) => {
    b.onclick = () => {
      tabs.forEach((x) => x.classList.toggle("sel", x === b));
      document.querySelectorAll<HTMLElement>(".page").forEach((p) => {
        p.classList.toggle("sel", p.dataset.page === b.dataset.tab);
      });
      if (b.dataset.tab === "care") { renderCare(); renderSync(); }
      if (b.dataset.tab === "history") renderHistory();
    };
  });
}

// ------------------------------------------------------------------ history ----
function renderHistory() {
  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  const countEl = document.getElementById("history-count");
  if (!listEl) return;
  const items = history.list();
  if (countEl) countEl.textContent = items.length ? `${items.length}` : "";
  if (emptyEl) emptyEl.style.display = items.length ? "none" : "";
  const escH = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const fmtDur = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}${t("s")}`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m}${t("m")}` : `${Math.round(m / 60)}${t("h")}`;
  };
  const locale = getLang() === "zh" ? "zh-CN" : undefined;
  const dayLabel = (t: number) => new Date(t).toLocaleDateString(locale);
  const timeLabel = (t: number) => new Date(t).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  let html = "", curDay = "";
  for (const e of items) {
    const d = dayLabel(e.endedAt);
    if (d !== curDay) { curDay = d; html += `<div class="hist-day">${escH(d)}</div>`; }
    const label = e.title || e.project || e.agent;
    html += `<div class="hist-row">
      <span class="hist-agent">${escH(e.agent)}</span>
      <span class="hist-title">${escH(label)}</span>
      <span class="hist-meta dim">${escH(e.project)} · ${fmtDur(e.endedAt - e.startedAt)} · ${timeLabel(e.endedAt)}</span>
    </div>`;
  }
  listEl.innerHTML = html;
}

// ------------------------------------------------------------------ care ----
function fmtNum(n: number): string {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
function currentPetName(): string {
  const slug = savedSlug();
  if (!slug) return t("Your pet");
  const custom = petDisplayName(slug);
  if (custom !== slug) return custom;
  const hit = getLibrary().find((p) => p.slug === slug) || catalog.find((p) => p.slug === slug);
  return hit?.name || slug;
}
function renderCare() {
  // Usage panels are independent from the selected pet and stay useful even if
  // the local pet library has not finished loading yet.
  void refreshUsagePanels();
  const slug = savedSlug();
  if (!slug) return;
  const s = care.stateFor(slug);
  const internal = care.levelForXP(s.xp);
  const setTxt = (id: string, v: string) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt("care-name", currentPetName());
  setTxt("care-level", `${t("Lv")} ${care.displayLevel(s.xp)}`);
  setTxt("care-stagename", t(care.stageName(internal)));
  setTxt("care-hunger", t(care.hunger(s)));
  const fill = document.getElementById("care-xpfill");
  if (fill) fill.style.width = `${Math.round(care.levelProgress(s.xp) * 100)}%`;
  setTxt("care-xp", `${s.xp} XP`);
  const toNext = care.tokensToNextLevel(s);
  setTxt("care-tonext", toNext > 0 ? `≈ ${fmtNum(toNext)} ${t("tokens to next level")}` : "");
  // achievements
  const unlocked = new Set(s.unlockedAchievements || []);
  setTxt("care-achcount", `${unlocked.size} / ${care.ACHIEVEMENTS.length}`);
  const badges = document.getElementById("care-badges");
  if (badges) badges.innerHTML = care.ACHIEVEMENTS
    .map((a) => `<span class="care-badge${unlocked.has(a) ? " on" : ""}" title="${t(care.ACH_NAME[a])}">${care.ACH_ICON[a]}</span>`)
    .join("");
  setTxt("care-today", fmtNum(s.tokensToday));
  setTxt("care-today-sub", `${s.mealsToday} ${t("sessions")}`);
  const money = (v: number) => `$${v.toFixed(2)}`;
  setTxt("care-cost", `${t("Today")} ${money(usage.todayCostUSD())} · ${t("Month")} ${money(usage.monthlyCostUSD())}`);
  setTxt("care-streak", String(s.streakDays));
  setTxt("care-lifetime", fmtNum(s.totalTokens));
  setTxt("care-sessions", String(s.totalMeals));
  const days = care.recentDays(s, 7);
  const max = Math.max(1, ...days.map((d) => d.tokens));
  setTxt("care-burntotal", fmtNum(days.reduce((a, d) => a + d.tokens, 0)));
  const chart = document.getElementById("care-chart");
  if (chart) chart.innerHTML = days
    .map((d) => `<div class="cbar-wrap" title="${fmtNum(d.tokens)}"><div class="cbar" style="height:${Math.max(3, Math.round((d.tokens / max) * 100))}%"></div><div class="cbar-lbl">${d.label}</div></div>`)
    .join("");
}

type JsonObject = Record<string, unknown>;

interface CodexAccountSnapshot {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  updatedAt: number;
  stale: boolean;
  error: string | null;
}

interface UsageLedgerStats {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  grossTokens?: number;
  effectiveTokens?: number;
  todayGrossTokens?: number;
  todayEffectiveTokens?: number;
  eventCount?: number;
  todayEventCount?: number;
  sessionCount?: number;
  todaySessionCount?: number;
  fileCount?: number;
  firstEventAt?: number | string | null;
  lastEventAt?: number | string | null;
  today?: string;
}

interface UsageScanProgress {
  filesDiscovered?: number;
  filesScanned?: number;
  bytesTotal?: number;
  bytesScanned?: number;
  eventsSeen?: number;
  eventsInserted?: number;
  errorCount?: number;
  currentFile?: string | null;
  finished?: boolean;
}

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const localeCode = () => {
  if (getLang() === "zh") return "zh-CN";
  if (getLang() === "zh-TW") return "zh-TW";
  if (getLang() === "vi") return "vi-VN";
  return "en-US";
};

function usageDate(value: unknown): Date | null {
  if (typeof value === "string" && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const epoch = finiteNumber(value);
  if (epoch === null || epoch <= 0) return null;
  const date = new Date(epoch >= 1e12 ? epoch : epoch * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtUsageDate(value: unknown, withTime = false): string {
  const date = usageDate(value);
  if (!date) return "--";
  return withTime
    ? date.toLocaleString(localeCode(), { dateStyle: "short", timeStyle: "short" })
    : date.toLocaleDateString(localeCode(), { year: "numeric", month: "short", day: "numeric" });
}

function fmtDuration(seconds: unknown): string {
  const total = finiteNumber(seconds);
  if (total === null || total < 0) return "--";
  const rounded = Math.round(total);
  if (rounded < 60) return `${rounded}${t("s")}`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours) return minutes ? `${hours}${t("h")} ${minutes}${t("m")}` : `${hours}${t("h")}`;
  return `${minutes}${t("m")}`;
}

function usageText(id: string, value: string, resolved = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.classList.toggle("usage-placeholder", !resolved);
}

function usageStatus(id: string, value: string, tone: "ok" | "warn" | "error" | "neutral" = "neutral") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.dataset.tone = tone;
}

function setUsageBusy(id: string, busy: boolean) {
  const el = document.getElementById(id);
  if (el) el.setAttribute("aria-busy", String(busy));
}

let usagePanelsRefreshing = false;
let usagePanelsLastRefresh = 0;
let latestLedgerProgress: UsageScanProgress | null = null;
let latestLedgerValue: unknown = null;

function renderAccountSnapshot(snapshot: CodexAccountSnapshot) {
  const hasOfficialData = [snapshot.lifetimeTokens, snapshot.peakDailyTokens, snapshot.longestRunningTurnSec, snapshot.currentStreakDays]
    .some((value) => finiteNumber(value) !== null);
  const metric = (id: string, value: unknown, format: (n: number) => string = fmtNum) => {
    const n = finiteNumber(value);
    usageText(id, n === null ? "--" : format(n), n !== null);
  };

  metric("codex-account-lifetime", snapshot.lifetimeTokens);
  metric("codex-account-peak", snapshot.peakDailyTokens);
  metric("codex-account-longest", snapshot.longestRunningTurnSec, (n) => fmtDuration(n));
  metric("codex-account-streak", snapshot.currentStreakDays, (n) => String(Math.max(0, Math.round(n))));

  const best = finiteNumber(snapshot.longestStreakDays);
  usageText(
    "codex-account-streak-sub",
    best === null ? t("days") : `${t("Best")} ${Math.round(best)} ${t("days")}`,
    best !== null || finiteNumber(snapshot.currentStreakDays) !== null,
  );

  const used = finiteNumber(snapshot.usedPercent);
  const clamped = Math.max(0, Math.min(100, used ?? 0));
  usageText("codex-quota-value", used === null ? t("Not available") : `${clamped.toFixed(clamped % 1 ? 1 : 0)}%`, used !== null);
  const fill = document.getElementById("codex-quota-fill");
  if (fill) fill.style.width = `${clamped}%`;
  const track = document.getElementById("codex-quota-track");
  if (track) track.setAttribute("aria-valuenow", String(clamped));

  const windowMins = finiteNumber(snapshot.windowDurationMins);
  const windowDays = windowMins === null ? null : windowMins / 1440;
  usageText(
    "codex-quota-window",
    windowDays === null ? t("Usage window unavailable") : `${Number.isInteger(windowDays) ? windowDays : windowDays.toFixed(1)} ${t("day window")}`,
    windowDays !== null,
  );
  const reset = usageDate(snapshot.resetsAt);
  usageText("codex-quota-reset", reset ? `${t("Resets")} ${fmtUsageDate(snapshot.resetsAt, true)}` : t("Reset time unavailable"), Boolean(reset));

  const updated = usageDate(snapshot.updatedAt);
  usageText("codex-account-updated", updated ? `${t("Updated")} ${fmtUsageDate(snapshot.updatedAt, true)}` : t("Update time unavailable"), Boolean(updated));
  if (!hasOfficialData) {
    usageStatus("codex-account-status", t("Unavailable"), "error");
    usageText("codex-account-message", t("Official usage is temporarily unavailable."));
  } else if (snapshot.stale || snapshot.error) {
    usageStatus("codex-account-status", t("Cached data"), "warn");
    usageText("codex-account-message", t("Showing the last successful official snapshot."));
  } else {
    usageStatus("codex-account-status", t("Official data updated"), "ok");
    usageText("codex-account-message", t("Official account data does not affect pet XP."));
  }
  setUsageBusy("codex-account-card", false);
}

function renderAccountUnavailable() {
  ["codex-account-lifetime", "codex-account-peak", "codex-account-longest", "codex-account-streak", "codex-account-streak-sub",
    "codex-quota-value", "codex-quota-window", "codex-quota-reset", "codex-account-updated"]
    .forEach((id) => usageText(id, "--", false));
  const fill = document.getElementById("codex-quota-fill");
  if (fill) fill.style.width = "0%";
  const track = document.getElementById("codex-quota-track");
  if (track) track.setAttribute("aria-valuenow", "0");
  usageStatus("codex-account-status", t("Unavailable"), "error");
  usageText("codex-account-message", t("Official usage is temporarily unavailable."));
  setUsageBusy("codex-account-card", false);
}

function scanProgressFrom(value: unknown): UsageScanProgress | null {
  const root = asObject(value);
  if (!root) return latestLedgerProgress;
  const scan = asObject(root.scan) || asObject(root.progress);
  if (!scan) return latestLedgerProgress;
  const nested = asObject(scan.progress) || scan;
  return nested as UsageScanProgress;
}

function renderLedgerStats(value: unknown) {
  latestLedgerValue = value;
  const root = asObject(value) || {};
  const stats = (asObject(root.stats) || root) as UsageLedgerStats;
  const progress = scanProgressFrom(value);
  const metric = (id: string, value: unknown, format: (n: number) => string = fmtNum) => {
    const n = finiteNumber(value);
    usageText(id, n === null ? "--" : format(n), n !== null);
  };

  metric("local-codex-gross", stats.grossTokens);
  metric("local-codex-effective", stats.effectiveTokens);
  metric("local-codex-sessions", stats.sessionCount, (n) => Math.max(0, Math.round(n)).toLocaleString(localeCode()));

  const eventCount = finiteNumber(stats.eventCount);
  const fileCount = finiteNumber(stats.fileCount);
  usageText(
    "local-codex-session-sub",
    eventCount === null ? t("usage events") : `${Math.round(eventCount).toLocaleString(localeCode())} ${t("usage events")}`,
    eventCount !== null,
  );

  const first = usageDate(stats.firstEventAt);
  const last = usageDate(stats.lastEventAt);
  usageText("local-codex-coverage", first && last ? `${fmtUsageDate(stats.firstEventAt)} - ${fmtUsageDate(stats.lastEventAt)}` : "--", Boolean(first && last));
  usageText("local-codex-coverage-sub", first && last ? t("first to latest event") : t("Coverage unavailable"), Boolean(first && last));

  if (progress && !progress.finished) {
    const doneBytes = finiteNumber(progress.bytesScanned) ?? 0;
    const totalBytes = finiteNumber(progress.bytesTotal) ?? 0;
    const doneFiles = finiteNumber(progress.filesScanned) ?? 0;
    const totalFiles = finiteNumber(progress.filesDiscovered) ?? 0;
    const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : totalFiles > 0 ? Math.round((doneFiles / totalFiles) * 100) : 0;
    usageStatus("local-codex-status", `${t("Scanning local records")} ${Math.max(0, Math.min(100, pct))}%`, "warn");
    usageText("local-codex-message", t("The first scan may take a while and runs in the background."));
    usageText("local-codex-scan", totalFiles > 0 ? `${Math.round(doneFiles)} / ${Math.round(totalFiles)} ${t("files")}` : t("Scanning"));
  } else {
    const errors = finiteNumber(progress?.errorCount) ?? 0;
    const empty = (fileCount ?? 0) === 0 && (eventCount ?? 0) === 0 && !first && !last;
    usageStatus(
      "local-codex-status",
      empty ? t("No local records yet") : errors > 0 ? t("Complete with skipped files") : t("Ready"),
      errors > 0 ? "warn" : empty ? "neutral" : "ok",
    );
    usageText(
      "local-codex-message",
      empty ? t("Local totals will appear after the first scan.") : t("Local totals are calculated from this computer's Codex logs."),
    );
    const details: string[] = [];
    if (fileCount !== null) details.push(`${Math.round(fileCount).toLocaleString(localeCode())} ${t("files")}`);
    if (eventCount !== null) details.push(`${Math.round(eventCount).toLocaleString(localeCode())} ${t("events")}`);
    usageText("local-codex-scan", empty ? t("Waiting for scan") : details.length ? details.join(" / ") : t("Statistics ready"), !empty && details.length > 0);
  }
  setUsageBusy("local-codex-card", false);
}

function renderLedgerUnavailable() {
  ["local-codex-gross", "local-codex-effective", "local-codex-sessions", "local-codex-session-sub", "local-codex-coverage", "local-codex-coverage-sub", "local-codex-scan"]
    .forEach((id) => usageText(id, "--", false));
  usageStatus("local-codex-status", t("Unavailable"), "error");
  usageText("local-codex-message", t("Local usage records are temporarily unavailable."));
  setUsageBusy("local-codex-card", false);
}

function withUsageTimeout<T>(promise: Promise<T>, timeoutMs = 25_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("usage-timeout")), timeoutMs);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

async function refreshUsagePanels(force = false) {
  const now = Date.now();
  if (usagePanelsRefreshing || (!force && now - usagePanelsLastRefresh < 30_000)) return;
  usagePanelsRefreshing = true;
  usagePanelsLastRefresh = now;
  try {
    const [account, ledger] = await Promise.allSettled([
      withUsageTimeout(Promise.resolve().then(() => invoke<CodexAccountSnapshot>("get_codex_account_snapshot"))),
      withUsageTimeout(Promise.resolve().then(() => invoke<unknown>("get_usage_ledger_stats"))),
    ]);
    if (account.status === "fulfilled") renderAccountSnapshot(account.value);
    else renderAccountUnavailable();
    if (ledger.status === "fulfilled") renderLedgerStats(ledger.value);
    else renderLedgerUnavailable();
  } finally {
    usagePanelsRefreshing = false;
  }
}

// Click the pet's name to rename it; Enter or blur saves (empty resets to the
// default). The custom name flows to the HUD, menubar, and web leaderboard.
function setupRename() {
  const nameEl = document.getElementById("care-name");
  const input = document.getElementById("care-rename") as HTMLInputElement | null;
  if (!nameEl || !input) return;
  const startEdit = () => {
    const slug = savedSlug();
    if (!slug) return;
    input.value = currentPetName();
    nameEl.style.display = "none";
    input.style.display = "";
    input.focus();
    input.select();
  };
  const commit = () => {
    const slug = savedSlug();
    if (slug) renamePet(slug, input.value);
    input.style.display = "none";
    nameEl.style.display = "";
    renderCare();
    emit("care-updated");
    sync.schedulePush();
  };
  nameEl.addEventListener("click", startEdit);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { input.value = currentPetName(); input.blur(); }
  });
}
setupRename();

// Refresh when the pet window feeds the pet, and periodically for the hunger clock.
listen("care-updated", () => { if (document.querySelector('.page[data-page="care"].sel')) renderCare(); });
listen<UsageScanProgress>("usage-ledger-progress", (event) => {
  latestLedgerProgress = event.payload;
  if (!document.querySelector('.page[data-page="care"].sel')) return;
  if (event.payload.finished) {
    // Refresh the SQLite totals once when a pass completes.  Do not re-query
    // the official account endpoint for every local scan progress event.
    void invoke<unknown>("get_usage_ledger_stats")
      .then((value) => renderLedgerStats(value))
      .catch(() => renderLedgerUnavailable());
  } else if (latestLedgerValue !== null) {
    renderLedgerStats(latestLedgerValue);
  }
});
setInterval(() => { if (document.querySelector('.page[data-page="care"].sel')) renderCare(); }, 30_000);

// ---- web profile / leaderboard sign-in ----
function renderSync() {
  const out = document.getElementById("sync-out");
  const inn = document.getElementById("sync-in");
  const status = document.getElementById("sync-status");
  if (!out || !inn) return;
  const on = sync.signedIn();
  out.style.display = on ? "none" : "";
  inn.style.display = on ? "" : "none";
  if (on && status) {
    const who = sync.login();
    status.textContent = who ? `${t("Connected as")} ${who}` : t("Connected to your profile");
  }
}
function initSync() {
  const codeEl = document.getElementById("sync-code") as HTMLInputElement | null;
  const msg = document.getElementById("sync-msg");
  document.getElementById("sync-connect")?.addEventListener("click", async () => {
    const c = (codeEl?.value || "").trim().toUpperCase();
    if (msg) msg.textContent = t("Connecting…");
    const r = await sync.pair(c);
    if (r.ok) {
      if (msg) msg.textContent = "";
      if (codeEl) codeEl.value = "";
      renderSync(); renderCare();
    } else if (msg) {
      msg.textContent = r.error === "expired" ? t("Code expired, get a new one.") : t("Could not connect.");
    }
  });
  document.getElementById("sync-restore")?.addEventListener("click", async () => {
    const msg2 = document.getElementById("sync-msg2");
    if (msg2) msg2.textContent = t("Restoring…");
    const n = await sync.restore();
    await sync.push();
    if (msg2) msg2.textContent = n > 0 ? `${t("Restored")} ${n}` : t("Already up to date.");
    renderCare();
  });
  document.getElementById("sync-disconnect")?.addEventListener("click", () => { sync.disconnect(); renderSync(); });
  renderSync();
}
initSync();

// ---------------------------------------------------------------- agents ----
interface AgentInfo {
  kind: string;
  display_name: string;
  installed: boolean;
  note: string | null;
}

const agentsRoot = document.getElementById("agents")!;
let agentsCache: AgentInfo[] = [];

async function loadAgents() {
  agentsCache = await invoke<AgentInfo[]>("list_agents");
  renderAgents();
}

function renderAgents() {
  agentsRoot.innerHTML = "";
  for (const a of agentsCache) {
    const row = document.createElement("div");
    row.className = "agent-row";

    const meta = document.createElement("div");
    meta.className = "meta";
    // Codex needs a one-time trust after install (mac shows it in orange).
    const status = a.kind === "codex" && a.installed
      ? `<div class="note warn">${esc(t("Installed , needs a one-time trust (tap ?)"))}</div>`
      : a.note
      ? `<div class="note">${esc(t(a.note))}</div>`
      : a.installed
      ? `<div class="ok">${esc(t("Hook installed"))}</div>`
      : "";
    meta.innerHTML = `<div class="name">${esc(a.display_name)}</div>${status}`;
    row.appendChild(meta);

    if (a.kind === "codex") {
      const help = document.createElement("button");
      help.className = "help-btn";
      help.textContent = "?";
      help.title = t("How to connect Codex");
      help.onclick = () => { (document.getElementById("codex-help") as HTMLElement).hidden = false; };
      row.appendChild(help);
    }

    const btn = document.createElement("button");
    btn.textContent = a.installed ? t("Remove") : t("Install");
    if (a.installed) btn.classList.add("remove");
    btn.onclick = async () => {
      btn.disabled = true;
      try { await invoke("toggle_install", { kind: a.kind }); } catch (e) { alert(String(e)); }
      await loadAgents();
    };
    row.appendChild(btn);
    agentsRoot.appendChild(row);
  }
}

// ------------------------------------------------------------------ pet ----
// macOS model: the pager shows your INSTALLED pets (library); the full catalog
// lives in the Browse dialog where "Get" adds a pet to the library.
const current = document.getElementById("pet-current") as HTMLDivElement;
const search = document.getElementById("pet-search") as HTMLInputElement;
const results = document.getElementById("pet-results") as HTMLDivElement;

let catalog: Pet[] = [];

function selectedPet(): LibPet | undefined {
  const slug = savedSlug();
  return getLibrary().find((p) => p.slug === slug) ?? getLibrary()[0];
}

async function pick(p: LibPet) {
  saveSlug(p.slug);
  localStorage.setItem("ap_pet_url", p.url);
  localStorage.removeItem("ap_pet_custom"); // legacy key
  await emit("set-pet", { slug: p.slug, url: p.url });
  showCurrent();
  renderPage();
}

function showCurrent() {
  const sel = selectedPet();
  current.textContent = sel ? sel.name : t("No pet selected");
  const hero = document.getElementById("hero-thumb") as HTMLCanvasElement;
  if (sel) drawThumb(hero, sel.url);
  loadHeroDescription(sel);
}

// The pet's own description (from its pet.json on the CDN), like the macOS
// hero card; falls back to the generic caption.
async function loadHeroDescription(sel: LibPet | undefined) {
  const el = document.getElementById("hero-desc");
  if (!el) return;
  if (getLang() === "zh") { el.textContent = t("Your selected desktop companion."); return; }
  if (!sel?.petJsonUrl) { el.textContent = t("Pick the companion that floats on your desktop."); return; }
  try {
    const j: any = await (await fetch(sel.petJsonUrl)).json();
    const desc = (j.description || j.about || "").toString().trim();
    el.textContent = desc || t("Pick the companion that floats on your desktop.");
  } catch {
    el.textContent = t("Pick the companion that floats on your desktop.");
  }
}

// Pet pager , 8 per page (4 × 2) over the LIBRARY, hover ✕ to remove.
const PER_PAGE = 8;
let page = 0;

const pgPrev = document.getElementById("pg-prev") as HTMLButtonElement;
const pgNext = document.getElementById("pg-next") as HTMLButtonElement;
const pgInd = document.getElementById("pg-ind") as HTMLElement;

function libraryView(): LibPet[] {
  const q = search.value.trim().toLowerCase();
  const lib = getLibrary();
  return q ? lib.filter((p) => p.name.toLowerCase().includes(q)) : lib;
}

function renderPage() {
  const lib = getLibrary();
  (document.getElementById("pet-search-wrap") as HTMLElement).style.display = lib.length > 4 ? "" : "none"; // mac shows search only when >4
  (document.getElementById("lib-empty") as HTMLElement).hidden = lib.length > 0;
  const view = libraryView();
  const totalPages = Math.max(1, Math.ceil(view.length / PER_PAGE));
  if (page >= totalPages) page = totalPages - 1;
  results.innerHTML = "";
  for (const p of view.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)) {
    const item = document.createElement("button");
    item.className = "pet-item";
    item.dataset.slug = p.slug;
    if (p.slug === savedSlug()) item.classList.add("sel");
    const cv = document.createElement("canvas");
    cv.width = 48; cv.height = 48; cv.className = "pet-thumb";
    drawThumb(cv, p.url);
    const label = document.createElement("span");
    label.textContent = p.name;
    const del = document.createElement("span");
    del.className = "pet-del";
    del.textContent = "✕";
    del.title = t("Remove");
    del.onclick = (ev) => {
      ev.stopPropagation();
      removeFromLibrary(p.slug);
      if (p.slug === savedSlug()) {
        const next = getLibrary()[0];
        if (next) void pick(next);
      }
      showCurrent();
      renderPage();
    };
    item.appendChild(del);
    item.appendChild(cv);
    item.appendChild(label);
    item.onclick = () => pick(p);
    results.appendChild(item);
  }
  const pager = document.getElementById("pet-pager") as HTMLElement;
  pager.style.display = view.length > PER_PAGE ? "" : "none";
  pgPrev.disabled = page === 0;
  pgNext.disabled = page >= totalPages - 1;
  pgInd.innerHTML = "";
  if (totalPages <= 8) {
    for (let i = 0; i < totalPages; i++) {
      const d = document.createElement("span");
      d.className = "pg-dot" + (i === page ? " sel" : "");
      d.onclick = () => { page = i; renderPage(); };
      pgInd.appendChild(d);
    }
  } else {
    pgInd.textContent = `${page + 1} / ${totalPages}`;
  }
}
pgPrev.onclick = () => { if (page > 0) { page--; renderPage(); } };
pgNext.onclick = () => { page++; renderPage(); };

// Draws frame 0 (first column of the Idle row) of an 8x9 spritesheet as a preview.
function drawThumb(cv: HTMLCanvasElement, url: string) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const img = new Image();
  img.onload = () => {
    const fw = img.naturalWidth / 8, fh = img.naturalHeight / 9;
    if (!fw || !fh) return;
    const sc = Math.min(cv.width / fw, cv.height / fh);
    const dw = fw * sc, dh = fh * sc;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, fw, fh, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
  };
  img.src = url;
}

async function initPet() {
  search.addEventListener("input", () => { page = 0; renderPage(); });
  renderPage();
  showCurrent();
  initBrowse();
  initCreate();
  // Seed the library on first run: the currently shown pet (or the catalog
  // default) becomes the first installed pet, so the pager is never empty.
  for (;;) {
    catalog = await loadCatalog();
    if (catalog.length) break;
    current.textContent = t("Couldn't load pets , check your internet connection.");
    await new Promise((r) => setTimeout(r, 15000));
  }
  if (!getLibrary().length) {
    const slug = savedSlug();
    const c = catalog.find((p) => p.slug === slug) ?? catalog[Math.floor(catalog.length / 2)];
    if (c) {
      addToLibrary({ slug: c.slug, name: c.name, url: c.spritesheetUrl, petJsonUrl: c.petJsonUrl });
      if (!localStorage.getItem("ap_pet_url")) localStorage.setItem("ap_pet_url", c.spritesheetUrl);
    }
  }
  renderPage();
  showCurrent();
}

// -------------------------------------------------------------- browse ----
// The macOS BrowsePetsView: community pets first, Petdex shuffled, category
// segmented filter, search, Get/Added per row, lazy thumbnails.
interface RemotePet { slug: string; name: string; url: string; petJsonUrl?: string; kind: string; author: string; community: boolean }
let browseAll: RemotePet[] = [];
let bwCat = "all";
let bwShown = 0;
const BW_CHUNK = 60;

function initBrowse() {
  const modal = document.getElementById("browse-modal") as HTMLElement;
  const list = document.getElementById("bw-list") as HTMLElement;
  const status = document.getElementById("bw-status") as HTMLElement;
  const searchEl = document.getElementById("bw-search") as HTMLInputElement;

  (document.getElementById("open-browse") as HTMLButtonElement).onclick = async () => {
    modal.hidden = false;
    if (!browseAll.length) {
      status.style.display = "";
      status.textContent = t("Loading pets…");
      browseAll = await loadBrowseSources();
      if (!browseAll.length) {
        status.textContent = t("Couldn't load the pet library. Check your connection.");
        return;
      }
    }
    status.style.display = "none";
    repaint();
  };
  (document.getElementById("browse-done") as HTMLButtonElement).onclick = () => { modal.hidden = true; renderPage(); showCurrent(); };

  document.querySelectorAll<HTMLButtonElement>("#bw-cat button").forEach((b) => {
    b.onclick = () => {
      bwCat = b.dataset.v!;
      document.querySelectorAll("#bw-cat button").forEach((x) => x.classList.toggle("sel", x === b));
      repaint();
    };
  });
  searchEl.addEventListener("input", () => repaint());

  const thumbIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cv = e.target as HTMLCanvasElement;
      thumbIO.unobserve(cv);
      drawThumb(cv, cv.dataset.url!);
    }
  }, { root: list, rootMargin: "200px" });

  function filtered(): RemotePet[] {
    let v = browseAll;
    if (bwCat !== "all") v = v.filter((p) => p.kind === bwCat);
    const q = searchEl.value.trim().toLowerCase();
    if (q) v = v.filter((p) => p.name.toLowerCase().includes(q) || p.slug.includes(q));
    return v;
  }

  function repaint() {
    list.innerHTML = "";
    bwShown = 0;
    appendChunk();
  }

  function appendChunk() {
    const v = filtered();
    const installed = new Set(getLibrary().map((p) => p.slug));
    for (const p of v.slice(bwShown, bwShown + BW_CHUNK)) {
      const row = document.createElement("div");
      row.className = "bw-row";
      const cv = document.createElement("canvas");
      cv.width = 44; cv.height = 48; cv.className = "bw-thumb";
      cv.dataset.url = p.url;
      thumbIO.observe(cv);
      const meta = document.createElement("div");
      meta.className = "bw-meta";
      meta.innerHTML = `<span class="bw-name">${esc(p.name)}${p.community ? ` <span class="bw-badge">${t("Community")}</span>` : ""}</span>` +
        `<span class="cap">${t("by")} ${esc(p.author)}</span>`;
      const btn = document.createElement("button");
      if (installed.has(p.slug)) {
        btn.className = "bw-added";
        btn.textContent = `✓ ${t("Added")}`;
        btn.disabled = true;
      } else {
        btn.className = "mini";
        btn.textContent = t("Get");
        btn.onclick = () => {
          addToLibrary({ slug: p.slug, name: p.name, url: p.url, petJsonUrl: p.petJsonUrl });
          void pick({ slug: p.slug, name: p.name, url: p.url, petJsonUrl: p.petJsonUrl });
          btn.className = "bw-added";
          btn.textContent = `✓ ${t("Added")}`;
          btn.disabled = true;
        };
      }
      row.appendChild(cv);
      row.appendChild(meta);
      row.appendChild(btn);
      list.appendChild(row);
    }
    bwShown = Math.min(bwShown + BW_CHUNK, v.length);
  }

  list.addEventListener("scroll", () => {
    if (list.scrollTop + list.clientHeight > list.scrollHeight - 300) appendChunk();
  });
}

/// Community manifest first, Petdex library shuffled after, deduped by slug.
async function loadBrowseSources(): Promise<RemotePet[]> {
  const norm = (p: any, community: boolean): RemotePet | null => {
    if (!p?.slug || !p?.spritesheetUrl) return null;
    const author = (p.submittedBy || "").trim() || "community";
    return { slug: p.slug, name: p.displayName ?? p.slug, url: p.spritesheetUrl,
      petJsonUrl: p.petJsonUrl, kind: p.kind ?? "creature", author, community };
  };
  const fetchList = async (url: string, community: boolean): Promise<RemotePet[]> => {
    try {
      const j: any = await (await fetch(url)).json();
      return (j.pets ?? []).map((p: any) => norm(p, community)).filter(Boolean);
    } catch { return []; }
  };
  const [community, library] = await Promise.all([
    fetchList("https://agentpet.thenightwatcher.online/api/pets", true),
    fetchList("https://pets.thenightwatcher.online/manifest.json", false),
  ]);
  for (let i = library.length - 1; i > 0; i--) { // shuffle like macOS
    const j = Math.floor(Math.random() * (i + 1));
    [library[i], library[j]] = [library[j], library[i]];
  }
  const seen = new Set<string>();
  return [...community, ...library].filter((p) => seen.has(p.slug) ? false : (seen.add(p.slug), true));
}

// -------------------------------------------------------------- create ----
function initCreate() {
  const modal = document.getElementById("create-modal") as HTMLElement;
  const name = document.getElementById("cr-name") as HTMLInputElement;
  const desc = document.getElementById("cr-desc") as HTMLInputElement;
  const fileName = document.getElementById("cr-file-name") as HTMLElement;
  const err = document.getElementById("cr-error") as HTMLElement;
  const createBtn = document.getElementById("cr-create") as HTMLButtonElement;
  let dataUrl = "";

  const filePick = document.createElement("input");
  filePick.type = "file";
  filePick.accept = "image/png,image/webp,image/*";
  filePick.style.display = "none";
  document.body.appendChild(filePick);

  const sync = () => { createBtn.disabled = !(name.value.trim() && dataUrl); };
  name.addEventListener("input", sync);

  (document.getElementById("open-create") as HTMLButtonElement).onclick = () => {
    modal.hidden = false;
    name.value = ""; desc.value = ""; dataUrl = "";
    fileName.textContent = t("No image selected");
    err.hidden = true;
    sync();
  };
  (document.getElementById("create-cancel") as HTMLButtonElement).onclick = () => { modal.hidden = true; };
  (document.getElementById("cr-choose") as HTMLButtonElement).onclick = () => {
    filePick.onchange = () => {
      const f = filePick.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => { dataUrl = String(reader.result); fileName.textContent = f.name; err.hidden = true; sync(); };
        img.onerror = () => { err.textContent = t("Could not create this pet. Check that the image is a valid spritesheet."); err.hidden = false; };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(f);
      filePick.value = "";
    };
    filePick.click();
  };
  createBtn.onclick = () => {
    const slug = `local-${Date.now()}`;
    addToLibrary({ slug, name: name.value.trim(), url: dataUrl, custom: true });
    void pick({ slug, name: name.value.trim(), url: dataUrl, custom: true });
    modal.hidden = true;
    renderPage();
    showCurrent();
  };
}

// ---------------------------------------------------------------- bubble ----
const MSG_STATES: [string, string][] = [
  ["working", "Working"], ["waiting", "Needs you"], ["done", "Done"],
  ["celebrate", "Celebrate"], ["idle", "Idle"],
];
const MSG_AGENTS: [string, string][] = [
  ["all", "All agents"], ["claude", "Claude Code"], ["codex", "Codex"], ["gemini", "Gemini CLI"],
  ["cursor", "Cursor"], ["opencode", "opencode"], ["windsurf", "Windsurf"],
  ["antigravity", "Antigravity"], ["copilot", "GitHub Copilot"], ["kiro", "Kiro CLI"],
];

function initBubble() {
  const changed = () => { emit("bubble-changed", null); };
  const opacity = document.getElementById("opacity") as HTMLInputElement;
  const msgAgent = document.getElementById("msg-agent") as HTMLSelectElement;
  const editors = document.getElementById("msg-editors")!;

  opacity.value = localStorage.getItem("ap_opacity") || "92";
  opacity.oninput = () => {
    localStorage.setItem("ap_opacity", opacity.value);
    changed();
    document.dispatchEvent(new CustomEvent("seg-changed", { detail: "ap_opacity" }));
  };

  // Multi-agent bubble master toggle (mac BubbleSettings.multiAgentBubbleEnabled).
  const multi = document.getElementById("multi") as HTMLInputElement;
  multi.checked = localStorage.getItem("ap_multi") !== "0";
  multi.onchange = () => { localStorage.setItem("ap_multi", multi.checked ? "1" : "0"); changed(); };

  msgAgent.innerHTML = "";
  for (const [k, name] of MSG_AGENTS) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k === "all" ? t("All agents") : name; // brand names stay
    msgAgent.appendChild(o);
  }

  const build = (agent: string) => {
    editors.innerHTML = "";
    for (const [st, label] of MSG_STATES) {
      const wrap = document.createElement("div");
      wrap.className = "msg-editor";
      const lbl = document.createElement("div");
      lbl.className = "msg-label";
      lbl.dataset.label = label;
      lbl.textContent = t(label) + (st === "working" ? ` ${t("(blank = live activity)")}` : "");
      const ta = document.createElement("textarea");
      const key = `ap_msg_${agent}_${st}`;
      ta.value = localStorage.getItem(key) || "";
      ta.addEventListener("input", () => { localStorage.setItem(key, ta.value); changed(); });
      wrap.appendChild(lbl);
      wrap.appendChild(ta);
      editors.appendChild(wrap);
    }
  };
  msgAgent.onchange = () => build(msgAgent.value);
  build("all");

  // System/custom source (segmented, saved by initSegs) + reset.
  const customWrap = document.getElementById("msg-custom-wrap") as HTMLElement;
  const syncSrc = () => { customWrap.style.display = (localStorage.getItem("ap_msg_src") || "system") === "custom" ? "" : "none"; };
  syncSrc();
  document.addEventListener("seg-changed", (e) => { if ((e as CustomEvent).detail === "ap_msg_src") syncSrc(); });
  (document.getElementById("msg-reset") as HTMLButtonElement).onclick = () => {
    for (const [st] of MSG_STATES) localStorage.removeItem(`ap_msg_${msgAgent.value}_${st}`);
    build(msgAgent.value);
    changed();
  };

  const phrases = document.getElementById("phrases") as HTMLSelectElement;
  const savedTheme = localStorage.getItem("ap_theme_phrases") || "chef";
  phrases.value = savedTheme === "off" ? "chef" : savedTheme; // pre-port "off" → chef
  phrases.onchange = () => { localStorage.setItem("ap_theme_phrases", phrases.value); changed(); };

  const idle = document.getElementById("idle") as HTMLInputElement;
  idle.checked = localStorage.getItem("ap_idle") !== "0";
  idle.onchange = () => { localStorage.setItem("ap_idle", idle.checked ? "1" : "0"); changed(); };

  const reactive = document.getElementById("reactive") as HTMLInputElement;
  reactive.checked = localStorage.getItem("ap_reactive") !== "0";
  reactive.onchange = () => { localStorage.setItem("ap_reactive", reactive.checked ? "1" : "0"); changed(); };

  const split = document.getElementById("split") as HTMLInputElement;
  const splitList = document.getElementById("split-list") as HTMLElement;
  const renderSplitList = () => {
    splitList.style.display = split.checked ? "" : "none";
    splitList.innerHTML = "";
    if (!split.checked) return;
    const lib = getLibrary();
    const map = projectpets.projectPetMap();
    const projects = usage.knownProjects();
    if (!projects.length) {
      const p = document.createElement("div");
      p.className = "cap";
      p.textContent = t("No projects yet. Use an agent in a project first.");
      splitList.appendChild(p);
      return;
    }
    for (const proj of projects) {
      const row = document.createElement("label");
      row.className = "row";
      const name = document.createElement("span");
      name.className = "rt";
      name.textContent = proj.name;
      const sel = document.createElement("select");
      const none = document.createElement("option");
      none.value = "";
      none.textContent = t("Merged");
      sel.appendChild(none);
      for (const p of lib) {
        const o = document.createElement("option");
        o.value = p.slug;
        o.textContent = p.name;
        if (map[proj.id] === p.slug) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => { projectpets.setProjectPet(proj.id, sel.value); emit("split-changed"); };
      row.appendChild(name);
      row.appendChild(sel);
      splitList.appendChild(row);
    }
  };
  split.checked = projectpets.splitEnabled();
  split.onchange = () => { projectpets.setSplit(split.checked); renderSplitList(); emit("split-changed"); };
  renderSplitList();
}

// -------------------------------------------------- bubble display + layout ----
function initBubbleDisplay() {
  const changed = () => { emit("bubble-changed", null); };
  const bind = (id: string, key: string, dflt: string) => {
    const el = document.getElementById(id) as HTMLSelectElement;
    el.value = localStorage.getItem(key) || dflt;
    el.onchange = () => { localStorage.setItem(key, el.value); changed(); paintPreview(); };
  };
  bind("bub-filter", "ap_bub_filter", "all");

  // Detail captions + conditional rows, mirroring the macOS pickers.
  const MODE_DETAIL: Record<string, string> = {
    list: "Show every row at once, up to the max below.",
    carousel: "One row at a time. Auto-cycles every 3 s.",
    compact: "Summary header, first two rows, then fold the rest.",
  };
  const GROUP_DETAIL: Record<string, string> = {
    byKind: "One row per agent kind (×N when multiple)",
    all: "One row per session",
  };
  const syncDisplay = () => {
    const mode = localStorage.getItem("ap_bub_mode") || "carousel";
    const grouping = localStorage.getItem("ap_bub_grouping") || "byKind";
    (document.getElementById("bub-mode-detail") as HTMLElement).textContent = t(MODE_DETAIL[mode] ?? "");
    (document.getElementById("bub-grouping-detail") as HTMLElement).textContent = t(GROUP_DETAIL[grouping] ?? "");
    (document.getElementById("maxrows-row") as HTMLElement).style.display = mode === "carousel" ? "none" : "";
    (document.getElementById("sortkind-row") as HTMLElement).style.display = grouping === "all" ? "" : "none";
  };
  syncDisplay();
  const sortkind = document.getElementById("bub-sortkind") as HTMLInputElement;
  sortkind.checked = localStorage.getItem("ap_bub_sortkind") === "1";
  sortkind.onchange = () => { localStorage.setItem("ap_bub_sortkind", sortkind.checked ? "1" : "0"); changed(); };

  // Segmented controls (mode/grouping/sep/dot) save via initSegs; repaint the
  // preview row + captions when one changes.
  document.addEventListener("seg-changed", () => { paintPreview(); syncDisplay(); });

  const max = document.getElementById("bub-max") as HTMLInputElement;
  max.value = localStorage.getItem("ap_bub_max") || "5";
  max.oninput = () => { localStorage.setItem("ap_bub_max", max.value); changed(); };

  // Visible agents (hiddenKinds).
  const visRoot = document.getElementById("bub-visible")!;
  const hidden = new Set<string>(JSON.parse(localStorage.getItem("ap_bub_hidden") || "[]"));
  for (const [kind, name] of MSG_AGENTS.slice(1)) {
    const row = document.createElement("label");
    row.className = "row";
    const span = document.createElement("span");
    span.textContent = name;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !hidden.has(kind);
    box.onchange = () => {
      if (box.checked) hidden.delete(kind); else hidden.add(kind);
      localStorage.setItem("ap_bub_hidden", JSON.stringify([...hidden]));
      changed();
    };
    row.appendChild(span);
    row.appendChild(box);
    visRoot.appendChild(row);
  }

  // Row content: colored chips (mac PaletteChip/CanvasChip) , a palette row
  // of addable tokens and an active row with removable ones, in order.
  const tokensRoot = document.getElementById("bub-tokens")!;
  const paletteRoot = document.getElementById("bub-palette")!;
  const readTokens = (): TokenItem[] => readBubbleConfig().tokens;
  const saveTokens = (tokens: TokenItem[]) => {
    localStorage.setItem("ap_bub_tokens", JSON.stringify(tokens));
    changed();
    paintTokens();
    paintPreview();
  };
  const TOKEN_META: Record<BubbleToken, { name: string; sym: string; color: string }> = {
    dot:        { name: "Dot",     sym: "circle",     color: "#ff9f0a" },
    icon:       { name: "Icon",    sym: "sparkle",    color: "#bf5af2" },
    title:      { name: "Title",   sym: "quote",      color: "#0a84ff" },
    project:    { name: "Project", sym: "folder",     color: "#30d158" },
    separator:  { name: "Sep",     sym: "arrowRight", color: "#98989d" },
    message:    { name: "Message", sym: "message",    color: "#5e5ce6" },
    stateLabel: { name: "State",   sym: "tag",        color: "#ffd60a" },
    elapsed:    { name: "Elapsed", sym: "clock",      color: "#40c8e0" },
  };
  function chip(tokenItem: TokenItem, active: boolean): HTMLButtonElement {
    const m = TOKEN_META[tokenItem.token];
    const b = document.createElement("button");
    b.className = "tok-chip2";
    b.style.setProperty("--tc", m.color);
    b.innerHTML = `<span class="tc-sym">${uiIcon(m.sym)}</span> ${t(m.name)} <span class="tc-act">${active ? "✕" : "＋"}</span>`;
    b.onclick = () => {
      const tokens = readTokens().map((x) =>
        x.token === tokenItem.token ? { ...x, isVisible: !active } : x);
      saveTokens(tokens);
    };
    return b;
  }
  function paintTokens() {
    tokensRoot.innerHTML = "";
    paletteRoot.innerHTML = "";
    for (const item of readTokens()) {
      (item.isVisible ? tokensRoot : paletteRoot).appendChild(chip(item, item.isVisible));
    }
    paletteRoot.style.display = paletteRoot.childElementCount ? "" : "none";
  }
  document.querySelectorAll<HTMLButtonElement>(".preset-btns button").forEach((b) => {
    b.onclick = () => saveTokens(LAYOUT_PRESETS[b.dataset.preset!]);
  });

  // Mock preview row (mac BubbleRowPreview).
  const preview = document.getElementById("bub-preview")!;
  function paintPreview() {
    const cfg = readBubbleConfig();
    preview.innerHTML = "";
    const row = document.createElement("div");
    row.className = "pv-row";
    for (const item of cfg.tokens) {
      if (!item.isVisible) continue;
      switch (item.token) {
        case "dot": { const d = document.createElement("span"); d.className = "pv-dot"; row.appendChild(d); break; }
        case "icon": {
          const img = document.createElement("img");
          img.className = "aicon"; img.src = agentIconUrl("claude") || ""; row.appendChild(img); break;
        }
        case "title": { const s = document.createElement("span"); s.className = "pv-strong"; s.textContent = t("Fix login bug"); row.appendChild(s); break; }
        case "project": { const s = document.createElement("span"); s.className = "pv-strong"; s.textContent = "agentpet"; row.appendChild(s); break; }
        case "separator": { const s = document.createElement("span"); s.className = "pv-dim"; s.textContent = cfg.separator; row.appendChild(s); break; }
        case "message": { const s = document.createElement("span"); s.textContent = t("Editing SettingsModel.swift"); row.appendChild(s); break; }
        case "stateLabel": { const s = document.createElement("span"); s.className = "pv-dim"; s.textContent = t("Working"); row.appendChild(s); break; }
        case "elapsed": { const s = document.createElement("span"); s.className = "pv-dim"; s.textContent = `3${t("m")}`; row.appendChild(s); break; }
      }
    }
    if (!row.childElementCount) { row.textContent = t("(empty)"); row.classList.add("pv-dim"); }
    row.style.fontSize = `${parseInt(localStorage.getItem("ap_font_size") || "12", 10) || 12}px`;
    row.style.opacity = String((parseInt(localStorage.getItem("ap_opacity") || "92", 10) || 92) / 100);
    preview.appendChild(row);
    row.style.display = "inline-flex";
  }

  paintTokens();
  paintPreview();
}

// ----------------------------------------------- pet size / fx / import ----
function initPetControls() {
  const changed = () => { emit("bubble-changed", null); };
  const size = document.getElementById("pet-size") as HTMLInputElement;
  size.value = localStorage.getItem("ap_pet_size") || "100";
  size.oninput = () => { localStorage.setItem("ap_pet_size", size.value); changed(); };
  document.querySelectorAll<HTMLButtonElement>(".size-presets button").forEach((b) => {
    b.onclick = () => {
      size.value = b.dataset.size!;
      localStorage.setItem("ap_pet_size", size.value);
      size.dispatchEvent(new Event("input"));
      changed();
    };
  });


}

// ------------------------------------------------------------- agent icons ----
// Per-agent icon override (mac BubbleSettings.iconChoices): brand logo of any
// agent, or a symbol. Stored as ap_icon_<kind> = "brand:<kind>" | "emoji:<char>".
const ICON_SYMBOLS = ["terminal","zap","star","heart","cloud","moon","sun","anchor","box","code","command","compass","cpu","gift","globe","layers","target","rocket"];

export function iconChoiceLabel(kind: string): { type: "brand"; kind: string } | { type: "sym"; v: string } {
  const raw = localStorage.getItem(`ap_icon_${kind}`);
  if (raw?.startsWith("sym:")) return { type: "sym", v: raw.slice(4) };
  if (raw?.startsWith("brand:")) return { type: "brand", kind: raw.slice(6) };
  return { type: "brand", kind };
}

function iconCellHtml(kind: string): string {
  const c = iconChoiceLabel(kind);
  if (c.type === "sym") return `<span class="ic-sym">${uiIcon(c.v)}</span>`;
  const url = agentIconUrl(c.kind);
  return url ? `<img class="aicon" src="${url}">` : "";
}

function initAgentIcons() {
  const root = document.getElementById("agent-icons")!;
  const modal = document.getElementById("icon-modal") as HTMLElement;
  const brands = document.getElementById("ic-brands") as HTMLElement;
  const symbols = document.getElementById("ic-symbols") as HTMLElement;
  let editing = "claude";

  const paintRows = () => {
    root.innerHTML = "";
    for (const [kind, name] of MSG_AGENTS.slice(1)) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span class="ic-cur">${iconCellHtml(kind)} ${esc(name)}</span>`;
      const btn = document.createElement("button");
      btn.className = "mini";
      btn.textContent = t("Change…");
      btn.onclick = () => { editing = kind; openPicker(name); };
      row.appendChild(btn);
      root.appendChild(row);
    }
  };

  const paintPicker = () => {
    const cur = localStorage.getItem(`ap_icon_${editing}`) ?? `brand:${editing}`;
    brands.innerHTML = "";
    for (const [kind] of MSG_AGENTS.slice(1)) {
      const url = agentIconUrl(kind);
      if (!url) continue;
      const cell = document.createElement("button");
      cell.className = "icon-cell" + (cur === `brand:${kind}` ? " sel" : "");
      cell.innerHTML = `<img class="aicon" src="${url}">`;
      cell.onclick = () => { localStorage.setItem(`ap_icon_${editing}`, `brand:${kind}`); finish(); };
      brands.appendChild(cell);
    }
    symbols.innerHTML = "";
    for (const sym of ICON_SYMBOLS) {
      const cell = document.createElement("button");
      cell.className = "icon-cell ic-sym" + (cur === `sym:${sym}` ? " sel" : "");
      cell.innerHTML = uiIcon(sym);
      cell.onclick = () => { localStorage.setItem(`ap_icon_${editing}`, `sym:${sym}`); finish(); };
      symbols.appendChild(cell);
    }
  };

  const openPicker = (name: string) => {
    (document.getElementById("icon-modal-title") as HTMLElement).textContent = `${t("Icon for")} ${name}`;
    paintPicker();
    modal.hidden = false;
  };
  const finish = () => {
    modal.hidden = true;
    paintRows();
    emit("bubble-changed", null);
  };
  (document.getElementById("icon-done") as HTMLButtonElement).onclick = () => { modal.hidden = true; };
  (document.getElementById("icon-reset") as HTMLButtonElement).onclick = () => {
    localStorage.removeItem(`ap_icon_${editing}`);
    finish();
  };
  paintRows();
}

// ------------------------------------------------------------ animations ----
// The macOS AnimationPicker: a segmented mood selector over a grid of clip
// thumbnails sliced from the current pet's sheet. Hover = animated preview,
// click = bind that clip to the selected mood (ap_bind_<mood>).
const MOOD_DEFAULT_ROW: Record<string, number> = { idle: 0, working: 7, waiting: 6, done: 3, celebrate: 4 };

function initAnimations() {
  const grid = document.getElementById("anim-grid")!;
  const moodSeg = document.getElementById("anim-mood")!;
  let mood = "working";
  let img: HTMLImageElement | null = null;
  let clips: Rect[][] = [];
  let hoverTimer: number | null = null;

  const boundClip = (m: string) => {
    const v = parseInt(localStorage.getItem(`ap_bind_${m}`) ?? "", 10);
    return Number.isFinite(v) && v >= 0 ? Math.min(v, Math.max(0, clips.length - 1)) : Math.min(MOOD_DEFAULT_ROW[m] ?? 0, Math.max(0, clips.length - 1));
  };

  const drawFrame = (cv: HTMLCanvasElement, clip: Rect[], frame: number) => {
    const ctx = cv.getContext("2d");
    if (!ctx || !img || !clip.length) return;
    const r = clip[frame % clip.length];
    const maxW = Math.max(...clip.map((x) => x.w));
    const sc = Math.min(cv.width / maxW, cv.height / r.h);
    const dw = r.w * sc, dh = r.h * sc;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, r.x, r.y, r.w, r.h, (cv.width - dw) / 2, cv.height - dh, dw, dh);
  };

  const paint = () => {
    grid.innerHTML = "";
    if (!clips.length) return;
    const current = boundClip(mood);
    clips.forEach((clip, i) => {
      const cell = document.createElement("button");
      cell.className = "anim-cell" + (i === current ? " sel" : "");
      const cv = document.createElement("canvas");
      cv.width = 54; cv.height = 44;
      drawFrame(cv, clip, 0);
      const label = document.createElement("span");
      label.className = "cap";
      label.textContent = `${t("Clip")} ${i + 1}`;
      cell.appendChild(cv);
      cell.appendChild(label);
      cell.onclick = () => {
        localStorage.setItem(`ap_bind_${mood}`, String(i));
        emit("bubble-changed", null);
        paint();
      };
      // Hover = animate this clip (mac hover preview).
      cell.onmouseenter = () => {
        let f = 0;
        if (hoverTimer) clearInterval(hoverTimer);
        hoverTimer = window.setInterval(() => drawFrame(cv, clip, ++f), 125);
      };
      cell.onmouseleave = () => {
        if (hoverTimer) clearInterval(hoverTimer);
        hoverTimer = null;
        drawFrame(cv, clip, 0);
      };
      grid.appendChild(cell);
    });
  };

  moodSeg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.onclick = () => {
      mood = b.dataset.v!;
      moodSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b));
      paint();
    };
  });

  const loadSheet = () => {
    const lib = getLibrary();
    const sel = lib.find((x) => x.slug === savedSlug()) ?? lib[0];
    const url = localStorage.getItem("ap_pet_custom") || localStorage.getItem("ap_pet_url") || sel?.url;
    if (!url) { setTimeout(loadSheet, 3000); return; } // library may seed late
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => { img = im; clips = slice(im); paint(); };
    im.onerror = () => { img = null; clips = []; grid.innerHTML = ""; };
    im.src = url.startsWith("data:") ? url : url + (url.includes("?") ? "&" : "?") + "cors=1";
  };
  loadSheet();
  listen("set-pet", () => setTimeout(loadSheet, 50));
}

// ----------------------------------------------------------------- sounds ----
let settingsAudioCtx: AudioContext | null = null;
function playSound(ev: "done" | "waiting") {
  const data = localStorage.getItem(`ap_sound_${ev}_data`);
  if (data) {
    try { void new Audio(data).play(); return; } catch {}
  }
  try {
    settingsAudioCtx = settingsAudioCtx || new AudioContext();
    const o = settingsAudioCtx.createOscillator();
    const g = settingsAudioCtx.createGain();
    o.type = "sine";
    o.frequency.value = ev === "done" ? 880 : 560;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(settingsAudioCtx.destination);
    o.start();
    o.stop(settingsAudioCtx.currentTime + 0.13);
  } catch {}
}

function initSounds() {
  const filePick = document.createElement("input");
  filePick.type = "file";
  filePick.accept = "audio/*";
  filePick.style.display = "none";
  document.body.appendChild(filePick);

  const syncNames = () => {
    for (const ev of ["done", "waiting"] as const) {
      const name = localStorage.getItem(`ap_sound_${ev}_name`);
      (document.getElementById(`sound-${ev}-name`) as HTMLElement).textContent = name || t("Default");
      (document.getElementById(`t-df-${ev}`) as HTMLElement).style.display = name ? "" : "none";
    }
  };
  syncNames();

  document.querySelectorAll<HTMLButtonElement>(".sound-btns .mini").forEach((b) => {
    const ev = b.dataset.ev as "done" | "waiting";
    b.onclick = () => {
      switch (b.dataset.act) {
        case "play": playSound(ev); break;
        case "reset":
          localStorage.removeItem(`ap_sound_${ev}_data`);
          localStorage.removeItem(`ap_sound_${ev}_name`);
          syncNames();
          break;
        case "upload":
          filePick.onchange = () => {
            const f = filePick.files?.[0];
            if (!f) return;
            if (f.size > 2_000_000) { alert(t("Sound file too large (max 2 MB)")); return; }
            const reader = new FileReader();
            reader.onload = () => {
              localStorage.setItem(`ap_sound_${ev}_data`, String(reader.result));
              localStorage.setItem(`ap_sound_${ev}_name`, f.name);
              syncNames();
              playSound(ev); // preview, like macOS
            };
            reader.readAsDataURL(f);
            filePick.value = "";
          };
          filePick.click();
          break;
      }
    };
  });
}

// --------------------------------------------------------- notifications ----
function initNotify() {
  const box = document.getElementById("notify") as HTMLInputElement;
  box.checked = localStorage.getItem("ap_notify") !== "0";
  box.addEventListener("change", () => localStorage.setItem("ap_notify", box.checked ? "1" : "0"));
  // Per-event sound toggles (mac SoundSettings); legacy ap_sound seeds both.
  const legacyOff = localStorage.getItem("ap_sound") === "0";
  for (const ev of ["done", "waiting"] as const) {
    const el = document.getElementById(`sound-${ev}`) as HTMLInputElement;
    const key = `ap_sound_${ev}`;
    el.checked = (localStorage.getItem(key) ?? (legacyOff ? "0" : "1")) !== "0";
    el.addEventListener("change", () => localStorage.setItem(key, el.checked ? "1" : "0"));
  }
  (document.getElementById("codex-help-close") as HTMLButtonElement).onclick = () => {
    (document.getElementById("codex-help") as HTMLElement).hidden = true;
  };
}

// --------------------------------------------------------------- startup ----
async function initAutostart() {
  const box = document.getElementById("autostart") as HTMLInputElement;
  try { box.checked = await isEnabled(); } catch {}
  box.addEventListener("change", async () => {
    try { box.checked ? await enable() : await disable(); } catch (e) { alert(String(e)); }
  });
}

// ----------------------------------------------------------------- i18n ----
function applyStatic() {
  document.documentElement.lang = getLang();
  const set = (id: string, key: string) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  // tabs
  set("tab-general", "General");
  set("tab-pet", "Pet");
  set("tab-care", "Care");
  set("tab-bubble", "Bubble");
  set("tab-history", "History");
  set("tab-about", "About");
  // general
  set("t-lang", "Language");
  set("t-lang2", "Language");
  set("t-startup", "Launch");
  set("t-autostart", "Launch at login");
  set("t-autostart-sub", "AgentPet starts automatically when you sign in.");
  set("t-notif", "Notifications");
  set("t-notify", "Notifications on");
  set("t-notify-sub", "Alerts when an agent finishes or needs input");
  set("t-sounds", "Sounds");
  set("t-sound-done", "When an agent finishes");
  set("t-sound-waiting", "When an agent needs input");
  set("t-up-done", "Upload…");
  set("t-up-waiting", "Upload…");
  set("t-df-done", "Default");
  set("t-df-waiting", "Default");
  set("t-agents", "Agent integrations");
  set("t-app", "About");
  set("t-version", "Version");
  set("quit-btn", "Quit AgentPet");
  // pet
  set("t-pet-sub", "Pick the companion that floats on your desktop.");
  set("t-choose", "Choose pet");
  set("t-lib-empty", "No pets yet. Tap Browse to add one.");
  set("t-browse", "Browse pets…");
  set("t-create", "Create pet…");
  set("t-bw-title", "Browse pets");
  set("browse-done", "Done");
  set("t-bw-all", "All");
  set("t-bw-char", "Characters");
  set("t-bw-crea", "Creatures");
  set("t-bw-obj", "Objects");
  set("t-cr-title", "Create pet");
  set("create-cancel", "Cancel");
  set("t-cr-name", "Name");
  set("t-cr-desc", "Description");
  set("t-cr-sheet", "Spritesheet");
  set("t-cr-hint", "Use the same 8×9 transparent spritesheet format as downloaded pets.");
  set("cr-create", "Create");
  set("cr-choose", "Choose image…");
  set("t-size", "Size on screen");
  set("t-anims", "Animations");
  set("t-anim-hint", "Hover a clip to preview it.");
  set("am-idle", "Idle");
  set("am-working", "Working");
  set("am-waiting", "Waiting");
  set("am-done", "Done");
  set("am-celebrate", "Celebrate");
  // care + profile sync
  set("t-care-head", "Your companion");
  set("t-care-ach", "Achievements");
  set("t-care-today", "Today");
  set("t-care-streak", "Streak");
  set("t-care-streak-sub", "days fed");
  set("t-care-lifetime", "Counted toward pet XP");
  set("t-care-lifetime-sub", "feeding tokens counted");
  set("t-care-sessions", "Sessions");
  set("t-care-sessions-sub", "completed");
  set("t-care-cost", "Est. cost (Claude)");
  set("t-care-burn", "Burn, last 7 days");
  set("t-care-help", "Your pet eats the real tokens your agents burn and the sessions they finish. Feeding earns XP; it levels up through five stages.");
  // Official account usage and local Codex ledger. These are read-only totals;
  // only the companion card above controls pet XP.
  set("t-codex-account", "Codex official account");
  set("t-codex-lifetime", "Account total");
  set("t-codex-lifetime-sub", "tokens reported by Codex");
  set("t-codex-peak", "Daily peak");
  set("t-codex-peak-sub", "tokens in one day");
  set("t-codex-longest", "Longest task");
  set("t-codex-longest-sub", "longest running turn");
  set("t-codex-streak", "Current streak");
  set("t-codex-quota", "Official usage window");
  set("codex-account-status", "Loading official usage…");
  set("codex-account-message", "Official usage is temporarily unavailable.");
  set("t-local-codex", "Local Codex records");
  set("t-local-gross", "Total including cache");
  set("t-local-gross-sub", "input including cache and output");
  set("t-local-effective", "Effective tokens");
  set("t-local-effective-sub", "uncached input and output");
  set("t-local-sessions", "Sessions found");
  set("t-local-coverage", "Coverage");
  set("local-codex-coverage-sub", "first to latest event");
  set("local-codex-status", "Reading local records…");
  set("local-codex-message", "The first scan may take a while and runs in the background.");
  set("t-webprofile", "Web profile");
  set("t-sync-desc", "Show your companions on your web profile and the leaderboard.");
  set("t-sync-signin", "Sign in with GitHub");
  set("t-sync-connect", "Connect");
  set("t-sync-restore", "Restore");
  set("t-sync-disc", "Disconnect");
  set("t-sync-help", "Fully optional. Everything works offline; connecting only adds the profile and leaderboard.");
  const careName = document.getElementById("care-name");
  if (careName) careName.title = t("Click to rename");
  // bubble
  set("t-appearance", "Appearance");
  set("t-theme", "Theme");
  set("t-opacity", "Opacity");
  set("t-fontsize", "Text size");
  set("o-dark", "Dark");
  set("o-light", "Light");
  set("o-theme-system", "System");
  set("t-idle", "Show idle message");
  set("t-idle-sub", "The pet's chatter while no agent is running.");
  set("t-reactive", "Reactive comments");
  set("t-reactive-sub", "The pet reacts to token usage, streaks, hunger, and busy sessions.");
  set("t-split", "Split pets by project");
  set("t-split-sub", "Give a project its own pet window; the rest stay on the main pet.");
  set("t-display", "Display");
  set("t-rows", "Rows");
  set("o-bm-list", "All rows");
  set("o-bm-carousel", "Carousel");
  set("o-bm-compact", "Compact");
  set("t-grouping", "Sessions");
  set("o-bg-kind", "Grouped by agent");
  set("o-bg-all", "All sessions");
  set("t-maxrows", "Max rows");
  set("t-filter", "Include states");
  set("o-bf-all", "All states");
  set("o-bf-done", "Done and above");
  set("o-bf-ww", "Working & Waiting");
  set("o-bf-w", "Working only");
  set("t-visible", "Visible agents");
  set("t-rowcontent", "Row content");
  set("t-presets", "Presets");
  set("t-preview-cap", "Preview");
  set("t-vocab-foot", "Whimsical phrases shown while agents work, e.g. \"Brewing…\" or \"Compiling…\".");
  set("t-msg-foot", "Per-agent overrides win over \"All agents\". A custom line replaces the live/theme text and the real pet honours it.");
  set("t-pr-original", "Original");
  set("t-pr-standard", "Standard");
  set("t-pr-detailed", "Detailed");
  set("t-agenticons", "Agent icons");
  set("t-sortkind", "Sort by agent kind");
  set("t-ic-brand", "Brand logos");
  set("t-ic-sym", "Symbols");
  set("icon-reset", "Reset to default");
  set("icon-done", "Done");
  set("t-style", "Style");
  set("t-separator", "Separator");
  set("o-sep-space", "space");
  set("t-dotstyle", "State dot");
  set("o-dot-plain", "Plain dot");
  set("o-dot-claude", "Claude style");
  set("t-activity", "Activity messages");
  set("t-phrases", "Vocabulary");
  set("t-messages", "Bubble messages");
  set("t-msg-src", "Messages");
  set("o-ms-system", "System");
  set("o-ms-custom", "Custom");
  set("msg-reset", "Reset to defaults");
  set("t-msg-help", "One message per line; a random one is shown.");
  set("t-msg-agent", "Agent");
  const phraseOptions: Array<[string, string, string]> = [
    ["o-ph-chef", "👨‍🍳", "Chef"],
    ["o-ph-engineer", "⚙️", "Engineer"],
    ["o-ph-wizard", "🧙", "Wizard"],
    ["o-ph-explorer", "🧭", "Explorer"],
    ["o-ph-scientist", "🔬", "Scientist"],
  ];
  for (const [id, icon, key] of phraseOptions) {
    const el = document.getElementById(id);
    if (el) el.textContent = `${icon} ${t(key)}`;
  }
  // history
  set("t-history", "Session history");
  set("history-empty", "No finished sessions yet. Run an agent and they'll appear here.");
  // codex help
  set("t-cdx-title", "How to connect Codex");
  set("t-cdx-1", "Install the hook here (it also enables hooks in Codex's config.toml).");
  set("t-cdx-2", "Open Codex CLI and run /hooks.");
  set("t-cdx-3", "Press t to Trust the AgentPet hook.");
  set("t-cdx-4", "Quit and reopen Codex (both the CLI and the desktop app).");
  const allOpt = document.querySelector<HTMLOptionElement>('#msg-agent option[value="all"]');
  if (allOpt) allOpt.textContent = t("All agents");
  document.querySelectorAll<HTMLElement>(".msg-label").forEach((el) => {
    if (el.dataset.label) el.textContent = t(el.dataset.label);
  });
  // about
  set("t-tagline", "A desktop pet that watches your AI coding agents.");
  set("t-star", "Star on GitHub");
  set("t-discord", "Join the Discord");
  set("t-coffee", "Buy me a coffee");
  set("t-author", "Author");
  set("t-version2", "Version");
  // bottom bar + demo panel
  set("t-lp", "Live preview");
  set("t-preview-sub", "Fire webhooks for many agents with your current settings");
  set("t-dp-title", "Live preview");
  set("t-dp-quick", "Quick scenarios");
  set("t-dp-active", "Active webhooks");
  set("t-dp-add", "Add webhook");
  set("t-dp-hint", "Add agents here, then change each webhook's state or delete it in the list on the left.");
  set("dp-spawn", "Spawn 3 working");
  set("dp-finish", "Finish all");
  set("dp-clear", "Clear all");
  set("dp-empty", "No webhooks yet. Add one from the right →");
  set("t-bubmode", "Bubble mode");
  set("t-multi", "Multi-agent bubble");
  set("t-multi-sub", "Structured rows with icons, state dots, and activity messages.");
  set("t-thanks", "If AgentPet helps your workflow, a star means a lot. Thank you!");
  set("t-fontsize", "Font size");
  search.placeholder = t("Search your pets");
  (document.getElementById("bw-search") as HTMLInputElement).placeholder = t("Search pets");
}

// ------------------------------------------------- version / quit / links ----
function initMisc() {
  getVersion().then((v) => {
    const a = document.getElementById("app-version");
    const b = document.getElementById("app-version2");
    if (a) a.textContent = v;
    if (b) b.textContent = v;
  }).catch(() => {});
  (document.getElementById("quit-btn") as HTMLButtonElement).onclick = () => { exit(0); };
  document.querySelectorAll<HTMLElement>("[data-url]").forEach((el) => {
    el.addEventListener("click", () => invoke("open_url", { url: el.dataset.url }).catch(() => {}));
  });
}

function initLang() {
  const sel = document.getElementById("lang") as HTMLSelectElement;
  sel.value = getLang();
  applyStatic();
  // Tell the tray (Rust) + the pet window about the initial language too.
  invoke("set_lang", { code: getLang() }).catch(() => {});
  sel.addEventListener("change", async () => {
    setLang(sel.value as Lang);
    applyStatic();
    renderAgents();
    showCurrent();
    renderCare();
    renderSync();
    renderHistory();
    invoke("set_lang", { code: getLang() }).catch(() => {});
    await emit("lang-changed", getLang());
    // Some settings controls are built by closures during startup. Reloading
    // recreates every preview and option in the new language without adding a
    // second copy of their event handlers.
    window.location.reload();
  });
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
}

// Paint the filled-left part of every slider (drives the --fill CSS variable)
// and the numeric value label next to it.
function initSliders() {
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((r) => {
    const val = document.getElementById(`${r.id}-val`);
    const paint = () => {
      const min = Number(r.min) || 0;
      const max = Number(r.max) || 100;
      const pct = ((Number(r.value) - min) / (max - min)) * 100;
      r.style.setProperty("--fill", `${pct}%`);
      if (val) val.textContent = r.value + (r.id === "opacity" ? "%" : "");
    };
    r.addEventListener("input", paint);
    paint();
  });
}

initTabs();
initLang();
loadAgents();
initPet();
initPetControls();
initBubble();
initBubbleDisplay();
initAgentIcons();
initAnimations();
initSounds();
initNotify();
initAutostart();
initSliders();
initSegs();
initMisc();
initDemo();
