"use strict";
/* «Proton» — десктопный браузер (Electron).
   Главный процесс: окно + встроенный поисковый движок, система вкладок,
   голосовой ввод, фоновые обои, настройки и надежное обновление через GitHub Releases.
   Текущая версия: 2.8.2 (Комплексное исправление интерфейса, надежный поиск, кликабельность) */

const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");

app.setName("Proton");

const APP_VERSION = "2.10.0";
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
  // ИИ-помощник (Google Assistant / AI Overview стиль)
  aiEnabled: true,
  aiAutoSpeak: false,
  aiProvider: "builtin", // "builtin", "groq", "openai", "deepseek", "ollama", "custom"
  aiApiKey: "",
  aiModel: "",
  aiCustomEndpoint: "",
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
    if (i > 0) await sleep(800 * i);
    const url = "https://html.duckduckgo.com/html/";
    try {
      if (attempts[i] === "post") {
        const body = new URLSearchParams({ q: query, kl: kl, s: String(offset), b: "" });
        resp = await fetch(url, {
          method: "POST",
          headers: { ...NAV_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(4500),
        });
      } else {
        resp = await fetch(`${url}?q=${encodeURIComponent(query)}&kl=${kl}&s=${offset}`, {
          headers: NAV_HEADERS,
          signal: AbortSignal.timeout(4500),
        });
      }
      if (resp && resp.ok) break;
    } catch (_) {}
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
      { headers: JSON_HEADERS, signal: AbortSignal.timeout(2500) }
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
      { headers: { "User-Agent": USER_AGENT, "Accept": "*/*" }, signal: AbortSignal.timeout(3000) }
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
      signal: AbortSignal.timeout(4500),
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
  const r = await fetch(u, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(3000) });
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

/* ---------- ИИ-помощник (Google Assistant / AI Overview) ---------- */

function cleanTextForAI(str) {
  if (!str) return "";
  return String(str)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSentencesForAI(text) {
  if (!text) return [];
  const cleaned = cleanTextForAI(text);
  const raw = cleaned.split(/(?<=[.!?])\s+/);
  const out = [];
  for (let s of raw) {
    s = s.trim();
    s = s.replace(/^[\s\.\…\-\*\–\—\•\d\.\)]+/, "").trim();
    if (s.length < 25) continue;
    if (/^(читать|подробнее|см\.|источник|фото|видео|автор|опубликовано|реклама|cookie|все права|подписаться)/i.test(s)) continue;
    if (!/[.!?]$/.test(s)) s += ".";
    out.push(s);
  }
  return out;
}

