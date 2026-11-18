const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
// Carica prima il file storico "dotenv", poi il convenzionale ".env" senza
// sovrascrivere variabili già presenti nell'ambiente.
try {
  require('dotenv').config({ path: path.join(__dirname, 'dotenv') });
  require('dotenv').config({ path: path.join(__dirname, '.env'), override: false });
} catch (err) {
  console.warn('[CONFIG] dotenv non disponibile:', err.message);
}

let puppeteer;
try {
  const puppeteerExtra = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
  puppeteer = puppeteerExtra;
} catch (_) {
  puppeteer = require('puppeteer');
}

// ============================================================================
// PROTEZIONE GLOBALE ANTI-CRASH NODE.JS
// ============================================================================
process.on('unhandledRejection', (err) => {
  const msg = err && err.message ? err.message : String(err || '');
  if (/Target closed|Session closed|Protocol error/i.test(msg)) return;
  console.error('[⚠️ UNHANDLED REJECTION]', msg);
});
process.on('uncaughtException', (err) => {
  // Un'eccezione non gestita può lasciare lo stato del processo inconsistente:
  // salva i dati e termina, lasciando al process manager il riavvio pulito.
  console.error('[❌ UNCAUGHT EXCEPTION - USCITA SICURA]', err && err.stack ? err.stack : err);
  try { if (isDataDirty) saveAppDataSync(); } catch (_) {}
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
});

// ============================================================================
// CONFIGURAZIONE GENERALE & PERSISTENZA
// ============================================================================
const STRICT_SOLD_BY_AMAZON = true;
const MIN_PRICE_EURO = 18;
const ANOMALY_MAX_PRICE = 95;
const MIN_CATALOG_RETAIL_EURO = 180;
const DISCOVERY_INTERVAL_MS = 8 * 60 * 60 * 1000;
const EMPTY_DISCOVERY_COOLDOWN_MS = 15 * 60 * 1000;
const BROWSER_RECYCLE_MS = 4 * 60 * 60 * 1000;
const HIBERNATE_AFTER_MISSES = 20;
const HIBERNATE_DURATION_MS = 2 * 60 * 60 * 1000;
const DATA_FILE = path.join(__dirname, 'cacciatore_data.json');
const LEGACY_RULES_FILE = path.join(__dirname, 'regole_custom.json');
const CHROME_PROFILE_DIR = path.join(__dirname, 'chrome_profile');

const STORES = [
  { code: 'IT', domain: 'amazon.it', keepaId: 8, amazonSellerId: 'A11IL2PNWYJU7H' },
  { code: 'DE', domain: 'amazon.de', keepaId: 3, amazonSellerId: 'A3JWKAKR8XB7XF' },
  { code: 'FR', domain: 'amazon.fr', keepaId: 4, amazonSellerId: 'A1X6FK5RDHNB96' },
  { code: 'ES', domain: 'amazon.es', keepaId: 9, amazonSellerId: 'A1AT7YVPFBWXBL' },
];

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWordBoundaryRegex(words) {
  const escaped = (Array.isArray(words) ? words : [])
    .filter((w) => typeof w === 'string')
    .map((w) => escapeRegex(w.trim()))
    .filter(Boolean);
  // Un elenco vuoto deve significare "nessuna corrispondenza", non matchare
  // accidentalmente qualsiasi confine di parola.
  return escaped.length
    ? new RegExp(`(?:^|[^a-z0-9à-ÿ])(?:${escaped.join('|')})(?:$|[^a-z0-9à-ÿ])`, 'i')
    : /(?!) /;
}

function matchesKeywordExact(text, keyword) {
  if (typeof text !== 'string' || typeof keyword !== 'string' || !keyword.trim()) return false;
  const safeKw = escapeRegex(keyword.trim());
  const re = new RegExp(`(?:^|[^a-z0-9à-ÿ])(?:rtx|rx|gtx)?${safeKw}(?:$|[^a-z0-9à-ÿ])`, 'i');
  return re.test(text);
}

const TRUSTED_BRANDS = [
  'apple', 'iphone', 'ipad', 'macbook', 'mac mini', 'mac studio',
  'asus', 'rog', 'tuf', 'msi', 'gigabyte', 'aorus', 'razer',
  'lenovo', 'legion', 'thinkpad', 'dell', 'alienware',
  'hp', 'omen', 'acer', 'predator', 'microsoft', 'surface',
  'samsung', 'galaxy', 'odyssey', 'lg', 'ultragear', 'sony', 'playstation', 'console playstation', 'ps5',
  'amd', 'ryzen', 'intel', 'nvidia', 'geforce',
  'zotac', 'pny', 'palit', 'gainward', 'inno3d',
  'sapphire', 'xfx', 'asrock', 'powercolor',
  'crucial', 'western digital', 'wd_black', 'wd', 'kingston', 'corsair', 'seagate', 'sandisk'
];
const TRUSTED_BRAND_REGEX = buildWordBoundaryRegex(TRUSTED_BRANDS);

const STRICT_GLOBAL_BLACKLIST = [
  'toner', 'cartuccia', 'cartucce', 'cartridge', 'drum', 'tamburo', 'lexmark', 'ricoh', 'kyocera', 'brother', 'epson', 'canon',
  'pellicola', 'pellicole', 'panzerglas', 'blickschutz',
  'ricambi', 'replacement', 'ersatz', 'rechange', 'repuesto',
  'empty box', 'airtag', 'earpods', 'microsd', 'sdxc', 'chiavetta', 'pen drive', 'flash drive',
  'pasta termica', 'thermal paste', 'dualsense', 'joystick', 'gamepad', 'manette', 'mando',
  'pulse 3d', 'pulse elite', 'pulse explore', 'psvr', 'vr2', 'capture card', 'capturadora', 'scheda di acquisizione',
  'gt 710', 'gt710', 'gt 730', 'gt730', 'gt 1030', 'gt1030', 'gtx 1050', 'gtx 1650',
  'rtx 2060', 'rtx 3050', 'rtx 3060', 'rtx 4060', 'rx 550', 'rx 580', 'rx 6400', 'rx 6500',
  'per macbook', 'for macbook', 'für macbook', 'pour macbook', 'para macbook',
  'per asus', 'for asus', 'für asus', 'pour asus', 'para asus',
  'per rog', 'for rog', 'für rog', 'pour rog', 'para rog',
  'per razer', 'for razer', 'für razer', 'pour razer', 'para razer',
  'per iphone', 'for iphone', 'für iphone', 'pour iphone', 'para iphone',
  'per ipad', 'for ipad', 'für ipad', 'pour ipad', 'para ipad',
  'per galaxy', 'for galaxy', 'für galaxy', 'pour galaxy', 'para galaxy',
  'per lenovo', 'for lenovo', 'für lenovo', 'pour lenovo', 'para lenovo',
  'per msi', 'for msi', 'für msi', 'pour msi', 'para msi',
  'per ps5', 'for ps5', 'für ps5', 'pour ps5', 'para ps5',
  'per playstation', 'for playstation', 'für playstation', 'pour playstation', 'para playstation'
];
const STRICT_GLOBAL_BLACKLIST_REGEX = buildWordBoundaryRegex(STRICT_GLOBAL_BLACKLIST);

const HEAD_ONLY_BLACKLIST = [
  'kompatibel', 'compatibile', 'compatibili', 'compatible', 'designed for',
  'borsa', 'borse', 'bag', 'tasche', 'zaino', 'zaini', 'backpack', 'rucksack',
  'sac à dos', 'sacoche', 'mochila', 'maletín', 'sleeve', 'custodia', 'custodie',
  'case', 'cover', 'hülle', 'coque', 'étui', 'funda', 'carcasa', 'skin', 'sticker', 'adesivo', 'decal',
  'caricabatterie', 'caricatore', 'charger', 'ladegerät', 'chargeur', 'cargador',
  'alimentatore', 'netzteil', 'power supply', 'magsafe', 'cavo', 'cable', 'kabel',
  'adattatore', 'adapter', 'hub', 'dock', '12vhpwr', 'enclosure', 'box esterno',
  'gehäuse', 'boîtier', 'caja externa', 'protector', 'vetro', 'vetri', 'privacy',
  'glass', 'folie', 'verre', 'cristal', 'filtro', 'filter',
  'confezione', 'pack of', 'schrauben', 'screw', 'viti', 'tornillo',
  'lüfter', 'ventola', 'ventole', 'cooling fan', 'cpu fan', 'gpu fan', 'ventilateur', 'ventilador',
  'buchse', 'jack', 'connector', 'connettore', 'anschluss',
  'tastatur', 'keyboard', 'copritastiera', 'clavier', 'teclado',
  'batteria', 'battery', 'akku', 'heatsink', 'dissipatore', 'kühler', 'waterblock',
  'backplate', 'riser', 'staffa', 'bracket', 'halterung', 'supporto', 'stand',
  'piedini', 'tappetino', 'mousepad', 'poster', 'manuale', 'guida', 'scatola',
  'controller', 'portal', 'remote player', 'cuffie', 'headset', 'auriculares',
  'casque', 'kopfhörer', 'auricolari', 'iem', 'piastre', 'faceplate',
  'base verticale', 'vertical stand', 'stazione di ricarica', 'charging station',
  'unità disco', 'disc drive'
];
const HEAD_ONLY_BLACKLIST_REGEX = buildWordBoundaryRegex(HEAD_ONLY_BLACKLIST);

const USED_CONDITION_REGEX = buildWordBoundaryRegex([
  'usato', 'usata', 'usado', 'seconda mano', 'come nuovo', 'ottime condizioni', 'buone condizioni', 'accettabile',
  'gebraucht', 'wie neu', 'sehr gut', 'gut', 'akzeptabel', 'retourenkauf',
  'occasion', 'comme neuf', 'très bon', 'bon', 'acceptable', 'seconde main',
  'segunda mano', 'como nuevo', 'muy bueno', 'bueno', 'aceptable', 'warehouse'
]);

const HIGH_TIER_INDICATORS = [
  '5090', 'rtx5090', '5080', 'rtx5080', '5070', '9070', 'oled', 'qd-oled', 'macbook', 'iphone', 'ipad pro',
  'galaxy s26', 'galaxy s25', 'galaxy s24', 'ryzen 9', 'ryzen 7', 'core ultra 9', 'core ultra 7',
  'x870e', 'z890', '8tb', '96gb', 'rog strix', 'alienware', 'razer blade',
  'legion pro', 'predator', 'odyssey', 'ultragear', 'playstation 5', 'ps5'
];

const VIP_INDICATORS = [
  '5090', 'rtx5090', '5080', 'rtx5080', '5070 ti', '9070 xt', 'ps5 pro', 'playstation 5 pro',
  'macbook pro', 'iphone 18 pro', 'iphone 17 pro', 'ipad pro', 's26 ultra', 's25 ultra', 'oled 4k'
];

const BASE_SMART_RULES = [
  { keywords: ['rtx', '6000'], maxPrice: 3200, label: 'Workstation RTX 6000' },
  { keywords: ['5090'], maxPrice: 1850, label: 'RTX 5090' },
  { keywords: ['5080'], maxPrice: 1050, label: 'RTX 5080' },
  { keywords: ['5070 ti'], maxPrice: 580, label: 'RTX 5070 Ti' },
  { keywords: ['5070ti'], maxPrice: 580, label: 'RTX 5070 Ti' },
  { keywords: ['5070'], maxPrice: 390, label: 'RTX 5070' },
  { keywords: ['9070 xt'], maxPrice: 480, label: 'RX 9070 XT' },
  { keywords: ['9070xt'], maxPrice: 480, label: 'RX 9070 XT' },
  { keywords: ['ps5', 'pro'], maxPrice: 430, label: 'PlayStation 5 Pro' },
  { keywords: ['playstation 5', 'pro'], maxPrice: 430, label: 'PlayStation 5 Pro' },
  { keywords: ['playstation 5', 'digital'], maxPrice: 240, label: 'PlayStation 5 Digital' },
  { keywords: ['ps5', 'digital'], maxPrice: 240, label: 'PlayStation 5 Digital' },
  { keywords: ['playstation 5', 'slim'], maxPrice: 280, label: 'PlayStation 5 Slim' },
  { keywords: ['ps5', 'slim'], maxPrice: 280, label: 'PlayStation 5 Slim' },
  { keywords: ['playstation 5', 'console'], maxPrice: 280, label: 'PlayStation 5 Console' },
  { keywords: ['ps5', 'console'], maxPrice: 280, label: 'PlayStation 5 Console' },
  { keywords: ['iphone', '18', 'pro'], maxPrice: 820, label: 'iPhone 18 Pro / Max' },
  { keywords: ['iphone', 'duo'], maxPrice: 1050, label: 'iPhone Duo' },
  { keywords: ['iphone', '17', 'pro'], maxPrice: 700, label: 'iPhone 17 Pro / Max' },
  { keywords: ['ipad', 'pro'], maxPrice: 640, label: 'iPad Pro' },
  { keywords: ['s26', 'ultra'], maxPrice: 660, label: 'Galaxy S26 Ultra' },
  { keywords: ['strix', 'scar'], maxPrice: 1200, label: 'ASUS ROG Strix SCAR' },
  { keywords: ['razer', 'blade'], maxPrice: 1200, label: 'Razer Blade' },
  { keywords: ['msi', 'titan'], maxPrice: 1350, label: 'MSI Titan HX' },
  { keywords: ['msi', 'raider'], maxPrice: 1200, label: 'MSI Raider HX' },
  { keywords: ['legion', 'pro 7'], maxPrice: 1150, label: 'Lenovo Legion Pro 7' },
  { keywords: ['legion', '9i'], maxPrice: 1350, label: 'Lenovo Legion 9i' },
  { keywords: ['macbook', 'pro'], maxPrice: 980, label: 'MacBook Pro' },
  { keywords: ['x870e'], maxPrice: 115, label: 'Scheda Madre X870E' },
  { keywords: ['z890'], maxPrice: 105, label: 'Scheda Madre Z890' },
  { keywords: ['crosshair'], maxPrice: 180, label: 'ASUS ROG Crosshair' },
  { keywords: ['maximus'], maxPrice: 180, label: 'ASUS ROG Maximus' },
  { keywords: ['9100 pro', '4tb'], maxPrice: 245, label: 'SSD M.2 Samsung 9100 Pro 4TB' },
  { keywords: ['sn8100', '4tb'], maxPrice: 245, label: 'SSD M.2 WD SN8100 4TB' },
  { keywords: ['t710', '4tb'], maxPrice: 245, label: 'SSD M.2 Crucial T710 4TB' },
  { keywords: ['t705', '4tb'], maxPrice: 225, label: 'SSD M.2 Crucial T705 4TB' },
  { keywords: ['990 pro', '4tb'], maxPrice: 175, label: 'SSD M.2 Samsung 990 Pro 4TB' },
  { keywords: ['sn850x', '4tb'], maxPrice: 175, label: 'SSD M.2 WD SN850X 4TB' },
  { keywords: ['ssd', '8tb'], maxPrice: 380, label: 'SSD M.2 NVMe 8TB' },
  { keywords: ['ddr5', '64gb'], maxPrice: 125, label: 'RAM DDR5 64GB' },
  { keywords: ['ddr5', '96gb'], maxPrice: 180, label: 'RAM DDR5 96GB' },
  { keywords: ['oled', '4k'], maxPrice: 480, label: 'Monitor OLED 4K' },
  { keywords: ['qd-oled', '4k'], maxPrice: 460, label: 'Monitor QD-OLED 4K' },
  { keywords: ['qd-oled', '32'], maxPrice: 460, label: 'Monitor QD-OLED 32"' },
  { keywords: ['qd-oled'], maxPrice: 250, label: 'Monitor QD-OLED' },
  { keywords: ['9950x3d'], maxPrice: 330, label: 'Ryzen 9 9950X3D' },
  { keywords: ['9800x3d'], maxPrice: 300, label: 'Ryzen 7 9800X3D' },
  { keywords: ['285k'], maxPrice: 300, label: 'Intel Core Ultra 9 285K' },
  { keywords: ['rog ally'], maxPrice: 340, label: 'ASUS ROG Ally' },
  { keywords: ['legion go'], maxPrice: 340, label: 'Lenovo Legion Go' },
];

// ============================================================================
// STATO PERSISTENTE SU FILE E MAPPE IN MEMORIA
// ============================================================================
let appData = loadAppData();
let isDataDirty = false;
let isSavingAsync = false;
let pendingSaveAfterCurrent = false;
let isPaused = Boolean(appData.isPaused);
let onlyUsedMode = Boolean(appData.onlyUsedMode);
let manualTurboMode = Boolean(appData.manualTurboMode);
let autoMidnightTurbo = true;
let activeBrowser = null;
let isIntentionalRecycle = false;
let isLaunchingBrowser = false;
let watchdogFails = 0;
let pendingAction = null;
let isDiscoveringNow = false;
let lastDiscoveryAttemptTs = 0;
let forceDiscoveryFlag = false;
let isCommandRunning = false;
let commandRunningSinceTs = 0;

const storePages = new Map();
let commandPage = null;
let discoveryPage = null;

const workerLastProgressTs = new Map();
const storeLastValidPriceTs = new Map();
const storeBlindAlertSent = new Set();
const storeBackoffFactor = new Map();

const seenDeals = new Map();
const mutedAsins = new Map();
const lastSearchCache = new Map();
const lastBlockAlert = new Map();
const lastSessionPrices = new Map();
const missCounters = new Map();
const hibernateUntil = new Map();
const notified404Asins = new Set();

