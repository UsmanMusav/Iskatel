"use strict";
/* Proton Shield — защита вкладок и проверка загрузок.
   Это не замена системного антивируса: модуль изолирует сайты,
   блокирует известные вредоносные адреса и не даёт открыть опасный файл. */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

const ALLOW_HOSTS = [
  "google.com", "youtube.com", "gmail.com", "gstatic.com", "googleusercontent.com",
  "googleapis.com", "ggpht.com", "github.com", "githubusercontent.com",
  "microsoft.com", "live.com", "office.com", "office365.com", "microsoftonline.com",
  "apple.com", "icloud.com", "cloudflare.com", "wikipedia.org", "wikimedia.org",
  "yandex.ru", "yandex.com", "yandex.net", "ya.ru", "yastatic.net",
  "vk.com", "vk.ru", "userapi.com", "mail.ru", "ok.ru",
  "duckduckgo.com", "bing.com", "mozilla.org", "proton.me"
];

const BRANDS = [
  { token: "paypal", label: "PayPal", domains: ["paypal.com", "paypal.me"] },
  { token: "sberbank", label: "Сбербанк", domains: ["sberbank.ru", "sber.ru"] },
  { token: "sber", label: "Сбер", domains: ["sber.ru", "sberbank.ru"] },
  { token: "gosuslugi", label: "Госуслуги", domains: ["gosuslugi.ru"] },
  { token: "google", label: "Google", domains: ["google.com", "google.ru", "gmail.com", "youtube.com", "gstatic.com", "googleapis.com", "googleusercontent.com"] },
  { token: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be", "googlevideo.com"] },
  { token: "apple", label: "Apple", domains: ["apple.com", "icloud.com"] },
  { token: "microsoft", label: "Microsoft", domains: ["microsoft.com", "live.com", "office.com", "office365.com", "microsoftonline.com"] },
  { token: "steam", label: "Steam", domains: ["steampowered.com", "steamcommunity.com"] },
  { token: "binance", label: "Binance", domains: ["binance.com"] },
  { token: "telegram", label: "Telegram", domains: ["telegram.org", "t.me"] },
  { token: "whatsapp", label: "WhatsApp", domains: ["whatsapp.com", "whatsapp.net"] },
  { token: "yandex", label: "Яндекс", domains: ["yandex.ru", "yandex.com", "ya.ru", "yandex.net"] }
];

const PHISH_WORDS = ["login", "secure", "verify", "account", "update", "signin", "support", "wallet", "confirm", "password", "recovery", "bonus"];

const LOCAL_BAD_HOSTS = [
  "testsafebrowsing.appspot.com",
  "malware.testing.google.test",
  "phishing.testing.google.test"
];

const DANGEROUS_EXT = new Set([
  ".exe", ".scr", ".bat", ".cmd", ".com", ".pif", ".vbs", ".vbe", ".js", ".jse",
  ".wsf", ".wsh", ".ps1", ".msi", ".dll", ".hta", ".jar", ".apk", ".iso", ".img",
  ".lnk", ".reg", ".cpl", ".msc", ".gadget", ".application", ".msix", ".appx"
]);

const DOC_EXT = new Set(["pdf", "doc", "docx", "xls", "xlsx", "jpg", "jpeg", "png", "gif", "txt", "mp3", "mp4", "zip"]);

const SAFE_SITE_PERMISSIONS = new Set([
  "fullscreen", "pointerLock", "clipboard-sanitized-write", "background-sync",
  "mediaKeySystem", "accessibility-events", "idle-detection"
]);

const ASK_SITE_PERMISSIONS = new Set([
  "media", "microphone", "camera", "geolocation", "notifications",
  "clipboard-read", "display-capture", "midi", "speaker-selection"
]);

const badHosts = new Set(LOCAL_BAD_HOSTS);
let feedHosts = 0;
let feedLoadedAt = 0;
let feedSource = "локальные правила";

const stats = {
  blockedPages: 0,
  blockedResources: 0,
  downloadsScanned: 0,
  downloadsQuarantined: 0,
  permissionsDenied: 0
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/\.$/, "").toLowerCase();
  } catch (_) {
    return "";
  }
}

