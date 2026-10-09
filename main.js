"use strict";
/* «Proton» — десктопный браузер (Electron).
   Главный процесс: окно + встроенный поисковый движок, система вкладок,
   подсказки, Википедия, мгновенные ответы, настройки и проверка обновлений через GitHub Releases.
   Текущая версия: 2.8.0 (Вкладки, черный лаконичный стиль OLED, стили оформления) */

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");

app.setName("Proton");

const APP_VERSION = "2.8.0";
const GITHUB_REPO = "UsmanMusav/Iskatel";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const NAV_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
  "Referer": "https://html.duckduckgo.com/",
};

const JSON_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
  "Referer": "https://duckduckgo.com/",
  "X-Requested-With": "XMLHttpRequest",
};


/* ---------- система аккаунтов, профилей и Gmail-авторизации (v2.5) ---------- */

function getAccountsPath() {
  return path.join(app.getPath("userData"), "accounts.json");
}

function getSessionPath() {
  return path.join(app.getPath("userData"), "session.json");
}

function loadAccounts() {
  try {
    const p = getAccountsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) || [];
    }
  } catch (_) {}
  return [];
}

function saveAccounts(accounts) {
  try {
    const p = getAccountsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(accounts, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("Ошибка сохранения аккаунтов:", err);
    return false;
  }
}

function loadSession() {
  try {
    const p = getSessionPath();
    if (fs.existsSync(p)) {
      const sess = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (sess && sess.userId) {
        const accounts = loadAccounts();
        const user = accounts.find((a) => a.id === sess.userId);
        if (user) {
          const { passwordHash, ...safeUser } = user;
          return safeUser;
        }
      }
    }
  } catch (_) {}
  return null;
}

function saveSession(userId) {
  try {
    const p = getSessionPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (userId) {
      fs.writeFileSync(p, JSON.stringify({ userId, loginAt: Date.now() }, null, 2), "utf-8");
    } else {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "") + "iskatel_salt_2026").digest("hex");
}

function registerAccount({ name, email, password }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanName = String(name || "").trim() || cleanEmail.split("@")[0];
  const pass = String(password || "");

  if (!cleanEmail || !cleanEmail.includes("@")) {
    return { ok: false, error: "Укажите корректный адрес электронной почты (Gmail)." };
  }
  if (pass.length < 6) {
    return { ok: false, error: "Пароль должен содержать не менее 6 символов." };
  }

  const accounts = loadAccounts();
  const exists = accounts.find((a) => a.email.toLowerCase() === cleanEmail);
  if (exists) {
    return { ok: false, error: "Аккаунт с таким email уже зарегистрирован. Войдите в него." };
  }

  const isGmail = cleanEmail.endsWith("@gmail.com");
  const newUser = {
    id: "usr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    name: cleanName,
    email: cleanEmail,
    provider: isGmail ? "gmail" : "email",
    passwordHash: hashPassword(pass),
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
    bookmarks: [],
    history: [],
  };

  accounts.push(newUser);
  saveAccounts(accounts);
  saveSession(newUser.id);

  const { passwordHash, ...safeUser } = newUser;
  return { ok: true, user: safeUser };
}

function loginAccount({ email, password }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const pass = String(password || "");

  if (!cleanEmail || !pass) {
    return { ok: false, error: "Введите email и пароль." };
  }

  const accounts = loadAccounts();
  const user = accounts.find((a) => a.email.toLowerCase() === cleanEmail);
  if (!user) {
    return { ok: false, error: "Аккаунт с таким email не найден." };
  }

  if (user.passwordHash !== hashPassword(pass)) {
    return { ok: false, error: "Неверный пароль. Попробуйте снова." };
  }

  user.lastLoginAt = Date.now();
  saveAccounts(accounts);
  saveSession(user.id);

  const { passwordHash, ...safeUser } = user;
  return { ok: true, user: safeUser };
}

function googleSignIn({ email, name, avatar }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    return { ok: false, error: "Некорректный аккаунт Google." };
  }

  const accounts = loadAccounts();
  let user = accounts.find((a) => a.email.toLowerCase() === cleanEmail);

  if (!user) {
    // Автоматическая регистрация через Google/Gmail
    user = {
      id: "usr_g_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name: name || cleanEmail.split("@")[0],
      email: cleanEmail,
      avatar: avatar || "",
      provider: "google",
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      bookmarks: [],
      history: [],
    };
    accounts.push(user);
  } else {
    user.lastLoginAt = Date.now();
    if (name) user.name = name;
    if (avatar) user.avatar = avatar;
    user.provider = "google";
  }

  saveAccounts(accounts);
  saveSession(user.id);

  const { passwordHash, ...safeUser } = user;
  return { ok: true, user: safeUser };
}