const stats = {
  startTime: Date.now(),
  scannedPages: { IT: 0, DE: 0, FR: 0, ES: 0 },
  directAodChecks: 0,
  alertsSent: 0,
  shield503Count: 0,
  captchaCount: 0,
  yellowBtnBypassed: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
function withTimeout(promise, ms, label = 'operation timeout') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
function getStoreBackoff(storeCode) {
  return storeBackoffFactor.get(storeCode) || 1.0;
}
function bumpStoreBackoff(storeCode, step = 0.5) {
  const cur = storeBackoffFactor.get(storeCode) || 1.0;
  storeBackoffFactor.set(storeCode, Math.min(3.0, Math.round((cur + step) * 100) / 100));
}
function relaxStoreBackoff(storeCode) {
  const cur = storeBackoffFactor.get(storeCode) || 1.0;
  if (cur > 1.0) {
    storeBackoffFactor.set(storeCode, Math.max(1.0, Math.round((cur - 0.1) * 100) / 100));
  }
}
async function tryAcquireCommandLock() {
  if (isCommandRunning && Date.now() - commandRunningSinceTs < 45000) {
    await sendTelegram('⏳ Un altro comando su Chrome è già in esecuzione, riprova tra 5 secondi.');
    return false;
  }
  if (isCommandRunning && commandPage && !commandPage.isClosed()) {
    await commandPage.close().catch(() => {});
    commandPage = null;
  }
  isCommandRunning = true;
  commandRunningSinceTs = Date.now();
  return true;
}
function releaseCommandLock() {
  isCommandRunning = false;
  commandRunningSinceTs = 0;
}

function loadAppData() {
  const defaultState = {
    minDiscountPercent: 50,
    minEuroSavings: 220,
    warehousePromoPercent: 0,
    smartNightMode: true,
    pcBeepEnabled: true,
    isPaused: false,
    onlyUsedMode: false,
    manualTurboMode: false,
    lastDiscoveryTs: 0,
    discoveredCatalog: [],
    customRules: [],
    customBlacklist: [],
    bannedAsins: [],
    watchlistAsins: [],
    priceHistory: {},
    recentAlerts: [],
  };

  let loadedFrom = null;
  try {
    if (fs.existsSync(DATA_FILE)) {
      loadedFrom = DATA_FILE;
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('La radice del file dati non è un oggetto JSON');
      }
      const state = { ...defaultState, ...parsed };
      for (const key of ['discoveredCatalog', 'customRules', 'customBlacklist', 'bannedAsins', 'watchlistAsins', 'recentAlerts']) {
        if (!Array.isArray(state[key])) state[key] = [];
      }
      if (!state.priceHistory || typeof state.priceHistory !== 'object' || Array.isArray(state.priceHistory)) state.priceHistory = {};
      state.minDiscountPercent = clampNumber(state.minDiscountPercent, 10, 95, 50);
      state.minEuroSavings = clampNumber(state.minEuroSavings, 10, 100000, 220);
      state.warehousePromoPercent = clampNumber(state.warehousePromoPercent, 0, 60, 0);
      state.smartNightMode = state.smartNightMode !== false;
      state.pcBeepEnabled = state.pcBeepEnabled !== false;
      state.isPaused = Boolean(state.isPaused);
      state.onlyUsedMode = Boolean(state.onlyUsedMode);
      state.manualTurboMode = Boolean(state.manualTurboMode);
      return state;
    }
    if (fs.existsSync(LEGACY_RULES_FILE)) {
      loadedFrom = LEGACY_RULES_FILE;
      const legacy = JSON.parse(fs.readFileSync(LEGACY_RULES_FILE, 'utf8'));
      defaultState.customRules = Array.isArray(legacy) ? legacy : [];
    }
  } catch (err) {
    console.error('[⚠️ ERRORE LETTURA JSON] Avvio con configurazione predefinita:', err.message);
    if (loadedFrom && fs.existsSync(loadedFrom)) {
      try { fs.copyFileSync(loadedFrom, `${loadedFrom}.corrupted_${Date.now()}.bak`); } catch (_) {}
    }
  }
  return defaultState;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function saveAppDataSync() {
  try {
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(appData), 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
    isDataDirty = false;
  } catch (err) {
    console.error('[⚠️ ERRORE SALVATAGGIO JSON SYNC]', err.message);
  }
}

async function flushAppDataAsync() {
  if (isSavingAsync) {
    pendingSaveAfterCurrent = true;
    return;
  }
  isSavingAsync = true;
  try {
    const serialized = JSON.stringify(appData);
    const tmpFile = `${DATA_FILE}.tmp`;
    await fs.promises.writeFile(tmpFile, serialized, 'utf8');
    await fs.promises.rename(tmpFile, DATA_FILE);
    isDataDirty = false;
  } catch (err) {
    console.error('[⚠️ ERRORE SALVATAGGIO JSON ASYNC]', err.message);
  } finally {
    isSavingAsync = false;
    if (pendingSaveAfterCurrent) {
      pendingSaveAfterCurrent = false;
      flushAppDataAsync().catch(() => {});
    }
  }
}

function saveAppData(immediate = true) {
  isDataDirty = true;
  if (immediate) {
    flushAppDataAsync().catch(() => {});
  }
}

setInterval(() => {
  if (isDataDirty) flushAppDataAsync().catch(() => {});
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of seenDeals.entries()) {
    if (now - ts > 6 * 60 * 60 * 1000) seenDeals.delete(k);
  }
  for (const [k, exp] of mutedAsins.entries()) {
    if (exp <= now) mutedAsins.delete(k);
  }
  for (const [k, exp] of hibernateUntil.entries()) {
    if (exp <= now) {
      hibernateUntil.delete(k);
      missCounters.delete(k);
    }
  }
  if (missCounters.size > 3000) missCounters.clear();
  if (notified404Asins.size > 1000) notified404Asins.clear();
  if (lastSessionPrices.size > 2500) lastSessionPrices.clear();
  if (lastSearchCache.size > 500) lastSearchCache.clear();
}, 30 * 60 * 1000);

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Ricevuto ${signal}: salvataggio dati e chiusura...`);
  try { if (isDataDirty) saveAppDataSync(); } catch (_) {}
  if (activeBrowser) activeBrowser.close().catch(() => {});
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

function playPcCriticalBeep() {
  if (!appData.pcBeepEnabled || process.platform !== 'win32') return;
  try {
    exec(
      'powershell -NoProfile -Command "[console]::beep(1200,200);[console]::beep(1600,200);[console]::beep(2000,400)"'
    );
  } catch (_) {}
}

function isTurboActive() {
  if (manualTurboMode) return true;
  if (!autoMidnightTurbo) return false;
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return (h === 23 && m >= 55) || (h === 0 && m <= 25);
}

function isQuietNightHours() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return (h === 1 && m >= 30) || (h >= 2 && h <= 6) || (h === 7 && m <= 30);
}

function isAsinMuted(storeCode, asin) {
  const exp = mutedAsins.get(`${storeCode}_${asin}`) || 0;
  return exp > Date.now();
}

function getAllRules() {
  return [...BASE_SMART_RULES, ...appData.customRules].filter(
    (r) => r && Array.isArray(r.keywords) && r.keywords.length > 0 &&
      Number.isFinite(Number(r.maxPrice)) && Number(r.maxPrice) > 0
  );
}

let cachedCustomBlacklistKey = '';
let cachedCustomBlacklistRegex = /(?!) /;

function getCustomBlacklistRegex() {
  const key = appData.customBlacklist.join('|');
  if (key !== cachedCustomBlacklistKey) {
    cachedCustomBlacklistKey = key;
    cachedCustomBlacklistRegex = buildWordBoundaryRegex(appData.customBlacklist);
  }
  return cachedCustomBlacklistRegex;
}

function isBannedTitle(lowerTitle) {
  if (STRICT_GLOBAL_BLACKLIST_REGEX.test(lowerTitle)) return true;
  if (HEAD_ONLY_BLACKLIST_REGEX.test(lowerTitle.slice(0, 48))) return true;
  if (appData.customBlacklist.length > 0 && getCustomBlacklistRegex().test(lowerTitle)) return true;
  return false;
}

function isBannedAsin(asin) {
  return appData.bannedAsins.some((b) => b && b.asin === asin);
}

function startsWithTrustedBrand(lowerTitle) {
  const head = lowerTitle.slice(0, 42);
  return TRUSTED_BRAND_REGEX.test(head);
}

function isHighTierProduct(lowerTitle) {
  return HIGH_TIER_INDICATORS.some((ind) => matchesKeywordExact(lowerTitle, ind));
}

function isVipEntry(entry) {
  if (entry.isManual) return true;
  const lower = entry.title.toLowerCase();
  return VIP_INDICATORS.some((ind) => matchesKeywordExact(lower, ind));
}

// Estrae chi segue l'etichetta Venditore senza farsi ingannare da "Speditore Amazon" su venditori terzi FBA
function isAmazonSellerText(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const lower = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const sellerMatch = lower.match(
    /(?:venditore|verkäufer|vendeur|vendedor|seller|venduto e spedito da|venduto da|sold and dispatched by|sold by|vendu par|vendido por)\s*[:/]?\s*(.*)$/i
  );
  if (sellerMatch && sellerMatch[1].trim()) {
    return /^amazon(?:\b|\.)/.test(sellerMatch[1].trim());
  }
  // Se non c'è etichetta Venditore ma compare un riferimento alla sola spedizione/logistica, scarta
  if (/spedizione|spedito|dispatched|ships from|versand|expédié|livraison|enviado|envío/i.test(lower)) {
    return false;
  }
  const merchantOnly = lower.replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^amazon(?:\s+(?:seconda\s+mano|retourenkauf|seconde\s+main|segunda\s+mano|warehouse|resale|eu|services|europe|business|digital|it|de|fr|es|com|sàrl|sarl|s|à|r|l|ltd|inc|gmbh|sas|sa|limited))*\s*$/i.test(merchantOnly);
}

// ============================================================================
// CREAZIONE SCHEDA CHROME TURBO
// ============================================================================
async function createFastPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  try {
    const client = await page.createCDPSession();
    await client.send('Network.enable', {
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
      maxPostDataSize: 0,
    });
    await client.send('Network.setBlockedURLs', {
      urls: [
        '*.jpg', '*.jpeg', '*.png', '*.webp', '*.gif', '*.svg', '*.ico',
        '*.mp4', '*.webm', '*.woff', '*.woff2', '*.ttf', '*.eot'
      ],
    });
  } catch (_) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  }
  return page;
}

async function getStoreDedicatedPage(storeCode) {
  if (!activeBrowser) return null;
  try {
    let page = storePages.get(storeCode);
    if (!page || page.isClosed()) {
      page = await createFastPage(activeBrowser);
      storePages.set(storeCode, page);
    }
    return page;
  } catch (_) {
    return null;
  }
}

async function getCommandPage() {
  if (!activeBrowser) return null;
  try {
    if (!commandPage || commandPage.isClosed()) {
      commandPage = await createFastPage(activeBrowser);
    }
    return commandPage;
  } catch (_) {
    return null;
  }
}

async function getDiscoveryPage() {
  if (!activeBrowser) return null;
  try {
    if (!discoveryPage || discoveryPage.isClosed()) {
      discoveryPage = await createFastPage(activeBrowser);
    }
    return discoveryPage;
  } catch (_) {
    return null;
  }
}

// ============================================================================
// AUTO-SUPERAMENTO SCHERMATA GIALLA & RILEVAMENTO CAPTCHA
// ============================================================================
async function handleAmazonInterstitial(page, storeCode) {
  if (!page || page.isClosed()) return { bypassed: false, isCaptcha: false };
  try {
    const status = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
      const hasProductElements = !!document.querySelector(
        'div[data-component-type="s-search-result"], #aod-offer, #aod-pinned-offer, #corePriceDisplay_feature_div, #productTitle'
      );
      if (hasProductElements) return { action: 'NONE' };

      const triggers = [
        'continua con gli acquisti',
        'continue shopping',
        'weiter shoppen',
        'continuer vos achats',
        'seguir comprando',
      ];
      if (triggers.some((t) => bodyText.includes(t))) {
        const btn =
          document.querySelector('form[action*="validateCaptcha"] button') ||
          document.querySelector('form[action*="validateCaptcha"] input[type="submit"]') ||
          Array.from(document.querySelectorAll('button, a, input[type="submit"]')).find((el) => {
            const txt = (el.innerText || el.value || '').toLowerCase();
            return triggers.some((t) => txt.includes(t));
          });
        if (btn) {
          btn.click();
          return { action: 'CLICKED_YELLOW' };
        }
      }

      if (
        document.querySelector('form[action*="validateCaptcha"], input#captchacharacters') ||
        /inserisci i caratteri|type the characters|zeichen eingeben|saisissez les caractères|introduzca los caracteres/i.test(bodyText)
      ) {
        return { action: 'CAPTCHA' };
      }

      return { action: 'NONE' };
    });

    if (status.action === 'CLICKED_YELLOW') {
      stats.yellowBtnBypassed++;
      console.log(`[🟡 BOTTONE GIALLO ${storeCode}] Click automatico su "Continua con gli acquisti"...`);
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {});
      await sleep(800);
      return { bypassed: true, isCaptcha: false };
    }

    if (status.action === 'CAPTCHA') {
      stats.captchaCount++;
      return { bypassed: false, isCaptcha: true };
    }
  } catch (_) {}
  return { bypassed: false, isCaptcha: false };
}

// ============================================================================
// PARSING PREZZI E COUPON ESATTI
// ============================================================================
function parsePrice(raw) {
  if (raw === null || raw === undefined) return null;
  let cleaned = String(raw).replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.includes('.') && cleaned.includes(',')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    cleaned = parts[parts.length - 1].length === 2
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts[parts.length - 1].length !== 2) {
      cleaned = cleaned.replace(/\./g, '');
    }
  }
  const val = parseFloat(cleaned);
  return Number.isNaN(val) || val <= 0 ? null : val;
}

function extractCouponEuro(couponText, basePrice) {
  if (!couponText || !basePrice || basePrice <= 0) return 0;
  const clean = couponText.replace(/\s+/g, ' ').trim();

  const hasCouponKeyword = /coupon|voucher|buono|buoni|applica|apply|einlösen|appliquer|aplicar|risparmia|save|spare|économisez|ahorra/i.test(clean);
  if (!hasCouponKeyword) return 0;

  if (
    /al mese|per month|monatlich|par mois|al mes|spedizione|delivery|versand|livraison|envío|iscriviti e risparmia|subscribe\s*&\s*save|spar-abo|prévoyez et économisez|suscríbete y ahorra|acquistando\s*[2-9]|buy\s*[2-9]|kaufen sie\s*[2-9]|achetez\s*[2-9]|compra\s*[2-9]/i.test(
      clean
    )
  ) {
    return 0;
  }

  const pctMatch = clean.match(/(\d{1,2})\s*%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10);
    if (pct >= 5 && pct <= 60) {
      return Math.round(basePrice * (pct / 100) * 100) / 100;
    }
  }

  const euroMatch = clean.match(/([0-9.,]+)\s*€|€\s*([0-9.,]+)/);
  if (euroMatch) {
    const rawNum = euroMatch[1] || euroMatch[2];
    const euroVal = parsePrice(rawNum);
    if (euroVal && euroVal > 0 && euroVal < basePrice * 0.70) {
      return euroVal;
    }
  }

  return 0;
}

function extractCheckoutPromoPercent(text) {
  if (!text) return 0;
  const match = text.match(
    /(\d{1,2})\s*%\s*(?:di sconto al check-out|di sconto nel carrello|al check-out|nel carrello|rabatt an der kasse|an der kasse|im einkaufswagen|de réduction au paiement|au paiement|au panier|de remise au panier|de descuento al tramitar|al tramitar|al finalizar|en la cesta)/i
  );
  if (match) {
    const pct = parseInt(match[1], 10);
    if (pct >= 5 && pct <= 60) return pct;
  }
  return 0;
}

// ============================================================================
// STORICO PREZZI E MEDIANA (SEPARATI NUOVO/USATO)
// ============================================================================
function computeMedian(numbers) {
  if (!numbers || numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

function getConditionGrade(condition, isUsedOffer) {
  if (!isUsedOffer) return 'NEW';
  const lower = String(condition || '').toLowerCase();
  if (/come nuovo|like new|wie neu|comme neuf|como nuevo/i.test(lower)) return 'USED_LIKE_NEW';
  if (/ottim|very good|sehr gut|très bon|muy bueno/i.test(lower)) return 'USED_VERY_GOOD';
  if (/buon|good|gut|bon|bueno/i.test(lower)) return 'USED_GOOD';
  if (/accettab|acceptable|akzeptabel|aceptable/i.test(lower)) return 'USED_ACCEPTABLE';
  return 'USED_GENERIC';
}

function recordPricePoint(asin, storeCode, price, condition, isUsedOffer, basePrice = null) {
  if (!asin || !price) return null;
  const existingList = Array.isArray(appData.priceHistory[asin]) ? appData.priceHistory[asin] : null;
  if (existingList) {
    delete appData.priceHistory[asin];
    appData.priceHistory[asin] = existingList;
  } else {
    const keys = Object.keys(appData.priceHistory);
    if (keys.length >= 1200) {
      delete appData.priceHistory[keys[0]];
    }
    appData.priceHistory[asin] = [];
  }

  const list = appData.priceHistory[asin];
  const grade = getConditionGrade(condition, isUsedOffer);
  const sameStoreAndGrade = list.filter(
    (x) =>
      x.store === storeCode &&
      Boolean(x.isUsed) === Boolean(isUsedOffer) &&
      getConditionGrade(x.condition, Boolean(x.isUsed)) === grade
  );
  const prevEntry = sameStoreAndGrade.length > 0 ? sameStoreAndGrade[sameStoreAndGrade.length - 1] : null;
  const effectiveBase = Number.isFinite(Number(basePrice)) && Number(basePrice) > 0 ? Number(basePrice) : price;

  if (
    !prevEntry ||
    prevEntry.price !== price ||
    Date.now() - prevEntry.ts > 30 * 60 * 1000
  ) {
    list.push({
      ts: Date.now(),
      store: storeCode,
      price,
      basePrice: effectiveBase,
      condition: condition || 'Nuovo',
      isUsed: Boolean(isUsedOffer),
    });
    if (list.length > 60) list.shift();
    saveAppData(false);
  }

  const updatedSeries = list.filter(
    (x) =>
      x.store === storeCode &&
      Boolean(x.isUsed) === Boolean(isUsedOffer) &&
      getConditionGrade(x.condition, Boolean(x.isUsed)) === grade
  );
  const prices = updatedSeries.map((x) => x.price);
  const minSeen = Math.min(...prices);
  const maxSeen = Math.max(...prices);
  const avgSeen = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
  const newStoreBasePrices = list
    .filter((x) => !x.isUsed && x.store === storeCode)
    .map((x) => (Number.isFinite(Number(x.basePrice)) && Number(x.basePrice) > 0 ? Number(x.basePrice) : x.price));
  const medianNew = computeMedian(newStoreBasePrices);

  return {
    count: updatedSeries.length,
    newCount: newStoreBasePrices.length,
    minSeen,
    maxSeen,
    avgSeen,
    medianNew,
    prevPrice: prevEntry ? prevEntry.price : null,
  };
}

function checkHistoryOrEuArbitrage(asin, currentStore, currentPrice, isUsedOffer, condition = '') {
  const list = appData.priceHistory[asin];
  if (!list || list.length === 0) return null;

  const cutoff = Date.now() - 72 * 60 * 60 * 1000;
  const targetGrade = getConditionGrade(condition, isUsedOffer);
  const validEntries = list.filter(
    (e) =>
      e.ts >= cutoff &&
      e.price > 0 &&
      Boolean(e.isUsed) === Boolean(isUsedOffer) &&
      (!isUsedOffer || getConditionGrade(e.condition, true) === targetGrade)
  );
  if (validEntries.length === 0) return null;

  let refEntry = validEntries[0];
  for (const e of validEntries) {
    if (e.price > refEntry.price) refEntry = e;
  }

  const requiredDropPct = Math.max(40, appData.minDiscountPercent);
  const dropPct = Math.round(((refEntry.price - currentPrice) / refEntry.price) * 100);

  if (
    refEntry.price >= 350 &&
    dropPct >= requiredDropPct &&
    refEntry.price - currentPrice >= appData.minEuroSavings
  ) {
    return {
      refStore: refEntry.store,
      refPrice: refEntry.price,
      dropPct,
      isSameStore: refEntry.store === currentStore,
    };
  }

  return null;
}

function formatPriceTrendSummary(trend, currentPrice, isUsedOffer) {
  const tipo = isUsedOffer ? 'Usato' : 'Nuovo';
  if (!trend || trend.count <= 1) {
    return `📈 Storico bot (${tipo}): Prima rilevazione (${currentPrice}€)`;
  }
  let diffStr = '';
  if (trend.prevPrice && trend.prevPrice !== currentPrice) {
    const diff = Math.round((currentPrice - trend.prevPrice) * 100) / 100;
    diffStr = diff < 0 ? ` | 📉 ${diff}€ vs prec.` : ` | 📈 +${diff}€ vs prec.`;
  }
  return `📈 Storico (${tipo}, ${trend.count} ril.): Min ${trend.minSeen}€ | Media ${trend.avgSeen}€ | Max ${trend.maxSeen}€${diffStr}`;
}

function getKeepaUrl(storeCode, asin) {
  const st = STORES.find((s) => s.code === storeCode) || STORES[0];
  return `https://keepa.com/#!product/${st.keepaId}-${asin}`;
}