function synthesizeBuiltinAIAnswer({ query = "", results = [], wiki = {}, instant = {} }) {
  const qClean = cleanTextForAI(query);
  const qLower = qClean.toLowerCase();
  const qWords = qLower.split(/[\s,.;:!?\-]+/).filter(w => w.length > 2 && !["как", "что", "кто", "где", "когда", "почему", "зачем", "сколько", "какой", "какая", "какие", "это", "или", "для", "при", "про", "чем", "все"].includes(w));

  const sentences = [];
  const sources = [];

  // Энциклопедическая выжимка из Википедии
  if (wiki && wiki.extract) {
    const sents = extractSentencesForAI(wiki.extract);
    sents.forEach((st, idx) => {
      sentences.push({
        text: st,
        weight: 12 - idx * 2,
        source: { title: wiki.title || "Википедия", url: wiki.url || "", domain: "ru.wikipedia.org" }
      });
    });
    if (wiki.url) {
      sources.push({
        title: wiki.title ? `${wiki.title} — Википедия` : "Википедия",
        url: wiki.url,
        domain: "ru.wikipedia.org"
      });
    }
  }

  // Мгновенный факт / калькулятор
  if (instant && (instant.text || instant.abstract)) {
    const sents = extractSentencesForAI(instant.text || instant.abstract);
    sents.forEach(st => {
      sentences.push({
        text: st,
        weight: 10,
        source: { title: instant.heading || "Мгновенный ответ", url: instant.url || "", domain: "duckduckgo.com" }
      });
    });
  }

  // Сниппеты ведущих результатов поиска
  for (const r of (results || []).slice(0, 6)) {
    if (!r) continue;
    let domain = r.display_url || "";
    try {
      if (!domain && r.url) domain = new URL(r.url).hostname.replace(/^www\./, "");
    } catch (_) {}

    if (r.url && sources.length < 5 && !sources.some(s => s.url === r.url)) {
      sources.push({
        title: cleanTextForAI(r.title) || domain,
        url: r.url,
        domain: domain || "web"
      });
    }

    const sents = extractSentencesForAI(r.snippet);
    sents.forEach(st => {
      let weight = 4;
      const stLower = st.toLowerCase();
      for (const w of qWords) {
        if (stLower.includes(w)) weight += 2;
      }
      if (/— (это|представляет собой|является|называется|считается)/i.test(st)) weight += 3;
      sentences.push({
        text: st,
        weight,
        source: { title: cleanTextForAI(r.title), url: r.url, domain }
      });
    });
  }

  // Дедупликация похожих предложений
  const unique = [];
  for (const item of sentences) {
    const isDup = unique.some(u => {
      const a = u.text.toLowerCase().replace(/[^a-zа-яё0-9]/g, "");
      const b = item.text.toLowerCase().replace(/[^a-zа-яё0-9]/g, "");
      return a === b || a.includes(b.slice(0, 35)) || b.includes(a.slice(0, 35));
    });
    if (!isDup) unique.push(item);
  }

  unique.sort((a, b) => b.weight - a.weight);

  let summary = "";
  let keyPoints = [];

  if (unique.length > 0) {
    summary = unique[0].text;
    if (unique.length > 1 && unique[1].weight >= 6 && summary.length < 180) {
      summary += " " + unique[1].text;
    }
    const pool = unique.filter(u => !summary.includes(u.text));
    keyPoints = pool.slice(0, 4).map(u => u.text);
  }

  if (!summary) {
    summary = `По запросу «${qClean}» найдены проверенные материалы в веб-источниках. Основные детали представлены в результатах поиска.`;
  }

  const voiceText = `${summary} ${keyPoints.slice(0, 3).join(" ")}`.replace(/\s+/g, " ").trim();

  return {
    ok: true,
    provider: "Встроенный нейросинтез",
    summary,
    keyPoints,
    sources: sources.slice(0, 4),
    voiceText
  };
}