function isOfficialHost(host) {
  return ALLOW_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

function isListedHost(host) {
  if (!host) return false;
  if (badHosts.has(host)) return true;
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join(".");
    if (badHosts.has(parent)) return true;
  }
  return false;
}

function brandImpersonation(host) {
  if (!host || isOfficialHost(host)) return null;
  for (const brand of BRANDS) {
    const official = brand.domains.some((d) => host === d || host.endsWith("." + d));
    if (official) continue;
    const embedded = brand.domains.some((d) => host.includes(d + ".") || host.startsWith(d + "."));
    const tokenRe = new RegExp("(^|[.\\-])" + brand.token + "([.\\-]|$)", "i");
    const hasToken = tokenRe.test(host) || host.includes(brand.token + "-") || host.includes("-" + brand.token);
    if (embedded) {
      return `Адрес маскируется под ${brand.label}`;
    }
    if (hasToken && PHISH_WORDS.some((w) => host.includes(w))) {
      return `Похоже на поддельный сайт ${brand.label}`;
    }
  }
  return null;
}

function assessUrl(raw) {
  const url = String(raw || "").trim();
  if (!url) return { ok: true, block: false, level: "ok", reason: "", url, host: "" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { ok: false, block: true, level: "block", reason: "Некорректный адрес", url, host: "" };
  }
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (protocol === "javascript:" || protocol === "data:" || protocol === "file:" || protocol === "filesystem:" || protocol === "chrome:" || protocol === "chrome-extension:") {
    return { ok: false, block: true, level: "block", reason: "Сайт пытается открыть запрещённую схему адреса", url, host };
  }
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "about:") {
    return { ok: false, block: true, level: "block", reason: "Неподдерживаемая схема адреса", url, host };
  }
  if (host && isListedHost(host) && !isOfficialHost(host)) {
    return { ok: false, block: true, level: "block", reason: "Адрес есть в базе вредоносных сайтов", url, host };
  }
  const phish = brandImpersonation(host);
  if (phish) {
    return { ok: false, block: true, level: "block", reason: phish, url, host };
  }
  let level = "ok";
  let reason = "";
  if (protocol === "http:" && host && !/^(localhost|127\\.0\\.0\\.1)$/.test(host)) {
    level = "warn";
    reason = "Соединение без шифрования";
  }
  if (/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(host)) {
    level = "warn";
    reason = "Сайт открыт по IP-адресу, а не по имени";
  }
  return { ok: true, block: false, level, reason, url, host };
}

function inspectDownloadName(filename, sourceUrl) {
  const name = String(filename || "").toLowerCase();
  const host = hostOf(sourceUrl);
  if (host && isListedHost(host) && !isOfficialHost(host)) {
    return { threat: true, level: "block", reason: "Файл скачивается с вредоносного адреса" };
  }
  const parts = name.split(".");
  if (parts.length >= 3) {
    const prev = parts[parts.length - 2];
    const last = "." + parts[parts.length - 1];
    if (DOC_EXT.has(prev) && DANGEROUS_EXT.has(last)) {
      return { threat: true, level: "block", reason: "Двойное расширение: файл маскируется под документ" };
    }
  }
  for (const ext of DANGEROUS_EXT) {
    if (name.endsWith(ext)) {
      return { threat: true, level: "warn", reason: "Исполняемый или скриптовый файл. Он не будет запущен" };
    }
  }
  return { threat: false, level: "ok", reason: "" };
}