// ============================================================================
// TELEGRAM: TASTIERA DEDICATA, MENU NATIVO E PULSANTI INTERATTIVI
// ============================================================================
const MAIN_REPLY_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Stato' }, { text: '⚡ Turbo Evento' }, { text: '🌙 Notte Smart' }],
    [{ text: '🔗 Aggiungi Link' }, { text: '📦 Lista Catalogo' }],
    [{ text: '🔎 Ricerca & Monitor' }, { text: '🔄 Aggiorna Catalogo' }],
    [{ text: '♻️ Solo Usato' }, { text: '🆕+♻️ Nuovo + Usato' }],
    [{ text: '🎯 Sconto %' }, { text: '🏷️ Promo Usato %' }],
    [{ text: '🚫 Gestisci Ban' }, { text: '➕ Aggiungi Soglia' }],
    [{ text: '📋 Regole & Watchlist' }, { text: '📜 Ultimi Affari' }],
    [{ text: '⏸️ Pausa / ▶️ Avvia' }, { text: '🧪 Test Notifica' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const MENU_BUTTON_LABELS = new Set([
  '📊 Stato',
  '⚡ Turbo Evento',
  '🌙 Notte Smart',
  '🔗 Aggiungi Link',
  '📦 Lista Catalogo',
  '🔎 Ricerca & Monitor',
  '🔄 Aggiorna Catalogo',
  '♻️ Solo Usato',
  '🆕+♻️ Nuovo + Usato',
  '🎯 Sconto %',
  '🏷️ Promo Usato %',
  '🚫 Gestisci Ban',
  '➕ Aggiungi Soglia',
  '📋 Regole & Watchlist',
  '📜 Ultimi Affari',
  '⏸️ Pausa / ▶️ Avvia',
  '🧪 Test Notifica',
]);

function telegramApi(method, payload = null) {
  return new Promise((resolve) => {
    const token = process.env.TELEGRAM_ACCESS_TOKEN;
    if (!token) return resolve(null);

    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: payload ? 'POST' : 'GET',
        timeout: method.startsWith('getUpdates') ? 15000 : 18000,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.ok === false) {
              console.error(`[❌ TELEGRAM RIFIUTA ${method}]`, parsed.description || raw);
            }
            resolve(parsed);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

async function setupTelegramMenu() {
  await telegramApi('setMyCommands', {
    commands: [
      { command: 'menu', description: 'Apri tastiera comandi principali' },
      { command: 'stato', description: 'Stato live, velocità multi-scheda e catalogo' },
      { command: 'test', description: 'Simula allarme completo (Nuovo + Seconda Mano)' },
      { command: 'link', description: 'Inserisci link Amazon nel catalogo (es. /link URL 850)' },
      { command: 'catalogo', description: 'Sfoglia e rimuovi prodotti dal catalogo' },
      { command: 'scopri', description: 'Forza scansione Auto-Discovery nuovi prodotti' },
      { command: 'turbo', description: 'Attiva/Disattiva Modalità Turbo Eventi' },
      { command: 'notte', description: 'Attiva/Disattiva Modalità Notte Smart' },
      { command: 'cerca', description: 'Cerca prodotto in EU e attivalo in monitoraggio' },
      { command: 'sconto', description: 'Cambia % sconto minimo (es. /sconto 50)' },
      { command: 'promo_usato', description: 'Imposta % extra check-out Seconda Mano' },
      { command: 'banna', description: 'Banna parola/prodotto (es. /banna acer)' },
      { command: 'aggiungi', description: 'Aggiungi soglia (es. /aggiungi ps5 pro 400)' },
      { command: 'regole', description: 'Gestisci regole, ban e watchlist' },
    ],
  });
}

async function sendTelegram(text, customReplyMarkup = null, silent = false) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return false;
  const fullText = String(text ?? '');
  // Telegram limita il testo dei messaggi a 4096 caratteri. Spezza in blocchi
  // conservando i ritorni a capo e allega la tastiera soltanto all'ultimo.
  const chunks = [];
  let remaining = fullText;
  while (remaining.length > 3900) {
    let cut = remaining.lastIndexOf('\n', 3900);
    if (cut < 1800) cut = 3900;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  chunks.push(remaining);

  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    const markup = i === chunks.length - 1 ? (customReplyMarkup || MAIN_REPLY_KEYBOARD) : undefined;
    const payload = {
      chat_id: chatId,
      text: chunks[i],
      disable_web_page_preview: true,
      disable_notification: silent,
    };
    if (markup) payload.reply_markup = markup;
    let result = await telegramApi('sendMessage', payload);
    if ((!result || result.ok !== true) && i === chunks.length - 1 && customReplyMarkup) {
      result = await telegramApi('sendMessage', { ...payload, reply_markup: MAIN_REPLY_KEYBOARD });
    }
    if (!result || result.ok !== true) allOk = false;
  }
  return allOk;
}

async function notifyBlock(storeCode, reason) {
  const last = lastBlockAlert.get(storeCode) || 0;
  if (Date.now() - last < 30 * 60 * 1000) return;
  lastBlockAlert.set(storeCode, Date.now());
  await sendTelegram(
    `⚠️ AVVISO BLOCCO [${storeCode}]\n` +
    `Motivo: ${reason}\n` +
    `Azione: Pausa solo sulla scheda ${storeCode}; le altre 3 schede continuano.`,
    null,
    true
  );
}

// ============================================================================
// TEST END-TO-END NOTIFICA AFFARE (NUOVO + SECONDA MANO + OPZIONI PREZZO)
// ============================================================================
async function runSimulatedDealTest() {
  if (!activeBrowser) {
    await sendTelegram('❌ TEST FALLITO: Browser Chrome non avviato.');
    return;
  }
  if (!(await tryAcquireCommandLock())) return;
  try {
    await sendTelegram('🧪 Avvio test completo su pagina reale Amazon (lettura Nuovo + Seconda Mano e invio notifica di prova)...');

    const seenCand = new Set();
    const candidates = [];
    const pushCand = (item) => {
      if (!item || !item.asin || !item.store) return;
      const k = `${item.store}_${item.asin}`;
      if (seenCand.has(k)) return;
      seenCand.add(k);
      const st = STORES.find((s) => s.code === item.store) || STORES[0];
      candidates.push({
        store: st.code,
        domain: item.domain || st.domain,
        asin: item.asin,
        title: item.title || item.asin,
      });
    };

    appData.watchlistAsins.slice(0, 3).forEach(pushCand);
    appData.discoveredCatalog.filter((x) => x.isManual).slice(0, 3).forEach(pushCand);
    pushCand({ store: 'IT', domain: 'amazon.it', asin: 'B0DN7CYYSD', title: 'WD_BLACK SN7100 NVMe SSD 1TB' });
    appData.recentAlerts.slice(-3).reverse().forEach(pushCand);
    appData.discoveredCatalog.filter((x) => x.refRetailPrice).slice(0, 6).forEach(pushCand);

    for (const sample of candidates) {
      const cmdPage = await getCommandPage();
      if (!cmdPage || cmdPage.isClosed()) {
        await sendTelegram('❌ TEST FALLITO: Impossibile aprire la scheda Chrome di test.');
        return;
      }

      const storeObj = STORES.find((s) => s.code === sample.store) || STORES[0];
      const t0 = Date.now();
      const verified = await verifyOfferViaAodOnPage(cmdPage, storeObj.domain, sample.asin, storeObj.code);
      const elapsedMs = Date.now() - t0;

      if (
        verified &&
        !verified.error &&
        !verified.notFound404 &&
        !verified.emptyPage &&
        !verified.noAmazonOffer &&
        !verified.filteredByMode &&
        verified.price > 0 &&
        !verified.is503 &&
        !verified.isCaptcha
      ) {
        const realTitle = verified.pageTitle || sample.title;
        const fakeThreshold = Math.round(verified.price + 50);

        const optionsSummary =
          verified.allAmazonOffers && verified.allAmazonOffers.length > 0
            ? verified.allAmazonOffers
                .map((o) => `  • ${o.condition}: ${o.price}€ (${o.soldBy})`)
                .join('\n')
            : `  • ${verified.condition}: ${verified.price}€ (${verified.soldBy})`;

        await sendTelegram(
          `🔬 RISULTATO SCANSIONE PAGINA [${storeObj.code}] (${elapsedMs} ms):\n` +
          `Opzioni vendute da Amazon rilevate:\n${optionsSummary}\n\n` +
          `Invio ora la notifica di allarme esattamente come la riceverai quando scatta un affare:`
        );

        await dispatchVerifiedDeal({
          store: storeObj,
          asin: sample.asin,
          title: realTitle,
          verified,
          reason: `🧪 TEST NOTIFICA (Simulazione soglia <= ${fakeThreshold}€)`,
          isWarehouseFeed: verified.isUsedOffer,
          isCritical: true,
          isTestRun: true,
        });
        return;
      }
    }

    await sendTelegram('⚠️ Nessuno dei prodotti di test aveva un\'offerta venduta da Amazon attiva in questo momento.');
  } finally {
    releaseCommandLock();
  }
}

// ============================================================================
// INSERIMENTO DIRETTO DI LINK AMAZON NEL CATALOGO (SU SCHEDA DEDICATA)
// ============================================================================
function parseAmazonLinkInput(rawText) {
  const urlMatch = rawText.match(/https?:\/\/(?:www\.)?amazon\.(it|de|fr|es)\/[^\s]+/i);
  if (!urlMatch) return null;

  const fullUrl = urlMatch[0];
  const tld = urlMatch[1].toUpperCase();
  const asinMatch = fullUrl.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/ASIN\/)([A-Z0-9]{10})/i);
  if (!asinMatch) return null;

  const asin = asinMatch[1].toUpperCase();
  const remainder = rawText.replace(fullUrl, '').trim();
  let targetPrice = null;
  if (remainder) {
    const parsedNum = parsePrice(remainder);
    if (parsedNum && parsedNum >= MIN_PRICE_EURO) {
      targetPrice = parsedNum;
    }
  }

  return { storeCode: tld, asin, targetPrice };
}

async function handleAddLinksFromUser(rawText) {
  if (!activeBrowser) {
    await sendTelegram('⚠️ Browser in riavvio, riprova tra 5 secondi.');
    return;
  }
  if (isCommandRunning && Date.now() - commandRunningSinceTs < 45000) {
    await sendTelegram('⏳ Un altro comando su Chrome è già in esecuzione, riprova tra 5 secondi.');
    return;
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsedLinks = [];
  for (const line of lines) {
    const parsed = parseAmazonLinkInput(line);
    if (parsed) parsedLinks.push(parsed);
  }

  if (parsedLinks.length === 0) {
    await sendTelegram(
      '❌ Nessun link Amazon valido trovato.\n\n' +
      'Esempi validi:\n' +
      '• https://www.amazon.it/dp/B0DT6Q3BXM\n' +
      '• https://www.amazon.it/dp/B0DT6Q3BXM 3000'
    );
    return;
  }

  if (!(await tryAcquireCommandLock())) return;
  try {
    await sendTelegram(`⏳ Inserimento istantaneo di ${parsedLinks.length} link Amazon...`);

    for (const entry of parsedLinks) {
      const storeObj = STORES.find((s) => s.code === entry.storeCode) || STORES[0];
      const cmdPage = await getCommandPage();
      const verified = cmdPage
        ? await verifyOfferViaAodOnPage(cmdPage, storeObj.domain, entry.asin, storeObj.code)
        : null;

      const hasRealPrice =
        verified &&
        !verified.error &&
        !verified.notFound404 &&
        !verified.emptyPage &&
        !verified.noAmazonOffer &&
        !verified.is503 &&
        !verified.isCaptcha &&
        verified.price > 0;
      const cleanTitle = (verified && verified.pageTitle) ? verified.pageTitle : `Prodotto ${entry.asin}`;
      const realRefPrice = hasRealPrice && !verified.isUsedOffer ? verified.price : null;

      appData.bannedAsins = appData.bannedAsins.filter((b) => b.asin !== entry.asin);
      hibernateUntil.delete(`${storeObj.code}_${entry.asin}`);
      missCounters.delete(`${storeObj.code}_${entry.asin}`);
      notified404Asins.delete(`${storeObj.code}_${entry.asin}`);

      const existing = appData.discoveredCatalog.find((x) => x.asin === entry.asin && x.store === storeObj.code);
      if (existing) {
        if (verified && verified.pageTitle) existing.title = verified.pageTitle.slice(0, 120);
        existing.isManual = true;
        if (realRefPrice && (!existing.refRetailPrice || realRefPrice > existing.refRetailPrice)) {
          existing.refRetailPrice = realRefPrice;
        }
      } else {
        appData.discoveredCatalog.unshift({
          asin: entry.asin,
          store: storeObj.code,
          domain: storeObj.domain,
          title: cleanTitle.slice(0, 120),
          refRetailPrice: realRefPrice,
          isManual: true,
          addedTs: Date.now(),
        });
      }

      if (entry.targetPrice) {
        appData.watchlistAsins = appData.watchlistAsins.filter(
          (w) => !(w.asin === entry.asin && w.store === storeObj.code)
        );
        appData.watchlistAsins.push({
          asin: entry.asin,
          store: storeObj.code,
          domain: storeObj.domain,
          title: cleanTitle.slice(0, 120),
          targetPrice: entry.targetPrice,
        });
      }

      saveAppData(true);

      const priceInfo = hasRealPrice
        ? `💰 Miglior prezzo attuale: ${verified.price}€ (${verified.condition})`
        : '💰 Prezzo attuale: in attesa di disponibilità Amazon (monitorato in corsia VIP)';
      const targetInfo = entry.targetPrice
        ? `\n🎯 Soglia Watchlist attiva: <= ${entry.targetPrice}€`
        : `\n🎯 Monitorato per errori di prezzo, soglie e sconto >= ${appData.minDiscountPercent}%`;

      await sendTelegram(
        `✅ LINK AGGIUNTO AL CATALOGO [${storeObj.code}]\n` +
        `📦 ${cleanTitle.slice(0, 110)}\n` +
        `🆔 ASIN: ${entry.asin}\n` +
        `${priceInfo}${targetInfo}`
      );
      await sleep(600);
    }
  } finally {
    releaseCommandLock();
  }
}

// ============================================================================
// ELENCO COMPLETO PRODOTTI CON PULSANTI DI RIMOZIONE DIRETTA SU TELEGRAM
// ============================================================================
function removeProductCompletely(storeCode, asin) {
  const beforeLen = appData.discoveredCatalog.length;
  const removedItem =
    appData.discoveredCatalog.find((x) => x.asin === asin && x.store === storeCode) ||
    appData.discoveredCatalog.find((x) => x.asin === asin);
  appData.discoveredCatalog = appData.discoveredCatalog.filter((x) => x.asin !== asin);
  appData.watchlistAsins = appData.watchlistAsins.filter((w) => w.asin !== asin);
  if (!isBannedAsin(asin)) {
    appData.bannedAsins.push({
      asin,
      store: storeCode,
      title: removedItem ? removedItem.title : asin,
      ts: Date.now(),
    });
  }
  saveAppData(true);
  return appData.discoveredCatalog.length < beforeLen;
}

function buildCatalogPagePayload(pageIndex = 0) {
  const total = appData.discoveredCatalog.length;
  if (total === 0) {
    return {
      text: '📦 Il catalogo è vuoto.\nPremi "🔄 Aggiorna Catalogo" per avviare la scoperta automatica oppure "🔗 Aggiungi Link" per inserire i tuoi link.',
      replyMarkup: MAIN_REPLY_KEYBOARD,
    };
  }

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const start = safePage * pageSize;
  const slice = appData.discoveredCatalog.slice(start, start + pageSize);

  const byStore = { IT: 0, DE: 0, FR: 0, ES: 0 };
  let manualCount = 0;
  for (const item of appData.discoveredCatalog) {
    if (byStore[item.store] !== undefined) byStore[item.store]++;
    if (item.isManual) manualCount++;
  }

  const inlineKeyboard = [];
  let deleteRow = [];

  const rows = slice
    .map((item, idx) => {
      const num = start + idx + 1;
      const badge = item.isManual ? '🔗' : '🤖';
      const watchMatch = appData.watchlistAsins.find((w) => w.asin === item.asin && w.store === item.store);
      const targetTag = watchMatch ? ` | 🎯 <=${watchMatch.targetPrice}€` : '';
      const rifTag = item.refRetailPrice ? `Rif: ${item.refRetailPrice}€` : 'Rif: n/d';

      deleteRow.push({
        text: `🗑️ #${num} [${item.store}]`,
        callback_data: `rmcat_${item.store}_${item.asin}_${safePage}`,
      });
      if (deleteRow.length === 2) {
        inlineKeyboard.push(deleteRow);
        deleteRow = [];
      }

      return `${num}. ${badge} [${item.store}] ${item.title.slice(0, 48)}...\n    🆔 ${item.asin} | ${rifTag}${targetTag}`;
    })
    .join('\n');

  if (deleteRow.length > 0) {
    inlineKeyboard.push(deleteRow);
  }

  const navButtons = [];
  if (safePage > 0) {
    navButtons.push({ text: '⬅️ Prec', callback_data: `catpage_${safePage - 1}` });
  }
  navButtons.push({ text: `📄 Pag. ${safePage + 1}/${totalPages}`, callback_data: 'catnoop' });
  if (safePage < totalPages - 1) {
    navButtons.push({ text: 'Succ ➡️', callback_data: `catpage_${safePage + 1}` });
  }
  inlineKeyboard.push(navButtons);

  const text =
    `📦 ELENCO PRODOTTI MONITORATI (${total} totali)\n` +
    `• IT: ${byStore.IT} | DE: ${byStore.DE} | FR: ${byStore.FR} | ES: ${byStore.ES} | 🔗 Manuali: ${manualCount}\n` +
    `(Tocca "🗑️ #N" qui sotto per rimuovere un prodotto dal monitoraggio)\n\n` +
    `${rows}`;

  return {
    text,
    replyMarkup: { inline_keyboard: inlineKeyboard },
  };
}

async function sendCatalogPage(pageIndex = 0) {
  const payload = buildCatalogPagePayload(pageIndex);
  await sendTelegram(payload.text, payload.replyMarkup);
}

// ============================================================================
// PANNELLI INTERATTIVI DEL MENU TELEGRAM
// ============================================================================
async function sendDiscountPanel() {
  await sendTelegram(
    `🎯 IMPOSTAZIONI SCONTO ANOMALO\n\n` +
    `• Sconto minimo attuale: ${appData.minDiscountPercent}%\n` +
    `• Risparmio minimo in €: ${appData.minEuroSavings}€\n\n` +
    `Tocca una percentuale rapida oppure scrivi un numero (es. 40 oppure 45 200):`,
    {
      inline_keyboard: [
        [
          { text: '35%', callback_data: 'setdisc_35' },
          { text: '40%', callback_data: 'setdisc_40' },
          { text: '50%', callback_data: 'setdisc_50' },
          { text: '60%', callback_data: 'setdisc_60' },
        ],
        [
          { text: '65%', callback_data: 'setdisc_65' },
          { text: '70%', callback_data: 'setdisc_70' },
          { text: '75%', callback_data: 'setdisc_75' },
        ],
      ],
    }
  );
}

async function sendWarehousePromoPanel() {
  await sendTelegram(
    `🏷️ PROMO CHECK-OUT AMAZON SECONDA MANO\n\n` +
    `• Sconto extra forzato attuale: ${appData.warehousePromoPercent}%\n` +
    `Seleziona lo sconto extra da applicare a tutti i resi Seconda Mano:`,
    {
      inline_keyboard: [
        [
          { text: '0% (Solo Auto)', callback_data: 'setwhp_0' },
          { text: '-10% Extra', callback_data: 'setwhp_10' },
        ],
        [
          { text: '-20% Extra', callback_data: 'setwhp_20' },
          { text: '-30% Extra', callback_data: 'setwhp_30' },
        ],
      ],
    }
  );
}

async function sendBanPanel() {
  const inlineRows = [];
  appData.customBlacklist.forEach((word, idx) => {
    inlineRows.push([{ text: `✅ Sblocca parola: "${word}"`, callback_data: `unbanw_${idx}` }]);
  });
  appData.bannedAsins.slice(-20).forEach((b) => {
    inlineRows.push([
      { text: `✅ Sblocca ASIN: ${b.asin} (${b.title.slice(0, 22)}...)`, callback_data: `unbana_${b.asin}` },
    ]);
  });

  const infoWords =
    appData.customBlacklist.length > 0
      ? appData.customBlacklist.map((w) => `• "${w}"`).join('\n')
      : 'Nessuna parola personalizzata bannata.';

  const infoAsins =
    appData.bannedAsins.length > 0
      ? `${appData.bannedAsins.length} ASIN bannati/rimossi.`
      : 'Nessun ASIN bannato.';

  await sendTelegram(
    `🚫 GESTIONE BAN PRODOTTI\n\n` +
    `Parole bannate:\n${infoWords}\n\n` +
    `Prodotti specifici:\n${infoAsins}\n\n` +
    `✍️ Scrivi ora una parola (min. 4 caratteri) da bannare per sempre:`,
    inlineRows.length > 0 ? { inline_keyboard: inlineRows } : MAIN_REPLY_KEYBOARD
  );
}

async function sendRulesAndWatchlistPanel() {
  const inlineRows = [];
  let text = '📋 REGOLE CUSTOM & WATCHLIST ATTIVE\n\n';

  if (appData.customRules.length === 0) {
    text += '• Regole soglia custom: nessuna\n';
  } else {
    text += '🎯 Regole Soglia Custom:\n';
    appData.customRules.forEach((r, i) => {
      text += `${i + 1}. ${r.keywords.join(' ')} <= ${r.maxPrice}€\n`;
      inlineRows.push([{ text: `🗑️ Elimina regola: ${r.keywords.join(' ')}`, callback_data: `delrule_${i}` }]);
    });
  }

  text += '\n';

  if (appData.watchlistAsins.length === 0) {
    text += '• Watchlist con soglia dedicata: vuota (nel catalogo ci sono ' + appData.discoveredCatalog.length + ' prodotti)';
  } else {
    text += '👁️ Prodotti con Soglia Dedicata:\n';
    appData.watchlistAsins.forEach((w, i) => {
      text += `${i + 1}. [${w.store}] ${w.title.slice(0, 35)}... <= ${w.targetPrice}€\n`;
      inlineRows.push([{ text: `🗑️ Rimuovi soglia: ${w.asin}`, callback_data: `delwatch_${i}` }]);
    });
  }

  await sendTelegram(text, inlineRows.length > 0 ? { inline_keyboard: inlineRows } : MAIN_REPLY_KEYBOARD);
}

async function sendPriceHistoryReport(asin, preferredStore = 'IT') {
  const cleanAsin = asin.trim().toUpperCase();
  const list = appData.priceHistory[cleanAsin] || [];
  const st = STORES.find((s) => s.code === preferredStore) || STORES[0];
  const keepaUrl = getKeepaUrl(st.code, cleanAsin);
  const camelUrl = `https://${st.code.toLowerCase()}.camelcamelcamel.com/product/${cleanAsin}`;
  const haggleUrl = `https://www.hagglezon.com/en/s/${cleanAsin}`;

  if (list.length === 0) {
    await sendTelegram(
      `📈 ANDAMENTO PREZZO [${cleanAsin}]\n\n` +
      `Nessuna rilevazione locale salvata ancora.\n` +
      `Consulta i grafici storici completi qui sotto:`,
      {
        inline_keyboard: [
          [
            { text: `📊 Grafico Keepa (${st.code})`, url: keepaUrl },
            { text: '🐫 CamelCamelCamel', url: camelUrl },
          ],
          [{ text: '🌍 Confronto Prezzi EU', url: haggleUrl }],
        ],
      }
    );
    return;
  }

  const prices = list.map((x) => x.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const avgP = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;

  const recentRows = list
    .slice(-8)
    .reverse()
    .map((entry) => {
      const d = new Date(entry.ts);
      const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(
        d.getHours()
      ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `• ${dateStr} [${entry.store}] → ${entry.price}€ (${entry.condition})`;
    })
    .join('\n');

  await sendTelegram(
    `📈 ANDAMENTO PREZZO [${cleanAsin}]\n\n` +
    `📉 Minimo rilevato: ${minP}€\n` +
    `📊 Prezzo medio: ${avgP}€\n` +
    `📈 Massimo rilevato: ${maxP}€\n\n` +
    `Ultime rilevazioni del bot:\n${recentRows}`,
    {
      inline_keyboard: [
        [
          { text: `📊 Grafico Keepa (${st.code})`, url: keepaUrl },
          { text: '🐫 CamelCamelCamel', url: camelUrl },
        ],
        [{ text: '🌍 Confronto Prezzi EU', url: haggleUrl }],
      ],
    }
  );
}

// ============================================================================
// RICERCA LAMPO SU RICHIESTA DA TELEGRAM (CON SCHEDA DEDICATA)
// ============================================================================
async function runOnDemandSearch(query) {
  if (!activeBrowser) {
    await sendTelegram('⚠️ Browser in riavvio, riprova tra 5 secondi.');
    return;
  }
  if (!(await tryAcquireCommandLock())) return;
  try {
    await sendTelegram(`🔎 Ricerca lampo parallela su IT, DE, FR, ES per: "${query}"...`);
    const foundItems = [];

    for (const store of STORES) {
      try {
        const cmdPage = await getCommandPage();
        if (!cmdPage) break;

        const url = `https://www.${store.domain}/s?k=${encodeURIComponent(query)}&rh=p_6%3A${store.amazonSellerId}`;
        await cmdPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 14000 });
        await sleep(800);
        const check = await handleAmazonInterstitial(cmdPage, store.code);
        if (check.isCaptcha) continue;
        if (check.bypassed) {
          await cmdPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 14000 });
          await sleep(800);
        }

        const items = await cmdPage.evaluate(() => {
          return Array.from(document.querySelectorAll('div[data-component-type="s-search-result"]'))
            .slice(0, 10)
            .map((card) => ({
              asin: card.getAttribute('data-asin') || '',
              title: card.querySelector('h2 span')?.textContent.trim() || '',
              couponRaw: card.querySelector('.s-coupon-unclipped, [data-component-type="s-coupon-component"]')?.innerText.trim() || '',
            }));
        });

        let foundInStore = 0;
        for (const it of items) {
          const lower = it.title.toLowerCase();
          if (!it.asin || !it.title || isBannedTitle(lower) || isBannedAsin(it.asin)) continue;
          if (!startsWithTrustedBrand(lower)) continue;

          const activeCmdPage = await getCommandPage();
          if (!activeCmdPage) break;

          const verified = await verifyOfferViaAodOnPage(activeCmdPage, store.domain, it.asin, store.code, it.couponRaw);
          if (
            verified &&
            !verified.error &&
            !verified.notFound404 &&
        !verified.emptyPage &&
            !verified.noAmazonOffer &&
            !verified.filteredByMode &&
            !verified.is503 &&
            !verified.isCaptcha &&
            verified.price > 0
          ) {
            const wasAdded = addToDiscoveredCatalog(it.asin, store.code, store.domain, it.title, verified.isUsedOffer ? null : verified.price);
            const alreadyInCat = !wasAdded && appData.discoveredCatalog.some((x) => x.asin === it.asin && x.store === store.code);
            const catalogBadge = wasAdded
              ? 'aggiunto al catalogo'
              : alreadyInCat
                ? 'già in catalogo'
                : 'non aggiunto al catalogo automatico';
            const cacheKey = `${store.code}_${it.asin}`;
            lastSearchCache.set(cacheKey, {
              asin: it.asin,
              store: store.code,
              domain: store.domain,
              title: it.title,
              price: verified.price,
            });
            foundItems.push({
              store: store.code,
              domain: store.domain,
              asin: it.asin,
              title: it.title,
              price: verified.price,
              condition: verified.condition,
              isUsedOffer: verified.isUsedOffer,
              trend: verified.trend,
              omnibusLow: verified.omnibusLow,
              offeringId: verified.offeringId,
              catalogBadge,
            });
            foundInStore++;
            if (foundInStore >= 3) break;
          }
        }
      } catch (_) {}
      await sleep(700);
    }

    if (foundItems.length === 0) {
      await sendTelegram(`❌ Nessuna offerta venduta da Amazon disponibile al momento per "${query}".`);
      return;
    }

    for (const item of foundItems) {
      const autoTarget = Math.max(18, Math.round(item.price * 0.85));
      const aodUrl = `https://www.${item.domain}/dp/${item.asin}?aod=1`;
      const cartUrl = item.offeringId
        ? `https://www.${item.domain}/gp/aws/cart/add.html?OfferListingId.1=${encodeURIComponent(item.offeringId)}&Quantity.1=1`
        : `https://www.${item.domain}/gp/aws/cart/add.html?ASIN.1=${item.asin}&Quantity.1=1`;
      const trendLine = formatPriceTrendSummary(item.trend, item.price, item.isUsedOffer);
      const omniLine = item.omnibusLow ? `\n📉 Minimo 30gg Amazon: ${item.omnibusLow}€` : '';

      await sendTelegram(
        `🔎 RISULTATO [${item.store}] (${item.catalogBadge})\n` +
        `📦 ${item.title.slice(0, 105)}\n` +
        `💰 Prezzo netto attuale: ${item.price}€ (${item.condition})${omniLine}\n` +
        `${trendLine}\n` +
        `🔗 ${aodUrl}`,
        {
          inline_keyboard: [
            [
              { text: `👁️ Monitora <= ${autoTarget}€ (-15%)`, callback_data: `watch15_${item.store}_${item.asin}_${autoTarget}` },
              { text: '🎯 Scegli Soglia €', callback_data: `watchask_${item.store}_${item.asin}` },
            ],
            [
              { text: '🛒 Carrello Offerta Esatta', url: cartUrl },
              { text: '📈 Storico & Grafici', callback_data: `hist_${item.store}_${item.asin}` },
            ],
          ],
        }
      );
    }
  } finally {
    releaseCommandLock();
  }
}