function addBookmarkForUser(bookmark) {
  const session = loadSession();
  if (!session) return { ok: false, error: "Требуется авторизация" };

  const accounts = loadAccounts();
  const user = accounts.find((a) => a.id === session.id);
  if (!user) return { ok: false, error: "Пользователь не найден" };

  if (!user.bookmarks) user.bookmarks = [];
  const bm = {
    id: "bm_" + Date.now(),
    title: bookmark.title || bookmark.url,
    url: bookmark.url,
    domain: bookmark.domain || "",
    addedAt: Date.now(),
  };

  // Проверяем дубликат
  user.bookmarks = user.bookmarks.filter((b) => b.url !== bm.url);
  user.bookmarks.unshift(bm);
  saveAccounts(accounts);

  return { ok: true, bookmarks: user.bookmarks };
}

function removeBookmarkForUser(id) {
  const session = loadSession();
  if (!session) return { ok: false, error: "Требуется авторизация" };

  const accounts = loadAccounts();
  const user = accounts.find((a) => a.id === session.id);
  if (!user || !user.bookmarks) return { ok: true, bookmarks: [] };

  user.bookmarks = user.bookmarks.filter((b) => b.id !== id);
  saveAccounts(accounts);

  return { ok: true, bookmarks: user.bookmarks };
}

function recordSearchHistory(query) {
  try {
    const session = loadSession();
    if (!session) return;
    const accounts = loadAccounts();
    const user = accounts.find((a) => a.id === session.id);
    if (!user) return;
    if (!user.history) user.history = [];
    user.history = user.history.filter((h) => h.query.toLowerCase() !== query.toLowerCase());
    user.history.unshift({ query, date: Date.now() });
    if (user.history.length > 100) user.history = user.history.slice(0, 100);
    saveAccounts(accounts);
  } catch (_) {}
}

/* ---------- настройки пользователя ---------- */

const DEFAULT_SETTINGS = {
  engine: "auto", // "auto", "duckduckgo", "bing"
  region: "ru-ru", // "ru-ru", "wt-wt", "us-en", "de-de", "kz-kz"
  theme: "system", // "light", "dark", "system"
  accentColor: "indigo", // "indigo", "emerald", "cyan", "orange", "ruby", "amber", "monochrome"
  ambientBlobs: true,
  glassmorphism: true,
  fontSize: "medium", // "small", "medium", "large"
  density: "normal", // "normal", "compact"
  showWikiCards: true,
  showInstantAnswers: true,
  showSuggestions: true,
  showRelatedQueries: true,
  autoCheckUpdates: true,
  openInBrowser: true,
};

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...data };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(newSettings) {
  try {
    const p = getSettingsPath();
    const current = loadSettings();
    const updated = { ...current, ...(newSettings || {}) };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(updated, null, 2), "utf-8");
    return { ok: true, settings: updated };
  } catch (err) {
    console.error("Ошибка сохранения настроек:", err);
    return { ok: false, error: err.message };
  }
}

/* ---------- утилиты текста ---------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function richText(html) {
  if (!html) return "";
  let s = String(html)
    .replace(/<b>/gi, "\x00").replace(/<\/b>/gi, "\x01")
    .replace(/<strong>/gi, "\x00").replace(/<\/strong>/gi, "\x01");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#0*39;|&#0*27;/gi, "'");
  s = escapeHtml(s);
  return s.replace(/\x00/g, "<mark>").replace(/\x01/g, "</mark>").trim();
}

function decodeDdgHref(href) {
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const u = new URL(href);
    if (u.hostname.endsWith("duckduckgo.com") && u.searchParams.get("uddg")) {
      return u.searchParams.get("uddg");
    }
  } catch (_) {}
  return href;
}

function decodeBingHref(href) {
  if (!href.includes("bing.com/ck/a")) return href;
  try {
    const u = new URL(href, "https://www.bing.com");
    let raw = u.searchParams.get("u") || "";
    if (raw.startsWith("a1")) {
      raw = raw.slice(2).replace(/=+$/, "");
      const dec = Buffer.from(raw, "base64url").toString("utf8");
      if (dec.startsWith("http")) return dec;
    }
  } catch (_) {}
  return href;
}

function displayUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).slice(0, 3);
    const text = u.hostname + (parts.length ? "/" + parts.join("/") : "");
    return escapeHtml(decodeURIComponent(text).slice(0, 72));
  } catch (_) {
    return escapeHtml(url.slice(0, 72));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- кэш ---------- */

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.t < CACHE_TTL) return item.v;
  return null;
}