function scanDownloadFile(filePath, filename, sourceUrl) {
  const byName = inspectDownloadName(filename, sourceUrl);
  let sample = "";
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, "r");
    head = Buffer.alloc(8192);
    const n = fs.readSync(fd, head, 0, 8192, 0);
    fs.closeSync(fd);
    head = head.slice(0, n);
    sample = head.toString("utf8");
  } catch (_) {}

  if (sample.includes(EICAR)) {
    return { threat: true, level: "block", reason: "Обнаружена тестовая сигнатура EICAR" };
  }
  const ext = path.extname(String(filename || "")).toLowerCase();
  const looksDoc = DOC_EXT.has(ext.slice(1));
  const mz = head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
  if (looksDoc && (mz || /<script|powershell|cmd\.exe|wscript/i.test(sample))) {
    return { threat: true, level: "block", reason: "Файл назван документом, но содержит исполняемый код" };
  }
  if (byName.threat) return byName;
  return { threat: false, level: "ok", reason: "Угроз не найдено" };
}

function permissionDecision(isAppUi, permission) {
  const perm = String(permission || "");
  if (isAppUi) {
    if (perm === "media" || perm === "microphone" || perm === "audioCapture" || SAFE_SITE_PERMISSIONS.has(perm) || ASK_SITE_PERMISSIONS.has(perm)) {
      return "allow";
    }
    return "deny";
  }
  if (SAFE_SITE_PERMISSIONS.has(perm)) return "allow";
  if (ASK_SITE_PERMISSIONS.has(perm)) return "ask";
  return "deny";
}

function note(kind) {
  if (stats[kind] != null) stats[kind] += 1;
}

function getStats() {
  return {
    ...stats,
    feedHosts,
    feedSource,
    feedLoadedAt,
    localRules: LOCAL_BAD_HOSTS.length + BRANDS.length
  };
}

function rememberHosts(hosts) {
  let added = 0;
  for (const host of hosts) {
    if (!host || host.length < 4 || isOfficialHost(host)) continue;
    if (!badHosts.has(host)) {
      badHosts.add(host);
      added += 1;
    }
    if (badHosts.size > 80000) break;
  }
  feedHosts = Math.max(0, badHosts.size - LOCAL_BAD_HOSTS.length);
  return added;
}

function parseHostFile(text) {
  const hosts = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const bits = trimmed.split(/\s+/);
    const host = (bits[1] || bits[0] || "").replace(/\.$/, "").toLowerCase();
    if (host && host !== "0.0.0.0" && host !== "localhost" && !host.includes(":")) hosts.push(host);
  }
  return hosts;
}

function fetchText(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("http://") ? http : https;
    const req = lib.get(url, {
      headers: { "User-Agent": "ProtonShield/1.0" },
      timeout: 12000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        fetchText(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          req.destroy(new Error("Слишком большой список"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

async function loadBlocklist(userDataDir) {
  const cachePath = path.join(userDataDir, "shield-urlhaus-hosts.txt");
  try {
    if (fs.existsSync(cachePath)) {
      const cached = fs.readFileSync(cachePath, "utf8");
      const n = rememberHosts(parseHostFile(cached));
      if (n >= 0) feedSource = "сохранённый список URLhaus";
    }
  } catch (_) {}

  try {
    const text = await fetchText("https://urlhaus.abuse.ch/downloads/hostfile/");
    rememberHosts(parseHostFile(text));
    feedSource = "URLhaus";
    feedLoadedAt = Date.now();
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(cachePath, text);
    } catch (_) {}
  } catch (err) {
    if (feedSource === "локальные правила") feedSource = "локальные правила (список не загрузился)";
    return { ok: false, error: err.message, ...getStats() };
  }
  return { ok: true, ...getStats() };
}

function safeFilename(name) {
  const base = path.basename(String(name || "download")).replace(/[\u0000-\u001f\\/]/g, "_").trim();
  return (base || "download").slice(0, 180);
}

function quarantinePath(dir, filename) {
  const id = Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
  return path.join(dir, id + "-" + safeFilename(filename));
}

module.exports = {
  EICAR,
  assessUrl,
  inspectDownloadName,
  scanDownloadFile,
  permissionDecision,
  note,
  getStats,
  loadBlocklist,
  safeFilename,
  quarantinePath,
  hostOf
};