async function handleRuleAddition(rawInput) {
  const parts = rawInput.trim().split(/\s+/);
  const price = parsePrice(parts.pop());
  const kw = parts.join(' ').toLowerCase();
  if (!kw || !price || price <= 0) {
    await sendTelegram(
      '❌ Formato non valido.\nPremi di nuovo "➕ Aggiungi Soglia" e scrivi nome + prezzo (es. mac mini m4 420).'
    );
    return;
  }
  appData.customRules.push({
    keywords: kw.split(' '),
    maxPrice: price,
    label: `CUSTOM: ${kw.toUpperCase()}`,
  });
  saveAppData(true);
  await sendTelegram(`✅ Regola salvata!\nApplicata ai prodotti in catalogo, watchlist e feed Usato per "${kw}" <= ${price}€.\n(Per aggiungere subito un prodotto specifico usa /link URL ${price})`);
}

async function startTelegramRemote() {
  const allowedChatId = String(process.env.TELEGRAM_CHAT_ID || '');
  const allowedUserId = String(process.env.TELEGRAM_USER_ID || '');
  if (!process.env.TELEGRAM_ACCESS_TOKEN || !allowedChatId) {
    console.warn('[TELEGRAM] Bot remoto disattivato: configura TELEGRAM_ACCESS_TOKEN e TELEGRAM_CHAT_ID.');
    return;
  }
  if (!allowedUserId) {
    console.warn('[SICUREZZA] TELEGRAM_USER_ID non configurato: chiunque nel gruppo autorizzato può inviare comandi. Impostalo per limitare i comandi al tuo account.');
  }

  await setupTelegramMenu();

  let lastUpdateId = 0;
  const init = await telegramApi('getUpdates?offset=-1');
  if (init && init.ok && init.result.length > 0) {
    lastUpdateId = init.result[init.result.length - 1].update_id;
  }

  while (true) {
    try {
      const res = await telegramApi(`getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
      if (res && res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          try {
            lastUpdateId = update.update_id;

            if (update.callback_query) {
              const cb = update.callback_query;
              const cbData = cb.data || '';
              const chatId = cb.message ? String(cb.message.chat.id) : '';
              const callbackUserId = cb.from ? String(cb.from.id) : '';

              if (chatId === allowedChatId && (!allowedUserId || callbackUserId === allowedUserId)) {
                pendingAction = null;

                if (cbData === 'catnoop') {
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id });
                } else if (cbData.startsWith('catpage_')) {
                  const pageIdx = parseInt(cbData.slice(8), 10) || 0;
                  const payload = buildCatalogPagePayload(pageIdx);
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id });
                  if (cb.message) {
                    await telegramApi('editMessageText', {
                      chat_id: chatId,
                      message_id: cb.message.message_id,
                      text: payload.text,
                      disable_web_page_preview: true,
                      reply_markup: payload.replyMarkup,
                    });
                  }
                } else if (cbData.startsWith('rmcat_')) {
                  const [, stCode, asin, pageStr] = cbData.split('_');
                  const pageIdx = parseInt(pageStr, 10) || 0;
                  removeProductCompletely(stCode, asin);
                  await telegramApi('answerCallbackQuery', {
                    callback_query_id: cb.id,
                    text: `🗑️ ${asin} rimosso da tutti gli store!`,
                  });
                  const payload = buildCatalogPagePayload(pageIdx);
                  if (cb.message) {
                    await telegramApi('editMessageText', {
                      chat_id: chatId,
                      message_id: cb.message.message_id,
                      text: payload.text,
                      disable_web_page_preview: true,
                      reply_markup: payload.replyMarkup,
                    });
                  }
                } else if (cbData.startsWith('mute_')) {
                  const key = cbData.slice(5);
                  mutedAsins.set(key, Date.now() + 24 * 60 * 60 * 1000);
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: '🔕 Silenziato su questo store per 24 ore!' });
                } else if (cbData.startsWith('banasin_')) {
                  const [, stCode, asin] = cbData.split('_');
                  removeProductCompletely(stCode, asin);
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: `🚫 ASIN ${asin} rimosso e bannato!` });
                } else if (cbData.startsWith('unbana_')) {
                  const asin = cbData.slice(7);
                  appData.bannedAsins = appData.bannedAsins.filter((b) => b.asin !== asin);
                  saveAppData(true);
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ ASIN ${asin} sbloccato!` });
                  await sendBanPanel();
                } else if (cbData.startsWith('unbanw_')) {
                  const idx = parseInt(cbData.slice(7), 10);
                  if (!Number.isNaN(idx) && appData.customBlacklist[idx]) {
                    const w = appData.customBlacklist.splice(idx, 1)[0];
                    saveAppData(true);
                    await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ "${w}" sbloccata!` });
                    await sendBanPanel();
                  }
                } else if (cbData.startsWith('setdisc_')) {
                  const val = parseInt(cbData.slice(8), 10);
                  if (!Number.isNaN(val) && val >= 10 && val <= 95) {
                    appData.minDiscountPercent = val;
                    saveAppData(true);
                    await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: `🎯 Sconto minimo: ${val}%!` });
                    await sendTelegram(`✅ Sconto minimo aggiornato al ${val}%.`);
                  }
                } else if (cbData.startsWith('setwhp_')) {
                  const val = parseInt(cbData.slice(7), 10);
                  if (!Number.isNaN(val) && val >= 0 && val <= 60) {
                    appData.warehousePromoPercent = val;
                    saveAppData(true);
                    await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: `🏷️ Promo Usato: -${val}%!` });
                    await sendTelegram(
                      val > 0
                        ? `✅ Promo Check-out Seconda Mano impostata al -${val}%!`
                        : '✅ Promo forzato disattivato.'
                    );
                  }
                } else if (cbData.startsWith('hist_')) {
                  const [, stCode, asin] = cbData.split('_');
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: '📈 Caricamento storico...' });
                  await sendPriceHistoryReport(asin, stCode);
                } else if (cbData.startsWith('watch15_')) {
                  const [, stCode, asin, targetStr] = cbData.split('_');
                  const cached = lastSearchCache.get(`${stCode}_${asin}`);
                  const stObj = STORES.find((s) => s.code === stCode) || STORES[0];
                  const targetPrice = parseFloat(targetStr);
                  appData.watchlistAsins = appData.watchlistAsins.filter((w) => !(w.asin === asin && w.store === stCode));
                  appData.watchlistAsins.push({
                    asin,
                    store: stCode,
                    domain: stObj.domain,
                    title: cached ? cached.title : asin,
                    targetPrice,
                  });
                  saveAppData(true);
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: `👁️ Monitoraggio attivo <= ${targetPrice}€!` });
                  await sendTelegram(`👁️ Aggiunto in Watchlist [${stCode}] <= ${targetPrice}€.`);
                } else if (cbData.startsWith('watchask_')) {
                  const [, stCode, asin] = cbData.split('_');
                  pendingAction = { type: 'WATCH_PRICE', meta: { stCode, asin } };
                  await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Inserisci soglia €' });
                  await sendTelegram(`🎯 Scrivi il prezzo massimo in € per ${asin} su [${stCode}]:`);
                } else if (cbData.startsWith('delrule_')) {
                  const idx = parseInt(cbData.slice(8), 10);
                  if (!Number.isNaN(idx) && appData.customRules[idx]) {
                    appData.customRules.splice(idx, 1);
                    saveAppData(true);
                    await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: '🗑️ Regola eliminata!' });
                    await sendRulesAndWatchlistPanel();
                  }
                } else if (cbData.startsWith('delwatch_')) {
                  const idx = parseInt(cbData.slice(9), 10);
                  if (!Number.isNaN(idx) && appData.watchlistAsins[idx]) {
                    appData.watchlistAsins.splice(idx, 1);
                    saveAppData(true);
                    await telegramApi('answerCallbackQuery', { callback_query_id: cb.id, text: '🗑️ Rimosso dalla Watchlist!' });
                    await sendRulesAndWatchlistPanel();
                  }
                }
              }
              continue;
            }

            const msg = update.message;
            if (!msg || !msg.text || String(msg.chat.id) !== allowedChatId) continue;
            if (allowedUserId && (!msg.from || String(msg.from.id) !== allowedUserId)) continue;

            const text = msg.text.trim().replace(/^(\/[a-z0-9_]+)@[a-z0-9_]+/i, '$1');
            const lower = text.toLowerCase();

            if (MENU_BUTTON_LABELS.has(text) || text.startsWith('/')) {
              pendingAction = null;
            }

            if (pendingAction) {
              const action = pendingAction;
              pendingAction = null;

              if (action.type === 'ADD_LINKS') {
                handleAddLinksFromUser(text).catch(() => {});
                continue;
              }
              if (action.type === 'SEARCH') {
                runOnDemandSearch(text).catch(() => {});
                continue;
              }
              if (action.type === 'ADD_RULE') {
                await handleRuleAddition(text);
                continue;
              }
              if (action.type === 'BAN_WORD') {
                const word = lower.trim();
                if (word.length < 4) {
                  await sendTelegram('❌ Parola troppo corta (minimo 4 caratteri, es. "acer" o "palit") per non bloccare titoli validi.');
                } else if (!appData.customBlacklist.includes(word)) {
                  appData.customBlacklist.push(word);
                  const banRe = buildWordBoundaryRegex([word]);
                  appData.discoveredCatalog = appData.discoveredCatalog.filter((x) => !banRe.test(x.title.toLowerCase()));
                  saveAppData(true);
                  await sendTelegram(`🚫 Parola "${word}" bannata e rimossa dal catalogo!`);
                }
                continue;
              }
              if (action.type === 'SET_DISCOUNT') {
                const parts = text.split(/\s+/).map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
                if (parts.length >= 1 && parts[0] >= 10 && parts[0] <= 95) {
                  appData.minDiscountPercent = parts[0];
                  if (parts[1] && parts[1] >= 10) appData.minEuroSavings = parts[1];
                  saveAppData(true);
                  await sendTelegram(`✅ Sconto minimo: ${appData.minDiscountPercent}% | Risparmio: ${appData.minEuroSavings}€`);
                } else {
                  await sendTelegram('❌ Valore non valido. Inserisci una percentuale tra 10 e 95 (es. 45 oppure 45 200).');
                }
                continue;
              }
              if (action.type === 'WATCH_PRICE') {
                const targetPrice = parsePrice(text);
                const { stCode, asin } = action.meta;
                if (targetPrice && targetPrice > 0) {
                  const cached = lastSearchCache.get(`${stCode}_${asin}`);
                  const stObj = STORES.find((s) => s.code === stCode) || STORES[0];
                  appData.watchlistAsins = appData.watchlistAsins.filter((w) => !(w.asin === asin && w.store === stCode));
                  appData.watchlistAsins.push({
                    asin,
                    store: stCode,
                    domain: stObj.domain,
                    title: cached ? cached.title : asin,
                    targetPrice,
                  });
                  saveAppData(true);
                  await sendTelegram(`👁️ Monitoraggio attivato per ${asin} [${stCode}] <= ${targetPrice}€!`);
                }
                continue;
              }
            }

            if (text === '📊 Stato' || lower === '/stato' || lower === '/status') {
              const mins = Math.floor((Date.now() - stats.startTime) / 60000);
              const ramMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
              const turboOn = isTurboActive();
              const speedRate = mins > 0 ? Math.round((stats.directAodChecks / mins) * 60) : 0;
              const sleepingCount = Array.from(hibernateUntil.values()).filter((ts) => ts > Date.now()).length;
              await sendTelegram(
                `📊 STATO CACCIATORE v14.0 PRODUCTION MASTER\n` +
                `• Stato: ${isPaused ? '⏸️ IN PAUSA' : isDiscoveringNow ? '🔍 AUTO-DISCOVERY' : activeBrowser ? '⚡ 4 SCHEDE PARALLELE (IT+DE+FR+ES)' : '🔄 RIAVVIO BROWSER...'}\n` +
                `• Catalogo: ${appData.discoveredCatalog.length} prodotti (${sleepingCount} in letargo 2h)\n` +
                `• Velocità reale: ${turboOn ? '🔥 TURBO EVENTO' : `🚀 ~${speedRate} controlli/ora`}\n` +
                `• Modalità: ${onlyUsedMode ? '♻️ SOLO SECONDA MANO' : '🆕+♻️ NUOVO + SECONDA MANO'}\n` +
                `• Sconto min: ${appData.minDiscountPercent}% (-${appData.minEuroSavings}€) | Errore secco: <=${ANOMALY_MAX_PRICE}€\n` +
                `• Verifiche ?aod=1: ${stats.directAodChecks} | Bottone Giallo: ${stats.yellowBtnBypassed} | 503/Captcha: ${stats.shield503Count}/${stats.captchaCount}\n` +
                `• Offerte inviate: ${stats.alertsSent} | RAM: ${ramMb} MB (${mins} min)`
              );
            } else if (text === '🧪 Test Notifica' || lower === '/test') {
              runSimulatedDealTest().catch(() => {});
            } else if (text === '🔗 Aggiungi Link') {
              pendingAction = { type: 'ADD_LINKS' };
              await sendTelegram(
                '🔗 Incolla uno o più link Amazon (IT, DE, FR, ES) da inserire subito nel catalogo!\n\n' +
                '• Link semplice:\nhttps://www.amazon.it/dp/B0DT6Q3BXM\n' +
                '• Link con prezzo massimo personalizzato:\nhttps://www.amazon.it/dp/B0DT6Q3BXM 3000'
              );
            } else if (lower.startsWith('/link ')) {
              handleAddLinksFromUser(text.slice(6)).catch(() => {});
            } else if (text === '📦 Lista Catalogo' || lower === '/catalogo') {
              await sendCatalogPage(0);
            } else if (text === '🔄 Aggiorna Catalogo' || lower === '/scopri') {
              forceDiscoveryFlag = true;
              await sendTelegram('🔄 Scansione Auto-Discovery programmata: al prossimo passaggio aggiornerò il catalogo su IT, DE, FR, ES!');
            } else if (text === '⚡ Turbo Evento' || lower === '/turbo') {
              manualTurboMode = !manualTurboMode;
              appData.manualTurboMode = manualTurboMode;
              saveAppData(true);
              await sendTelegram(manualTurboMode ? '⚡ MODALITÀ TURBO EVENTO ATTIVATA SU TUTTE E 4 LE SCHEDE!' : '🚀 Modalità Turbo disattivata.');
            } else if (text === '🌙 Notte Smart' || lower === '/notte') {
              appData.smartNightMode = !appData.smartNightMode;
              saveAppData(true);
              await sendTelegram(appData.smartNightMode ? '🌙 Notte Smart ATTIVA (01:30-07:30).' : '🔔 Notte Smart DISATTIVA.');
            } else if (text === '⏸️ Pausa / ▶️ Avvia' || lower === '/pausa' || lower === '/riprendi') {
              if (lower === '/pausa') isPaused = true;
              else if (lower === '/riprendi') isPaused = false;
              else isPaused = !isPaused;
              appData.isPaused = isPaused;
              saveAppData(true);
              await sendTelegram(isPaused ? '⏸️ Radar messo in PAUSA.' : '▶️ Radar ATTIVO su tutte e 4 le schede!');
            } else if (text === '♻️ Solo Usato' || lower === '/solo_usato') {
              onlyUsedMode = true;
              appData.onlyUsedMode = true;
              saveAppData(true);
              await sendTelegram('♻️ Modalità SOLO SECONDA MANO attivata.');
            } else if (text === '🆕+♻️ Nuovo + Usato' || lower === '/tutto') {
              onlyUsedMode = false;
              appData.onlyUsedMode = false;
              saveAppData(true);
              await sendTelegram('🆕+♻️ Modalità COMPLETA attivata.');
            } else if (text === '🔎 Ricerca & Monitor' || lower === '/cerca') {
              pendingAction = { type: 'SEARCH' };
              await sendTelegram('🔎 Scrivi il nome del prodotto da cercare e aggiungere al catalogo (es. RTX 5080 oppure PS5 Pro):');
            } else if (lower.startsWith('/cerca ')) {
              const q = text.slice(7).trim();
              if (q) runOnDemandSearch(q).catch(() => {});
            } else if (lower.startsWith('/sconto ')) {
              const parts = text.slice(8).trim().split(/\s+/).map((x) => Number(x));
              const pct = parts[0];
              const euro = parts[1];
              if (Number.isInteger(pct) && pct >= 10 && pct <= 95 &&
                  (euro === undefined || (Number.isFinite(euro) && euro >= 10 && euro <= 100000))) {
                appData.minDiscountPercent = pct;
                if (euro !== undefined) appData.minEuroSavings = euro;
                saveAppData(true);
                await sendTelegram(`✅ Soglia aggiornata: ${pct}%${euro !== undefined ? ` e ${euro}€` : ''}.`);
              } else {
                await sendTelegram('❌ Uso: /sconto 50 oppure /sconto 50 220 (percentuale 10-95, euro >=10).');
              }
            } else if (lower.startsWith('/banna ')) {
              const word = lower.slice(7).trim();
              if (word.length < 4) {
                await sendTelegram('❌ Specifica una parola di almeno 4 caratteri. Esempio: /banna acer');
              } else if (appData.customBlacklist.includes(word)) {
                await sendTelegram(`ℹ️ "${word}" è già bannata.`);
              } else {
                appData.customBlacklist.push(word);
                const banRe = buildWordBoundaryRegex([word]);
                appData.discoveredCatalog = appData.discoveredCatalog.filter((x) => !banRe.test(String(x.title || '').toLowerCase()));
                saveAppData(true);
                await sendTelegram(`🚫 Parola "${word}" bannata e rimossa dal catalogo.`);
              }
            } else if (lower.startsWith('/aggiungi ')) {
              await handleRuleAddition(text.slice(10));
            } else if (text === '🎯 Sconto %') {
              pendingAction = { type: 'SET_DISCOUNT' };
              await sendDiscountPanel();
            } else if (text === '🏷️ Promo Usato %' || lower === '/promo_usato') {
              await sendWarehousePromoPanel();
            } else if (text === '🚫 Gestisci Ban') {
              pendingAction = { type: 'BAN_WORD' };
              await sendBanPanel();
            } else if (text === '➕ Aggiungi Soglia') {
              pendingAction = { type: 'ADD_RULE' };
              await sendTelegram('➕ Scrivi nome prodotto e prezzo massimo (es. mac mini m4 420):');
            } else if (text === '📋 Regole & Watchlist' || lower === '/regole') {
              await sendRulesAndWatchlistPanel();
            } else if (text === '📜 Ultimi Affari') {
              if (appData.recentAlerts.length === 0) {
                await sendTelegram('📜 Nessun affare registrato ancora.');
              } else {
                const rows = appData.recentAlerts
                  .slice(-10)
                  .reverse()
                  .map((a, i) => {
                    const d = new Date(a.ts);
                    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                    return `${i + 1}. [${hhmm}] [${a.store}] ${a.price}€ (${a.condition})\n   ${a.title.slice(0, 55)}...\n   ${a.url}`;
                  })
                  .join('\n\n');
                await sendTelegram(`📜 ULTIMI 10 AFFARI TROVATI:\n\n${rows}`);
              }
            } else if (lower === '/menu' || lower === '/start' || lower === '/aiuto' || lower === '/help') {
              await sendTelegram('🎛️ Pannello Cacciatore v14.0 Production Master attivo! Premi "🧪 Test Notifica" per simulare un allarme reale.');
            }
          } catch (err) {
            console.error('[⚠️ ERRORE GESTIONE COMANDO TELEGRAM]', err.message);
          }
        }
      }
    } catch (_) {}
    await sleep(1500);
  }
}

// ============================================================================
// FASE 1: AUTO-DISCOVERY CATALOGO HARDWARE REALE
// ============================================================================
function addToDiscoveredCatalog(asin, storeCode, domain, title, retailPrice) {
  if (!asin || !title) return false;
  if (retailPrice !== null && retailPrice < MIN_CATALOG_RETAIL_EURO) return false;
  if (isBannedAsin(asin)) return false;

  const lower = title.toLowerCase();
  if (!startsWithTrustedBrand(lower) || isBannedTitle(lower)) return false;

  const existing = appData.discoveredCatalog.find((x) => x.asin === asin && x.store === storeCode);
  if (existing) {
    if (retailPrice && (!existing.refRetailPrice || retailPrice > existing.refRetailPrice)) {
      existing.refRetailPrice = retailPrice;
    }
    return false;
  }

  appData.discoveredCatalog.push({
    asin,
    store: storeCode,
    domain,
    title: title.slice(0, 120),
    refRetailPrice: retailPrice || null,
    addedTs: Date.now(),
  });

  if (appData.discoveredCatalog.length > 700) {
    const autoIdx = appData.discoveredCatalog.findIndex((x) => !x.isManual);
    if (autoIdx >= 0) appData.discoveredCatalog.splice(autoIdx, 1);
  }
  saveAppData(false);
  return true;
}

async function runAutoDiscoveryPhase() {
  if (isDiscoveringNow || !activeBrowser) return;
  isDiscoveringNow = true;
  forceDiscoveryFlag = false;
  console.log('🔍 [AUTO-DISCOVERY] Avvio costruzione catalogo hardware reale...');

  const neg = '-toner -cartridge -cartuccia -cover -custodia -funda -hulle -coque -cavo -cable -kabel -controller -dualsense -skin -sticker';
  const discoverySeeds = [
    { dept: 'computers', query: `("RTX 5090" | "RTX 5080" | "RTX 5070 Ti" | "RX 9070 XT") ${neg}` },
    { dept: 'computers', query: `("MacBook Pro" | "ROG Strix" | "Razer Blade" | "Legion Pro") ${neg}` },
    { dept: 'computers', query: `("OLED 4K" | "QD-OLED" | "9800X3D" | "9950X3D" | "X870E" | "Z890" | "NVMe 4TB") ${neg}` },
    { dept: 'electronics', query: `("iPhone 18 Pro" | "iPhone 17 Pro" | "iPad Pro" | "Galaxy S26 Ultra") ${neg}` },
    { dept: 'videogames', query: `("PlayStation 5 Pro" | "PlayStation 5 Console" | "PS5 Pro") ${neg}` },
  ];

  let addedTotal = 0;
  let successPages = 0;

  try {
    const page = await getDiscoveryPage();
    if (!page) return;

    for (const store of STORES) {
      for (const seed of discoverySeeds) {
        while (isPaused) await sleep(2000);
        try {
          const url = `https://www.${store.domain}/s?i=${seed.dept}&k=${encodeURIComponent(seed.query)}&rh=p_6%3A${store.amazonSellerId}%2Cp_36%3A18000-`;
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(1000);

          if (resp && resp.status() === 503) {
            stats.shield503Count++;
            console.log(`[🐕 SCUDO 503 ${store.code}] Limite rilevato durante Auto-Discovery: passo allo store successivo...`);
            await notifyBlock(store.code, 'Errore 503 durante Auto-Discovery');
            break;
          }

          const check = await handleAmazonInterstitial(page, store.code);
          if (check.isCaptcha) {
            await notifyBlock(store.code, 'Captcha rilevato durante Auto-Discovery');
            break;
          }
          if (check.bypassed) {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(1000);
          }

          successPages++;

          const cards = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('div[data-component-type="s-search-result"]'))
              .slice(0, 20)
              .map((card) => ({
                asin: card.getAttribute('data-asin') || '',
                title: card.querySelector('h2 span')?.textContent.trim() || '',
                priceRaw: card.querySelector('.a-price:not([data-a-strike="true"]) .a-offscreen')?.textContent.trim() || '',
                oldPriceRaw: card.querySelector('.a-price[data-a-strike="true"] .a-offscreen')?.textContent.trim() || '',
              }));
          });

          for (const c of cards) {
            const p = parsePrice(c.oldPriceRaw) || parsePrice(c.priceRaw);
            if (p && p >= MIN_CATALOG_RETAIL_EURO) {
              if (addToDiscoveredCatalog(c.asin, store.code, store.domain, c.title, p)) {
                addedTotal++;
              }
            }
          }
        } catch (_) {}
        await sleep(randomDelay(3200, 4800));
      }
    }
  } finally {
    if (discoveryPage && !discoveryPage.isClosed()) {
      await discoveryPage.close().catch(() => {});
    }
    discoveryPage = null;
    lastDiscoveryAttemptTs = Date.now();
    if (successPages > 0 || addedTotal > 0) {
      appData.lastDiscoveryTs = Date.now();
      saveAppData(true);
    }
    isDiscoveringNow = false;
    console.log(`✅ [AUTO-DISCOVERY] Completata! Nuovi prodotti aggiunti: +${addedTotal} | Totale catalogo: ${appData.discoveredCatalog.length}`);
  }
}