async function callExternalLLM({ query, results = [], wiki = {}, instant = {}, provider, apiKey, model, customEndpoint }) {
  let endpoint = "";
  let modelName = model || "";
  const headers = { "Content-Type": "application/json" };

  if (provider === "groq") {
    endpoint = "https://api.groq.com/openai/v1/chat/completions";
    modelName = modelName || "llama-3.3-70b-versatile";
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (provider === "openai") {
    endpoint = "https://api.openai.com/v1/chat/completions";
    modelName = modelName || "gpt-4o-mini";
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (provider === "deepseek") {
    endpoint = "https://api.deepseek.com/chat/completions";
    modelName = modelName || "deepseek-chat";
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (provider === "ollama") {
    endpoint = customEndpoint || "http://127.0.0.1:11434/v1/chat/completions";
    modelName = modelName || "llama3.2";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (provider === "custom") {
    endpoint = customEndpoint;
    modelName = modelName || "gpt-3.5-turbo";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    throw new Error(`Неизвестный провайдер: ${provider}`);
  }

  if (!endpoint) {
    throw new Error("Не указан URL эндпоинта модели");
  }

  const contextParts = [];
  if (wiki && wiki.extract) contextParts.push(`Википедия: ${wiki.extract}`);
  if (instant && (instant.text || instant.abstract)) contextParts.push(`Факт: ${instant.text || instant.abstract}`);
  for (const r of (results || []).slice(0, 5)) {
    if (r && r.snippet) {
      contextParts.push(`- ${cleanTextForAI(r.title)}: ${cleanTextForAI(r.snippet)}`);
    }
  }

  const userPrompt = `Запрос пользователя: "${query}"\n\nКонтекст источников:\n${contextParts.join("\n") || "(источники отсутствуют)"}`;

  const body = {
    model: modelName,
    messages: [
      {
        role: "system",
        content: `Ты — лаконичный ИИ-ассистент браузера Proton (в стиле Google Assistant и AI Overviews).
Твоя задача — дать прямой, предельно информативный и чёткий ответ на русском языке (или языке запроса).
Правила:
1. Краткий ответ (summary): 2–3 предложения прямо по существу вопроса без пустых вводных слов.
2. Ключевые факты (keyPoints): 3–4 конкретных тезиса (цифры, факты, свойства, важные детали).
3. Стиль: объективный, лаконичный. Без эмодзи.
4. Ответ верни в строгом формате JSON:
{
  "summary": "краткий ответ...",
  "keyPoints": ["тезис 1", "тезис 2", "тезис 3"]
}`
      },
      {
        role: "user",
        content: userPrompt
      }
    ],
    temperature: 0.2,
    max_tokens: 700
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 120)}`);
  }

  const data = await response.json();
  const rawContent = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!rawContent) throw new Error("Пустой ответ от нейросети");

  let summary = "";
  let keyPoints = [];

  try {
    const match = rawContent.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.summary && typeof parsed.summary === "string") summary = parsed.summary.trim();
      if (Array.isArray(parsed.keyPoints)) {
        keyPoints = parsed.keyPoints.filter(p => typeof p === "string" && p.trim().length > 0).map(p => p.trim());
      }
    }
  } catch (_) {}

  if (!summary) {
    const lines = rawContent.split("\n").map(l => l.trim()).filter(Boolean);
    const bullets = [];
    const plain = [];
    for (const l of lines) {
      if (/^[-*•\d\.]+\s+/.test(l)) {
        bullets.push(l.replace(/^[-*•\d\.]+\s+/, "").trim());
      } else {
        plain.push(l);
      }
    }
    summary = plain.slice(0, 2).join(" ");
    keyPoints = bullets.slice(0, 4);
  }

  const sources = [];
  if (wiki && wiki.url) {
    sources.push({
      title: wiki.title ? `${wiki.title} — Википедия` : "Википедия",
      url: wiki.url,
      domain: "ru.wikipedia.org"
    });
  }
  for (const r of (results || []).slice(0, 4)) {
    if (r && r.url && sources.length < 4 && !sources.some(s => s.url === r.url)) {
      let domain = r.display_url || "";
      try { if (!domain && r.url) domain = new URL(r.url).hostname.replace(/^www\./, ""); } catch (_) {}
      sources.push({
        title: cleanTextForAI(r.title) || domain,
        url: r.url,
        domain: domain || "web"
      });
    }
  }

  const voiceText = `${summary} ${keyPoints.slice(0, 3).join(" ")}`.replace(/\s+/g, " ").trim();

  let providerLabel = provider.toUpperCase();
  if (provider === "groq") providerLabel = `Groq (${modelName})`;
  else if (provider === "openai") providerLabel = `OpenAI (${modelName})`;
  else if (provider === "deepseek") providerLabel = `DeepSeek (${modelName})`;
  else if (provider === "ollama") providerLabel = `Ollama (${modelName})`;
  else if (provider === "custom") providerLabel = `LLM (${modelName})`;

  return {
    ok: true,
    provider: providerLabel,
    summary,
    keyPoints,
    sources,
    voiceText
  };
}

async function generateAIAssistantAnswer(params = {}) {
  const settings = loadSettings();
  if (settings.aiEnabled === false) {
    return { ok: false, disabled: true, error: "ИИ-помощник отключен в настройках" };
  }

  const provider = (params.provider || settings.aiProvider || "builtin").toLowerCase();
  const apiKey = params.apiKey != null ? params.apiKey : (settings.aiApiKey || "");
  const model = params.model || settings.aiModel || "";
  const customEndpoint = params.customEndpoint || settings.aiCustomEndpoint || "";

  if (provider !== "builtin" && (apiKey || provider === "ollama")) {
    try {
      return await callExternalLLM({
        query: params.query,
        results: params.results,
        wiki: params.wiki,
        instant: params.instant,
        provider,
        apiKey,
        model,
        customEndpoint
      });
    } catch (err) {
      console.warn("External LLM failed, fallback to built-in synthesizer:", err.message);
      const fallback = synthesizeBuiltinAIAnswer(params);
      fallback.provider = `Встроенный нейросинтез (Резерв)`;
      fallback.warning = err.message;
      return fallback;
    }
  }

  return synthesizeBuiltinAIAnswer(params);
}

async function testAIConnection({ provider, apiKey, model, customEndpoint }) {
  try {
    const prov = (provider || "builtin").toLowerCase();
    if (prov === "builtin") {
      return { ok: true, message: "Встроенный нейросинтез готов к работе и не требует API-ключей." };
    }
    const res = await callExternalLLM({
      query: "Тест подключения",
      results: [{ title: "Тест", snippet: "Проверка связи с моделью искусственного интеллекта.", url: "https://example.com" }],
      provider: prov,
      apiKey,
      model,
      customEndpoint
    });
    return { ok: true, message: `Связь с моделью ${res.provider} успешно установлена!` };
  } catch (err) {
    return { ok: false, message: `Ошибка подключения: ${err.message}` };
  }
}

function generateBuiltinCopilotReply(userText, query, wiki, instant, results) {
  const uLower = (userText || "").toLowerCase().trim();
  const allSentences = [];

  if (wiki && wiki.extract) {
    extractSentencesForAI(wiki.extract).forEach(s => allSentences.push(s));
  }
  if (instant && (instant.text || instant.abstract)) {
    extractSentencesForAI(instant.text || instant.abstract).forEach(s => allSentences.push(s));
  }
  for (const r of (results || []).slice(0, 5)) {
    if (r && r.snippet) {
      extractSentencesForAI(r.snippet).forEach(s => allSentences.push(s));
    }
  }

  // 1. TL;DR / Краткая суть
  if (/кратк|суть|пересказ|тлдр|главное|в двух словах/i.test(uLower)) {
    if (allSentences.length > 0) {
      const main = allSentences.slice(0, 2).join(" ");
      const bullets = allSentences.slice(2, 5).map(s => "- " + s).join("\n");
      return {
        ok: true,
        content: `Краткая суть по теме «${query || "запроса"}»:\n\n${main}\n\nКлючевые моменты:\n${bullets}`,
        provider: "Встроенный Copilot"
      };
    }
  }

  // 2. Факты и цифры
  if (/факт|цифр|числа|статистик/i.test(uLower)) {
    const factSentences = allSentences.filter(s => /\d+/.test(s) || /является|состоит|включает/i.test(s));
    if (factSentences.length > 0) {
      return {
        ok: true,
        content: `Ключевые факты по теме «${query || "запроса"}»:\n\n` + factSentences.slice(0, 5).map(s => "- " + s).join("\n"),
        provider: "Встроенный Copilot"
      };
    }
  }

  // 3. Объясни просто
  if (/просто|простыми словами|для чайников|понятно/i.test(uLower)) {
    if (allSentences.length > 0) {
      return {
        ok: true,
        content: `Простыми словами о том, что такое «${query || "это понятие"}»:\n\n` +
          allSentences[0] + "\n\n" +
          "Если говорить простым языком: " + (allSentences[1] || allSentences[0]),
        provider: "Встроенный Copilot"
      };
    }
  }

  // 4. Сравнение / Плюсы и минусы
  if (/сравн|плюс|минус|преимуществ|недостат/i.test(uLower)) {
    if (allSentences.length > 0) {
      return {
        ok: true,
        content: `Анализ темы «${query || userText}»:\n\n` +
          "- Основные характеристики: " + (allSentences[0] || "") + "\n" +
          "- Особенности и специфика: " + (allSentences[1] || "") + "\n" +
          "- Практическое применение: " + (allSentences[2] || allSentences[0]),
        provider: "Встроенный Copilot"
      };
    }
  }

  // 5. Перевод
  if (/перевод|переведи|на английск|на русский/i.test(uLower)) {
    return {
      ok: true,
      content: `Перевод и ключевые термины по запросу «${query || userText}»:\n\n` +
        (wiki && wiki.title ? `- Понятие: ${wiki.title}\n` : "") +
        `- В международном контексте: ${query}\n\n` +
        (allSentences[0] ? `Определение: ${allSentences[0]}` : ""),
      provider: "Встроенный Copilot"
    };
  }

  // 6. Обычный контекстный ответ
  if (allSentences.length > 0) {
    const relevant = allSentences.slice(0, 3).join(" ");
    return {
      ok: true,
      content: `По теме «${query || userText}»:\n\n${relevant}\n\nВы можете задать любой уточняющий вопрос или нажать на быстрые действия выше.`,
      provider: "Встроенный Copilot"
    };
  }

  return {
    ok: true,
    content: `Я готов помочь вам с поиском и анализом информации. Введите интересующий вас вопрос или поисковый запрос в строке Proton.`,
    provider: "Встроенный Copilot"
  };
}

async function handleCopilotChat({ messages = [], context = {} }) {
  const settings = loadSettings();
  const provider = (settings.aiProvider || "builtin").toLowerCase();
  const apiKey = settings.aiApiKey || "";
  const model = settings.aiModel || "";
  const customEndpoint = settings.aiCustomEndpoint || "";

  const lastMsgObj = messages[messages.length - 1] || {};
  const userText = cleanTextForAI(lastMsgObj.content || "");
  const query = cleanTextForAI(context.query || "");
  const wiki = context.wiki || {};
  const results = context.results || [];
  const instant = context.instant || {};

  if (provider !== "builtin" && (apiKey || provider === "ollama")) {
    try {
      let endpoint = "";
      let modelName = model;
      const headers = { "Content-Type": "application/json" };

      if (provider === "groq") {
        endpoint = "https://api.groq.com/openai/v1/chat/completions";
        modelName = modelName || "llama-3.3-70b-versatile";
        headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (provider === "openai") {
        endpoint = "https://api.openai.com/v1/chat/completions";
        modelName = modelName || "gpt-4o-mini";
        headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (provider === "deepseek") {
        endpoint = "https://api.deepseek.com/chat/completions";
        modelName = modelName || "deepseek-chat";
        headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (provider === "ollama") {
        endpoint = customEndpoint || "http://127.0.0.1:11434/v1/chat/completions";
        modelName = modelName || "llama3.2";
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (provider === "custom") {
        endpoint = customEndpoint;
        modelName = modelName || "gpt-3.5-turbo";
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const contextSnippets = [];
      if (query) contextSnippets.push(`Текущий поисковый запрос: "${query}"`);
      if (wiki.extract) contextSnippets.push(`Википедия: ${cleanTextForAI(wiki.extract)}`);
      if (instant.text || instant.abstract) contextSnippets.push(`Факт: ${cleanTextForAI(instant.text || instant.abstract)}`);
      for (const r of (results || []).slice(0, 4)) {
        if (r && r.snippet) contextSnippets.push(`- ${cleanTextForAI(r.title)}: ${cleanTextForAI(r.snippet)}`);
      }

      const systemPrompt = `Ты — интеллектуальный ИИ-ассистент Proton Copilot в боковой панели браузера Proton.
Твоя задача — помогать пользователю анализировать информацию, отвечать на вопросы, делать выжимки и давать четкие объяснения.
Контекст открытой страницы/запроса:
${contextSnippets.join("\n") || "(контекст поиска отсутствует)"}

Требования:
1. Отвечай прямо, информативно и вежливо на русском языке.
2. Форматируй текст понятными абзацами и четкими пунктами списков (через дефис).
3. Стиль лаконичный, энциклопедический.
4. Не используй эмодзи.`;

      const apiMessages = [
        { role: "system", content: systemPrompt },
        ...messages.slice(-8).map(m => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content || "")
        }))
      ];

      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelName,
          messages: apiMessages,
          temperature: 0.3,
          max_tokens: 800
        }),
        signal: AbortSignal.timeout(14000)
      });

      if (!resp.ok) {
        const errT = await resp.text().catch(() => "");
        throw new Error(`API error ${resp.status}: ${errT.slice(0, 100)}`);
      }

      const data = await resp.json();
      const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!answer) throw new Error("Пустой ответ от нейросети");

      return {
        ok: true,
        content: answer.trim(),
        provider: `${provider.toUpperCase()} (${modelName})`
      };
    } catch (err) {
      console.warn("External LLM copilot failed, fallback to built-in synthesizer:", err.message);
    }
  }

  return generateBuiltinCopilotReply(userText, query, wiki, instant, results);
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

  // Если оба внешних сервиса заблокированы или недоступны — формируем прямые навигационные карточки
  if ((!results || results.length === 0) && page === 0) {
    const qEnc = encodeURIComponent(query);
    results = [
      {
        title: `${query} — Поиск в Яндекс`,
        url: `https://yandex.ru/search/?text=${qEnc}`,
        display_url: "yandex.ru",
        snippet: `Перейти к результатам поиска «${query}» в поисковой системе Яндекс.`,
      },
      {
        title: `${query} — Поиск в Google`,
        url: `https://www.google.com/search?q=${qEnc}`,
        display_url: "google.com",
        snippet: `Открыть поисковую выдачу Google по запросу «${query}».`,
      },
      {
        title: `Искать «${query}» в Русской Википедии`,
        url: `https://ru.wikipedia.org/wiki/Special:Search?search=${qEnc}`,
        display_url: "ru.wikipedia.org",
        snippet: `Статьи, справочные материалы и исторические справки в свободной энциклопедии Википедия.`,
      },
      {
        title: `${query} — Видео на YouTube`,
        url: `https://www.youtube.com/results?search_query=${qEnc}`,
        display_url: "youtube.com",
        snippet: `Видеоролики, обзоры и обучающие материалы по теме «${query}».`,
      },
    ];
    engineUsed = "Прямой веб-навигатор";
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

  let aiAnswer = null;
  if (page === 0 && settings.aiEnabled !== false) {
    try {
      aiAnswer = synthesizeBuiltinAIAnswer({
        query,
        results,
        wiki: finalWiki,
        instant,
      });
    } catch (_) {}
  }

  const payload = {
    query,
    page,
    results: results || [],
    related: (related || []).filter((s) => s.toLowerCase() !== query.toLowerCase()),
    instant: instant || {},
    wiki: finalWiki || {},
    ai: aiAnswer,
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
        "User-Agent": `Proton/${APP_VERSION}`,
        "Accept": "application/vnd.github.v3+json",
      },
      signal: AbortSignal.timeout(6000),
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
    let matchedAsset = assets.find((a) => a.name === expectedName);
    if (!matchedAsset) {
      if (process.platform === "win32") {
        matchedAsset = assets.find((a) => a.name.includes("win64-setup") || a.name.endsWith(".exe"));
      } else if (process.platform === "linux") {
        matchedAsset = assets.find((a) => a.name.endsWith(".deb"));
      } else if (process.platform === "darwin") {
        const arch = process.arch;
        matchedAsset = assets.find((a) => a.name.includes(arch) && a.name.endsWith(".dmg")) || assets.find((a) => a.name.endsWith(".dmg"));
      }
    }

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

function downloadFileWithProgress(initialUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch (_) {}
    }
    const file = fs.createWriteStream(destPath);
    let redirects = 0;

    function get(currentUrl) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (err) {
        file.close();
        return reject(err);
      }
      const client = parsed.protocol === "http:" ? http : https;
      const req = client.get(
        currentUrl,
        {
          headers: {
            "User-Agent": `Proton/${APP_VERSION}`,
          },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            redirects++;
            if (redirects > 10) {
              file.close();
              return reject(new Error("Слишком много перенаправлений"));
            }
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            return get(nextUrl);
          }

          if (res.statusCode !== 200) {
            file.close();
            try { fs.unlinkSync(destPath); } catch (_) {}
            return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || ""}`));
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
        try { fs.unlinkSync(destPath); } catch (_) {}
        reject(err);
      });
    }

    get(initialUrl);
  });
}

async function launchSystemInstaller(filePath) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // Запуск системного инсталлятора Windows (.exe)
      const err = await shell.openPath(filePath);
      if (err) {
        const p = spawn(filePath, [], { detached: true, stdio: "ignore" });
        p.unref();
      }
      // Закрываем Proton через 1.5 секунды, чтобы инсталлятор мог обновить занятые файлы
      setTimeout(() => {
        app.quit();
      }, 1500);
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
  } catch (e) {
    console.error("Ошибка запуска установщика:", e);
    return false;
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
      webviewTag: true,
    },
  });

  // Перехватываем открытие окон и перенаправляем во вкладки внутри Proton
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (mainWindow && !mainWindow.isDestroyed() && url && url.startsWith("http")) {
      mainWindow.webContents.send("iskatel:open-tab-url", url);
    }
    return { action: "deny" };
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
}

/* ---------- регистрация IPC и запуск ---------- */

app.whenReady().then(() => {
  // Разрешаем доступ к микрофону для голосового поиска
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "microphone") {
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === "media" || permission === "microphone") {
      return true;
    }
    return false;
  });

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

  // ИИ-ассистент (Google Assistant / AI Overview) и Copilot
  ipcMain.handle("iskatel:ai-ask", async (_e, params) => generateAIAssistantAnswer(params || {}));
  ipcMain.handle("iskatel:ai-test-provider", async (_e, params) => testAIConnection(params || {}));
  ipcMain.handle("iskatel:ai-copilot", async (_e, params) => handleCopilotChat(params || {}));

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