function cacheSet(key, v) {
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
}

/* ---------- DuckDuckGo ---------- */

async function ddgSearch(query, page, region = "ru-ru") {
  const offset = page * 10;
  const attempts = ["post", "get", "get"];
  let resp = null;
  const kl = region || "ru-ru";
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await sleep(1200 * i);
    const url = "https://html.duckduckgo.com/html/";
    if (attempts[i] === "post") {
      const body = new URLSearchParams({ q: query, kl: kl, s: String(offset), b: "" });
      resp = await fetch(url, {
        method: "POST",
        headers: { ...NAV_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } else {
      resp = await fetch(`${url}?q=${encodeURIComponent(query)}&kl=${kl}&s=${offset}`, {
        headers: NAV_HEADERS,
      });
    }
    if (resp.ok) break;
  }
  if (!resp || !resp.ok || resp.status === 202) {
    throw new Error(`DuckDuckGo: HTTP ${resp ? resp.status : "0"}`);
  }

  const html = await resp.text();
  if (html.includes("anomaly-modal") || html.includes("challenge-running")) {
    throw new Error("Поисковый движок временно ограничил запросы.");
  }

  const results = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [...html.matchAll(linkRe)];
  const snips = [...html.matchAll(snipRe)];

  for (let i = 0; i < links.length; i++) {
    const url = decodeDdgHref(links[i][1]);
    if (url.includes("duckduckgo.com/y.js")) continue; // реклама
    results.push({
      title: richText(links[i][2]),
      url,
      display_url: displayUrl(url),
      snippet: snips[i] ? richText(snips[i][1]) : "",
    });
  }
  if (results.length === 0) {
    throw new Error("DuckDuckGo вернул пустую страницу выдачи.");
  }
  return results;
}

async function ddgSuggest(query) {
  try {
    const r = await fetch(
      `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`,
      { headers: JSON_HEADERS }
    );
    const data = await r.json();
    let out = [];
    if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
      out = data.map((d) => d.phrase).filter(Boolean);
    } else if (Array.isArray(data) && Array.isArray(data[1])) {
      out = data[1].filter((s) => typeof s === "string");
    }
    return out.slice(0, 8);
  } catch (_) {
    return [];
  }
}

async function ddgInstant(query) {
  try {
    const r = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": USER_AGENT, "Accept": "*/*" } }
    );
    const d = await r.json();
    const out = {};
    if (d.Answer) out.answer = String(d.Answer).replace(/<[^>]+>/g, "");
    if (d.AnswerURL) out.answer_source = d.AnswerURL;
    if (d.AbstractText) {
      out.abstract = d.AbstractText;
      out.source = d.AbstractSource || "";
      out.source_url = d.AbstractURL || "";
      if (d.Image) out.image = d.Image;
    } else if (d.Definition) {
      out.definition = d.Definition;
      out.definition_source = d.DefinitionSource || "";
      out.definition_url = d.DefinitionURL || "";
    }
    return out;
  } catch (_) {
    return {};
  }
}

/* ---------- Bing (резервный движок) ---------- */

async function bingSearch(query, page, region = "ru-RU") {
  const r = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${page * 10 + 1}&setlang=ru&mkt=${region}&cc=RU`,
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
    }
  );
  if (!r.ok) throw new Error(`Bing: HTTP ${r.status}`);
  const html = await r.text();

  const results = [];
  const chunks = html.split(/class="b_algo"/).slice(1);
  for (const chunk of chunks) {
    const a = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeBingHref(a[1]);
    if (!url.startsWith("http")) continue;
    const snip = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title: richText(a[2]),
      url,
      display_url: displayUrl(url),
      snippet: snip ? richText(snip[1]) : "",
    });
    if (results.length >= 10) break;
  }
  if (!results.length) throw new Error("Резервный движок не вернул результатов");
  return results;
}

/* ---------- Википедия ---------- */

const WIKI_PARAMS = {
  action: "query", format: "json",
  prop: "extracts|pageimages|info",
  exintro: 1, explaintext: 1, exsentences: 3,
  piprop: "thumbnail", pithumbsize: 240,
  inprop: "url",
};

async function wikiApi(params) {
  const u = new URL("https://ru.wikipedia.org/w/api.php");
  for (const [k, v] of Object.entries({ ...WIKI_PARAMS, ...params })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "User-Agent": USER_AGENT } });
  return (await r.json()).query?.pages || {};
}

function wikiCardFromPage(page) {
  if (!page || page.missing !== undefined) return {};
  const extract = (page.extract || "").trim();
  if (extract.length < 80) return {};
  const card = {
    title: page.title || "",
    text: extract,
    url: page.fullurl || `https://ru.wikipedia.org/wiki/${encodeURIComponent(page.title || "")}`,
    source: "Википедия",
  };
  if (page.thumbnail?.source) card.image = page.thumbnail.source;
  return card;
}

async function wikiByTitle(title) {
  try {
    const pages = await wikiApi({ titles: title });
    for (const page of Object.values(pages)) {
      const card = wikiCardFromPage(page);
      if (card.title) return card;
    }
  } catch (_) {}
  return {};
}

async function wikiFromResults(results) {
  for (const r of results.slice(0, 5)) {
    const m = r.url.match(/^https?:\/\/ru\.wikipedia\.org\/wiki\/([^#?]+)/);
    if (!m) continue;
    const title = decodeURIComponent(m[1]).replace(/_/g, " ");
    const card = await wikiByTitle(title);
    if (card.title) return card;
  }
  return {};
}

async function wikiCard(query) {
  try {
    const pages = await wikiApi({ generator: "search", gsrsearch: query, gsrlimit: 5 });
    const stop = new Set([
      "какая", "какой", "какие", "каких", "каким", "когда", "почему", "зачем",
      "где", "чего", "кому", "это", "этот", "эта", "эти", "или", "для", "при",
      "про", "что", "такое", "такой", "такая", "такие", "надо", "нужно",
      "можно", "быть", "был", "есть", "нет", "мой", "наш", "ваш", "кто",
    ]);
    const words = (query.toLowerCase().match(/[a-zа-яё]{4,}/g) || []).filter((w) => !stop.has(w));
    const stems = new Set(words.map((w) => w.slice(0, 4)));
    const n = stems.size;
    if (!n) return {};
    const need = n <= 2 ? 1 : 2;

    let best = null, bestScore = 0;
    for (const page of Object.values(pages)) {
      const extract = (page.extract || "").trim();
      if (extract.length < 80) continue;
      const title = (page.title || "").toLowerCase();
      let score = 0;
      for (const s of stems) if (title.includes(s)) score += 1;
      if (!score) {
        const first = extract.slice(0, 160).toLowerCase();
        for (const s of stems) if (first.includes(s)) score += 0.5;
      }
      if (score < need) continue;
      const better = score > bestScore ||
        (score === bestScore && best && title.length < (best.title || "").toLowerCase().length);
      if (better) { best = page; bestScore = score; }
    }
    return best ? wikiCardFromPage(best) : {};
  } catch (_) {
    return {};
  }
}

/* ---------- сборка ответа поиска ---------- */

async function doSearch({ q, page = 0 }) {
  const query = String(q || "").trim();
  if (!query) return { error: "Пустой запрос" };
  page = Math.max(0, parseInt(page, 10) || 0);

  const settings = loadSettings();
  const region = settings.region || "ru-ru";
  const preferredEngine = settings.engine || "auto";

  const key = `s:${query.toLowerCase()}:${page}:${region}:${preferredEngine}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const started = Date.now();
  let results = [];
  let engineUsed = "Умный гибрид";

  // Функция гарантированного поиска с переходом на резервные движки
  if (preferredEngine === "bing") {
    try {
      results = await bingSearch(query, page, region);
      engineUsed = "Bing";
    } catch (e1) {
      try {
        results = await ddgSearch(query, page, region);
        engineUsed = "DuckDuckGo (резерв)";
      } catch (e2) {}
    }
  } else if (preferredEngine === "duckduckgo") {
    try {
      results = await ddgSearch(query, page, region);
      engineUsed = "DuckDuckGo";
    } catch (e1) {
      try {
        results = await bingSearch(query, page, region);
        engineUsed = "Bing (резерв)";
      } catch (e2) {}
    }
  } else {
    // "auto" (гибридный): пробуем сначала DuckDuckGo, если 0 результатов или ошибка — мгновенно Bing
    try {
      results = await ddgSearch(query, page, region);
      engineUsed = "DuckDuckGo";
    } catch (_) {
      try {
        results = await bingSearch(query, page, region);
        engineUsed = "Bing";
      } catch (_) {
        results = [];
      }
    }
  }

  // Если всё ещё пусто, пробуем Bing с общим запросом без фильтра региона
  if ((!results || results.length === 0) && page === 0) {
    try {
      results = await bingSearch(query, 0, "wt-wt");
      if (results.length > 0) engineUsed = "Bing (международный)";
    } catch (_) {}
  }

  // Карточки и справки (учитываем настройки пользователя)
  const showInstant = settings.showInstantAnswers !== false;
  const showWiki = settings.showWikiCards !== false;
  const showSuggestions = settings.showSuggestions !== false;

  const [instant, wiki, related] = await Promise.all([
    (page === 0 && showInstant) ? ddgInstant(query) : Promise.resolve({}),
    (page === 0 && showWiki) ? wikiCard(query) : Promise.resolve({}),
    (page === 0 && showSuggestions) ? ddgSuggest(query) : Promise.resolve([]),
  ]);

  let finalWiki = {};
  if (showWiki) {
    if (wiki && wiki.title) {
      finalWiki = wiki;
    } else if (page === 0 && results.length > 0) {
      finalWiki = await wikiFromResults(results);
    }
  }

  const payload = {
    query,
    page,
    results: results || [],
    related: (related || []).filter((s) => s.toLowerCase() !== query.toLowerCase()),
    instant: instant || {},
    wiki: finalWiki || {},
    engine: engineUsed,
    took_ms: Date.now() - started,
  };
  recordSearchHistory(query);
  cacheSet(key, payload);
  return payload;
}

/* ---------- проверка и скачивание обновлений ---------- */

function getExpectedAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    return "iskatel-win64-setup.exe";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "iskatel-mac-arm64.dmg" : "iskatel-mac-intel.dmg";
  }
  if (platform === "linux") {
    return "iskatel-linux-amd64.deb";
  }
  return null;
}

function parseSemver(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function isNewerVersion(latest, current) {
  const [lMaj, lMin, lPat] = parseSemver(latest);
  const [cMaj, cMin, cPat] = parseSemver(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

async function checkForUpdates() {
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: {
        "User-Agent": `Iskatel/${APP_VERSION}`,
        "Accept": "application/vnd.github.v3+json",
      },
    });

    if (res.status === 404) {
      return {
        hasUpdate: false,
        currentVersion: APP_VERSION,
        message: "Опубликованных релизов пока не найдено.",
      };
    }

    if (!res.ok) {
      throw new Error(`GitHub API вернул статус ${res.status}`);
    }

    const release = await res.json();
    const latestTag = release.tag_name || "";
    const cleanLatest = latestTag.replace(/^v/i, "");
    const hasUpdate = isNewerVersion(latestTag, APP_VERSION);
    const expectedName = getExpectedAssetName();

    const assets = release.assets || [];
    const matchedAsset = assets.find((a) => a.name === expectedName);

    return {
      hasUpdate,
      currentVersion: APP_VERSION,
      latestVersion: cleanLatest,
      latestTag,
      releaseName: release.name || latestTag,
      releaseNotes: release.body || "",
      publishedAt: release.published_at,
      htmlUrl: release.html_url,
      expectedAsset: expectedName,
      asset: matchedAsset
        ? {
            name: matchedAsset.name,
            size: matchedAsset.size,
            downloadUrl: matchedAsset.browser_download_url,
          }
        : null,
      availableAssets: assets.map((a) => a.name),
    };
  } catch (err) {
    return {
      hasUpdate: false,
      currentVersion: APP_VERSION,
      error: `Ошибка проверки обновлений: ${err.message}`,
    };
  }
}

function downloadFileWithProgress(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);

    function requestUrl(targetUrl) {
      const client = targetUrl.startsWith("https") ? https : http;
      const req = client.get(
        targetUrl,
        {
          headers: {
            "User-Agent": `Iskatel/${APP_VERSION}`,
          },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return requestUrl(res.headers.location);
          }
          if (res.statusCode !== 200) {
            file.close();
            fs.unlink(destPath, () => {});
            return reject(new Error(`HTTP ${res.statusCode}`));
          }

          const total = parseInt(res.headers["content-length"] || "0", 10);
          let downloaded = 0;

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (onProgress) {
              onProgress({
                downloaded,
                total,
                percent: total > 0 ? Math.round((downloaded / total) * 100) : 0,
              });
            }
          });

          res.pipe(file);

          file.on("finish", () => {
            file.close(() => resolve(destPath));
          });
        }
      );

      req.on("error", (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    requestUrl(url);
  });
}

async function launchSystemInstaller(filePath) {
  const platform = process.platform;
  if (platform === "win32") {
    // Запуск системного инсталлятора Windows (.exe)
    const p = spawn(filePath, [], { detached: true, stdio: "ignore" });
    p.unref();
    return true;
  } else if (platform === "darwin") {
    // Открытие образа macOS (.dmg)
    await shell.openPath(filePath);
    return true;
  } else if (platform === "linux") {
    // Открытие системного установщика пакетов Linux (.deb)
    await shell.openPath(filePath);
    return true;
  }
  return false;
}

/* ---------- главное окно ---------- */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 720,
    minHeight: 560,
    title: "Proton",
    backgroundColor: "#16171d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ссылки открываются в системном браузере по умолчанию
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
}

/* ---------- регистрация IPC и запуск ---------- */

app.whenReady().then(() => {
  // Поиск и саджест
  ipcMain.handle("iskatel:search", (_e, params) => doSearch(params || {}));
  ipcMain.handle("iskatel:suggest", async (_e, params) => {
    const q = String((params || {}).q || "").trim();
    if (!q) return { suggestions: [] };
    const key = `a:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return { suggestions: cached };
    const s = await ddgSuggest(q);
    cacheSet(key, s);
    return { suggestions: s };
  });

  // Метаданные
  ipcMain.handle("iskatel:get-version", () => APP_VERSION);

  // Авторизация и аккаунты (v2.5)
  ipcMain.handle("iskatel:auth-get-current-user", () => loadSession());
  ipcMain.handle("iskatel:auth-register", (_e, params) => registerAccount(params || {}));
  ipcMain.handle("iskatel:auth-login", (_e, params) => loginAccount(params || {}));
  ipcMain.handle("iskatel:auth-google-login", (_e, params) => googleSignIn(params || {}));
  ipcMain.handle("iskatel:auth-logout", () => {
    saveSession(null);
    return { ok: true };
  });
  ipcMain.handle("iskatel:auth-get-bookmarks", () => {
    const user = loadSession();
    return (user && user.bookmarks) || [];
  });
  ipcMain.handle("iskatel:auth-add-bookmark", (_e, bm) => addBookmarkForUser(bm || {}));
  ipcMain.handle("iskatel:auth-remove-bookmark", (_e, id) => removeBookmarkForUser(id));

  // Настройки
  ipcMain.handle("iskatel:get-settings", () => loadSettings());
  ipcMain.handle("iskatel:save-settings", (_e, newSettings) => saveSettings(newSettings));

  // Обновления
  ipcMain.handle("iskatel:check-update", () => checkForUpdates());

  ipcMain.handle("iskatel:download-update", async (event, { url, filename }) => {
    const name = filename || getExpectedAssetName() || "iskatel-update";
    const dest = path.join(app.getPath("temp"), "iskatel-update", name);
    try {
      await downloadFileWithProgress(url, dest, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("iskatel:download-progress", progress);
        }
      });
      return { ok: true, filePath: dest };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("iskatel:install-update", async (_e, { filePath }) => {
    try {
      const ok = await launchSystemInstaller(filePath);
      return { ok };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("iskatel:open-external", (_e, url) => {
    if (typeof url === "string" && url.startsWith("http")) {
      shell.openExternal(url);
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