// ============================================================================
// VERIFICA PROFONDA LIVE (?aod=1 + BUYBOX EU + BOX USATO INLINE + 404)
// ============================================================================
async function verifyOfferViaAodOnPage(aodPage, domain, asin, storeCode, cardCouponRaw = '') {
  if (!aodPage || aodPage.isClosed()) return { error: true };
  if (storeCode) workerLastProgressTs.set(storeCode, Date.now());
  stats.directAodChecks++;
  try {
    const response = await withTimeout(
      aodPage.goto(`https://www.${domain}/dp/${asin}?aod=1`, {
        waitUntil: 'domcontentloaded',
        timeout: 14000,
      }),
      16500,
      'goto timeout'
    );
    if (response && response.status() === 503) {
      stats.shield503Count++;
      return { is503: true };
    }
    if (response && response.status() === 404) {
      return { notFound404: true };
    }

    const check = await withTimeout(handleAmazonInterstitial(aodPage, storeCode), 8000, 'interstitial timeout');
    if (check.isCaptcha) {
      return { isCaptcha: true };
    }
    if (check.bypassed) {
      await withTimeout(
        aodPage.goto(`https://www.${domain}/dp/${asin}?aod=1`, {
          waitUntil: 'domcontentloaded',
          timeout: 14000,
        }),
        16500,
        'goto bypass timeout'
      );
    }

    let hasAodNodes = await aodPage
      .waitForSelector('#aod-offer .a-price .a-offscreen, #aod-pinned-offer .a-price .a-offscreen', {
        timeout: isTurboActive() ? 2200 : 3200,
      })
      .then(() => true)
      .catch(() => false);

    if (hasAodNodes) {
      await sleep(isTurboActive() ? 300 : 500);
    }

    if (!hasAodNodes) {
      const clickedOlp = await aodPage.evaluate(() => {
        const trigger = document.querySelector(
          '#aod-ingress-link, #olpLinkWidget_feature_div a, #usedBuySection a, a[href*="aod=1"], a[href*="/gp/offer-listing/"]'
        );
        if (trigger) {
          trigger.click();
          return true;
        }
        return false;
      });
      if (clickedOlp) {
        await aodPage
          .waitForSelector('#aod-offer .a-price .a-offscreen, #aod-pinned-offer .a-price .a-offscreen', { timeout: 2200 })
          .catch(() => {});
      }
    }

    const aodData = await Promise.race([
      aodPage.evaluate(() => {
      function cleanNodeText(el, stripPrices = false) {
        if (!el) return '';
        const clone = el.cloneNode(true);
        const sel = stripPrices ? 'style, script, noscript, .a-price, .a-offscreen' : 'style, script, noscript';
        clone.querySelectorAll(sel).forEach((n) => n.remove());
        return clone.textContent.replace(/\s+/g, ' ').trim();
      }

      const results = [];
      const titleEl = document.querySelector('#productTitle, #title, h1');
      const pageTitle = cleanNodeText(titleEl);

      if (!pageTitle) {
        return { errorStatus: 'NoTitle' };
      }

      const pageCouponEl = document.querySelector(
        '#vpcButton, [id*="couponBadge"], [data-csa-c-coupon], label[for*="coupon"]'
      );
      const pageCouponText = cleanNodeText(pageCouponEl);

      const centerText = cleanNodeText(document.querySelector('#centerCol, #dp-container'));
      const omniMatch = centerText.match(
        /(?:prezzo più basso negli ultimi 30 giorni|niedrigster preis der letzten 30 tage|plus bas prix des 30 derniers jours|precio más bajo en los últimos 30 días)[^€\d]{0,30}([0-9.,]+\s*€|€\s*[0-9.,]+)/i
      );
      const omnibusRaw = omniMatch ? omniMatch[1] : '';

      const offerNodes = Array.from(document.querySelectorAll('#aod-pinned-offer, #aod-offer'));
      for (const node of offerNodes) {
        const priceEl = node.querySelector('.a-price .a-offscreen');
        const headingEl = node.querySelector('#aod-offer-heading');
        const soldByEl = node.querySelector('#aod-offer-soldBy, .aod-offer-soldBy');
        const nodeCouponEl = node.querySelector('[id*="coupon"], [class*="coupon"], [data-csa-c-coupon], .promoPriceBlockMessage');
        const nodeCouponText = cleanNodeText(nodeCouponEl);
        const nodeText = cleanNodeText(node);
        const cleanCond = cleanNodeText(headingEl, true).slice(0, 60) || 'Nuovo';

        let offeringId = '';
        const atcNode = node.querySelector('[data-aod-atc-action]');
        if (atcNode) {
          try {
            const parsed = JSON.parse(atcNode.getAttribute('data-aod-atc-action'));
            if (parsed && parsed.oid) offeringId = parsed.oid;
          } catch (_) {}
        }
        if (!offeringId) {
          const inputOid = node.querySelector('input[name="offeringID.1"]');
          if (inputOid && inputOid.value) offeringId = inputOid.value;
        }

        results.push({
          priceRaw: priceEl ? priceEl.textContent.trim() : '',
          condition: cleanCond,
          soldBy: cleanNodeText(soldByEl),
          nodeCouponText,
          nodeText,
          offeringId,
        });
      }

      // Ripiego su BuyBox principale e Accordion (supporta anche "Acquista una tantum" e "Speditore / Venditore Amazon")
      if (!results.some((r) => r.soldBy && /amazon/i.test(r.soldBy))) {
        const mainPrice = document.querySelector(
          '#corePriceDisplay_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #newAccordionRow .a-price .a-offscreen, #buybox .a-accordion-active .a-price .a-offscreen, .reinventPriceAccordionT2 .a-price .a-offscreen, #apex_desktop .a-price .a-offscreen, .apexPriceToPay .a-offscreen, #priceblock_ourprice'
        );
        const availabilityText = cleanNodeText(
          document.querySelector('#availability, #deliveryBlockMessage, #mir-layout-DELIVERY_BLOCK')
        );

        const sellerEl = document.querySelector(
          '[offer-display-feature-name="desktop-merchant-info"], #merchantInfoFeature_feature_div, [data-feature-name="merchantInfoFeature"], #tabular-buybox tr[tabular-attribute-name*="Venditore"], #tabular-buybox tr[tabular-attribute-name*="Venduto"], #tabular-buybox tr[tabular-attribute-name*="Sold"], #tabular-buybox tr[tabular-attribute-name*="Verkäufer"], #tabular-buybox tr[tabular-attribute-name*="Vendu"], #tabular-buybox tr[tabular-attribute-name*="Vendeur"], #tabular-buybox tr[tabular-attribute-name*="Vendido"], #tabular-buybox tr[tabular-attribute-name*="Vendedor"], #sellerProfileTriggerId, #merchant-info'
        );
        let sellerText = cleanNodeText(sellerEl);
        // Se sellerEl contiene solo l'etichetta ("Speditore / Venditore") senza il nome, estrae dal blocco BuyBox completo
        if (!sellerText || !/amazon/i.test(sellerText)) {
          const buyboxClean = cleanNodeText(document.querySelector('#desktop_buybox, #buybox, #rightCol, #centerCol'));
          const m = buyboxClean.match(
            /(?:speditore\s*\/\s*venditore|versender\s*\/\s*verkäufer|expéditeur\s*\/\s*vendeur|remitente\s*\/\s*vendedor|venduto e spedito da|venduto da|venditore|sold by|verkauf durch|verkäufer|vendu par|vendeur|vendido por|vendedor)\s*:?\s*([^|•]{2,60})/i
          );
          if (m && m[1].trim()) {
            sellerText = m[1].trim();
          }
        }

        const oidInput = document.querySelector('#offerListingID, input[name="offeringID.1"]');

        const canOrderNow =
          !!document.querySelector(
            '#add-to-cart-button, #add-to-cart-button-ubb, #buy-now-button, input[name="submit.add-to-cart"], input[name="submit.addToCart"], #newAccordionRow'
          ) || /ordina ora|prenota|pre-order|vorbestellen|précommander|reservar/i.test(availabilityText);

        if (mainPrice && sellerText && canOrderNow) {
          const isPreorderOrBackorder =
            /temporaneamente non disponibile|ordina ora|prenota|pre-order|vorbestellen|précommander|reservar/i.test(availabilityText);
          results.push({
            priceRaw: mainPrice.textContent.trim(),
            condition: isPreorderOrBackorder ? 'Nuovo (Pre-ordine / Ordina ora)' : 'Nuovo',
            soldBy: sellerText,
            nodeCouponText: pageCouponText,
            nodeText: availabilityText,
            offeringId: oidInput ? oidInput.value : '',
          });
        }

      }

      // Estrae SEMPRE anche il box inline Usato / Seconda Mano (#usedAccordionRow / #usedBuySection),
      // anche quando il pannello AOD ha caricato solo l'offerta Nuovo principale.
      const usedRow = document.querySelector('#usedAccordionRow, #usedBuySection');
      if (usedRow) {
        const usedPriceEl = usedRow.querySelector('.a-price .a-offscreen');
        const usedHeadingEl = usedRow.querySelector('#usedAccordionRow_header, .a-accordion-row-a11y, h5');
        const usedSellerEl = usedRow.querySelector(
          '[offer-display-feature-name="desktop-merchant-info"], #tabular-buybox tr[tabular-attribute-name*="Venditore"], #tabular-buybox tr[tabular-attribute-name*="Venduto"], #tabular-buybox tr[tabular-attribute-name*="Sold"], #tabular-buybox tr[tabular-attribute-name*="Verkäufer"], #tabular-buybox tr[tabular-attribute-name*="Vendeur"], #tabular-buybox tr[tabular-attribute-name*="Vendedor"], #merchant-info, #sellerProfileTriggerId'
        );
        const usedCleanFull = cleanNodeText(usedRow);
        let usedSellerText = cleanNodeText(usedSellerEl);
        if (!usedSellerText || !/amazon/i.test(usedSellerText)) {
          const um = usedCleanFull.match(
            /(?:speditore\s*\/\s*venditore|versender\s*\/\s*verkäufer|expéditeur\s*\/\s*vendeur|remitente\s*\/\s*vendedor|venduto e spedito da|venduto da|venditore|sold by|verkauf durch|verkäufer|vendu par|vendeur|vendido por|vendedor)\s*:?\s*([^|•]{2,60})/i
          );
          if (um && um[1].trim()) usedSellerText = um[1].trim();
        }

        const usedOid = usedRow.querySelector('input[name="offeringID.1"], #offerListingID');

        if (usedPriceEl && usedSellerText) {
          const rawPriceStr = usedPriceEl.textContent.trim();
          const alreadyHasSameUsed = results.some(
            (r) => r.priceRaw === rawPriceStr && /usat|seconda mano|used|gebraucht|occasion|segunda mano/i.test(r.condition)
          );
          if (!alreadyHasSameUsed) {
            const rawCondFull = usedHeadingEl ? cleanNodeText(usedHeadingEl, true) : 'Seconda Mano';
            const rawCond = rawCondFull.split(/€|\$|£|FREE|Consegna|Livraison|Lieferung|Entrega|Dispatches|Spedizione/i)[0].trim().slice(0, 45) || 'Seconda Mano';
            results.push({
              priceRaw: rawPriceStr,
              condition: `Usato / ${rawCond}`,
              soldBy: usedSellerText,
              nodeCouponText: '',
              nodeText: usedCleanFull,
              offeringId: usedOid ? usedOid.value : '',
            });
          }
        }
      }

      return { results, pageCouponText, omnibusRaw, pageTitle, errorStatus: null };
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 10000)),
    ]);

    if (aodData.errorStatus === 'NoTitle') {
      return { error: true };
    }

    const omnibusLow = parsePrice(aodData.omnibusRaw);

    let bestNewOffer = null;
    let bestUsedOffer = null;
    const allAmazonOffers = [];
    let hasAnyAmazonOffer = false;

    for (const off of aodData.results) {
      const rawPrice = parsePrice(off.priceRaw);
      if (!rawPrice) continue;

      const isSoldByAmazon = isAmazonSellerText(off.soldBy);
      if (STRICT_SOLD_BY_AMAZON && !isSoldByAmazon) continue;

      hasAnyAmazonOffer = true;
      if (rawPrice < MIN_PRICE_EURO) continue;

      const condText = off.condition || 'Nuovo';
      const sellerLower = off.soldBy.toLowerCase();
      const isUsedOffer =
        USED_CONDITION_REGEX.test(condText) || USED_CONDITION_REGEX.test(sellerLower);

      let netPrice = rawPrice;
      let couponEuro = 0;
      let checkoutPromoPct = 0;

      if (!isUsedOffer) {
        const couponSource = `${off.nodeCouponText || ''} ${aodData.pageCouponText} ${cardCouponRaw}`;
        couponEuro = extractCouponEuro(couponSource, rawPrice);
        if (couponEuro > 0) {
          netPrice = Math.max(MIN_PRICE_EURO, Math.round((rawPrice - couponEuro) * 100) / 100);
        }
      } else {
        const autoPromoPct = extractCheckoutPromoPercent(`${off.nodeText} ${aodData.pageCouponText}`);
        checkoutPromoPct = Math.max(autoPromoPct, appData.warehousePromoPercent || 0);
        if (checkoutPromoPct > 0) {
          netPrice = Math.max(MIN_PRICE_EURO, Math.round(rawPrice * (1 - checkoutPromoPct / 100) * 100) / 100);
        }
      }

      allAmazonOffers.push({
        price: netPrice,
        condition: condText,
        soldBy: off.soldBy || 'Amazon',
        isUsedOffer,
      });

      const candidateObj = {
        price: netPrice,
        rawPrice,
        couponEuro,
        checkoutPromoPct,
        omnibusLow,
        condition: condText,
        soldBy: off.soldBy || 'Amazon',
        isUsedOffer,
        offeringId: off.offeringId || '',
        pageTitle: aodData.pageTitle || '',
        allAmazonOffers,
      };

      if (!isUsedOffer) {
        if (!bestNewOffer || netPrice < bestNewOffer.price) {
          bestNewOffer = candidateObj;
        }
      } else {
        if (!bestUsedOffer || netPrice < bestUsedOffer.price) {
          bestUsedOffer = candidateObj;
        }
      }
    }

    const liveNewPrice = bestNewOffer ? bestNewOffer.price : null;

    if (bestNewOffer && storeCode) {
      bestNewOffer.liveNewPrice = liveNewPrice;
      bestNewOffer.trend = recordPricePoint(asin, storeCode, bestNewOffer.price, bestNewOffer.condition, false, bestNewOffer.rawPrice);
    }
    if (bestUsedOffer && storeCode) {
      bestUsedOffer.liveNewPrice = liveNewPrice;
      bestUsedOffer.trend = recordPricePoint(asin, storeCode, bestUsedOffer.price, bestUsedOffer.condition, true, bestUsedOffer.rawPrice);
    }

    const primaryOffer = onlyUsedMode
      ? bestUsedOffer
      : (bestNewOffer && bestUsedOffer
          ? (bestUsedOffer.price < bestNewOffer.price ? bestUsedOffer : bestNewOffer)
          : (bestNewOffer || bestUsedOffer));

    if (primaryOffer) {
      primaryOffer.bestNewOffer = bestNewOffer;
      primaryOffer.bestUsedOffer = bestUsedOffer;
      primaryOffer.liveNewPrice = liveNewPrice;
      primaryOffer.allAmazonOffers = allAmazonOffers;
      primaryOffer.offersToEvaluate = onlyUsedMode
        ? [bestUsedOffer].filter(Boolean)
        : [bestNewOffer, bestUsedOffer].filter(Boolean);
      return primaryOffer;
    }

    if (aodData.results.length > 0) {
      console.log(`[DEBUG AOD ${storeCode} ${asin}] Offerte scartate:`, JSON.stringify(aodData.results));
    }

    if (aodData.results.length === 0) {
      return {
        emptyPage: true,
        pageTitle: aodData.pageTitle || '',
      };
    }

    return {
      noAmazonOffer: !hasAnyAmazonOffer,
      filteredByMode: hasAnyAmazonOffer && onlyUsedMode,
      pageTitle: aodData.pageTitle || '',
    };
  } catch (err) {
    if (!/timeout/i.test(err.message)) {
      await aodPage.close().catch(() => {});
    }
    return { error: true };
  }
}

// ============================================================================
// INVIO NOTIFICA TELEGRAM
// ============================================================================
async function dispatchVerifiedDeal({ store, asin, title, verified, reason, isWarehouseFeed, isCritical, isTestRun = false }) {
  const verifiedKey = `${store.code}_${asin}_${Math.round(verified.price * 100)}_VERIFIED`;

  if (!isTestRun) {
    if (isAsinMuted(store.code, asin)) return false;
    const lastAlert = seenDeals.get(verifiedKey);
    if (lastAlert && Date.now() - lastAlert < 6 * 60 * 60 * 1000) return false;
    const targetIsUsed = Boolean(isWarehouseFeed || verified.isUsedOffer);
    const alreadyAlertedRecently = appData.recentAlerts.some((a) => {
      if (!a || a.store !== store.code || a.asin !== asin) return false;
      if (Date.now() - a.ts >= 6 * 60 * 60 * 1000) return false;
      const entryIsUsed = typeof a.isUsed === 'boolean' ? a.isUsed : USED_CONDITION_REGEX.test(String(a.condition || ''));
      return entryIsUsed === targetIsUsed && verified.price >= a.price * 0.95;
    });
    if (alreadyAlertedRecently) return false;
    seenDeals.set(verifiedKey, Date.now());
    stats.alertsSent++;
  }

  const isUsed = isWarehouseFeed || verified.isUsedOffer;
  const badgeTipo = isUsed ? '♻️ USATO / SECONDA MANO' : '🆕 NUOVO';

  const aodUrl = `https://www.${store.domain}/dp/${asin}?aod=1`;
  const cartUrl = verified.offeringId
    ? `https://www.${store.domain}/gp/aws/cart/add.html?OfferListingId.1=${encodeURIComponent(verified.offeringId)}&Quantity.1=1`
    : `https://www.${store.domain}/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=1`;
  const cartBtnLabel = verified.offeringId
    ? (isUsed ? '🛒 Carrello Diretto Usato' : '🛒 Carrello Offerta Esatta')
    : '🛒 Carrello 1-Click';

  const keepaUrl = getKeepaUrl(store.code, asin);
  const trendLine = formatPriceTrendSummary(verified.trend, verified.price, isUsed);
  const omniLine = verified.omnibusLow ? `\n📉 Minimo 30gg Amazon: ${verified.omnibusLow}€` : '';

  let priceLine = `💰 Prezzo reale: ${verified.price}€`;
  if (verified.couponEuro > 0) {
    priceLine = `💰 Prezzo netto: ${verified.price}€ (Listino ${verified.rawPrice}€ - Coupon ${verified.couponEuro}€)`;
  } else if (verified.checkoutPromoPct > 0) {
    priceLine = `💰 Netto check-out (-${verified.checkoutPromoPct}%): ${verified.price}€ (Esposto: ${verified.rawPrice}€)`;
  } else if (isUsed && verified.liveNewPrice && verified.liveNewPrice > verified.price) {
    const pctOffNew = Math.round(((verified.liveNewPrice - verified.price) / verified.liveNewPrice) * 100);
    priceLine = `💰 Prezzo reale: ${verified.price}€ (Nuovo oggi: ${verified.liveNewPrice}€ | -${pctOffNew}%)`;
  }

  const sendSilently = !isTestRun && Boolean(appData.smartNightMode && isQuietNightHours() && !isCritical);

  if (isCritical) {
    playPcCriticalBeep();
  }

  const msg =
    `🚨 AFFARE VERIFICATO [${store.code}] 🚨\n` +
    `${badgeTipo}${sendSilently ? ' | 🌙 Notte Silenziosa' : ''}\n` +
    `📌 ${reason}\n` +
    `📦 ${title.slice(0, 115)}\n` +
    `${priceLine}${omniLine}\n` +
    `🏷️ Condizione: ${verified.condition}\n` +
    `🏪 ${verified.soldBy}\n` +
    `${trendLine}\n\n` +
    `🔗 ${aodUrl}`;

  console.log(`[✅ VERIFICATO ${store.code}] [${badgeTipo}] ${title.slice(0, 45)} -> ${verified.price}€`);

  const success = await sendTelegram(
    msg,
    {
      inline_keyboard: [
        [
          { text: '🔗 Apri Offerta (?aod=1)', url: aodUrl },
          { text: cartBtnLabel, url: cartUrl },
        ],
        [
          { text: '📈 Andamento Prezzo', callback_data: `hist_${store.code}_${asin}` },
          { text: `📊 Grafico Keepa (${store.code})`, url: keepaUrl },
        ],
        [
          { text: '🔕 Silenzia 24h', callback_data: `mute_${store.code}_${asin}` },
          { text: '🚫 Banna ASIN Per Sempre', callback_data: `banasin_${store.code}_${asin}` },
        ],
      ],
    },
    sendSilently
  );

  if (!success && !isTestRun) {
    seenDeals.delete(verifiedKey);
    stats.alertsSent--;
    return false;
  }

  if (!isTestRun && success) {
    appData.recentAlerts.push({
      ts: Date.now(),
      store: store.code,
      asin,
      title,
      price: verified.price,
      condition: verified.condition,
      isUsed: Boolean(isUsed),
      url: aodUrl,
    });
    if (appData.recentAlerts.length > 15) appData.recentAlerts.shift();
    saveAppData(true);
  }

  return success;
}

// ============================================================================
// VALUTAZIONE ERRORI DI PREZZO (CON WORD BOUNDARY E MEDIANA DI RIFERIMENTO)
// ============================================================================
function evaluateOfferReason(title, asin, storeCode, verified, refRetailPrice) {
  const lowerTitle = String(title || '').toLowerCase();
  const condGrade = getConditionGrade(verified.condition, verified.isUsedOffer);
  const sessionKey = `${storeCode}_${asin}_${condGrade}`;
  const prevSessionPrice = lastSessionPrices.get(sessionKey);
  lastSessionPrices.set(sessionKey, verified.price);

  if (verified.price <= ANOMALY_MAX_PRICE && isHighTierProduct(lowerTitle)) {
    return { text: `💥 ERRORE PREZZO SECCO (${verified.price}€)`, isCritical: true };
  }

  if (prevSessionPrice && prevSessionPrice >= 250 && verified.price <= prevSessionPrice * 0.55) {
    const dropPct = Math.round(((prevSessionPrice - verified.price) / prevSessionPrice) * 100);
    return {
      text: `⚡ ERRORE DI PREZZO / CROLLO IMPROVVISO (-${dropPct}% da ${prevSessionPrice}€)`,
      isCritical: true,
    };
  }

  const histArb = checkHistoryOrEuArbitrage(asin, storeCode, verified.price, verified.isUsedOffer, verified.condition);
  if (histArb) {
    const originTag = histArb.isSameStore ? `storico ${histArb.refStore}` : `EU ${histArb.refStore}`;
    return {
      text: `📉 CROLLO VS ${originTag.toUpperCase()} (-${histArb.dropPct}% da ${histArb.refPrice}€)`,
      isCritical: true,
    };
  }

  // Per il Nuovo, liveNewPrice coincide col prezzo dell'offerta stessa: usarlo azzererebbe ogni sconto!
  const ownNew = verified.isUsedOffer ? verified.liveNewPrice : null;
  const medianNewRef =
    verified.trend && verified.trend.medianNew && (verified.trend.newCount || 0) >= 2
      ? verified.trend.medianNew
      : null;
  const knownNewRef = ownNew || medianNewRef || refRetailPrice || null;

  // Segnale dedicato sotto il minimo storico a 30 giorni di Amazon (Omnibus)
  if (
    verified.omnibusLow &&
    verified.omnibusLow >= 100 &&
    verified.price <= verified.omnibusLow * 0.72 &&
    verified.omnibusLow - verified.price >= Math.min(120, appData.minEuroSavings)
  ) {
    const omniDropPct = Math.round(((verified.omnibusLow - verified.price) / verified.omnibusLow) * 100);
    return {
      text: `📉 SOTTO MINIMO 30GG AMAZON (-${omniDropPct}% vs ${verified.omnibusLow}€)`,
      isCritical: omniDropPct >= 45,
    };
  }

  // Regole personalizzate dell'utente (hanno sempre priorità assoluta)
  const validCustomRules = appData.customRules.filter(
    (r) => r && Array.isArray(r.keywords) && r.keywords.length > 0 && Number.isFinite(Number(r.maxPrice)) && Number(r.maxPrice) > 0
  );
  for (const rule of validCustomRules) {
    if (rule.keywords.every((kw) => matchesKeywordExact(lowerTitle, kw)) && verified.price <= rule.maxPrice) {
      return {
        text: `SOTTO SOGLIA ${rule.label} (<= ${rule.maxPrice}€)`,
        isCritical: verified.price <= rule.maxPrice * 0.65,
      };
    }
  }

  // Regole smart integrate: se conosciamo il prezzo del Nuovo, evitiamo falsi allarmi su resi Usato scontati solo del 10-30%
  for (const rule of BASE_SMART_RULES) {
    if (rule.keywords.every((kw) => matchesKeywordExact(lowerTitle, kw)) && verified.price <= rule.maxPrice) {
      if (knownNewRef && knownNewRef > verified.price) {
        const discVsNew = Math.round(((knownNewRef - verified.price) / knownNewRef) * 100);
        const euroSavedVsNew = Math.round((knownNewRef - verified.price) * 100) / 100;
        if (discVsNew < 35 || euroSavedVsNew < 150) {
          continue;
        }
        return {
          text: `SOTTO SOGLIA ${rule.label} (-${discVsNew}% vs Nuovo ${knownNewRef}€)`,
          isCritical: discVsNew >= 55 || verified.price <= rule.maxPrice * 0.65,
        };
      }
      return {
        text: `SOTTO SOGLIA ${rule.label} (<= ${rule.maxPrice}€)`,
        isCritical: verified.price <= rule.maxPrice * 0.65,
      };
    }
  }

  const effectiveRef = knownNewRef;

  if (effectiveRef && effectiveRef > verified.price) {
    const realDisc = Math.round(((effectiveRef - verified.price) / effectiveRef) * 100);
    if (realDisc >= appData.minDiscountPercent && effectiveRef - verified.price >= appData.minEuroSavings) {
      return {
        text: `SCONTO ANOMALO -${realDisc}% (Nuovo rif.: ${effectiveRef}€)`,
        isCritical: realDisc >= 70,
      };
    }
  }

  return null;
}

async function checkPureWarehouseLatestForStore(store, page) {
  try {
    const neg = '-toner -cartridge -cartuccia -cover -custodia -funda -hulle -coque -cavo -cable -kabel -controller -dualsense -skin -sticker';
    const warehouseBuzz = `("RTX 5090" | "RTX 5080" | "RTX 5070 Ti" | "RX 9070 XT" | "OLED" | "MacBook Pro" | "iPhone 18" | "iPhone 17" | "iPad Pro" | "ROG Strix" | "Razer Blade" | "PlayStation 5 Pro") ${neg}`;
    const url = `https://www.${store.domain}/s?i=warehouse-deals&k=${encodeURIComponent(warehouseBuzz)}&rh=p_36%3A12000-&s=date-desc-rank`;

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 14000 });
    if (resp && resp.status() === 503) {
      stats.shield503Count++;
      return { is503: true };
    }

    const check = await handleAmazonInterstitial(page, store.code);
    if (check.isCaptcha) {
      return { isCaptcha: true };
    }
    if (check.bypassed) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 14000 });
      await sleep(800);
    }

    const items = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('div[data-component-type="s-search-result"]'))
        .slice(0, 12)
        .map((card) => ({
          asin: card.getAttribute('data-asin') || '',
          title: card.querySelector('h2 span')?.textContent.trim() || '',
          priceRaw: card.querySelector('.a-price:not([data-a-strike="true"]) .a-offscreen')?.textContent.trim() || '',
          oldPriceRaw: card.querySelector('.a-price[data-a-strike="true"] .a-offscreen')?.textContent.trim() || '',
        }));
    });

    stats.scannedPages[store.code]++;
    let found = 0;

    for (const item of items) {
      workerLastProgressTs.set(store.code, Date.now());
      if (!item.asin || !item.title || isBannedAsin(item.asin) || isAsinMuted(store.code, item.asin)) continue;
      const lowerTitle = item.title.toLowerCase();
      if (!startsWithTrustedBrand(lowerTitle) || isBannedTitle(lowerTitle)) continue;

      const price = parsePrice(item.priceRaw);
      const oldPrice = parsePrice(item.oldPriceRaw);
      if (!price || price < MIN_PRICE_EURO) continue;

      // Solo il prezzo barrato (oldPrice) è un listino Nuovo affidabile, mai il prezzo Usato della card
      if (oldPrice && oldPrice >= MIN_CATALOG_RETAIL_EURO) {
        addToDiscoveredCatalog(item.asin, store.code, store.domain, item.title, oldPrice);
      }

      const verified = await verifyOfferViaAodOnPage(page, store.domain, item.asin, store.code);
      if (
        !verified ||
        verified.error ||
        verified.notFound404 ||
        verified.noAmazonOffer ||
        verified.filteredByMode ||
        verified.is503 ||
        verified.isCaptcha ||
        !verified.price
      ) {
        continue;
      }

      const candidatesToEval = verified.offersToEvaluate || [verified];
      for (const offerCandidate of candidatesToEval) {
        const reason = evaluateOfferReason(item.title, item.asin, store.code, offerCandidate, oldPrice || null);
        if (reason) {
          const sent = await dispatchVerifiedDeal({
            store,
            asin: item.asin,
            title: item.title,
            verified: offerCandidate,
            reason: reason.text,
            isWarehouseFeed: offerCandidate.isUsedOffer,
            isCritical: reason.isCritical,
          });
          if (sent) found++;
        }
      }
      await sleep(1200);
    }

    console.log(
      `[${new Date().toLocaleTimeString()}] ♻️ [${store.code}] SECONDA MANO ULTIMI ARRIVI -> ${items.length} schede (affari: ${found})`
    );
    return { is503: false };
  } catch (err) {
    console.warn(`[⚠️ WAREHOUSE FEED ${store.code}]`, err.message);
    return { is503: false };
  }
}

async function runStoreParallelWorker(store) {
  let standardCursor = 0;
  let vipCursor = 0;
  let watchCursor = 0;
  let stepCounter = 0;

  const storeIndex = STORES.findIndex((s) => s.code === store.code);
  await sleep(storeIndex * 1200);

  workerLastProgressTs.set(store.code, Date.now());

  while (true) {
    try {
      workerLastProgressTs.set(store.code, Date.now());

      while (isPaused || !activeBrowser) {
        workerLastProgressTs.set(store.code, Date.now());
        await sleep(1500);
      }

      if (isDiscoveringNow) {
        await sleep(2500);
      }

      const page = await getStoreDedicatedPage(store.code);
      if (!page) {
        await sleep(1500);
        continue;
      }

      stepCounter++;
      if (stepCounter % 120 === 0) {
        const oldTab = storePages.get(store.code);
        storePages.delete(store.code);
        if (oldTab && !oldTab.isClosed()) {
          await oldTab.close().catch(() => {});
        }
      }

      // 1. Watchlist dedicata per questo paese (1 prodotto a turno)
      const storeWatch = appData.watchlistAsins.filter(
        (w) => w.store === store.code && !isBannedAsin(w.asin) && !isAsinMuted(store.code, w.asin)
      );
      if (storeWatch.length > 0) {
        const wItem = storeWatch[watchCursor % storeWatch.length];
        watchCursor++;
        const verified = await verifyOfferViaAodOnPage(page, store.domain, wItem.asin, store.code);
        if (verified && (verified.is503 || verified.isCaptcha)) {
          bumpStoreBackoff(store.code, 0.75);
          const reasonMsg = verified.isCaptcha ? 'Captcha rilevato' : 'Errore 503';
          console.log(`[🐕 SCUDO ${store.code}] ${reasonMsg}: pausa 60s solo sulla scheda ${store.code} (backoff ${getStoreBackoff(store.code)}x)...`);
          await notifyBlock(store.code, `${reasonMsg} (pausa automatica 60s)`);
          await sleep(60000);
          continue;
        }
        if (verified && verified.pageTitle && wItem.title.startsWith('Prodotto ')) {
          wItem.title = verified.pageTitle.slice(0, 120);
          saveAppData(false);
        }
        if (
          verified &&
          !verified.error &&
          !verified.emptyPage &&
          !verified.notFound404 &&
          !verified.noAmazonOffer &&
          !verified.filteredByMode &&
          verified.price > 0
        ) {
          storeLastValidPriceTs.set(store.code, Date.now());
          storeBlindAlertSent.delete(store.code);
          const speedLabel = isTurboActive() ? '⚡' : '';
          console.log(
            `[${new Date().toLocaleTimeString()}] ${speedLabel}👁️ [${store.code}] ${wItem.title.slice(0, 40)} -> ${verified.price}€ (${verified.condition} | Soglia: <=${wItem.targetPrice}€)`
          );
          if (verified.price <= wItem.targetPrice) {
            await dispatchVerifiedDeal({
              store,
              asin: wItem.asin,
              title: wItem.title,
              verified,
              reason: `👁️ SOGLIA RAGGIUNTA (<= ${wItem.targetPrice}€)`,
              isWarehouseFeed: verified.isUsedOffer,
              isCritical: verified.price <= ANOMALY_MAX_PRICE,
            });
          } else {
            for (const offerCandidate of (verified.offersToEvaluate || [verified])) {
              const extraReason = evaluateOfferReason(wItem.title, wItem.asin, store.code, offerCandidate, null);
              if (extraReason) {
                await dispatchVerifiedDeal({
                  store,
                  asin: wItem.asin,
                  title: wItem.title,
                  verified: offerCandidate,
                  reason: extraReason.text,
                  isWarehouseFeed: offerCandidate.isUsedOffer,
                  isCritical: extraReason.isCritical,
                });
              }
            }
          }
        } else {
          console.log(
            `[WATCH ${store.code}] ${wItem.asin} nessun match:`,
            verified
              ? {
                  noAmazon: verified.noAmazonOffer,
                  emptyPage: verified.emptyPage,
                  err: verified.error,
                  notFound404: verified.notFound404,
                  mode: verified.filteredByMode,
                }
              : null
          );
        }
        await sleep(isTurboActive() ? randomDelay(1100, 1700) : randomDelay(2200, 3200));
      }

      // 2. Ogni 15 controlli su questo store, controlla gli Ultimi Arrivi Seconda Mano
      if (stepCounter % 15 === 0) {
        const whRes = await checkPureWarehouseLatestForStore(store, page);
        if (whRes && (whRes.is503 || whRes.isCaptcha)) {
          await notifyBlock(store.code, whRes.isCaptcha ? 'Captcha su feed Usato' : 'Errore 503 su feed Usato');
          await sleep(60000);
          continue;
        }
        await sleep(isTurboActive() ? 1400 : 2500);
      }

      // 3. Controllo diretto (?aod=1) con Corsia VIP + Auto-Letargo solo su reale assenza offerte o 404
      const now = Date.now();
      const watchSetForStore = new Set(
        appData.watchlistAsins.filter((w) => w.store === store.code).map((w) => w.asin)
      );
      const eligibleCatalog = appData.discoveredCatalog.filter((x) => {
        if (x.store !== store.code || isBannedAsin(x.asin)) return false;
        if (watchSetForStore.has(x.asin)) return false; // Già controllato nella Watchlist prioritaria
        if (isAsinMuted(store.code, x.asin)) return false;
        const key = `${store.code}_${x.asin}`;
        if (!x.isManual && (hibernateUntil.get(key) || 0) > now) return false;
        return true;
      });

      if (eligibleCatalog.length > 0) {
        const vipList = eligibleCatalog.filter((x) => isVipEntry(x));
        let entry;

        if (vipList.length > 0 && stepCounter % 2 === 0) {
          entry = vipList[vipCursor % vipList.length];
          vipCursor++;
        } else {
          entry = eligibleCatalog[standardCursor % eligibleCatalog.length];
          standardCursor++;
        }

        const key = `${store.code}_${entry.asin}`;
        const verified = await verifyOfferViaAodOnPage(page, store.domain, entry.asin, store.code);

        if (verified && (verified.is503 || verified.isCaptcha)) {
          bumpStoreBackoff(store.code, 0.75);
          const reasonMsg = verified.isCaptcha ? 'Captcha rilevato' : 'Errore 503';
          console.log(`[🐕 SCUDO ${store.code}] ${reasonMsg}: pausa 60s solo sulla scheda ${store.code} (backoff ${getStoreBackoff(store.code)}x)...`);
          await notifyBlock(store.code, `${reasonMsg} (pausa automatica 60s)`);
          await sleep(60000);
          continue;
        }

        if (verified && verified.notFound404) {
          if (!entry.isManual) {
            hibernateUntil.set(key, Date.now() + 12 * 60 * 60 * 1000);
          } else if (!notified404Asins.has(key)) {
            notified404Asins.add(key);
            sendTelegram(`⚠️ Link manuale [${store.code}] ${entry.asin} non trovato su Amazon (HTTP 404).`).catch(() => {});
          }
          await sleep(randomDelay(2200, 3400));
          continue;
        }

        if (verified && verified.pageTitle && entry.title.startsWith('Prodotto ')) {
          entry.title = verified.pageTitle.slice(0, 120);
          saveAppData(false);
        }

        if (
          verified &&
          !verified.error &&
          !verified.emptyPage &&
          !verified.notFound404 &&
          !verified.noAmazonOffer &&
          !verified.filteredByMode &&
          verified.price > 0
        ) {
          relaxStoreBackoff(store.code);
          storeLastValidPriceTs.set(store.code, Date.now());
          storeBlindAlertSent.delete(store.code);
          missCounters.set(key, 0);
          hibernateUntil.delete(key);

          const newBaseForRef = verified.bestNewOffer
            ? (verified.bestNewOffer.rawPrice || verified.bestNewOffer.price)
            : (!verified.isUsedOffer ? (verified.rawPrice || verified.price) : null);
          const newPriceForRef = newBaseForRef;
          if (newPriceForRef) {
            const newTrendObj = verified.bestNewOffer ? verified.bestNewOffer.trend : (!verified.isUsedOffer ? verified.trend : null);
            if (newTrendObj && newTrendObj.medianNew && (newTrendObj.newCount || 0) >= 3) {
              if (entry.refRetailPrice !== newTrendObj.medianNew) {
                entry.refRetailPrice = newTrendObj.medianNew;
                saveAppData(false);
              }
            } else if (!entry.refRetailPrice) {
              entry.refRetailPrice = newPriceForRef;
              saveAppData(false);
            } else if (newPriceForRef > entry.refRetailPrice && newPriceForRef <= entry.refRetailPrice * 1.25) {
              entry.refRetailPrice = newPriceForRef;
              saveAppData(false);
            }
          }

          const speedLabel = isTurboActive() ? '⚡' : '';
          const tagIcon = entry.isManual ? '🔗' : isVipEntry(entry) ? '💎' : '🎯';
          const rifDisplay = entry.refRetailPrice ? `${entry.refRetailPrice}€` : 'n/d';
          console.log(
            `[${new Date().toLocaleTimeString()}] ${speedLabel}${tagIcon} [${store.code}] ${entry.title.slice(0, 40)} -> ${verified.price}€ (${verified.condition} | Rif: ${rifDisplay})`
          );

          for (const offerCandidate of (verified.offersToEvaluate || [verified])) {
            const reason = evaluateOfferReason(
              entry.title,
              entry.asin,
              store.code,
              offerCandidate,
              entry.refRetailPrice
            );

            if (reason) {
              await dispatchVerifiedDeal({
                store,
                asin: entry.asin,
                title: entry.title,
                verified: offerCandidate,
                reason: reason.text,
                isWarehouseFeed: offerCandidate.isUsedOffer,
                isCritical: reason.isCritical,
              });
            }
          }
        } else if (verified && verified.noAmazonOffer && !entry.isManual) {
          const misses = (missCounters.get(key) || 0) + 1;
          if (misses >= HIBERNATE_AFTER_MISSES) {
            hibernateUntil.set(key, Date.now() + HIBERNATE_DURATION_MS);
            missCounters.set(key, 0);
          } else {
            missCounters.set(key, misses);
          }
        }
      }
    } catch (err) {
      console.error(`[⚠️ WORKER ${store.code}] Errore temporaneo recuperato:`, err.message);
      await sleep(3000);
    }

    const baseSleepMs = isTurboActive() ? randomDelay(1100, 1700) : randomDelay(2200, 3400);
    await sleep(Math.round(baseSleepMs * getStoreBackoff(store.code)));
  }
}

async function runDiscoveryCoordinator() {
  while (true) {
    try {
      const now = Date.now();
      const elapsedSinceSuccess = now - (appData.lastDiscoveryTs || 0);
      const elapsedSinceAttempt = now - lastDiscoveryAttemptTs;
      const isEmptyAndCooledDown =
        appData.discoveredCatalog.length === 0 &&
        elapsedSinceSuccess > EMPTY_DISCOVERY_COOLDOWN_MS &&
        elapsedSinceAttempt > EMPTY_DISCOVERY_COOLDOWN_MS;
      const isScheduledDue =
        elapsedSinceSuccess > DISCOVERY_INTERVAL_MS &&
        elapsedSinceAttempt > EMPTY_DISCOVERY_COOLDOWN_MS;

      if (
        !isPaused &&
        activeBrowser &&
        !isDiscoveringNow &&
        (forceDiscoveryFlag || isEmptyAndCooledDown || isScheduledDue)
      ) {
        await runAutoDiscoveryPhase();
      }
    } catch (err) {
      isDiscoveringNow = false;
      console.error('[⚠️ DISCOVERY COORDINATOR]', err.message);
    }
    await sleep(5000);
  }
}

// ============================================================================
// GESTIONE BROWSER CON WATCHDOG DI RIAVVIO AUTOMATICO & ANTI-THROTTLING
// ============================================================================
async function launchBrowserInstance() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: CHROME_PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
    ],
  });

  browser.on('disconnected', () => {
    if (isIntentionalRecycle || activeBrowser !== browser) return;
    console.error('[⚠️ CHROME DISCONNESSO] Rilevata chiusura imprevista di Chrome: riavvio automatico...');
    activeBrowser = null;
    storePages.clear();
    commandPage = null;
    discoveryPage = null;
    ensureBrowserRunning().catch(() => {});
  });

  return browser;
}

async function ensureBrowserRunning() {
  if (isLaunchingBrowser) return;
  isLaunchingBrowser = true;
  try {
    watchdogFails = 0;
    while (!activeBrowser) {
      try {
        activeBrowser = await launchBrowserInstance();
        watchdogFails = 0;
        console.log('✅ Istanza Chrome avviata e collegata.');
      } catch (err) {
        watchdogFails++;
        console.error(`[⚠️ WATCHDOG CHROME] Fallimento ${watchdogFails}/3. Riprovo avvio tra 5s:`, err.message);
        if (watchdogFails === 3) {
          sendTelegram('⚠️ ATTENZIONE: Il browser Chrome ha fallito l\'avvio per 3 volte consecutive sul server!').catch(() => {});
        }
        await sleep(5000);
      }
    }
  } finally {
    isLaunchingBrowser = false;
  }
}

(async () => {
  console.log('================================================================');
  console.log('🚀 CACCIATORE v14.0 PRODUCTION MASTER (IT + DE + FR + ES)');
  console.log('🛡️ Venditore FBA-Safe + Ripiego BuyBox + Usato EU + Diagnostica');
  console.log('================================================================');

  startTelegramRemote();
  await sendTelegram('🚀 Cacciatore v14.0 Production Master avviato! Fix venditore FBA-safe, ripiego BuyBox, usato EU e log diagnostici attivi.');

  await ensureBrowserRunning();

  async function recycleBrowserNow(reasonLabel) {
    if (isIntentionalRecycle || isLaunchingBrowser) return;
    const oldBrowser = activeBrowser;
    isIntentionalRecycle = true;
    try {
      console.log(`🔄 ${reasonLabel}: rigenerazione browser Chrome...`);
      activeBrowser = null;
      storePages.clear();
      commandPage = null;
      discoveryPage = null;
      await sleep(3000);
      if (oldBrowser) await oldBrowser.close().catch(() => {});
      await sleep(1000);
      await ensureBrowserRunning();
    } catch (err) {
      console.error('[⚠️ RICICLO BROWSER]', err.message);
      if (oldBrowser) await oldBrowser.close().catch(() => {});
      activeBrowser = null;
      await ensureBrowserRunning();
    } finally {
      isIntentionalRecycle = false;
    }
  }

  setInterval(() => {
    recycleBrowserNow('Manutenzione preventiva 4h').catch(() => {});
  }, BROWSER_RECYCLE_MS);

  // Watchdog anti-freeze per singola scheda + riavvio globale + rilevamento store ciechi (ogni 45s)
  setInterval(async () => {
    if (isPaused || !activeBrowser || isLaunchingBrowser || isIntentionalRecycle) return;
    const now = Date.now();
    const heavilyStalled = STORES.filter((s) => {
      const lastTs = workerLastProgressTs.get(s.code) || stats.startTime;
      return now - lastTs > 3 * 60 * 1000;
    });
    if (heavilyStalled.length >= 3) {
      console.error('[⚠️ WATCHDOG FREEZE] 3+ worker fermi da >3 minuti: rigenerazione totale Chrome...');
      for (const s of STORES) workerLastProgressTs.set(s.code, now);
      recycleBrowserNow('Watchdog anti-freeze globale Chrome').catch(() => {});
      return;
    }

    // Ripristino chirurgico della singola scheda congelata (>150s) senza interrompere gli altri 3 store
    if (now - stats.startTime > 45 * 1000) {
      for (const s of STORES) {
        const lastTs = workerLastProgressTs.get(s.code) || stats.startTime;
        if (now - lastTs > 150 * 1000) {
          console.warn(`[🩺 WATCHDOG TAB ${s.code}] Scheda ferma da >150s: chiusura e ricreazione scheda dedicata...`);
          workerLastProgressTs.set(s.code, now);
          const stuckPage = storePages.get(s.code);
          storePages.delete(s.code);
          if (stuckPage && !stuckPage.isClosed()) {
            await stuckPage.close().catch(() => {});
          }
        }
      }
    }

    for (const s of STORES) {
      const hasItems = appData.discoveredCatalog.some((x) => x.store === s.code && !isBannedAsin(x.asin));
      if (!hasItems) continue;
      const lastPriceTs = storeLastValidPriceTs.get(s.code) || stats.startTime;
      if (now - lastPriceTs > 25 * 60 * 1000 && !storeBlindAlertSent.has(s.code)) {
        storeBlindAlertSent.add(s.code);
        sendTelegram(
          `⚠️ AVVISO DIAGNOSTICA [${s.code}]\n` +
          `Nessun prezzo valido letto su ${s.code} negli ultimi 25 minuti (possibile soft-block o cambio layout Amazon).`,
          null,
          true
        ).catch(() => {});
      }
    }
  }, 45 * 1000);

  runDiscoveryCoordinator();
  await Promise.all(STORES.map((store) => runStoreParallelWorker(store)));
})();
