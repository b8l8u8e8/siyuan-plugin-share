/* SiYuan Share - SiYuan plugin (no-build single file) */
/* eslint-disable no-console */

const {
  Plugin,
  fetchSyncPost,
  showMessage,
  getAllEditor,
  confirm,
  Setting,
  Dialog,
} = require("siyuan");

let fs;
let path;
try {
  fs = require("fs");
  path = require("path");
} catch (err) {
  // Browser / mobile frontend won't have Node.js builtins.
}

const STORAGE_SETTINGS = "settings";
const STORAGE_SHARES = "shares";
const STORAGE_SITE_SHARES = "sharesBySite";
const STORAGE_SHARE_OPTIONS = "shareOptions";
const STORAGE_INCREMENTAL_CURSOR = "incrementalCursorBySite";
const STORAGE_DOC_BLOCK_COUNTS = "docBlockCountBySite";
const STORAGE_EXPORT_RETRY_CACHE_INDEX = "exportRetryCacheIndexBySite";
const STORAGE_AUTO_UPDATE_RUNTIME = "autoUpdateRuntimeBySite";
const DOCK_TYPE = "siyuan-plugin-share-dock";
const MB = 1024 * 1024;
const UPLOAD_CHUNK_MIN_SIZE = 256 * 1024;
const UPLOAD_CHUNK_MAX_SIZE = 8 * MB;
const UPLOAD_CHUNK_HARD_MAX_SIZE = 10 * MB;
const UPLOAD_TARGET_CHUNK_MS = 1800;
const UPLOAD_DEFAULT_SPEED_BPS = 2 * MB;
const DEFAULT_UPLOAD_ASSET_CONCURRENCY = 10;
const DEFAULT_UPLOAD_CHUNK_CONCURRENCY = 5;
const DEFAULT_DOC_EXPORT_CONCURRENCY = 4;
const DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY = 3;
const DOC_CHUNK_UPLOAD_PREFIX = "__sps_docs";
const UPLOAD_RETRY_LIMIT = 8;
const UPLOAD_RETRY_BASE_DELAY = 400;
const UPLOAD_RETRY_MAX_DELAY = 2000;
const UPLOAD_MISSING_CHUNK_RETRY_LIMIT = 8;
const EXPORT_RETRY_CACHE_DIR_NAME = "export-retry-cache";
const EXPORT_RETRY_CACHE_VERSION = 1;
const AUTO_UPDATE_HISTORY_LIMIT = 2000;
const AUTO_UPDATE_HISTORY_RENDER_LIMIT = 200;
const AUTO_UPDATE_HISTORY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const AUTO_UPDATE_QUIET_DEDUP_WINDOW_MS = 1200;
const AUTO_UPDATE_NOTEBOOK_CACHE_TTL_MS = 10 * 1000;
const AUTO_UPDATE_NOTEBOOK_FORCE_MIN_INTERVAL_MS = 1200;
const AUTO_UPDATE_NOTEBOOK_CLOSE_MONITOR_MS = 2500;

const REMOTE_API = {
  verify: "/api/v1/auth/verify",
  shares: "/api/v1/shares",
  shareSnapshot: "/api/v1/shares/snapshot",
  shareDocInit: "/api/v1/shares/doc/init",
  shareDoc: "/api/v1/shares/doc",
  shareNotebookInit: "/api/v1/shares/notebook/init",
  shareNotebook: "/api/v1/shares/notebook",
  shareAssetChunk: "/api/v1/shares/asset/chunk",
  shareUploadComplete: "/api/v1/shares/upload/complete",
  shareUploadCancel: "/api/v1/shares/upload/cancel",
  shareAccessUpdate: "/api/v1/shares/access/update",
  deleteShare: "/api/v1/shares/delete",
};

const SHARE_TYPES = {
  DOC: "doc",
  NOTEBOOK: "notebook",
};

// === Compact QR Code matrix generator (byte mode, EC level M, versions 1-10) ===
const SPS_QR = (() => {
  const EXP = new Uint8Array(256), LOG = new Uint8Array(256);
  {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
    EXP[255] = EXP[0];
  }
  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[(LOG[a] + LOG[b]) % 255];

  function rsEncode(data, n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const r = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { r[j] ^= gfMul(g[j], EXP[i]); r[j + 1] ^= g[j]; }
      g = r;
    }
    const out = new Array(data.length + n).fill(0);
    for (let i = 0; i < data.length; i++) out[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const c = out[i];
      if (c) for (let j = 1; j <= n; j++) out[i + j] ^= gfMul(g[n - j], c);
    }
    return out.slice(data.length);
  }

  // EC table: [totalCW, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
  const EC = [
    null,
    [26,10,1,16,0,0],[44,16,1,28,0,0],[70,26,1,44,0,0],[100,18,2,32,0,0],
    [134,24,2,43,0,0],[172,16,4,27,0,0],[196,18,4,31,0,0],[242,22,2,38,2,39],
    [292,22,3,36,2,37],[346,26,4,43,1,44],
  ];
  const ALIGN = [null,[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];

  function chooseVersion(len) {
    for (let v = 1; v <= 10; v++) {
      const d = EC[v][2] * EC[v][3] + EC[v][4] * EC[v][5];
      if (4 + (v <= 9 ? 8 : 16) + len * 8 <= d * 8) return v;
    }
    return -1;
  }

  function encodeData(text, ver) {
    const bytes = new TextEncoder().encode(text);
    const totalData = EC[ver][2] * EC[ver][3] + EC[ver][4] * EC[ver][5];
    const cntBits = ver <= 9 ? 8 : 16;
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, cntBits);
    for (const b of bytes) push(b, 8);
    const tLen = Math.min(4, totalData * 8 - bits.length);
    for (let i = 0; i < tLen; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const pads = [0xEC, 0x11];
    let pi = 0;
    while (bits.length < totalData * 8) { push(pads[pi % 2], 8); pi++; }
    const cw = new Uint8Array(totalData);
    for (let i = 0; i < totalData; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] || 0);
      cw[i] = b;
    }
    return cw;
  }

  function computeBlocks(dataCW, ver) {
    const [, ecPB, g1b, g1d, g2b, g2d] = EC[ver];
    const blocks = [];
    let off = 0;
    for (let i = 0; i < g1b; i++) { blocks.push(dataCW.slice(off, off + g1d)); off += g1d; }
    for (let i = 0; i < g2b; i++) { blocks.push(dataCW.slice(off, off + g2d)); off += g2d; }
    return blocks.map(d => ({ data: d, ec: new Uint8Array(rsEncode(Array.from(d), ecPB)) }));
  }

  function interleave(blocks) {
    const res = [];
    const maxD = Math.max(...blocks.map(b => b.data.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.data.length) res.push(b.data[i]);
    const ecL = blocks[0].ec.length;
    for (let i = 0; i < ecL; i++) for (const b of blocks) res.push(b.ec[i]);
    return res;
  }

  function generate(text) {
    const bytes = new TextEncoder().encode(text);
    const ver = chooseVersion(bytes.length);
    if (ver < 0) return null;
    const size = 17 + 4 * ver;
    const dataCW = encodeData(text, ver);
    const blocks = computeBlocks(dataCW, ver);
    const stream = interleave(blocks);
    const dataBits = [];
    for (const byte of stream) for (let i = 7; i >= 0; i--) dataBits.push((byte >> i) & 1);

    let bestMask = 0, bestPenalty = Infinity, bestMod = null;
    for (let mask = 0; mask < 8; mask++) {
      const mod = Array.from({length: size}, () => Array(size).fill(null));
      const fn = Array.from({length: size}, () => Array(size).fill(false));
      const set = (r, c, dark, isF) => {
        if (r >= 0 && r < size && c >= 0 && c < size) { mod[r][c] = dark; if (isF) fn[r][c] = true; }
      };
      // Finder patterns
      const placeFinder = (cr, cc) => {
        for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
          const m = Math.max(Math.abs(dr), Math.abs(dc));
          set(cr + dr, cc + dc, m === 4 ? false : m === 2 ? false : true, true);
        }
      };
      placeFinder(3, 3);
      placeFinder(3, size - 4);
      placeFinder(size - 4, 3);
      // Timing patterns
      for (let i = 8; i < size - 8; i++) {
        if (mod[6][i] === null) set(6, i, i % 2 === 0, true);
        if (mod[i][6] === null) set(i, 6, i % 2 === 0, true);
      }
      // Dark module
      set(4 * ver + 9, 8, true, true);
      // Alignment patterns
      const ap = ALIGN[ver];
      if (ap.length) {
        for (const row of ap) for (const col of ap) {
          if (row <= 8 && col <= 8) continue;
          if (row <= 8 && col >= size - 8) continue;
          if (row >= size - 8 && col <= 8) continue;
          for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
            const m = Math.max(Math.abs(dr), Math.abs(dc));
            set(row + dr, col + dc, m === 2 || m === 0, true);
          }
        }
      }
      // Reserve format areas
      for (let i = 0; i <= 8; i++) {
        if (mod[8][i] === null) set(8, i, false, true);
        if (mod[i][8] === null) set(i, 8, false, true);
      }
      for (let i = 0; i <= 7; i++) {
        if (mod[8][size - 1 - i] === null) set(8, size - 1 - i, false, true);
        if (mod[size - 1 - i][8] === null) set(size - 1 - i, 8, false, true);
      }
      // Reserve version areas
      if (ver >= 7) {
        for (let i = 0; i < 18; i++) {
          const r1 = size - 11 + (i % 3), c1 = Math.floor(i / 3);
          if (mod[r1][c1] === null) set(r1, c1, false, true);
          const r2 = Math.floor(i / 3), c2 = size - 11 + (i % 3);
          if (mod[r2][c2] === null) set(r2, c2, false, true);
        }
      }
      // Place data bits (zigzag)
      let bi = 0, col = size - 1, up = true;
      while (col >= 1) {
        if (col === 6) col--;
        const rows = up ? Array.from({length: size}, (_, i) => size - 1 - i) : Array.from({length: size}, (_, i) => i);
        for (const row of rows) {
          for (const c of [col, col - 1]) {
            if (c >= 0 && c < size && !fn[row][c]) {
              mod[row][c] = bi < dataBits.length ? !!dataBits[bi] : false;
              bi++;
            }
          }
        }
        col -= 2;
        up = !up;
      }
      // Apply mask
      const maskFns = [
        (r, c) => (r + c) % 2 === 0,
        (r, c) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
        (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
        (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
      ];
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (!fn[r][c] && maskFns[mask](r, c)) mod[r][c] = !mod[r][c];
      }
      // Place format info
      const ecBits = 0; // M
      let fd = (ecBits << 3) | mask, bch = fd << 10;
      for (let i = 4; i >= 0; i--) if (bch & (1 << (i + 10))) bch ^= 0x537 << i;
      const fmt = ((fd << 10) | bch) ^ 0x5412;
      for (let i = 0; i < 15; i++) {
        const dark = !!((fmt >> i) & 1);
        if (i < 6) mod[i][8] = dark;
        else if (i < 8) mod[i + 1][8] = dark;
        else mod[size - 15 + i][8] = dark;

        if (i < 8) mod[8][size - i - 1] = dark;
        else if (i < 9) mod[8][7] = dark;
        else mod[8][15 - i - 1] = dark;
      }
      // Place version info
      if (ver >= 7) {
        let vd = ver, vb = vd << 12;
        for (let i = 5; i >= 0; i--) if (vb & (1 << (i + 12))) vb ^= 0x1F25 << i;
        const vi = (vd << 12) | vb;
        for (let i = 0; i < 18; i++) {
          const dark = !!((vi >> i) & 1);
          mod[size - 11 + (i % 3)][Math.floor(i / 3)] = dark;
          mod[Math.floor(i / 3)][size - 11 + (i % 3)] = dark;
        }
      }
      // Penalty scoring
      let penalty = 0;
      // Rule 1: runs
      for (let r = 0; r < size; r++) {
        let cnt = 1;
        for (let c = 1; c < size; c++) { if (mod[r][c] === mod[r][c-1]) cnt++; else { if (cnt >= 5) penalty += cnt - 2; cnt = 1; } }
        if (cnt >= 5) penalty += cnt - 2;
      }
      for (let c = 0; c < size; c++) {
        let cnt = 1;
        for (let r = 1; r < size; r++) { if (mod[r][c] === mod[r-1][c]) cnt++; else { if (cnt >= 5) penalty += cnt - 2; cnt = 1; } }
        if (cnt >= 5) penalty += cnt - 2;
      }
      // Rule 2: 2x2 blocks
      for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
        const v = mod[r][c]; if (v === mod[r][c+1] && v === mod[r+1][c] && v === mod[r+1][c+1]) penalty += 3;
      }
      // Rule 3: finder-like patterns
      const p1 = [1,0,1,1,1,0,1,0,0,0,0], p2 = [0,0,0,0,1,0,1,1,1,0,1];
      for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) {
        let m1 = true, m2 = true;
        for (let k = 0; k < 11; k++) { if (!!mod[r][c+k] !== !!p1[k]) m1 = false; if (!!mod[r][c+k] !== !!p2[k]) m2 = false; }
        if (m1 || m2) penalty += 40;
      }
      for (let c = 0; c < size; c++) for (let r = 0; r <= size - 11; r++) {
        let m1 = true, m2 = true;
        for (let k = 0; k < 11; k++) { if (!!mod[r+k][c] !== !!p1[k]) m1 = false; if (!!mod[r+k][c] !== !!p2[k]) m2 = false; }
        if (m1 || m2) penalty += 40;
      }
      // Rule 4: dark proportion
      let dk = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (mod[r][c]) dk++;
      const pct = (dk * 100) / (size * size);
      penalty += Math.min(Math.abs(Math.floor(pct / 5) * 5 - 50), Math.abs(Math.ceil(pct / 5) * 5 - 50)) * 2;

      if (penalty < bestPenalty) { bestPenalty = penalty; bestMask = mask; bestMod = mod.map(row => row.map(v => !!v)); }
    }
    return { modules: bestMod, size };
  }

  return { generate };
})();

const SPS_QR_STYLES = [
  { id: "classic", bg: "#ffffff", fg: "#000000", finderFg: "#000000" },
  { id: "blue", bg: "#ffffff", fg: "#1565c0", finderFg: "#0d47a1", finderRadius: 0.8 },
  { id: "green", bg: "#ffffff", fg: "#2e7d32", finderFg: "#1b5e20", finderRadius: 0.8 },
  { id: "coral", bg: "#ffffff", fg: "#d84315", finderFg: "#bf360c", finderRadius: 0.8 },
  { id: "purple", bg: "#ffffff", fg: "#7b1fa2", finderFg: "#6a1b9a", finderRadius: 0.8 },
  { id: "gradient_blue", bg: "#ffffff", gradientStart: "#1e88e5", gradientEnd: "#0d47a1", finderFg: "#1565c0", finderRadius: 0.8 },
  { id: "gradient_rainbow", bg: "#ffffff", gradientStart: "#ff6b35", gradientEnd: "#04c2c9", finderFg: "#f57c00", finderRadius: 0.8 },
  { id: "gradient_warm", bg: "#ffffff", gradientStart: "#e53935", gradientEnd: "#ff8f00", finderFg: "#d32f2f", finderRadius: 0.8 },
  { id: "gradient_purple", bg: "#ffffff", gradientStart: "#8e24aa", gradientEnd: "#3f51b5", finderFg: "#7b1fa2", finderRadius: 0.8 },
  { id: "dark", bg: "#1a1a1a", fg: "#e0e0e0", finderFg: "#64b5f6", finderRadius: 0.8 },
];
const SPS_QR_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor"><path d="M48.384 45.376l412.224 0 0 84.992-412.224 0 0-84.992ZM565.44 45.376l238.656 0 0 84.992-238.656 0 0-84.992ZM891.584 45.376l86.72 0 0 86.72-86.72 0 0-86.72ZM48.384 374.4l412.224 0 0 85.056-412.224 0 0-85.056ZM45.696 45.376l84.992 0 0 412.224-84.992 0 0-412.224ZM375.616 45.376l84.992 0 0 412.224-84.992 0 0-412.224ZM189.376 200.832l115.712 0 0 115.712-115.712 0 0-115.712ZM565.44 130.368l82.752 0 0 87.232-82.752 0 0-87.232ZM804.032 130.368l90.752 0 0 160.512-90.752 0 0-160.512ZM891.584 217.6l86.72 0 0 151.872-86.72 0 0-151.872ZM651.328 282.688l152.768 0 0 109.312-152.768 0 0-109.312ZM736.832 369.408l155.392 0 0 88.128-155.392 0 0-88.128ZM565.952 372.16l85.376 0 0 85.376-85.376 0 0-85.376ZM45.696 542.784l84.992 0 0 192.576-84.992 0 0-192.576ZM130.88 717.248l91.968 0 0 92.032-91.968 0 0-92.032ZM45.696 805.632l85.184 0 0 173.056-85.184 0 0-173.056ZM217.664 542.784l261.696 0 0 105.728-261.696 0 0-105.728ZM281.344 639.104l109.184 0 0 100.48-109.184 0 0-100.48ZM370.176 717.248l109.184 0 0 174.848-109.184 0 0-174.848ZM285.44 805.632l105.088 0 0 173.056-105.088 0 0-173.056ZM197.952 869.12l102.016 0 0 109.568-102.016 0 0-109.568ZM629.184 542.784l195.264 0 0 174.464-195.264 0 0-174.464ZM871.168 542.784l107.136 0 0 107.136-107.136 0 0-107.136ZM545.088 630.016l107.136 0 0 194.304-107.136 0 0-194.304ZM716.672 692.8l107.776 0 0 111.872-107.776 0 0-111.872ZM545.088 869.12l107.136 0 0 109.568-107.136 0 0-109.568ZM802.816 892.096l175.488 0 0 86.592-175.488 0 0-86.592ZM890.56 804.672l87.744 0 0 105.728-87.744 0 0-105.728Z"/></svg>';
const DEFAULT_DOC_ICON_LEAF = "\u{1F4C4}";
const DEFAULT_DOC_ICON_PARENT = "\u{1F4D1}";
const BLOCK_REF_ID_PATTERN = "[0-9]{14}-[0-9a-z]{7,}";
const BLOCK_REF_RE = new RegExp(
  `\\(\\(${BLOCK_REF_ID_PATTERN}(?:\\s+\\"[^\\"]*\\")?\\)\\)`,
  "i",
);
const BLOCK_REF_LINK_RE = new RegExp(`siyuan://blocks/${BLOCK_REF_ID_PATTERN}`, "i");

const TREE_SHARE_CLASS = "sps-tree-share";
const TREE_SHARED_CLASS = "sps-tree-item--shared";
const TREE_SHARE_ICON_ID = "iconSiyuanShare";
const TREE_SHARE_QUIET_ICON_ID = "iconSiyuanShareQuiet";
const TREE_SHARE_QUEUED_ICON_ID = "iconSiyuanShareQueued";
const TREE_SHARE_SYNCING_ICON_ID = "iconSiyuanShareSyncing";
const TREE_SHARE_ERROR_ICON_ID = "iconSiyuanShareError";
const HASH_HEX_RE = /^[a-f0-9]{64}$/i;
const SHARE_SLUG_MIN_LENGTH = 6;
const SHARE_SLUG_MAX_LENGTH = 32;
const SHARE_SLUG_ALLOWED_RE = /^[a-z0-9]+$/;

let globalI18nProvider = null;

function setGlobalI18nProvider(provider) {
  globalI18nProvider = typeof provider === "function" ? provider : null;
}

function tGlobal(key, vars) {
  if (globalI18nProvider) return globalI18nProvider(key, vars);
  if (!vars) return key;
  return key.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const value = vars[name];
    return value == null ? "" : String(value);
  });
}

function getAPIToken() {
  try {
    const token = globalThis?.siyuan?.config?.api?.token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

function getAuthHeaders() {
  const token = getAPIToken();
  if (!token) return {};
  return {Authorization: `Token ${token}`};
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeHashHex(value) {
  const raw = String(value || "").trim().toLowerCase();
  return HASH_HEX_RE.test(raw) ? raw : "";
}

function escapeSqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

function chunkArray(list, size = 200) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  const chunkSize = Math.max(1, Math.floor(Number(size) || 1));
  for (let i = 0; i < list.length; i += chunkSize) {
    out.push(list.slice(i, i + chunkSize));
  }
  return out;
}

function normalizeDocUpdatedStamp(value) {
  const raw = String(value || "")
    .trim()
    .replace(/\D/g, "");
  if (raw.length < 14) return "";
  return raw.slice(0, 14);
}

function formatDocUpdatedStampFromMs(tsMs) {
  const ts = Number(tsMs);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (num) => String(num).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
}

function encodeUtf8Bytes(input) {
  const text = String(input || "");
  if (globalThis.TextEncoder) {
    return new TextEncoder().encode(text);
  }
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(text, "utf8"));
  }
  const encoded = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) {
    bytes[i] = encoded.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function fallbackHashBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    h1 ^= v;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (v << (i % 8));
    h2 = Math.imul(h2, 0x85ebca6b);
    h3 ^= (v + i) & 0xff;
    h3 = Math.imul(h3, 0xc2b2ae35);
    h4 ^= (v * 131) & 0xff;
    h4 = Math.imul(h4, 0x27d4eb2f);
  }
  const words = [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0, (h1 ^ h3) >>> 0, (h2 ^ h4) >>> 0, (h1 ^ h2) >>> 0, (h3 ^ h4) >>> 0];
  return words.map((n) => n.toString(16).padStart(8, "0")).join("");
}

async function hashTextSha256(text) {
  const source = String(text || "");
  try {
    if (globalThis?.crypto?.subtle && globalThis.TextEncoder) {
      const buf = encodeUtf8Bytes(source);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(digest))
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // fallback below
  }
  return fallbackHashBytes(encodeUtf8Bytes(source));
}

async function hashBlobSha256(blob) {
  if (!blob) return "";
  try {
    const buf = await blob.arrayBuffer();
    try {
      if (globalThis?.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(digest))
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
      }
    } catch {
      // fallback below
    }
    return fallbackHashBytes(new Uint8Array(buf));
  } catch {
    return "";
  }
}

function normalizeSortIndexForHash(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const rounded = Math.round(num * 1000000) / 1000000;
  return Number.isFinite(rounded) ? rounded : 0;
}

function buildDocMetaHashInput(doc) {
  const meta = {
    title: String(doc?.title || ""),
    hPath: String(doc?.hPath || doc?.hpath || ""),
    parentId: String(doc?.parentId || doc?.parent_id || ""),
    sortIndex: normalizeSortIndexForHash(doc?.sortIndex ?? doc?.sort_index ?? 0),
    sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder ?? doc?.sort_order ?? 0) || 0)),
    icon: normalizeDocIconValue(doc?.icon || ""),
  };
  return JSON.stringify(meta);
}

async function runTasksWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const limit = Math.max(1, Math.floor(concurrency || 1));
  let nextIndex = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(null).map(async () => {
    while (nextIndex < tasks.length) {
      const current = nextIndex;
      nextIndex += 1;
      await tasks[current]();
    }
  });
  await Promise.all(workers);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError(message = tGlobal("siyuanShare.message.cancelled")) {
  const err = new Error(message || tGlobal("siyuanShare.message.cancelled"));
  err.name = "AbortError";
  err.isAbortError = true;
  return err;
}

function isAbortError(err) {
  if (!err) return false;
  if (err?.name === "AbortError" || err?.isAbortError) return true;
  const code = String(err?.code || "").toUpperCase();
  if (code === "ABORT_ERR" || code === "ERR_CANCELED" || code === "ECONNABORTED") return true;
  const message = String(err?.message || "").trim();
  if (!message) return false;
  // Avoid treating common filesystem errors as abort/cancel because file paths
  // may contain words like "取消", which can cause false positives.
  if (/^(ENOENT|EACCES|EPERM|ENOTDIR|EISDIR)\b/i.test(message)) return false;
  if (/\b(canceled|cancelled|aborted|abort)\b/i.test(message)) return true;
  return /^(已取消|用户取消|操作已取消|请求已取消)$/i.test(message);
}

function getMissingChunksFromError(err) {
  const data = err?.data;
  if (!data || !Array.isArray(data.missingChunks)) return null;
  const missing = data.missingChunks
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  return missing.length ? missing : null;
}

function isRemoteShareNotFoundError(err) {
  const status = Number(err?.status || err?.code);
  if (status === 404) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("share not found");
}

async function withRetry(task, {retries = 0, baseDelay = 0, maxDelay = 0, controller = null, onRetry = null} = {}) {
  let attempt = 0;
  while (true) {
    if (controller?.signal?.aborted) {
      throw createAbortError(tGlobal("siyuanShare.message.cancelled"));
    }
    try {
      return await task();
    } catch (err) {
      if (err?.noRetry || isAbortError(err) || attempt >= retries) {
        throw err;
      }
      attempt += 1;
      if (onRetry) {
        try {
          onRetry(attempt, err);
        } catch {
          // ignore
        }
      }
      const delay = Math.min(maxDelay || baseDelay, baseDelay * Math.pow(2, attempt - 1));
      const jitter = delay ? Math.floor(delay * (0.2 * Math.random())) : 0;
      if (delay + jitter > 0) {
        await sleep(delay + jitter);
      }
    }
  }
}

function nowTs() {
  return Date.now();
}

function normalizeTimestampMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e12 ? num * 1000 : num;
}

function toDateTimeLocalInput(value) {
  const ts = normalizeTimestampMs(value);
  if (!ts) return "";
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function parseDateTimeLocalInput(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return tGlobal("siyuanShare.format.sizeKb", {value: "0"});
  }
  const kb = value / 1024;
  if (kb < 1024) {
    const display = kb < 10 ? kb.toFixed(1) : kb.toFixed(0);
    return tGlobal("siyuanShare.format.sizeKb", {value: display});
  }
  const mb = kb / 1024;
  const display = mb < 10 ? mb.toFixed(1) : mb.toFixed(0);
  return tGlobal("siyuanShare.format.sizeMb", {value: display});
}

function getUrlHost(raw) {
  try {
    return new URL(String(raw || "")).host || "";
  } catch {
    return "";
  }
}

function tryDecodeAssetPath(value) {
  const raw = String(value || "");
  if (!/%[0-9a-fA-F]{2}/.test(raw)) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function replaceAllText(input, search, replacement) {
  if (!search) return input;
  return String(input || "").split(search).join(replacement);
}

function appendAssetSuffix(path, index) {
  const raw = String(path || "");
  const slash = raw.lastIndexOf("/");
  const dir = slash >= 0 ? raw.slice(0, slash + 1) : "";
  const name = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return `${dir}${name.slice(0, dot)}-${index}${name.slice(dot)}`;
  }
  return `${dir}${name}-${index}`;
}

function ensureUniqueAssetPath(path, used) {
  if (!path) return "";
  const taken = used || new Set();
  let candidate = path;
  let index = 1;
  while (taken.has(candidate)) {
    candidate = appendAssetSuffix(path, index);
    index += 1;
  }
  taken.add(candidate);
  return candidate;
}

function sanitizeAssetUploadPath(path, used) {
  const decoded = tryDecodeAssetPath(path) || "";
  const raw = decoded || String(path || "");
  const stripped = raw.replace(/\s+/g, "");
  const normalized = normalizeAssetPath(stripped);
  if (!normalized) return "";
  return ensureUniqueAssetPath(normalized, used);
}

function throwIfAborted(controller, message) {
  if (controller?.signal?.aborted) {
    throw createAbortError(message || tGlobal("siyuanShare.message.cancelled"));
  }
}

function randomSlug(len = 6) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const pick = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  };

  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(len);
      globalThis.crypto.getRandomValues(bytes);
      return pick(bytes);
    }
  } catch {
    // ignore
  }

  try {
    // Desktop (Node.js)
    const crypto = require("crypto");
    const bytes = crypto.randomBytes(len);
    return pick(bytes);
  } catch {
    // ignore
  }

  let out = "";
  while (out.length < len) out += Math.random().toString(36).slice(2);
  return out.slice(0, len);
}

function isValidDocId(id) {
  return typeof id === "string" && /^\d{14}-[a-z0-9]{7}$/i.test(id.trim());
}

function isValidNotebookId(id) {
  return isValidDocId(id);
}

function normalizeDocIdList(input) {
  const source = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[,\n\r\s]+/)
      : [];
  const out = [];
  const seen = new Set();
  source.forEach((item) => {
    const id = String(item || "").trim();
    if (!isValidDocId(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function findAttrId(el) {
  if (!el || typeof el.getAttribute !== "function") return "";
  const attrs = [
    "data-node-id",
    "data-id",
    "data-doc-id",
    "data-root-id",
    "data-box",
    "data-url",
    "data-notebook-id",
    "data-notebook",
    "data-box-id",
    "data-boxid",
  ];
  for (const attr of attrs) {
    const v = el.getAttribute(attr);
    if (isValidDocId(v)) return v.trim();
  }
  if (el.dataset) {
    for (const v of Object.values(el.dataset)) {
      if (isValidDocId(v)) return String(v).trim();
    }
  }
  if (isValidDocId(el.id)) return el.id.trim();
  return "";
}

function findTitleFromTree(el) {
  if (!el) return "";
  const textEl =
    el.querySelector(".b3-list-item__text") ||
    el.querySelector(".b3-list-item__title") ||
    el.querySelector(".b3-list-item__name") ||
    el.querySelector(".b3-list-item__label") ||
    el.querySelector(".b3-list-item__content");
  const title = textEl?.textContent?.trim();
  if (title) return title;
  return el.textContent?.trim() || "";
}

function resolveTreeItemInfo(item) {
  if (!item) return {id: "", isNotebook: false};
  const dataType = item.getAttribute?.("data-type") || item.dataset?.type || "";
  const typeLower = String(dataType).toLowerCase();
  const notebookTypes = new Set(["notebook", "navigation-root"]);
  const docTypes = new Set(["navigation-file", "navigation-doc", "navigation-folder", "doc", "file"]);
  let isNotebook = notebookTypes.has(typeLower);
  const isDocType = docTypes.has(typeLower);
  const nextSibling = item.nextElementSibling;
  const parentList =
    item.closest?.(
      "ul[data-url], ul[data-box], ul[data-box-id], ul[data-boxid], ul[data-notebook-id], ul[data-notebook]",
    ) || item.parentElement?.closest?.(
      "ul[data-url], ul[data-box], ul[data-box-id], ul[data-boxid], ul[data-notebook-id], ul[data-notebook]",
    );
  const urlFromSelf = item.getAttribute?.("data-url") || item.dataset?.url;
  const urlFromNext = nextSibling?.getAttribute?.("data-url") || nextSibling?.dataset?.url;
  const urlFromParent = parentList?.getAttribute?.("data-url") || parentList?.dataset?.url;
  const docAttrs = ["data-node-id", "data-id", "data-doc-id", "data-root-id"];
  let docAttrValue = "";
  for (const attr of docAttrs) {
    const value = item.getAttribute?.(attr);
    if (isValidDocId(value)) {
      docAttrValue = value;
      break;
    }
  }
  if (!docAttrValue) {
    const docChild = item.querySelector?.("[data-node-id], [data-id], [data-doc-id], [data-root-id]");
    const childId = findAttrId(docChild);
    if (isValidDocId(childId)) docAttrValue = childId;
  }
  const hasDocAttr = isValidDocId(docAttrValue);
  const notebookAttrs = ["data-box", "data-box-id", "data-boxid", "data-notebook-id", "data-notebook"];
  let notebookAttrValue = "";
  for (const attr of notebookAttrs) {
    const value = item.getAttribute?.(attr);
    if (isValidDocId(value)) {
      notebookAttrValue = value;
      break;
    }
  }
  if (!notebookAttrValue) {
    const parentValues = [
      urlFromParent,
      parentList?.getAttribute?.("data-box"),
      parentList?.getAttribute?.("data-box-id"),
      parentList?.getAttribute?.("data-boxid"),
      parentList?.getAttribute?.("data-notebook-id"),
      parentList?.getAttribute?.("data-notebook"),
    ];
    for (const value of parentValues) {
      if (isValidDocId(value)) {
        notebookAttrValue = value;
        break;
      }
    }
  }
  if (isValidDocId(notebookAttrValue)) {
    isNotebook = true;
  }
  if (
    !isNotebook &&
    !isDocType &&
    !hasDocAttr &&
    (isValidDocId(urlFromSelf) || isValidDocId(urlFromNext) || isValidDocId(urlFromParent))
  ) {
    isNotebook = true;
  }
  if (isDocType || hasDocAttr) isNotebook = false;

  let id = "";
  if (isNotebook) {
    if (isValidDocId(notebookAttrValue)) id = notebookAttrValue.trim();
    else if (isValidDocId(urlFromSelf)) id = urlFromSelf.trim();
    else if (isValidDocId(urlFromNext)) id = urlFromNext.trim();
    else if (isValidDocId(urlFromParent)) id = urlFromParent.trim();
    else if (isValidDocId(docAttrValue)) id = docAttrValue.trim();
  } else if (isValidDocId(docAttrValue)) {
    id = docAttrValue.trim();
  }
  if (!id) id = findAttrId(item);

  return {id, isNotebook};
}

function pickDocTreeContainer() {
  const navItem = document.querySelector(
    ".b3-list-item[data-type^='navigation'], .b3-list-item[data-type*='navigation'], .b3-list-item[data-type='notebook']",
  );
  if (navItem) {
    return (
      navItem.closest(".file-tree") ||
      navItem.closest(".b3-list") ||
      navItem.closest(".b3-list--tree") ||
      navItem.parentElement
    );
  }
  const anyItem = document.querySelector(
    ".b3-list-item[data-node-id], .b3-list-item[data-id], .b3-list-item[data-doc-id], .b3-list-item[data-notebook-id], .b3-list-item[data-url]",
  );
  if (anyItem) {
    return anyItem.closest(".b3-list") || anyItem.parentElement;
  }
  const selectors = [
    "#dockFileTree",
    "#file-tree",
    "#fileTree",
    ".file-tree",
    ".file-tree__list",
    ".b3-list--tree",
    ".b3-list--background",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function isProbablyDocTreeItem(item) {
  if (!item) return false;
  if (item.closest?.("[data-sps-share-tree='1']")) return true;
  const dataType = item.getAttribute?.("data-type") || item.dataset?.type || "";
  if (String(dataType).toLowerCase().includes("navigation")) return true;
  const container = item.closest(
    "#dockFileTree, #file-tree, #fileTree, .file-tree, .file-tree__list, .b3-list--tree, .b3-list--background, .b3-list",
  );
  return Boolean(container);
}

function resolveDetailId(detail) {
  const candidates = [
    detail?.id,
    detail?.box,
    detail?.boxId,
    detail?.notebookId,
    detail?.data?.id,
    detail?.data?.box,
    detail?.data?.boxId,
  ];
  for (const value of candidates) {
    if (isValidDocId(value)) return String(value).trim();
  }
  return "";
}

function isElementVisiblySized(el) {
  try {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  } catch {
    return false;
  }
}

function normalizeUrlBase(url) {
  if (typeof url !== "string") return "";
  return url.trim().replace(/\s+/g, "").replace(/\/$/, "");
}

function normalizeShareSlugInput(value) {
  return String(value || "").trim().toLowerCase();
}

function getShareSlugValidationResult(value, {allowEmpty = true} = {}) {
  const slug = normalizeShareSlugInput(value);
  if (!slug) {
    return allowEmpty ? {ok: true, value: ""} : {ok: false, value: "", reason: "required"};
  }
  if (!SHARE_SLUG_ALLOWED_RE.test(slug)) {
    return {ok: false, value: slug, reason: "chars"};
  }
  if (slug.length < SHARE_SLUG_MIN_LENGTH || slug.length > SHARE_SLUG_MAX_LENGTH) {
    return {ok: false, value: slug, reason: "length"};
  }
  return {ok: true, value: slug};
}

function normalizeAssetPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/^[\\/]+/, "").split(/[?#]/)[0];
  if (!cleaned || cleaned.endsWith("/")) return "";
  return cleaned;
}

function extractAssetPaths(markdown) {
  if (typeof markdown !== "string" || !markdown) return [];
  const out = new Set();
  const patterns = [
    /\((?:<)?(\/?(?:assets|emojis)\/[^)\s>]+)(?:>)?(?:\s+[^)]*)?\)/g,
    /src=["'](\/?(?:assets|emojis)\/[^"']+)["']/g,
    /href=["'](\/?(?:assets|emojis)\/[^"']+)["']/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(markdown))) {
      const normalized = normalizeAssetPath(match[1]);
      if (normalized) out.add(normalized);
    }
  }
  return Array.from(out);
}

function rewriteAssetLinks(markdown) {
  if (typeof markdown !== "string" || !markdown) return "";
  return markdown
    .replace(/\]\(\/assets\//g, "](assets/")
    .replace(/\]\(\.\/assets\//g, "](assets/")
    .replace(/src="\/assets\//g, 'src="assets/')
    .replace(/src="\.\/assets\//g, 'src="assets/')
    .replace(/href="\/assets\//g, 'href="assets/')
    .replace(/href="\.\/assets\//g, 'href="assets/')
    .replace(/\]\(\/emojis\//g, "](emojis/")
    .replace(/\]\(\.\/emojis\//g, "](emojis/")
    .replace(/src="\/emojis\//g, 'src="emojis/')
    .replace(/src="\.\/emojis\//g, 'src="emojis/')
    .replace(/href="\/emojis\//g, 'href="emojis/')
    .replace(/href="\.\/emojis\//g, 'href="emojis/');
}

function makeResourcePathsRelative(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/(src|href)="\/(assets|stage|appearance|emojis)\//g, '$1="$2/')
    .replace(/(src)="\/(emojis)/g, '$1="$2');
}

function safeJsonForHtmlScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function getSnippetCSSHtml() {
  let out = "";
  try {
    document.querySelectorAll("style").forEach((item) => {
      if (item?.id?.startsWith("snippetCSS")) out += item.outerHTML;
    });
  } catch {
    // ignore
  }
  return out;
}

function getSnippetJSHtml() {
  let out = "";
  try {
    document.querySelectorAll("script").forEach((item) => {
      if (item?.id?.startsWith("snippetJS")) out += item.outerHTML;
    });
  } catch {
    // ignore
  }
  return out;
}

function getExportIconScriptHtml() {
  const iconName = globalThis?.siyuan?.config?.appearance?.icon || "";
  if (!iconName) return "";
  const escaped = escapeAttr(iconName);
  const isBuiltInIcon = ["ant", "material"].includes(iconName);
  const fallback = isBuiltInIcon ? "" : `<script src="appearance/icons/material/icon.js"></script>`;
  return `${fallback}<script src="appearance/icons/${escaped}/icon.js"></script>`;
}

function buildExportIndexHtml({title, content, exportMode}) {
  const cfg = globalThis?.siyuan?.config || {};
  const appearance = cfg.appearance || {};
  const editor = cfg.editor || {};
  const lang = appearance.lang || "zh_CN";

  let themeName = appearance.themeLight || "daylight";
  let mode = 0;
  if (appearance.mode === 1) {
    themeName = appearance.themeDark || themeName;
    mode = 1;
  }
  const themeMode = mode === 1 ? "dark" : "light";

  const previewClass =
    exportMode === "htmlmd"
      ? "b3-typography"
      : `protyle-wysiwyg${editor.displayBookmarkIcon ? " protyle-wysiwyg--attr" : ""}`;

  const winSiyuan = {
    config: {
      appearance: {
        mode,
        codeBlockThemeDark: appearance.codeBlockThemeDark || "",
        codeBlockThemeLight: appearance.codeBlockThemeLight || "",
      },
      editor: {
        codeLineWrap: true,
        fontSize: Number(editor.fontSize) || 16,
        codeLigatures: !!editor.codeLigatures,
        plantUMLServePath: editor.plantUMLServePath || "",
        codeSyntaxHighlightLineNum: !!editor.codeSyntaxHighlightLineNum,
        katexMacros: editor.katexMacros || "",
      },
    },
    languages: {
      copy: globalThis?.siyuan?.languages?.copy || "Copy",
    },
  };

  const snippetCSS = getSnippetCSSHtml();
  const snippetJS = getSnippetJSHtml();
  const iconScript = getExportIconScriptHtml();
  const winSiyuanJson = safeJsonForHtmlScript(winSiyuan);

  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}" data-theme-mode="${escapeAttr(themeMode)}" data-light-theme="${escapeAttr(
    appearance.themeLight || "",
  )}" data-dark-theme="${escapeAttr(appearance.themeDark || "")}">
<head>
    <base href="">
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"/>
    <meta name="mobile-web-app-capable" content="yes"/>
    <meta name="apple-mobile-web-app-status-bar-style" content="black">
    <link rel="stylesheet" type="text/css" id="baseStyle" href="stage/build/export/base.css"/>
    <link rel="stylesheet" type="text/css" id="themeDefaultStyle" href="appearance/themes/${escapeAttr(themeName)}/theme.css"/>
    <script src="stage/protyle/js/protyle-html.js"></script>
    <title>${escapeHtml(title || "")}</title>
    <style>
        body {font-family: var(--b3-font-family);background-color: var(--b3-theme-background);color: var(--b3-theme-on-background)}
    </style>
    ${snippetCSS}
</head>
<body>
<div class="${previewClass}" style="max-width: 800px;margin: 0 auto;" id="preview">${content || ""}</div>
${iconScript}
<script src="stage/build/export/protyle-method.js"></script>
<script src="stage/protyle/js/lute/lute.min.js"></script>  
<script>
    window.siyuan = ${winSiyuanJson};
    const previewElement = document.getElementById('preview');
    Protyle.highlightRender(previewElement, "stage/protyle");
    Protyle.mathRender(previewElement, "stage/protyle", false);
    Protyle.mermaidRender(previewElement, "stage/protyle");
    Protyle.flowchartRender(previewElement, "stage/protyle");
    Protyle.graphvizRender(previewElement, "stage/protyle");
    Protyle.chartRender(previewElement, "stage/protyle");
    Protyle.mindmapRender(previewElement, "stage/protyle");
    Protyle.abcRender(previewElement, "stage/protyle");
    Protyle.htmlRender(previewElement);
    Protyle.plantumlRender(previewElement, "stage/protyle");
    document.querySelectorAll(".protyle-action__copy").forEach((item) => {
      item.addEventListener("click", (event) => {
            let text = item.parentElement.nextElementSibling.textContent.trimEnd();
            text = text.replace(/\\u00A0/g, " ");
            navigator.clipboard.writeText(text);
            event.preventDefault();
            event.stopPropagation();
      })
    });
</script>
${snippetJS}
</body></html>`;
}

function joinWorkspaceRelPath(...parts) {
  const cleaned = parts
    .flatMap((p) => (p == null ? [] : [String(p)]))
    .map((p) => p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
    .filter(Boolean);
  return `/${cleaned.join("/")}`;
}

function normalizeWorkspaceRelPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized.replace(/\/+$/, "") : `/${normalized.replace(/\/+$/, "")}`;
}

function joinFsPath(base, ...parts) {
  const baseStr = String(base || "");
  const sep = baseStr.includes("\\") ? "\\" : "/";
  const baseTrimmed = baseStr.replace(/[\\/]+$/, "");
  const cleaned = parts
    .flatMap((p) => (p == null ? [] : [String(p)]))
    .map((p) => p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
    .filter(Boolean);
  return [baseTrimmed, ...cleaned].join(sep);
}

async function resolveWorkspaceRoot(publishRootInput) {
  const wsInfo = await fetchSyncPost("/api/system/getWorkspaceInfo", {});
  if (!wsInfo || wsInfo.code !== 0) {
    throw new Error(wsInfo?.msg || tGlobal("siyuanShare.error.workspaceInfoFailed"));
  }
  const workspaceDir = wsInfo?.data?.workspaceDir;
  if (!workspaceDir) throw new Error(tGlobal("siyuanShare.error.workspacePathFailed"));

  const inputRaw = String(publishRootInput || "").trim();
  if (!inputRaw) throw new Error(tGlobal("siyuanShare.error.publishDirRequired"));
  const inputNorm = inputRaw.replace(/\\/g, "/").replace(/\/+$/, "");

  const wsNorm = String(workspaceDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const isWindows = /^[a-zA-Z]:\//.test(wsNorm) || wsNorm.startsWith("//");

  // Windows absolute path or UNC path.
  const isWinAbs = /^[a-zA-Z]:\//.test(inputNorm) || inputNorm.startsWith("//");
  if (isWinAbs) {
    const wsCmp = isWindows ? wsNorm.toLowerCase() : wsNorm;
    const inputCmp = isWindows ? inputNorm.toLowerCase() : inputNorm;
    if (inputCmp === wsCmp) {
      return {workspaceDir, rootRel: "/"};
    }
    if (inputCmp.startsWith(`${wsCmp}/`)) {
      const rel = inputNorm.slice(wsNorm.length) || "/";
      return {workspaceDir, rootRel: rel.startsWith("/") ? rel : `/${rel}`};
    }
    throw new Error(
      tGlobal("siyuanShare.error.publishDirOutsideWorkspace", {workspace: workspaceDir}),
    );
  }

  const rel = normalizeWorkspaceRelPath(inputNorm);
  if (rel.includes("..")) throw new Error(tGlobal("siyuanShare.error.publishDirInvalid"));
  return {workspaceDir, rootRel: rel};
}

async function putWorkspaceFile(workspacePath, content, filename = "index.html", mime = "text/html") {
  const form = new FormData();
  form.append("path", workspacePath);
  form.append("isDir", "false");
  form.append("modTime", String(Date.now()));
  const blob = content instanceof Blob ? content : new Blob([String(content)], {type: mime});
  form.append("file", blob, filename);

  const resp = await fetch("/api/file/putFile", {
    method: "POST",
    body: form,
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
    },
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(
      json?.msg || tGlobal("siyuanShare.error.writeFileFailedStatus", {status: resp.status}),
    );
  }
  if (json?.code !== 0) {
    throw new Error(json?.msg || tGlobal("siyuanShare.error.writeFileFailed"));
  }
}

async function safeRm(dirPath) {
  if (!fs) throw new Error(tGlobal("siyuanShare.error.nodeFsUnavailable"));
  const fsp = fs.promises;
  if (fsp.rm) {
    await fsp.rm(dirPath, {recursive: true, force: true});
    return;
  }
  // Node <14 fallback
  await fsp.rmdir(dirPath, {recursive: true});
}
function pickActiveProtyle() {
  const protyles = getAllEditor();
  if (!Array.isArray(protyles) || protyles.length === 0) return null;

  const visibles = protyles.filter((p) => isElementVisiblySized(p?.element));
  if (visibles.length === 0) return null;
  if (visibles.length === 1) return visibles[0];

  const activeWnd =
    document.querySelector(".layout__wnd--active") ||
    document.querySelector(".layout__wnd--focus") ||
    document.querySelector(".layout__wnd--current");
  if (activeWnd) {
    const hit = visibles.find((p) => p?.element && activeWnd.contains(p.element));
    if (hit) return hit;
  }

  const active = document.activeElement;
  if (active) {
    const hit = visibles.find((p) => p?.element && p.element.contains(active));
    if (hit) return hit;
  }
  return visibles[0];
}

function extractDocIdsFromDoctreeElements(elements) {
  if (!elements) return [];
  const els = Array.from(elements);
  const ids = [];
  for (const el of els) {
    if (!el || typeof el.getAttribute !== "function") continue;
    let found = "";
    const directAttrs = [
      "data-node-id",
      "data-id",
      "data-doc-id",
      "data-root-id",
      "data-block-id",
    ];
    for (const attr of directAttrs) {
      const v = el.getAttribute(attr);
      if (isValidDocId(v)) {
        found = v.trim();
        break;
      }
    }
    if (!found && el.dataset) {
      for (const v of Object.values(el.dataset)) {
        if (isValidDocId(v)) {
          found = v.trim();
          break;
        }
      }
    }
    if (!found && isValidDocId(el.id)) found = el.id.trim();
    if (found) ids.push(found);
  }
  return Array.from(new Set(ids));
}

function extractDocTreeNodes(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.tree)) return data.tree;
  if (Array.isArray(data.root?.children)) return data.root.children;
  if (Array.isArray(data.files)) return data.files;
  if (Array.isArray(data.children)) return data.children;
  return [];
}

function normalizeDocIconValue(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") {
    let trimmed = raw.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeDocIconValue(parsed);
      } catch {
        // ignore
      }
    }
    const normalizedHex = trimmed.replace(/^u\+/i, "").replace(/\s+/g, "");
    if (/^(?:0x)?[0-9a-f]{4,6}(?:-(?:0x)?[0-9a-f]{4,6})*$/i.test(normalizedHex)) {
      const parts = normalizedHex.split("-").map((part) => part.replace(/^0x/i, ""));
      try {
        const codepoints = parts.map((part) => parseInt(part, 16)).filter((n) => Number.isFinite(n));
        if (codepoints.length) {
          return String.fromCodePoint(...codepoints);
        }
      } catch {
        // ignore
      }
    }
    return trimmed;
  }
  if (typeof raw === "number") return String(raw);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const value = normalizeDocIconValue(item);
      if (value) return value;
    }
    return "";
  }
  if (typeof raw === "object") {
    const candidates = [
      raw.icon,
      raw.value,
      raw.emoji,
      raw.iconEmoji,
      raw.iconValue,
      raw.path,
      raw.file,
      raw.asset,
      raw.assetPath,
      raw.src,
      raw.url,
    ];
    for (const candidate of candidates) {
      const value = normalizeDocIconValue(candidate);
      if (value) return value;
    }
  }
  return "";
}

function extractDocTreeNodeIcon(node) {
  if (!node) return "";
  const candidates = [
    node.icon,
    node.iconEmoji,
    node.emoji,
    node.emojiIcon,
    node.iconValue,
    node.iconPath,
    node.iconSrc,
    node.data?.icon,
    node.data?.iconEmoji,
    node.data?.emoji,
    node.data?.iconValue,
    node.attrs?.icon,
    node.attrs?.iconEmoji,
    node.attrs?.emoji,
  ];
  for (const candidate of candidates) {
    const value = normalizeDocIconValue(candidate);
    if (value) return value;
  }
  return "";
}

function extractDocIconFromAttrs(attrs) {
  if (!attrs || typeof attrs !== "object") return "";
  const candidates = [
    attrs.icon,
    attrs.emoji,
    attrs.iconEmoji,
    attrs.iconValue,
    attrs.iconPath,
  ];
  for (const candidate of candidates) {
    const value = normalizeDocIconValue(candidate);
    if (value) return value;
  }
  return "";
}

const DOC_ICON_IMAGE_EXT_RE = /\.(svg|png|jpe?g|gif|webp|bmp)$/i;
const EMOJI_IMAGE_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "bmp"];

function stripEmojiColons(value) {
  if (!value) return "";
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith(":")) return "";
  const withoutStart = trimmed.slice(1);
  if (!withoutStart) return "";
  const withoutEnd = withoutStart.endsWith(":") ? withoutStart.slice(0, -1) : withoutStart;
  return withoutEnd.trim();
}

function normalizeEmojiAssetPath(pathValue, fromEmojiToken) {
  if (!pathValue) return "";
  const lower = pathValue.toLowerCase();
  if (
    lower.startsWith("emojis/") ||
    lower.startsWith("assets/") ||
    lower.startsWith("data/") ||
    lower.startsWith("appearance/") ||
    lower.startsWith("stage/")
  ) {
    return pathValue;
  }
  if (fromEmojiToken || /[\\/]/.test(pathValue) || DOC_ICON_IMAGE_EXT_RE.test(pathValue)) {
    return `emojis/${pathValue}`;
  }
  return pathValue;
}

function isEmojiTokenName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  if (raw.length > 200) return "";
  if (/[\r\n]/.test(raw)) return "";
  if (raw.includes(":")) return "";
  return raw;
}

function getEmojiTokenNameAt(text, index) {
  if (!text || index < 0 || index >= text.length) return "";
  if (text[index] !== ":") return "";
  const end = text.indexOf(":", index + 1);
  if (end <= index + 1) return "";
  const token = text.slice(index, end + 1);
  return isEmojiTokenName(stripEmojiColons(token));
}

function getFenceMarkerAt(text, index) {
  const ch = text[index];
  if (ch !== "`" && ch !== "~") return "";
  const marker = text.slice(index, index + 3);
  if (marker !== "```" && marker !== "~~~") return "";
  let i = index - 1;
  while (i >= 0 && text[i] === " ") i -= 1;
  if (i >= 0 && text[i] !== "\n") return "";
  return marker;
}

function collectEmojiTokenNames(markdown) {
  const out = new Set();
  const source = String(markdown || "");
  if (!source) return out;
  let i = 0;
  let inFence = false;
  let fenceMarker = "";
  let inInline = false;
  while (i < source.length) {
    const fence = getFenceMarkerAt(source, i);
    if (!inFence && fence) {
      inFence = true;
      fenceMarker = fence;
      i += fence.length;
      continue;
    }
    if (inFence && fence && fence === fenceMarker) {
      inFence = false;
      fenceMarker = "";
      i += fence.length;
      continue;
    }
    const ch = source[i];
    if (!inFence) {
      if (ch === "`") {
        inInline = !inInline;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        inInline = false;
        i += 1;
        continue;
      }
      if (!inInline && ch === ":") {
        const end = source.indexOf(":", i + 1);
        if (end > i + 1) {
          const token = source.slice(i, end + 1);
          const name = isEmojiTokenName(stripEmojiColons(token));
          if (name) out.add(name);
          i = end + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  if (source.includes(":")) {
    const re = /:([^:\r\n]{1,200}):/g;
    let match;
    while ((match = re.exec(source))) {
      const name = isEmojiTokenName(match[1]);
      if (name) out.add(name);
    }
  }
  return out;
}

function replaceCustomEmojiTokens(markdown, tokenMap) {
  if (!markdown || !tokenMap || tokenMap.size === 0) return markdown;
  const source = String(markdown || "");
  let out = "";
  let i = 0;
  let inFence = false;
  let fenceMarker = "";
  let inInline = false;
  while (i < source.length) {
    const fence = getFenceMarkerAt(source, i);
    if (!inFence && fence) {
      inFence = true;
      fenceMarker = fence;
      out += fence;
      i += fence.length;
      continue;
    }
    if (inFence && fence && fence === fenceMarker) {
      inFence = false;
      fenceMarker = "";
      out += fence;
      i += fence.length;
      continue;
    }
    const ch = source[i];
    if (!inFence) {
      if (ch === "`") {
        inInline = !inInline;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        inInline = false;
        out += ch;
        i += 1;
        continue;
      }
      if (!inInline && ch === ":") {
        const end = source.indexOf(":", i + 1);
        if (end > i + 1) {
          const token = source.slice(i, end + 1);
          const name = isEmojiTokenName(stripEmojiColons(token));
          if (name && tokenMap.has(name)) {
            out += tokenMap.get(name);
            const nextName = getEmojiTokenNameAt(source, end + 1);
            if (nextName && tokenMap.has(nextName)) {
              out += " ";
            }
          } else {
            out += token;
          }
          i = end + 1;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function insertAdjacentEmojiImageSpacing(markdown) {
  const source = String(markdown || "");
  if (!source) return source;
  return source.replace(
    /(!\[[^\]]*]\((?:<)?[^)\s]*emojis\/[^)\s>]+(?:>)?\))(?=!\[[^\]]*]\((?:<)?[^)\s]*emojis\/)/g,
    "$1 ",
  );
}

function getDocIconKind(iconValue) {
  const icon = normalizeDocIconValue(iconValue);
  if (!icon) return "empty";
  if (/^data:image\//i.test(icon)) return "data";
  if (/^https?:\/\//i.test(icon)) return "url";
  const emojiToken = stripEmojiColons(icon);
  const candidate = emojiToken || icon;
  if (/[\\/]/.test(candidate) || DOC_ICON_IMAGE_EXT_RE.test(candidate)) {
    return "asset";
  }
  return "emoji";
}

function normalizeDocIconAssetPath(iconValue) {
  const icon = normalizeDocIconValue(iconValue);
  if (!icon) return "";
  if (/^data:image\//i.test(icon) || /^https?:\/\//i.test(icon)) {
    return icon;
  }
  const emojiToken = stripEmojiColons(icon);
  let cleaned = (emojiToken || icon).replace(/^file:\/+/i, "");
  cleaned = cleaned.replace(/^[\\/]+/, "");
  const decoded = tryDecodeAssetPath(cleaned) || "";
  const normalized = normalizeAssetPath(decoded || cleaned);
  if (!normalized) return "";
  return normalizeEmojiAssetPath(normalized, Boolean(emojiToken));
}

function normalizeApiIconUrl(iconValue) {
  if (typeof iconValue !== "string") return "";
  const raw = iconValue.trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return "";
  if (raw.startsWith("//")) return `${location.protocol}${raw}`;
  if (raw.startsWith("/api/")) return `${location.origin}${raw}`;
  if (raw.startsWith("api/")) return `${location.origin}/${raw}`;
  return "";
}

function guessImageExtension(contentType = "", url = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("svg")) return "svg";
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  if (type.includes("bmp")) return "bmp";
  const match = String(url || "").match(/\.(svg|png|jpe?g|gif|webp|bmp)(?:\?|#|$)/i);
  if (match) return match[1].toLowerCase().replace("jpeg", "jpg");
  return "png";
}

function applyDefaultDocIcons(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return;
  const hasChildren = new Set();
  docs.forEach((doc) => {
    const parentId = String(doc?.parentId || "").trim();
    if (isValidDocId(parentId)) hasChildren.add(parentId);
  });
  docs.forEach((doc) => {
    const docId = String(doc?.docId || "").trim();
    if (!isValidDocId(docId)) return;
    const current = normalizeDocIconValue(doc?.icon);
    if (current) return;
    doc.icon = hasChildren.has(docId) ? DEFAULT_DOC_ICON_PARENT : DEFAULT_DOC_ICON_LEAF;
  });
}

function getDocTreeChildren(node) {
  if (!node) return [];
  const children = node.children || node.child || node.files || node.nodes;
  return Array.isArray(children) ? children : [];
}

function extractDocIdFromValue(value) {
  if (!value) return "";
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isValidDocId(raw)) return raw;
  const matches = raw.match(/\d{14}-[a-z0-9]{7}/gi);
  if (!matches || matches.length === 0) return "";
  const candidate = matches[matches.length - 1];
  return isValidDocId(candidate) ? candidate : "";
}

function deriveParentIdFromPath(pathValue, selfId = "") {
  if (!pathValue) return "";
  const parts = String(pathValue || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return "";
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const parentId = extractDocIdFromValue(parts[i]);
    if (parentId && parentId !== selfId) return parentId;
  }
  return "";
}

function collectDocIdsFromPath(pathValue) {
  if (!pathValue) return [];
  const parts = String(pathValue || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const out = [];
  parts.forEach((part) => {
    const docId = extractDocIdFromValue(part);
    if (docId && !out.includes(docId)) out.push(docId);
  });
  return out;
}

function getDocTreeNodeId(node) {
  if (!node) return "";
  const candidates = [
    node?.id,
    node?.docId,
    node?.docID,
    node?.nodeId,
    node?.nodeID,
    node?.rootId,
    node?.rootID,
    node?.blockId,
    node?.blockID,
    node?.path,
    node?.data?.id,
    node?.data?.docId,
    node?.data?.nodeId,
    node?.data?.rootId,
  ];
  for (const candidate of candidates) {
    const extracted = extractDocIdFromValue(candidate);
    if (extracted) return extracted;
  }
  return "";
}

function getDocTreeNodeParentId(node) {
  if (!node) return "";
  const candidates = [
    node?.parentId,
    node?.parentID,
    node?.parent_id,
    node?.parent,
    node?.data?.parentId,
    node?.data?.parentID,
    node?.data?.parent_id,
  ];
  for (const candidate of candidates) {
    const extracted = extractDocIdFromValue(candidate);
    if (extracted) return extracted;
  }
  return "";
}

function getDocTreeNodePath(node) {
  if (!node) return "";
  const candidates = [node?.path, node?.data?.path, node?.data?.filePath];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate || "").trim();
    if (value && value.includes(".sy")) {
      return value.startsWith("/") ? value : `/${value}`;
    }
  }
  return "";
}

function normalizeDocTitle(rawTitle) {
  const text = String(rawTitle || "").trim();
  if (!text) return "";
  return text.endsWith(".sy") ? text.slice(0, -3) : text;
}

function buildDocPath(parentPath, docId) {
  const safeId = extractDocIdFromValue(docId);
  if (!safeId) {
    return String(parentPath || "").trim();
  }
  const base = String(parentPath || "").trim();
  const segment = `${safeId}.sy`;
  if (!base || base === "/") {
    return `/${segment}`;
  }
  return `${base.replace(/\/$/, "")}/${segment}`;
}

function getShareSignature(shares) {
  if (!Array.isArray(shares) || shares.length === 0) return "";
  const rows = shares
    .map((share) => ({
      id: String(share?.id || ""),
      type: String(share?.type || ""),
      slug: String(share?.slug || ""),
      docId: String(share?.docId || ""),
      notebookId: String(share?.notebookId || ""),
      updatedAt: String(share?.updatedAt || ""),
      expiresAt: String(share?.expiresAt || ""),
      visitorLimit: String(share?.visitorLimit || ""),
      title: String(share?.title || ""),
    }))
    .filter((row) => row.id);
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows.map((row) => Object.values(row).join("|")).join(";");
}

function findDocTreeNode(nodes, docId) {
  if (!Array.isArray(nodes) || !isValidDocId(docId)) return null;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    const nodeId = getDocTreeNodeId(node);
    if (nodeId && nodeId === docId) return node;
    const children = getDocTreeChildren(node);
    if (children.length) stack.push(...children);
  }
  return null;
}

function getDocTreeSortValue(node) {
  if (!node) return null;
  const candidates = [
    node.sort,
    node.sortOrder,
    node.sortIndex,
    node.sortId,
    node.sortID,
    node.sort_id,
    node.order,
    node.orderIndex,
    node.index,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function sortDocTreeNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node, idx) => ({node, idx, sort: getDocTreeSortValue(node)}))
    .sort((a, b) => {
      const aSort = Number.isFinite(a.sort) ? a.sort : a.idx;
      const bSort = Number.isFinite(b.sort) ? b.sort : b.idx;
      if (aSort === bSort) return a.idx - b.idx;
      return aSort - bSort;
    })
    .map((entry) => entry.node);
}

function flattenDocTree(nodes, out = [], parentId = "") {
  if (!Array.isArray(nodes)) return out;
  const ordered = sortDocTreeNodes(nodes);
  ordered.forEach((node, index) => {
    const id = getDocTreeNodeId(node);
    const title = String(node?.name || node?.title || node?.content || node?.label || "");
    const nodeParent = getDocTreeNodeParentId(node) || "";
    const validId = isValidDocId(id);
    const sortValue = getDocTreeSortValue(node);
    const sortIndex = Number.isFinite(sortValue) ? sortValue : index;
    if (validId) {
      out.push({
        docId: id,
        title,
        parentId: nodeParent || parentId || "",
        sortIndex,
      });
    }
    const children = getDocTreeChildren(node);
    if (children.length) {
      const nextParent = validId ? id : parentId;
      flattenDocTree(children, out, nextParent);
    }
  });
  return out;
}

class SiYuanSharePlugin extends Plugin {
  constructor(options) {
    super(options);
    this.settings = {
      siteUrl: "",
      apiKey: "",
      uploadAssetConcurrency: DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      uploadChunkConcurrency: DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      sites: [],
      activeSiteId: "",
      refWarningDisabled: false,
      autoUpdateScanStampBySite: {},
    };
    this.remoteUploadLimits = null;
    this.remoteFeatures = null;
    this.uploadTuner = {avgSpeed: 0, samples: 0};
    this.shares = [];
    this.siteShares = {};
    this.shareOptions = {};
    this.incrementalCursorBySite = {};
    this.docBlockCountBySite = {};
    this.exportRetryCacheIndexBySite = {};
    this.refQuerySchema = null;
    this.blocksRootCol = null;
    this.dockElement = null;
    this.workspaceDir = "";
    this.hasNodeFs = !!(fs && path);
    this.currentDoc = {id: "", title: ""};
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.notebooks = [];
    this.notebooksFetchedAt = 0;
    this.notebookRefreshPromise = null;
    this.docIconCache = new Map();
    this.docTreeContainer = null;
    this.docTreeObserver = null;
    this.docTreeBindTimer = null;
    this.docTreeRefreshTimer = null;
    this.docTreeDeferredTimers = [];
    this.docTreeStructSnapshot = new Map();
    this.docTreeStructDetectTimer = null;
    this.docTreeStructDetectRunning = false;
    this.docTreeStructDetectPending = false;
    this.backgroundSyncTimer = null;
    this.backgroundSyncLoopRunner = null;
    this.backgroundSyncing = false;
    this.backgroundSyncDelayMs = 3 * 60 * 1000;
    this.backgroundSyncMinDelayMs = 3 * 60 * 1000;
    this.backgroundSyncMaxDelayMs = 3 * 60 * 60 * 1000;
    this.backgroundSyncHiddenMinDelayMs = 10 * 60 * 1000;
    this.backgroundSyncHiddenMaxDelayMs = 3 * 60 * 60 * 1000;
    this.autoUpdateTimer = null;
    this.autoUpdateLoopRunner = null;
    this.autoUpdating = false;
    this.autoUpdateDelayMs = 15 * 1000;
    this.autoUpdateHiddenDelayMs = 60 * 1000;
    this.autoUpdateAdaptiveDelayMs = this.autoUpdateDelayMs;
    this.autoUpdateBackoffFactor = 1.8;
    this.autoUpdateMaxDelayMs = 5 * 60 * 1000;
    this.autoUpdateHiddenMaxDelayMs = 15 * 60 * 1000;
    this.autoUpdateDelayJitterRatio = 0.15;
    this.autoUpdateRetryBaseDelayMs = 30 * 1000;
    this.autoUpdateRetryMaxDelayMs = 30 * 60 * 1000;
    this.autoUpdateQuietWindowMs = 60 * 1000;
    this.autoUpdateQueue = [];
    this.autoUpdateQueuedSet = new Set();
    this.autoUpdateRerunSet = new Set();
    this.autoUpdateCurrentShareId = "";
    this.autoUpdateCurrentController = null;
    this.autoUpdateShareStates = {};
    this.autoUpdateRetryStateByShare = {};
    this.autoUpdateShareChangeSeqById = {};
    this.autoUpdateAbortByQuietSet = new Set();
    this.autoUpdateAbortByManualSet = new Set();
    this.autoUpdateAbortByNotebookClosedSet = new Set();
    this.autoUpdateShareNotebookHintById = {};
    this.autoUpdateManualSkipDetectSet = new Set();
    this.autoUpdateManualSkipRealtimeOnceSet = new Set();
    this.autoUpdateQuietDeadlineByShare = {};
    this.autoUpdateQuietFirstEnteredByShare = {};
    this.autoUpdateQuietMaxMultiplier = 5;
    this.autoUpdateQuietPendingSet = new Set();
    this.autoUpdateQuietFlushTimer = null;
    this.autoUpdateQuietNextFlushAt = 0;
    this.autoUpdateWsDocIdSet = new Set();
    this.autoUpdateWsFlushTimer = null;
    this.autoUpdateWsDetectRunning = false;
    this.autoUpdateWsDetectPending = false;
    this.autoUpdateHistory = [];
    this.autoUpdateNextRunAt = 0;
    this.autoUpdateLastScanAt = 0;
    this.autoUpdateLastResult = null;
    this.autoUpdateStatusDialog = null;
    this.autoUpdateStatusRefreshTimer = null;
    this.autoUpdateRuntimeBySite = {};
    this.autoUpdateStructDigestByShare = {};
    this.autoUpdateStructReconcileQueue = [];
    this.autoUpdateStructReconcileTimer = null;
    this.autoUpdateStructReconcileRunning = false;
    this.autoUpdateStructReconcileSiteId = "";
    this.autoUpdatePersistTimer = null;
    this.autoUpdatePersistDelayMs = 800;
    this.autoUpdatePersistFingerprint = "";
    this.autoUpdatePersistInitialized = false;
    this.progressDialog = null;
    this.settingVisible = false;
    this.settingEls = {
      siteInput: null,
      apiKeyInput: null,
      siteSelect: null,
      siteNameInput: null,
      autoUpdateInput: null,
      autoUpdateRow: null,
      quietWindowInput: null,
      connectActions: null,
      currentWrap: null,
      sharesWrap: null,
      envHint: null,
    };
    this.settingLayoutObserver = null;
    this.isUnloading = false;
  }

  t(key, vars) {
    const text = this.i18n?.[key] ?? key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
      const value = vars[name];
      return value == null ? "" : String(value);
    });
  }

  notify(message, ...rest) {
    const prefix = this.displayName || this.name || "SiYuan Share";
    const text = prefix ? `${prefix}: ${message}` : message;
    showMessage(text, ...rest);
  }

  onload() {
    this.isUnloading = false;
    setGlobalI18nProvider(this.t.bind(this));
    const bootstrap = async () => {
      await this.clearExportRetryCacheOnStartup();
      await this.loadState();
    };
    bootstrap().catch((err) => {
      console.error(err);
      this.notify(this.t("siyuanShare.message.pluginInitFailed", {error: err.message || err}));
    });

    this.addIcons(`<symbol id="iconSiyuanShare" viewBox="0 0 24 24">
  <path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/>
  </symbol>
  <symbol id="iconSiyuanShareQuiet" viewBox="0 0 24 24">
    <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10s10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
  </symbol>
  <symbol id="iconSiyuanShareQueued" viewBox="0 0 24 24">
    <path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
  </symbol>
  <symbol id="iconSiyuanShareSyncing" viewBox="0 0 24 24">
    <path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
  </symbol>
  <symbol id="iconSiyuanShareError" viewBox="0 0 24 24">
    <path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
</symbol>`);

    this.initSettingPanel();
    this.addCommand({
      langKey: "siyuanShare.openDock",
      hotkey: "",
      callback: () => this.openShareDock(),
    });

    this.eventBus.on("click-editortitleicon", this.onEditorTitleMenu);
    this.eventBus.on("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.on("switch-protyle", this.onSwitchProtyle);
    this.eventBus.on("loaded-protyle-static", this.onLoadedProtyle);
    this.eventBus.on("loaded-protyle-dynamic", this.onLoadedProtyle);
    this.eventBus.on("ws-main", this.onWsMain);
    document.addEventListener("click", this.onGlobalTreeShareClick, true);

    this.bindDocTreeLater();
    void this.refreshCurrentDocContext();
  }

  onunload() {
    this.isUnloading = true;
    setGlobalI18nProvider(null);
    this.closeAutoUpdateStatusDialog();
    this.stopAutoUpdateStructureReconcile();
    this.stopBackgroundSync();
    this.stopAutoUpdate({clearState: false, refreshTreeOnClear: false, preservePendingOnPause: true});
    // Keep persisted runtime/history, but clear volatile in-memory UI state
    // so plugin disable/enable won't replay stale tree icon statuses.
    this.autoUpdateShareStates = {};
    this.shares = [];
    if (this.dockElement) {
      this.dockElement.removeEventListener("click", this.onDockClick);
      this.dockElement.removeEventListener("change", this.onDockChange);
    }
    this.eventBus.off("click-editortitleicon", this.onEditorTitleMenu);
    this.eventBus.off("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.off("switch-protyle", this.onSwitchProtyle);
    this.eventBus.off("loaded-protyle-static", this.onLoadedProtyle);
    this.eventBus.off("loaded-protyle-dynamic", this.onLoadedProtyle);
    this.eventBus.off("ws-main", this.onWsMain);
    document.removeEventListener("click", this.onGlobalTreeShareClick, true);
    if (this.docTreeBindTimer) {
      clearInterval(this.docTreeBindTimer);
      this.docTreeBindTimer = null;
    }
    if (this.docTreeRefreshTimer) {
      clearTimeout(this.docTreeRefreshTimer);
      this.docTreeRefreshTimer = null;
    }
    if (this.docTreeDeferredTimers.length) {
      this.docTreeDeferredTimers.forEach((t) => clearTimeout(t));
      this.docTreeDeferredTimers = [];
    }
    if (this.docTreeStructDetectTimer) {
      clearTimeout(this.docTreeStructDetectTimer);
      this.docTreeStructDetectTimer = null;
    }
    if (this.autoUpdateWsFlushTimer) {
      clearTimeout(this.autoUpdateWsFlushTimer);
      this.autoUpdateWsFlushTimer = null;
    }
    this.autoUpdateWsDocIdSet.clear();
    this.autoUpdateWsDetectRunning = false;
    this.autoUpdateWsDetectPending = false;
    this.docTreeStructSnapshot = new Map();
    this.docTreeStructDetectRunning = false;
    this.docTreeStructDetectPending = false;
    this.detachDocTree();
    this.clearDocTreeMarks();
    if (this.settingEls.sharesWrap) {
      this.settingEls.sharesWrap.removeEventListener("click", this.onSettingSharesClick);
    }
    if (this.settingEls.currentWrap) {
      this.settingEls.currentWrap.removeEventListener("click", this.onSettingCurrentClick);
    }
    if (this.settingEls.autoUpdateInput) {
      this.settingEls.autoUpdateInput.removeEventListener("change", this.onSettingAutoUpdateToggleChange);
    }
    if (this.settingEls.quietWindowInput) {
      this.settingEls.quietWindowInput.removeEventListener("change", this.onSettingQuietWindowChange);
    }
    if (this.settingEls.autoUpdateRow) {
      this.settingEls.autoUpdateRow.removeEventListener("click", this.onSettingActionsClick);
    }
    if (this.settingEls.connectActions) {
      this.settingEls.connectActions.removeEventListener("click", this.onSettingActionsClick);
    }
    if (this.settingLayoutObserver) {
      try {
        this.settingLayoutObserver.disconnect();
      } catch {
        // ignore
      }
      this.settingLayoutObserver = null;
    }
    if (this.progressDialog) {
      try {
        this.progressDialog.destroy();
      } catch {
        // ignore
      }
      this.progressDialog = null;
    }
    void this.flushAutoUpdateRuntimePersist();
  }

  async uninstall() {
    await this.removeData(STORAGE_SETTINGS);
    await this.removeData(STORAGE_SHARES);
    await this.removeData(STORAGE_SITE_SHARES);
    await this.removeData(STORAGE_AUTO_UPDATE_RUNTIME);
    await this.removeData(STORAGE_INCREMENTAL_CURSOR);
    await this.removeData(STORAGE_DOC_BLOCK_COUNTS);
    await this.removeData(STORAGE_EXPORT_RETRY_CACHE_INDEX);
    await this.clearExportRetryCacheFiles();
  }

  onSwitchProtyle = ({detail}) => {
    void this.refreshCurrentDocContext(detail?.protyle);
    this.scheduleAutoUpdateNow(1200);
  };

  onLoadedProtyle = ({detail}) => {
    void this.refreshCurrentDocContext(detail?.protyle);
    this.scheduleAutoUpdateNow(1200);
  };

  onWsMain = (event) => {
    if (!this.isAutoUpdateEnabledForActiveSite()) return;
    if (!Array.isArray(this.shares) || this.shares.length === 0) return;
    const payload =
      event?.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
        ? event.detail
        : event;
    const cmd = String(payload?.cmd || "").trim().toLowerCase();
    if (cmd && (cmd === "movedoc" || cmd.includes("move"))) {
      this.scheduleAutoUpdateStructureReconcile({immediate: false, reset: false});
    }
    const docIds = this.extractAutoUpdateDocIdsFromWsPayload(payload);
    if (!docIds.length) return;
    docIds.forEach((docId) => {
      const id = String(docId || "").trim();
      if (isValidDocId(id)) {
        this.autoUpdateWsDocIdSet.add(id);
      }
    });
    this.scheduleAutoUpdateWsDetectFlush(220);
  };

  scheduleAutoUpdateWsDetectFlush(delayMs = 220) {
    if (this.autoUpdateWsFlushTimer) return;
    const delay = Math.max(80, Math.floor(Number(delayMs) || 0));
    this.autoUpdateWsFlushTimer = setTimeout(() => {
      this.autoUpdateWsFlushTimer = null;
      void this.flushAutoUpdateWsDetect();
    }, delay);
  }

  extractAutoUpdateDocIdsFromWsPayload(event) {
    const payload =
      event?.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
        ? event.detail
        : event;
    const cmd = String(payload?.cmd || "").trim().toLowerCase();
    if (!cmd) return [];
    // Keep ws-main detection narrow to avoid false positives (for example lock/unlock/no-op attr events).
    const shouldInspect =
      cmd === "savedoc" ||
      cmd === "renamedoc" ||
      cmd === "movedoc" ||
      cmd.includes("rename") ||
      cmd.includes("move");
    if (!shouldInspect) return [];
    const out = new Set();
    const addDocId = (raw) => {
      const id = String(raw || "").trim();
      if (isValidDocId(id)) {
        out.add(id);
      }
    };
    const addDocIdList = (list) => {
      (Array.isArray(list) ? list : []).forEach((id) => addDocId(id));
    };
    const data = payload?.data;
    addDocId(payload?.rootID || payload?.rootId || payload?.docID || payload?.docId || payload?.id);
    addDocIdList(payload?.ids);
    if (typeof data === "string") {
      addDocId(data);
    } else if (Array.isArray(data)) {
      addDocIdList(data);
    }
    if (data && typeof data === "object") {
      addDocId(data?.rootID || data?.rootId || data?.docID || data?.docId || data?.id);
      addDocId(data?.parentID || data?.parentId);
      addDocIdList(data?.ids || data?.docIds || data?.rootIDs || data?.rootIds);
    }
    if (cmd === "savedoc") {
      return Array.from(out);
    }
    const skipLargeTextKey = /^(markdown|content|dom|html|text|source|sources|kramdown|ial|attrs?)$/i;
    const walk = (value, depth = 0) => {
      if (depth > 5 || out.size >= 240 || value == null) return;
      if (typeof value === "string") {
        const text = String(value || "").trim();
        if (text.length <= 32) {
          addDocId(text);
        }
        return;
      }
      if (Array.isArray(value)) {
        const count = Math.min(value.length, 80);
        for (let i = 0; i < count; i += 1) {
          walk(value[i], depth + 1);
          if (out.size >= 240) return;
        }
        return;
      }
      if (typeof value !== "object") return;
      const entries = Object.entries(value);
      const count = Math.min(entries.length, 80);
      for (let i = 0; i < count; i += 1) {
        const [key, next] = entries[i];
        if (skipLargeTextKey.test(String(key || ""))) continue;
        if (typeof next === "string") {
          const text = String(next || "").trim();
          if (text.length <= 32) addDocId(text);
          continue;
        }
        if (next && (Array.isArray(next) || typeof next === "object")) {
          walk(next, depth + 1);
          if (out.size >= 240) return;
        }
      }
    };
    walk(data, 0);
    return Array.from(out);
  }

  async flushAutoUpdateWsDetect() {
    if (this.autoUpdateWsDetectRunning) {
      this.autoUpdateWsDetectPending = true;
      return;
    }
    this.autoUpdateWsDetectRunning = true;
    try {
      while (this.autoUpdateWsDocIdSet.size > 0) {
        if (!this.isAutoUpdateEnabledForActiveSite() || !Array.isArray(this.shares) || this.shares.length === 0) {
          this.autoUpdateWsDocIdSet.clear();
          break;
        }
        const batch = Array.from(this.autoUpdateWsDocIdSet).slice(0, 180);
        batch.forEach((id) => this.autoUpdateWsDocIdSet.delete(id));
        try {
          const changedIds = Array.from(
            new Set(
              (Array.isArray(batch) ? batch : [])
                .map((id) => String(id || "").trim())
                .filter((id) => isValidDocId(id)),
            ),
          );
          let mergedIds = changedIds.slice();
          if (changedIds.length > 0) {
            try {
              const refImpacted = await this.queryRefImpactedDocIdsByTargets(changedIds);
              const extra = Array.from(
                new Set(
                  (Array.isArray(refImpacted) ? refImpacted : [])
                    .map((id) => String(id || "").trim())
                    .filter((id) => isValidDocId(id)),
                ),
              );
              if (extra.length > 0) {
                mergedIds = Array.from(new Set([...changedIds, ...extra]));
              }
            } catch (refErr) {
              if (!isAbortError(refErr)) {
                console.warn("ws-main ref-impact detect failed", refErr);
              }
            }
          }
          await this.enqueueAutoUpdateByDocIds(mergedIds, {source: "ws"});
        } catch (err) {
          if (!isAbortError(err)) {
            console.warn("ws-main auto-update detect failed", err);
          }
        }
      }
    } finally {
      this.autoUpdateWsDetectRunning = false;
      if (this.autoUpdateWsDetectPending || this.autoUpdateWsDocIdSet.size > 0) {
        this.autoUpdateWsDetectPending = false;
        this.scheduleAutoUpdateWsDetectFlush(180);
      }
    }
  }

  bindDocTreeLater() {
    if (this.docTreeBindTimer) clearInterval(this.docTreeBindTimer);
    if (this.isUnloading) return;
    this.docTreeBindTimer = setInterval(() => {
      if (this.isUnloading) {
        clearInterval(this.docTreeBindTimer);
        this.docTreeBindTimer = null;
        return;
      }
      const attached = this.attachDocTree();
      const alreadyBound = !!(this.docTreeContainer && this.docTreeContainer.isConnected);
      if (attached || alreadyBound) {
        clearInterval(this.docTreeBindTimer);
        this.docTreeBindTimer = null;
      }
      this.refreshDocTreeMarks();
    }, 800);
  }

  attachDocTree({skipRefresh = false} = {}) {
    if (this.isUnloading) return false;
    const container = pickDocTreeContainer();
    if (!container) return false;
    if (container === this.docTreeContainer && this.docTreeContainer?.isConnected) return false;
    this.detachDocTree();
    this.docTreeContainer = container;
    this.docTreeContainer.setAttribute("data-sps-share-tree", "1");
    this.docTreeContainer.addEventListener("click", this.onDocTreeClick, true);
    this.docTreeObserver = new MutationObserver((mutations) => {
      if (this.isUnloading) return;
      const isOurMutation = (m) => {
        if (m.type !== "childList") {
          const targetEl = m.target instanceof Element ? m.target : m.target?.parentElement;
          if (targetEl instanceof Element && targetEl.closest?.(`.${TREE_SHARE_CLASS}`)) return true;
          return false;
        }
        if (m.target instanceof Element && m.target.closest?.(`.${TREE_SHARE_CLASS}`)) return true;
        const ourNode = (n) => n instanceof Element && n.classList?.contains(TREE_SHARE_CLASS);
        return Array.from(m.addedNodes).every(ourNode) && Array.from(m.removedNodes).every(ourNode);
      };
      if (!mutations.every(isOurMutation)) {
        this.scheduleDocTreeRefresh();
        this.scheduleDocTreeStructureDetect();
      }
    });
    this.docTreeObserver.observe(this.docTreeContainer, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    this.docTreeStructSnapshot = this.captureDocTreeStructureSnapshot();
    if (!skipRefresh) {
      this.refreshDocTreeMarks();
    }
    return true;
  }

  detachDocTree() {
    if (this.docTreeStructDetectTimer) {
      clearTimeout(this.docTreeStructDetectTimer);
      this.docTreeStructDetectTimer = null;
    }
    this.docTreeStructSnapshot = new Map();
    this.docTreeStructDetectRunning = false;
    this.docTreeStructDetectPending = false;
    if (this.docTreeContainer) {
      this.docTreeContainer.removeAttribute("data-sps-share-tree");
      this.docTreeContainer.removeEventListener("click", this.onDocTreeClick, true);
    }
    if (this.docTreeObserver) {
      this.docTreeObserver.disconnect();
      this.docTreeObserver = null;
    }
    this.docTreeContainer = null;
  }

  getTreeItemIconSignature(item) {
    if (!item) return "";
    const iconEl =
      item.querySelector?.(".b3-list-item__icon") ||
      item.querySelector?.(".b3-list-item__graphic") ||
      item.querySelector?.(".b3-list-item__emoji");
    if (!iconEl) return "";
    const text = normalizeDocIconValue(iconEl.textContent || "");
    const useEl = iconEl.querySelector?.("use");
    const useHref = String(useEl?.getAttribute?.("xlink:href") || useEl?.getAttribute?.("href") || "").trim();
    const cls = String(iconEl.className || "").replace(/\s+/g, " ").trim();
    const style = String(iconEl.getAttribute?.("style") || "").replace(/\s+/g, " ").trim();
    const attrParts = [];
    try {
      Array.from(iconEl.attributes || []).forEach((attr) => {
        const name = String(attr?.name || "").trim();
        if (!name) return;
        const value = String(attr?.value || "").replace(/\s+/g, " ").trim();
        attrParts.push(`${name}:${value}`);
      });
      attrParts.sort();
    } catch {
      // ignore
    }
    const html = String(iconEl.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 180);
    return [text ? `text:${text}` : "", useHref ? `svg:${useHref}` : "", cls ? `class:${cls}` : "", style ? `style:${style}` : "", attrParts.length ? `attrs:${attrParts.join(";")}` : "", html ? `html:${html}` : ""]
      .filter(Boolean)
      .join("|");
  }

  captureDocTreeStructureSnapshot() {
    const container = this.docTreeContainer;
    const out = new Map();
    if (!container || !container.isConnected) return out;
    const allItems = Array.from(container.querySelectorAll(".b3-list-item")).filter((item) => isProbablyDocTreeItem(item));
    if (!allItems.length) return out;
    const itemSet = new Set(allItems);
    const sortIndexMap = new Map();
    const childrenMap = new Map();
    allItems.forEach((item) => {
      const parentItem = item.parentElement?.closest?.(".b3-list-item");
      const key = parentItem && itemSet.has(parentItem) ? parentItem : null;
      if (!childrenMap.has(key)) childrenMap.set(key, []);
      childrenMap.get(key).push(item);
    });
    childrenMap.forEach((items) => {
      items.forEach((item, index) => {
        sortIndexMap.set(item, index);
      });
    });
    allItems.forEach((item) => {
      const info = resolveTreeItemInfo(item);
      const docId = String(info?.id || "").trim();
      if (!isValidDocId(docId) || info?.isNotebook || out.has(docId)) return;
      const parentItem = item.parentElement?.closest?.(".b3-list-item");
      let parentId = "";
      if (parentItem && itemSet.has(parentItem)) {
        const parentInfo = resolveTreeItemInfo(parentItem);
        if (!parentInfo?.isNotebook && isValidDocId(parentInfo?.id)) {
          parentId = String(parentInfo.id || "").trim();
        }
      }
      out.set(docId, {
        docId,
        title: String(findTitleFromTree(item) || ""),
        icon: this.getTreeItemIconSignature(item),
        parentId,
        sortIndex: Math.max(0, Math.floor(Number(sortIndexMap.get(item)) || 0)),
      });
    });
    return out;
  }

  scheduleDocTreeStructureDetect() {
    if (this.isUnloading) return;
    if (this.docTreeStructDetectRunning) {
      this.docTreeStructDetectPending = true;
      return;
    }
    if (this.docTreeStructDetectTimer) return;
    this.docTreeStructDetectTimer = setTimeout(() => {
      this.docTreeStructDetectTimer = null;
      if (this.isUnloading) return;
      void this.flushDocTreeStructureDetect();
    }, 240);
  }

  async flushDocTreeStructureDetect() {
    if (this.isUnloading) return;
    if (this.docTreeStructDetectRunning) {
      this.docTreeStructDetectPending = true;
      return;
    }
    this.docTreeStructDetectRunning = true;
    if (!this.docTreeContainer || !this.docTreeContainer.isConnected) {
      this.docTreeStructSnapshot = new Map();
      this.docTreeStructDetectRunning = false;
      this.docTreeStructDetectPending = false;
      return;
    }
    try {
      const prev = this.docTreeStructSnapshot instanceof Map ? this.docTreeStructSnapshot : new Map();
      const next = this.captureDocTreeStructureSnapshot();
      this.docTreeStructSnapshot = next;
      if (!prev.size || !next.size) return;
      const changedDocIdSet = new Set();
      const forceDocIdSet = new Set();
      const markChanged = (row) => {
        const docId = String(row?.docId || "").trim();
        if (isValidDocId(docId)) changedDocIdSet.add(docId);
        const parentId = String(row?.parentId || "").trim();
        if (isValidDocId(parentId)) changedDocIdSet.add(parentId);
      };
      const markForce = (row) => {
        const docId = String(row?.docId || "").trim();
        if (isValidDocId(docId)) forceDocIdSet.add(docId);
      };
      next.forEach((row, docId) => {
        const old = prev.get(docId);
        if (!old) {
          markChanged(row);
          return;
        }
        const titleChanged = String(row.title || "") !== String(old.title || "");
        const iconChanged = String(row.icon || "") !== String(old.icon || "");
        const parentChanged = String(row.parentId || "") !== String(old.parentId || "");
        const sortChanged = Number(row.sortIndex || 0) !== Number(old.sortIndex || 0);
        if (titleChanged || iconChanged || parentChanged || sortChanged) {
          markChanged(row);
          markChanged(old);
          if (titleChanged || iconChanged) {
            markForce(row);
            markForce(old);
          }
        }
      });
      prev.forEach((row, docId) => {
        if (next.has(docId)) return;
        markChanged(row);
      });
      if (!changedDocIdSet.size) return;
      try {
        await this.enqueueAutoUpdateByDocIds(Array.from(changedDocIdSet), {
          source: "tree",
          forceDocIds: Array.from(forceDocIdSet),
        });
      } catch (err) {
        console.warn("tree structure auto-update detect failed", err);
      }
    } finally {
      this.docTreeStructDetectRunning = false;
      if (this.docTreeStructDetectPending) {
        this.docTreeStructDetectPending = false;
        this.scheduleDocTreeStructureDetect();
      }
    }
  }

  scheduleDocTreeRefresh(delayMs = 80, {force = false} = {}) {
    if (this.isUnloading) return;
    const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
    if (this.docTreeRefreshTimer) {
      if (!force) return;
      clearTimeout(this.docTreeRefreshTimer);
      this.docTreeRefreshTimer = null;
    }
    this.docTreeRefreshTimer = setTimeout(() => {
      this.docTreeRefreshTimer = null;
      if (this.isUnloading) return;
      this.refreshDocTreeMarks();
    }, delay);
  }

  refreshDocTreeMarksLater() {
    if (this.isUnloading) return;
    this.attachDocTree({skipRefresh: true});
    this.refreshDocTreeMarks();
    this.scheduleDocTreeRefresh();
    this.bindDocTreeLater();
    const t1 = setTimeout(() => this.scheduleDocTreeRefresh(), 300);
    const t2 = setTimeout(() => this.scheduleDocTreeRefresh(), 800);
    this.docTreeDeferredTimers.push(t1, t2);
  }

  clearDocTreeMarks() {
    const clearScope = (scope) => {
      scope.querySelectorAll(`.${TREE_SHARE_CLASS}`).forEach((el) => el.remove());
      scope.querySelectorAll(`.${TREE_SHARED_CLASS}`).forEach((el) => {
        el.classList.remove(TREE_SHARED_CLASS);
      });
    };
    const hasTreeRoot = this.docTreeContainer && this.docTreeContainer.isConnected;
    if (hasTreeRoot) {
      clearScope(this.docTreeContainer);
      clearScope(document);
      return;
    }
    clearScope(document);
  }

  getTreeShareIconIdByAutoState(autoState = "") {
    if (autoState === "quiet") return TREE_SHARE_QUIET_ICON_ID;
    if (autoState === "queued") return TREE_SHARE_QUEUED_ICON_ID;
    if (autoState === "syncing") return TREE_SHARE_SYNCING_ICON_ID;
    if (autoState === "error") return TREE_SHARE_ERROR_ICON_ID;
    return TREE_SHARE_ICON_ID;
  }

  getAutoUpdateQuietRemainingSeconds(shareId, now = nowTs()) {
    const id = String(shareId || "").trim();
    if (!id) return 0;
    const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[id]) || 0));
    if (!deadline) return 0;
    const remainMs = Math.max(0, deadline - Math.floor(Number(now) || 0));
    if (!remainMs) return 0;
    return Math.max(1, Math.ceil(remainMs / 1000));
  }

  getTreeShareIconTooltip(shareId, autoStateInfo = null) {
    const id = String(shareId || "").trim();
    if (!id) return "";
    const stateInfo = autoStateInfo || this.getAutoUpdateShareState(id);
    const autoState = String(stateInfo?.state || "").trim();
    if (autoState === "syncing") {
      return this.t("siyuanShare.message.autoUpdateSyncing");
    }
    if (autoState === "quiet") {
      const seconds = this.getAutoUpdateQuietRemainingSeconds(id);
      if (seconds > 0) {
        return this.t("siyuanShare.message.autoUpdateQuietRemaining", {seconds});
      }
      return this.t("siyuanShare.message.autoUpdateQueued");
    }
    if (autoState === "queued") {
      return this.t("siyuanShare.message.autoUpdateQueued");
    }
    if (autoState === "error") {
      return stateInfo?.message || this.t("siyuanShare.message.autoUpdateFailed");
    }
    return this.isAutoUpdateEnabledForActiveSite()
      ? this.t("siyuanShare.message.autoUpdateIdle")
      : this.t("siyuanShare.message.autoUpdateDisabled");
  }

  updateTreeShareIconTooltip(icon, shareId, autoStateInfo = null) {
    if (!icon) return;
    const title = this.getTreeShareIconTooltip(shareId, autoStateInfo);
    if (title) {
      icon.setAttribute("title", title);
    } else {
      icon.removeAttribute("title");
    }
  }

  refreshDocTreeMarks() {
    if (this.isUnloading) return;
    if (this.docTreeContainer && !this.docTreeContainer.isConnected) {
      this.detachDocTree();
      this.bindDocTreeLater();
    }
    if (!this.docTreeContainer || !isElementVisiblySized(this.docTreeContainer)) {
      this.attachDocTree({skipRefresh: true});
    }
    const hasTreeRoot = this.docTreeContainer && this.docTreeContainer.isConnected;
    const applyMarks = (scope, requireFilter) => {
      let items = scope.querySelectorAll(".b3-list-item");
      if (!items.length) {
        items = scope.querySelectorAll("[data-type^='navigation'], [data-type*='navigation'], [data-type='notebook']");
      }
      items.forEach((rawItem) => {
        const item =
          rawItem.classList?.contains("b3-list-item") ? rawItem : rawItem.closest?.(".b3-list-item") || rawItem;
        if (requireFilter && !isProbablyDocTreeItem(item)) return;
        const info = resolveTreeItemInfo(item);
        if (!info?.id) return;
        const share = info.isNotebook ? this.getShareByNotebookId(info.id) : this.getShareByDocId(info.id);
        const titleEl =
          item.querySelector(".b3-list-item__text") ||
          item.querySelector(".b3-list-item__title") ||
          item.querySelector(".b3-list-item__name") ||
          item.querySelector(".b3-list-item__label") ||
          item.querySelector(".b3-list-item__content") ||
          item;
        const existing = titleEl.querySelector(`.${TREE_SHARE_CLASS}`);
        if (share) {
          item.classList.add(TREE_SHARED_CLASS);
          let icon = existing;
          if (!icon) {
            icon = document.createElement("span");
            icon.className = TREE_SHARE_CLASS;
            titleEl.appendChild(icon);
          }
          this.bindTreeShareIconEvents(icon);
          icon.setAttribute("data-share-type", share.type);
          icon.setAttribute("data-share-id", info.id);
          icon.setAttribute("data-share-record-id", share.id);
          const autoStateInfo = this.getAutoUpdateShareState(share.id);
          const autoState = autoStateInfo?.state || "";
          icon.classList.toggle("sps-tree-share--quiet", autoState === "quiet");
          icon.classList.toggle("sps-tree-share--queued", autoState === "queued");
          icon.classList.toggle("sps-tree-share--syncing", autoState === "syncing");
          icon.classList.toggle("sps-tree-share--error", autoState === "error");
          if (autoState) {
            icon.setAttribute("data-auto-update-state", autoState);
          } else {
            icon.removeAttribute("data-auto-update-state");
          }
          this.updateTreeShareIconTooltip(icon, share.id, autoStateInfo);
          const iconId = this.getTreeShareIconIdByAutoState(autoState);
          if (icon.getAttribute("data-icon-id") !== iconId) {
            icon.innerHTML = `<svg><use xlink:href="#${iconId}"></use></svg>`;
            icon.setAttribute("data-icon-id", iconId);
          }
        } else {
          item.classList.remove(TREE_SHARED_CLASS);
          if (existing) existing.remove();
        }
      });
    };
    if (hasTreeRoot) {
      applyMarks(this.docTreeContainer, false);
      applyMarks(document, true);
      return;
    }
    applyMarks(document, true);
  }

  bindTreeShareIconEvents(icon) {
    if (!icon || icon.getAttribute("data-sps-tree-bound") === "1") return;
    icon.setAttribute("data-sps-tree-bound", "1");
    icon.addEventListener("mouseenter", this.onTreeShareIconMouseEnter, true);
    icon.addEventListener("click", this.onTreeShareIconClick, true);
  }

  onTreeShareIconMouseEnter = (event) => {
    const icon =
      event?.currentTarget?.classList?.contains?.(TREE_SHARE_CLASS)
        ? event.currentTarget
        : event?.target?.closest?.(`.${TREE_SHARE_CLASS}`);
    if (!icon) return;
    const shareId = String(icon.getAttribute("data-share-record-id") || "").trim();
    if (!shareId) return;
    this.updateTreeShareIconTooltip(icon, shareId);
  };

  consumeTreeShareIconEvent(event, {open = false, requireLeftClick = false, icon = null} = {}) {
    if (!event) return false;
    const target = event.target;
    const iconEl =
      (icon && icon.classList?.contains?.(TREE_SHARE_CLASS) ? icon : null) ||
      target?.closest?.(`.${TREE_SHARE_CLASS}`) ||
      (event.currentTarget?.classList?.contains?.(TREE_SHARE_CLASS) ? event.currentTarget : null);
    if (!iconEl) return false;
    if (requireLeftClick) {
      const isClickEvent = String(event.type || "").toLowerCase() === "click";
      const button = Number(event.button);
      if (!isClickEvent || button !== 0) {
        return false;
      }
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (open) this.openAutoUpdateStatusDialog();
    return true;
  }

  onTreeShareIconClick = (event) => {
    this.consumeTreeShareIconEvent(event, {open: true, requireLeftClick: true});
  };

  onDocTreeClick = (event) => {
    const icon = event.target?.closest?.(`.${TREE_SHARE_CLASS}`);
    const item = event.target?.closest?.(".b3-list-item");
    let matchedIcon = icon;
    if (!matchedIcon && item) {
      const maybeIcon = item.querySelector?.(`.${TREE_SHARE_CLASS}[data-share-id]`) || null;
      if (maybeIcon) {
        const rect = maybeIcon.getBoundingClientRect();
        const x = Number(event?.clientX) || 0;
        const y = Number(event?.clientY) || 0;
        const slack = 10;
        if (
          x >= rect.left - slack &&
          x <= rect.right + slack &&
          y >= rect.top - slack &&
          y <= rect.bottom + slack
        ) {
          matchedIcon = maybeIcon;
        }
      }
    }
    if (!matchedIcon) return;
    this.consumeTreeShareIconEvent(event, {open: true, requireLeftClick: true, icon: matchedIcon});
  };

  onGlobalTreeShareClick = (event) => {
    this.consumeTreeShareIconEvent(event, {open: true, requireLeftClick: true});
  };

  getDocIdFromProtyle(protyle) {
    const pid = protyle?.id;
    if (isValidDocId(pid)) return pid.trim();
    const rootID = protyle?.block?.rootID;
    if (isValidDocId(rootID)) return rootID.trim();
    const id = protyle?.block?.id;
    if (isValidDocId(id)) return id.trim();
    return "";
  }

  async fetchBlockRow(blockId) {
    if (!isValidDocId(blockId)) return null;
    try {
      const resp = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT id, root_id AS rootId, content AS content, type AS type, box AS box, path AS path FROM blocks WHERE id='${blockId}' LIMIT 1`,
      });
      if (resp && resp.code === 0 && Array.isArray(resp.data) && resp.data.length > 0) {
        return resp.data[0] || null;
      }
    } catch (err) {
      console.error(err);
    }
    return null;
  }

  async fetchBlockAttrs(blockId) {
    if (!isValidDocId(blockId)) return null;
    try {
      const resp = await fetchSyncPost("/api/attr/getBlockAttrs", {id: blockId});
      if (resp && resp.code === 0 && resp.data && typeof resp.data === "object") {
        return resp.data;
      }
    } catch (err) {
      // ignore
    }
    return null;
  }

  async fetchDocIconsBySQL(docIds) {
    const out = new Map();
    if (!Array.isArray(docIds) || docIds.length === 0) return out;
    const ids = Array.from(
      new Set(docIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!ids.length) return out;
    const quoted = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const candidates = [
      `SELECT block_id AS blockId, name, value FROM attributes WHERE block_id IN (${quoted}) AND name IN ('icon','emoji','iconEmoji')`,
      `SELECT block_id AS blockId, name, value FROM attrs WHERE block_id IN (${quoted}) AND name IN ('icon','emoji','iconEmoji')`,
      `SELECT block_id AS blockId, name, value FROM block_attributes WHERE block_id IN (${quoted}) AND name IN ('icon','emoji','iconEmoji')`,
      `SELECT id AS blockId, icon AS value FROM blocks WHERE id IN (${quoted})`,
    ];
    for (const stmt of candidates) {
      let resp = null;
      try {
        resp = await fetchSyncPost("/api/query/sql", {stmt});
      } catch {
        resp = null;
      }
      if (!resp || resp.code !== 0 || !Array.isArray(resp.data)) {
        continue;
      }
      for (const row of resp.data) {
        const blockId = String(row?.blockId || row?.block_id || row?.id || "").trim();
        if (!isValidDocId(blockId)) continue;
        let rawValue = row?.value;
        if (rawValue == null && typeof row?.icon !== "undefined") rawValue = row.icon;
        const icon = normalizeDocIconValue(rawValue);
        if (!icon) continue;
        if (!out.has(blockId)) out.set(blockId, icon);
      }
      break;
    }
    return out;
  }

  async fillDocIcons(docs, {preferDbIconDocIdSet = null} = {}) {
    if (!Array.isArray(docs) || docs.length === 0) return;
    if (!this.docIconCache) this.docIconCache = new Map();
    const pending = [];
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const preferDb = preferDbIconDocIdSet instanceof Set && preferDbIconDocIdSet.has(docId);
      if (preferDb && this.docIconCache.has(docId)) {
        this.docIconCache.delete(docId);
      }
      const provided = normalizeDocIconValue(doc?.icon);
      if (provided && !preferDb) {
        this.docIconCache.set(docId, provided);
        doc.icon = provided;
        return;
      }
      if (!preferDb && this.docIconCache.has(docId)) {
        const cached = this.docIconCache.get(docId) || "";
        if (cached) {
          doc.icon = cached;
          return;
        }
      }
      pending.push(docId);
    });
    const missing = Array.from(new Set(pending));
    if (!missing.length) return;
    const sqlMap = await this.fetchDocIconsBySQL(missing);
    sqlMap.forEach((icon, id) => this.docIconCache.set(id, icon));
    const still = missing.filter((id) => !this.docIconCache.has(id) || !this.docIconCache.get(id));
    if (still.length) {
      const tasks = still.map((id) => async () => {
        const attrs = await this.fetchBlockAttrs(id);
        const icon = extractDocIconFromAttrs(attrs);
        if (icon) {
          this.docIconCache.set(id, icon);
        } else {
          this.docIconCache.set(id, "");
        }
      });
      await runTasksWithConcurrency(tasks, 6);
    }
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      if (normalizeDocIconValue(doc?.icon)) return;
      const cached = this.docIconCache.get(docId) || "";
      if (cached) doc.icon = cached;
    });
  }

  async resolveDocIcon(docId) {
    const id = String(docId || "").trim();
    if (!isValidDocId(id)) return "";
    if (!this.docIconCache) this.docIconCache = new Map();
    if (this.docIconCache.has(id)) {
      const cached = this.docIconCache.get(id) || "";
      if (cached) return cached;
    }
    const sqlMap = await this.fetchDocIconsBySQL([id]);
    if (sqlMap.has(id)) {
      const icon = sqlMap.get(id) || "";
      this.docIconCache.set(id, icon);
      return icon;
    }
    const attrs = await this.fetchBlockAttrs(id);
    const icon = extractDocIconFromAttrs(attrs);
    this.docIconCache.set(id, icon || "");
    return icon || "";
  }

  invalidateDocIconCacheByDocIds(docIds = []) {
    if (!this.docIconCache || typeof this.docIconCache.delete !== "function") return;
    const ids = Array.from(
      new Set((Array.isArray(docIds) ? docIds : []).map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!ids.length) return;
    ids.forEach((id) => {
      this.docIconCache.delete(id);
    });
  }

  async resolveIconUpload(
    iconValue,
    {docId = "", notebookId = "", usedUploadPaths = null, assetMap = null, iconUploadMap = null, controller} = {},
  ) {
    const icon = normalizeDocIconValue(iconValue);
    if (!icon) return "";
    const apiUrl = normalizeApiIconUrl(icon);
    if (apiUrl) {
      if (iconUploadMap && iconUploadMap.has(apiUrl)) {
        return iconUploadMap.get(apiUrl) || "";
      }
      try {
        const {blob, contentType} = await this.fetchIconUrlBlob(apiUrl, controller);
        const ext = guessImageExtension(contentType, apiUrl);
        const baseName = isValidDocId(docId) ? `doc-${docId}` : `icon-${randomSlug(8)}`;
        const rawPath = `assets/share-icons/${baseName}.${ext}`;
        const uploadPath = sanitizeAssetUploadPath(rawPath, usedUploadPaths) || normalizeAssetPath(rawPath);
        if (!uploadPath) return "";
        if (assetMap && !assetMap.has(uploadPath)) {
          assetMap.set(uploadPath, {asset: {path: uploadPath, blob}, docId});
        }
        if (usedUploadPaths) usedUploadPaths.add(uploadPath);
        if (iconUploadMap) iconUploadMap.set(apiUrl, uploadPath);
        return uploadPath;
      } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn("Icon url download failed", {url: apiUrl, error: err});
        if (iconUploadMap) iconUploadMap.set(apiUrl, "");
        return "";
      }
    }
    const kind = getDocIconKind(icon);
    if (kind === "emoji" || kind === "url" || kind === "data") return icon;
    if (kind !== "asset") return icon;
      let assetPath = normalizeDocIconAssetPath(icon);
      if (!assetPath) return "";
      const cacheKey = assetPath;
      if (iconUploadMap && iconUploadMap.has(cacheKey)) {
        return iconUploadMap.get(cacheKey) || "";
      }
      let resolvedAsset = null;
      if (assetPath.toLowerCase().startsWith("emojis/") && !DOC_ICON_IMAGE_EXT_RE.test(assetPath)) {
        try {
          resolvedAsset = await this.fetchEmojiAssetBlob(assetPath, controller, notebookId);
          if (resolvedAsset?.path) assetPath = resolvedAsset.path;
        } catch (err) {
          if (isAbortError(err)) throw err;
          console.warn("Emoji icon lookup failed", {path: assetPath, error: err});
          if (iconUploadMap) iconUploadMap.set(cacheKey, "");
          return "";
        }
      }
      if (iconUploadMap && iconUploadMap.has(assetPath)) {
        return iconUploadMap.get(assetPath) || "";
      }
      if (usedUploadPaths && usedUploadPaths.has(assetPath)) {
        if (iconUploadMap) {
          iconUploadMap.set(cacheKey, assetPath);
          iconUploadMap.set(assetPath, assetPath);
        }
        return assetPath;
      }
      const uploadPath = sanitizeAssetUploadPath(assetPath, usedUploadPaths) || normalizeAssetPath(assetPath);
      if (!uploadPath) return "";
      try {
        const asset = resolvedAsset || (await this.fetchAssetBlob(assetPath, controller, notebookId));
        if (assetMap && !assetMap.has(uploadPath)) {
          assetMap.set(uploadPath, {asset: {path: uploadPath, blob: asset.blob}, docId});
        }
        if (usedUploadPaths) usedUploadPaths.add(uploadPath);
        if (iconUploadMap) {
          iconUploadMap.set(cacheKey, uploadPath);
          iconUploadMap.set(assetPath, uploadPath);
        }
        return uploadPath;
      } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn("Icon asset download failed", {path: assetPath, error: err});
        return "";
    }
  }

  async resolveDocInfoFromAnyId(anyId) {
    if (!isValidDocId(anyId)) return {docId: "", title: ""};
    const row = await this.fetchBlockRow(anyId);
    if (!row) return {docId: "", title: ""};

    const type = row.type;
    if (type === "d") {
      return {docId: anyId, title: typeof row.content === "string" ? row.content : ""};
    }

    const rootId = row.rootId;
    if (!isValidDocId(rootId)) return {docId: "", title: ""};
    const rootRow = await this.fetchBlockRow(rootId);
    const title = rootRow && typeof rootRow.content === "string" ? rootRow.content : "";
    return {docId: rootId, title};
  }

  extractAnyBlockIdFromDOM() {
    const candidates = [];
    const pushFromEl = (el) => {
      if (!el || typeof el.getAttribute !== "function") return;
      const attrs = [
        "data-node-id",
        "data-id",
        "data-block-id",
        "data-root-id",
        "data-doc-id",
      ];
      for (const attr of attrs) {
        const v = el.getAttribute(attr);
        if (isValidDocId(v)) {
          candidates.push(v.trim());
          return;
        }
      }
      if (el.dataset) {
        for (const v of Object.values(el.dataset)) {
          if (isValidDocId(v)) {
            candidates.push(v.trim());
            return;
          }
        }
      }
      if (isValidDocId(el.id)) candidates.push(el.id.trim());
    };

    // 1) From active element upwards.
    let el = document.activeElement;
    if (el && typeof el.closest === "function" && el.closest(".protyle")) {
      for (let i = 0; el && i < 20; i++) {
        pushFromEl(el);
        el = el.parentElement;
      }
    }

    // 2) From focused protyle block.
    const protyleEls = Array.from(document.querySelectorAll(".protyle")).filter((p) => isElementVisiblySized(p));
    const bestProtyle = protyleEls.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];

    pushFromEl(bestProtyle);
    const blockInProtyle = bestProtyle?.querySelector?.("[data-node-id]");
    pushFromEl(blockInProtyle);

    return candidates.find(Boolean) || "";
  }

  async refreshCurrentDocContext(protyle) {
    const p = protyle || pickActiveProtyle() || globalThis?.siyuan?.mobile?.editor || globalThis?.siyuan?.mobile?.popEditor;
    let docId = this.getDocIdFromProtyle(p);
    let title = "";

    if (!docId) {
      // Fallback 1: use block id from protyle.block.id and resolve to root doc id.
      const isFromVisibleProtyle = !p?.element || isElementVisiblySized(p?.element);
      const anyId = isFromVisibleProtyle ? p?.block?.id : "";
      if (isValidDocId(anyId)) {
        const info = await this.resolveDocInfoFromAnyId(anyId);
        docId = info.docId;
        title = info.title;
      }
    }

    if (!docId) {
      // Fallback 2: try DOM (active block id) and resolve to root doc id.
      const anyId = this.extractAnyBlockIdFromDOM();
      if (isValidDocId(anyId)) {
        const info = await this.resolveDocInfoFromAnyId(anyId);
        docId = info.docId;
        title = info.title;
      }
    }

    if (!docId) {
      // Fallback 3: backStack (desktop).
      const hasVisibleProtyle = Array.from(document.querySelectorAll(".protyle")).some((el) => isElementVisiblySized(el));
      if (!hasVisibleProtyle) {
        // When no document is opened, backStack may still contain the last doc.
        // Avoid treating it as current.
      } else {
      try {
        const stack = globalThis?.siyuan?.backStack;
        if (Array.isArray(stack) && stack.length > 0) {
          for (let i = stack.length - 1; i >= 0; i--) {
            const item = stack[i];
            const id = item?.protyle?.block?.rootID || item?.id;
            if (isValidDocId(id)) {
              const info = await this.resolveDocInfoFromAnyId(id);
              docId = info.docId;
              title = info.title;
              break;
            }
          }
        }
      } catch {
        // ignore
      }
      }
    }

    if (!docId) {
      this.currentDoc = {id: "", title: ""};
      this.updateTopBarState();
      this.renderSettingCurrent?.();
      return;
    }

    if (this.currentDoc.id !== docId) {
      if (!title) {
        const info = await this.resolveDocInfoFromAnyId(docId);
        title = info.title;
      }
      this.currentDoc = {id: docId, title: title || ""};
    }

    this.updateTopBarState();
    this.renderSettingCurrent?.();
  }

  updateTopBarState() {
    this.refreshDocTreeMarks();
  }

  getShareById(shareId) {
    if (!shareId) return null;
    return this.shares.find((s) => String(s.id) === String(shareId)) || null;
  }

  getShareByDocId(docId) {
    if (!isValidDocId(docId)) return null;
    return this.shares.find((s) => s.type === SHARE_TYPES.DOC && s.docId === docId) || null;
  }

  getShareByNotebookId(notebookId) {
    if (!isValidNotebookId(notebookId)) return null;
    return (
      this.shares.find((s) => s.type === SHARE_TYPES.NOTEBOOK && s.notebookId === notebookId) || null
    );
  }

  getShareUrl(share) {
    if (!share) return "";
    const base = normalizeUrlBase(this.settings.siteUrl);
    if (share.url) return share.url;
    const path = share.path || (share.slug ? `/s/${encodeURIComponent(share.slug)}` : "");
    if (!base || !path) return "";
    return `${base}${path}`;
  }

  normalizeShareOptionValue(raw, {fallbackIncludeChildren = null} = {}) {
    if (typeof raw === "boolean") {
      return {
        includeChildren: raw,
        excludedDocIds: [],
      };
    }
    const fallback =
      typeof fallbackIncludeChildren === "boolean" ? fallbackIncludeChildren : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      if (fallback === null) return null;
      return {
        includeChildren: fallback,
        excludedDocIds: [],
      };
    }
    return {
      includeChildren:
        typeof raw.includeChildren === "boolean"
          ? raw.includeChildren
          : fallback === null
            ? false
            : fallback,
      excludedDocIds: normalizeDocIdList(raw.excludedDocIds),
    };
  }

  normalizeShareOptionsMap(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([shareIdRaw, optionRaw]) => {
      const shareId = String(shareIdRaw || "").trim();
      if (!shareId) return;
      const option = this.normalizeShareOptionValue(optionRaw);
      if (!option) return;
      out[shareId] = option;
    });
    return out;
  }

  getShareOptionValue(shareId, {fallbackIncludeChildren = null} = {}) {
    const key = String(shareId || "").trim();
    if (!key) {
      return this.normalizeShareOptionValue(null, {fallbackIncludeChildren});
    }
    const optionMap =
      this.shareOptions && typeof this.shareOptions === "object" && !Array.isArray(this.shareOptions)
        ? this.shareOptions
        : {};
    const optionRaw = Object.prototype.hasOwnProperty.call(optionMap, key) ? optionMap[key] : null;
    return this.normalizeShareOptionValue(optionRaw, {fallbackIncludeChildren});
  }

  setShareOptionValue(shareId, {includeChildren = false, excludedDocIds = []} = {}) {
    const key = String(shareId || "").trim();
    if (!key) return;
    const normalized = this.normalizeShareOptionValue(
      {
        includeChildren: !!includeChildren,
        excludedDocIds,
      },
      {fallbackIncludeChildren: !!includeChildren},
    );
    if (!normalized) return;
    if (!this.shareOptions || typeof this.shareOptions !== "object" || Array.isArray(this.shareOptions)) {
      this.shareOptions = {};
    }
    this.shareOptions[key] = normalized;
  }

  buildDocSelectionRows(docs, {rootDocId = ""} = {}) {
    const listRaw = Array.isArray(docs) ? docs : [];
    const map = new Map();
    listRaw.forEach((item, index) => {
      const docId = String(item?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      if (map.has(docId)) return;
      map.set(docId, {
        docId,
        title: String(item?.title || ""),
        icon: normalizeDocIconValue(item?.icon || ""),
        parentId: String(item?.parentId || "").trim(),
        sortIndex: Number.isFinite(Number(item?.sortIndex)) ? Number(item.sortIndex) : index,
        sortOrder: Number.isFinite(Number(item?.sortOrder)) ? Number(item.sortOrder) : index,
      });
    });
    if (!map.size) return [];

    const idSet = new Set(map.keys());
    const childrenMap = new Map();
    const parentMap = new Map();
    map.forEach((doc) => {
      const parentId = String(doc.parentId || "").trim();
      const validParent = isValidDocId(parentId) && idSet.has(parentId) ? parentId : "";
      parentMap.set(doc.docId, validParent);
      if (!validParent) return;
      if (!childrenMap.has(validParent)) childrenMap.set(validParent, []);
      childrenMap.get(validParent).push(doc);
    });
    const sortDocs = (arr) =>
      arr.sort((a, b) => {
        const aOrder = Number.isFinite(Number(a?.sortOrder)) ? Number(a.sortOrder) : 0;
        const bOrder = Number.isFinite(Number(b?.sortOrder)) ? Number(b.sortOrder) : 0;
        if (aOrder !== bOrder) return aOrder - bOrder;
        const aIndex = Number.isFinite(Number(a?.sortIndex)) ? Number(a.sortIndex) : 0;
        const bIndex = Number.isFinite(Number(b?.sortIndex)) ? Number(b.sortIndex) : 0;
        if (aIndex !== bIndex) return aIndex - bIndex;
        const aTitle = String(a?.title || "");
        const bTitle = String(b?.title || "");
        if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);
        return String(a?.docId || "").localeCompare(String(b?.docId || ""));
      });

    childrenMap.forEach((arr, parentId) => {
      childrenMap.set(parentId, sortDocs(arr));
    });

    const roots = [];
    const rootCandidate = String(rootDocId || "").trim();
    if (isValidDocId(rootCandidate) && map.has(rootCandidate)) {
      roots.push(map.get(rootCandidate));
    } else {
      const top = [];
      map.forEach((doc) => {
        const parentId = parentMap.get(doc.docId) || "";
        if (!parentId) top.push(doc);
      });
      roots.push(...sortDocs(top));
    }

    const out = [];
    const visited = new Set();
    const pushNode = (doc, depth) => {
      if (!doc || visited.has(doc.docId)) return;
      visited.add(doc.docId);
      out.push({
        ...doc,
        parentId: parentMap.get(doc.docId) || "",
        depth: Math.max(0, depth),
      });
      const children = childrenMap.get(doc.docId) || [];
      children.forEach((child) => pushNode(child, depth + 1));
    };

    roots.forEach((doc) => pushNode(doc, 0));
    map.forEach((doc) => {
      if (!visited.has(doc.docId)) pushNode(doc, 0);
    });
    return out;
  }

  expandExcludedDocIds(scopeDocs, excludedDocIds, {lockedDocIds = []} = {}) {
    const docs = Array.isArray(scopeDocs) ? scopeDocs : [];
    if (!docs.length) return new Set();
    const docSet = new Set(
      docs.map((doc) => String(doc?.docId || "").trim()).filter((id) => isValidDocId(id)),
    );
    if (!docSet.size) return new Set();
    const lockedSet = new Set(normalizeDocIdList(lockedDocIds).filter((id) => docSet.has(id)));
    const childrenMap = new Map();
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!docSet.has(docId)) return;
      const parentId = String(doc?.parentId || "").trim();
      if (!docSet.has(parentId)) return;
      if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
      childrenMap.get(parentId).push(docId);
    });
    const queue = normalizeDocIdList(excludedDocIds)
      .filter((id) => docSet.has(id))
      .filter((id) => !lockedSet.has(id));
    const out = new Set();
    while (queue.length > 0) {
      const docId = queue.pop();
      if (!docId || out.has(docId) || lockedSet.has(docId)) continue;
      out.add(docId);
      const children = childrenMap.get(docId) || [];
      children.forEach((childId) => {
        if (!out.has(childId) && !lockedSet.has(childId)) queue.push(childId);
      });
    }
    return out;
  }

  compactExcludedDocIds(scopeDocs, excludedDocIds, {lockedDocIds = []} = {}) {
    const docs = Array.isArray(scopeDocs) ? scopeDocs : [];
    if (!docs.length) return [];
    const expandedSet = this.expandExcludedDocIds(docs, excludedDocIds, {lockedDocIds});
    if (!expandedSet.size) return [];
    const parentMap = new Map();
    const ordered = [];
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId) || parentMap.has(docId)) return;
      ordered.push(docId);
      parentMap.set(docId, String(doc?.parentId || "").trim());
    });
    const out = [];
    ordered.forEach((docId) => {
      if (!expandedSet.has(docId)) return;
      let parentId = parentMap.get(docId) || "";
      let hasExcludedAncestor = false;
      while (isValidDocId(parentId)) {
        if (expandedSet.has(parentId)) {
          hasExcludedAncestor = true;
          break;
        }
        parentId = parentMap.get(parentId) || "";
      }
      if (!hasExcludedAncestor) out.push(docId);
    });
    return out;
  }

  filterScopeDocsByExcludedDocIds(scopeDocs, excludedDocIds, {lockedDocIds = []} = {}) {
    const docs = Array.isArray(scopeDocs) ? scopeDocs : [];
    const expandedSet = this.expandExcludedDocIds(docs, excludedDocIds, {lockedDocIds});
    if (!expandedSet.size) {
      return {
        docs: docs.slice(),
        selectedDocIds: this.compactExcludedDocIds(docs, excludedDocIds, {lockedDocIds}),
        excludedSet: expandedSet,
      };
    }
    return {
      docs: docs.filter((doc) => !expandedSet.has(String(doc?.docId || "").trim())),
      selectedDocIds: this.compactExcludedDocIds(docs, excludedDocIds, {lockedDocIds}),
      excludedSet: expandedSet,
    };
  }

  async openExcludedDocsDialog(
    {
      itemType = SHARE_TYPES.NOTEBOOK,
      itemTitle = "",
      docs = [],
      selectedDocIds = [],
      lockedDocIds = [],
      loader = null,
    } = {},
  ) {
    const t = this.t.bind(this);
    const loadingLabel = t("siyuanShare.message.processing");
    const rootDocId = itemType === SHARE_TYPES.DOC ? String(lockedDocIds?.[0] || "").trim() : "";
    const lockedList = normalizeDocIdList(lockedDocIds);
    const normalizeDoc = (raw, fallbackOrder = 0) => {
      const docId = String(raw?.docId || "").trim();
      if (!isValidDocId(docId)) return null;
      return {
        docId,
        title: String(raw?.title || ""),
        parentId: String(raw?.parentId || "").trim(),
        sortIndex: Number.isFinite(Number(raw?.sortIndex)) ? Number(raw.sortIndex) : fallbackOrder,
        sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Number(raw.sortOrder) : fallbackOrder,
      };
    };
    const docMap = new Map();
    (Array.isArray(docs) ? docs : []).forEach((doc, index) => {
      const normalized = normalizeDoc(doc, index);
      if (!normalized || docMap.has(normalized.docId)) return;
      docMap.set(normalized.docId, normalized);
    });
    let rows = [];
    let childrenMap = new Map();
    let parentMap = new Map();
    let lockedSet = new Set();
    let selectedRoots = normalizeDocIdList(selectedDocIds).filter((id) => !lockedList.includes(id));
    let selectedSet = new Set();
    let loading = typeof loader === "function";
    let loadedCount = docMap.size;
    const rebuildState = () => {
      rows = this.buildDocSelectionRows(Array.from(docMap.values()), {rootDocId});
      const rowIdSet = new Set(rows.map((row) => row.docId));
      childrenMap = new Map();
      parentMap = new Map();
      rows.forEach((row) => {
        const rowId = String(row?.docId || "").trim();
        const parentId = String(row?.parentId || "").trim();
        if (isValidDocId(rowId)) {
          parentMap.set(rowId, parentId);
        }
        if (!rowIdSet.has(parentId)) return;
        if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
        childrenMap.get(parentId).push(rowId);
      });
      lockedSet = new Set(lockedList.filter((id) => rowIdSet.has(id)));
      const unresolvedRoots = selectedRoots.filter((id) => !rowIdSet.has(id) && !lockedList.includes(id));
      const expanded = this.expandExcludedDocIds(rows, selectedRoots, {lockedDocIds: lockedList});
      selectedSet = new Set(
        Array.from(expanded).filter((id) => rowIdSet.has(id) && !lockedSet.has(id)),
      );
      const compacted = this.compactExcludedDocIds(rows, Array.from(selectedSet), {
        lockedDocIds: lockedList,
      });
      selectedRoots = normalizeDocIdList([...compacted, ...unresolvedRoots]);
      loadedCount = docMap.size;
    };
    const updateSelectedRootsFromSet = () => {
      const rowIdSet = new Set(rows.map((row) => row.docId));
      const unresolvedRoots = selectedRoots.filter((id) => !rowIdSet.has(id) && !lockedList.includes(id));
      const compacted = this.compactExcludedDocIds(rows, Array.from(selectedSet), {
        lockedDocIds: lockedList,
      });
      selectedRoots = normalizeDocIdList([...compacted, ...unresolvedRoots]);
    };
    rebuildState();

    return new Promise((resolve) => {
      let done = false;
      let dialog = null;
      let loadingController = null;
      let listScrollEl = null;
      let renderTimer = null;
      let lastRenderAt = 0;
      let interactionFreezeUntil = 0;
      let pendingLoadedSinceRender = 0;
      const LOADING_RENDER_INTERVAL_MS = 900;
      const LOADING_RENDER_BATCH_SIZE = 160;
      const freezeRenderDuringInteraction = (ms = 220) => {
        const until = Date.now() + Math.max(0, Math.floor(Number(ms) || 0));
        if (until <= interactionFreezeUntil) return;
        interactionFreezeUntil = until;
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = null;
          scheduleRender();
        }
      };
      const finish = (value = null) => {
        if (done) return;
        done = true;
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = null;
        }
        if (loadingController && !loadingController.signal?.aborted) {
          try {
            loadingController.abort();
          } catch {
            // ignore
          }
        }
        dialog?.element?.removeEventListener?.("click", onClick);
        dialog?.element?.removeEventListener?.("change", onChange);
        dialog?.element?.removeEventListener?.("input", onInput);
        dialog?.element?.removeEventListener?.("pointerdown", onPointerDown);
        dialog?.element?.removeEventListener?.("wheel", onWheel);
        listScrollEl?.removeEventListener?.("scroll", onListScroll);
        resolve(value);
      };

      const content = `<div class="b3-dialog__content sps-exclude-dialog">
  <div class="sps-exclude-dialog__header">
    <div class="sps-exclude-dialog__title">${escapeHtml(t("siyuanShare.title.selectExcludedDocs"))}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(itemTitle || "")}</div>
  </div>
  <input id="sps-exclude-search" class="b3-text-field fn__block" placeholder="${escapeAttr(
    t("siyuanShare.placeholder.searchDocs"),
  )}" />
  <div class="siyuan-plugin-share__muted sps-exclude-dialog__summary"></div>
  <div class="sps-exclude-dialog__list"></div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-action="cancel">${escapeHtml(t("siyuanShare.action.cancel"))}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-action="confirm">${escapeHtml(t("siyuanShare.action.confirm"))}</button>
</div>`;

      dialog = new Dialog({
        title: t("siyuanShare.title.selectExcludedDocs"),
        content,
        width: "min(760px, 94vw)",
        destroyCallback: () => finish(null),
      });
      const scheduleRender = () => {
        if (done) return;
        if (renderTimer) return;
        const now = Date.now();
        let delay = Math.max(24, LOADING_RENDER_INTERVAL_MS - (now - lastRenderAt));
        const freezeDelay = interactionFreezeUntil - now;
        if (freezeDelay > delay) delay = freezeDelay;
        renderTimer = setTimeout(() => {
          if (done) return;
          renderTimer = null;
          rebuildState();
          render();
          lastRenderAt = Date.now();
          pendingLoadedSinceRender = 0;
        }, Math.max(0, delay));
      };

      const toggleSubtree = (docId, checked) => {
        if (!isValidDocId(docId)) return;
        const queue = [docId];
        const visited = new Set();
        while (queue.length > 0) {
          const current = queue.pop();
          if (!current || visited.has(current)) continue;
          visited.add(current);
          if (!lockedSet.has(current)) {
            if (checked) selectedSet.add(current);
            else selectedSet.delete(current);
          }
          const children = childrenMap.get(current) || [];
          children.forEach((childId) => {
            if (!visited.has(childId)) queue.push(childId);
          });
        }
        if (!checked) {
          const cancelledAncestorIds = new Set();
          let parentId = parentMap.get(docId) || "";
          while (isValidDocId(parentId) && !cancelledAncestorIds.has(parentId)) {
            cancelledAncestorIds.add(parentId);
            if (selectedSet.has(parentId)) {
              selectedSet.delete(parentId);
            }
            parentId = parentMap.get(parentId) || "";
          }
          if (cancelledAncestorIds.size > 0) {
            selectedRoots = selectedRoots.filter((id) => !cancelledAncestorIds.has(id));
          }
        }
        updateSelectedRootsFromSet();
      };

      const render = () => {
        const root = dialog?.element;
        if (!root) return;
        const searchInput = root.querySelector("#sps-exclude-search");
        const summaryEl = root.querySelector(".sps-exclude-dialog__summary");
        const listEl = root.querySelector(".sps-exclude-dialog__list");
        const confirmBtn = root.querySelector("[data-action='confirm']");
        if (!summaryEl || !listEl) return;
        if (confirmBtn) confirmBtn.disabled = loading;
        const keyword = String(searchInput?.value || "")
          .trim()
          .toLowerCase();
        const visibleRows = keyword
          ? rows.filter((row) => {
              const title = String(row?.title || "").toLowerCase();
              const docId = String(row?.docId || "").toLowerCase();
              return title.includes(keyword) || docId.includes(keyword);
            })
          : rows;

        const summaryParts = [t("siyuanShare.label.excludedDocsCount", {count: selectedSet.size})];
        if (loading) {
          summaryParts.push(`${loadingLabel} (${loadedCount})`);
        }
        if (lockedSet.size) {
          summaryParts.push(t("siyuanShare.hint.excludeRootLocked"));
        }
        summaryEl.textContent = summaryParts.join(" | ");
        const prevScrollTop = listEl.scrollTop;

        if (!visibleRows.length) {
          const emptyLabel = keyword
            ? t("siyuanShare.message.noMatchingDocs")
            : loading
              ? loadingLabel
              : t("siyuanShare.message.noDocsToExclude");
          listEl.innerHTML = `<div class="siyuan-plugin-share__muted">${escapeHtml(emptyLabel)}</div>`;
          listEl.scrollTop = prevScrollTop;
          return;
        }
        listEl.innerHTML = visibleRows
          .map((row) => {
            const docId = String(row?.docId || "").trim();
            const checked = selectedSet.has(docId);
            const locked = lockedSet.has(docId);
            const disabled = locked;
            const depth = Math.max(0, Math.floor(Number(row?.depth) || 0));
            const title = String(row?.title || "").trim() || t("siyuanShare.label.untitled");
            const indent = 8 + Math.min(depth, 18) * 16;
            return `<label class="sps-exclude-row${locked ? " sps-exclude-row--locked" : ""}" style="padding-left:${indent}px;">
  <input type="checkbox" data-doc-id="${escapeAttr(docId)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} />
  <span class="sps-exclude-row__title">${escapeHtml(title)}</span>
  <span class="sps-exclude-row__meta">${escapeHtml(docId)}</span>
</label>`;
          })
          .join("");
        listEl.scrollTop = prevScrollTop;
      };

      const onClick = (event) => {
        const btn = event.target?.closest?.("[data-action]");
        if (!btn) return;
        const action = btn.getAttribute("data-action");
        if (!action) return;
        if (action === "cancel") {
          finish(null);
          dialog?.destroy();
          return;
        }
        if (action === "confirm") {
          if (loading) return;
          const selected = this.compactExcludedDocIds(rows, selectedRoots, {
            lockedDocIds: lockedList,
          });
          finish({
            selectedDocIds: selected,
            excludedCount: selectedSet.size,
          });
          dialog?.destroy();
        }
      };

      const onInput = (event) => {
        const target = event.target;
        if (!target || target.id !== "sps-exclude-search") return;
        freezeRenderDuringInteraction(220);
        render();
        lastRenderAt = Date.now();
      };

      const onChange = (event) => {
        const target = event.target;
        if (!target || target.type !== "checkbox") return;
        const docId = target.getAttribute?.("data-doc-id");
        if (!isValidDocId(docId) || lockedSet.has(docId)) return;
        freezeRenderDuringInteraction(700);
        toggleSubtree(docId, !!target.checked);
        render();
        lastRenderAt = Date.now();
      };
      const onPointerDown = (event) => {
        const target = event.target;
        if (!target?.closest?.(".sps-exclude-row")) return;
        freezeRenderDuringInteraction(700);
      };
      const onWheel = (event) => {
        const target = event.target;
        if (!target?.closest?.(".sps-exclude-dialog__list")) return;
        freezeRenderDuringInteraction(320);
      };
      const onListScroll = () => {
        freezeRenderDuringInteraction(260);
      };
      const addDocRow = (rawDoc, indexHint = 0) => {
        if (done) return false;
        const normalized = normalizeDoc(rawDoc, indexHint);
        if (!normalized || docMap.has(normalized.docId)) return false;
        docMap.set(normalized.docId, normalized);
        loadedCount = docMap.size;
        pendingLoadedSinceRender += 1;
        return true;
      };
      const startLoading = async () => {
        if (typeof loader !== "function") {
          loading = false;
          rebuildState();
          render();
          lastRenderAt = Date.now();
          return;
        }
        loading = true;
        render();
        lastRenderAt = Date.now();
        loadingController = new AbortController();
        try {
          const loaded = await loader({
            controller: loadingController,
            onDoc: (doc) => {
              if (done) return;
              if (addDocRow(doc, docMap.size)) {
                if (docMap.size <= 60 || pendingLoadedSinceRender >= LOADING_RENDER_BATCH_SIZE) {
                  scheduleRender();
                }
              }
            },
          });
          if (done) return;
          const finalDocs = Array.isArray(loaded?.docs)
            ? loaded.docs
            : Array.isArray(loaded)
              ? loaded
              : [];
          finalDocs.forEach((doc, index) => {
            addDocRow(doc, index);
          });
        } catch (err) {
          if (done) return;
          if (!isAbortError(err)) {
            this.showErr(err);
          }
        } finally {
          if (done) return;
          loading = false;
          rebuildState();
          render();
          lastRenderAt = Date.now();
        }
      };

      dialog?.element?.addEventListener?.("click", onClick);
      dialog?.element?.addEventListener?.("input", onInput);
      dialog?.element?.addEventListener?.("change", onChange);
      dialog?.element?.addEventListener?.("pointerdown", onPointerDown);
      dialog?.element?.addEventListener?.("wheel", onWheel, {passive: true});
      listScrollEl = dialog?.element?.querySelector?.(".sps-exclude-dialog__list") || null;
      listScrollEl?.addEventListener?.("scroll", onListScroll, {passive: true});
      render();
      lastRenderAt = Date.now();
      void startLoading();
    });
  }

  async openShareDialogFor({type = SHARE_TYPES.DOC, id = "", title = ""} = {}) {
    const t = this.t.bind(this);
    const itemType = type === SHARE_TYPES.NOTEBOOK ? SHARE_TYPES.NOTEBOOK : SHARE_TYPES.DOC;
    let itemId = String(id || "").trim();
    if (!itemId && itemType === SHARE_TYPES.DOC) {
      for (let i = 0; i < 5; i++) {
        await this.refreshCurrentDocContext();
        if (isValidDocId(this.currentDoc.id)) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      itemId = this.currentDoc.id;
    }
    if (!itemId) {
      this.notify(t("siyuanShare.message.noCurrentDoc"));
      return;
    }

    let itemTitle = title || itemId;
    if (itemType === SHARE_TYPES.DOC) {
      if (!itemTitle || itemTitle === itemId) {
        const info = await this.resolveDocInfoFromAnyId(itemId);
        itemTitle = info?.title || itemTitle || t("siyuanShare.label.unknown");
      }
    } else {
      if (!this.notebooks.length) {
        await this.refreshNotebookOptions({silent: true});
      }
      const notebook = this.notebooks.find((n) => n.id === itemId);
      itemTitle = notebook?.name || itemTitle || t("siyuanShare.label.unknown");
    }

    const typeLabel =
      itemType === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
    const passwordKeepToken = "__KEEP__";
    let draftExcludedDocIds = null;
    let draftExcludedDocCount = null;
    let excludedCountRequestId = 0;
    let excludedCountController = null;
    const getShare = () =>
      itemType === SHARE_TYPES.NOTEBOOK ? this.getShareByNotebookId(itemId) : this.getShareByDocId(itemId);
    const buildViewState = () => {
      const share = getShare();
      const url = share ? this.getShareUrl(share) : "";
      const slugInputValue = normalizeShareSlugInput(share?.slug || "");
      const hasPassword = !!share?.hasPassword;
      const expiresAt = normalizeTimestampMs(share?.expiresAt || 0);
      const expiresInputValue = expiresAt ? toDateTimeLocalInput(expiresAt) : "";
      const visitorLimitValue = Number.isFinite(Number(share?.visitorLimit))
        ? Math.max(0, Math.floor(Number(share.visitorLimit)))
        : 0;
      const visitorInputValue = visitorLimitValue > 0 ? String(visitorLimitValue) : "";
      const currentPasswordLabel = hasPassword
        ? t("siyuanShare.label.passwordSet")
        : t("siyuanShare.label.passwordNotSet");
      const currentExpiresLabel = expiresAt ? this.formatTime(expiresAt) : t("siyuanShare.label.expiresNotSet");
      const currentVisitorLabel =
        visitorLimitValue > 0
          ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
          : t("siyuanShare.label.visitorLimitNotSet");
      const passwordInputValue = share && hasPassword ? passwordKeepToken : "";
      const passwordPlaceholder = share
        ? (hasPassword ? t("siyuanShare.hint.passwordKeep") : t("siyuanShare.label.passwordNotSet"))
        : t("siyuanShare.hint.passwordOptional");
      const option = this.getShareOptionValue(share?.id, {
        fallbackIncludeChildren: typeof share?.includeChildren === "boolean" ? share.includeChildren : false,
      });
      const includeChildrenDefault =
        typeof option?.includeChildren === "boolean"
          ? option.includeChildren
          : typeof share?.includeChildren === "boolean"
            ? share.includeChildren
            : false;
      const excludedDefault = normalizeDocIdList(
        draftExcludedDocIds === null
          ? (option?.excludedDocIds || share?.excludedDocIds || [])
          : draftExcludedDocIds,
      );
      const excludedCountDefault = Number.isFinite(Number(draftExcludedDocCount))
        ? Math.max(0, Math.floor(Number(draftExcludedDocCount)))
        : excludedDefault.length;
      return {
        share,
        url,
        expiresInputValue,
        visitorLimitValue,
        visitorInputValue,
        currentPasswordLabel,
        currentExpiresLabel,
        currentVisitorLabel,
        slugInputValue,
        passwordInputValue,
        passwordPlaceholder,
        includeChildrenDefault,
        excludedDocIds: excludedDefault,
        excludedDocCount: excludedCountDefault,
      };
    };

    const renderContent = () => {
      const state = buildViewState();
      const share = state.share;
      const url = state.url;
      const expiresInputValue = state.expiresInputValue;
      const visitorInputValue = state.visitorInputValue;
      const currentPasswordLabel = state.currentPasswordLabel;
      const currentExpiresLabel = state.currentExpiresLabel;
      const currentVisitorLabel = state.currentVisitorLabel;
      const slugInputValue = state.slugInputValue;
      const passwordInputValue = state.passwordInputValue;
      const passwordPlaceholder = state.passwordPlaceholder;
      const includeChildrenDefault = !!state.includeChildrenDefault;
      const excludedDocIds = normalizeDocIdList(state.excludedDocIds || []);
      const excludedDocCount = Math.max(0, Math.floor(Number(state.excludedDocCount) || 0));
      const excludedCountLabel = t("siyuanShare.label.excludedDocsCount", {count: excludedDocCount});
      const showDocOptions = itemType === SHARE_TYPES.DOC;
      const showExcludeOptions = itemType === SHARE_TYPES.NOTEBOOK || showDocOptions;
      const excludeEnabled = itemType === SHARE_TYPES.NOTEBOOK || includeChildrenDefault;
      const includeBlockHtml = showDocOptions
        ? `<label class="sps-checkbox">
      <input id="sps-share-include-children" type="checkbox"${includeChildrenDefault ? " checked" : ""} />
      <span>${escapeHtml(t("siyuanShare.label.includeChildren"))}</span>
    </label>
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.hint.includeChildren"))}</div>`
        : "";
      const excludeInputsHtml = `<input id="sps-share-excluded-doc-ids" type="hidden" value="${escapeAttr(excludedDocIds.join(","))}" />
      <input id="sps-share-excluded-doc-count" type="hidden" value="${escapeAttr(String(excludedDocCount))}" />`;
      const excludeActionsHtml = `<div class="siyuan-plugin-share__actions sps-share-exclude__actions">
        <button class="b3-button b3-button--outline sps-share-exclude__btn" data-action="pick-excluded-docs"${excludeEnabled ? "" : " disabled"}>${escapeHtml(
          t("siyuanShare.action.selectExcludedDocs"),
        )}</button>
        <button class="b3-button b3-button--outline sps-share-exclude__btn" data-action="clear-excluded-docs"${excludeEnabled && excludedDocIds.length ? "" : " disabled"}>${escapeHtml(
          t("siyuanShare.action.clearExcludedDocs"),
        )}</button>
      </div>`;
      const excludeBlockHtml = showExcludeOptions
        ? showDocOptions
          ? `<div class="sps-share-exclude sps-share-exclude--doc">
      ${excludeInputsHtml}
      ${excludeActionsHtml}
      <div id="sps-share-excluded-count" class="siyuan-plugin-share__muted">${escapeHtml(excludedCountLabel)}</div>
    </div>`
          : `<div class="sps-share-exclude sps-share-exclude--notebook">
      ${excludeInputsHtml}
      ${excludeActionsHtml}
      <div id="sps-share-excluded-count" class="siyuan-plugin-share__muted">${escapeHtml(excludedCountLabel)}</div>
    </div>`
        : "";
      return `<div class="siyuan-plugin-share sps-dialog-body">
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(typeLabel)}</div>
    <div>${escapeHtml(itemTitle)}</div>
    <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(
      t("siyuanShare.label.id"),
    )}: ${escapeHtml(itemId)}</div>
  </div>
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.accessSettings"))}</div>
    <div class="siyuan-plugin-share__grid">
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.accessPassword"))}</div>
      <input id="sps-share-password" type="password" class="b3-text-field" value="${escapeAttr(
        passwordInputValue,
      )}" placeholder="${escapeAttr(passwordPlaceholder)}" />
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.expiresAt"))}</div>
      <input id="sps-share-expires" type="datetime-local" step="60" class="b3-text-field" value="${escapeAttr(
        expiresInputValue,
      )}" />
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.visitorLimit"))}</div>
      <input id="sps-share-visitor-limit" type="number" min="0" step="1" class="b3-text-field" value="${escapeAttr(
        visitorInputValue,
      )}" placeholder="${escapeAttr(t("siyuanShare.hint.visitorLimit"))}" />
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.linkSuffix"))}</div>
      <input id="sps-share-slug" type="text" class="b3-text-field" value="${escapeAttr(
        slugInputValue,
      )}" placeholder="${escapeAttr(
        t("siyuanShare.hint.linkSuffixPlaceholder", {
          min: SHARE_SLUG_MIN_LENGTH,
          max: SHARE_SLUG_MAX_LENGTH,
        }),
      )}" minlength="${SHARE_SLUG_MIN_LENGTH}" maxlength="${SHARE_SLUG_MAX_LENGTH}" pattern="[a-z0-9]*" autocomplete="off" autocapitalize="off" spellcheck="false" />
    </div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(
      currentPasswordLabel,
    )} | ${escapeHtml(currentExpiresLabel)} | ${escapeHtml(currentVisitorLabel)}</div>
  </div>
  ${
    showDocOptions || showExcludeOptions
      ? `<div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.shareOptions"))}</div>
    ${
      showDocOptions
        ? `<div class="sps-share-doc-options">
      <div class="sps-share-doc-options__include">${includeBlockHtml}</div>
      ${excludeBlockHtml}
    </div>`
        : excludeBlockHtml
    }
  </div>`
      : ""
  }
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.shareLink"))}</div>
    ${
      share
        ? `<div class="siyuan-plugin-share__muted">${escapeHtml(
            t("siyuanShare.label.shareId"),
          )}: <span class="siyuan-plugin-share__mono">${escapeHtml(share.slug || "")}</span></div>
      <div class="siyuan-plugin-share__actions" style="align-items: center;">
        <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
        <span class="sps-qr-btn" data-action="show-qr" data-url="${escapeAttr(url)}" title="${escapeAttr(t("siyuanShare.qr.title"))}">${SPS_QR_ICON_SVG}</span>
        <button class="b3-button b3-button--outline" data-action="copy" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
        <button class="b3-button b3-button--outline" data-action="copy-info" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.copyShareInfo"))}</button>
      </div>
      <div class="siyuan-plugin-share__actions">
        <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.updateShare"))}</button>
        <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
        <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.deleteShare"))}</button>
      </div>`
        : `<div class="siyuan-plugin-share__muted">${escapeHtml(
            t("siyuanShare.message.noShareYet"),
          )}</div>
      <div class="siyuan-plugin-share__actions">
        <button class="b3-button b3-button--outline" data-action="share" data-item-id="${escapeAttr(
          itemId,
        )}">${escapeHtml(t("siyuanShare.action.createShare"))}</button>
      </div>`
    }
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-action="close">${escapeHtml(
    t("siyuanShare.action.close"),
  )}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-action="open-settings">${escapeHtml(
    t("siyuanShare.action.openSettings"),
  )}</button>
</div>`;
    };
    const content = `<div class="sps-share-dialog-content">${renderContent()}</div>`;

    const normalizeExcludedDocCount = (value, fallback = 0) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return Math.max(0, Math.floor(Number(fallback) || 0));
      }
      return Math.max(0, Math.floor(parsed));
    };

    const writeExcludedDocCount = (root, nextCount = null) => {
      const hiddenIds = root?.querySelector?.("#sps-share-excluded-doc-ids");
      const fallbackCount = normalizeDocIdList(hiddenIds?.value || "").length;
      const safeCount = normalizeExcludedDocCount(nextCount, fallbackCount);
      draftExcludedDocCount = safeCount;
      const hiddenCount = root?.querySelector?.("#sps-share-excluded-doc-count");
      if (hiddenCount) {
        hiddenCount.value = String(safeCount);
      }
      const countEl = root?.querySelector?.("#sps-share-excluded-count");
      if (countEl) {
        countEl.textContent = t("siyuanShare.label.excludedDocsCount", {count: safeCount});
      }
    };

    const abortExcludedCountRefresh = () => {
      if (excludedCountController && !excludedCountController.signal?.aborted) {
        try {
          excludedCountController.abort();
        } catch {
          // ignore
        }
      }
      excludedCountController = null;
    };

    const loadExcludeScopeDocs = async ({controller = null} = {}) => {
      if (itemType === SHARE_TYPES.NOTEBOOK) {
        const tree = await this.listDocsInNotebook(itemId, {
          controller,
          fillIcons: false,
        });
        return Array.isArray(tree?.docs) ? tree.docs : [];
      }
      const byPath = await this.listDocSubtreeByPath(itemId, {
        controller,
        fillIcons: false,
      });
      return Array.isArray(byPath) ? byPath : [];
    };

    const refreshExcludedDocCount = (root) => {
      const container = root || dialog?.element;
      if (!container) return;
      const hiddenIds = container.querySelector?.("#sps-share-excluded-doc-ids");
      const excludedDocIds = normalizeDocIdList(hiddenIds?.value || "");
      if (!excludedDocIds.length) {
        writeExcludedDocCount(container, 0);
        return;
      }
      const requestId = ++excludedCountRequestId;
      abortExcludedCountRefresh();
      excludedCountController = new AbortController();
      void (async () => {
        try {
          const scopeDocs = await loadExcludeScopeDocs({controller: excludedCountController});
          if (requestId !== excludedCountRequestId) return;
          const lockedDocIds = itemType === SHARE_TYPES.DOC ? [itemId] : [];
          const expandedSet = this.expandExcludedDocIds(scopeDocs, excludedDocIds, {lockedDocIds});
          writeExcludedDocCount(container, expandedSet.size);
        } catch (err) {
          if (requestId !== excludedCountRequestId) return;
          if (isAbortError(err) || err?.name === "AbortError") return;
          console.warn("refreshExcludedDocCount failed", err);
          writeExcludedDocCount(container, excludedDocIds.length);
        } finally {
          if (requestId === excludedCountRequestId) {
            excludedCountController = null;
          }
        }
      })();
    };

    const syncExcludeControlsState = (root) => {
      const hidden = root?.querySelector?.("#sps-share-excluded-doc-ids");
      const normalized = normalizeDocIdList(hidden?.value || "");
      const includeChildrenChecked =
        itemType === SHARE_TYPES.NOTEBOOK || !!root?.querySelector?.("#sps-share-include-children")?.checked;
      const pickBtn = root?.querySelector?.("[data-action='pick-excluded-docs']");
      if (pickBtn) {
        pickBtn.disabled = !includeChildrenChecked;
      }
      const clearBtn = root?.querySelector?.("[data-action='clear-excluded-docs']");
      if (clearBtn) {
        clearBtn.disabled = !includeChildrenChecked || normalized.length === 0;
      }
    };

    const writeExcludedDocIds = (root, nextIds = [], {excludedCount = null, recalcCount = false} = {}) => {
      const normalized = normalizeDocIdList(nextIds);
      draftExcludedDocIds = normalized;
      const hidden = root?.querySelector?.("#sps-share-excluded-doc-ids");
      if (hidden) hidden.value = normalized.join(",");
      writeExcludedDocCount(root, excludedCount);
      syncExcludeControlsState(root);
      if (recalcCount) {
        refreshExcludedDocCount(root);
      }
    };

    const readShareOptions = (root, currentShare) => {
      const passwordInput = root?.querySelector?.("#sps-share-password");
      const expiresInput = root?.querySelector?.("#sps-share-expires");
      const visitorInput = root?.querySelector?.("#sps-share-visitor-limit");
      const slugInput = root?.querySelector?.("#sps-share-slug");
      const includeChildrenInput = root?.querySelector?.("#sps-share-include-children");
      const excludedInput = root?.querySelector?.("#sps-share-excluded-doc-ids");
      const passwordRaw = (passwordInput?.value || "").trim();
      const expiresAt = parseDateTimeLocalInput(expiresInput?.value || "");
      const visitorRaw = (visitorInput?.value || "").trim();
      const visitorParsed = Number(visitorRaw);
      const visitorLimit = Number.isFinite(visitorParsed)
        ? Math.max(0, Math.floor(visitorParsed))
        : null;
      const excludedDocIds = normalizeDocIdList(excludedInput?.value || "");
      const hasExistingPassword = !!currentShare?.hasPassword;
      const hasExistingExpires = normalizeTimestampMs(currentShare?.expiresAt || 0) > 0;
      const hasExistingVisitorLimit = Number(currentShare?.visitorLimit || 0) > 0;
      const currentSlug = normalizeShareSlugInput(currentShare?.slug || "");
      const requestedSlug = normalizeShareSlugInput(slugInput?.value || "");
      const password = passwordRaw === passwordKeepToken ? "" : passwordRaw;
      const includeChildren = !!includeChildrenInput?.checked;
      return {
        slugOverride: requestedSlug && requestedSlug !== currentSlug ? requestedSlug : "",
        password,
        clearPassword: !!currentShare && hasExistingPassword && passwordRaw === "",
        expiresAt,
        clearExpires: !!currentShare && hasExistingExpires && !expiresAt,
        visitorLimit,
        clearVisitorLimit: !!currentShare && hasExistingVisitorLimit && visitorRaw === "",
        includeChildren,
        excludedDocIds,
      };
    };

    const onClick = (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (!action) return;

      void (async () => {
        try {
          if (action === "close") {
            dialog.destroy();
            return;
          }
          if (action === "open-settings") {
            this.openSetting();
            setTimeout(() => this.applySettingWideLayout(), 80);
            return;
          }
          if (action === "copy") {
            const shareId = btn.getAttribute("data-share-id");
            await this.copyShareLink(shareId);
            return;
          }
          if (action === "show-qr") {
            const qrUrl = btn.getAttribute("data-url");
            if (qrUrl) this.showQRCodeDialog(qrUrl);
            return;
          }
          if (action === "copy-info") {
            const shareId = btn.getAttribute("data-share-id");
            await this.copyShareInfo(shareId, {title: itemTitle});
            return;
          }
          if (action === "pick-excluded-docs") {
            const currentOptions = readShareOptions(dialog.element, getShare());
            const selectedDocIds = normalizeDocIdList(currentOptions.excludedDocIds || []);
            const includeChildrenChecked =
              itemType === SHARE_TYPES.NOTEBOOK ||
              !!dialog?.element?.querySelector?.("#sps-share-include-children")?.checked;
            if (!includeChildrenChecked) {
              return;
            }
            const selected = await this.openExcludedDocsDialog({
              itemType,
              itemTitle,
              selectedDocIds,
              lockedDocIds: itemType === SHARE_TYPES.DOC ? [itemId] : [],
              loader: async ({onDoc, controller}) => {
                if (itemType === SHARE_TYPES.NOTEBOOK) {
                  const tree = await this.listDocsInNotebook(itemId, {
                    onDoc,
                    controller,
                    fillIcons: false,
                  });
                  return {docs: Array.isArray(tree?.docs) ? tree.docs : []};
                }
              const byPath = await this.listDocSubtreeByPath(itemId, {
                onDoc,
                controller,
                fillIcons: false,
              });
              if (Array.isArray(byPath) && byPath.length > 0) {
                return {docs: byPath};
              }
              const fallback = await this.listDocSubtree(itemId);
              return {docs: Array.isArray(fallback) ? fallback : []};
            },
          });
            if (!selected) return;
            const nextIds = Array.isArray(selected)
              ? selected
              : normalizeDocIdList(selected?.selectedDocIds || []);
            if (!Array.isArray(nextIds)) return;
            const rawSelectedCount = Array.isArray(selected) ? null : selected?.excludedCount;
            const hasSelectedCount =
              Number.isFinite(Number(rawSelectedCount)) && Number(rawSelectedCount) >= 0;
            const nextCount = hasSelectedCount ? normalizeExcludedDocCount(rawSelectedCount, 0) : null;
            writeExcludedDocIds(dialog.element, nextIds, {
              excludedCount: nextCount,
              recalcCount: nextCount === null,
            });
            return;
          }
          if (action === "clear-excluded-docs") {
            writeExcludedDocIds(dialog.element, [], {excludedCount: 0});
            return;
          }
          if (action === "update") {
            const shareId = btn.getAttribute("data-share-id");
            const options = readShareOptions(dialog.element, getShare());
            await this.updateShare(shareId, options);
            refreshDialog();
            return;
          }
          if (action === "update-access") {
            const shareId = btn.getAttribute("data-share-id");
            const options = readShareOptions(dialog.element, getShare());
            await this.updateShareAccess(shareId, options);
            refreshDialog();
            return;
          }
          if (action === "delete") {
            const shareId = btn.getAttribute("data-share-id");
            await this.deleteShare(shareId);
            refreshDialog();
            return;
          }
          if (action === "share") {
            const options = readShareOptions(dialog.element, getShare());
            if (itemType === SHARE_TYPES.NOTEBOOK) {
              await this.shareNotebook(itemId, options);
            } else {
              await this.shareDoc(itemId, options);
            }
            refreshDialog();
          }
        } catch (err) {
          this.showErr(err);
        }
      })();
    };
    const onChange = (event) => {
      const target = event.target;
      if (!target) return;
      if (target.id === "sps-share-include-children") {
        syncExcludeControlsState(dialog?.element);
      }
    };

    let dialog = null;
    const attachCopyFocus = () => {
      const input = dialog?.element?.querySelector?.("input.b3-text-field[readonly]");
      if (input) {
        input.addEventListener("focus", () => input.select());
      }
    };
    const refreshDialog = () => {
      const contentEl = dialog?.element?.querySelector?.(".sps-share-dialog-content");
      if (!contentEl) return;
      draftExcludedDocIds = null;
      draftExcludedDocCount = null;
      contentEl.innerHTML = renderContent();
      attachCopyFocus();
      syncExcludeControlsState(dialog?.element);
      refreshExcludedDocCount(dialog?.element);
    };

    dialog = new Dialog({
      title: t("siyuanShare.title.shareManagement"),
      content,
      width: "min(720px, 92vw)",
      destroyCallback: () => {
        excludedCountRequestId += 1;
        abortExcludedCountRefresh();
        dialog.element.removeEventListener("click", onClick);
        dialog.element.removeEventListener("change", onChange);
      },
    });

    dialog.element.addEventListener("click", onClick);
    dialog.element.addEventListener("change", onChange);
    attachCopyFocus();
    syncExcludeControlsState(dialog?.element);
    refreshExcludedDocCount(dialog?.element);
  }

  startSettingLayoutObserver() {
    if (this.settingLayoutObserver || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      this.applySettingWideLayout();
      this.handleSettingVisibilityChange();
    });
    observer.observe(document.body, {childList: true, subtree: true});
    this.settingLayoutObserver = observer;
    this.applySettingWideLayout();
    this.handleSettingVisibilityChange();
  }

  handleSettingVisibilityChange() {
    const {siteInput, apiKeyInput} = this.settingEls || {};
    const isVisible = !!(siteInput?.isConnected || apiKeyInput?.isConnected);
    if (isVisible) {
      this.settingVisible = true;
      return;
    }
    if (this.settingVisible) {
      this.settingVisible = false;
      void this.saveSettingsFromSetting({notify: false});
    }
  }

  makeSettingRowFullWidth(actionEl) {
    if (!actionEl) return false;
    const row = actionEl.closest?.("label.b3-label, .b3-label");
    if (!row) return false;
    if (row.classList.contains("sps-setting-full-row")) return true;
    row.classList.add("sps-setting-full-row");
    try {
      row.style.flexDirection = "column";
      row.style.alignItems = "stretch";
      row.style.justifyContent = "flex-start";
      row.style.gap = "8px";
    } catch {
      // ignore
    }
    try {
      actionEl.style.width = "100%";
      actionEl.style.alignSelf = "stretch";
      actionEl.style.flex = "1";
      actionEl.style.minWidth = "0";
    } catch {
      // ignore
    }
    return true;
  }

  applySettingWideLayout() {
    const {currentWrap, sharesWrap, siteInput, apiKeyInput} = this.settingEls || {};
    this.makeSettingRowFullWidth(currentWrap);
    this.makeSettingRowFullWidth(sharesWrap);
    const anyEl = siteInput || apiKeyInput || currentWrap || sharesWrap;
    if (anyEl?.isConnected) {
      const dialogBody = anyEl.closest(".b3-dialog__body");
      if (dialogBody && !dialogBody.classList.contains("sps-settings-body")) {
        dialogBody.classList.add("sps-settings-body");
      }
    }
  }

  alignSettingSiteSelectWidth() {
    const {siteSelect, siteNameInput, siteInput, apiKeyInput} = this.settingEls || {};
    if (!siteSelect) return;
    const ref =
      (siteNameInput && siteNameInput.isConnected && siteNameInput) ||
      (siteInput && siteInput.isConnected && siteInput) ||
      (apiKeyInput && apiKeyInput.isConnected && apiKeyInput) ||
      null;
    if (!ref) return;
    const rect = ref.getBoundingClientRect();
    const width = Math.round(rect?.width || 0);
    if (!Number.isFinite(width) || width <= 0) return;
    siteSelect.style.width = `${width}px`;
    siteSelect.style.maxWidth = `${width}px`;
  }

  onDockClick = (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        if (action === "sync-remote") {
          await this.saveSettingsFromUI();
          await this.trySyncRemoteShares({silent: false});
          return;
        }
        if (action === "disconnect") {
          await this.disconnectRemote();
          return;
        }
        if (action === "auto-update-status") {
          this.openAutoUpdateStatusDialog();
          return;
        }
        if (action === "copy-link") {
          const shareId = target.getAttribute("data-share-id");
          await this.copyShareLink(shareId);
          return;
        }
        if (action === "show-qr") {
          const qrUrl = target.getAttribute("data-url");
          if (qrUrl) this.showQRCodeDialog(qrUrl);
          return;
        }
        if (action === "update") {
          const shareId = target.getAttribute("data-share-id");
          await this.updateShare(shareId);
          return;
        }
        if (action === "update-access") {
          const shareId = target.getAttribute("data-share-id");
          const share = this.getShareById(shareId);
          if (!share) throw new Error(this.t("siyuanShare.error.shareNotFound"));
          const itemId = share.type === SHARE_TYPES.NOTEBOOK ? share.notebookId : share.docId;
          await this.openShareDialogFor({type: share.type, id: itemId, title: share.title || ""});
          return;
        }
        if (action === "delete") {
          const shareId = target.getAttribute("data-share-id");
          await this.deleteShare(shareId);
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onEditorTitleMenu = ({detail}) => {
    try {
      const t = this.t.bind(this);
      const {menu, data} = detail || {};
      const docId = data?.rootID || data?.id;
      if (!isValidDocId(docId)) return;
      const share = this.getShareByDocId(docId);
      menu.addItem({
        icon: "iconSiyuanShare",
        label: t("siyuanShare.title.shareManagement"),
        click: () => void this.openShareDialogFor({type: SHARE_TYPES.DOC, id: docId}),
      });
      if (share) {
        menu.addItem({
          icon: "iconRefresh",
          label: t("siyuanShare.action.updateShare"),
          click: () => void this.updateShare(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconCopy",
          label: t("siyuanShare.action.copyShareLink"),
          click: () => void this.copyShareLink(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconTrashcan",
          label: t("siyuanShare.action.deleteShare"),
          click: () => void this.deleteShare(share?.id).catch(this.showErr),
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  onDocTreeMenu = ({detail}) => {
    try {
      const t = this.t.bind(this);
      const {menu, elements, type} = detail || {};
      const rawElements = elements ?? detail?.element;
      let elementList = [];
      if (rawElements) {
        if (Array.isArray(rawElements)) {
          elementList = rawElements;
        } else if (typeof rawElements.length === "number") {
          elementList = Array.from(rawElements);
        } else {
          elementList = [rawElements];
        }
      }
      if (!menu || elementList.length === 0) return;

      const targetEl = elementList[0];
      const pickElementWithId = (el) => {
        if (!el) return null;
        if (findAttrId(el)) return el;
        const closestItem = el.closest?.(".b3-list-item");
        if (closestItem && findAttrId(closestItem)) return closestItem;
        const closestWithId = el.closest?.(
          "[data-node-id],[data-id],[data-doc-id],[data-root-id],[data-box],[data-url],[data-notebook-id],[data-notebook],[data-box-id],[data-boxid]",
        );
        if (closestWithId && findAttrId(closestWithId)) return closestWithId;
        const childWithId = el.querySelector?.(
          "[data-node-id],[data-id],[data-doc-id],[data-root-id],[data-box],[data-url],[data-notebook-id],[data-notebook],[data-box-id],[data-boxid]",
        );
        if (childWithId && findAttrId(childWithId)) return childWithId;
        return el;
      };

      let holder = null;
      let id = "";
      for (const el of elementList) {
        const candidate = pickElementWithId(el);
        const candidateId = findAttrId(candidate);
        if (candidateId) {
          holder = candidate;
          id = candidateId;
          break;
        }
      }
      if (!id) {
        const candidate = pickElementWithId(targetEl);
        id = findAttrId(candidate);
        holder = candidate || targetEl;
      }
      if (!id) id = resolveDetailId(detail);

      const dataType =
        holder?.getAttribute("data-type") ||
        holder?.dataset?.type ||
        targetEl?.getAttribute("data-type") ||
        targetEl?.dataset?.type;
      const detailType = detail?.data?.type || type;
      const docAttrCandidates = [
        holder?.getAttribute?.("data-node-id"),
        holder?.getAttribute?.("data-id"),
        holder?.getAttribute?.("data-doc-id"),
        holder?.getAttribute?.("data-root-id"),
      ];
      const docAttrValue = docAttrCandidates.find((val) => isValidDocId(val));
      let isNotebook =
        detailType === "notebook" ||
        detailType === "navigation-root" ||
        dataType === "notebook" ||
        dataType === "navigation-root";
      const notebookAttrCandidates = [
        holder?.getAttribute?.("data-url"),
        holder?.getAttribute?.("data-box"),
        holder?.getAttribute?.("data-box-id"),
        holder?.getAttribute?.("data-boxid"),
        holder?.getAttribute?.("data-notebook-id"),
        holder?.getAttribute?.("data-notebook"),
      ];
      if (!isNotebook) {
        const urlAttr = notebookAttrCandidates.find((val) => isValidDocId(val));
        if (docAttrValue) {
          isNotebook = false;
        } else if (isValidDocId(urlAttr)) {
          isNotebook = true;
        }
      }
      if (!id && isNotebook) {
        const notebookEl =
          holder?.closest?.("ul[data-url]") ||
          targetEl?.closest?.("ul[data-url]") ||
          targetEl?.querySelector?.("ul[data-url]");
        const notebookId = notebookEl?.getAttribute?.("data-url") || "";
        if (isValidDocId(notebookId)) id = notebookId.trim();
        if (!id) {
          const idFromAttr = notebookAttrCandidates.find((val) => isValidDocId(val));
          if (isValidDocId(idFromAttr)) id = idFromAttr.trim();
        }
      }

      const treeItem =
        holder?.closest?.(".b3-list-item") ||
        targetEl?.closest?.(".b3-list-item") ||
        holder ||
        targetEl;
      const treeInfo = resolveTreeItemInfo(treeItem);
      if (treeInfo?.id) {
        id = treeInfo.id;
        isNotebook = treeInfo.isNotebook;
      }
      if (!id) return;

      const itemType = isNotebook ? SHARE_TYPES.NOTEBOOK : SHARE_TYPES.DOC;
      const title = findTitleFromTree(treeItem || holder || targetEl) || id;
      const share =
        itemType === SHARE_TYPES.NOTEBOOK ? this.getShareByNotebookId(id) : this.getShareByDocId(id);

      menu.addItem({
        icon: "iconSiyuanShare",
        label: share ? t("siyuanShare.action.manageShare") : t("siyuanShare.action.createShare"),
        click: () => void this.openShareDialogFor({type: itemType, id, title}),
      });
      if (share) {
        menu.addItem({
          icon: "iconRefresh",
          label: t("siyuanShare.action.updateShare"),
          click: () => void this.updateShare(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconCopy",
          label: t("siyuanShare.action.copyShareLink"),
          click: () => void this.copyShareLink(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconTrashcan",
          label: t("siyuanShare.action.deleteShare"),
          click: () => void this.deleteShare(share?.id).catch(this.showErr),
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  showErr = (err) => {
    console.error(err);
    const t = this.t.bind(this);
    let message = err?.message || String(err);
    const lower = message.toLowerCase();
    if (
      lower.includes("api key") ||
      lower.includes("invalid api key") ||
      lower.includes("unauthorized") ||
      lower.includes("401")
    ) {
      message = t("siyuanShare.error.invalidApiKey");
    } else if (lower.includes("storage") || lower.includes("quota") || lower.includes("space")) {
      message = t("siyuanShare.error.storageLimit");
    } else if (
      lower.includes("failed to fetch") ||
      lower.includes("network") ||
      lower.includes("connect") ||
      lower.includes("fetch")
    ) {
      message = t("siyuanShare.error.networkFail");
    } else if (lower.includes("invalid metadata")) {
      message = t("siyuanShare.error.invalidMetadata");
    } else if (lower.includes("missing docid")) {
      message = t("siyuanShare.error.missingDocId");
    }
    this.notify(message);
  };

  hasReferenceInMarkdown(markdown) {
    if (!markdown) return false;
    return BLOCK_REF_RE.test(markdown) || BLOCK_REF_LINK_RE.test(markdown);
  }

  async querySqlRows(stmt) {
    if (!stmt) return null;
    try {
      const resp = await fetchSyncPost("/api/query/sql", {stmt});
      if (resp && resp.code === 0 && Array.isArray(resp.data)) {
        return resp.data;
      }
    } catch {
      // ignore
    }
    return null;
  }

  async resolveRefQuerySchema() {
    if (this.refQuerySchema) return this.refQuerySchema;
    const candidates = ["refs", "ref"];
    for (const table of candidates) {
      const rows = await this.querySqlRows(`PRAGMA table_info(${table})`);
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const names = rows.map((row) => String(row?.name || "").trim());
      const rootCol = ["root_id", "rootId", "doc_id", "docId"].find((name) => names.includes(name));
      const targetCol = ["def_block_root_id", "defBlockRootId", "def_root_id", "defRootId"].find((name) =>
        names.includes(name),
      );
      if (!rootCol || !targetCol) continue;
      this.refQuerySchema = {table, rootCol, targetCol};
      return this.refQuerySchema;
    }
    return null;
  }

  async resolveBlocksRootColumn() {
    if (this.blocksRootCol !== null) return this.blocksRootCol;
    const rows = await this.querySqlRows("PRAGMA table_info(blocks)");
    if (!Array.isArray(rows) || rows.length === 0) {
      this.blocksRootCol = "";
      return this.blocksRootCol;
    }
    const names = rows.map((row) => String(row?.name || "").trim());
    const rootCol = ["root_id", "rootId"].find((name) => names.includes(name)) || "";
    this.blocksRootCol = rootCol;
    return this.blocksRootCol;
  }

  resolveIncrementalSinceStamp(existingShare) {
    const shareId = String(existingShare?.id || "").trim();
    const cursor = shareId ? this.getIncrementalCursor(shareId) : "";
    if (cursor) return cursor;
    return formatDocUpdatedStampFromMs(existingShare?.updatedAt || 0);
  }

  async queryDocsUpdatedSince(docIds, sinceStamp) {
    const normalizedSince = normalizeDocUpdatedStamp(sinceStamp);
    const scope = Array.from(
      new Set((Array.isArray(docIds) ? docIds : []).map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!scope.length || !normalizedSince) return [];
    const rootCol = await this.resolveBlocksRootColumn();
    const updated = new Set();
    let failed = false;
    for (const part of chunkArray(scope, 200)) {
      const quoted = part.map((id) => `'${escapeSqlString(id)}'`).join(",");
      let rows = null;
      if (rootCol) {
        rows = await this.querySqlRows(
          `SELECT DISTINCT ${rootCol} AS id FROM blocks WHERE ${rootCol} IN (${quoted}) AND updated >= '${escapeSqlString(
            normalizedSince,
          )}'`,
        );
      }
      if (!Array.isArray(rows)) {
        rows = await this.querySqlRows(
          `SELECT id FROM blocks WHERE type='d' AND id IN (${quoted}) AND updated >= '${escapeSqlString(
            normalizedSince,
          )}'`,
        );
      }
      if (!Array.isArray(rows)) {
        failed = true;
        continue;
      }
      rows.forEach((row) => {
        const id = String(row?.id || "").trim();
        if (isValidDocId(id)) updated.add(id);
      });
    }
    if (failed) return null;
    return Array.from(updated);
  }

  async queryDocUpdatedMap(docIds, {controller = null} = {}) {
    const t = this.t.bind(this);
    const scope = Array.from(
      new Set((Array.isArray(docIds) ? docIds : []).map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!scope.length) return new Map();
    const map = new Map();
    let failed = false;
    for (const part of chunkArray(scope, 200)) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const quoted = part.map((id) => `'${escapeSqlString(id)}'`).join(",");
      const rows = await this.querySqlRows(`SELECT id, updated FROM blocks WHERE type='d' AND id IN (${quoted})`);
      if (!Array.isArray(rows)) {
        failed = true;
        continue;
      }
      rows.forEach((row) => {
        const docId = String(row?.id || "").trim();
        if (!isValidDocId(docId)) return;
        map.set(docId, normalizeDocUpdatedStamp(row?.updated));
      });
    }
    if (failed) return null;
    scope.forEach((docId) => {
      if (!map.has(docId)) {
        map.set(docId, "");
      }
    });
    return map;
  }

  async queryDocBlockCountMap(docIds, {controller = null} = {}) {
    const t = this.t.bind(this);
    const scope = Array.from(
      new Set((Array.isArray(docIds) ? docIds : []).map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!scope.length) return new Map();
    const rootCol = await this.resolveBlocksRootColumn();
    if (!rootCol) return null;
    const map = new Map();
    let failed = false;
    for (const part of chunkArray(scope, 200)) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const quoted = part.map((id) => `'${escapeSqlString(id)}'`).join(",");
      const rows = await this.querySqlRows(
        `SELECT ${rootCol} AS docId, COUNT(*) AS count FROM blocks WHERE ${rootCol} IN (${quoted}) GROUP BY ${rootCol}`,
      );
      if (!Array.isArray(rows)) {
        failed = true;
        continue;
      }
      rows.forEach((row) => {
        const docId = String(row?.docId || "").trim();
        if (!isValidDocId(docId)) return;
        const count = Math.max(0, Math.floor(Number(row?.count) || 0));
        map.set(docId, count);
      });
    }
    if (failed) return null;
    scope.forEach((docId) => {
      if (!map.has(docId)) {
        map.set(docId, 0);
      }
    });
    return map;
  }

  async queryRefImpactedDocsSince(scopeDocIds, sinceStamp) {
    const normalizedSince = normalizeDocUpdatedStamp(sinceStamp);
    const scope = Array.from(
      new Set(
        (Array.isArray(scopeDocIds) ? scopeDocIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => isValidDocId(id)),
      ),
    );
    if (!scope.length || !normalizedSince) return [];
    const schema = await this.resolveRefQuerySchema();
    if (!schema) return null;
    const impacted = new Set();
    const quotedSince = escapeSqlString(normalizedSince);
    let failed = false;
    for (const part of chunkArray(scope, 120)) {
      const quoted = part.map((id) => `'${escapeSqlString(id)}'`).join(",");
      const stmt = `SELECT DISTINCT ${schema.rootCol} AS docId
        FROM ${schema.table}
        WHERE ${schema.rootCol} IN (${quoted})
          AND ${schema.targetCol} IN (
            SELECT id FROM blocks WHERE type='d' AND updated >= '${quotedSince}'
          )`;
      const rows = await this.querySqlRows(stmt);
      if (!Array.isArray(rows)) {
        failed = true;
        continue;
      }
      rows.forEach((row) => {
        const id = String(row?.docId || "").trim();
        if (isValidDocId(id)) impacted.add(id);
      });
    }
    if (failed) return null;
    return Array.from(impacted);
  }

  async collectIncrementalCandidateDocIds(scopeDocs, existingShare, {controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    const scope = Array.isArray(scopeDocs) ? scopeDocs : [];
    const scopeIds = Array.from(
      new Set(scope.map((doc) => String(doc?.docId || "").trim()).filter((id) => isValidDocId(id))),
    );
    const scopeSet = new Set(scopeIds);
    if (!scopeIds.length) {
      return {
        sinceStamp: "",
        directDocIds: [],
        impactedDocIds: [],
        candidateDocIds: [],
      };
    }
    const sinceStamp = this.resolveIncrementalSinceStamp(existingShare);
    if (!sinceStamp) {
      return {
        sinceStamp: "",
        directDocIds: scopeIds,
        impactedDocIds: [],
        candidateDocIds: scopeIds,
      };
    }
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const directDocIds = await this.queryDocsUpdatedSince(scopeIds, sinceStamp);
    if (!Array.isArray(directDocIds)) {
      throw new Error("Incremental precheck failed while querying changed docs");
    }
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const impactedDocIds = await this.queryRefImpactedDocsSince(scopeIds, sinceStamp);
    if (!Array.isArray(impactedDocIds)) {
      throw new Error("Incremental precheck failed while querying references");
    }
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const candidate = new Set();
    directDocIds.forEach((id) => {
      if (scopeSet.has(id)) candidate.add(id);
    });
    impactedDocIds.forEach((id) => {
      if (scopeSet.has(id)) candidate.add(id);
    });
    let candidateDocIds = Array.from(candidate);
    if (candidateDocIds.length === 0) {
      const countChanged = await this.collectDocCountChangedDocIds(scopeIds, existingShare, {
        controller,
        progress,
      });
      if (countChanged.length) {
        candidateDocIds = countChanged;
      }
    }
    progress?.update?.({
      text: t("siyuanShare.progress.analyzingIncrement"),
      detail: t("siyuanShare.progress.analyzingDocs", {
        index: candidateDocIds.length,
        total: scopeIds.length,
      }),
    });
    return {
      sinceStamp,
      directDocIds,
      impactedDocIds,
      candidateDocIds,
    };
  }

  async collectDocCountChangedDocIds(scopeDocIds, existingShare, {controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    const shareId = String(existingShare?.id || "").trim();
    if (!shareId) return [];
    const cached = this.getDocBlockCountCache(shareId);
    if (!cached || typeof cached !== "object" || Object.keys(cached).length === 0) return [];
    const map = await this.queryDocBlockCountMap(scopeDocIds, {controller});
    if (!map) return [];
    const changed = [];
    map.forEach((count, docId) => {
      const prev = Number(cached?.[docId]);
      if (!Number.isFinite(prev) || prev !== count) {
        changed.push(docId);
      }
    });
    if (changed.length) {
      progress?.update?.({
        text: t("siyuanShare.progress.analyzingIncrement"),
        detail: t("siyuanShare.progress.analyzingDocs", {
          index: changed.length,
          total: Math.max(1, scopeDocIds.length),
        }),
      });
    }
    return changed;
  }

  async refreshDocBlockCountCacheForShare(shareId, scopeDocs, {controller = null} = {}) {
    const shareKey = String(shareId || "").trim();
    if (!shareKey) return;
    const scopeIds = Array.from(
      new Set((Array.isArray(scopeDocs) ? scopeDocs : []).map((doc) => String(doc?.docId || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!scopeIds.length) return;
    const map = await this.queryDocBlockCountMap(scopeIds, {controller});
    if (!map) return;
    const docMap = {};
    map.forEach((count, docId) => {
      docMap[docId] = Math.max(0, Math.floor(Number(count) || 0));
    });
    await this.setDocBlockCountCache(shareKey, docMap);
  }

  collectStructChangedDocIds(scopeDocs, remoteSnapshot) {
    const localList = Array.isArray(scopeDocs) ? scopeDocs : [];
    const remoteList = Array.isArray(remoteSnapshot?.docs) ? remoteSnapshot.docs : [];
    if (!localList.length || !remoteList.length) return [];
    const remoteMap = new Map();
    remoteList.forEach((row) => {
      const docId = String(row?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      remoteMap.set(docId, row || {});
    });
    const changed = new Set();
    localList.forEach((doc, index) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const remote = remoteMap.get(docId);
      if (!remote) {
        changed.add(docId);
        return;
      }
      const localSortOrder = Math.max(0, Math.floor(Number(doc?.sortOrder) || index));
      const remoteSortOrder = Math.max(0, Math.floor(Number(remote?.sortOrder) || 0));
      let different = localSortOrder !== remoteSortOrder;
      if (
        !different &&
        Object.prototype.hasOwnProperty.call(remote, "title") &&
        String(doc?.title || "") !== String(remote?.title || "")
      ) {
        different = true;
      }
      if (
        !different &&
        Object.prototype.hasOwnProperty.call(remote, "icon") &&
        normalizeDocIconValue(doc?.icon || "") !== normalizeDocIconValue(remote?.icon || "")
      ) {
        different = true;
      }
      const hasParentField =
        Object.prototype.hasOwnProperty.call(remote, "parentId") ||
        Object.prototype.hasOwnProperty.call(remote, "parent_id");
      if (
        !different &&
        hasParentField &&
        String(doc?.parentId || "") !== String(remote?.parentId || remote?.parent_id || "")
      ) {
        different = true;
      }
      const hasSortIndexField =
        Object.prototype.hasOwnProperty.call(remote, "sortIndex") ||
        Object.prototype.hasOwnProperty.call(remote, "sort_index");
      if (hasSortIndexField && !different) {
        const localSortIndex = normalizeSortIndexForHash(doc?.sortIndex ?? 0);
        const remoteSortIndex = normalizeSortIndexForHash(remote?.sortIndex ?? remote?.sort_index ?? 0);
        if (localSortIndex !== remoteSortIndex) {
          different = true;
        }
      }
      if (different) {
        changed.add(docId);
      }
    });
    return Array.from(changed);
  }

  async hasDocReferencesBySQL(docIds) {
    if (!Array.isArray(docIds) || docIds.length === 0) return false;
    const unique = Array.from(
      new Set(docIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!unique.length) return false;
    const quoted = unique.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const statements = [
      `SELECT 1 AS hit FROM refs WHERE root_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE rootId IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE doc_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE docId IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE def_block_root_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE block_id IN (SELECT id FROM blocks WHERE root_id IN (${quoted})) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE blockId IN (SELECT id FROM blocks WHERE root_id IN (${quoted})) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE root_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE rootId IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE doc_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE docId IN (${quoted}) LIMIT 1`,
    ];
    for (const stmt of statements) {
      let resp = null;
      try {
        resp = await fetchSyncPost("/api/query/sql", {stmt});
      } catch (err) {
        resp = null;
      }
      if (!resp || resp.code !== 0 || !Array.isArray(resp.data)) {
        continue;
      }
      return resp.data.length > 0;
    }
    return false;
  }

  resolveExportReferenceMode() {
    const exportCfg = globalThis?.siyuan?.config?.export;
    if (!exportCfg || typeof exportCfg !== "object") {
      return {found: false, correct: false};
    }

    const visited = new WeakSet();
    const evalValue = (value, depth = 0) => {
      if (depth > 3 || value == null) return {found: false, correct: false};
      if (typeof value === "number") {
        return {found: true, correct: value === 4};
      }
      if (typeof value === "string") {
        const raw = value.trim();
        if (!raw) return {found: false, correct: false};
        if (/^\d+$/.test(raw)) {
          const num = Number(raw);
          return {found: true, correct: num === 4};
        }
        const lower = raw.toLowerCase();
        const hasFootnote = lower.includes("footnote") || raw.includes("脚注");
        const hasAnchor =
          lower.includes("anchor") ||
          lower.includes("hash") ||
          raw.includes("锚点") ||
          raw.includes("哈希");
        if (hasFootnote && hasAnchor) return {found: true, correct: true};
        return {found: true, correct: false};
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          const res = evalValue(entry, depth + 1);
          if (res.found) return res;
        }
        return {found: false, correct: false};
      }
      if (typeof value === "object") {
        if (visited.has(value)) return {found: false, correct: false};
        visited.add(value);
        const fields = [
          value.mode,
          value.type,
          value.value,
          value.format,
          value.label,
          value.name,
          value.text,
          value.ref,
          value.blockRef,
        ];
        for (const entry of fields) {
          const res = evalValue(entry, depth + 1);
          if (res.found) return res;
        }
        return {found: false, correct: false};
      }
      return {found: false, correct: false};
    };

    const pickInOrder = [
      "blockRef",
      "blockRefMode",
      "blockRefType",
      "blockRefFormat",
      "blockRefRule",
      "ref",
      "refMode",
      "refType",
      "reference",
      "referenceMode",
      "referenceType",
    ];

    for (const key of pickInOrder) {
      if (!Object.prototype.hasOwnProperty.call(exportCfg, key)) continue;
      const res = evalValue(exportCfg[key]);
      if (res.found) return res;
      return {found: true, correct: false};
    }

    return {found: false, correct: false};
  }

  openExportReferenceWarningDialog() {
    const t = this.t.bind(this);
    return new Promise((resolve) => {
      let done = false;
      let dialog = null;
      const onClick = (event) => {
        const btn = event.target?.closest?.("[data-action]");
        if (!btn) return;
        if (btn.getAttribute("data-action") !== "confirm") return;
        const checkbox = dialog?.element?.querySelector?.("[data-ref-warning-disable]");
        if (checkbox?.checked) {
          this.settings.refWarningDisabled = true;
          void this.saveData(STORAGE_SETTINGS, this.settings);
        }
        dialog?.destroy();
      };
      const finish = () => {
        if (done) return;
        done = true;
        dialog?.element?.removeEventListener?.("click", onClick);
        resolve();
      };
      const content = `<div class="b3-dialog__content sps-warning-dialog">
  <div class="sps-warning">
    <div class="sps-warning__icon">!</div>
    <div class="sps-warning__body">
      <div class="sps-warning__desc">${escapeHtml(t("siyuanShare.warning.refSettingMessage"))}</div>
    </div>
  </div>
  <label class="b3-checkbox sps-warning__checkbox">
    <input class="b3-checkbox__input" type="checkbox" data-ref-warning-disable>
    <span class="b3-checkbox__label">${escapeHtml(t("siyuanShare.warning.refSettingDontRemind"))}</span>
  </label>
</div>
<div class="b3-dialog__action">
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-action="confirm">${escapeHtml(
    t("siyuanShare.warning.refSettingOk"),
  )}</button>
</div>`;
      dialog = new Dialog({
        title: t("siyuanShare.warning.refSettingTitle"),
        content,
        width: "460px",
        destroyCallback: finish,
      });
      dialog.element?.addEventListener?.("click", onClick);
    });
  }

  async maybeWarnExportReference(markdownList, docIds = []) {
    if (this.settings.refWarningDisabled) return;
    const setting = this.resolveExportReferenceMode();
    if (setting.found && setting.correct) return;
    const hasDocRefs = await this.hasDocReferencesBySQL(docIds);
    if (!hasDocRefs) return;
    await this.openExportReferenceWarningDialog();
  }

  openProgressDialog(message, controller) {
    const t = this.t.bind(this);
    try {
      if (this.progressDialog) {
        this.progressDialog.destroy();
      }
    } catch {
      // ignore
    }
    const rawMessage = message || t("siyuanShare.message.processing");
    const safeMessage = escapeHtml(rawMessage);
    let onDialogDestroy = () => {};
    const dialog = new Dialog({
      title: t("siyuanShare.title.processing"),
      content: `<div class="sps-progress">
  <div class="sps-progress__header">
    <div class="sps-progress__title">${safeMessage}</div>
    <div class="sps-progress__percent" style="display:none"></div>
  </div>
  <div class="sps-progress__detail" style="display:none"></div>
  <div class="sps-progress__bar"><div class="sps-progress__bar-inner"></div></div>
</div>
<div class="b3-dialog__action">
  <div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-action="continue" style="display:none"></button>
</div>`,
      width: "360px",
      destroyCallback: () => onDialogDestroy(),
    });
    this.progressDialog = dialog;
    dialog.element?.classList?.add("sps-progress-dialog");

    const label = dialog.element?.querySelector?.(".sps-progress__title");
    const percentEl = dialog.element?.querySelector?.(".sps-progress__percent");
    const detailEl = dialog.element?.querySelector?.(".sps-progress__detail");
    const barWrap = dialog.element?.querySelector?.(".sps-progress__bar");
    const bar = dialog.element?.querySelector?.(".sps-progress__bar-inner");
    const continueBtn = dialog.element?.querySelector?.("[data-action='continue']");
    let confirmResolver = null;
    let currentText = rawMessage;
    let barVisible = true;
    let closed = false;
    let continueCountdownTimer = null;
    let continueCountdownInterval = null;
    let continueCountdownRemain = 0;
    let continueBaseText = "";
    const setIndeterminate = () => {
      if (!bar) return;
      bar.style.animation = "";
      bar.style.width = "";
    };
    const setDeterminate = (value) => {
      if (!bar) return 0;
      const clamped = Math.max(0, Math.min(100, value));
      bar.style.animation = "none";
      bar.style.width = `${clamped}%`;
      return clamped;
    };
    const setBarVisible = (visible = true) => {
      barVisible = !!visible;
      if (barWrap) {
        barWrap.style.display = barVisible ? "" : "none";
      }
      if (!barVisible && percentEl) {
        percentEl.textContent = "";
        percentEl.style.display = "none";
      }
    };
    const update = (next, percent = null, detail = "") => {
      let text = next;
      let pct = percent;
      let extra = detail;
      if (next && typeof next === "object") {
        text = next.text;
        pct = next.percent;
        extra = next.detail;
      }
      if (typeof text === "string") {
        currentText = text;
      } else if (text == null) {
        text = currentText;
      } else {
        currentText = String(text);
        text = currentText;
      }
      const extraText = extra ? String(extra) : "";
      const hasPercent = pct !== null && pct !== undefined && pct !== "";
      const numeric = hasPercent ? Number(pct) : NaN;
      if (label) label.textContent = String(text || "");
      if (detailEl) {
        if (extraText) {
          detailEl.textContent = extraText;
          detailEl.style.display = "";
        } else {
          detailEl.textContent = "";
          detailEl.style.display = "none";
        }
      }
      if (!barVisible) {
        if (percentEl) {
          percentEl.textContent = "";
          percentEl.style.display = "none";
        }
      } else if (Number.isFinite(numeric)) {
        const clamped = setDeterminate(numeric);
        if (percentEl) {
          percentEl.textContent = `${Math.round(clamped)}%`;
          percentEl.style.display = "";
        }
      } else {
        setIndeterminate();
        if (percentEl) {
          percentEl.textContent = "";
          percentEl.style.display = "none";
        }
      }
    };
    const hideContinue = () => {
      if (continueCountdownTimer) {
        clearTimeout(continueCountdownTimer);
        continueCountdownTimer = null;
      }
      if (continueCountdownInterval) {
        clearInterval(continueCountdownInterval);
        continueCountdownInterval = null;
      }
      continueCountdownRemain = 0;
      continueBaseText = "";
      if (!continueBtn) return;
      continueBtn.style.display = "none";
      continueBtn.textContent = "";
    };
    const showContinue = (labelText, autoProceedSeconds = 0) => {
      if (continueCountdownTimer) {
        clearTimeout(continueCountdownTimer);
        continueCountdownTimer = null;
      }
      if (continueCountdownInterval) {
        clearInterval(continueCountdownInterval);
        continueCountdownInterval = null;
      }
      continueCountdownRemain = 0;
      continueBaseText = String(labelText || t("siyuanShare.action.continueUpload"));
      if (!continueBtn) return;
      continueBtn.style.display = "";
      const renderLabel = () => {
        if (!continueBtn) return;
        const suffix = continueCountdownRemain > 0 ? ` (${continueCountdownRemain}s)` : "";
        continueBtn.textContent = `${continueBaseText}${suffix}`;
      };
      const countdownSeconds = Math.max(0, Math.floor(Number(autoProceedSeconds) || 0));
      if (countdownSeconds <= 0) {
        renderLabel();
        return;
      }
      continueCountdownRemain = countdownSeconds;
      renderLabel();
      continueCountdownInterval = setInterval(() => {
        if (!confirmResolver) {
          if (continueCountdownInterval) {
            clearInterval(continueCountdownInterval);
            continueCountdownInterval = null;
          }
          if (continueCountdownTimer) {
            clearTimeout(continueCountdownTimer);
            continueCountdownTimer = null;
          }
          continueCountdownRemain = 0;
          return;
        }
        continueCountdownRemain -= 1;
        if (continueCountdownRemain <= 0) {
          if (continueCountdownInterval) {
            clearInterval(continueCountdownInterval);
            continueCountdownInterval = null;
          }
          continueCountdownRemain = 0;
          return;
        }
        renderLabel();
      }, 1000);
      continueCountdownTimer = setTimeout(() => {
        if (continueCountdownInterval) {
          clearInterval(continueCountdownInterval);
          continueCountdownInterval = null;
        }
        continueCountdownTimer = null;
        continueCountdownRemain = 0;
        if (!confirmResolver) return;
        settleConfirm(true);
      }, countdownSeconds * 1000);
    };
    const settleConfirm = (result) => {
      if (!confirmResolver) return;
      const resolver = confirmResolver;
      confirmResolver = null;
      hideContinue();
      resolver(!!result);
    };
    onDialogDestroy = () => {
      if (closed) return;
      closed = true;
      settleConfirm(false);
      if (controller && !controller.signal?.aborted) {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }
      if (this.progressDialog === dialog) {
        this.progressDialog = null;
      }
    };
    const confirm = ({text = null, detail = "", continueText = "", autoProceedSeconds = 0} = {}) =>
      new Promise((resolve) => {
        if (typeof text === "string" || (text && typeof text === "object")) {
          update({text, detail});
        } else if (detail) {
          update({detail});
        }
        confirmResolver = resolve;
        showContinue(continueText, autoProceedSeconds);
      });
    const close = () => {
      if (closed) return;
      closed = true;
      settleConfirm(false);
      try {
        dialog.destroy();
      } catch {
        // ignore
      }
      if (this.progressDialog === dialog) {
        this.progressDialog = null;
      }
    };

    dialog.element?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "continue") {
        settleConfirm(true);
      }
    });

    return {close, update, confirm, setBarVisible};
  }

  createProgressHandle(message, controller, {background = false} = {}) {
    if (!background) {
      return this.openProgressDialog(message, controller);
    }
    return {
      close: () => {},
      update: () => {},
      confirm: async () => true,
      setBarVisible: () => {},
    };
  }

  async loadState() {
    const settings = (await this.loadData(STORAGE_SETTINGS)) || {};
    const legacyShares = (await this.loadData(STORAGE_SHARES)) || [];
    const siteSharesRaw = (await this.loadData(STORAGE_SITE_SHARES)) || {};
    const shareOptionsRaw = (await this.loadData(STORAGE_SHARE_OPTIONS)) || {};
    const incrementalCursorRaw = (await this.loadData(STORAGE_INCREMENTAL_CURSOR)) || {};
    const docBlockCountRaw = (await this.loadData(STORAGE_DOC_BLOCK_COUNTS)) || {};
    const exportRetryCacheIndexRaw = (await this.loadData(STORAGE_EXPORT_RETRY_CACHE_INDEX)) || {};
    const autoUpdateRuntimeRaw = (await this.loadData(STORAGE_AUTO_UPDATE_RUNTIME)) || {};
    const autoUpdateScanStampBySite = this.normalizeAutoUpdateScanStampBySite(settings.autoUpdateScanStampBySite);
    const siteShares =
      siteSharesRaw && typeof siteSharesRaw === "object" && !Array.isArray(siteSharesRaw) ? siteSharesRaw : {};
    const shareOptions = this.normalizeShareOptionsMap(shareOptionsRaw);
    const incrementalCursorBySite = this.normalizeIncrementalCursorBySite(incrementalCursorRaw);
    const docBlockCountBySite = this.normalizeDocBlockCountBySite(docBlockCountRaw);
    const exportRetryCacheIndexBySite = this.normalizeExportRetryCacheIndexBySite(exportRetryCacheIndexRaw);
    let sites = this.normalizeSiteList(settings.sites);
    let activeSiteId = String(settings.activeSiteId || "");
    let persistSettings = false;
    if (!sites.length && (settings.siteUrl || settings.apiKey)) {
      const fallback = {
        id: randomSlug(10),
        name: this.resolveSiteName("", settings.siteUrl || "", 0),
        siteUrl: String(settings.siteUrl || "").trim(),
        apiKey: String(settings.apiKey || "").trim(),
        autoUpdateEnabled: false,
        quietWindowSeconds: 60,
      };
      sites.push(fallback);
      activeSiteId = fallback.id;
      persistSettings = true;
    }
    if (activeSiteId && !sites.find((site) => String(site.id) === activeSiteId)) {
      activeSiteId = "";
      persistSettings = true;
    }
    if (!activeSiteId && sites.length) {
      activeSiteId = String(sites[0].id || "");
      persistSettings = true;
    }
    const activeSite = sites.find((site) => String(site.id) === activeSiteId) || null;
    let persistShares = false;
    if (Array.isArray(legacyShares) && legacyShares.length && activeSiteId && !siteShares[activeSiteId]) {
      siteShares[activeSiteId] = legacyShares;
      persistShares = true;
    }
    this.siteShares = siteShares;
    this.shareOptions = shareOptions;
    this.incrementalCursorBySite = incrementalCursorBySite;
    this.docBlockCountBySite = docBlockCountBySite;
    this.exportRetryCacheIndexBySite = exportRetryCacheIndexBySite;
    this.autoUpdateRuntimeBySite = this.normalizeAutoUpdateRuntimeBySite(autoUpdateRuntimeRaw);
    this.autoUpdatePersistFingerprint = stableStringify(this.autoUpdateRuntimeBySite);
    this.autoUpdatePersistInitialized = true;
    this.settings = {
      siteUrl: activeSite?.siteUrl || "",
      apiKey: activeSite?.apiKey || "",
      uploadAssetConcurrency: normalizePositiveInt(
        settings.uploadAssetConcurrency,
        DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      ),
      uploadChunkConcurrency: normalizePositiveInt(
        settings.uploadChunkConcurrency,
        DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      ),
      sites,
      activeSiteId,
      refWarningDisabled: !!settings.refWarningDisabled,
      autoUpdateScanStampBySite,
    };
    const activeShares = activeSiteId ? this.siteShares[activeSiteId] : null;
    this.shares = Array.isArray(activeShares) ? activeShares.filter((s) => s && s.id && s.type) : [];
    this.restoreAutoUpdateRuntimeForSite(activeSiteId);
    this.hasNodeFs = !!(fs && path);
    this.workspaceDir = "";
    this.syncRemoteStatusFromSite(activeSite);
    this.syncSettingInputs();
    this.renderSettingShares();
    this.renderDock();
    this.updateTopBarState();
    void this.refreshCurrentDocContext();
    if (persistSettings) {
      await this.saveData(STORAGE_SETTINGS, this.settings);
    }
    if (persistShares) {
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
    this.startBackgroundSync({immediate: true});
    this.refreshAutoUpdateLoop({immediate: true});
  }

  initSettingPanel() {
    const t = this.t.bind(this);
    const siteSelect = document.createElement("select");
    siteSelect.className = "b3-select sps-setting-field sps-site-select sps-site-select--setting";
    siteSelect.addEventListener("change", this.onSiteSelectChange);

    const siteNameInput = document.createElement("input");
    siteNameInput.className = "b3-text-field fn__block sps-setting-field";
    siteNameInput.placeholder = t("siyuanShare.label.siteName");

    const siteActions = document.createElement("div");
    siteActions.className = "siyuan-plugin-share__actions";
    siteActions.innerHTML = `
  <button class="b3-button b3-button--outline" data-action="site-add">${t(
    "siyuanShare.action.addSite",
  )}</button>
  <button class="b3-button b3-button--outline" data-action="site-remove">${t(
    "siyuanShare.action.removeSite",
  )}</button>
`;
    siteActions.addEventListener("click", this.onSettingSitesClick);

    const siteInput = document.createElement("input");
    siteInput.className = "b3-text-field fn__block sps-setting-field";
    siteInput.placeholder = t("siyuanShare.placeholder.siteUrl");

    const apiKeyInput = document.createElement("input");
    apiKeyInput.className = "b3-text-field fn__block sps-setting-field";
    apiKeyInput.type = "password";
    apiKeyInput.placeholder = t("siyuanShare.label.apiKey");

    const autoUpdateWrap = document.createElement("label");
    autoUpdateWrap.className = "sps-switch";
    autoUpdateWrap.innerHTML = `<input type="checkbox" aria-label="${escapeAttr(
      t("siyuanShare.label.autoUpdateEnabled"),
    )}" />
<span class="sps-switch__slider" aria-hidden="true"></span>`;
    const autoUpdateInput = autoUpdateWrap.querySelector("input");
    if (autoUpdateInput) {
      autoUpdateInput.addEventListener("change", this.onSettingAutoUpdateToggleChange);
    }

    const autoUpdateRow = document.createElement("div");
    autoUpdateRow.className = "siyuan-plugin-share__actions sps-setting-actions-inline sps-auto-update-row";
    autoUpdateRow.appendChild(autoUpdateWrap);
    autoUpdateRow.insertAdjacentHTML(
      "beforeend",
      `<button class="b3-button b3-button--outline" data-action="settings-auto-update-status">${escapeHtml(
        t("siyuanShare.action.autoUpdateStatus"),
      )}</button>`,
    );
    autoUpdateRow.addEventListener("click", this.onSettingActionsClick);

    const quietWindowInput = document.createElement("input");
    quietWindowInput.className = "b3-text-field";
    quietWindowInput.type = "number";
    quietWindowInput.min = "30";
    quietWindowInput.style.width = "80px";
    quietWindowInput.value = "60";
    quietWindowInput.addEventListener("change", this.onSettingQuietWindowChange);

    const currentWrap = document.createElement("div");
    currentWrap.className = "siyuan-plugin-share";
    currentWrap.addEventListener("click", this.onSettingCurrentClick);

    const sharesWrap = document.createElement("div");
    sharesWrap.className = "siyuan-plugin-share";
    sharesWrap.addEventListener("click", this.onSettingSharesClick);

    const envHint = document.createElement("div");
    envHint.className = "siyuan-plugin-share__muted sps-setting-hint";

    this.settingEls = {
      siteInput,
      apiKeyInput,
      siteSelect,
      siteNameInput,
      autoUpdateInput,
      autoUpdateRow,
      quietWindowInput,
      connectActions: null,
      currentWrap,
      sharesWrap,
      envHint,
    };

    this.setting = new Setting({
      width: "92vw",
      height: "80vh",
    });

    this.setting.addItem({
      title: t("siyuanShare.label.site"),
      description: t("siyuanShare.hint.siteList"),
      createActionElement: () => siteSelect,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteName"),
      description: "",
      createActionElement: () => siteNameInput,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteActions"),
      description: "",
      createActionElement: () => siteActions,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteUrl"),
      description: t("siyuanShare.hint.siteUrl"),
      createActionElement: () => siteInput,
    });
    this.setting.addItem({
      title: t("siyuanShare.label.apiKey"),
      description: t("siyuanShare.hint.apiKey"),
      createActionElement: () => apiKeyInput,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.autoUpdate"),
      description: t("siyuanShare.hint.autoUpdate"),
      createActionElement: () => autoUpdateRow,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.quietWindow"),
      description: t("siyuanShare.hint.quietWindow"),
      createActionElement: () => quietWindowInput,
    });

    const connectActions = document.createElement("div");
    connectActions.className = "siyuan-plugin-share__actions sps-setting-actions-inline";
    connectActions.innerHTML = `
  <button class="b3-button b3-button--outline" data-action="settings-sync">${t(
    "siyuanShare.action.verifySync",
  )}</button>
  <button class="b3-button b3-button--outline" data-action="settings-disconnect">${t(
    "siyuanShare.action.disconnect",
  )}</button>
`;
    connectActions.addEventListener("click", this.onSettingActionsClick);
    this.settingEls.connectActions = connectActions;
    this.setting.addItem({
      title: t("siyuanShare.label.connectionSync"),
      description: t("siyuanShare.hint.connectionSync"),
      createActionElement: () => connectActions,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.envInfo"),
      description: "",
      direction: "column",
      createActionElement: () => envHint,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.currentShareInfo"),
      description: t("siyuanShare.hint.currentShare"),
      direction: "column",
      createActionElement: () => currentWrap,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.shareList"),
      description: t("siyuanShare.hint.shareList"),
      direction: "column",
      createActionElement: () => sharesWrap,
    });

    this.syncSettingInputs();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.startSettingLayoutObserver();
  }

  resolveSiteName(name, siteUrl, fallbackIndex = 0) {
    const trimmed = String(name || "").trim();
    if (trimmed) return trimmed;
    const host = getUrlHost(siteUrl);
    if (host) return host;
    const url = String(siteUrl || "").trim();
    if (url) return url;
    return `${this.t("siyuanShare.label.site")} ${fallbackIndex + 1}`;
  }

  normalizeRemoteUser(raw) {
    if (!raw) return null;
    if (typeof raw === "string") {
      const username = raw.trim();
      return username ? {username} : null;
    }
    if (typeof raw !== "object") return null;
    const username = String(raw.username || raw.name || "").trim();
    const id = String(raw.id || raw.userId || "").trim();
    const user = {};
    if (username) user.username = username;
    if (id) user.id = id;
    return Object.keys(user).length ? user : null;
  }

  normalizeRemoteVerifiedAt(value) {
    const ts = Number(value);
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    return Math.floor(ts);
  }

  normalizeRemoteFeatures(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      incrementalShare: !!raw.incrementalShare,
      docChunkUpload: !!raw.docChunkUpload,
    };
  }

  syncRemoteStatusFromSite(site) {
    this.remoteUser = this.normalizeRemoteUser(site?.remoteUser);
    this.remoteVerifiedAt = this.normalizeRemoteVerifiedAt(site?.remoteVerifiedAt);
    this.remoteFeatures = this.normalizeRemoteFeatures(site?.remoteFeatures);
  }

  async persistActiveRemoteStatus({clear = false} = {}) {
    const sites = this.normalizeSiteList(this.settings.sites);
    const activeId = String(this.settings.activeSiteId || "");
    const activeSite = sites.find((site) => String(site.id) === activeId);
    if (!activeSite) return;
    if (clear) {
      activeSite.remoteUser = null;
      activeSite.remoteVerifiedAt = 0;
      activeSite.remoteFeatures = null;
    } else {
      activeSite.remoteUser = this.normalizeRemoteUser(this.remoteUser);
      activeSite.remoteVerifiedAt = this.normalizeRemoteVerifiedAt(this.remoteVerifiedAt);
      activeSite.remoteFeatures = this.normalizeRemoteFeatures(this.remoteFeatures);
    }
    this.settings = {
      ...this.settings,
      sites,
    };
    await this.saveData(STORAGE_SETTINGS, this.settings);
  }

  normalizeSiteList(rawSites) {
    const sites = [];
    const seen = new Set();
    if (!Array.isArray(rawSites)) return sites;
    rawSites.forEach((raw) => {
      if (!raw || typeof raw !== "object") return;
      let id = String(raw.id || "").trim();
      if (!id || seen.has(id)) {
        id = randomSlug(10);
      }
      const siteUrl = String(raw.siteUrl || "").trim();
      const apiKey = String(raw.apiKey || "").trim();
      const name = this.resolveSiteName(raw.name, siteUrl, sites.length);
      const remoteUser = this.normalizeRemoteUser(raw.remoteUser);
      const remoteVerifiedAt = this.normalizeRemoteVerifiedAt(raw.remoteVerifiedAt);
      const remoteFeatures = this.normalizeRemoteFeatures(raw.remoteFeatures);
      const autoUpdateEnabled = !!raw.autoUpdateEnabled;
      const quietWindowSeconds = Math.max(30, Math.floor(Number(raw.quietWindowSeconds) || 60));
      sites.push({id, name, siteUrl, apiKey, remoteUser, remoteVerifiedAt, remoteFeatures, autoUpdateEnabled, quietWindowSeconds});
      seen.add(id);
    });
    return sites;
  }

  normalizeAutoUpdateScanCursor(raw) {
    let updated = "";
    let docId = "";
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      updated = normalizeDocUpdatedStamp(raw.updated || raw.stamp || raw.value || "");
      docId = String(raw.docId || raw.id || "").trim();
    } else {
      updated = normalizeDocUpdatedStamp(raw);
    }
    if (!updated) return null;
    if (!isValidDocId(docId)) docId = "";
    return {updated, docId};
  }

  normalizeAutoUpdateScanStampBySite(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([siteIdRaw, cursorRaw]) => {
      const siteId = String(siteIdRaw || "").trim();
      if (!siteId) return;
      const cursor = this.normalizeAutoUpdateScanCursor(cursorRaw);
      if (!cursor) return;
      out[siteId] = cursor;
    });
    return out;
  }

  normalizeAutoUpdateQueue(raw) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(raw)) return out;
    raw.forEach((shareIdRaw) => {
      const shareId = String(shareIdRaw || "").trim();
      if (!shareId || seen.has(shareId)) return;
      seen.add(shareId);
      out.push(shareId);
    });
    return out;
  }

  normalizeAutoUpdateRetryStateByShare(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([shareIdRaw, rowRaw]) => {
      const shareId = String(shareIdRaw || "").trim();
      if (!shareId) return;
      if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return;
      const attempt = Math.max(1, Math.floor(Number(rowRaw.attempt) || 1));
      const nextRetryAt = Math.max(0, Math.floor(Number(rowRaw.nextRetryAt) || 0));
      const message = String(rowRaw.message || "").trim();
      if (!nextRetryAt) return;
      out[shareId] = {attempt, nextRetryAt, message};
    });
    return out;
  }

  normalizeAutoUpdateStructDigestByShare(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([shareIdRaw, digestRaw]) => {
      const shareId = String(shareIdRaw || "").trim();
      if (!shareId) return;
      const digest = normalizeHashHex(digestRaw);
      if (!digest) return;
      out[shareId] = digest;
    });
    return out;
  }

  normalizeAutoUpdateQuietDeadlineByShare(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([shareIdRaw, deadlineRaw]) => {
      const shareId = String(shareIdRaw || "").trim();
      if (!shareId) return;
      const deadline = Math.max(0, Math.floor(Number(deadlineRaw) || 0));
      if (!deadline) return;
      out[shareId] = deadline;
    });
    return out;
  }

  normalizeAutoUpdateHistoryList(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    const now = nowTs();
    const minTs = now - AUTO_UPDATE_HISTORY_RETENTION_MS;
    raw.forEach((rowRaw) => {
      if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return;
      const ts = Math.max(0, Math.floor(Number(rowRaw.ts) || 0));
      if (!ts || ts < minTs) return;
      const levelRaw = String(rowRaw.level || "info").trim();
      const level = ["info", "success", "error"].includes(levelRaw) ? levelRaw : "info";
      const shareId = String(rowRaw.shareId || "").trim();
      const message = String(rowRaw.message || "").trim();
      const detail = String(rowRaw.detail || "").trim();
      if (!message) return;
      out.push({ts, level, shareId, message, detail});
    });
    out.sort((a, b) => b.ts - a.ts);
    if (out.length > AUTO_UPDATE_HISTORY_LIMIT) {
      out.length = AUTO_UPDATE_HISTORY_LIMIT;
    }
    return out;
  }

  normalizeAutoUpdateRuntimeBySite(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([siteIdRaw, rowRaw]) => {
      const siteId = String(siteIdRaw || "").trim();
      if (!siteId) return;
      if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return;
      const queue = this.normalizeAutoUpdateQueue(rowRaw.queue || []);
      const retryStateByShare = this.normalizeAutoUpdateRetryStateByShare(rowRaw.retryStateByShare || {});
      const history = this.normalizeAutoUpdateHistoryList(rowRaw.history || []);
      const structDigestByShare = this.normalizeAutoUpdateStructDigestByShare(
        rowRaw.structDigestByShare || rowRaw.structureDigestByShare || {},
      );
      const quietDeadlineByShare = this.normalizeAutoUpdateQuietDeadlineByShare(
        rowRaw.quietDeadlineByShare || rowRaw.quietDeadlinesByShare || {},
      );
      let quietPendingShareIds = this.normalizeAutoUpdateQueue(
        rowRaw.quietPendingShareIds || rowRaw.quietPendingQueue || rowRaw.quietPending || [],
      );
      if (!quietPendingShareIds.length && Object.keys(quietDeadlineByShare).length > 0) {
        quietPendingShareIds = this.normalizeAutoUpdateQueue(Object.keys(quietDeadlineByShare));
      }
      quietPendingShareIds = quietPendingShareIds.filter(
        (shareId) => Math.max(0, Math.floor(Number(quietDeadlineByShare?.[shareId]) || 0)) > 0,
      );
      const quietDeadlineBySharePruned = {};
      quietPendingShareIds.forEach((shareId) => {
        const deadline = Math.max(0, Math.floor(Number(quietDeadlineByShare?.[shareId]) || 0));
        if (!deadline) return;
        quietDeadlineBySharePruned[shareId] = deadline;
      });
      if (
        !queue.length &&
        !Object.keys(retryStateByShare).length &&
        !history.length &&
        !Object.keys(structDigestByShare).length &&
        !quietPendingShareIds.length
      ) {
        return;
      }
      out[siteId] = {
        queue,
        retryStateByShare,
        history,
        structDigestByShare,
        quietPendingShareIds,
        quietDeadlineByShare: quietDeadlineBySharePruned,
      };
    });
    return out;
  }

  syncAutoUpdateRuntimeRecordForSite(siteId = "") {
    const id = String(siteId || this.getActiveSiteId()).trim();
    if (!id) return;
    const store = this.normalizeAutoUpdateRuntimeBySite(this.autoUpdateRuntimeBySite || {});
    // Persist the in-flight share as resumable queue item.
    // This avoids losing the currently syncing task if app/plugin exits
    // before the unload-time flush fully lands on disk.
    const inFlightShareId = String(this.autoUpdateCurrentShareId || "").trim();
    const queue = this.normalizeAutoUpdateQueue(
      inFlightShareId ? [inFlightShareId, ...(this.autoUpdateQueue || [])] : this.autoUpdateQueue || [],
    );
    const retryStateByShare = this.normalizeAutoUpdateRetryStateByShare(this.autoUpdateRetryStateByShare || {});
    const history = this.normalizeAutoUpdateHistoryList(this.autoUpdateHistory || []);
    const structDigestByShare = this.normalizeAutoUpdateStructDigestByShare(this.autoUpdateStructDigestByShare || {});
    const quietDeadlineByShareAll = this.normalizeAutoUpdateQuietDeadlineByShare(this.autoUpdateQuietDeadlineByShare || {});
    const quietPendingShareIds = this.normalizeAutoUpdateQueue(Array.from(this.autoUpdateQuietPendingSet || []))
      .filter((shareId) => Math.max(0, Math.floor(Number(quietDeadlineByShareAll?.[shareId]) || 0)) > 0);
    const quietDeadlineByShare = {};
    quietPendingShareIds.forEach((shareId) => {
      const deadline = Math.max(0, Math.floor(Number(quietDeadlineByShareAll?.[shareId]) || 0));
      if (!deadline) return;
      quietDeadlineByShare[shareId] = deadline;
    });
    if (
      !queue.length &&
      !Object.keys(retryStateByShare).length &&
      !history.length &&
      !Object.keys(structDigestByShare).length &&
      !quietPendingShareIds.length
    ) {
      if (Object.prototype.hasOwnProperty.call(store, id)) {
        delete store[id];
      }
    } else {
      store[id] = {
        queue,
        retryStateByShare,
        history,
        structDigestByShare,
        quietPendingShareIds,
        quietDeadlineByShare,
      };
    }
    this.autoUpdateRuntimeBySite = store;
  }

  restoreAutoUpdateRuntimeForSite(siteId = "") {
    const id = String(siteId || this.getActiveSiteId()).trim();
    const store = this.normalizeAutoUpdateRuntimeBySite(this.autoUpdateRuntimeBySite || {});
    this.autoUpdateRuntimeBySite = store;
    const row = id ? store[id] || null : null;
    const shareIdSet = new Set(
      (Array.isArray(this.shares) ? this.shares : [])
        .map((share) => String(share?.id || "").trim())
        .filter((shareId) => shareId),
    );
    let queue = this.normalizeAutoUpdateQueue(row?.queue || []);
    let retryStateByShare = this.normalizeAutoUpdateRetryStateByShare(row?.retryStateByShare || {});
    let structDigestByShare = this.normalizeAutoUpdateStructDigestByShare(row?.structDigestByShare || {});
    let quietDeadlineByShare = this.normalizeAutoUpdateQuietDeadlineByShare(
      row?.quietDeadlineByShare || row?.quietDeadlinesByShare || {},
    );
    let quietPendingShareIds = this.normalizeAutoUpdateQueue(
      row?.quietPendingShareIds || row?.quietPendingQueue || row?.quietPending || [],
    );
    if (!quietPendingShareIds.length && Object.keys(quietDeadlineByShare).length > 0) {
      quietPendingShareIds = this.normalizeAutoUpdateQueue(Object.keys(quietDeadlineByShare));
    }
    quietPendingShareIds = quietPendingShareIds.filter(
      (shareId) => Math.max(0, Math.floor(Number(quietDeadlineByShare?.[shareId]) || 0)) > 0,
    );
    const quietDeadlineBySharePrunedByPending = {};
    quietPendingShareIds.forEach((shareId) => {
      const deadline = Math.max(0, Math.floor(Number(quietDeadlineByShare?.[shareId]) || 0));
      if (!deadline) return;
      quietDeadlineBySharePrunedByPending[shareId] = deadline;
    });
    quietDeadlineByShare = quietDeadlineBySharePrunedByPending;
    let shouldPersist = false;
    if (shareIdSet.size > 0) {
      const prevQueueLength = queue.length;
      const prevRetryCount = Object.keys(retryStateByShare).length;
      const prevDigestCount = Object.keys(structDigestByShare).length;
      const prevQuietPendingCount = quietPendingShareIds.length;
      const prevQuietDeadlineCount = Object.keys(quietDeadlineByShare).length;
      queue = queue.filter((shareId) => shareIdSet.has(shareId));
      const prunedRetry = {};
      Object.entries(retryStateByShare).forEach(([shareId, retry]) => {
        if (!shareIdSet.has(String(shareId))) return;
        prunedRetry[shareId] = retry;
      });
      retryStateByShare = prunedRetry;
      const prunedDigest = {};
      Object.entries(structDigestByShare).forEach(([shareId, digest]) => {
        if (!shareIdSet.has(String(shareId))) return;
        const normalizedDigest = normalizeHashHex(digest);
        if (!normalizedDigest) return;
        prunedDigest[shareId] = normalizedDigest;
      });
      structDigestByShare = prunedDigest;
      quietPendingShareIds = quietPendingShareIds.filter((shareId) => shareIdSet.has(String(shareId)));
      const prunedQuietDeadline = {};
      quietPendingShareIds.forEach((shareId) => {
        const deadline = Math.max(0, Math.floor(Number(quietDeadlineByShare?.[shareId]) || 0));
        if (!deadline) return;
        prunedQuietDeadline[shareId] = deadline;
      });
      quietDeadlineByShare = prunedQuietDeadline;
      if (
        queue.length !== prevQueueLength ||
        Object.keys(retryStateByShare).length !== prevRetryCount ||
        Object.keys(structDigestByShare).length !== prevDigestCount ||
        quietPendingShareIds.length !== prevQuietPendingCount ||
        Object.keys(quietDeadlineByShare).length !== prevQuietDeadlineCount
      ) {
        shouldPersist = true;
      }
    }
    const history = this.normalizeAutoUpdateHistoryList(row?.history || []);
    if (row && Array.isArray(row.history) && history.length !== row.history.length) {
      shouldPersist = true;
    }
    this.autoUpdateQueue = queue;
    this.autoUpdateQueuedSet = new Set(queue);
    this.autoUpdateRetryStateByShare = retryStateByShare;
    this.autoUpdateStructDigestByShare = structDigestByShare;
    this.autoUpdateShareChangeSeqById = {};
    if (this.autoUpdateQuietFlushTimer) {
      clearTimeout(this.autoUpdateQuietFlushTimer);
      this.autoUpdateQuietFlushTimer = null;
    }
    this.autoUpdateQuietNextFlushAt = 0;
    this.autoUpdateQuietPendingSet = new Set(quietPendingShareIds);
    this.autoUpdateQuietDeadlineByShare = quietDeadlineByShare;
    this.autoUpdateQuietFirstEnteredByShare = {};
    this.autoUpdateHistory = history;
    this.autoUpdateCurrentShareId = "";
    this.autoUpdateCurrentController = null;
    this.autoUpdateShareNotebookHintById = {};
    this.autoUpdateRerunSet.clear();
    this.autoUpdateAbortByQuietSet.clear();
    this.autoUpdateAbortByManualSet.clear();
    this.autoUpdateAbortByNotebookClosedSet.clear();
    this.autoUpdateManualSkipDetectSet.clear();
    this.autoUpdateManualSkipRealtimeOnceSet.clear();
    if (this.autoUpdateQuietPendingSet.size > 0) {
      this.scheduleAutoUpdateQuietFlush();
    }
    this.refreshAutoUpdateStatusTextInDock();
    if (this.autoUpdateStatusDialog?.element?.isConnected) {
      this.renderAutoUpdateStatusDialog();
    }
    if (shouldPersist) {
      this.schedulePersistAutoUpdateRuntime();
    }
  }

  schedulePersistAutoUpdateRuntime() {
    const siteId = this.getActiveSiteId();
    if (!siteId) return;
    this.syncAutoUpdateRuntimeRecordForSite(siteId);
    if (this.autoUpdatePersistTimer) return;
    this.autoUpdatePersistTimer = setTimeout(() => {
      this.autoUpdatePersistTimer = null;
      void this.persistAutoUpdateRuntimeNow();
    }, this.autoUpdatePersistDelayMs);
  }

  async persistAutoUpdateRuntimeNow() {
    const siteId = this.getActiveSiteId();
    if (siteId) {
      this.syncAutoUpdateRuntimeRecordForSite(siteId);
    }
    const store = this.normalizeAutoUpdateRuntimeBySite(this.autoUpdateRuntimeBySite || {});
    this.autoUpdateRuntimeBySite = store;
    const fingerprint = stableStringify(store);
    if (this.autoUpdatePersistInitialized && fingerprint === this.autoUpdatePersistFingerprint) {
      return;
    }
    await this.saveData(STORAGE_AUTO_UPDATE_RUNTIME, store);
    this.autoUpdatePersistFingerprint = fingerprint;
    this.autoUpdatePersistInitialized = true;
  }

  async flushAutoUpdateRuntimePersist() {
    if (this.autoUpdatePersistTimer) {
      clearTimeout(this.autoUpdatePersistTimer);
      this.autoUpdatePersistTimer = null;
    }
    try {
      await this.persistAutoUpdateRuntimeNow();
    } catch {
      // ignore
    }
  }

  async removeAutoUpdateRuntimeForSite(siteId) {
    const id = String(siteId || "").trim();
    if (!id) return;
    const store = this.normalizeAutoUpdateRuntimeBySite(this.autoUpdateRuntimeBySite || {});
    if (!Object.prototype.hasOwnProperty.call(store, id)) return;
    delete store[id];
    this.autoUpdateRuntimeBySite = store;
    const fingerprint = stableStringify(store);
    if (this.autoUpdatePersistInitialized && fingerprint === this.autoUpdatePersistFingerprint) {
      return;
    }
    await this.saveData(STORAGE_AUTO_UPDATE_RUNTIME, store);
    this.autoUpdatePersistFingerprint = fingerprint;
    this.autoUpdatePersistInitialized = true;
  }

  normalizeIncrementalCursorBySite(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([siteIdRaw, cursorMap]) => {
      const siteId = String(siteIdRaw || "").trim();
      if (!siteId) return;
      if (!cursorMap || typeof cursorMap !== "object" || Array.isArray(cursorMap)) return;
      const nextMap = {};
      Object.entries(cursorMap).forEach(([shareIdRaw, stampRaw]) => {
        const shareId = String(shareIdRaw || "").trim();
        if (!shareId) return;
        const stamp = normalizeDocUpdatedStamp(stampRaw);
        if (!stamp) return;
        nextMap[shareId] = stamp;
      });
      if (Object.keys(nextMap).length) {
        out[siteId] = nextMap;
      }
    });
    return out;
  }

  normalizeDocBlockCountBySite(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([siteIdRaw, shareMapRaw]) => {
      const siteId = String(siteIdRaw || "").trim();
      if (!siteId) return;
      if (!shareMapRaw || typeof shareMapRaw !== "object" || Array.isArray(shareMapRaw)) return;
      const shareMap = {};
      Object.entries(shareMapRaw).forEach(([shareIdRaw, docMapRaw]) => {
        const shareId = String(shareIdRaw || "").trim();
        if (!shareId) return;
        if (!docMapRaw || typeof docMapRaw !== "object" || Array.isArray(docMapRaw)) return;
        const docMap = {};
        Object.entries(docMapRaw).forEach(([docIdRaw, countRaw]) => {
          const docId = String(docIdRaw || "").trim();
          if (!isValidDocId(docId)) return;
          const count = Math.max(0, Math.floor(Number(countRaw) || 0));
          docMap[docId] = count;
        });
        if (Object.keys(docMap).length) {
          shareMap[shareId] = docMap;
        }
      });
      if (Object.keys(shareMap).length) {
        out[siteId] = shareMap;
      }
    });
    return out;
  }

  getActiveSiteId() {
    return String(this.settings?.activeSiteId || "").trim();
  }

  getIncrementalCursor(shareId) {
    const siteId = this.getActiveSiteId();
    const shareKey = String(shareId || "").trim();
    if (!siteId || !shareKey) return "";
    const siteMap = this.incrementalCursorBySite?.[siteId];
    if (!siteMap || typeof siteMap !== "object") return "";
    return normalizeDocUpdatedStamp(siteMap[shareKey]);
  }

  async setIncrementalCursor(shareId, stamp) {
    const siteId = this.getActiveSiteId();
    const shareKey = String(shareId || "").trim();
    const normalized = normalizeDocUpdatedStamp(stamp);
    if (!siteId || !shareKey || !normalized) return;
    const store = this.normalizeIncrementalCursorBySite(this.incrementalCursorBySite || {});
    const siteMap = {...(store[siteId] || {})};
    if (siteMap[shareKey] === normalized) return;
    siteMap[shareKey] = normalized;
    store[siteId] = siteMap;
    this.incrementalCursorBySite = store;
    await this.saveData(STORAGE_INCREMENTAL_CURSOR, store);
  }

  async clearIncrementalCursor(shareId) {
    const siteId = this.getActiveSiteId();
    const shareKey = String(shareId || "").trim();
    if (!siteId || !shareKey) return;
    const store = this.normalizeIncrementalCursorBySite(this.incrementalCursorBySite || {});
    const siteMap = {...(store[siteId] || {})};
    if (!Object.prototype.hasOwnProperty.call(siteMap, shareKey)) return;
    delete siteMap[shareKey];
    if (Object.keys(siteMap).length) {
      store[siteId] = siteMap;
    } else {
      delete store[siteId];
    }
    this.incrementalCursorBySite = store;
    await this.saveData(STORAGE_INCREMENTAL_CURSOR, store);
  }

  async pruneIncrementalCursor(shareIds = []) {
    const siteId = this.getActiveSiteId();
    if (!siteId) return;
    const keep = new Set((Array.isArray(shareIds) ? shareIds : []).map((id) => String(id || "").trim()).filter(Boolean));
    const store = this.normalizeIncrementalCursorBySite(this.incrementalCursorBySite || {});
    const siteMapRaw = store[siteId];
    if (!siteMapRaw || typeof siteMapRaw !== "object") return;
    let changed = false;
    const siteMap = {...siteMapRaw};
    Object.keys(siteMap).forEach((key) => {
      if (!keep.has(String(key))) {
        delete siteMap[key];
        changed = true;
      }
    });
    if (!changed) return;
    if (Object.keys(siteMap).length) {
      store[siteId] = siteMap;
    } else {
      delete store[siteId];
    }
    this.incrementalCursorBySite = store;
    await this.saveData(STORAGE_INCREMENTAL_CURSOR, store);
  }

  getDocBlockCountCache(shareId) {
    const siteId = this.getActiveSiteId();
    const shareKey = String(shareId || "").trim();
    if (!siteId || !shareKey) return {};
    const siteMap = this.docBlockCountBySite?.[siteId];
    if (!siteMap || typeof siteMap !== "object") return {};
    const docMap = siteMap[shareKey];
    if (!docMap || typeof docMap !== "object") return {};
    return docMap;
  }

  async setDocBlockCountCache(shareId, docMapRaw) {
    const siteId = this.getActiveSiteId();
    const shareKey = String(shareId || "").trim();
    if (!siteId || !shareKey) return;
    const docMap = {};
    if (docMapRaw && typeof docMapRaw === "object" && !Array.isArray(docMapRaw)) {
      Object.entries(docMapRaw).forEach(([docIdRaw, countRaw]) => {
        const docId = String(docIdRaw || "").trim();
        if (!isValidDocId(docId)) return;
        const count = Math.max(0, Math.floor(Number(countRaw) || 0));
        docMap[docId] = count;
      });
    }
    const store = this.normalizeDocBlockCountBySite(this.docBlockCountBySite || {});
    const siteMap = {...(store[siteId] || {})};
    if (Object.keys(docMap).length) {
      siteMap[shareKey] = docMap;
    } else {
      delete siteMap[shareKey];
    }
    if (Object.keys(siteMap).length) {
      store[siteId] = siteMap;
    } else {
      delete store[siteId];
    }
    this.docBlockCountBySite = store;
    await this.saveData(STORAGE_DOC_BLOCK_COUNTS, store);
  }

  async clearDocBlockCountCache(shareId) {
    const siteId = this.getActiveSiteId();
    const shareKey = String(shareId || "").trim();
    if (!siteId || !shareKey) return;
    const store = this.normalizeDocBlockCountBySite(this.docBlockCountBySite || {});
    const siteMap = {...(store[siteId] || {})};
    if (!Object.prototype.hasOwnProperty.call(siteMap, shareKey)) return;
    delete siteMap[shareKey];
    if (Object.keys(siteMap).length) {
      store[siteId] = siteMap;
    } else {
      delete store[siteId];
    }
    this.docBlockCountBySite = store;
    await this.saveData(STORAGE_DOC_BLOCK_COUNTS, store);
  }

  async pruneDocBlockCountCache(shareIds = []) {
    const siteId = this.getActiveSiteId();
    if (!siteId) return;
    const keep = new Set((Array.isArray(shareIds) ? shareIds : []).map((id) => String(id || "").trim()).filter(Boolean));
    const store = this.normalizeDocBlockCountBySite(this.docBlockCountBySite || {});
    const siteMapRaw = store[siteId];
    if (!siteMapRaw || typeof siteMapRaw !== "object") return;
    let changed = false;
    const siteMap = {...siteMapRaw};
    Object.keys(siteMap).forEach((key) => {
      if (!keep.has(String(key))) {
        delete siteMap[key];
        changed = true;
      }
    });
    if (!changed) return;
    if (Object.keys(siteMap).length) {
      store[siteId] = siteMap;
    } else {
      delete store[siteId];
    }
    this.docBlockCountBySite = store;
    await this.saveData(STORAGE_DOC_BLOCK_COUNTS, store);
  }

  normalizeExportRetryCacheIndexBySite(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    Object.entries(raw).forEach(([siteIdRaw, scopeMapRaw]) => {
      const siteId = String(siteIdRaw || "").trim();
      if (!siteId) return;
      if (!scopeMapRaw || typeof scopeMapRaw !== "object" || Array.isArray(scopeMapRaw)) return;
      const scopeMap = {};
      Object.entries(scopeMapRaw).forEach(([scopeKeyRaw, itemRaw]) => {
        const scopeKey = String(scopeKeyRaw || "").trim();
        if (!scopeKey) return;
        if (!itemRaw || typeof itemRaw !== "object" || Array.isArray(itemRaw)) return;
        const cacheKey = String(itemRaw.cacheKey || "").trim();
        if (!cacheKey) return;
        const scopeDigest = normalizeHashHex(itemRaw.scopeDigest);
        const exportStamp = normalizeDocUpdatedStamp(itemRaw.exportStamp);
        const savedAt = Math.max(0, Math.floor(Number(itemRaw.savedAt) || 0));
        const bytes = Math.max(0, Math.floor(Number(itemRaw.bytes) || 0));
        scopeMap[scopeKey] = {
          cacheKey,
          scopeDigest,
          exportStamp,
          savedAt,
          bytes,
          type: String(itemRaw.type || "").trim(),
          targetId: String(itemRaw.targetId || "").trim(),
          includeChildren: !!itemRaw.includeChildren,
        };
      });
      if (Object.keys(scopeMap).length) {
        out[siteId] = scopeMap;
      }
    });
    return out;
  }

  async persistExportRetryCacheIndex() {
    const normalized = this.normalizeExportRetryCacheIndexBySite(this.exportRetryCacheIndexBySite || {});
    this.exportRetryCacheIndexBySite = normalized;
    await this.saveData(STORAGE_EXPORT_RETRY_CACHE_INDEX, normalized);
  }

  async getExportRetryCacheDirPath() {
    if (!this.hasNodeFs) return "";
    const wsDir = await this.ensureWorkspaceDir();
    if (!wsDir) return "";
    const pluginName = String(this.name || "siyuan-plugin-share").trim() || "siyuan-plugin-share";
    return joinFsPath(wsDir, "data", "storage", "petal", pluginName, EXPORT_RETRY_CACHE_DIR_NAME);
  }

  async clearExportRetryCacheFiles() {
    if (!this.hasNodeFs) return;
    const cacheDir = await this.getExportRetryCacheDirPath();
    if (!cacheDir) return;
    await safeRm(cacheDir).catch(() => {});
  }

  async clearExportRetryCacheOnStartup() {
    this.exportRetryCacheIndexBySite = {};
    await this.removeData(STORAGE_EXPORT_RETRY_CACHE_INDEX).catch(() => {});
    await this.clearExportRetryCacheFiles();
  }

  buildExportRetryScopeKey({type = "", targetId = "", includeChildren = false} = {}) {
    return `${String(type || "").trim()}:${String(targetId || "").trim()}:${includeChildren ? "1" : "0"}`;
  }

  buildExportRetryScopeMeta({type = "", targetId = "", includeChildren = false} = {}) {
    const normalizedType = String(type || "").trim();
    const normalizedTarget = String(targetId || "").trim();
    const normalizedChildren = !!includeChildren;
    return {
      siteId: this.getActiveSiteId(),
      type: normalizedType,
      targetId: normalizedTarget,
      includeChildren: normalizedChildren,
      scopeKey: this.buildExportRetryScopeKey({
        type: normalizedType,
        targetId: normalizedTarget,
        includeChildren: normalizedChildren,
      }),
    };
  }

  getExportRetryCacheRecord(scopeMeta) {
    const siteId = String(scopeMeta?.siteId || "").trim();
    const scopeKey = String(scopeMeta?.scopeKey || "").trim();
    if (!siteId || !scopeKey) return null;
    const siteMap = this.exportRetryCacheIndexBySite?.[siteId];
    if (!siteMap || typeof siteMap !== "object") return null;
    const record = siteMap[scopeKey];
    if (!record || typeof record !== "object") return null;
    const cacheKey = String(record.cacheKey || "").trim();
    if (!cacheKey) return null;
    return {
      cacheKey,
      scopeDigest: normalizeHashHex(record.scopeDigest),
      exportStamp: normalizeDocUpdatedStamp(record.exportStamp),
      savedAt: Math.max(0, Math.floor(Number(record.savedAt) || 0)),
      bytes: Math.max(0, Math.floor(Number(record.bytes) || 0)),
      type: String(record.type || "").trim(),
      targetId: String(record.targetId || "").trim(),
      includeChildren: !!record.includeChildren,
    };
  }

  async setExportRetryCacheRecord(scopeMeta, record) {
    const siteId = String(scopeMeta?.siteId || "").trim();
    const scopeKey = String(scopeMeta?.scopeKey || "").trim();
    if (!siteId || !scopeKey) return;
    const normalized = this.normalizeExportRetryCacheIndexBySite(this.exportRetryCacheIndexBySite || {});
    const siteMap = {...(normalized[siteId] || {})};
    siteMap[scopeKey] = {
      cacheKey: String(record?.cacheKey || "").trim(),
      scopeDigest: normalizeHashHex(record?.scopeDigest),
      exportStamp: normalizeDocUpdatedStamp(record?.exportStamp),
      savedAt: Math.max(0, Math.floor(Number(record?.savedAt) || 0)),
      bytes: Math.max(0, Math.floor(Number(record?.bytes) || 0)),
      type: String(record?.type || "").trim(),
      targetId: String(record?.targetId || "").trim(),
      includeChildren: !!record?.includeChildren,
    };
    normalized[siteId] = siteMap;
    this.exportRetryCacheIndexBySite = normalized;
    await this.persistExportRetryCacheIndex();
  }

  async deleteExportRetryCacheRecord(scopeMeta, {persist = true} = {}) {
    const siteId = String(scopeMeta?.siteId || "").trim();
    const scopeKey = String(scopeMeta?.scopeKey || "").trim();
    if (!siteId || !scopeKey) return null;
    const normalized = this.normalizeExportRetryCacheIndexBySite(this.exportRetryCacheIndexBySite || {});
    const siteMap = {...(normalized[siteId] || {})};
    const existing = siteMap[scopeKey];
    if (!existing) return null;
    delete siteMap[scopeKey];
    if (Object.keys(siteMap).length) {
      normalized[siteId] = siteMap;
    } else {
      delete normalized[siteId];
    }
    this.exportRetryCacheIndexBySite = normalized;
    if (persist) {
      await this.persistExportRetryCacheIndex();
    }
    return existing;
  }

  async buildExportRetryCacheKey(scopeMeta) {
    const siteId = String(scopeMeta?.siteId || "").trim();
    const scopeKey = String(scopeMeta?.scopeKey || "").trim();
    const seed = `${siteId}|${scopeKey}`;
    const hash = normalizeHashHex(await hashTextSha256(seed));
    if (hash) return `retry-${hash.slice(0, 24)}`;
    const fallback = seed.replace(/[^0-9a-zA-Z_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    return (fallback || "retry").slice(0, 64);
  }

  getExportRetryCachePaths(cacheKey, cacheDir = "") {
    const base = String(cacheDir || "").trim();
    const key = String(cacheKey || "").trim();
    if (!base || !key) {
      return {metaPath: "", docDir: "", assetDir: ""};
    }
    return {
      metaPath: joinFsPath(base, `${key}.json`),
      docDir: joinFsPath(base, `${key}.docs`),
      assetDir: joinFsPath(base, `${key}.assets`),
    };
  }

  async removeExportRetryCacheFilesByKey(cacheKey) {
    if (!this.hasNodeFs) return;
    const key = String(cacheKey || "").trim();
    if (!key) return;
    const cacheDir = await this.getExportRetryCacheDirPath();
    if (!cacheDir) return;
    const {metaPath, docDir, assetDir} = this.getExportRetryCachePaths(key, cacheDir);
    if (metaPath) {
      await fs.promises.unlink(metaPath).catch(() => {});
    }
    if (docDir) {
      await safeRm(docDir).catch(() => {});
    }
    if (assetDir) {
      await safeRm(assetDir).catch(() => {});
    }
  }

  async removeExportRetryCacheForScope(scopeMeta, {persist = true} = {}) {
    const record = this.getExportRetryCacheRecord(scopeMeta);
    if (record?.cacheKey) {
      await this.removeExportRetryCacheFilesByKey(record.cacheKey);
    }
    await this.deleteExportRetryCacheRecord(scopeMeta, {persist});
  }

  async removeExportRetryCacheForTarget({type = "", targetId = "", siteId = ""} = {}) {
    const targetType = String(type || "").trim();
    const target = String(targetId || "").trim();
    const siteLimit = String(siteId || "").trim();
    if (!targetType || !target) return;
    const normalized = this.normalizeExportRetryCacheIndexBySite(this.exportRetryCacheIndexBySite || {});
    let changed = false;
    for (const [siteKey, scopeMapRaw] of Object.entries(normalized)) {
      if (siteLimit && siteKey !== siteLimit) continue;
      const scopeMap = {...(scopeMapRaw || {})};
      let siteChanged = false;
      for (const [scopeKey, item] of Object.entries(scopeMap)) {
        if (String(item?.type || "").trim() !== targetType || String(item?.targetId || "").trim() !== target) {
          continue;
        }
        siteChanged = true;
        changed = true;
        delete scopeMap[scopeKey];
        await this.removeExportRetryCacheFilesByKey(item?.cacheKey);
      }
      if (!siteChanged) continue;
      if (Object.keys(scopeMap).length) {
        normalized[siteKey] = scopeMap;
      } else {
        delete normalized[siteKey];
      }
    }
    if (!changed) return;
    this.exportRetryCacheIndexBySite = normalized;
    await this.persistExportRetryCacheIndex();
  }

  normalizeExportRetryDocs(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    rows.forEach((row, index) => {
      const docId = String(row?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const normalized = {
        docId,
        title: String(row?.title || ""),
        hPath: String(row?.hPath || ""),
        parentId: String(row?.parentId || ""),
        sortIndex: Number.isFinite(Number(row?.sortIndex)) ? Number(row.sortIndex) : index,
        sortOrder: Math.max(0, Math.floor(Number(row?.sortOrder) || index)),
        markdown: String(row?.markdown || ""),
      };
      const icon = normalizeDocIconValue(row?.icon || "");
      if (icon) {
        normalized.icon = icon;
      }
      out.push(normalized);
    });
    return out;
  }

  normalizeExportRetryAssetEntries(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    const seen = new Set();
    rows.forEach((row) => {
      const asset = row?.asset || row;
      const assetPath = normalizeAssetPath(asset?.path || "");
      const blob = asset?.blob || null;
      if (!assetPath || !blob || seen.has(assetPath)) return;
      seen.add(assetPath);
      out.push({
        docId: String(row?.docId || "").trim(),
        asset: {
          path: assetPath,
          blob,
        },
      });
    });
    return out;
  }

  collectRequiredAssetPathsFromExportDocs(docs) {
    const required = new Set();
    const rows = Array.isArray(docs) ? docs : [];
    rows.forEach((doc) => {
      const markdown = String(doc?.markdown || "");
      extractAssetPaths(markdown).forEach((assetPath) => {
        const normalized = normalizeAssetPath(assetPath);
        if (normalized) required.add(normalized);
      });
      const icon = normalizeDocIconValue(doc?.icon || "");
      if (getDocIconKind(icon) === "asset") {
        const iconPath = normalizeAssetPath(normalizeDocIconAssetPath(icon));
        if (iconPath) required.add(iconPath);
      }
    });
    return required;
  }

  collectStructChangedDocIdsForExportRetry(scopeDocs, cachedDocs) {
    const scope = Array.isArray(scopeDocs) ? scopeDocs : [];
    const cachedMap = new Map(
      this.normalizeExportRetryDocs(cachedDocs || [])
        .map((doc) => [String(doc?.docId || "").trim(), doc]),
    );
    const changed = new Set();
    scope.forEach((doc, index) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const cached = cachedMap.get(docId);
      if (!cached) {
        changed.add(docId);
        return;
      }
      const nextTitle = String(doc?.title || "");
      const prevTitle = String(cached?.title || "");
      const nextIcon = normalizeDocIconValue(doc?.icon || "");
      const prevIcon = normalizeDocIconValue(cached?.icon || "");
      const nextParentId = String(doc?.parentId || "");
      const prevParentId = String(cached?.parentId || "");
      const nextSortIndex = normalizeSortIndexForHash(doc?.sortIndex ?? index);
      const prevSortIndex = normalizeSortIndexForHash(cached?.sortIndex ?? index);
      const nextSortOrder = Math.max(0, Math.floor(Number(doc?.sortOrder) || index));
      const prevSortOrder = Math.max(0, Math.floor(Number(cached?.sortOrder) || index));
      if (
        nextTitle !== prevTitle ||
        nextIcon !== prevIcon ||
        nextParentId !== prevParentId ||
        nextSortIndex !== prevSortIndex ||
        nextSortOrder !== prevSortOrder
      ) {
        changed.add(docId);
      }
    });
    return Array.from(changed);
  }

  collectMissingAssetDocIdsFromExportRetryCache(cachedDocs, cachedAssetEntries) {
    const docs = this.normalizeExportRetryDocs(cachedDocs || []);
    const assetPathSet = new Set(
      this.normalizeExportRetryAssetEntries(cachedAssetEntries || [])
        .map((entry) => normalizeAssetPath((entry?.asset || entry)?.path || ""))
        .filter(Boolean),
    );
    const missingDocIds = new Set();
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const required = new Set();
      const markdown = String(doc?.markdown || "");
      extractAssetPaths(markdown).forEach((assetPath) => {
        const normalized = normalizeAssetPath(assetPath);
        if (normalized) required.add(normalized);
      });
      const icon = normalizeDocIconValue(doc?.icon || "");
      if (getDocIconKind(icon) === "asset") {
        const iconPath = normalizeAssetPath(normalizeDocIconAssetPath(icon));
        if (iconPath) required.add(iconPath);
      }
      for (const assetPath of required) {
        if (!assetPathSet.has(assetPath)) {
          missingDocIds.add(docId);
          break;
        }
      }
    });
    return Array.from(missingDocIds);
  }

  async collectExportRetryChangedDocIds(
    scopeDocs,
    cachedDocs,
    sinceStamp,
    {cachedAssetEntries = [], controller = null, progress = null} = {},
  ) {
    const t = this.t.bind(this);
    const scope = Array.isArray(scopeDocs) ? scopeDocs : [];
    const scopeIds = Array.from(
      new Set(scope.map((doc) => String(doc?.docId || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!scopeIds.length) return [];
    const scopeSet = new Set(scopeIds);
    const changed = new Set();
    this.collectStructChangedDocIdsForExportRetry(scope, cachedDocs || []).forEach((docId) => {
      if (scopeSet.has(docId)) changed.add(docId);
    });
    this.collectMissingAssetDocIdsFromExportRetryCache(cachedDocs || [], cachedAssetEntries || []).forEach((docId) => {
      if (scopeSet.has(docId)) changed.add(docId);
    });
    const normalizedSince = normalizeDocUpdatedStamp(sinceStamp);
    if (!normalizedSince) return scopeIds;
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const directDocIds = await this.queryDocsUpdatedSince(scopeIds, normalizedSince);
    if (!Array.isArray(directDocIds)) {
      throw new Error("Export cache precheck failed while querying changed docs");
    }
    directDocIds.forEach((docId) => {
      if (scopeSet.has(docId)) changed.add(docId);
    });
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const impactedDocIds = await this.queryRefImpactedDocsSince(scopeIds, normalizedSince);
    if (!Array.isArray(impactedDocIds)) {
      throw new Error("Export cache precheck failed while querying references");
    }
    impactedDocIds.forEach((docId) => {
      if (scopeSet.has(docId)) changed.add(docId);
    });
    const changedDocIds = Array.from(changed);
    progress?.update?.({
      text: t("siyuanShare.progress.analyzingIncrement"),
      detail: t("siyuanShare.progress.analyzingDocs", {
        index: changedDocIds.length,
        total: scopeIds.length,
      }),
    });
    return changedDocIds;
  }

  async blobToNodeBuffer(blob) {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(blob)) return blob;
    if (blob && typeof blob.arrayBuffer === "function") {
      const buf = await blob.arrayBuffer();
      if (typeof Buffer !== "undefined") {
        return Buffer.from(buf);
      }
      return new Uint8Array(buf);
    }
    const text = String(blob || "");
    if (typeof Buffer !== "undefined") {
      return Buffer.from(text, "utf8");
    }
    return encodeUtf8Bytes(text);
  }

  async computeExportRetryScopeDigest(scopeMeta, scopeDocs) {
    const rows = (Array.isArray(scopeDocs) ? scopeDocs : [])
      .map((doc, index) => ({
        docId: String(doc?.docId || "").trim(),
        title: String(doc?.title || ""),
        icon: normalizeDocIconValue(doc?.icon || ""),
        parentId: String(doc?.parentId || ""),
        sortIndex: normalizeSortIndexForHash(doc?.sortIndex ?? index),
        sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder) || index)),
      }))
      .filter((doc) => isValidDocId(doc.docId))
      .sort((a, b) => {
        if (a.sortOrder === b.sortOrder) return a.docId.localeCompare(b.docId);
        return a.sortOrder - b.sortOrder;
      });
    const payload = {
      type: String(scopeMeta?.type || ""),
      targetId: String(scopeMeta?.targetId || ""),
      includeChildren: !!scopeMeta?.includeChildren,
      docs: rows,
    };
    return normalizeHashHex(await hashTextSha256(JSON.stringify(payload)));
  }

  async loadExportRetryCacheEntry(record) {
    if (!this.hasNodeFs) return null;
    const cacheKey = String(record?.cacheKey || "").trim();
    if (!cacheKey) return null;
    const cacheDir = await this.getExportRetryCacheDirPath();
    if (!cacheDir) return null;
    const {metaPath, docDir, assetDir} = this.getExportRetryCachePaths(cacheKey, cacheDir);
    if (!metaPath || !docDir || !assetDir) return null;
    const raw = await fs.promises.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw);
    if (!meta || typeof meta !== "object") return null;
    const version = Math.max(0, Math.floor(Number(meta.version) || 0));
    if (version !== EXPORT_RETRY_CACHE_VERSION) return null;
    const docs = [];
    const docsMeta = Array.isArray(meta.docs) ? meta.docs : [];
    for (const row of docsMeta) {
      const fileName = String(row?.file || "").trim();
      if (!fileName || /[\\/]/.test(fileName) || fileName.includes("..")) continue;
      const docRaw = await fs.promises.readFile(joinFsPath(docDir, fileName), "utf8");
      const parsedDoc = JSON.parse(docRaw);
      const normalizedDoc = this.normalizeExportRetryDocs([parsedDoc])[0];
      if (normalizedDoc) {
        docs.push(normalizedDoc);
      }
    }
    const assetEntriesRaw = [];
    const assetsMeta = Array.isArray(meta.assets) ? meta.assets : [];
    for (const row of assetsMeta) {
      const assetPath = normalizeAssetPath(row?.path || "");
      const fileName = String(row?.file || "").trim();
      if (!assetPath || !fileName || /[\\/]/.test(fileName) || fileName.includes("..")) continue;
      const buf = await fs.promises.readFile(joinFsPath(assetDir, fileName));
      assetEntriesRaw.push({
        docId: String(row?.docId || "").trim(),
        asset: {
          path: assetPath,
          blob: new Blob([buf]),
        },
      });
    }
    return {
      scopeDigest: normalizeHashHex(meta.scopeDigest || record?.scopeDigest),
      exportStamp: normalizeDocUpdatedStamp(meta.exportStamp || record?.exportStamp),
      savedAt: Math.max(0, Math.floor(Number(meta.savedAt) || 0)),
      docs,
      assetEntries: this.normalizeExportRetryAssetEntries(assetEntriesRaw),
    };
  }

  async resolveExportRetryCacheForScope(scopeMeta, scopeDocs, {controller = null, progress = null} = {}) {
    const docs = Array.isArray(scopeDocs) ? scopeDocs : [];
    const scopeDocIds = Array.from(
      new Set(docs.map((doc) => String(doc?.docId || "").trim()).filter((id) => isValidDocId(id))),
    );
    const scopeDigest = await this.computeExportRetryScopeDigest(scopeMeta, docs);
    if (!this.hasNodeFs || !scopeDocIds.length) {
      return {scopeDigest, cache: null, changedDocIds: scopeDocIds};
    }
    const record = this.getExportRetryCacheRecord(scopeMeta);
    if (!record) {
      return {scopeDigest, cache: null, changedDocIds: scopeDocIds};
    }
    // Scope changed (e.g., excluded docs changed), cached export data is no longer reusable.
    if (record.scopeDigest && scopeDigest && record.scopeDigest !== scopeDigest) {
      await this.removeExportRetryCacheForScope(scopeMeta);
      return {scopeDigest, cache: null, changedDocIds: scopeDocIds};
    }
    let cache = null;
    try {
      cache = await this.loadExportRetryCacheEntry(record);
    } catch (err) {
      console.warn("loadExportRetryCacheEntry failed", err);
      cache = null;
    }
    if (!cache) {
      await this.removeExportRetryCacheForScope(scopeMeta);
      return {scopeDigest, cache: null, changedDocIds: scopeDocIds};
    }
    cache = {
      ...cache,
      docs: this.normalizeExportRetryDocs(cache.docs || []),
      assetEntries: this.normalizeExportRetryAssetEntries(cache.assetEntries || []),
    };
    if (cache.scopeDigest && scopeDigest && cache.scopeDigest !== scopeDigest) {
      await this.removeExportRetryCacheForScope(scopeMeta);
      return {scopeDigest, cache: null, changedDocIds: scopeDocIds};
    }
    let changedDocIds = scopeDocIds;
    try {
      changedDocIds = await this.collectExportRetryChangedDocIds(
        docs,
        cache.docs || [],
        cache.exportStamp || record.exportStamp,
        {cachedAssetEntries: cache.assetEntries || [], controller, progress},
      );
    } catch (err) {
      console.warn("collectExportRetryChangedDocIds failed", err);
      changedDocIds = scopeDocIds;
    }
    return {
      scopeDigest,
      cache,
      changedDocIds: Array.from(
        new Set((Array.isArray(changedDocIds) ? changedDocIds : []).map((id) => String(id || "").trim())),
      ).filter((id) => isValidDocId(id)),
    };
  }

  mergeExportRetryData(scopeDocs, cachedData, freshData) {
    const scope = Array.isArray(scopeDocs) ? scopeDocs : [];
    const cachedDocs = this.normalizeExportRetryDocs(cachedData?.docs || []);
    const freshDocs = this.normalizeExportRetryDocs(freshData?.docs || []);
    const scopeDocSet = new Set(
      scope
        .map((doc) => String(doc?.docId || "").trim())
        .filter((docId) => isValidDocId(docId)),
    );
    const cachedMap = new Map(cachedDocs.map((doc) => [String(doc.docId), doc]));
    const freshMap = new Map(freshDocs.map((doc) => [String(doc.docId), doc]));
    const mergedDocs = [];
    scope.forEach((scopeDoc, index) => {
      const docId = String(scopeDoc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const freshPicked = freshMap.get(docId) || null;
      const cachedPicked = cachedMap.get(docId) || null;
      const picked = freshPicked || cachedPicked;
      if (!picked) return;
      const scopeTitle = String(scopeDoc?.title || "");
      const scopeIcon = normalizeDocIconValue(scopeDoc?.icon || "");
      const scopeParentId = String(scopeDoc?.parentId || "");
      const scopeSortIndex = normalizeSortIndexForHash(scopeDoc?.sortIndex ?? index);
      const scopeSortOrder = Math.max(0, Math.floor(Number(scopeDoc?.sortOrder) || index));
      const merged = {
        ...picked,
        docId,
        title: scopeTitle || String(picked?.title || ""),
        parentId: scopeParentId,
        sortIndex: scopeSortIndex,
        sortOrder: scopeSortOrder,
      };
      const freshIcon = normalizeDocIconValue(freshPicked?.icon || "");
      const cachedIcon = normalizeDocIconValue(cachedPicked?.icon || "");
      if (freshIcon) {
        merged.icon = freshIcon;
      } else if (cachedIcon) {
        merged.icon = cachedIcon;
      } else if (scopeIcon) {
        merged.icon = scopeIcon;
      } else {
        delete merged.icon;
      }
      mergedDocs.push(merged);
    });
    const mergedDocMap = new Map(
      mergedDocs
        .map((doc) => [String(doc?.docId || "").trim(), doc])
        .filter(([docId]) => isValidDocId(docId)),
    );
    const resolveDocIconAssetPath = (doc) => {
      const icon = normalizeDocIconValue(doc?.icon || "");
      if (getDocIconKind(icon) !== "asset") return "";
      return normalizeAssetPath(normalizeDocIconAssetPath(icon));
    };
    const activeIconAssetPaths = new Set();
    mergedDocs.forEach((doc) => {
      const iconPath = resolveDocIconAssetPath(doc);
      if (iconPath) activeIconAssetPaths.add(iconPath);
    });
    const collectDocRequiredAssetPaths = (doc) => {
      const required = new Set();
      const markdown = String(doc?.markdown || "");
      extractAssetPaths(markdown).forEach((assetPath) => {
        const normalized = normalizeAssetPath(assetPath);
        if (normalized) required.add(normalized);
      });
      const iconPath = resolveDocIconAssetPath(doc);
      if (iconPath) required.add(iconPath);
      return required;
    };
    const freshDocIdSet = new Set(
      freshDocs
        .map((doc) => String(doc?.docId || "").trim())
        .filter((docId) => isValidDocId(docId) && scopeDocSet.has(docId)),
    );
    const removedAssetPathsFromChangedDocs = new Set();
    freshDocIdSet.forEach((docId) => {
      const oldDoc = cachedMap.get(docId) || null;
      const newDoc = freshMap.get(docId) || null;
      if (!oldDoc || !newDoc) return;
      const oldRequired = collectDocRequiredAssetPaths(oldDoc);
      const newRequired = collectDocRequiredAssetPaths(newDoc);
      oldRequired.forEach((assetPath) => {
        if (!newRequired.has(assetPath)) {
          removedAssetPathsFromChangedDocs.add(assetPath);
        }
      });
    });
    const requiredAssetPathsAfterMerge = this.collectRequiredAssetPathsFromExportDocs(mergedDocs);
    const freshAssetPathSet = new Set(
      this.normalizeExportRetryAssetEntries(freshData?.assetEntries || [])
        .map((entry) => normalizeAssetPath((entry?.asset || entry)?.path || ""))
        .filter(Boolean),
    );
    const staleGeneratedIconPaths = new Set();
    cachedDocs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!scopeDocSet.has(docId)) return;
      const oldIconPath = resolveDocIconAssetPath(doc);
      if (!oldIconPath || !oldIconPath.startsWith("assets/share-icons/")) return;
      const nextDoc = mergedDocMap.get(docId);
      const nextIconPath = resolveDocIconAssetPath(nextDoc);
      if (oldIconPath === nextIconPath) return;
      if (freshAssetPathSet.has(oldIconPath)) return;
      if (activeIconAssetPaths.has(oldIconPath)) return;
      staleGeneratedIconPaths.add(oldIconPath);
    });
    const staleAssetPaths = new Set(staleGeneratedIconPaths);
    removedAssetPathsFromChangedDocs.forEach((assetPath) => {
      if (!assetPath) return;
      if (freshAssetPathSet.has(assetPath)) return;
      if (activeIconAssetPaths.has(assetPath)) return;
      if (requiredAssetPathsAfterMerge.has(assetPath)) return;
      staleAssetPaths.add(assetPath);
    });
    const normalizeEntry = (entry) => {
      const asset = entry?.asset || entry;
      const assetPath = normalizeAssetPath(asset?.path || "");
      const blob = asset?.blob || null;
      if (!assetPath || !blob) return null;
      return {
        docId: String(entry?.docId || "").trim(),
        asset: {
          path: assetPath,
          blob,
        },
      };
    };
    const mergedAssetMap = new Map();
    const putAsset = (entry, {override = false} = {}) => {
      if (!entry) return;
      const assetPath = String(entry?.asset?.path || "").trim();
      if (!assetPath) return;
      if (!override && mergedAssetMap.has(assetPath)) return;
      mergedAssetMap.set(assetPath, entry);
    };
    this.normalizeExportRetryAssetEntries(cachedData?.assetEntries || []).forEach((entry) => {
      const normalized = normalizeEntry(entry);
      if (!normalized) return;
      putAsset(normalized);
    });
    this.normalizeExportRetryAssetEntries(freshData?.assetEntries || []).forEach((entry) => {
      const normalized = normalizeEntry(entry);
      if (!normalized) return;
      putAsset(normalized, {override: true});
    });
    const mergedAssets = Array.from(mergedAssetMap.values()).filter((entry) => {
      const entryDocId = String(entry?.docId || "").trim();
      const assetPath = normalizeAssetPath((entry?.asset || entry)?.path || "");
      if (!assetPath) return false;
      if (staleAssetPaths.has(assetPath)) return false;
      if (!entryDocId) return true;
      return scopeDocSet.has(entryDocId);
    });
    return {
      docs: mergedDocs,
      assetEntries: mergedAssets,
    };
  }

  async saveExportRetryCacheForScope(scopeMeta, {scopeDigest = "", exportStamp = "", docs = [], assetEntries = []} = {}) {
    if (!this.hasNodeFs) return;
    const siteId = String(scopeMeta?.siteId || "").trim();
    const scopeKey = String(scopeMeta?.scopeKey || "").trim();
    if (!siteId || !scopeKey) return;
    const cacheDir = await this.getExportRetryCacheDirPath();
    if (!cacheDir) return;
    await fs.promises.mkdir(cacheDir, {recursive: true});
    const cacheKey = await this.buildExportRetryCacheKey(scopeMeta);
    const finalPaths = this.getExportRetryCachePaths(cacheKey, cacheDir);
    if (!finalPaths.metaPath || !finalPaths.docDir || !finalPaths.assetDir) return;
    const tempSuffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const tempKey = `${cacheKey}.tmp-${tempSuffix}`;
    const tempPaths = this.getExportRetryCachePaths(tempKey, cacheDir);
    const normalizedDocs = this.normalizeExportRetryDocs(docs);
    const normalizedAssets = this.normalizeExportRetryAssetEntries(assetEntries);
    const normalizedDigest = normalizeHashHex(scopeDigest);
    const normalizedExportStamp = normalizeDocUpdatedStamp(exportStamp) || formatDocUpdatedStampFromMs(nowTs());
    let totalBytes = 0;
    try {
      await safeRm(tempPaths.docDir).catch(() => {});
      await safeRm(tempPaths.assetDir).catch(() => {});
      await fs.promises.mkdir(tempPaths.docDir, {recursive: true});
      await fs.promises.mkdir(tempPaths.assetDir, {recursive: true});
      const docsMeta = [];
      let docSeq = 0;
      for (const doc of normalizedDocs) {
        const fileName = `${String(docSeq).padStart(6, "0")}.json`;
        docSeq += 1;
        const text = JSON.stringify(doc);
        await fs.promises.writeFile(joinFsPath(tempPaths.docDir, fileName), text);
        const bytes =
          typeof Buffer !== "undefined"
            ? Buffer.byteLength(text, "utf8")
            : encodeUtf8Bytes(text).length;
        totalBytes += Math.max(0, Number(bytes) || 0);
        docsMeta.push({
          docId: String(doc?.docId || "").trim(),
          file: fileName,
        });
      }
      const assetsMeta = [];
      let assetSeq = 0;
      for (const entry of normalizedAssets) {
        const asset = entry?.asset || entry;
        const assetPath = normalizeAssetPath(asset?.path || "");
        const blob = asset?.blob || null;
        if (!assetPath || !blob) continue;
        const fileName = `${String(assetSeq).padStart(6, "0")}.bin`;
        assetSeq += 1;
        const buf = await this.blobToNodeBuffer(blob);
        await fs.promises.writeFile(joinFsPath(tempPaths.assetDir, fileName), buf);
        const size = Math.max(0, Number(buf?.length || buf?.byteLength || 0));
        totalBytes += size;
        assetsMeta.push({
          path: assetPath,
          docId: String(entry?.docId || "").trim(),
          file: fileName,
          size,
        });
      }
      const payload = {
        version: EXPORT_RETRY_CACHE_VERSION,
        savedAt: nowTs(),
        exportStamp: normalizedExportStamp,
        scopeDigest: normalizedDigest,
        docs: docsMeta,
        assets: assetsMeta,
      };
      await fs.promises.writeFile(tempPaths.metaPath, JSON.stringify(payload));
      await fs.promises.unlink(finalPaths.metaPath).catch(() => {});
      await safeRm(finalPaths.docDir).catch(() => {});
      await safeRm(finalPaths.assetDir).catch(() => {});
      await fs.promises.rename(tempPaths.metaPath, finalPaths.metaPath);
      await fs.promises.rename(tempPaths.docDir, finalPaths.docDir);
      await fs.promises.rename(tempPaths.assetDir, finalPaths.assetDir);
      await this.setExportRetryCacheRecord(scopeMeta, {
        cacheKey,
        scopeDigest: normalizedDigest,
        exportStamp: normalizedExportStamp,
        savedAt: nowTs(),
        bytes: totalBytes,
        type: String(scopeMeta?.type || ""),
        targetId: String(scopeMeta?.targetId || ""),
        includeChildren: !!scopeMeta?.includeChildren,
      });
    } finally {
      await fs.promises.unlink(tempPaths.metaPath).catch(() => {});
      await safeRm(tempPaths.docDir).catch(() => {});
      await safeRm(tempPaths.assetDir).catch(() => {});
    }
  }

  getActiveSite() {
    const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
    const activeId = String(this.settings.activeSiteId || "");
    return sites.find((site) => site && String(site.id) === activeId) || sites[0] || null;
  }

  getSiteOptionLabel(site, index = 0) {
    if (!site) return `${this.t("siyuanShare.label.site")} ${index + 1}`;
    const name = this.resolveSiteName(site.name, site.siteUrl, index);
    const host = getUrlHost(site.siteUrl);
    if (host && host !== name) {
      return `${name} (${host})`;
    }
    return name || host || `${this.t("siyuanShare.label.site")} ${index + 1}`;
  }

  syncSettingInputs() {
    const {siteInput, apiKeyInput, envHint, siteSelect, siteNameInput, autoUpdateInput, quietWindowInput} = this.settingEls || {};
    if (siteInput) siteInput.value = this.settings.siteUrl || "";
    if (apiKeyInput) apiKeyInput.value = this.settings.apiKey || "";
    if (siteSelect) {
      const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
      const activeId = String(this.settings.activeSiteId || "");
      siteSelect.innerHTML = "";
      sites.forEach((site, index) => {
        const option = document.createElement("option");
        option.value = String(site.id || "");
        option.textContent = this.getSiteOptionLabel(site, index);
        siteSelect.appendChild(option);
      });
      if (activeId) {
        siteSelect.value = activeId;
      }
    }
    if (siteNameInput) {
      const active = this.getActiveSite();
      siteNameInput.value = active?.name || "";
    }
    if (autoUpdateInput) {
      const active = this.getActiveSite();
      autoUpdateInput.checked = !!active?.autoUpdateEnabled;
    }
    if (quietWindowInput) {
      const active = this.getActiveSite();
      const seconds = Number(active?.quietWindowSeconds);
      quietWindowInput.value = String(Math.max(30, Number.isFinite(seconds) && seconds > 0 ? seconds : 60));
    }
    if (envHint) {
      const t = this.t.bind(this);
      const base = normalizeUrlBase(this.settings.siteUrl);
      const hasKey = !!(this.settings.apiKey || "").trim();
      if (!base || !hasKey) {
        envHint.textContent = t("siyuanShare.hint.needSiteAndKey");
        return;
      }
      const displayName = this.remoteUser?.username || this.remoteUser?.name || "";
      const userLabel = displayName
        ? t("siyuanShare.hint.statusConnectedUser", {
            user: escapeHtml(displayName),
          })
        : t("siyuanShare.hint.statusConnectedNoUser");
      const timeLabel = this.remoteVerifiedAt
        ? t("siyuanShare.hint.lastVerifiedAt", {
            time: escapeHtml(this.formatTime(this.remoteVerifiedAt)),
          })
        : "";
      envHint.innerHTML = timeLabel ? `${userLabel} | ${timeLabel}` : userLabel;
    }
  }

  persistCurrentSiteInputs() {
    const {siteInput, apiKeyInput, siteNameInput, autoUpdateInput, quietWindowInput} = this.settingEls || {};
    const siteUrl = (siteInput?.value || "").trim();
    const apiKey = (apiKeyInput?.value || "").trim();
    const siteName = (siteNameInput?.value || "").trim();
    const autoUpdateEnabled = !!autoUpdateInput?.checked;
    const quietWindowRaw = Number(quietWindowInput?.value);
    const quietWindowSeconds = Math.max(30, Number.isFinite(quietWindowRaw) && quietWindowRaw > 0 ? Math.floor(quietWindowRaw) : 60);
    let sites = this.normalizeSiteList(this.settings.sites);
    let activeSiteId = String(this.settings.activeSiteId || "");
    let activeSite = sites.find((site) => String(site.id) === activeSiteId);
    const prevSiteUrl = activeSite?.siteUrl || "";
    const prevApiKey = activeSite?.apiKey || "";
    if (!activeSite && (siteUrl || apiKey || siteName)) {
      activeSiteId = activeSiteId || randomSlug(10);
      activeSite = {
        id: activeSiteId,
        name: this.resolveSiteName(siteName, siteUrl, sites.length),
        siteUrl,
        apiKey,
        autoUpdateEnabled,
        quietWindowSeconds,
        remoteUser: null,
        remoteVerifiedAt: 0,
        remoteFeatures: null,
      };
      sites.push(activeSite);
    } else if (activeSite) {
      activeSite.siteUrl = siteUrl;
      activeSite.apiKey = apiKey;
      activeSite.autoUpdateEnabled = autoUpdateEnabled;
      activeSite.quietWindowSeconds = quietWindowSeconds;
      activeSite.name = this.resolveSiteName(siteName || activeSite.name, siteUrl, sites.indexOf(activeSite));
      if (prevSiteUrl !== siteUrl || prevApiKey !== apiKey) {
        activeSite.remoteUser = null;
        activeSite.remoteVerifiedAt = 0;
        activeSite.remoteFeatures = null;
        this.remoteUploadLimits = null;
        this.remoteFeatures = null;
        this.stopAutoUpdate({clearState: false, preservePendingOnPause: true});
      }
    }
    this.settings = {
      ...this.settings,
      siteUrl,
      apiKey,
      sites,
      activeSiteId,
    };
    this.syncRemoteStatusFromSite(activeSite);
    return {siteUrl, apiKey, siteName, autoUpdateEnabled, sites, activeSiteId};
  }

  async applyActiveSite(siteId, {persist = true} = {}) {
    // Capture in-flight auto-update share into queue before persisting,
    // so it is not lost when switching sites
    const inFlightShareId = String(this.autoUpdateCurrentShareId || "").trim();
    if (inFlightShareId && !this.autoUpdateQueuedSet.has(inFlightShareId)) {
      this.autoUpdateQueue.unshift(inFlightShareId);
      this.autoUpdateQueuedSet.add(inFlightShareId);
    }
    await this.flushAutoUpdateRuntimePersist();
    this.stopAutoUpdate({clearState: true});
    const sites = this.normalizeSiteList(this.settings.sites);
    const next = sites.find((site) => String(site.id) === String(siteId)) || sites[0] || null;
    const activeSiteId = next ? String(next.id) : "";
    this.settings = {
      ...this.settings,
      sites,
      activeSiteId,
      siteUrl: next?.siteUrl || "",
      apiKey: next?.apiKey || "",
    };
    this.syncRemoteStatusFromSite(next);
    this.remoteUploadLimits = null;
    this.shares = Array.isArray(this.siteShares?.[activeSiteId]) ? this.siteShares[activeSiteId] : [];
    this.restoreAutoUpdateRuntimeForSite(activeSiteId);
    if (persist) {
      await this.saveData(STORAGE_SETTINGS, this.settings);
    }
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.updateTopBarState();
    this.refreshAutoUpdateLoop({immediate: true});
  }

  saveSettingsFromSetting = async ({notify = true} = {}) => {
    const t = this.t.bind(this);
    this.persistCurrentSiteInputs();
    this.shares = Array.isArray(this.siteShares?.[this.settings.activeSiteId])
      ? this.siteShares[this.settings.activeSiteId]
      : [];
    await this.saveData(STORAGE_SETTINGS, this.settings);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      this.shares = [];
      if (this.settings.activeSiteId) {
        this.siteShares[this.settings.activeSiteId] = [];
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
    }
    this.renderDock();
    this.renderSettingShares();
    this.syncSettingInputs();
    this.refreshAutoUpdateLoop({immediate: true});
    if (notify) this.notify(t("siyuanShare.message.disconnected"));
  };

  onSiteSelectChange = (event) => {
    const nextId = String(event?.target?.value || "");
    if (!nextId || String(this.settings.activeSiteId || "") === nextId) return;
    void (async () => {
      try {
        this.persistCurrentSiteInputs();
        await this.applyActiveSite(nextId, {persist: false});
        await this.saveData(STORAGE_SETTINGS, this.settings);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  confirmEnableAutoUpdate = async () => {
    const t = this.t.bind(this);
    return new Promise((resolve) => {
      let settled = false;
      let dialog = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(!!value);
      };
      const content = `<div class="b3-dialog__content sps-auto-update-confirm-dialog">${escapeHtml(
        t("siyuanShare.confirm.enableAutoUpdateMessage"),
      )}</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--text" data-action="confirm">${escapeHtml(t("siyuanShare.action.confirm"))}</button>
</div>`;
      const onClick = (event) => {
        const btn = event.target?.closest?.("[data-action='confirm']");
        if (!btn) return;
        settle(true);
        try {
          dialog?.destroy();
        } catch {
          // ignore
        }
      };
      dialog = new Dialog({
        title: t("siyuanShare.confirm.enableAutoUpdateTitle"),
        content,
        width: "min(520px, 92vw)",
        destroyCallback: () => {
          dialog?.element?.removeEventListener?.("click", onClick);
          if (!settled) {
            settle(false);
          }
        },
      });
      dialog?.element?.addEventListener?.("click", onClick);
    });
  };

  onSettingAutoUpdateToggleChange = () => {
    void (async () => {
      try {
        const active = this.getActiveSite();
        const prevEnabled = !!active?.autoUpdateEnabled;
        const nextEnabled = !!this.settingEls?.autoUpdateInput?.checked;
        if (nextEnabled && !prevEnabled) {
          const confirmed = await this.confirmEnableAutoUpdate();
          if (!confirmed) {
            if (this.settingEls?.autoUpdateInput) {
              this.settingEls.autoUpdateInput.checked = prevEnabled;
            }
            return;
          }
        }
        this.persistCurrentSiteInputs();
        await this.saveData(STORAGE_SETTINGS, this.settings);
        this.refreshAutoUpdateLoop({immediate: true});
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingQuietWindowChange = () => {
    void (async () => {
      try {
        this.persistCurrentSiteInputs();
        await this.saveData(STORAGE_SETTINGS, this.settings);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onDockChange = (event) => {
    const target = event.target;
    if (!target || target.id !== "sps-site-select") return;
    const nextId = String(target.value || "");
    if (!nextId || String(this.settings.activeSiteId || "") === nextId) return;
    void (async () => {
      try {
        const siteUrl = this.getInputValue("sps-site").trim();
        const apiKey = this.getInputValue("sps-apikey").trim();
        let sites = this.normalizeSiteList(this.settings.sites);
        let activeSiteId = String(this.settings.activeSiteId || "");
        let activeSite = sites.find((site) => String(site.id) === activeSiteId);
        const prevSiteUrl = activeSite?.siteUrl || "";
        const prevApiKey = activeSite?.apiKey || "";
        if (!activeSite && (siteUrl || apiKey)) {
          activeSiteId = activeSiteId || randomSlug(10);
          activeSite = {
            id: activeSiteId,
            name: this.resolveSiteName("", siteUrl, sites.length),
            siteUrl,
            apiKey,
            autoUpdateEnabled: false,
            quietWindowSeconds: 60,
            remoteUser: null,
            remoteVerifiedAt: 0,
            remoteFeatures: null,
          };
          sites.push(activeSite);
        } else if (activeSite) {
          activeSite.siteUrl = siteUrl;
          activeSite.apiKey = apiKey;
          activeSite.name = this.resolveSiteName(activeSite.name, siteUrl, sites.indexOf(activeSite));
          if (prevSiteUrl !== siteUrl || prevApiKey !== apiKey) {
            activeSite.remoteUser = null;
            activeSite.remoteVerifiedAt = 0;
            activeSite.remoteFeatures = null;
            this.remoteUploadLimits = null;
            this.remoteFeatures = null;
            this.stopAutoUpdate({clearState: false, preservePendingOnPause: true});
          }
        }
        this.settings = {
          ...this.settings,
          sites,
          siteUrl,
          apiKey,
          activeSiteId,
        };
        this.syncRemoteStatusFromSite(activeSite);
        await this.applyActiveSite(nextId, {persist: true});
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingSitesClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;
    void (async () => {
      try {
        if (action === "site-add") {
          this.persistCurrentSiteInputs();
          // Persist old site's auto-update runtime before switching
          await this.flushAutoUpdateRuntimePersist();
          this.stopAutoUpdate({clearState: true});
          const sites = this.normalizeSiteList(this.settings.sites);
          const newSiteId = randomSlug(10);
          const newSite = {
            id: newSiteId,
            name: this.resolveSiteName("", "", sites.length),
            siteUrl: "",
            apiKey: "",
            autoUpdateEnabled: false,
            quietWindowSeconds: 60,
            remoteUser: null,
            remoteVerifiedAt: 0,
            remoteFeatures: null,
          };
          sites.push(newSite);
          this.settings = {
            ...this.settings,
            sites,
            activeSiteId: newSiteId,
            siteUrl: "",
            apiKey: "",
          };
          this.siteShares[newSiteId] = this.siteShares[newSiteId] || [];
          this.shares = this.siteShares[newSiteId];
          this.remoteUser = null;
          this.remoteVerifiedAt = 0;
          this.remoteFeatures = null;
          this.remoteUploadLimits = null;
          await this.saveData(STORAGE_SETTINGS, this.settings);
          await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
          this.syncSettingInputs();
          this.renderDock();
          this.renderSettingCurrent();
          this.renderSettingShares();
          this.updateTopBarState();
          this.refreshAutoUpdateLoop({immediate: true});
          return;
        }
        if (action === "site-remove") {
          const activeId = String(this.settings.activeSiteId || "");
          if (!activeId) return;
          await this.flushAutoUpdateRuntimePersist();
          this.stopAutoUpdate({clearState: true});
          const sites = this.normalizeSiteList(this.settings.sites).filter(
            (site) => String(site.id) !== activeId,
          );
          const autoUpdateScanStampBySite = this.normalizeAutoUpdateScanStampBySite(
            this.settings.autoUpdateScanStampBySite || {},
          );
          if (Object.prototype.hasOwnProperty.call(autoUpdateScanStampBySite, activeId)) {
            delete autoUpdateScanStampBySite[activeId];
          }
          if (this.siteShares?.[activeId]) {
            delete this.siteShares[activeId];
          }
          await this.removeAutoUpdateRuntimeForSite(activeId);
          const nextSite = sites[0] || null;
          this.settings = {
            ...this.settings,
            sites,
            activeSiteId: nextSite?.id || "",
            siteUrl: nextSite?.siteUrl || "",
            apiKey: nextSite?.apiKey || "",
            autoUpdateScanStampBySite,
          };
          this.shares = nextSite?.id && this.siteShares?.[nextSite.id] ? this.siteShares[nextSite.id] : [];
          this.syncRemoteStatusFromSite(nextSite);
          this.remoteUploadLimits = null;
          if (nextSite?.id) {
            this.restoreAutoUpdateRuntimeForSite(nextSite.id);
          }
          await this.saveData(STORAGE_SETTINGS, this.settings);
          await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
          this.syncSettingInputs();
          this.renderDock();
          this.renderSettingCurrent();
          this.renderSettingShares();
          this.updateTopBarState();
          this.refreshAutoUpdateLoop({immediate: true});
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingActionsClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        if (action === "settings-sync") {
          await this.saveSettingsFromSetting({notify: false});
          await this.trySyncRemoteShares({silent: false});
          return;
        }
        if (action === "settings-disconnect") {
          await this.disconnectRemote();
          return;
        }
        if (action === "settings-auto-update-status") {
          this.openAutoUpdateStatusDialog();
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingCurrentClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        const t = this.t.bind(this);
        const docId = this.currentDoc.id;
        if (!isValidDocId(docId)) throw new Error(t("siyuanShare.message.noCurrentDoc"));

        if (action === "show-qr") {
          const qrUrl = btn.getAttribute("data-url");
          if (qrUrl) this.showQRCodeDialog(qrUrl);
          return;
        }
        const share = this.getShareByDocId(docId);
        if (!share) throw new Error(t("siyuanShare.message.currentDocNoShare"));
        if (action === "copy-link") return await this.copyShareLink(share.id);
        if (action === "update") return await this.updateShare(share.id);
        if (action === "update-access") {
          await this.openShareDialogFor({type: SHARE_TYPES.DOC, id: docId});
          return;
        }
        if (action === "delete") return await this.deleteShare(share.id);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingSharesClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;
    if (action === "show-qr") {
      const qrUrl = btn.getAttribute("data-url");
      if (qrUrl) this.showQRCodeDialog(qrUrl);
      return;
    }
    const shareId = btn.getAttribute("data-share-id");
    if (!shareId) return;
    void (async () => {
      try {
        if (action === "copy-link") return await this.copyShareLink(shareId);
        if (action === "copy-info") return await this.copyShareInfo(shareId);
        if (action === "update") return await this.updateShare(shareId);
        if (action === "update-access") {
          const share = this.getShareById(shareId);
          if (!share) throw new Error(this.t("siyuanShare.error.shareNotFound"));
          const itemId = share.type === SHARE_TYPES.NOTEBOOK ? share.notebookId : share.docId;
          await this.openShareDialogFor({type: share.type, id: itemId, title: share.title || ""});
          return;
        }
        if (action === "delete") return await this.deleteShare(shareId);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  renderSettingCurrent() {
    const wrap = this.settingEls?.currentWrap;
    if (!wrap) return;

    const t = this.t.bind(this);
    const docId = this.currentDoc.id;
    if (!isValidDocId(docId)) {
      wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.message.noCurrentDoc"))}</div>
</div>`;
      return;
    }

    const title = this.currentDoc.title || t("siyuanShare.label.untitledDoc");
    const share = this.getShareByDocId(docId);
    const url = share ? this.getShareUrl(share) : "";
    const passwordLabel = share?.hasPassword
      ? t("siyuanShare.label.passwordSet")
      : t("siyuanShare.label.passwordNotSet");
    const expiresLabel = share?.expiresAt ? this.formatTime(share.expiresAt) : t("siyuanShare.label.expiresNotSet");
    const visitorLimitValue = Number(share?.visitorLimit) || 0;
    const visitorLabel =
      visitorLimitValue > 0
        ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
        : t("siyuanShare.label.visitorLimitNotSet");
    wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    share ? t("siyuanShare.label.sharedDoc") : t("siyuanShare.label.unsharedDoc"),
  )}</div>
  <div>${escapeHtml(title)}</div>
  <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(
    t("siyuanShare.label.id"),
  )}: ${escapeHtml(docId)}</div>
  ${
    share
      ? `<div class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.label.shareId"),
        )}: <span class="siyuan-plugin-share__mono">${escapeHtml(
          share.slug || "",
        )}</span> | ${escapeHtml(t("siyuanShare.label.updatedAt"))}: ${escapeHtml(
          this.formatTime(share.updatedAt),
        )}</div>
  <div class="siyuan-plugin-share__muted">${escapeHtml(
          passwordLabel,
        )} | ${escapeHtml(expiresLabel)} | ${escapeHtml(visitorLabel)}</div>
  <div class="siyuan-plugin-share__actions" style="align-items: center;">
    <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
    <span class="sps-qr-btn" data-action="show-qr" data-url="${escapeAttr(url)}" title="${escapeAttr(t("siyuanShare.qr.title"))}">${SPS_QR_ICON_SVG}</span>
    <button class="b3-button b3-button--outline" data-action="copy-link">${escapeHtml(
      t("siyuanShare.action.copyLink"),
    )}</button>
  </div>
  <div class="siyuan-plugin-share__actions">
    <button class="b3-button b3-button--outline" data-action="update">${escapeHtml(
      t("siyuanShare.action.updateShare"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="update-access">${escapeHtml(
      t("siyuanShare.action.updateAccess"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="delete">${escapeHtml(
      t("siyuanShare.action.deleteShare"),
    )}</button>
  </div>`
      : `<div class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.message.currentDocNoShare"),
        )}</div>`
  }
</div>`;
  }

  renderSettingShares() {
    const wrap = this.settingEls?.sharesWrap;
    if (!wrap) return;
    const t = this.t.bind(this);
    const items = this.shares
      .map((s) => {
        const url = this.getShareUrl(s);
        const isCurrent = s.type === SHARE_TYPES.DOC && s.docId === this.currentDoc.id;
        const typeLabel =
          s.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
        const idLabel = s.type === SHARE_TYPES.NOTEBOOK ? s.notebookId : s.docId;
        const passwordLabel = s.hasPassword ? t("siyuanShare.label.passwordYes") : t("siyuanShare.label.passwordNo");
        const expiresLabel = s.expiresAt ? this.formatTime(s.expiresAt) : t("siyuanShare.label.expiresNotSet");
        const visitorLimitValue = Number(s.visitorLimit) || 0;
        const visitorLabel =
          visitorLimitValue > 0
            ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
            : t("siyuanShare.label.visitorLimitNotSet");
        return `<div class="sps-share-item ${isCurrent ? "sps-share-item--current" : ""}">
  <div class="sps-share-item__main">
    <div class="sps-share-item__title" title="${escapeAttr(s.title || "")}">${escapeHtml(
          s.title || t("siyuanShare.label.untitled"),
        )}</div>
    <div class="sps-share-item__meta">
      <span class="siyuan-plugin-share__mono" title="${escapeAttr(
          t("siyuanShare.label.shareId"),
        )}">${escapeHtml(s.slug || "")}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.type"),
        )}">${escapeHtml(typeLabel)}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.updatedAt"),
        )}">${escapeHtml(
          this.formatTime(s.updatedAt),
        )}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.accessSettings"),
        )}">${escapeHtml(
          passwordLabel,
        )} | ${escapeHtml(expiresLabel)} | ${escapeHtml(visitorLabel)}</span>
      <span class="siyuan-plugin-share__muted siyuan-plugin-share__mono" title="${escapeAttr(
          t("siyuanShare.label.id"),
        )}">${escapeHtml(
          idLabel || "",
        )}</span>
    </div>
    <div class="sps-share-item__link">
      <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
      <span class="sps-qr-btn" data-action="show-qr" data-url="${escapeAttr(url)}" title="${escapeAttr(t("siyuanShare.qr.title"))}">${SPS_QR_ICON_SVG}</span>
      <button class="b3-button b3-button--outline" data-action="copy-link" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
      <button class="b3-button b3-button--outline" data-action="copy-info" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyShareInfo"))}</button>
    </div>
  </div>
  <div class="sps-share-item__actions">
    <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateShare"))}</button>
    <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
    <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.deleteShare"))}</button>
  </div>
</div>`;
      })
      .join("");

    wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    t("siyuanShare.title.shareListCount", {count: this.shares.length}),
  )}</div>
  <div class="sps-share-list">
    ${items || `<div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.message.noShareRecords"))}</div>`}
  </div>
</div>`;
  }


  async saveSettingsFromUI() {
    const siteUrl = this.getInputValue("sps-site").trim();
    const apiKey = this.getInputValue("sps-apikey").trim();
    const siteSelectId = this.getInputValue("sps-site-select").trim();
    let sites = this.normalizeSiteList(this.settings.sites);
    let activeSiteId = siteSelectId || String(this.settings.activeSiteId || "");
    let activeSite = sites.find((site) => String(site.id) === activeSiteId);
    const prevSiteUrl = activeSite?.siteUrl || "";
    const prevApiKey = activeSite?.apiKey || "";
    if (!activeSite && (siteUrl || apiKey)) {
      activeSiteId = activeSiteId || randomSlug(10);
      activeSite = {
        id: activeSiteId,
        name: this.resolveSiteName("", siteUrl, sites.length),
        siteUrl,
        apiKey,
        autoUpdateEnabled: false,
        quietWindowSeconds: 60,
        remoteUser: null,
        remoteVerifiedAt: 0,
        remoteFeatures: null,
      };
      sites.push(activeSite);
    } else if (activeSite) {
      activeSite.siteUrl = siteUrl;
      activeSite.apiKey = apiKey;
      activeSite.name = this.resolveSiteName(activeSite.name, siteUrl, sites.indexOf(activeSite));
      if (prevSiteUrl !== siteUrl || prevApiKey !== apiKey) {
        activeSite.remoteUser = null;
        activeSite.remoteVerifiedAt = 0;
        activeSite.remoteFeatures = null;
        this.remoteUploadLimits = null;
        this.remoteFeatures = null;
        this.stopAutoUpdate({clearState: false, preservePendingOnPause: true});
      }
    }
    this.settings = {
      ...this.settings,
      siteUrl,
      apiKey,
      sites,
      activeSiteId,
    };
    this.shares = Array.isArray(this.siteShares?.[activeSiteId]) ? this.siteShares[activeSiteId] : [];
    await this.saveData(STORAGE_SETTINGS, this.settings);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      this.shares = [];
      if (activeSiteId) {
        this.siteShares[activeSiteId] = [];
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
      this.remoteUser = null;
      this.remoteVerifiedAt = 0;
      this.remoteFeatures = null;
      this.remoteUploadLimits = null;
    }
    this.syncRemoteStatusFromSite(activeSite);
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingShares();
    this.updateTopBarState();
    this.refreshAutoUpdateLoop({immediate: true});
  }

  getInputValue(id) {
    if (!this.dockElement) return "";
    const el = this.dockElement.querySelector(`#${CSS.escape(id)}`);
    if (!el) return "";
    return el.value || "";
  }

  openShareDock() {
    try {
      this.openSetting();
      setTimeout(() => this.applySettingWideLayout(), 80);
    } catch (err) {
      console.error(err);
      this.notify(this.t("siyuanShare.message.openSharePanelFailed"));
    }
  }

  getUploadConcurrency() {
    return {
      asset: normalizePositiveInt(
        this.settings.uploadAssetConcurrency,
        DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      ),
      chunk: normalizePositiveInt(
        this.settings.uploadChunkConcurrency,
        DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      ),
    };
  }

  normalizeUploadLimits(raw) {
    if (!raw || typeof raw !== "object") return null;
    const min = normalizePositiveInt(raw.minChunkSize, UPLOAD_CHUNK_MIN_SIZE);
    const max = normalizePositiveInt(raw.maxChunkSize, UPLOAD_CHUNK_MAX_SIZE);
    const safeMin = Math.max(1, Math.min(min, max));
    const cappedMax = Math.min(max, UPLOAD_CHUNK_HARD_MAX_SIZE);
    const safeMax = Math.max(safeMin, cappedMax);
    return {minChunkSize: safeMin, maxChunkSize: safeMax};
  }

  getUploadChunkLimits() {
    const remote = this.remoteUploadLimits || {};
    const min = normalizePositiveInt(remote.minChunkSize, UPLOAD_CHUNK_MIN_SIZE);
    const max = normalizePositiveInt(remote.maxChunkSize, UPLOAD_CHUNK_MAX_SIZE);
    const safeMin = Math.max(1, Math.min(min, max));
    const cappedMax = Math.min(max, UPLOAD_CHUNK_HARD_MAX_SIZE);
    const safeMax = Math.max(safeMin, cappedMax);
    return {min: safeMin, max: safeMax};
  }

  getUploadSpeedBps() {
    const speed = this.uploadTuner?.avgSpeed;
    if (Number.isFinite(speed) && speed > 0) return speed;
    return UPLOAD_DEFAULT_SPEED_BPS;
  }

  updateUploadSpeed(bytes, ms) {
    const size = Number(bytes);
    const elapsed = Number(ms);
    if (!Number.isFinite(size) || !Number.isFinite(elapsed) || size <= 0 || elapsed <= 0) return;
    const speed = (size / elapsed) * 1000;
    const tuner = this.uploadTuner || {avgSpeed: 0, samples: 0};
    const alpha = 0.2;
    tuner.avgSpeed = tuner.avgSpeed ? tuner.avgSpeed * (1 - alpha) + speed * alpha : speed;
    tuner.samples = (tuner.samples || 0) + 1;
    this.uploadTuner = tuner;
  }

  getAdaptiveAssetConcurrency(totalBytes, totalAssets, maxConcurrency, sizes = []) {
    const limit = normalizePositiveInt(maxConcurrency, DEFAULT_UPLOAD_ASSET_CONCURRENCY);
    const total = Math.max(1, Number(totalAssets) || 1);
    if (total <= 1) return 1;
    const size = Number(totalBytes);
    const avgSize = Number.isFinite(size) && total > 0 ? size / total : 0;
    const speed = this.getUploadSpeedBps();
    let concurrency = 1;
    if (total >= 100) {
      concurrency = 8;
    } else if (total >= 50) {
      concurrency = 6;
    } else if (total >= 20) {
      concurrency = 4;
    } else if (total >= 10) {
      concurrency = 3;
    } else if (total >= 4) {
      concurrency = 2;
    }
    const filteredSizes = Array.isArray(sizes) ? sizes.filter((s) => Number.isFinite(s) && s > 0) : [];
    if (filteredSizes.length > 0) {
      const sorted = filteredSizes.slice().sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p90 = sorted[Math.floor(sorted.length * 0.9)] || mid;
      const max = sorted[sorted.length - 1] || mid;
      if (mid > 0) {
        if (mid <= 128 * 1024) {
          concurrency = Math.max(concurrency, 8);
        } else if (mid <= 256 * 1024) {
          concurrency = Math.max(concurrency, 6);
        } else if (mid <= 512 * 1024) {
          concurrency = Math.max(concurrency, 4);
        } else if (mid <= 2 * MB) {
          concurrency = Math.max(concurrency, 3);
        } else if (mid <= 8 * MB) {
          concurrency = Math.max(concurrency, 2);
        }
      }
      if (p90 >= 32 * MB) {
        concurrency = Math.min(concurrency, 3);
      }
      if (max >= 64 * MB) {
        concurrency = Math.min(concurrency, 2);
      }
      if (max >= 128 * MB) {
        concurrency = 1;
      }
    } else if (avgSize > 0) {
      if (avgSize <= 512 * 1024) {
        concurrency = Math.max(concurrency, 4);
      } else if (avgSize <= 2 * MB) {
        concurrency = Math.max(concurrency, 3);
      } else if (avgSize <= 8 * MB) {
        concurrency = Math.max(concurrency, 2);
      }
      if (avgSize >= 128 * MB) {
        concurrency = Math.min(concurrency, 1);
      } else if (avgSize >= 64 * MB) {
        concurrency = Math.min(concurrency, 2);
      }
    }
    if (speed >= 12 * MB) {
      concurrency = Math.max(concurrency, 6);
    } else if (speed >= 8 * MB) {
      concurrency = Math.max(concurrency, 5);
    } else if (speed >= 4 * MB) {
      concurrency = Math.max(concurrency, 4);
    } else if (speed >= 2 * MB) {
      concurrency = Math.max(concurrency, 3);
    }
    return Math.min(limit, concurrency, total);
  }

  getAdaptiveChunkSize(sizeBytes) {
    const size = Number(sizeBytes) || 0;
    const {min, max} = this.getUploadChunkLimits();
    if (size > 0 && size <= min) return size;
    const speed = this.getUploadSpeedBps();
    let chunkSize = Math.round((speed * UPLOAD_TARGET_CHUNK_MS) / 1000);
    let sizeHint = 0;
    if (size >= 1024 * MB) {
      sizeHint = max;
    } else if (size >= 512 * MB) {
      sizeHint = Math.min(max, 6 * MB);
    } else if (size >= 256 * MB) {
      sizeHint = Math.min(max, 4 * MB);
    } else if (size >= 128 * MB) {
      sizeHint = Math.min(max, 3 * MB);
    } else if (size >= 64 * MB) {
      sizeHint = Math.min(max, 2 * MB);
    } else if (size >= 16 * MB) {
      sizeHint = Math.min(max, 1 * MB);
    } else if (size >= 4 * MB) {
      sizeHint = Math.min(max, Math.max(min, 512 * 1024));
    }
    chunkSize = Math.max(chunkSize, sizeHint);
    chunkSize = Math.max(min, Math.min(max, chunkSize));
    if (size > 0 && chunkSize > size) {
      chunkSize = size;
    }
    return chunkSize;
  }

  getAdaptiveChunkConcurrency(sizeBytes, chunkSize, maxConcurrency) {
    const size = Number(sizeBytes) || 0;
    const chunk = Math.max(1, Number(chunkSize) || 1);
    const totalChunks = Math.max(1, Math.ceil(size / chunk));
    const limit = normalizePositiveInt(maxConcurrency, DEFAULT_UPLOAD_CHUNK_CONCURRENCY);
    const speed = this.getUploadSpeedBps();
    let concurrency = 1;
    if (speed >= 10 * MB) {
      concurrency = 4;
    } else if (speed >= 6 * MB) {
      concurrency = 3;
    } else if (speed >= 2.5 * MB) {
      concurrency = 2;
    }
    if (size >= 512 * MB) {
      concurrency = Math.max(concurrency, 4);
    } else if (size >= 256 * MB) {
      concurrency = Math.max(concurrency, 3);
    } else if (size >= 128 * MB) {
      concurrency = Math.max(concurrency, 2);
    }
    if (totalChunks <= 2) {
      concurrency = 1;
    } else if (totalChunks <= 4) {
      concurrency = Math.min(concurrency, 2);
    }
    return Math.min(limit, concurrency, totalChunks);
  }

  getDocExportConcurrency(totalDocs = 0) {
    const total = Math.max(0, Math.floor(Number(totalDocs) || 0));
    if (total <= 1) return 1;
    const cpu = normalizePositiveInt(globalThis?.navigator?.hardwareConcurrency, 0);
    let concurrency = DEFAULT_DOC_EXPORT_CONCURRENCY;
    if (cpu > 0 && cpu <= 3) {
      concurrency = 2;
    } else if (cpu > 0 && cpu <= 5) {
      concurrency = 3;
    }
    return Math.max(1, Math.min(4, total, concurrency));
  }

  getPrepareAssetsConcurrency(totalAssets = 0, maxConcurrency = DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY) {
    const total = Math.max(0, Math.floor(Number(totalAssets) || 0));
    if (total <= 1) return 1;
    const cpu = normalizePositiveInt(globalThis?.navigator?.hardwareConcurrency, 0);
    let concurrency = normalizePositiveInt(maxConcurrency, DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY);
    if (cpu > 0 && cpu <= 3) {
      concurrency = Math.min(concurrency, 2);
    }
    return Math.max(1, Math.min(concurrency, total));
  }

  async collectDocExportResults(docs, notebookId, {controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    const list = (Array.isArray(docs) ? docs : []).filter((doc) => isValidDocId(String(doc?.docId || "")));
    if (list.length === 0) return [];
    const total = list.length;
    const concurrency = this.getDocExportConcurrency(total);
    const perDocAssetConcurrency = concurrency >= 4 ? 2 : 3;
    const results = new Array(total);
    const docProgress = new Array(total).fill(0);
    const reportProgress = (docIndex, ratio) => {
      if (!progress?.update) return;
      if (docIndex < 0 || docIndex >= total) return;
      const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
      if (clamped <= docProgress[docIndex]) return;
      docProgress[docIndex] = clamped;
      const sum = docProgress.reduce((acc, value) => acc + value, 0);
      const percent = total > 0 ? (sum / total) * 100 : 0;
      const completed = docProgress.filter((value) => value >= 1).length;
      const currentIndex = Math.max(1, Math.min(total, completed + 1));
      progress.update({
        text: t("siyuanShare.progress.exportingDoc", {index: currentIndex, total}),
        percent,
      });
    };
    reportProgress(0, 0.01);
    const tasks = list.map((doc, index) => async () => {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      reportProgress(index, 0.05);
      const exportRes = await this.exportDocMarkdown(String(doc.docId || ""));
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      reportProgress(index, 0.35);
      const prepared = await this.prepareMarkdownAssets(exportRes.content || "", controller, notebookId, {
        concurrency: perDocAssetConcurrency,
        onProgress: ({current = 0, total: assetTotal = 0} = {}) => {
          const totalCount = Math.max(1, Math.floor(Number(assetTotal) || 0));
          const doneCount = Math.max(0, Math.min(totalCount, Math.floor(Number(current) || 0)));
          reportProgress(index, 0.35 + (doneCount / totalCount) * 0.6);
        },
      });
      results[index] = {
        doc,
        index,
        exportRes,
        markdown: prepared.markdown,
        assets: prepared.assets,
        failures: prepared.failures,
      };
      reportProgress(index, 1);
    });
    try {
      await runTasksWithConcurrency(tasks, concurrency);
    } catch (err) {
      if (!isAbortError(err) && controller && !controller.signal?.aborted) {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }
      throw err;
    }
    return results.filter(Boolean);
  }

  formatUploadDetail(uploaded, total, assetDone = null, assetTotal = null) {
    const hasAssets = Number.isFinite(assetDone) && Number.isFinite(assetTotal) && assetTotal > 0;
    if (hasAssets) {
      return this.t("siyuanShare.progress.uploadedAssetsBytes", {
        current: Math.min(assetTotal, Math.max(0, Math.floor(assetDone))),
        total: Math.max(1, Math.floor(assetTotal)),
        bytesCurrent: formatBytes(uploaded),
        bytesTotal: formatBytes(total),
      });
    }
    return this.t("siyuanShare.progress.uploadedBytes", {
      current: formatBytes(uploaded),
      total: formatBytes(total),
    });
  }

  getUploadPercent(tracker) {
    if (!tracker) return null;
    const hasAssets = Number.isFinite(tracker.totalAssets) && tracker.totalAssets > 0;
    const hasBytes = Number.isFinite(tracker.totalBytes) && tracker.totalBytes > 0;
    const assetPercent = hasAssets ? (tracker.completedAssets / tracker.totalAssets) * 100 : 0;
    const bytePercent = hasBytes ? (tracker.uploadedBytes / tracker.totalBytes) * 100 : 0;
    if (hasBytes) {
      let percent = bytePercent;
      if (hasAssets && tracker.completedAssets < tracker.totalAssets && percent >= 100) {
        percent = 99;
      }
      return percent;
    }
    if (hasAssets) return assetPercent;
    return null;
  }

  normalizeShareSlugOverrideOrThrow(slugOverride, {allowEmpty = true} = {}) {
    const t = this.t.bind(this);
    const result = getShareSlugValidationResult(slugOverride, {allowEmpty});
    if (result.ok) return result.value;
    if (result.reason === "chars") {
      throw new Error(t("siyuanShare.error.shareSlugInvalidChars"));
    }
    if (result.reason === "length") {
      throw new Error(
        t("siyuanShare.error.shareSlugInvalidLength", {
          min: SHARE_SLUG_MIN_LENGTH,
          max: SHARE_SLUG_MAX_LENGTH,
        }),
      );
    }
    throw new Error(t("siyuanShare.error.shareSlugInvalidChars"));
  }

  resolveRemoteErrorMessage(response, status) {
    const t = this.t.bind(this);
    const errorKey = String(response?.data?.errorKey || response?.errorKey || "").trim();
    if (errorKey === "share.slug.conflict") {
      return t("siyuanShare.error.shareSlugConflict");
    }
    if (errorKey === "share.slug.invalid_chars") {
      return t("siyuanShare.error.shareSlugInvalidChars");
    }
    if (errorKey === "share.slug.invalid_length") {
      const min = Number(response?.data?.min);
      const max = Number(response?.data?.max);
      return t("siyuanShare.error.shareSlugInvalidLength", {
        min: Number.isFinite(min) && min > 0 ? Math.floor(min) : SHARE_SLUG_MIN_LENGTH,
        max: Number.isFinite(max) && max > 0 ? Math.floor(max) : SHARE_SLUG_MAX_LENGTH,
      });
    }
    if (errorKey === "share.slug.generate_failed") {
      return t("siyuanShare.error.shareSlugGenerateFailed");
    }
    return response?.msg || t("siyuanShare.error.remoteRequestFailed", {status});
  }

  supportsIncrementalShare() {
    return !!this.remoteFeatures?.incrementalShare;
  }

  supportsDocChunkUpload() {
    return !!this.remoteFeatures?.docChunkUpload;
  }

  buildDocChunkPath(docId, index = 0, usedPaths = null) {
    const safeId = String(docId || "")
      .replace(/[^0-9a-zA-Z_-]/g, "")
      .trim();
    const base = safeId || `doc-${index}`;
    let candidate = `${DOC_CHUNK_UPLOAD_PREFIX}/${base}.md`;
    if (usedPaths && usedPaths.has(candidate)) {
      let seq = 1;
      candidate = `${DOC_CHUNK_UPLOAD_PREFIX}/${base}-${seq}.md`;
      while (usedPaths.has(candidate)) {
        seq += 1;
        candidate = `${DOC_CHUNK_UPLOAD_PREFIX}/${base}-${seq}.md`;
      }
    }
    usedPaths?.add(candidate);
    return candidate;
  }

  buildDocChunkUploadPlan(payload) {
    const metadata = payload && typeof payload === "object" ? {...payload} : {};
    const hasDocsField = Object.prototype.hasOwnProperty.call(metadata, "docs");
    const sourceDocs = hasDocsField ? (Array.isArray(metadata.docs) ? metadata.docs : []) : null;
    const docs = [];
    if (sourceDocs !== null) {
      sourceDocs.forEach((doc, index) => {
        const docId = String(doc?.docId || "").trim();
        if (!isValidDocId(docId)) return;
        const sortIndexNum = Number(doc?.sortIndex);
        const sortOrderNum = Number(doc?.sortOrder);
        docs.push({
          docId,
          title: String(doc?.title || ""),
          icon: normalizeDocIconValue(doc?.icon || ""),
          hPath: String(doc?.hPath || ""),
          parentId: String(doc?.parentId || ""),
          sortIndex: Number.isFinite(sortIndexNum) ? sortIndexNum : index,
          sortOrder: Number.isFinite(sortOrderNum) ? Math.max(0, Math.floor(sortOrderNum)) : index,
          markdown: String(doc?.markdown || ""),
          contentHash: normalizeHashHex(doc?.contentHash),
          metaHash: normalizeHashHex(doc?.metaHash),
        });
      });
    } else {
      const docId = String(metadata?.docId || "").trim();
      if (isValidDocId(docId)) {
        const sortOrderNum = Number(metadata?.sortOrder);
        docs.push({
          docId,
          title: String(metadata?.title || ""),
          icon: normalizeDocIconValue(metadata?.icon || ""),
          hPath: String(metadata?.hPath || ""),
          parentId: "",
          sortIndex: 0,
          sortOrder: Number.isFinite(sortOrderNum) ? Math.max(0, Math.floor(sortOrderNum)) : 0,
          markdown: String(metadata?.markdown || ""),
          contentHash: normalizeHashHex(metadata?.contentHash),
          metaHash: normalizeHashHex(metadata?.metaHash),
        });
      }
    }

    const usedPaths = new Set();
    const docEntries = [];
    const docManifest = [];
    const docMetaRows = [];
    let totalBytes = 0;
    docs.forEach((doc, index) => {
      const markdown = String(doc?.markdown || "");
      const blob = new Blob([markdown], {type: "text/markdown"});
      const size = Number(blob.size) || 0;
      const path = this.buildDocChunkPath(doc.docId, index, usedPaths);
      const contentHash = normalizeHashHex(doc.contentHash);
      const metaHash = normalizeHashHex(doc.metaHash);
      const metaRow = {
        docId: doc.docId,
        title: String(doc.title || ""),
        hPath: String(doc.hPath || ""),
        parentId: String(doc.parentId || ""),
        sortIndex: Number.isFinite(Number(doc.sortIndex)) ? Number(doc.sortIndex) : index,
        sortOrder: Number.isFinite(Number(doc.sortOrder)) ? Math.max(0, Math.floor(Number(doc.sortOrder))) : index,
        size,
      };
      if (doc.icon) metaRow.icon = doc.icon;
      if (contentHash) metaRow.contentHash = contentHash;
      if (metaHash) metaRow.metaHash = metaHash;
      docMetaRows.push(metaRow);
      docEntries.push({asset: {path, blob}, docId: doc.docId});
      const manifestItem = {path, size, docId: doc.docId};
      if (contentHash) manifestItem.hash = contentHash;
      docManifest.push(manifestItem);
      totalBytes += size;
    });

    delete metadata.markdown;
    delete metadata.hPath;
    delete metadata.sortOrder;
    delete metadata.icon;
    delete metadata.contentHash;
    delete metadata.metaHash;
    metadata.docs = docMetaRows;

    return {metadata, docEntries, docManifest, totalBytes};
  }

  async fetchShareSnapshot(shareId, {controller = null, progress = null} = {}) {
    if (!shareId) throw new Error(this.t("siyuanShare.error.missingShareId"));
    return this.remoteRequest(REMOTE_API.shareSnapshot, {
      method: "POST",
      body: {shareId},
      controller,
      progress,
      progressText: this.t("siyuanShare.progress.analyzingIncrement"),
    });
  }

  collectPayloadDocRows(payload) {
    if (!payload || typeof payload !== "object") return [];
    const docs = [];
    if (Array.isArray(payload.docs) && payload.docs.length > 0) {
      payload.docs.forEach((doc, index) => {
        const docId = String(doc?.docId || "").trim();
        if (!isValidDocId(docId)) return;
        docs.push({
          docId,
          title: String(doc?.title || ""),
          icon: normalizeDocIconValue(doc?.icon || ""),
          hPath: String(doc?.hPath || ""),
          parentId: String(doc?.parentId || ""),
          sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : index,
          sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder) || index)),
          markdown: String(doc?.markdown || ""),
        });
      });
      return docs;
    }
    const docId = String(payload?.docId || "").trim();
    if (!isValidDocId(docId)) return [];
    docs.push({
      docId,
      title: String(payload?.title || ""),
      icon: normalizeDocIconValue(payload?.icon || ""),
      hPath: String(payload?.hPath || ""),
      parentId: "",
      sortIndex: 0,
      sortOrder: Math.max(0, Math.floor(Number(payload?.sortOrder) || 0)),
      markdown: String(payload?.markdown || ""),
    });
    return docs;
  }

  async buildIncrementalLocalState(payload, assetEntries, {controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    const docs = this.collectPayloadDocRows(payload);
    const localDocs = [];
    for (let i = 0; i < docs.length; i += 1) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const doc = docs[i];
      const contentHash = await hashTextSha256(doc.markdown || "");
      const metaHash = await hashTextSha256(buildDocMetaHashInput(doc));
      localDocs.push({
        ...doc,
        contentHash: normalizeHashHex(contentHash),
        metaHash: normalizeHashHex(metaHash),
        size: String(doc.markdown || "").length,
      });
      progress?.update?.({
        text: t("siyuanShare.progress.analyzingIncrement"),
        detail: t("siyuanShare.progress.analyzingDocs", {index: i + 1, total: docs.length}),
      });
    }

    const localAssets = [];
    const seenPath = new Set();
    const list = Array.isArray(assetEntries) ? assetEntries : [];
    for (let i = 0; i < list.length; i += 1) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const entry = list[i] || {};
      const asset = entry.asset || entry;
      const rawPath = normalizeAssetPath(asset?.path || "");
      if (!rawPath || seenPath.has(rawPath)) continue;
      seenPath.add(rawPath);
      const blob = asset?.blob || null;
      const hash = blob ? await hashBlobSha256(blob) : "";
      const size = Number(asset?.blob?.size) || 0;
      localAssets.push({
        path: rawPath,
        docId: String(entry?.docId || "").trim(),
        size: Math.max(0, size),
        hash: normalizeHashHex(hash),
      });
      progress?.update?.({
        text: t("siyuanShare.progress.analyzingIncrement"),
        detail: t("siyuanShare.progress.analyzingAssets", {index: i + 1, total: list.length}),
      });
    }
    return {docs: localDocs, assets: localAssets};
  }

  normalizeSnapshotDocs(rawDocs) {
    if (!Array.isArray(rawDocs)) return [];
    const out = [];
    rawDocs.forEach((doc, index) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      out.push({
        docId,
        contentHash: normalizeHashHex(doc?.contentHash),
        metaHash: normalizeHashHex(doc?.metaHash),
        sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder) || index)),
      });
    });
    return out;
  }

  normalizeSnapshotAssets(rawAssets) {
    if (!Array.isArray(rawAssets)) return [];
    const out = [];
    rawAssets.forEach((asset) => {
      const path = normalizeAssetPath(asset?.path || "");
      if (!path) return;
      out.push({
        path,
        docId: String(asset?.docId || "").trim(),
        hash: normalizeHashHex(asset?.hash),
      });
    });
    return out;
  }

  async buildScopedIncrementalPlan(
    {scopeDocs = [], exportedDocs = [], assetEntries = [], remoteSnapshot = null} = {},
    {controller = null, progress = null} = {},
  ) {
    const t = this.t.bind(this);
    const remoteDocs = this.normalizeSnapshotDocs(remoteSnapshot?.docs);
    const remoteAssets = this.normalizeSnapshotAssets(remoteSnapshot?.assets);
    const scopeDocList = Array.isArray(scopeDocs) ? scopeDocs : [];
    const exportedDocList = Array.isArray(exportedDocs) ? exportedDocs : [];
    const scopeDocIds = Array.from(
      new Set(scopeDocList.map((doc) => String(doc?.docId || "").trim()).filter((id) => isValidDocId(id))),
    );
    const scopeDocSet = new Set(scopeDocIds);
    const remoteDocMap = new Map(remoteDocs.map((doc) => [String(doc.docId), doc]));
    const remoteAssetMap = new Map(remoteAssets.map((asset) => [String(asset.path), asset]));

    const deletedDocIds = remoteDocs
      .map((doc) => String(doc?.docId || "").trim())
      .filter((id) => isValidDocId(id) && !scopeDocSet.has(id));

    const localExportedDocs = [];
    for (let i = 0; i < exportedDocList.length; i += 1) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const doc = exportedDocList[i] || {};
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) continue;
      const markdown = String(doc?.markdown || "");
      const contentHash = normalizeHashHex(doc?.contentHash) || normalizeHashHex(await hashTextSha256(markdown));
      const metaHash =
        normalizeHashHex(doc?.metaHash) || normalizeHashHex(await hashTextSha256(buildDocMetaHashInput(doc)));
      localExportedDocs.push({
        docId,
        title: String(doc?.title || ""),
        icon: normalizeDocIconValue(doc?.icon || ""),
        hPath: String(doc?.hPath || ""),
        parentId: String(doc?.parentId || ""),
        sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : 0,
        sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder) || 0)),
        markdown,
        contentHash,
        metaHash,
      });
      progress?.update?.({
        text: t("siyuanShare.progress.analyzingIncrement"),
        detail: t("siyuanShare.progress.analyzingDocs", {index: i + 1, total: exportedDocList.length}),
      });
    }

    const uploadDocs = [];
    let addedDocs = 0;
    let updatedDocs = 0;
    localExportedDocs.forEach((doc) => {
      const remote = remoteDocMap.get(String(doc.docId));
      if (!remote) {
        addedDocs += 1;
        uploadDocs.push(doc);
        return;
      }
      const sameContent = remote.contentHash && remote.contentHash === normalizeHashHex(doc.contentHash);
      const sameMeta = remote.metaHash && remote.metaHash === normalizeHashHex(doc.metaHash);
      if (sameContent && sameMeta) return;
      updatedDocs += 1;
      uploadDocs.push(doc);
    });

    const localAssets = [];
    const localAssetMap = new Map();
    const list = Array.isArray(assetEntries) ? assetEntries : [];
    for (let i = 0; i < list.length; i += 1) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const entry = list[i] || {};
      const asset = entry.asset || entry;
      const path = normalizeAssetPath(asset?.path || "");
      if (!path || localAssetMap.has(path)) continue;
      const blob = asset?.blob || null;
      const hash = blob ? normalizeHashHex(await hashBlobSha256(blob)) : "";
      const size = Math.max(0, Number(asset?.blob?.size) || 0);
      const row = {
        path,
        docId: String(entry?.docId || "").trim(),
        hash,
        size,
      };
      localAssetMap.set(path, row);
      localAssets.push(row);
      progress?.update?.({
        text: t("siyuanShare.progress.analyzingIncrement"),
        detail: t("siyuanShare.progress.analyzingAssets", {index: i + 1, total: list.length}),
      });
    }

    const changedAssetPaths = new Set();
    const uploadAssets = [];
    let addedAssets = 0;
    let updatedAssets = 0;
    localAssets.forEach((asset) => {
      const remote = remoteAssetMap.get(String(asset.path));
      if (!remote) {
        addedAssets += 1;
        changedAssetPaths.add(asset.path);
        uploadAssets.push(asset);
        return;
      }
      const sameHash = remote.hash && asset.hash && remote.hash === normalizeHashHex(asset.hash);
      const sameDoc = String(remote.docId || "") === String(asset.docId || "");
      if (sameHash && sameDoc) return;
      updatedAssets += 1;
      changedAssetPaths.add(asset.path);
      uploadAssets.push(asset);
    });

    const uploadAssetEntries = list.filter((entry) => {
      const asset = entry?.asset || entry;
      const path = normalizeAssetPath(asset?.path || "");
      return path && changedAssetPaths.has(path);
    });

    const deletedDocSet = new Set(deletedDocIds);
    const exportedDocSet = new Set(localExportedDocs.map((doc) => String(doc.docId)));
    const deletedAssetPaths = [];
    remoteAssets.forEach((asset) => {
      const path = normalizeAssetPath(asset?.path || "");
      if (!path || localAssetMap.has(path)) return;
      const docId = String(asset?.docId || "").trim();
      if (docId && (deletedDocSet.has(docId) || exportedDocSet.has(docId))) {
        deletedAssetPaths.push(path);
      }
    });
    const uniqueDeletedAssetPaths = Array.from(new Set(deletedAssetPaths));

    return {
      uploadDocs,
      uploadAssets: uploadAssets.map((asset) => ({
        path: String(asset.path),
        size: Math.max(0, Number(asset.size) || 0),
        docId: String(asset.docId || ""),
        hash: normalizeHashHex(asset.hash),
      })),
      uploadAssetEntries,
      uploadAssetPaths: Array.from(changedAssetPaths),
      deletedDocIds,
      deletedAssetPaths: uniqueDeletedAssetPaths,
      summary: {
        baseDocs: remoteDocs.length,
        baseAssets: remoteAssets.length,
        totalDocs: scopeDocIds.length,
        totalAssets: Math.max(0, remoteAssets.length - uniqueDeletedAssetPaths.length + uploadAssets.length),
        addedDocs,
        updatedDocs,
        changedDocs: uploadDocs.length,
        addedAssets,
        updatedAssets,
        changedAssets: uploadAssets.length,
        deletedDocs: deletedDocIds.length,
        deletedAssets: uniqueDeletedAssetPaths.length,
      },
    };
  }

  buildIncrementalPlan(localState, remoteSnapshot) {
    const localDocs = Array.isArray(localState?.docs) ? localState.docs : [];
    const localAssets = Array.isArray(localState?.assets) ? localState.assets : [];
    const remoteDocs = this.normalizeSnapshotDocs(remoteSnapshot?.docs);
    const remoteAssets = this.normalizeSnapshotAssets(remoteSnapshot?.assets);
    const localDocMap = new Map(localDocs.map((doc) => [String(doc.docId), doc]));
    const remoteDocMap = new Map(remoteDocs.map((doc) => [String(doc.docId), doc]));
    const localAssetMap = new Map(localAssets.map((asset) => [String(asset.path), asset]));
    const remoteAssetMap = new Map(remoteAssets.map((asset) => [String(asset.path), asset]));

    const addedDocIds = [];
    const updatedDocIds = [];
    const changedDocIds = new Set();
    localDocs.forEach((doc) => {
      const remote = remoteDocMap.get(String(doc.docId));
      if (!remote) {
        addedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
        return;
      }
      if (!remote.contentHash || !remote.metaHash) {
        updatedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
        return;
      }
      if (remote.contentHash !== normalizeHashHex(doc.contentHash)) {
        updatedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
        return;
      }
      if (remote.metaHash !== normalizeHashHex(doc.metaHash)) {
        updatedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
      }
    });

    const deletedDocIds = [];
    remoteDocs.forEach((doc) => {
      if (!localDocMap.has(String(doc.docId))) {
        deletedDocIds.push(String(doc.docId));
      }
    });

    const addedAssetPaths = [];
    const updatedAssetPaths = [];
    const changedAssetPaths = new Set();
    localAssets.forEach((asset) => {
      const remote = remoteAssetMap.get(String(asset.path));
      if (!remote) {
        addedAssetPaths.push(String(asset.path));
        changedAssetPaths.add(String(asset.path));
        return;
      }
      if (!remote.hash || !asset.hash || remote.hash !== normalizeHashHex(asset.hash)) {
        updatedAssetPaths.push(String(asset.path));
        changedAssetPaths.add(String(asset.path));
        return;
      }
      if (String(remote.docId || "") !== String(asset.docId || "")) {
        updatedAssetPaths.push(String(asset.path));
        changedAssetPaths.add(String(asset.path));
      }
    });

    const deletedAssetPaths = [];
    remoteAssets.forEach((asset) => {
      if (!localAssetMap.has(String(asset.path))) {
        deletedAssetPaths.push(String(asset.path));
      }
    });

    const uploadDocs = localDocs
      .filter((doc) => changedDocIds.has(String(doc.docId)))
      .map((doc) => ({
        docId: String(doc.docId),
        title: String(doc.title || ""),
        icon: normalizeDocIconValue(doc.icon || ""),
        hPath: String(doc.hPath || ""),
        parentId: String(doc.parentId || ""),
        sortIndex: Number.isFinite(Number(doc.sortIndex)) ? Number(doc.sortIndex) : 0,
        sortOrder: Math.max(0, Math.floor(Number(doc.sortOrder) || 0)),
        markdown: String(doc.markdown || ""),
        contentHash: normalizeHashHex(doc.contentHash),
        metaHash: normalizeHashHex(doc.metaHash),
      }));
    const uploadAssetPaths = Array.from(changedAssetPaths);
    const uploadAssetEntries = (Array.isArray(localState?.assetEntries) ? localState.assetEntries : []).filter((entry) => {
      const asset = entry?.asset || entry;
      const path = normalizeAssetPath(asset?.path || "");
      return path && changedAssetPaths.has(path);
    });
    const uploadAssets = localAssets
      .filter((asset) => changedAssetPaths.has(String(asset.path)))
      .map((asset) => ({
        path: String(asset.path),
        size: Math.max(0, Number(asset.size) || 0),
        docId: String(asset.docId || ""),
        hash: normalizeHashHex(asset.hash),
      }));

    return {
      uploadDocs,
      uploadAssets,
      uploadAssetEntries,
      uploadAssetPaths,
      deletedDocIds,
      deletedAssetPaths,
      summary: {
        baseDocs: remoteDocs.length,
        baseAssets: remoteAssets.length,
        totalDocs: localDocs.length,
        totalAssets: localAssets.length,
        addedDocs: addedDocIds.length,
        updatedDocs: updatedDocIds.length,
        changedDocs: uploadDocs.length,
        addedAssets: addedAssetPaths.length,
        updatedAssets: updatedAssetPaths.length,
        changedAssets: uploadAssets.length,
        deletedDocs: deletedDocIds.length,
        deletedAssets: deletedAssetPaths.length,
      },
    };
  }

  buildFullUploadPlan(localState, {assumeExisting = false} = {}) {
    const localDocs = Array.isArray(localState?.docs) ? localState.docs : [];
    const localAssets = Array.isArray(localState?.assets) ? localState.assets : [];
    const uploadDocs = localDocs.map((doc) => ({
      docId: String(doc.docId),
      title: String(doc.title || ""),
      icon: normalizeDocIconValue(doc.icon || ""),
      hPath: String(doc.hPath || ""),
      parentId: String(doc.parentId || ""),
      sortIndex: Number.isFinite(Number(doc.sortIndex)) ? Number(doc.sortIndex) : 0,
      sortOrder: Math.max(0, Math.floor(Number(doc.sortOrder) || 0)),
      markdown: String(doc.markdown || ""),
      contentHash: normalizeHashHex(doc.contentHash),
      metaHash: normalizeHashHex(doc.metaHash),
    }));
    const uploadAssets = localAssets.map((asset) => ({
      path: String(asset.path),
      size: Math.max(0, Number(asset.size) || 0),
      docId: String(asset.docId || ""),
      hash: normalizeHashHex(asset.hash),
    }));
    const existing = !!assumeExisting;
    return {
      uploadDocs,
      uploadAssets,
      uploadAssetEntries: Array.isArray(localState?.assetEntries) ? localState.assetEntries : [],
      uploadAssetPaths: uploadAssets.map((asset) => String(asset.path)),
      deletedDocIds: [],
      deletedAssetPaths: [],
      summary: {
        baseDocs: existing ? localDocs.length : 0,
        baseAssets: existing ? localAssets.length : 0,
        totalDocs: localDocs.length,
        totalAssets: localAssets.length,
        addedDocs: existing ? 0 : localDocs.length,
        updatedDocs: existing ? localDocs.length : 0,
        changedDocs: localDocs.length,
        addedAssets: existing ? 0 : localAssets.length,
        updatedAssets: existing ? localAssets.length : 0,
        changedAssets: localAssets.length,
        deletedDocs: 0,
        deletedAssets: 0,
      },
    };
  }

  isIncrementalPlanNoop(plan) {
    const summary = plan?.summary || {};
    const changedDocs = Math.max(0, Math.floor(Number(summary?.changedDocs) || 0));
    const changedAssets = Math.max(0, Math.floor(Number(summary?.changedAssets) || 0));
    const deletedDocs = Math.max(0, Math.floor(Number(summary?.deletedDocs) || 0));
    const deletedAssets = Math.max(0, Math.floor(Number(summary?.deletedAssets) || 0));
    return changedDocs === 0 && changedAssets === 0 && deletedDocs === 0 && deletedAssets === 0;
  }

  formatIncrementSummaryDetail(summary) {
    const t = this.t.bind(this);
    const toCount = (value) => Math.max(0, Math.floor(Number(value) || 0));
    const line = (title, base, added, updated, deleted) =>
      `${title}: ${t("siyuanShare.progress.incrementStatBase")} ${toCount(base)} | ${t(
        "siyuanShare.progress.incrementStatAdded",
      )} ${toCount(added)} | ${t("siyuanShare.progress.incrementStatUpdated")} ${toCount(
        updated,
      )} | ${t("siyuanShare.progress.incrementStatDeleted")} ${toCount(deleted)}`;
    return [
      line(
        t("siyuanShare.progress.incrementSectionDocs"),
        summary?.baseDocs,
        summary?.addedDocs,
        summary?.updatedDocs,
        summary?.deletedDocs,
      ),
      line(
        t("siyuanShare.progress.incrementSectionAssets"),
        summary?.baseAssets,
        summary?.addedAssets,
        summary?.updatedAssets,
        summary?.deletedAssets,
      ),
    ].join("\n");
  }

  async uploadAssetsChunked(uploadId, entries, controller, progress, totalBytes = 0) {
    const t = this.t.bind(this);
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
    if (!Array.isArray(entries) || entries.length === 0) return;
    const total = entries.length;
    const baseLabel = t("siyuanShare.progress.uploadingContent");
    const {asset: assetMax, chunk: chunkMax} = this.getUploadConcurrency();
    const sortedEntries = entries
      .slice()
      .sort((a, b) => (Number(b?.asset?.blob?.size) || 0) - (Number(a?.asset?.blob?.size) || 0));
    const sizes = sortedEntries.map((entry) => Number(entry?.asset?.blob?.size) || 0);
    let assetConcurrency = this.getAdaptiveAssetConcurrency(totalBytes, entries.length, assetMax, sizes);
    const docPrefix = `${DOC_CHUNK_UPLOAD_PREFIX}/`;
    const docChunkCount = sortedEntries.reduce((count, entry) => {
      const path = String(entry?.asset?.path || entry?.path || "");
      return count + (path.startsWith(docPrefix) ? 1 : 0);
    }, 0);
    if (docChunkCount > 0) {
      const ratio = docChunkCount / Math.max(1, sortedEntries.length);
      // Doc chunk uploads are prone to transient missing-chunk races.
      // Cap upload-asset concurrency when doc chunks dominate.
      assetConcurrency = Math.max(1, Math.min(assetConcurrency, ratio >= 0.5 ? 4 : 5));
    }
    let fatalError = null;
    const tracker = {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
      uploadedBytes: 0,
      totalAssets: total,
      completedAssets: 0,
      label: baseLabel,
      started: false,
    };
    const reportProgress = () => {
      if (!progress?.update) return;
      if (tracker.totalBytes > 0) {
        const percent = this.getUploadPercent(tracker);
        progress.update({
          text: baseLabel,
          percent,
          detail: this.formatUploadDetail(
            tracker.uploadedBytes,
            tracker.totalBytes,
            tracker.completedAssets,
            tracker.totalAssets,
          ),
        });
      } else {
        const percent = this.getUploadPercent(tracker);
        progress.update({text: baseLabel, percent});
      }
    };
    const tasks = sortedEntries.map((entry) => async () => {
      const assetEntry = entry || {};
      const asset = assetEntry.asset || assetEntry;
      const docId = assetEntry.docId || "";
      try {
        if (!tracker.started) {
          tracker.started = true;
          reportProgress();
        }
        await this.uploadAssetInChunks(uploadId, asset, docId, controller, progress, tracker, baseLabel, chunkMax);
        tracker.completedAssets += 1;
        reportProgress();
      } catch (err) {
        if (!fatalError && !isAbortError(err)) {
          fatalError = err;
        }
        if (controller && !controller.signal?.aborted) {
          try {
            controller.abort();
          } catch {
            // ignore
          }
        }
        throw err;
      }
    });
    try {
      await runTasksWithConcurrency(tasks, assetConcurrency);
    } catch (err) {
      if (fatalError && isAbortError(err)) {
        throw fatalError;
      }
      throw err;
    }
    reportProgress();
  }

  async uploadAssetInChunks(
    uploadId,
    asset,
    docId,
    controller,
    progress,
    tracker,
    label,
    chunkMaxConcurrency,
  ) {
    const t = this.t.bind(this);
    const blob = asset?.blob;
    const assetPath = asset?.path;
    if (!blob || !assetPath) return;
    const size = Number(blob.size) || 0;
    const chunkSize = this.getAdaptiveChunkSize(size);
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const baseConcurrency = this.getAdaptiveChunkConcurrency(size, chunkSize, chunkMaxConcurrency);
    const isDocChunkAsset = String(assetPath || "").startsWith(`${DOC_CHUNK_UPLOAD_PREFIX}/`);
    const concurrency = isDocChunkAsset ? Math.max(1, Math.min(2, baseConcurrency)) : baseConcurrency;
    const uploadChunkOnce = async (index, {countBytes = true} = {}) => {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const start = index * chunkSize;
      const end = Math.min(size, start + chunkSize);
      const chunk = blob.slice(start, end);
      const form = new FormData();
      form.append("uploadId", String(uploadId));
      form.append("assetPath", assetPath);
      if (docId) form.append("assetDocId", String(docId));
      form.append("chunkIndex", String(index));
      form.append("totalChunks", String(totalChunks));
      form.append("totalSize", String(size));
      form.append("chunk", chunk, assetPath);
      const startedAt = nowTs();
      try {
        await withRetry(
          () =>
            this.remoteRequest(REMOTE_API.shareAssetChunk, {
              method: "POST",
              body: form,
              isForm: true,
              controller,
              progress,
            }).catch((err) => {
              if (getMissingChunksFromError(err)) {
                err.noRetry = true;
              }
              throw err;
            }),
          {
            retries: UPLOAD_RETRY_LIMIT,
            baseDelay: UPLOAD_RETRY_BASE_DELAY,
            maxDelay: UPLOAD_RETRY_MAX_DELAY,
            controller,
          },
        );
      } catch (err) {
        throw err;
      }
      const elapsed = nowTs() - startedAt;
      this.updateUploadSpeed(end - start, elapsed);
      if (countBytes && tracker && tracker.totalBytes > 0) {
        tracker.uploadedBytes += end - start;
        const percent = this.getUploadPercent(tracker);
        progress?.update?.({
          text: label || tracker.label,
          percent,
          detail: this.formatUploadDetail(
            tracker.uploadedBytes,
            tracker.totalBytes,
            tracker.completedAssets,
            tracker.totalAssets,
          ),
        });
      }
    };
    if (totalChunks === 1) {
      await uploadChunkOnce(0);
      return;
    }
    const lastChunkIndex = totalChunks - 1;
    const tasks = [];
    for (let index = 0; index < lastChunkIndex; index += 1) {
      tasks.push(() => uploadChunkOnce(index));
    }
    await runTasksWithConcurrency(tasks, concurrency);
    let missingAttempt = 0;
    while (true) {
      try {
        await uploadChunkOnce(lastChunkIndex);
        break;
      } catch (err) {
        const missing = getMissingChunksFromError(err);
        if (!missing || missingAttempt >= UPLOAD_MISSING_CHUNK_RETRY_LIMIT) {
          throw err;
        }
        missingAttempt += 1;
        const normalizedMissing = Array.from(new Set(missing)).filter(
          (idx) => idx >= 0 && idx < totalChunks && idx !== lastChunkIndex,
        );
        if (normalizedMissing.length === 0) {
          throw err;
        }
        console.warn("Missing chunks detected, retrying upload.", {
          assetPath,
          missing: normalizedMissing,
          attempt: missingAttempt,
        });
        // Give in-flight writes a short settle window before retry.
        await sleep(120 + Math.floor(Math.random() * 180));
        const retryTasks = normalizedMissing.map((idx) => () => uploadChunkOnce(idx, {countBytes: false}));
        await runTasksWithConcurrency(retryTasks, Math.min(concurrency, retryTasks.length));
      }
    }
  }


  async shareDoc(
    docId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      includeChildren = false,
      excludedDocIds = [],
      allowRequestError = true,
      background = false,
      controller: externalController = null,
      autoUpdateExpectedChangeSeq = null,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidDocId(docId)) throw new Error(t("siyuanShare.error.invalidDocId"));
    const controller = externalController || new AbortController();
    const progress = this.createProgressHandle(t("siyuanShare.progress.creatingShare"), controller, {background});
    const incrementalCursorStamp = formatDocUpdatedStampFromMs(nowTs());
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({silent: background, controller, progress, background});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      progress.update(t("siyuanShare.progress.fetchingDocInfo"));
      const info = await this.resolveDocInfoFromAnyId(docId);
      const title = info?.title || t("siyuanShare.label.untitled");
      const notebookId = await this.resolveNotebookIdFromDoc(docId);
      let rootIcon = await this.resolveDocIcon(docId);
      if (!normalizeDocIconValue(rootIcon)) {
        rootIcon = DEFAULT_DOC_ICON_LEAF;
      }
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      let subtreeDocs = [];
      const existingShare = this.getShareByDocId(docId);
      if (background && isValidNotebookId(notebookId)) {
        const isClosed = await this.isNotebookClosedForAutoUpdate(notebookId, {forceRefresh: true});
        if (isClosed) {
          if (existingShare?.id) {
            this.autoUpdateAbortByNotebookClosedSet.add(String(existingShare.id));
          }
          throw createAbortError(this.buildAutoUpdateNotebookClosedSkipMessage(existingShare?.id || ""));
        }
      }
      let useIncremental = !!(existingShare?.id && this.supportsIncrementalShare());
      let remoteSnapshot = null;
      let shareMissingRemotely = false;
      if (useIncremental) {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        try {
          remoteSnapshot = await this.fetchShareSnapshot(existingShare.id, {controller, progress});
        } catch (err) {
          if (isRemoteShareNotFoundError(err)) {
            useIncremental = false;
            shareMissingRemotely = true;
            await this.clearIncrementalCursor(existingShare.id);
            await this.clearDocBlockCountCache(existingShare.id);
            console.warn("Remote share missing, fallback to create-new flow.", {shareId: existingShare.id});
          } else {
            throw err;
          }
        }
      }
      const exportedMarkdowns = [];
      const iconUploadMap = new Map();
      let selectedExcludedDocIds = normalizeDocIdList(excludedDocIds).filter((id) => id !== String(docId));
      if (includeChildren) {
        progress.update(t("siyuanShare.progress.fetchingNotebookList"));
        subtreeDocs = await this.listDocSubtree(docId);
        if (!Array.isArray(subtreeDocs) || subtreeDocs.length === 0) {
          if (background && isValidNotebookId(notebookId)) {
            const isClosed = await this.isNotebookClosedForAutoUpdate(notebookId, {forceRefresh: true});
            if (isClosed) {
              if (existingShare?.id) {
                this.autoUpdateAbortByNotebookClosedSet.add(String(existingShare.id));
              }
              throw createAbortError(this.buildAutoUpdateNotebookClosedSkipMessage(existingShare?.id || ""));
            }
          }
          throw new Error("Doc tree fetch failed: listDocsByPath returned empty.");
        }
        await this.fillDocIcons(subtreeDocs);
        applyDefaultDocIcons(subtreeDocs);
      }
      const useChildren = includeChildren && subtreeDocs.length > 1;
      let scopeDocs = useChildren
        ? subtreeDocs.map((doc, index) => ({
            docId: String(doc?.docId || "").trim(),
            title: String(doc?.title || ""),
            icon: normalizeDocIconValue(doc?.icon || ""),
            parentId: String(doc?.parentId || ""),
            sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : index,
            sortOrder: Number.isFinite(Number(doc?.sortOrder)) ? Number(doc.sortOrder) : index,
          }))
        : [
            {
              docId: String(docId || "").trim(),
              title: String(title || ""),
              icon: normalizeDocIconValue(rootIcon || ""),
              parentId: "",
              sortIndex: 0,
              sortOrder: 0,
            },
          ];
      if (useChildren) {
        const filtered = this.filterScopeDocsByExcludedDocIds(scopeDocs, selectedExcludedDocIds, {
          lockedDocIds: [String(docId)],
        });
        scopeDocs = filtered.docs;
        selectedExcludedDocIds = filtered.selectedDocIds;
        if (!scopeDocs.length) throw new Error(t("siyuanShare.error.noDocsToShare"));
      }
      let candidateDocIds = scopeDocs.map((doc) => String(doc?.docId || "").trim());
      if (useIncremental) {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        const candidateInfo = await this.collectIncrementalCandidateDocIds(scopeDocs, existingShare, {
          controller,
          progress,
        });
        candidateDocIds = Array.isArray(candidateInfo?.candidateDocIds) ? candidateInfo.candidateDocIds : [];
        const structChangedDocIds = this.collectStructChangedDocIds(scopeDocs, remoteSnapshot);
        if (structChangedDocIds.length) {
          candidateDocIds = Array.from(new Set([...candidateDocIds, ...structChangedDocIds]));
        }
      }
      const candidateSet = new Set(
        candidateDocIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id)),
      );
      let docsToExport = useIncremental
        ? scopeDocs.filter((doc) => candidateSet.has(String(doc?.docId || "").trim()))
        : scopeDocs.slice();
      if (useIncremental && docsToExport.length === 0) {
        const cached = this.getDocBlockCountCache(existingShare?.id);
        if (!cached || Object.keys(cached).length === 0) {
          docsToExport = scopeDocs.slice();
        }
      }

      let resourceFailures = 0;
      let docPayloads = [];
      let assetEntries = [];
      const allowRetryCache = !useIncremental;
      const exportScopeMeta = allowRetryCache
        ? this.buildExportRetryScopeMeta({
            type: SHARE_TYPES.DOC,
            targetId: docId,
            includeChildren: useChildren,
          })
        : null;
      let exportScopeDigest = "";
      let cachedExport = null;
      let changedDocIds = [];
      if (allowRetryCache && exportScopeMeta && docsToExport.length > 0) {
        try {
          const cacheState = await this.resolveExportRetryCacheForScope(exportScopeMeta, docsToExport, {
            controller,
            progress,
          });
          exportScopeDigest = cacheState.scopeDigest;
          cachedExport = cacheState.cache;
          changedDocIds = Array.isArray(cacheState.changedDocIds) ? cacheState.changedDocIds : [];
        } catch (err) {
          console.warn("resolveExportRetryCacheForScope failed", err);
        }
      }
      const changedSet = new Set(changedDocIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id)));
      if (allowRetryCache && cachedExport && changedSet.size === 0) {
        docPayloads = this.normalizeExportRetryDocs(cachedExport.docs || []);
        assetEntries = this.normalizeExportRetryAssetEntries(cachedExport.assetEntries || []);
      } else {
        let docsForFreshExport = docsToExport.slice();
        let cachedForMerge = null;
        if (allowRetryCache && cachedExport && changedSet.size > 0 && changedSet.size < docsToExport.length) {
          docsForFreshExport = docsToExport.filter((doc) => changedSet.has(String(doc?.docId || "").trim()));
          cachedForMerge = cachedExport;
        }
        const freshDocPayloads = [];
        const assetMap = new Map();
        const usedUploadPaths = new Set();
        const docResults = await this.collectDocExportResults(docsForFreshExport, notebookId, {controller, progress});
        for (const result of docResults) {
          const doc = result.doc || {};
          const index = Number(result.index) || 0;
          const exportRes = result.exportRes || {};
          const markdown = String(result.markdown || "");
          const assets = Array.isArray(result.assets) ? result.assets : [];
          const failures = Array.isArray(result.failures) ? result.failures : [];
          resourceFailures += failures.length;
          const docIdValue = String(doc?.docId || "").trim();
          const docTitle =
            String(doc?.title || "").trim() || (docIdValue === docId ? title : t("siyuanShare.label.untitled"));
          const iconValue = await this.resolveIconUpload(doc?.icon, {
            docId: docIdValue,
            notebookId,
            usedUploadPaths,
            assetMap,
            iconUploadMap,
            controller,
          });
          freshDocPayloads.push({
            docId: docIdValue,
            title: docTitle,
            hPath: exportRes.hPath || "",
            parentId: useChildren ? (docIdValue === docId ? "" : String(doc?.parentId || "")) : "",
            sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : index,
            sortOrder: Number.isFinite(Number(doc?.sortOrder)) ? Number(doc.sortOrder) : index,
            markdown,
            ...(iconValue ? {icon: iconValue} : {}),
          });
          for (const asset of assets) {
            if (!asset?.path || assetMap.has(asset.path)) continue;
            assetMap.set(asset.path, {asset, docId: docIdValue});
            usedUploadPaths.add(asset.path);
          }
        }
        const freshAssetEntries = Array.from(assetMap.values());
        if (cachedForMerge) {
          const merged = this.mergeExportRetryData(docsToExport, cachedForMerge, {
            docs: freshDocPayloads,
            assetEntries: freshAssetEntries,
          });
          docPayloads = merged.docs;
          assetEntries = merged.assetEntries;
        } else {
          docPayloads = freshDocPayloads;
          assetEntries = freshAssetEntries;
        }
        if (allowRetryCache && exportScopeMeta) {
          await this.saveExportRetryCacheForScope(exportScopeMeta, {
            scopeDigest: exportScopeDigest,
            exportStamp: incrementalCursorStamp,
            docs: docPayloads,
            assetEntries,
          }).catch((err) => {
            console.warn("saveExportRetryCacheForScope failed", err);
          });
        }
      }
      docPayloads.forEach((row) => {
        const markdown = String(row?.markdown || "");
        if (markdown) exportedMarkdowns.push(markdown);
      });
      if (resourceFailures > 0) {
        console.warn("Some assets failed to download.", resourceFailures);
      }
      const refDocIds = scopeDocs.map((doc) => String(doc?.docId || ""));
      if (!background) {
        await this.maybeWarnExportReference(exportedMarkdowns, refDocIds);
      }
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const rootPayload = docPayloads.find((row) => String(row?.docId || "") === String(docId));
      if (!useChildren && !useIncremental && !rootPayload) {
        throw new Error(t("siyuanShare.error.exportMarkdownFailed"));
      }
      const payload = useChildren
        ? {
            docId,
            title,
            docs: docPayloads,
          }
        : {
            docId,
            title,
            ...(rootPayload
              ? {
                  hPath: rootPayload.hPath || "",
                  markdown: String(rootPayload.markdown || ""),
                  sortOrder: Math.max(0, Math.floor(Number(rootPayload.sortOrder) || 0)),
                  ...(rootPayload.icon ? {icon: rootPayload.icon} : {}),
                }
              : {docs: []}),
          };
      const slug = this.normalizeShareSlugOverrideOrThrow(slugOverride);
      if (slug) payload.slug = slug;
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      const assetManifest = assetEntries.map(({asset, docId: entryDocId}) => ({
        path: asset.path,
        size: Number(asset?.blob?.size) || 0,
        docId: entryDocId,
      }));
      let uploadPayload = payload;
      let uploadAssetEntries = assetEntries;
      let uploadAssetManifest = assetManifest;
      let plan = null;
      if (useIncremental) {
        if (!remoteSnapshot) {
          throw new Error("Incremental snapshot unavailable");
        }
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        plan = await this.buildScopedIncrementalPlan(
          {
            scopeDocs,
            exportedDocs: docPayloads,
            assetEntries,
            remoteSnapshot,
          },
          {controller, progress},
        );
      } else {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        const localState = await this.buildIncrementalLocalState(payload, assetEntries, {controller, progress});
        localState.assetEntries = assetEntries;
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        plan = this.buildFullUploadPlan(localState, {
          assumeExisting: !!existingShare?.id && !shareMissingRemotely,
        });
      }
      if (background && this.isIncrementalPlanNoop(plan)) {
        if (existingShare?.id) {
          await this.setIncrementalCursor(existingShare.id, incrementalCursorStamp);
          if (!useIncremental || docsToExport.length > 0) {
            await this.refreshDocBlockCountCacheForShare(existingShare.id, scopeDocs, {controller});
          }
          await this.syncAutoUpdateStructDigestAfterShareSuccess(existingShare.id, {
            expectedChangeSeq: autoUpdateExpectedChangeSeq,
          });
        }
        return;
      }
      const detail = this.formatIncrementSummaryDetail(plan.summary);
      let proceed = true;
      if (!background) {
        progress.setBarVisible?.(false);
        try {
          proceed = await progress.confirm({
            text: t("siyuanShare.progress.incrementReady"),
            detail,
            continueText: t("siyuanShare.action.continueUpload"),
            autoProceedSeconds: 10,
          });
        } finally {
          progress.setBarVisible?.(true);
        }
      }
      if (!proceed) {
        throw createAbortError(t("siyuanShare.message.cancelled"));
      }
      if (useIncremental) {
        uploadPayload = {...payload};
        delete uploadPayload.markdown;
        delete uploadPayload.hPath;
        delete uploadPayload.sortOrder;
        delete uploadPayload.icon;
        uploadPayload.docs = plan.uploadDocs;
        uploadPayload.incremental = {
          enabled: true,
          deletedDocIds: plan.deletedDocIds,
          deletedAssetPaths: plan.deletedAssetPaths,
          ...plan.summary,
        };
        uploadAssetEntries = plan.uploadAssetEntries;
        uploadAssetManifest = plan.uploadAssets;
      }
      progress.update(t("siyuanShare.progress.uploadingContent"));
      let requestError = null;
      let uploadId = "";
      let uploadComplete = false;
      try {
        const useDocChunkUpload = this.supportsDocChunkUpload();
        const docChunkPlan = useDocChunkUpload ? this.buildDocChunkUploadPlan(uploadPayload) : null;
        const initBody = docChunkPlan
          ? {
              metadata: docChunkPlan.metadata,
              assets: uploadAssetManifest,
              docChunks: docChunkPlan.docManifest,
            }
          : {metadata: uploadPayload, assets: uploadAssetManifest};
        const init = await this.remoteRequest(REMOTE_API.shareDocInit, {
          method: "POST",
          body: initBody,
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadId = init?.uploadId;
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
        const uploadEntries = docChunkPlan
          ? [...docChunkPlan.docEntries, ...uploadAssetEntries]
          : uploadAssetEntries;
        const totalBytes = uploadAssetEntries.reduce(
          (sum, entry) => sum + (Number(entry?.asset?.blob?.size) || 0),
          0,
        ) + (docChunkPlan?.totalBytes || 0);
        await this.uploadAssetsChunked(uploadId, uploadEntries, controller, progress, totalBytes);
        await this.remoteRequest(REMOTE_API.shareUploadComplete, {
          method: "POST",
          body: {uploadId},
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadComplete = true;
      } catch (err) {
        requestError = err;
        if (uploadId && !uploadComplete) {
          try {
            await this.remoteRequest(REMOTE_API.shareUploadCancel, {
              method: "POST",
              body: {uploadId},
              controller,
              progress,
            });
          } catch (cancelErr) {
            console.warn("shareDoc cancel upload failed", cancelErr);
          }
        }
      }
      progress.update(t("siyuanShare.progress.syncingShareList"));
      let syncError = null;
      try {
        await this.syncRemoteShares({
          silent: true,
          controller,
          progress,
          background,
          skipAutoUpdateStructureReconcile: true,
        });
      } catch (err) {
        syncError = err;
      }
      if (requestError && isAbortError(requestError)) throw requestError;
      if (syncError && isAbortError(syncError)) throw syncError;
      if (requestError && !allowRequestError) throw requestError;
      const share = this.getShareByDocId(docId);
      if (!share) {
        if (requestError) throw requestError;
        if (syncError) throw syncError;
        throw new Error(t("siyuanShare.error.shareCreateFailed"));
      }
      this.setAutoUpdateShareNotebookHint(share.id, notebookId);
      this.setShareOptionValue(share.id, {
        includeChildren: !!includeChildren,
        excludedDocIds: selectedExcludedDocIds,
      });
      await this.saveData(STORAGE_SHARE_OPTIONS, this.shareOptions);
      await this.updateSharePasswordCache(share.id, {password, clearPassword});
      await this.setIncrementalCursor(share.id, incrementalCursorStamp);
      if (!useIncremental || docsToExport.length > 0) {
        await this.refreshDocBlockCountCacheForShare(share.id, scopeDocs, {controller});
      }
      await this.syncAutoUpdateStructDigestAfterShareSuccess(share.id, {
        expectedChangeSeq: autoUpdateExpectedChangeSeq,
      });
      if (requestError) {
        console.warn("shareDoc response error, but share exists after sync", requestError);
      }
      const url = this.getShareUrl(share);
      this.renderSettingCurrent();
      this.refreshDocTreeMarksLater();
      if (!background) {
        this.notify(t("siyuanShare.message.shareCreated", {value: url || title}));
        if (url) await this.tryCopyToClipboard(url);
      }
    } finally {
      progress?.close();
    }
  }

  async shareNotebook(
    notebookId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      excludedDocIds = [],
      allowRequestError = true,
      background = false,
      controller: externalController = null,
      autoUpdateExpectedChangeSeq = null,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidNotebookId(notebookId)) throw new Error(t("siyuanShare.error.invalidNotebookId"));
    const controller = externalController || new AbortController();
    const progress = this.createProgressHandle(t("siyuanShare.progress.creatingNotebookShare"), controller, {
      background,
    });
    const incrementalCursorStamp = formatDocUpdatedStampFromMs(nowTs());
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({silent: background, controller, progress, background});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      if (!this.notebooks.length) {
        progress.update(t("siyuanShare.progress.fetchingNotebookList"));
        await this.refreshNotebookOptions({silent: true});
      }
      const notebook = this.notebooks.find((n) => n.id === notebookId);
      if (background) {
        const isClosed = await this.isNotebookClosedForAutoUpdate(notebookId, {forceRefresh: true});
        if (isClosed) {
          const closedShare = this.getShareByNotebookId(notebookId);
          if (closedShare?.id) {
            this.autoUpdateAbortByNotebookClosedSet.add(String(closedShare.id));
          }
          throw createAbortError(this.buildAutoUpdateNotebookClosedSkipMessage(closedShare?.id || ""));
        }
      }
      const tree = await this.listDocsInNotebook(notebookId);
      const docs = Array.isArray(tree?.docs) ? tree.docs : Array.isArray(tree) ? tree : [];
      const title = notebook?.name || tree?.title || notebookId;
      progress.update(t("siyuanShare.progress.preparingNotebook"));
      if (!docs.length) throw new Error(t("siyuanShare.error.noDocsToShare"));
      await this.fillDocIcons(docs);
      applyDefaultDocIcons(docs);
      let scopeDocs = docs.map((doc, index) => ({
        docId: String(doc?.docId || "").trim(),
        title: String(doc?.title || ""),
        icon: normalizeDocIconValue(doc?.icon || ""),
        parentId: String(doc?.parentId || ""),
        sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : index,
        sortOrder: Number.isFinite(Number(doc?.sortOrder)) ? Number(doc.sortOrder) : index,
      }));
      let selectedExcludedDocIds = normalizeDocIdList(excludedDocIds);
      const excludedState = this.filterScopeDocsByExcludedDocIds(scopeDocs, selectedExcludedDocIds);
      scopeDocs = excludedState.docs;
      selectedExcludedDocIds = excludedState.selectedDocIds;
      if (!scopeDocs.length) throw new Error(t("siyuanShare.error.noDocsToShare"));
      const existingShare = this.getShareByNotebookId(notebookId);
      let useIncremental = !!(existingShare?.id && this.supportsIncrementalShare());
      let remoteSnapshot = null;
      let shareMissingRemotely = false;
      if (useIncremental) {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        try {
          remoteSnapshot = await this.fetchShareSnapshot(existingShare.id, {controller, progress});
        } catch (err) {
          if (isRemoteShareNotFoundError(err)) {
            useIncremental = false;
            shareMissingRemotely = true;
            await this.clearIncrementalCursor(existingShare.id);
            await this.clearDocBlockCountCache(existingShare.id);
            console.warn("Remote share missing, fallback to create-new flow.", {shareId: existingShare.id});
          } else {
            throw err;
          }
        }
      }
      let candidateDocIds = scopeDocs.map((doc) => String(doc?.docId || "").trim());
      if (useIncremental) {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        const candidateInfo = await this.collectIncrementalCandidateDocIds(scopeDocs, existingShare, {
          controller,
          progress,
        });
        candidateDocIds = Array.isArray(candidateInfo?.candidateDocIds) ? candidateInfo.candidateDocIds : [];
        const structChangedDocIds = this.collectStructChangedDocIds(scopeDocs, remoteSnapshot);
        if (structChangedDocIds.length) {
          candidateDocIds = Array.from(new Set([...candidateDocIds, ...structChangedDocIds]));
        }
      }
      const candidateSet = new Set(
        candidateDocIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id)),
      );
      let docsToExport = useIncremental
        ? scopeDocs.filter((doc) => candidateSet.has(String(doc?.docId || "").trim()))
        : scopeDocs.slice();
      if (useIncremental && docsToExport.length === 0) {
        const cached = this.getDocBlockCountCache(existingShare?.id);
        if (!cached || Object.keys(cached).length === 0) {
          docsToExport = scopeDocs.slice();
        }
      }

      let docPayloads = [];
      let assetEntries = [];
      const exportedMarkdowns = [];
      let failureCount = 0;
      const iconUploadMap = new Map();
      const allowRetryCache = !useIncremental;
      const exportScopeMeta = allowRetryCache
        ? this.buildExportRetryScopeMeta({
            type: SHARE_TYPES.NOTEBOOK,
            targetId: notebookId,
            includeChildren: true,
          })
        : null;
      let exportScopeDigest = "";
      let cachedExport = null;
      let changedDocIds = [];
      if (allowRetryCache && exportScopeMeta && docsToExport.length > 0) {
        try {
          const cacheState = await this.resolveExportRetryCacheForScope(exportScopeMeta, docsToExport, {
            controller,
            progress,
          });
          exportScopeDigest = cacheState.scopeDigest;
          cachedExport = cacheState.cache;
          changedDocIds = Array.isArray(cacheState.changedDocIds) ? cacheState.changedDocIds : [];
        } catch (err) {
          console.warn("resolveExportRetryCacheForScope failed", err);
        }
      }
      const changedSet = new Set(changedDocIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id)));
      if (allowRetryCache && cachedExport && changedSet.size === 0) {
        docPayloads = this.normalizeExportRetryDocs(cachedExport.docs || []);
        assetEntries = this.normalizeExportRetryAssetEntries(cachedExport.assetEntries || []);
      } else {
        let docsForFreshExport = docsToExport.slice();
        let cachedForMerge = null;
        if (allowRetryCache && cachedExport && changedSet.size > 0 && changedSet.size < docsToExport.length) {
          docsForFreshExport = docsToExport.filter((doc) => changedSet.has(String(doc?.docId || "").trim()));
          cachedForMerge = cachedExport;
        }
        const freshDocPayloads = [];
        const assetMap = new Map();
        const usedUploadPaths = new Set();
        const docResults = await this.collectDocExportResults(docsForFreshExport, notebookId, {controller, progress});
        for (const result of docResults) {
          const doc = result.doc || {};
          const index = Number(result.index) || 0;
          const exportRes = result.exportRes || {};
          const markdown = String(result.markdown || "");
          const assets = Array.isArray(result.assets) ? result.assets : [];
          const failures = Array.isArray(result.failures) ? result.failures : [];
          failureCount += failures.length;
          const docIdValue = String(doc?.docId || "").trim();
          const iconValue = await this.resolveIconUpload(doc?.icon, {
            docId: docIdValue,
            notebookId,
            usedUploadPaths,
            assetMap,
            iconUploadMap,
            controller,
          });
          freshDocPayloads.push({
            docId: docIdValue,
            title: doc.title || t("siyuanShare.label.untitled"),
            hPath: exportRes.hPath || "",
            markdown,
            parentId: doc.parentId || "",
            sortIndex: Number.isFinite(doc.sortIndex) ? doc.sortIndex : index,
            sortOrder: Number.isFinite(doc.sortOrder) ? doc.sortOrder : index,
            ...(iconValue ? {icon: iconValue} : {}),
          });
          for (const asset of assets) {
            if (!asset?.path || assetMap.has(asset.path)) continue;
            assetMap.set(asset.path, {asset, docId: docIdValue});
            usedUploadPaths.add(asset.path);
          }
        }
        const freshAssetEntries = Array.from(assetMap.values());
        if (cachedForMerge) {
          const merged = this.mergeExportRetryData(docsToExport, cachedForMerge, {
            docs: freshDocPayloads,
            assetEntries: freshAssetEntries,
          });
          docPayloads = merged.docs;
          assetEntries = merged.assetEntries;
        } else {
          docPayloads = freshDocPayloads;
          assetEntries = freshAssetEntries;
        }
        if (allowRetryCache && exportScopeMeta) {
          await this.saveExportRetryCacheForScope(exportScopeMeta, {
            scopeDigest: exportScopeDigest,
            exportStamp: incrementalCursorStamp,
            docs: docPayloads,
            assetEntries,
          }).catch((err) => {
            console.warn("saveExportRetryCacheForScope failed", err);
          });
        }
      }
      docPayloads.forEach((row) => {
        const markdown = String(row?.markdown || "");
        if (markdown) exportedMarkdowns.push(markdown);
      });
      if (failureCount > 0) {
        console.warn("Some assets failed to download.", failureCount);
      }
      const refDocIds = scopeDocs.map((doc) => String(doc?.docId || ""));
      if (!background) {
        await this.maybeWarnExportReference(exportedMarkdowns, refDocIds);
      }
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const payload = {
        notebookId,
        title,
        docs: docPayloads,
      };
      const slug = this.normalizeShareSlugOverrideOrThrow(slugOverride);
      if (slug) payload.slug = slug;
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      const assetManifest = assetEntries.map(({asset, docId}) => ({
        path: asset.path,
        size: Number(asset?.blob?.size) || 0,
        docId,
      }));
      let uploadPayload = payload;
      let uploadAssetEntries = assetEntries;
      let uploadAssetManifest = assetManifest;
      let plan = null;
      if (useIncremental) {
        if (!remoteSnapshot) {
          throw new Error("Incremental snapshot unavailable");
        }
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        plan = await this.buildScopedIncrementalPlan(
          {
            scopeDocs,
            exportedDocs: docPayloads,
            assetEntries,
            remoteSnapshot,
          },
          {controller, progress},
        );
      } else {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        const localState = await this.buildIncrementalLocalState(payload, assetEntries, {controller, progress});
        localState.assetEntries = assetEntries;
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        plan = this.buildFullUploadPlan(localState, {
          assumeExisting: !!existingShare?.id && !shareMissingRemotely,
        });
      }
      if (background && this.isIncrementalPlanNoop(plan)) {
        if (existingShare?.id) {
          await this.setIncrementalCursor(existingShare.id, incrementalCursorStamp);
          if (!useIncremental || docsToExport.length > 0) {
            await this.refreshDocBlockCountCacheForShare(existingShare.id, scopeDocs, {controller});
          }
          await this.syncAutoUpdateStructDigestAfterShareSuccess(existingShare.id, {
            expectedChangeSeq: autoUpdateExpectedChangeSeq,
          });
        }
        return;
      }
      const detail = this.formatIncrementSummaryDetail(plan.summary);
      let proceed = true;
      if (!background) {
        progress.setBarVisible?.(false);
        try {
          proceed = await progress.confirm({
            text: t("siyuanShare.progress.incrementReady"),
            detail,
            continueText: t("siyuanShare.action.continueUpload"),
            autoProceedSeconds: 10,
          });
        } finally {
          progress.setBarVisible?.(true);
        }
      }
      if (!proceed) {
        throw createAbortError(t("siyuanShare.message.cancelled"));
      }
      if (useIncremental) {
        uploadPayload = {...payload, docs: plan.uploadDocs};
        uploadPayload.incremental = {
          enabled: true,
          deletedDocIds: plan.deletedDocIds,
          deletedAssetPaths: plan.deletedAssetPaths,
          ...plan.summary,
        };
        uploadAssetEntries = plan.uploadAssetEntries;
        uploadAssetManifest = plan.uploadAssets;
      }
      progress.update(t("siyuanShare.progress.uploadingContent"));
      let requestError = null;
      let uploadId = "";
      let uploadComplete = false;
      try {
        const useDocChunkUpload = this.supportsDocChunkUpload();
        const docChunkPlan = useDocChunkUpload ? this.buildDocChunkUploadPlan(uploadPayload) : null;
        const initBody = docChunkPlan
          ? {
              metadata: docChunkPlan.metadata,
              assets: uploadAssetManifest,
              docChunks: docChunkPlan.docManifest,
            }
          : {metadata: uploadPayload, assets: uploadAssetManifest};
        const init = await this.remoteRequest(REMOTE_API.shareNotebookInit, {
          method: "POST",
          body: initBody,
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadId = init?.uploadId;
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
        const uploadEntries = docChunkPlan
          ? [...docChunkPlan.docEntries, ...uploadAssetEntries]
          : uploadAssetEntries;
        const totalBytes = uploadAssetEntries.reduce(
          (sum, entry) => sum + (Number(entry?.asset?.blob?.size) || 0),
          0,
        ) + (docChunkPlan?.totalBytes || 0);
        await this.uploadAssetsChunked(uploadId, uploadEntries, controller, progress, totalBytes);
        await this.remoteRequest(REMOTE_API.shareUploadComplete, {
          method: "POST",
          body: {uploadId},
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadComplete = true;
      } catch (err) {
        requestError = err;
        if (uploadId && !uploadComplete) {
          try {
            await this.remoteRequest(REMOTE_API.shareUploadCancel, {
              method: "POST",
              body: {uploadId},
              controller,
              progress,
            });
          } catch (cancelErr) {
            console.warn("shareNotebook cancel upload failed", cancelErr);
          }
        }
      }
      progress.update(t("siyuanShare.progress.syncingShareList"));
      let syncError = null;
      try {
        await this.syncRemoteShares({
          silent: true,
          controller,
          progress,
          background,
          skipAutoUpdateStructureReconcile: true,
        });
      } catch (err) {
        syncError = err;
      }
      if (requestError && isAbortError(requestError)) throw requestError;
      if (syncError && isAbortError(syncError)) throw syncError;
      if (requestError && !allowRequestError) throw requestError;
      const share = this.getShareByNotebookId(notebookId);
      if (!share) {
        if (requestError) throw requestError;
        if (syncError) throw syncError;
        throw new Error(t("siyuanShare.error.shareCreateFailed"));
      }
      this.setAutoUpdateShareNotebookHint(share.id, notebookId);
      this.setShareOptionValue(share.id, {
        includeChildren: true,
        excludedDocIds: selectedExcludedDocIds,
      });
      await this.saveData(STORAGE_SHARE_OPTIONS, this.shareOptions);
      await this.updateSharePasswordCache(share.id, {password, clearPassword});
      await this.setIncrementalCursor(share.id, incrementalCursorStamp);
      if (!useIncremental || docsToExport.length > 0) {
        await this.refreshDocBlockCountCacheForShare(share.id, scopeDocs, {controller});
      }
      await this.syncAutoUpdateStructDigestAfterShareSuccess(share.id, {
        expectedChangeSeq: autoUpdateExpectedChangeSeq,
      });
      if (requestError) {
        console.warn("shareNotebook response error, but share exists after sync", requestError);
      }
      const url = this.getShareUrl(share);
      this.refreshDocTreeMarksLater();
      if (!background) {
        this.notify(t("siyuanShare.message.shareCreated", {value: url || title}));
        if (url) await this.tryCopyToClipboard(url);
      }
    } finally {
      progress?.close();
    }
  }

  async fetchDocsByPath(notebookId, pathValue = "") {
    if (!isValidNotebookId(notebookId)) return {ok: false, nodes: []};
    try {
      const resp = await fetchSyncPost("/api/filetree/listDocsByPath", {
        notebook: notebookId,
        path: pathValue,
        app: "share",
      });
      if (resp && resp.code === 0) {
        const nodes = extractDocTreeNodes(resp.data);
        if (nodes.length) {
          const hasValid = nodes.some((node) => isValidDocId(getDocTreeNodeId(node)));
          if (!hasValid) {
            return {ok: false, nodes: []};
          }
        }
        return {ok: true, nodes};
      }
    } catch (err) {
      console.warn("listDocsByPath failed", err);
    }
    return {ok: false, nodes: []};
  }

  async collectDocsByPath(notebookId, pathValue, parentId, out, seen, {onDoc = null, controller = null} = {}) {
    const t = this.t.bind(this);
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const {ok, nodes} = await this.fetchDocsByPath(notebookId, pathValue);
    if (!ok) return false;
    if (!Array.isArray(nodes) || nodes.length === 0) return true;
    for (const [index, node] of nodes.entries()) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const docId = getDocTreeNodeId(node);
      if (!isValidDocId(docId)) continue;
      if (seen.has(docId)) continue;
      seen.add(docId);
      const rawTitle = node?.name || node?.title || node?.content || node?.label || "";
      const rawIcon = extractDocTreeNodeIcon(node);
      const row = {
        docId: String(docId || "").trim(),
        title: normalizeDocTitle(rawTitle),
        icon: normalizeDocIconValue(rawIcon),
        parentId: String(parentId || "").trim(),
        sortIndex: index,
        sortOrder: out.length,
      };
      out.push(row);
      if (typeof onDoc === "function") {
        try {
          onDoc(row);
        } catch {
          // ignore callback errors
        }
      }
      const nodePath = getDocTreeNodePath(node) || buildDocPath(pathValue, docId);
      const okChild = await this.collectDocsByPath(notebookId, nodePath, docId, out, seen, {
        onDoc,
        controller,
      });
      if (!okChild) return false;
    }
    return true;
  }

  async listDocsInNotebookByPath(
    notebookId,
    {onDoc = null, controller = null, fillIcons = true} = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidNotebookId(notebookId)) return null;
    const rootCandidates = ["/", ""];
    let rootNodes = null;
    let rootPath = "";
    let ok = false;
    for (const candidate of rootCandidates) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const resp = await this.fetchDocsByPath(notebookId, candidate);
      if (resp.ok) {
        ok = true;
        rootNodes = resp.nodes;
        rootPath = candidate;
        break;
      }
    }
    if (!ok) return null;
    const out = [];
    const seen = new Set();
    if (Array.isArray(rootNodes)) {
      for (const [index, node] of rootNodes.entries()) {
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        const docId = getDocTreeNodeId(node);
        if (!isValidDocId(docId)) continue;
        seen.add(docId);
        const rawTitle = node?.name || node?.title || node?.content || node?.label || "";
        const rawIcon = extractDocTreeNodeIcon(node);
        const row = {
          docId: String(docId || "").trim(),
          title: normalizeDocTitle(rawTitle),
          icon: normalizeDocIconValue(rawIcon),
          parentId: "",
          sortIndex: index,
          sortOrder: out.length,
        };
        out.push(row);
        if (typeof onDoc === "function") {
          try {
            onDoc(row);
          } catch {
            // ignore callback errors
          }
        }
        const nodePath = getDocTreeNodePath(node) || buildDocPath(rootPath, docId);
        const okChild = await this.collectDocsByPath(notebookId, nodePath, docId, out, seen, {
          onDoc,
          controller,
        });
        if (!okChild) return null;
      }
    }
    if (fillIcons) {
      await this.fillDocIcons(out);
    }
    return {title: "", docs: out};
  }

  async listDocSubtreeByPath(
    docId,
    {onDoc = null, controller = null, fillIcons = true} = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidDocId(docId)) return null;
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const notebookId = await this.resolveNotebookIdFromDoc(docId);
    if (!isValidNotebookId(notebookId)) return null;
    const row = await this.fetchBlockRow(docId);
    const rootPath = row?.path ? String(row.path || "").trim() : "";
    if (!rootPath) return null;
    const out = [];
    const seen = new Set();
    const rootTitle = normalizeDocTitle(
      typeof row?.content === "string" ? row.content : "",
    );
    const rootIcon = await this.resolveDocIcon(docId);
    const rootDoc = {
      docId: String(docId || "").trim(),
      title: rootTitle,
      icon: normalizeDocIconValue(rootIcon),
      parentId: "",
      sortIndex: 0,
      sortOrder: 0,
    };
    out.push(rootDoc);
    if (typeof onDoc === "function") {
      try {
        onDoc(rootDoc);
      } catch {
        // ignore callback errors
      }
    }
    seen.add(docId);
    const ok = await this.collectDocsByPath(notebookId, rootPath, docId, out, seen, {
      onDoc,
      controller,
    });
    if (!ok) return null;
    if (fillIcons) {
      await this.fillDocIcons(out);
    }
    return out;
  }

  async listDocsInNotebook(notebookId, options = {}) {
    if (!isValidNotebookId(notebookId)) return {docs: [], title: ""};
    const byPath = await this.listDocsInNotebookByPath(notebookId, options);
    if (byPath) return byPath;
    return {docs: [], title: ""};
  }

  async resolveNotebookIdFromDoc(docId) {
    if (!isValidDocId(docId)) return "";
    const row = await this.fetchBlockRow(docId);
    const boxId = row?.box ? String(row.box).trim() : "";
    return isValidNotebookId(boxId) ? boxId : "";
  }

  collectDocSubtree(docs, rootDocId) {
    if (!Array.isArray(docs) || !isValidDocId(rootDocId)) return [];
    const nodes = new Map();
    const children = new Map();
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const parentIdRaw = String(doc?.parentId || "").trim();
      const parentId = isValidDocId(parentIdRaw) ? parentIdRaw : "";
      const normalized = {
        docId,
        title: String(doc?.title || ""),
        parentId,
        sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : 0,
        sortOrder: Number.isFinite(Number(doc?.sortOrder)) ? Number(doc.sortOrder) : 0,
      };
      nodes.set(docId, normalized);
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(docId);
    });
    if (!nodes.has(rootDocId)) return [];
    const included = new Set();
    const stack = [rootDocId];
    while (stack.length) {
      const current = stack.pop();
      if (!current || included.has(current) || !nodes.has(current)) continue;
      included.add(current);
      const kids = children.get(current) || [];
      kids.forEach((kid) => stack.push(kid));
    }
    const out = [];
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!included.has(docId)) return;
      const node = nodes.get(docId);
      if (node) out.push(node);
    });
    return out;
  }

  async listDocSubtree(docId, options = {}) {
    const byPath = await this.listDocSubtreeByPath(docId, options);
    if (byPath && byPath.length) return byPath;
    return [];
  }

  async listDocSubtreeBySQL(docId, notebookId) {
    if (!isValidDocId(docId)) return [];
    try {
      const row = await this.fetchBlockRow(docId);
      const rootPath = row?.path ? String(row.path || "").trim() : "";
      const rootBox = row?.box ? String(row.box || "").trim() : "";
      const safeDocId = docId.replace(/'/g, "''");
      const safeBox = rootBox.replace(/'/g, "''");
      let bestDocs = [];
      const normalizeDocRow = (rowItem, index) => {
        const rowId = String(rowItem?.id || "").trim();
        if (!isValidDocId(rowId)) return null;
        const parentIdRaw = String(rowItem?.parent_id || rowItem?.parentId || "").trim();
        let parentId = isValidDocId(parentIdRaw) ? parentIdRaw : "";
        if (!parentId) {
          parentId = deriveParentIdFromPath(rowItem?.path, rowId);
        }
        if (parentId === rowId) parentId = "";
        const sortRaw = Number(rowItem?.sort);
        return {
          docId: rowId,
          title: typeof rowItem?.content === "string" ? rowItem.content : "",
          parentId,
          sortIndex: Number.isFinite(sortRaw) ? sortRaw : index,
          sortOrder: index,
        };
      };
      const considerDocs = (docs) => {
        if (docs.length > bestDocs.length) bestDocs = docs;
        return docs.length > 1;
      };
      try {
        const stmt = `WITH RECURSIVE doc_tree(id) AS (
          SELECT id FROM blocks WHERE id='${safeDocId}'
          UNION ALL
          SELECT b.id FROM blocks b JOIN doc_tree t ON b.parent_id = t.id WHERE b.type='d'
        )
        SELECT b.id, b.parent_id, b.content, b.sort, b.path FROM blocks b JOIN doc_tree t ON b.id = t.id ORDER BY b.sort`;
        const resp = await fetchSyncPost("/api/query/sql", {stmt});
        if (resp && resp.code === 0 && Array.isArray(resp.data)) {
          const docs = resp.data.map(normalizeDocRow).filter(Boolean);
          if (considerDocs(docs)) return docs;
        }
      } catch (err) {
        console.warn("Doc subtree recursive SQL failed", err);
      }
      if (rootPath) {
        const safePath = rootPath.replace(/'/g, "''");
        const pathPrefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
        const safePrefix = pathPrefix.replace(/'/g, "''");
        const altPrefix = rootPath.replace(/\.sy$/i, "");
        const altPrefixValue = altPrefix && altPrefix !== rootPath ? `${altPrefix}/` : "";
        const safeAltPrefix = altPrefixValue ? altPrefixValue.replace(/'/g, "''") : "";
        const pathFilter = safeAltPrefix
          ? `(path='${safePath}' OR path LIKE '${safePrefix}%' OR path LIKE '${safeAltPrefix}%')`
          : `(path='${safePath}' OR path LIKE '${safePrefix}%')`;
        const stmt = `SELECT id, parent_id, content, sort, path FROM blocks WHERE type='d' AND ${pathFilter} ORDER BY sort`;
        const resp = await fetchSyncPost("/api/query/sql", {stmt});
        if (resp && resp.code === 0 && Array.isArray(resp.data)) {
          const docs = resp.data.map(normalizeDocRow).filter(Boolean);
          if (considerDocs(docs)) return docs;
        }
      }
      if (rootBox) {
        const stmt = `SELECT id, parent_id, content, sort, path FROM blocks WHERE type='d' AND box='${safeBox}' ORDER BY sort`;
        const resp = await fetchSyncPost("/api/query/sql", {stmt});
        if (resp && resp.code === 0 && Array.isArray(resp.data)) {
          const docs = resp.data.map(normalizeDocRow).filter(Boolean);
          const subtree = this.collectDocSubtree(docs, docId);
          if (considerDocs(subtree)) return subtree;
        }
      }
      const iterDocs = await this.listDocSubtreeByParentChain(docId, row);
      if (considerDocs(iterDocs)) return iterDocs;
      return bestDocs.length ? bestDocs : [];
    } catch (err) {
      console.warn("Doc subtree SQL failed", err);
      return [];
    }
  }

  async listDocSubtreeByParentChain(docId, rootRow) {
    if (!isValidDocId(docId)) return [];
    const docs = [];
    const seen = new Set();
    const queue = [docId];
    const rootTitle =
      rootRow && typeof rootRow.content === "string" && rootRow.content ? rootRow.content : "";
    docs.push({
      docId,
      title: rootTitle,
      parentId: "",
      sortIndex: 0,
      sortOrder: 0,
    });
    seen.add(docId);
    let order = 1;
    while (queue.length) {
      const chunk = queue.splice(0, 20);
      const ids = chunk.filter((id) => isValidDocId(id)).map((id) => `'${id.replace(/'/g, "''")}'`);
      if (!ids.length) continue;
      const stmt = `SELECT id, parent_id, content, sort FROM blocks WHERE type='d' AND parent_id IN (${ids.join(
        ",",
      )}) ORDER BY sort`;
      const resp = await fetchSyncPost("/api/query/sql", {stmt});
      if (!resp || resp.code !== 0 || !Array.isArray(resp.data)) continue;
      resp.data.forEach((rowItem) => {
        const rowId = String(rowItem?.id || "").trim();
        if (!isValidDocId(rowId) || seen.has(rowId)) return;
        seen.add(rowId);
        const parentIdRaw = String(rowItem?.parent_id || "").trim();
        const parentId = isValidDocId(parentIdRaw) ? parentIdRaw : "";
        const sortRaw = Number(rowItem?.sort);
        docs.push({
          docId: rowId,
          title: typeof rowItem?.content === "string" ? rowItem.content : "",
          parentId,
          sortIndex: Number.isFinite(sortRaw) ? sortRaw : order,
          sortOrder: order,
        });
        order += 1;
        queue.push(rowId);
      });
    }
    return docs.length > 1 ? docs : [];
  }

  async updateShare(
    shareId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      includeChildren = null,
      excludedDocIds = null,
      background = false,
      controller = null,
      autoUpdateExpectedChangeSeq = null,
    } = {},
  ) {
    const t = this.t.bind(this);
    const shareIdKey = String(shareId || "").trim();
    if (!shareIdKey) throw new Error(t("siyuanShare.error.missingShareId"));
    const isManual = !background;
    let manualRuntimeSnapshot = null;
    if (!background) {
      manualRuntimeSnapshot = this.captureAutoUpdateRuntimeSnapshotForShare(shareIdKey);
      // If this share is currently being auto-updated, always mark as manually aborted
      // (even if controller is already aborted by a prior rapid manual update)
      if (this.autoUpdateCurrentShareId === shareIdKey) {
        this.autoUpdateAbortByManualSet.add(shareIdKey);
        if (
          this.autoUpdateCurrentController &&
          !this.autoUpdateCurrentController.signal?.aborted
        ) {
          try {
            this.autoUpdateCurrentController.abort();
          } catch {
            // ignore
          }
        }
      } else {
        this.autoUpdateAbortByManualSet.delete(shareIdKey);
      }
      this.suspendAutoUpdateRuntimeForShare(shareIdKey);
    }
    const existing = this.getShareById(shareIdKey);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    const option = this.getShareOptionValue(existing.id, {
      fallbackIncludeChildren: typeof existing?.includeChildren === "boolean" ? existing.includeChildren : false,
    });
    const excludedDocIdsValue = Array.isArray(excludedDocIds)
      ? normalizeDocIdList(excludedDocIds)
      : normalizeDocIdList(option?.excludedDocIds || existing?.excludedDocIds || []);
    const currentSlug = normalizeShareSlugInput(existing?.slug || "");
    const requestedSlug = normalizeShareSlugInput(slugOverride);
    const slugOverrideValue = requestedSlug && requestedSlug !== currentSlug ? requestedSlug : "";
    try {
      if (existing.type === SHARE_TYPES.NOTEBOOK) {
        await this.shareNotebook(existing.notebookId, {
          slugOverride: slugOverrideValue,
          password,
          clearPassword,
          expiresAt,
          clearExpires,
          visitorLimit,
          clearVisitorLimit,
          excludedDocIds: excludedDocIdsValue,
          allowRequestError: false,
          background,
          controller,
          autoUpdateExpectedChangeSeq,
        });
      } else {
        const includeChildrenValue =
          typeof includeChildren === "boolean"
            ? includeChildren
            : typeof option?.includeChildren === "boolean"
              ? option.includeChildren
              : !!existing.includeChildren;
        await this.shareDoc(existing.docId, {
          slugOverride: slugOverrideValue,
          password,
          clearPassword,
          expiresAt,
          clearExpires,
          visitorLimit,
          clearVisitorLimit,
          includeChildren: includeChildrenValue,
          excludedDocIds: excludedDocIdsValue,
          allowRequestError: false,
          background,
          controller,
          autoUpdateExpectedChangeSeq,
        });
      }
    } catch (err) {
      if (isManual) {
        this.restoreAutoUpdateRuntimeSnapshotForShare(shareIdKey, manualRuntimeSnapshot);
        this.autoUpdateAbortByManualSet.delete(shareIdKey);
      }
      throw err;
    }
    this.clearAutoUpdateRetryState(shareIdKey);
    if (isManual) {
      this.markAutoUpdateManualSuccess(shareIdKey);
      this.suspendAutoUpdateRuntimeForShare(shareIdKey, {clearRetry: true, clearSyncing: true});
      this.autoUpdateAbortByManualSet.delete(shareIdKey);
    }
  }

  async updateShareAccess(
    shareId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    const controller = new AbortController();
    const progress = this.openProgressDialog(t("siyuanShare.progress.requesting"), controller);
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({controller, progress});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const payload = {shareId: existing.id};
      const currentSlug = normalizeShareSlugInput(existing?.slug || "");
      const requestedSlugRaw = normalizeShareSlugInput(slugOverride);
      if (requestedSlugRaw && requestedSlugRaw !== currentSlug) {
        payload.slug = this.normalizeShareSlugOverrideOrThrow(requestedSlugRaw);
      }
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      progress.update(t("siyuanShare.progress.requesting"));
      await this.remoteRequest(REMOTE_API.shareAccessUpdate, {
        method: "POST",
        body: payload,
        progressText: t("siyuanShare.progress.requesting"),
        controller,
        progress,
      });
      progress.update(t("siyuanShare.progress.syncingShareList"));
      await this.syncRemoteShares({silent: true, controller, progress});
      await this.updateSharePasswordCache(existing.id, {password, clearPassword});
      this.renderSettingCurrent();
      this.notify(t("siyuanShare.message.accessUpdated"));
    } finally {
      progress?.close();
    }
  }

  async deleteShare(shareId) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));

    // Abort any in-progress auto-update for this share to avoid concurrent operations
    if (this.autoUpdateCurrentShareId === shareId) {
      this.autoUpdateAbortByManualSet.add(shareId);
      if (this.autoUpdateCurrentController && !this.autoUpdateCurrentController.signal?.aborted) {
        try {
          this.autoUpdateCurrentController.abort();
        } catch {
          // ignore
        }
      }
    }
    // Remove from auto-update queue
    if (this.autoUpdateQueuedSet.has(shareId)) {
      this.autoUpdateQueue = this.autoUpdateQueue.filter((id) => id !== shareId);
      this.autoUpdateQueuedSet.delete(shareId);
    }
    this.autoUpdateRerunSet.delete(shareId);
    this.setAutoUpdateShareState(shareId, "");
    this.clearAutoUpdateRetryState(shareId);

    const ok = await new Promise((resolve) => {
      confirm(
        t("siyuanShare.confirm.deleteShareTitle"),
        t("siyuanShare.confirm.deleteShareMessage", {
          name: existing.title || existing.slug || existing.id,
        }),
        () => resolve(true),
        () => resolve(false),
      );
    });
    if (!ok) return;

    await this.verifyRemote();
    await this.remoteRequest(REMOTE_API.deleteShare, {
      method: "POST",
      body: {shareId: existing.id, hardDelete: true},
      progressText: t("siyuanShare.progress.deletingShare"),
    });
    await this.syncRemoteShares({silent: true});
    const key = String(existing.id || "");
    if (key && Object.prototype.hasOwnProperty.call(this.shareOptions, key)) {
      delete this.shareOptions[key];
      await this.saveData(STORAGE_SHARE_OPTIONS, this.shareOptions);
    }
    if (key && Object.prototype.hasOwnProperty.call(this.autoUpdateStructDigestByShare || {}, key)) {
      delete this.autoUpdateStructDigestByShare[key];
      this.schedulePersistAutoUpdateRuntime();
    }
    if (key && Object.prototype.hasOwnProperty.call(this.autoUpdateShareChangeSeqById || {}, key)) {
      delete this.autoUpdateShareChangeSeqById[key];
    }
    if (key && Object.prototype.hasOwnProperty.call(this.autoUpdateQuietDeadlineByShare || {}, key)) {
      delete this.autoUpdateQuietDeadlineByShare[key];
      delete this.autoUpdateQuietFirstEnteredByShare[key];
    }
    if (key) {
      this.autoUpdateQuietPendingSet.delete(key);
      this.scheduleAutoUpdateQuietFlush();
    }
    if (key) {
      this.autoUpdateAbortByQuietSet.delete(key);
    }
    if (key) {
      this.autoUpdateAbortByManualSet.delete(key);
    }
    if (key) {
      this.autoUpdateAbortByNotebookClosedSet.delete(key);
    }
    if (key) {
      this.autoUpdateManualSkipDetectSet.delete(key);
      this.autoUpdateManualSkipRealtimeOnceSet.delete(key);
    }
    if (key) {
      await this.clearIncrementalCursor(key);
      await this.clearDocBlockCountCache(key);
      this.setAutoUpdateShareState(key, "");
    }
    if (existing?.type === SHARE_TYPES.DOC && isValidDocId(existing?.docId)) {
      await this.removeExportRetryCacheForTarget({
        type: SHARE_TYPES.DOC,
        targetId: String(existing.docId || ""),
        siteId: this.getActiveSiteId(),
      });
    } else if (existing?.type === SHARE_TYPES.NOTEBOOK && isValidNotebookId(existing?.notebookId)) {
      await this.removeExportRetryCacheForTarget({
        type: SHARE_TYPES.NOTEBOOK,
        targetId: String(existing.notebookId || ""),
        siteId: this.getActiveSiteId(),
      });
    }
    this.renderSettingCurrent();
    this.notify(t("siyuanShare.message.deleteSuccess"));
  }

  async copyShareLink(shareId) {
    const t = this.t.bind(this);
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    await this.verifyRemote();
    const url = this.getShareUrl(existing);
    if (!url) throw new Error(t("siyuanShare.error.shareLinkEmpty"));
    await this.tryCopyToClipboard(url);
    this.notify(t("siyuanShare.message.copyLinkSuccess"));
  }

  buildShareInfoText(share, titleOverride = "") {
    const t = this.t.bind(this);
    const titleRaw = String(titleOverride || share?.title || "").trim();
    const title = titleRaw || t("siyuanShare.label.untitled");
    const lines = [t("siyuanShare.copyInfo.title", {title})];
    const url = this.getShareUrl(share);
    if (url) lines.push(t("siyuanShare.copyInfo.link", {value: url}));
    const password = String(share?.password || "").trim();
    if (password) lines.push(t("siyuanShare.copyInfo.password", {value: password}));
    const expiresAt = normalizeTimestampMs(share?.expiresAt || 0);
    if (expiresAt) lines.push(t("siyuanShare.copyInfo.expiresAt", {value: this.formatTime(expiresAt)}));
    const visitorLimitValue = Number.isFinite(Number(share?.visitorLimit))
      ? Math.max(0, Math.floor(Number(share.visitorLimit)))
      : 0;
    if (visitorLimitValue > 0) {
      lines.push(t("siyuanShare.copyInfo.visitorLimit", {count: visitorLimitValue}));
    }
    return lines.join("\n");
  }

  async copyShareInfo(shareId, {title = ""} = {}) {
    const t = this.t.bind(this);
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    const text = this.buildShareInfoText(existing, title);
    await this.tryCopyToClipboard(text);
    this.notify(t("siyuanShare.message.copyShareInfoSuccess"));
  }

  drawQRCode(canvas, url, styleId) {
    const qr = SPS_QR.generate(url);
    if (!qr) return;
    const style = SPS_QR_STYLES.find(s => s.id === styleId) || SPS_QR_STYLES[0];
    const {modules, size: qrSize} = qr;
    const quiet = 4;
    const totalModules = qrSize + quiet * 2;
    const scale = Math.floor(840 / totalModules);
    const canvasSize = scale * totalModules;
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    let fgColor = style.fg || "#000000";
    if (style.gradientStart && style.gradientEnd) {
      const grad = ctx.createLinearGradient(0, 0, canvasSize, canvasSize);
      grad.addColorStop(0, style.gradientStart);
      grad.addColorStop(1, style.gradientEnd);
      fgColor = grad;
    }
    const isFinderModule = (r, c) => {
      if (r < 7 && c < 7) return true;
      if (r < 7 && c >= qrSize - 7) return true;
      if (r >= qrSize - 7 && c < 7) return true;
      return false;
    };
    ctx.fillStyle = fgColor;
    for (let r = 0; r < qrSize; r++) {
      for (let c = 0; c < qrSize; c++) {
        if (!modules[r][c]) continue;
        if (isFinderModule(r, c)) continue;
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    const drawRoundRect = (x, y, w, h, rad, color) => {
      ctx.fillStyle = color;
      if (rad <= 0) { ctx.fillRect(x, y, w, h); return; }
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.lineTo(x + w - rad, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
      ctx.lineTo(x + w, y + h - rad);
      ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
      ctx.lineTo(x + rad, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
      ctx.lineTo(x, y + rad);
      ctx.quadraticCurveTo(x, y, x + rad, y);
      ctx.fill();
    };
    const drawFinder = (startR, startC) => {
      const ox = (startC + quiet) * scale;
      const oy = (startR + quiet) * scale;
      const ff = style.finderFg || (typeof fgColor === "string" ? fgColor : "#000000");
      const rad = (style.finderRadius || 0) * scale;
      drawRoundRect(ox, oy, 7 * scale, 7 * scale, rad, ff);
      drawRoundRect(ox + scale, oy + scale, 5 * scale, 5 * scale, rad * 0.7, style.bg);
      drawRoundRect(ox + 2 * scale, oy + 2 * scale, 3 * scale, 3 * scale, rad * 0.5, ff);
    };
    drawFinder(0, 0);
    drawFinder(0, qrSize - 7);
    drawFinder(qrSize - 7, 0);
  }

  showQRCodeDialog(url) {
    if (!url) return;
    const t = this.t.bind(this);
    let styleIndex = 0;
    const total = SPS_QR_STYLES.length;
    const canvasSize = 840;
    const renderContent = () => {
      return `<div class="sps-qr-dialog">
  <span class="sps-qr-nav-btn" data-action="qr-prev">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
  </span>
  <div class="sps-qr-center">
    <div class="sps-qr-preview">
      <canvas id="sps-qr-canvas" width="${canvasSize}" height="${canvasSize}"></canvas>
    </div>
    <span class="sps-qr-nav-index">${styleIndex + 1} / ${total}</span>
  </div>
  <span class="sps-qr-nav-btn" data-action="qr-next">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
  </span>
</div>
<div class="b3-dialog__action" style="justify-content: center;">
  <button class="b3-button b3-button--outline" data-action="download-qr">${escapeHtml(t("siyuanShare.qr.download"))}</button>
</div>`;
    };
    const content = `<div class="sps-qr-dialog-content">${renderContent()}</div>`;
    const redraw = (root) => {
      const canvas = root?.querySelector?.("#sps-qr-canvas");
      if (canvas) this.drawQRCode(canvas, url, SPS_QR_STYLES[styleIndex].id);
    };
    const updateView = () => {
      const contentEl = dlg?.element?.querySelector?.(".sps-qr-dialog-content");
      if (contentEl) { contentEl.innerHTML = renderContent(); redraw(dlg.element); }
    };
    const onClick = (event) => {
      if (event.target.closest("[data-action='qr-prev']")) {
        styleIndex = (styleIndex - 1 + total) % total;
        updateView();
        return;
      }
      if (event.target.closest("[data-action='qr-next']")) {
        styleIndex = (styleIndex + 1) % total;
        updateView();
        return;
      }
      if (event.target.closest("[data-action='download-qr']")) {
        const canvas = dlg?.element?.querySelector?.("#sps-qr-canvas");
        if (!canvas) return;
        const link = document.createElement("a");
        link.download = "qrcode.png";
        link.href = canvas.toDataURL("image/png");
        link.click();
        return;
      }
    };
    const dlg = new Dialog({
      title: t("siyuanShare.qr.title"),
      content,
      width: "min(420px, 90vw)",
      destroyCallback: () => {
        dlg.element.removeEventListener("click", onClick);
      },
    });
    dlg.element.addEventListener("click", onClick);
    redraw(dlg.element);
  }

  collectSharePasswords(shares) {
    const map = {};
    if (!Array.isArray(shares)) return map;
    shares.forEach((share) => {
      const id = share?.id;
      if (!id) return;
      const password = String(share?.password || "").trim();
      if (password) map[String(id)] = password;
    });
    return map;
  }

  applySharePasswords(shares, passwordMap) {
    if (!Array.isArray(shares)) return [];
    if (!passwordMap || Object.keys(passwordMap).length === 0) return shares;
    return shares.map((share) => {
      const password = passwordMap[String(share?.id)] || "";
      if (!password) return share;
      return {...share, password};
    });
  }

  applyShareOptions(shares) {
    if (!Array.isArray(shares)) return shares;
    const optionMap = this.normalizeShareOptionsMap(this.shareOptions || {});
    let changed = false;
    const nextShares = shares.map((share) => {
      const id = share?.id;
      if (!id) return share;
      const key = String(id);
      const hasRemoteIncludeChildren = typeof share?.includeChildren === "boolean";
      const hasRemoteExcluded =
        share && Object.prototype.hasOwnProperty.call(share, "excludedDocIds");
      const option = this.normalizeShareOptionValue(optionMap[key], {
        fallbackIncludeChildren: hasRemoteIncludeChildren ? !!share.includeChildren : false,
      });
      const includeChildren = hasRemoteIncludeChildren
        ? !!share.includeChildren
        : !!option?.includeChildren;
      const excludedDocIds = hasRemoteExcluded
        ? normalizeDocIdList(share?.excludedDocIds || [])
        : normalizeDocIdList(option?.excludedDocIds || []);
      const nextOption = this.normalizeShareOptionValue(
        {
          includeChildren,
          excludedDocIds,
        },
        {fallbackIncludeChildren: includeChildren},
      );
      const prevOption = this.normalizeShareOptionValue(optionMap[key], {
        fallbackIncludeChildren: includeChildren,
      });
      const sameInclude = !!prevOption?.includeChildren === !!nextOption?.includeChildren;
      const sameExcluded =
        JSON.stringify(prevOption?.excludedDocIds || []) === JSON.stringify(nextOption?.excludedDocIds || []);
      if (!sameInclude || !sameExcluded) {
        optionMap[key] = nextOption;
        changed = true;
      }
      const needPatchInclude = !hasRemoteIncludeChildren;
      const needPatchExcluded =
        !hasRemoteExcluded ||
        JSON.stringify(normalizeDocIdList(share?.excludedDocIds || [])) !== JSON.stringify(excludedDocIds);
      if (!needPatchInclude && !needPatchExcluded) return share;
      return {
        ...share,
        ...(needPatchInclude ? {includeChildren} : {}),
        ...(needPatchExcluded ? {excludedDocIds} : {}),
      };
    });
    const existingIds = new Set(
      shares.map((share) => String(share?.id || "")).filter((id) => id !== ""),
    );
    let cleaned = false;
    Object.keys(optionMap).forEach((key) => {
      if (!existingIds.has(String(key))) {
        delete optionMap[key];
        cleaned = true;
      }
    });
    if (cleaned || changed || this.shareOptions !== optionMap) {
      this.shareOptions = optionMap;
    }
    return nextShares;
  }

  async updateSharePasswordCache(shareId, {password = "", clearPassword = false} = {}) {
    const targetId = String(shareId || "");
    if (!targetId) return;
    const nextPassword = clearPassword ? "" : String(password || "").trim();
    if (!nextPassword && !clearPassword) return;
    const updateList = (list) => {
      if (!Array.isArray(list)) return list;
      let changed = false;
      const nextList = list.map((share) => {
        if (String(share?.id) !== targetId) return share;
        if (clearPassword) {
          if (!share || !("password" in share)) return share;
          const next = {...share};
          delete next.password;
          changed = true;
          return next;
        }
        if (nextPassword && share?.password !== nextPassword) {
          changed = true;
          return {...share, password: nextPassword};
        }
        return share;
      });
      return changed ? nextList : list;
    };
    this.shares = updateList(this.shares);
    const activeSiteId = String(this.settings.activeSiteId || "");
    if (!activeSiteId) return;
    if (Array.isArray(this.siteShares?.[activeSiteId])) {
      const updated = updateList(this.siteShares[activeSiteId]);
      if (updated !== this.siteShares[activeSiteId]) {
        this.siteShares[activeSiteId] = updated;
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
    }
  }

  async tryCopyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  formatTime(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  getRemoteHeaders() {
    const key = String(this.settings.apiKey || "").trim();
    if (!key) return {};
    return {"X-Api-Key": key};
  }

  async remoteRequest(
    path,
    {
      method = "POST",
      body,
      isForm = false,
      progressText = "",
      controller = null,
      progress = null,
      silent = false,
    } = {},
  ) {
    const t = this.t.bind(this);
    const base = normalizeUrlBase(this.settings.siteUrl);
    if (!base) throw new Error(t("siyuanShare.error.siteUrlRequired"));
    const headers = {...this.getRemoteHeaders()};
    if (!headers["X-Api-Key"]) throw new Error(t("siyuanShare.error.apiKeyRequired"));
    if (!isForm && method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    const options = {
      method,
      headers,
    };
    if (body != null && method !== "GET") {
      options.body = isForm ? body : JSON.stringify(body);
    }
    const requestController = controller || new AbortController();
    options.signal = requestController.signal;
    const ownsProgress = !progress && !silent;
    const handle = progress || (ownsProgress
      ? this.openProgressDialog(progressText || t("siyuanShare.progress.requesting"), requestController)
      : null);
    if (!silent && progressText && handle?.update) {
      handle.update(progressText);
    }
    try {
      const resp = await fetch(`${base}${path}`, options);
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.code !== 0) {
        const message = this.resolveRemoteErrorMessage(json, resp.status);
        const error = new Error(message);
        error.status = resp.status;
        error.code = typeof json?.code !== "undefined" ? json.code : resp.status;
        error.data = json?.data;
        error.response = json;
        throw error;
      }
      return json.data;
    } catch (err) {
      if (err?.name === "AbortError") {
        throw createAbortError(t("siyuanShare.message.cancelled"));
      }
      throw err;
    } finally {
      if (ownsProgress) {
        handle?.close();
      }
    }
  }

  async verifyRemote({silent = false, controller = null, progress = null, background = false} = {}) {
    const t = this.t.bind(this);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      if (!silent) throw new Error(t("siyuanShare.error.siteAndKeyRequired"));
      return null;
    }
    if (this.remoteUser && this.remoteVerifiedAt && nowTs() - this.remoteVerifiedAt < 60000) {
      return {user: this.remoteUser, limits: this.remoteUploadLimits, features: this.remoteFeatures};
    }
    const data = await this.remoteRequest(REMOTE_API.verify, {
      method: "POST",
      body: {},
      progressText: background ? "" : t("siyuanShare.progress.verifyingSite"),
      controller,
      progress,
      silent: background,
    });
    this.remoteUser = this.normalizeRemoteUser(data?.user);
    this.remoteUploadLimits = this.normalizeUploadLimits(data?.limits);
    this.remoteFeatures = this.normalizeRemoteFeatures(data?.features);
    this.remoteVerifiedAt = nowTs();
    await this.persistActiveRemoteStatus();
    this.syncSettingInputs();
    return data;
  }

  async syncRemoteShares(
    {
      silent = false,
      controller = null,
      progress = null,
      background = false,
      skipAutoUpdateStructureReconcile = false,
    } = {},
  ) {
    const t = this.t.bind(this);
    const data = await this.remoteRequest(REMOTE_API.shares, {
      method: "GET",
      progressText: background ? "" : t("siyuanShare.progress.syncingShareList"),
      controller,
      progress,
      silent: background,
    });
    const activeSiteId = String(this.settings.activeSiteId || "");
    const rawShares = Array.isArray(data?.shares) ? data.shares : [];
    const passwordMap = activeSiteId ? this.collectSharePasswords(this.siteShares?.[activeSiteId]) : {};
    const withPasswords = this.applySharePasswords(rawShares, passwordMap);
    const shares = this.applyShareOptions(withPasswords);
    this.shares = shares;
    (Array.isArray(shares) ? shares : []).forEach((share) => {
      const shareId = String(share?.id || "").trim();
      const notebookId = String(share?.notebookId || "").trim();
      if (!shareId || !isValidNotebookId(notebookId)) return;
      this.setAutoUpdateShareNotebookHint(shareId, notebookId);
    });
    this.pruneAutoUpdateShareStates();
    if (activeSiteId) {
      this.siteShares[activeSiteId] = shares;
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      await this.pruneIncrementalCursor(shares.map((share) => share?.id));
      await this.pruneDocBlockCountCache(shares.map((share) => share?.id));
    }
    if (this.shareOptions) {
      await this.saveData(STORAGE_SHARE_OPTIONS, this.shareOptions);
    }
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.refreshDocTreeMarks();
    this.updateTopBarState();
    if (!background && !skipAutoUpdateStructureReconcile && this.isAutoUpdateEnabledForActiveSite()) {
      this.scheduleAutoUpdateStructureReconcile({immediate: false, reset: true});
    }
    if (!silent) this.notify(t("siyuanShare.message.verifySuccess"));
    return shares;
  }

  async trySyncRemoteShares({silent = false} = {}) {
    if (!this.settings.siteUrl || !this.settings.apiKey) return;
    try {
      await this.verifyRemote({silent: true});
      await this.syncRemoteShares({silent});
    } catch (err) {
      if (!silent) this.showErr(err);
    }
  }

  async disconnectRemote() {
    const t = this.t.bind(this);
    const activeSiteId = String(this.settings.activeSiteId || "");
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.remoteUploadLimits = null;
    this.remoteFeatures = null;
    await this.persistActiveRemoteStatus({clear: true});
    this.shares = [];
    if (activeSiteId) {
      this.siteShares[activeSiteId] = [];
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.updateTopBarState();
    this.refreshAutoUpdateLoop({immediate: false});
    this.notify(t("siyuanShare.message.disconnected"));
  }

  async fetchNotebooks() {
    const resp = await fetchSyncPost("/api/notebook/lsNotebooks", {});
    if (!resp || resp.code !== 0) throw new Error(resp?.msg || this.t("siyuanShare.error.notebookListFailed"));
    return resp?.data?.notebooks || [];
  }

  getNotebookRowId(notebookRow) {
    const id = String(notebookRow?.id || notebookRow?.box || notebookRow?.notebookId || "").trim();
    return isValidNotebookId(id) ? id : "";
  }

  isNotebookClosedRow(notebookRow) {
    if (!notebookRow || typeof notebookRow !== "object") return false;
    if (notebookRow.closed === true || notebookRow.isClosed === true) return true;
    if (typeof notebookRow.opened === "boolean") return notebookRow.opened === false;
    return false;
  }

  isNotebookClosedForAutoUpdateFromRows(notebookId, notebooks) {
    const id = String(notebookId || "").trim();
    if (!isValidNotebookId(id)) return false;
    const row = (Array.isArray(notebooks) ? notebooks : []).find((item) => this.getNotebookRowId(item) === id);
    if (!row) return false;
    return this.isNotebookClosedRow(row);
  }

  async getAutoUpdateShareNotebookId(share, {controller = null} = {}) {
    if (!share || typeof share !== "object") return "";
    const shareId = String(share?.id || "").trim();
    const direct = String(share?.notebookId || "").trim();
    if (isValidNotebookId(direct)) {
      if (shareId) this.setAutoUpdateShareNotebookHint(shareId, direct);
      return direct;
    }
    const hinted = this.getAutoUpdateShareNotebookHint(shareId);
    if (isValidNotebookId(hinted)) return hinted;
    const docId = String(share?.docId || "").trim();
    if (!isValidDocId(docId)) return "";
    throwIfAborted(controller, this.t("siyuanShare.message.cancelled"));
    const row = await this.fetchBlockRow(docId);
    const rowNotebookId = String(row?.box || row?.notebookId || "").trim();
    if (isValidNotebookId(rowNotebookId)) {
      if (shareId) this.setAutoUpdateShareNotebookHint(shareId, rowNotebookId);
      return rowNotebookId;
    }
    return "";
  }

  async refreshNotebookStateForAutoUpdate({force = false} = {}) {
    const cached = Array.isArray(this.notebooks) ? this.notebooks : [];
    const now = nowTs();
    const isFresh = this.notebooksFetchedAt > 0 && now - this.notebooksFetchedAt <= AUTO_UPDATE_NOTEBOOK_CACHE_TTL_MS;
    if (!force && isFresh) return cached;
    if (
      force &&
      this.notebooksFetchedAt > 0 &&
      now - this.notebooksFetchedAt <= AUTO_UPDATE_NOTEBOOK_FORCE_MIN_INTERVAL_MS
    ) {
      return cached;
    }
    if (this.notebookRefreshPromise) return this.notebookRefreshPromise;
    this.notebookRefreshPromise = (async () => {
      try {
        const notebooks = await this.fetchNotebooks();
        this.notebooks = Array.isArray(notebooks) ? notebooks : [];
        this.notebooksFetchedAt = nowTs();
      } catch (err) {
        console.warn("refresh notebook state for auto-update failed", err);
      } finally {
        this.notebookRefreshPromise = null;
      }
      return Array.isArray(this.notebooks) ? this.notebooks : [];
    })();
    return this.notebookRefreshPromise;
  }

  async isNotebookClosedForAutoUpdate(notebookId, {forceRefresh = false} = {}) {
    const id = String(notebookId || "").trim();
    if (!isValidNotebookId(id)) return false;
    const notebooks = await this.refreshNotebookStateForAutoUpdate({force: forceRefresh});
    return this.isNotebookClosedForAutoUpdateFromRows(id, notebooks);
  }

  async refreshNotebookOptions({silent = false} = {}) {
    const t = this.t.bind(this);
    try {
      this.notebooks = await this.fetchNotebooks();
      this.notebooksFetchedAt = nowTs();
      if (!silent) this.notify(t("siyuanShare.message.notebookListRefreshed"));
    } catch (err) {
      if (!silent) this.showErr(err);
    }
  }

  async exportDocMarkdown(docId) {
    const resp = await fetchSyncPost("/api/export/exportMdContent", {id: docId});
    if (!resp || resp.code !== 0) throw new Error(resp?.msg || this.t("siyuanShare.error.exportMarkdownFailed"));
    return {
      hPath: resp?.data?.hPath || "",
      content: resp?.data?.content || "",
    };
  }

  async ensureWorkspaceDir() {
    if (this.workspaceDir) return this.workspaceDir;
    try {
      const wsInfo = await fetchSyncPost("/api/system/getWorkspaceInfo", {});
      if (wsInfo && wsInfo.code === 0 && wsInfo.data?.workspaceDir) {
        this.workspaceDir = String(wsInfo.data.workspaceDir);
        return this.workspaceDir;
      }
    } catch (err) {
      // ignore
    }
    return this.workspaceDir;
  }

  async fetchEmojiAssetBlob(assetPath, controller, notebookId = "") {
    const t = this.t.bind(this);
    const normalized = normalizeAssetPath(assetPath);
    if (!normalized) throw new Error(t("siyuanShare.error.resourcePathInvalid"));
    const candidates = [];
    if (DOC_ICON_IMAGE_EXT_RE.test(normalized)) {
      candidates.push(normalized);
    } else {
      candidates.push(normalized);
      EMOJI_IMAGE_EXTENSIONS.forEach((ext) => candidates.push(`${normalized}.${ext}`));
    }
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        return await this.fetchAssetBlob(candidate, controller, notebookId);
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastErr = err;
      }
    }
    if (this.hasNodeFs) {
      const wsDir = await this.ensureWorkspaceDir();
      if (wsDir) {
        for (const candidate of candidates) {
          const clean = candidate.replace(/^[\\/]+/, "");
          const rel = clean.startsWith("emojis/") ? clean.slice("emojis/".length) : clean;
          const fsCandidates = new Set([
            joinFsPath(wsDir, "data", clean),
            joinFsPath(wsDir, "data", "emojis", rel),
            joinFsPath(wsDir, clean),
            joinFsPath(wsDir, "emojis", rel),
          ]);
          for (const fsPath of fsCandidates) {
            try {
              const stat = await fs.promises.stat(fsPath);
              if (!stat || !stat.isFile()) continue;
              const buf = await fs.promises.readFile(fsPath);
              const blob = new Blob([buf]);
              return {path: clean, blob};
            } catch (err) {
              if (isAbortError(err)) throw err;
              lastErr = err;
            }
          }
        }
      }
    }
    throw lastErr || new Error(t("siyuanShare.error.resourceDownloadFailed", {status: 404}));
  }

  async fetchAssetBlob(assetPath, controller, notebookId = "") {
    const t = this.t.bind(this);
    const normalized = normalizeAssetPath(assetPath);
    if (!normalized) throw new Error(t("siyuanShare.error.resourcePathInvalid"));
    const candidates = new Set();
    const appendCandidates = (value) => {
      const cleaned = normalizeAssetPath(value);
      if (!cleaned) return;
      if (cleaned.startsWith("data/")) {
        candidates.add(cleaned);
        return;
      }
      if (cleaned.startsWith("emojis/")) {
        candidates.add(`data/${cleaned}`);
        candidates.add(cleaned);
        return;
      }
      if (cleaned.startsWith("assets/")) {
        candidates.add(`data/${cleaned}`);
        if (isValidNotebookId(notebookId)) {
          candidates.add(`data/${notebookId}/${cleaned}`);
        }
        return;
      }
      candidates.add(`data/${cleaned}`);
    };
    appendCandidates(normalized);
    const decoded = tryDecodeAssetPath(normalized);
    if (decoded) {
      const decodedNormalized = normalizeAssetPath(decoded);
      if (decodedNormalized && decodedNormalized !== normalized) {
        appendCandidates(decodedNormalized);
      }
    }
    let lastErr = null;
    for (const workspacePath of candidates) {
      let resp;
      try {
        resp = await fetch("/api/file/getFile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({path: `/${workspacePath}`}),
          signal: controller?.signal,
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new Error(t("siyuanShare.error.resourceDownloadCanceled"));
        }
        lastErr = err;
        continue;
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        lastErr = new Error(err?.msg || t("siyuanShare.error.resourceDownloadFailed", {status: resp.status}));
        continue;
      }
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await resp.clone().json().catch(() => null);
        if (data && typeof data.code !== "undefined" && data.code !== 0) {
          lastErr = new Error(data?.msg || t("siyuanShare.error.resourceDownloadFailed", {status: resp.status}));
          continue;
        }
      }
      const blob = await resp.blob();
      return {path: normalized, blob};
    }
    throw lastErr || new Error(t("siyuanShare.error.resourceDownloadFailed", {status: 500}));
  }

  async fetchIconUrlBlob(url, controller) {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        ...getAuthHeaders(),
      },
      credentials: "same-origin",
      signal: controller?.signal,
    });
    if (!resp.ok) {
      throw new Error(`Icon download failed (${resp.status})`);
    }
    const contentType = resp.headers.get("content-type") || "";
    const blob = await resp.blob();
    return {blob, contentType};
  }

  async prepareMarkdownAssets(markdown, controller, notebookId = "", options = {}) {
    const t = this.t.bind(this);
    const cancelledMsg = t("siyuanShare.error.resourceDownloadCanceled");
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
    const maxConcurrency = normalizePositiveInt(
      options?.concurrency,
      DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY,
    );
    const reportProgress = (current, total, stage = "asset") => {
      if (!onProgress) return;
      try {
        onProgress({
          current: Math.max(0, Math.floor(Number(current) || 0)),
          total: Math.max(0, Math.floor(Number(total) || 0)),
          stage: String(stage || "asset"),
        });
      } catch {
        // ignore
      }
    };
    let fixed = rewriteAssetLinks(markdown || "");
    const assets = [];
    const failures = [];
    const renameMap = new Map();
    const usedUploadPaths = new Set();
    const seenPaths = new Set();
    const preloadedAssets = new Map();

    const emojiTokenNames = Array.from(collectEmojiTokenNames(fixed));
    if (emojiTokenNames.length > 0) {
      const tokenMap = new Map();
      const resolvedPathMap = new Map();
      const emojiResults = new Array(emojiTokenNames.length).fill(null);
      let emojiDone = 0;
      reportProgress(0, emojiTokenNames.length, "emoji");
      const emojiTasks = emojiTokenNames.map((name, index) => async () => {
        try {
          throwIfAborted(controller, t("siyuanShare.message.cancelled"));
          const basePath = normalizeEmojiAssetPath(name, true);
          if (!basePath) return;
          const asset = await this.fetchEmojiAssetBlob(basePath, controller, notebookId);
          const resolvedPath = normalizeAssetPath(asset?.path || "") || normalizeAssetPath(basePath);
          if (!resolvedPath || !asset?.blob) return;
          emojiResults[index] = {name, resolvedPath, blob: asset.blob};
        } catch (err) {
          if (isAbortError(err) || err?.message === cancelledMsg) {
            throw err;
          }
          emojiResults[index] = null;
        } finally {
          emojiDone += 1;
          reportProgress(emojiDone, emojiTokenNames.length, "emoji");
        }
      });
      await runTasksWithConcurrency(
        emojiTasks,
        this.getPrepareAssetsConcurrency(emojiTokenNames.length, maxConcurrency),
      );
      for (const item of emojiResults) {
        if (!item) continue;
        let uploadPath = resolvedPathMap.get(item.resolvedPath);
        if (!uploadPath) {
          uploadPath = sanitizeAssetUploadPath(item.resolvedPath, usedUploadPaths) || normalizeAssetPath(item.resolvedPath);
          if (!uploadPath) continue;
          resolvedPathMap.set(item.resolvedPath, uploadPath);
        }
        if (!seenPaths.has(uploadPath)) {
          assets.push({path: uploadPath, blob: item.blob});
          seenPaths.add(uploadPath);
          preloadedAssets.set(uploadPath, item.blob);
        }
        tokenMap.set(item.name, `![](<${uploadPath}>)`);
      }
      if (tokenMap.size > 0) {
        fixed = replaceCustomEmojiTokens(fixed, tokenMap);
      }
    }

    fixed = insertAdjacentEmojiImageSpacing(fixed);
    const assetPaths = extractAssetPaths(fixed);
    const assetPlans = [];
    for (const path of assetPaths) {
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const uploadPath = usedUploadPaths.has(path)
        ? path
        : sanitizeAssetUploadPath(path, usedUploadPaths) || normalizeAssetPath(path);
      if (uploadPath && uploadPath !== path) {
        renameMap.set(path, uploadPath);
      }
      assetPlans.push({
        path,
        uploadPath: uploadPath || normalizeAssetPath(path) || path,
      });
    }

    const assetResults = new Array(assetPlans.length).fill(null);
    let assetDone = 0;
    reportProgress(0, assetPlans.length, "asset");
    const assetTasks = assetPlans.map((plan, index) => async () => {
      try {
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        const blob = preloadedAssets.has(plan.path)
          ? preloadedAssets.get(plan.path)
          : (await this.fetchAssetBlob(plan.path, controller, notebookId)).blob;
        assetResults[index] = {blob, uploadPath: plan.uploadPath, path: plan.path};
      } catch (err) {
        if (isAbortError(err) || err?.message === cancelledMsg) {
          throw err;
        }
        assetResults[index] = {error: err, path: plan.path};
      } finally {
        assetDone += 1;
        reportProgress(assetDone, assetPlans.length, "asset");
      }
    });
    await runTasksWithConcurrency(
      assetTasks,
      this.getPrepareAssetsConcurrency(assetPlans.length, maxConcurrency),
    );
    for (let i = 0; i < assetResults.length; i += 1) {
      const item = assetResults[i];
      const plan = assetPlans[i];
      if (!item || !plan) continue;
      if (item.error) {
        failures.push({path: plan.path, err: item.error});
        continue;
      }
      if (!item.blob) continue;
      assets.push({path: item.uploadPath, blob: item.blob});
    }

    if (renameMap.size > 0) {
      for (const [from, to] of renameMap) {
        fixed = replaceAllText(fixed, from, to);
      }
    }
    if (failures.length > 0) {
      console.warn("Some assets failed to download.", failures);
    }
    return {markdown: fixed, assets, failures};
  }

  renderDock() {
    if (!this.dockElement) return;
    const t = this.t.bind(this);
    const siteUrl = this.settings.siteUrl || "";
    const apiKey = this.settings.apiKey || "";
    const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
    const activeSiteId = String(this.settings.activeSiteId || "");
    const siteOptions = sites
      .map((site, index) => {
        const id = String(site?.id || "");
        const label = this.getSiteOptionLabel(site, index);
        const selected = id && id === activeSiteId ? " selected" : "";
        return `<option value="${escapeAttr(id)}"${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");
    const displayName = this.remoteUser?.username || this.remoteUser?.name || "";
    const statusLabel = !siteUrl || !apiKey
      ? t("siyuanShare.hint.needSiteAndKey")
      : displayName
        ? t("siyuanShare.hint.statusConnectedUser", {
            user: escapeHtml(displayName),
          })
        : t("siyuanShare.hint.statusConnectedNoUser");
    const autoUpdateStatusLabel = this.getAutoUpdateSummaryLabel();
    const rows = this.shares
      .map((s) => {
        const url = this.getShareUrl(s);
        const typeLabel =
          s.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
        const idLabel = s.type === SHARE_TYPES.NOTEBOOK ? s.notebookId : s.docId;
        const visitorLimitValue = Number(s.visitorLimit) || 0;
        const visitorLabel =
          visitorLimitValue > 0
            ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
            : t("siyuanShare.label.visitorLimitNotSet");
        return `<tr>
  <td>
    <div>${escapeHtml(s.title || "")}</div>
    <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(idLabel || "")}</div>
  </td>
  <td class="siyuan-plugin-share__mono">${escapeHtml(typeLabel)}</td>
  <td>
    <div class="siyuan-plugin-share__mono">${escapeHtml(url)}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(visitorLabel)}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(this.formatTime(s.updatedAt))}</div>
  </td>
  <td>
    <div class="siyuan-plugin-share__actions">
      <span class="sps-qr-btn" data-action="show-qr" data-url="${escapeAttr(url)}" title="${escapeAttr(t("siyuanShare.qr.title"))}">${SPS_QR_ICON_SVG}</span>
      <button class="b3-button b3-button--outline" data-action="copy-link" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
      <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.update"))}</button>
      <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
      <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.delete"))}</button>
    </div>
  </td>
</tr>`;
      })
      .join("");

    this.dockElement.innerHTML = `
<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.connectionSettings"))}</div>
  <div class="siyuan-plugin-share__grid">
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.site"))}</div>
    <select id="sps-site-select" class="b3-select sps-site-select">
      ${siteOptions || `<option value="">${escapeHtml(t("siyuanShare.label.siteEmpty"))}</option>`}
    </select>
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.siteUrl"))}</div>
    <input id="sps-site" class="b3-text-field" placeholder="${escapeAttr(
      t("siyuanShare.placeholder.siteUrl"),
    )}" value="${escapeAttr(siteUrl)}" />
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.apiKey"))}</div>
    <input id="sps-apikey" type="password" class="b3-text-field" placeholder="${escapeAttr(
      t("siyuanShare.label.apiKey"),
    )}" value="${escapeAttr(apiKey)}" />
  </div>
  <div class="siyuan-plugin-share__actions">
    <button class="b3-button b3-button--outline" data-action="sync-remote">${escapeHtml(
      t("siyuanShare.action.verifySync"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="disconnect">${escapeHtml(
      t("siyuanShare.action.disconnect"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="auto-update-status">${escapeHtml(
      t("siyuanShare.action.autoUpdateStatus"),
    )}</button>
  </div>
  <div class="siyuan-plugin-share__muted">${statusLabel}</div>
  <div id="sps-auto-update-status" class="siyuan-plugin-share__muted">${escapeHtml(autoUpdateStatusLabel)}</div>
  <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.hint.checkApiKey"))}</div>
</div>

<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    t("siyuanShare.title.shareListCount", {count: this.shares.length}),
  )}</div>
  <table class="siyuan-plugin-share__table">
    <thead>
      <tr>
        <th style="width: 34%;">${escapeHtml(t("siyuanShare.label.title"))}</th>
        <th style="width: 14%;">${escapeHtml(t("siyuanShare.label.type"))}</th>
        <th style="width: 36%;">${escapeHtml(t("siyuanShare.label.link"))}</th>
        <th style="width: 16%;">${escapeHtml(t("siyuanShare.label.actions"))}</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="4" class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.message.noShareRecords"),
        )}</td></tr>`}
    </tbody>
  </table>
</div>
`;
    try {
      this.dockElement.removeEventListener("click", this.onDockClick);
      this.dockElement.removeEventListener("change", this.onDockChange);
      this.dockElement.addEventListener("click", this.onDockClick);
      this.dockElement.addEventListener("change", this.onDockChange);
    } catch {
      // ignore
    }
  }

  getAutoUpdateShareLabel(shareId) {
    const t = this.t.bind(this);
    const id = String(shareId || "").trim();
    if (!id) return t("siyuanShare.label.unknown");
    const share = this.getShareById(id);
    if (!share) return id;
    const title = String(share?.title || "").trim() || t("siyuanShare.label.untitled");
    const typeLabel =
      share?.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
    return `${title} (${typeLabel})`;
  }

  getAutoUpdateShareLogMeta(shareId) {
    const t = this.t.bind(this);
    const id = String(shareId || "").trim();
    if (!id) {
      return {
        shareId: "",
        typeLabel: t("siyuanShare.label.unknown"),
        title: t("siyuanShare.label.unknown"),
        targetId: "",
      };
    }
    const share = this.getShareById(id);
    if (!share) {
      return {
        shareId: id,
        typeLabel: t("siyuanShare.label.unknown"),
        title: t("siyuanShare.label.unknown"),
        targetId: id,
      };
    }
    const typeLabel =
      share?.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
    const title = String(share?.title || "").trim() || t("siyuanShare.label.untitled");
    const targetId =
      share?.type === SHARE_TYPES.NOTEBOOK
        ? String(share?.notebookId || "").trim()
        : String(share?.docId || "").trim();
    return {
      shareId: id,
      typeLabel,
      title,
      targetId: targetId || id,
    };
  }

  getAutoUpdateShareLogLabel(shareId) {
    const meta = this.getAutoUpdateShareLogMeta(shareId);
    return `${meta.typeLabel}:${meta.title} | id:${meta.targetId}`;
  }

  getTextDisplayWidth(text) {
    let width = 0;
    for (const ch of String(text || "")) {
      const code = ch.codePointAt(0) || 0;
      width += code <= 0x7f ? 1 : 2;
    }
    return width;
  }

  trimTextByDisplayWidth(text, maxWidth) {
    const input = String(text || "");
    const limit = Math.max(0, Math.floor(Number(maxWidth) || 0));
    if (!limit) return "";
    let width = 0;
    let out = "";
    for (const ch of input) {
      const code = ch.codePointAt(0) || 0;
      const step = code <= 0x7f ? 1 : 2;
      if (width + step > limit) break;
      out += ch;
      width += step;
    }
    return out;
  }

  padLogColumn(text, width, {truncate = true} = {}) {
    const input = String(text || "").replace(/\s+/g, " ").trim();
    const limit = Math.max(0, Math.floor(Number(width) || 0));
    if (!limit) return "";
    let content = input;
    let contentWidth = this.getTextDisplayWidth(content);
    if (truncate && contentWidth > limit) {
      const ellipsis = "...";
      const ellipsisWidth = this.getTextDisplayWidth(ellipsis);
      const keepWidth = Math.max(0, limit - ellipsisWidth);
      content = `${this.trimTextByDisplayWidth(content, keepWidth)}${ellipsis}`;
      contentWidth = this.getTextDisplayWidth(content);
    }
    const padWidth = Math.max(0, limit - contentWidth);
    return `${content}${" ".repeat(padWidth)}`;
  }

  pushAutoUpdateHistory(level, text, {shareId = "", detail = ""} = {}) {
    const message = String(text || "").trim();
    if (!message) return;
    const entry = {
      ts: nowTs(),
      level: String(level || "info"),
      shareId: String(shareId || "").trim(),
      message,
      detail: String(detail || "").trim(),
    };
    this.autoUpdateHistory.unshift(entry);
    if (this.autoUpdateHistory.length > AUTO_UPDATE_HISTORY_LIMIT) {
      this.autoUpdateHistory.length = AUTO_UPDATE_HISTORY_LIMIT;
    }
    if (this.autoUpdateStatusDialog?.element?.isConnected) {
      this.renderAutoUpdateStatusDialog();
    }
    this.schedulePersistAutoUpdateRuntime();
  }

  getAutoUpdateRetryState(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return null;
    const raw = this.autoUpdateRetryStateByShare?.[id];
    if (!raw || typeof raw !== "object") return null;
    const attempt = Math.max(1, Math.floor(Number(raw.attempt) || 1));
    const nextRetryAt = Math.max(0, Math.floor(Number(raw.nextRetryAt) || 0));
    const message = String(raw.message || "");
    return {attempt, nextRetryAt, message};
  }

  clearAutoUpdateRetryState(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return;
    if (Object.prototype.hasOwnProperty.call(this.autoUpdateRetryStateByShare || {}, id)) {
      delete this.autoUpdateRetryStateByShare[id];
      this.schedulePersistAutoUpdateRuntime();
    }
  }

  captureAutoUpdateRuntimeSnapshotForShare(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return null;
    const queueIndex = this.autoUpdateQueue.findIndex((queuedId) => String(queuedId || "").trim() === id);
    const inQueue = queueIndex >= 0 || this.autoUpdateQueuedSet.has(id);
    const inRerun = this.autoUpdateRerunSet.has(id);
    const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[id]) || 0));
    const inQuiet = this.autoUpdateQuietPendingSet.has(id) && deadline > 0;
    const retry = this.getAutoUpdateRetryState(id);
    const stateRaw = this.getAutoUpdateShareState(id);
    const state = stateRaw
      ? {
          state: String(stateRaw.state || ""),
          message: String(stateRaw.message || ""),
          updatedAt: Math.max(0, Math.floor(Number(stateRaw.updatedAt) || 0)),
        }
      : null;
    return {
      shareId: id,
      queueIndex,
      inQueue,
      inRerun,
      inQuiet,
      quietDeadlineAt: deadline,
      retry,
      state,
      wasCurrent: this.autoUpdateCurrentShareId === id,
    };
  }

  suspendAutoUpdateRuntimeForShare(shareId, {clearRetry = false, clearState = true, clearSyncing = false} = {}) {
    const id = String(shareId || "").trim();
    if (!id) return false;
    let changed = false;
    if (this.autoUpdateQueuedSet.has(id)) {
      const nextQueue = this.autoUpdateQueue.filter((queuedId) => String(queuedId || "").trim() !== id);
      if (nextQueue.length !== this.autoUpdateQueue.length) {
        this.autoUpdateQueue = nextQueue;
        changed = true;
      }
      this.autoUpdateQueuedSet.delete(id);
      changed = true;
    } else {
      const nextQueue = this.autoUpdateQueue.filter((queuedId) => String(queuedId || "").trim() !== id);
      if (nextQueue.length !== this.autoUpdateQueue.length) {
        this.autoUpdateQueue = nextQueue;
        changed = true;
      }
    }
    if (this.autoUpdateRerunSet.has(id)) {
      this.autoUpdateRerunSet.delete(id);
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(this.autoUpdateQuietDeadlineByShare || {}, id)) {
      delete this.autoUpdateQuietDeadlineByShare[id];
      delete this.autoUpdateQuietFirstEnteredByShare[id];
      changed = true;
    }
    if (this.autoUpdateQuietPendingSet.delete(id)) {
      changed = true;
    }
    if (this.autoUpdateAbortByQuietSet.delete(id)) {
      changed = true;
    }
    if (this.autoUpdateAbortByNotebookClosedSet.delete(id)) {
      changed = true;
    }
    if (clearRetry && Object.prototype.hasOwnProperty.call(this.autoUpdateRetryStateByShare || {}, id)) {
      delete this.autoUpdateRetryStateByShare[id];
      changed = true;
    }
    if (clearState) {
      const stateRaw = String(this.getAutoUpdateShareState(id)?.state || "").trim();
      if (stateRaw && (clearSyncing || stateRaw !== "syncing")) {
        this.setAutoUpdateShareState(id, "");
      }
    }
    if (changed) {
      this.scheduleAutoUpdateQuietFlush();
      this.schedulePersistAutoUpdateRuntime();
    }
    return changed;
  }

  restoreAutoUpdateRuntimeSnapshotForShare(shareId, snapshot) {
    const id = String(shareId || "").trim();
    if (!id || !snapshot || String(snapshot?.shareId || "").trim() !== id) return false;
    if (!this.getShareById(id)) return false;
    let changed = false;
    const now = nowTs();
    const hadQueue = this.autoUpdateQueuedSet.has(id);
    if ((snapshot.inQueue || snapshot.wasCurrent || snapshot.inRerun) && !hadQueue && this.autoUpdateCurrentShareId !== id) {
      if (Number.isFinite(Number(snapshot.queueIndex)) && Number(snapshot.queueIndex) <= 0) {
        this.autoUpdateQueue.unshift(id);
      } else {
        this.autoUpdateQueue.push(id);
      }
      this.autoUpdateQueuedSet.add(id);
      changed = true;
    }
    if (snapshot.inRerun && !this.autoUpdateRerunSet.has(id)) {
      this.autoUpdateRerunSet.add(id);
      changed = true;
    }
    const quietDeadlineAt = Math.max(0, Math.floor(Number(snapshot.quietDeadlineAt) || 0));
    if (snapshot.inQuiet && quietDeadlineAt > now) {
      if (!this.autoUpdateQuietPendingSet.has(id)) {
        this.autoUpdateQuietPendingSet.add(id);
        changed = true;
      }
      if (Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[id]) || 0)) !== quietDeadlineAt) {
        this.autoUpdateQuietDeadlineByShare[id] = quietDeadlineAt;
        changed = true;
      }
    }
    const retry = snapshot.retry;
    if (retry && Math.max(0, Math.floor(Number(retry.nextRetryAt) || 0)) > 0) {
      const nextRetryAt = Math.max(0, Math.floor(Number(retry.nextRetryAt) || 0));
      const attempt = Math.max(1, Math.floor(Number(retry.attempt) || 1));
      const message = String(retry.message || "").trim();
      const prev = this.getAutoUpdateRetryState(id);
      if (!prev || prev.nextRetryAt !== nextRetryAt || prev.attempt !== attempt || String(prev.message || "") !== message) {
        this.autoUpdateRetryStateByShare[id] = {attempt, nextRetryAt, message};
        changed = true;
      }
    }
    if (snapshot.inQuiet && quietDeadlineAt > now) {
      this.setAutoUpdateShareState(id, "quiet");
    } else if (this.autoUpdateCurrentShareId === id) {
      this.setAutoUpdateShareState(id, "syncing");
    } else if (this.autoUpdateQueuedSet.has(id) || this.autoUpdateRerunSet.has(id)) {
      this.setAutoUpdateShareState(id, "queued");
    } else {
      const retryState = this.getAutoUpdateRetryState(id);
      if (retryState && retryState.nextRetryAt > now) {
        const message =
          String(retryState.message || "").trim() ||
          this.buildAutoUpdateRetryMessage({
            attempt: retryState.attempt || 1,
            retryAt: retryState.nextRetryAt,
            error: "",
          });
        this.setAutoUpdateShareState(id, "error", {message});
      } else if (snapshot.state?.state === "quiet" && quietDeadlineAt > now) {
        this.setAutoUpdateShareState(id, "quiet");
      } else if (snapshot.state?.state === "queued") {
        this.setAutoUpdateShareState(id, "queued");
      } else if (snapshot.state?.state === "error") {
        this.setAutoUpdateShareState(id, "error", {message: String(snapshot.state?.message || "")});
      } else {
        this.setAutoUpdateShareState(id, "");
      }
    }
    if (snapshot.inQuiet && quietDeadlineAt > now) {
      this.scheduleAutoUpdateQuietFlush();
    }
    if (this.autoUpdateQueuedSet.has(id) || this.autoUpdateRerunSet.has(id)) {
      this.scheduleAutoUpdateNow(120);
    }
    if (changed) {
      this.schedulePersistAutoUpdateRuntime();
    }
    return changed;
  }

  clearAllAutoUpdateRetryStates() {
    const entries = Object.entries(this.autoUpdateRetryStateByShare || {});
    if (!entries.length) return 0;
    this.autoUpdateRetryStateByShare = {};
    entries.forEach(([shareIdRaw]) => {
      const shareId = String(shareIdRaw || "").trim();
      if (!shareId) return;
      const state = String(this.getAutoUpdateShareState(shareId)?.state || "").trim();
      if (state !== "error") return;
      if (this.hasAutoUpdateQuietPending(shareId)) {
        this.setAutoUpdateShareState(shareId, "quiet");
        return;
      }
      if (this.autoUpdateCurrentShareId === shareId) {
        this.setAutoUpdateShareState(shareId, "syncing");
        return;
      }
      if (this.autoUpdateQueuedSet.has(shareId) || this.autoUpdateRerunSet.has(shareId)) {
        this.setAutoUpdateShareState(shareId, "queued");
        return;
      }
      this.setAutoUpdateShareState(shareId, "");
    });
    this.schedulePersistAutoUpdateRuntime();
    return entries.length;
  }

  clearAutoUpdateHistory() {
    const rows = Array.isArray(this.autoUpdateHistory) ? this.autoUpdateHistory : [];
    const count = rows.length;
    if (!count) {
      this.autoUpdateHistory = [];
      return 0;
    }
    this.autoUpdateHistory = [];
    this.schedulePersistAutoUpdateRuntime();
    return count;
  }

  markAutoUpdateManualSuccess(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return;
    this.autoUpdateManualSkipDetectSet.add(id);
    const hasWsBacklog =
      this.autoUpdateWsDetectRunning ||
      this.autoUpdateWsDetectPending ||
      this.autoUpdateWsDocIdSet.size > 0 ||
      !!this.autoUpdateWsFlushTimer;
    if (hasWsBacklog) {
      this.autoUpdateManualSkipRealtimeOnceSet.add(id);
    }
  }

  buildAutoUpdateNotebookClosedSkipMessage(shareId) {
    return this.t("siyuanShare.message.autoUpdateSkippedNotebookClosed", {
      name: this.getAutoUpdateShareLabel(shareId),
    });
  }

  markAutoUpdateShareSkippedNotebookClosed(shareId, {clearQuiet = true} = {}) {
    const id = String(shareId || "").trim();
    if (!id) return;
    if (this.autoUpdateQueuedSet.has(id)) {
      this.autoUpdateQueue = this.autoUpdateQueue.filter((queuedId) => String(queuedId || "").trim() !== id);
      this.autoUpdateQueuedSet.delete(id);
    }
    this.autoUpdateRerunSet.delete(id);
    if (clearQuiet) {
      this.autoUpdateQuietPendingSet.delete(id);
      delete this.autoUpdateQuietDeadlineByShare[id];
      delete this.autoUpdateQuietFirstEnteredByShare[id];
    }
    this.autoUpdateAbortByNotebookClosedSet.delete(id);
    this.clearAutoUpdateRetryState(id);
    this.setAutoUpdateShareState(id, "");
    this.pushAutoUpdateHistory("info", this.buildAutoUpdateNotebookClosedSkipMessage(id), {shareId: id});
  }

  getAutoUpdateRetryDelayMs(attempt = 1) {
    const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
    const step = Math.min(10, safeAttempt - 1);
    const base = this.autoUpdateRetryBaseDelayMs * 2 ** step;
    const jitter = Math.floor(Math.random() * 5000);
    return Math.min(base + jitter, this.autoUpdateRetryMaxDelayMs);
  }

  isAutoUpdateRetryBlocked(shareId, now = nowTs()) {
    const state = this.getAutoUpdateRetryState(shareId);
    if (!state) return {blocked: false, remainMs: 0, retryAt: 0, attempt: 0, message: ""};
    const retryAt = Math.max(0, Math.floor(Number(state.nextRetryAt) || 0));
    const remainMs = Math.max(0, retryAt - Math.floor(Number(now) || 0));
    if (remainMs > 0) {
      return {
        blocked: true,
        remainMs,
        retryAt,
        attempt: state.attempt,
        message: String(state.message || ""),
      };
    }
    return {
      blocked: false,
      remainMs: 0,
      retryAt,
      attempt: state.attempt,
      message: String(state.message || ""),
    };
  }

  getDueAutoUpdateRetryShareIds(now = nowTs()) {
    const ts = Math.floor(Number(now) || 0);
    return Object.entries(this.autoUpdateRetryStateByShare || {})
      .map(([shareId, row]) => {
        const id = String(shareId || "").trim();
        const retryAt = Math.max(0, Math.floor(Number(row?.nextRetryAt) || 0));
        return {shareId: id, retryAt};
      })
      .filter((row) => row.shareId && row.retryAt > 0 && row.retryAt <= ts)
      .sort((a, b) => a.retryAt - b.retryAt)
      .map((row) => row.shareId);
  }

  buildAutoUpdateRetryMessage({attempt = 1, retryAt = 0, error = ""} = {}) {
    const t = this.t.bind(this);
    const time = retryAt > 0 ? this.formatTime(retryAt) : t("siyuanShare.label.unknown");
    const base = t("siyuanShare.message.autoUpdateRetryAt", {
      attempt: Math.max(1, Math.floor(Number(attempt) || 1)),
      time,
    });
    const detail = String(error || "").trim();
    return detail ? `${base} | ${detail}` : base;
  }

  markAutoUpdateShareFailure(shareId, err) {
    const id = String(shareId || "").trim();
    if (!id) return;
    const errorText = String(err?.message || err || "").trim();
    const prev = this.getAutoUpdateRetryState(id);
    const attempt = Math.max(1, (prev?.attempt || 0) + 1);
    const delayMs = this.getAutoUpdateRetryDelayMs(attempt);
    const retryAt = nowTs() + delayMs;
    const message = this.buildAutoUpdateRetryMessage({attempt, retryAt, error: errorText});
    this.autoUpdateRetryStateByShare[id] = {
      attempt,
      nextRetryAt: retryAt,
      message,
    };
    this.setAutoUpdateShareState(id, "error", {message});
    this.pushAutoUpdateHistory("error", this.t("siyuanShare.message.autoUpdateFailed"), {
      shareId: id,
      detail: message,
    });
    this.scheduleAutoUpdateNow(Math.min(delayMs + 120, this.getAutoUpdateDelayMs()));
  }

  scheduleAutoUpdateRetryWakeup() {
    const now = nowTs();
    const nextRetryAt = Object.values(this.autoUpdateRetryStateByShare || {}).reduce((min, row) => {
      const retryAt = Math.max(0, Math.floor(Number(row?.nextRetryAt) || 0));
      if (!retryAt || retryAt <= now) return min;
      if (!min || retryAt < min) return retryAt;
      return min;
    }, 0);
    if (!nextRetryAt) return;
    const remain = Math.max(0, nextRetryAt - now);
    if (remain <= this.getAutoUpdateDelayMs() + 1000) {
      this.scheduleAutoUpdateNow(remain + 120);
    }
  }

  getAutoUpdateSummaryLabel() {
    const t = this.t.bind(this);
    if (!this.isAutoUpdateEnabledForActiveSite()) {
      return t("siyuanShare.message.autoUpdateDisabled");
    }
    if (this.autoUpdateCurrentShareId) {
      return t("siyuanShare.message.autoUpdateRunningOne", {
        name: this.getAutoUpdateShareLabel(this.autoUpdateCurrentShareId),
      });
    }
    if (this.autoUpdateQueue.length > 0) {
      return t("siyuanShare.message.autoUpdateQueuedCount", {count: this.autoUpdateQueue.length});
    }
    if (this.autoUpdateNextRunAt > 0) {
      return t("siyuanShare.message.autoUpdateNextScan", {
        time: this.formatTime(this.autoUpdateNextRunAt),
      });
    }
    return t("siyuanShare.message.autoUpdateIdle");
  }

  refreshAutoUpdateStatusTextInDock() {
    if (!this.dockElement) return;
    const el = this.dockElement.querySelector?.("#sps-auto-update-status");
    if (!el) return;
    el.textContent = this.getAutoUpdateSummaryLabel();
  }

  closeAutoUpdateStatusDialog() {
    if (this.autoUpdateStatusRefreshTimer) {
      clearInterval(this.autoUpdateStatusRefreshTimer);
      this.autoUpdateStatusRefreshTimer = null;
    }
    if (this.autoUpdateStatusDialog) {
      try {
        this.autoUpdateStatusDialog.destroy();
      } catch {
        // ignore
      }
      this.autoUpdateStatusDialog = null;
    }
  }

  renderAutoUpdateStatusDialog() {
    const dialog = this.autoUpdateStatusDialog;
    const root = dialog?.element?.querySelector?.(".sps-auto-status");
    if (!root) return;
    const scrollState = {};
    root.querySelectorAll("[data-log]").forEach((el) => {
      const key = String(el.getAttribute("data-log") || "").trim();
      if (!key) return;
      scrollState[key] = {
        top: Number(el.scrollTop) || 0,
        left: Number(el.scrollLeft) || 0,
      };
    });
    const t = this.t.bind(this);
    const enabled = this.isAutoUpdateEnabledForActiveSite();
    const queueList = this.autoUpdateQueue.map((shareId, index) => {
      const meta = this.getAutoUpdateShareLogMeta(shareId);
      return {
        index: index + 1,
        shareId: meta.shareId,
        typeLabel: meta.typeLabel,
        title: meta.title,
        targetId: meta.targetId,
      };
    });
    const now = nowTs();
    const quietList = Array.from(this.autoUpdateQuietPendingSet || [])
      .map((shareIdRaw) => String(shareIdRaw || "").trim())
      .filter((shareId) => shareId)
      .map((shareId) => {
        const meta = this.getAutoUpdateShareLogMeta(shareId);
        const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[shareId]) || 0));
        const remainSeconds = deadline > 0 ? Math.max(0, Math.ceil(Math.max(0, deadline - now) / 1000)) : 0;
        return {
          shareId,
          typeLabel: meta.typeLabel,
          title: meta.title,
          targetId: meta.targetId,
          deadline,
          remainSeconds,
        };
      })
      .filter((row) => row.shareId && row.deadline > 0)
      .sort((a, b) => a.deadline - b.deadline);
    const retryList = Object.entries(this.autoUpdateRetryStateByShare || {})
      .map(([shareId, row]) => {
        const id = String(shareId || "").trim();
        const meta = this.getAutoUpdateShareLogMeta(id);
        const attempt = Math.max(1, Math.floor(Number(row?.attempt) || 1));
        const retryAt = Math.max(0, Math.floor(Number(row?.nextRetryAt) || 0));
        const message = String(row?.message || "").trim();
        return {
          shareId: id,
          typeLabel: meta.typeLabel,
          title: meta.title,
          targetId: meta.targetId,
          attempt,
          retryAt,
          message,
        };
      })
      .filter((row) => row.shareId)
      .sort((a, b) => a.retryAt - b.retryAt);
    const historyRowsAll = (Array.isArray(this.autoUpdateHistory) ? this.autoUpdateHistory : []).slice(
      0,
      AUTO_UPDATE_HISTORY_LIMIT,
    );
    const historyRows = historyRowsAll.slice(0, AUTO_UPDATE_HISTORY_RENDER_LIMIT);
    const summaryRows = [
      {
        label: t("siyuanShare.label.autoUpdateEnabled"),
        value: enabled ? t("siyuanShare.label.statusEnabled") : t("siyuanShare.label.statusDisabled"),
      },
      {
        label: t("siyuanShare.label.autoUpdateState"),
        value: this.getAutoUpdateSummaryLabel(),
      },
      {
        label: t("siyuanShare.label.autoUpdateCurrent"),
        value: this.autoUpdateCurrentShareId
          ? this.getAutoUpdateShareLabel(this.autoUpdateCurrentShareId)
          : t("siyuanShare.label.none"),
      },
      {
        label: t("siyuanShare.label.autoUpdateQueue"),
        value: String(this.autoUpdateQueue.length),
      },
      {
        label: t("siyuanShare.label.autoUpdateLastScan"),
        value: this.autoUpdateLastScanAt ? this.formatTime(this.autoUpdateLastScanAt) : t("siyuanShare.label.none"),
      },
      {
        label: t("siyuanShare.label.autoUpdateNextScan"),
        value: this.autoUpdateNextRunAt ? this.formatTime(this.autoUpdateNextRunAt) : t("siyuanShare.label.none"),
      },
    ];
    const summaryHtml = summaryRows
      .map(
        (row) => `<div class="sps-auto-status__row">
  <div class="sps-auto-status__key">${escapeHtml(row.label)}</div>
  <div class="sps-auto-status__value">${escapeHtml(row.value)}</div>
</div>`,
      )
      .join("");
    const queueContentHtml = queueList.length
      ? (() => {
          const rowsHtml = queueList
            .map((row) => {
              const shareLabel = `${row.typeLabel}:${row.title}`;
              return `<div class="sps-auto-history__row">
  <span class="sps-auto-history__cell">${escapeHtml(`[${row.index}]`)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(shareLabel)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(`id:${row.targetId}`)}</span>
</div>`;
            })
            .join("\n");
          return `<div class="sps-auto-status__log sps-auto-status__history-log sps-auto-status__list-log" data-log="queue">
  <div class="sps-auto-history__table">
    ${rowsHtml}
  </div>
</div>`;
        })()
      : `<pre class="sps-auto-status__log" data-log="queue">${escapeHtml(
          t("siyuanShare.message.autoUpdateQueueEmpty"),
        )}</pre>`;
    const quietContentHtml = quietList.length
      ? (() => {
          const rowsHtml = quietList
            .map((row) => {
              const timeLabel = row.deadline ? this.formatTime(row.deadline) : t("siyuanShare.label.none");
              const remainLabel = t("siyuanShare.message.autoUpdateQuietRemaining", {
                seconds: Math.max(0, Math.floor(Number(row.remainSeconds) || 0)),
              });
              const shareLabel = `${row.typeLabel}:${row.title}`;
              return `<div class="sps-auto-history__row">
  <span class="sps-auto-history__cell">${escapeHtml(`[${timeLabel}]`)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(remainLabel)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(shareLabel)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(`id:${row.targetId}`)}</span>
</div>`;
            })
            .join("\n");
          return `<div class="sps-auto-status__log sps-auto-status__history-log sps-auto-status__list-log" data-log="quiet">
  <div class="sps-auto-history__table">
    ${rowsHtml}
  </div>
</div>`;
        })()
      : `<pre class="sps-auto-status__log" data-log="quiet">${escapeHtml(
          t("siyuanShare.message.autoUpdateQuietEmpty"),
        )}</pre>`;
    const retryContentHtml = retryList.length
      ? (() => {
          const rowsHtml = retryList
            .map((row) => {
              const retryLabel = `${t("siyuanShare.label.retry")} ${row.attempt}`;
              const timeLabel = row.retryAt ? this.formatTime(row.retryAt) : t("siyuanShare.label.none");
              const shareLabel = `${row.typeLabel}:${row.title}`;
              const message = row.message || "-";
              return `<div class="sps-auto-history__row">
  <span class="sps-auto-history__cell">${escapeHtml(`[${retryLabel}]`)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(`[${timeLabel}]`)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(shareLabel)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(`id:${row.targetId}`)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(message)}</span>
</div>`;
            })
            .join("\n");
          return `<div class="sps-auto-status__log sps-auto-status__history-log sps-auto-status__list-log" data-log="retry">
  <div class="sps-auto-history__table">
    ${rowsHtml}
  </div>
</div>`;
        })()
      : `<pre class="sps-auto-status__log" data-log="retry">${escapeHtml(
          t("siyuanShare.message.autoUpdateRetryEmpty"),
        )}</pre>`;
    const retryTitleHtml = `<div class="sps-auto-status__head">
  <div class="sps-auto-status__title">${escapeHtml(t("siyuanShare.title.autoUpdateRetry"))}</div>
  <button class="sps-auto-status__head-link" data-action="auto-update-clear-retry"${
    retryList.length ? "" : " disabled"
  }>${escapeHtml(t("siyuanShare.action.autoUpdateClearRetry"))}</button>
</div>`;
    const historyContentHtml = historyRows.length
      ? (() => {
          const rowsHtml = historyRows
            .map((row) => {
              const tag =
                row.level === "error"
                  ? t("siyuanShare.label.statusError")
                  : row.level === "success"
                    ? t("siyuanShare.label.statusSuccess")
                    : t("siyuanShare.label.statusInfo");
              const shareMeta = row.shareId ? this.getAutoUpdateShareLogMeta(row.shareId) : null;
              const shareLabel = shareMeta ? `${shareMeta.typeLabel}:${shareMeta.title}` : "-";
              const targetId = shareMeta ? shareMeta.targetId : "-";
              const detail = row.detail ? String(row.detail || "") : "";
              const fullMsg = detail ? `${String(row.message || "")} | ${detail}` : String(row.message || "");
              return `<div class="sps-auto-history__row">
  <span class="sps-auto-history__cell">${escapeHtml(`[${this.formatTime(row.ts)}]`)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(`[${tag}]`)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(fullMsg)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(shareLabel)}</span>
  <span class="sps-auto-history__sep">|</span>
  <span class="sps-auto-history__cell">${escapeHtml(`id:${targetId}`)}</span>
</div>`;
            })
            .join("\n");
          return `<div class="sps-auto-status__log sps-auto-status__history-log" data-log="history">
  <div class="sps-auto-history__table">
    ${rowsHtml}
  </div>
</div>`;
        })()
      : `<pre class="sps-auto-status__log" data-log="history">${escapeHtml(
          t("siyuanShare.message.autoUpdateHistoryEmpty"),
        )}</pre>`;
    const historyTitleHtml = `<div class="sps-auto-status__head">
  <div class="sps-auto-status__title">${escapeHtml(t("siyuanShare.title.autoUpdateHistory"))}</div>
  <button class="sps-auto-status__head-link" data-action="auto-update-clear-history"${
    historyRowsAll.length ? "" : " disabled"
  }>${escapeHtml(t("siyuanShare.action.autoUpdateClearRetry"))}</button>
</div>`;
    root.innerHTML = `<div class="sps-auto-status__section">
  <div class="sps-auto-status__title">${escapeHtml(t("siyuanShare.title.autoUpdateSummary"))}</div>
  <div class="sps-auto-status__grid">${summaryHtml}</div>
</div>
<div class="sps-auto-status__section">
  <div class="sps-auto-status__title">${escapeHtml(t("siyuanShare.title.autoUpdateQueue"))}</div>
  ${queueContentHtml}
</div>
<div class="sps-auto-status__section">
  <div class="sps-auto-status__title">${escapeHtml(t("siyuanShare.title.autoUpdateQuiet"))}</div>
  ${quietContentHtml}
</div>
<div class="sps-auto-status__section">
  ${retryTitleHtml}
  ${retryContentHtml}
</div>
<div class="sps-auto-status__section">
  ${historyTitleHtml}
  ${historyContentHtml}
</div>`;
    Object.entries(scrollState).forEach(([key, pos]) => {
      const el = root.querySelector(`[data-log="${key}"]`);
      if (!el) return;
      el.scrollTop = Number(pos?.top) || 0;
      el.scrollLeft = Number(pos?.left) || 0;
    });
  }

  openAutoUpdateStatusDialog() {
    const t = this.t.bind(this);
    if (this.autoUpdateStatusDialog?.element?.isConnected) {
      this.renderAutoUpdateStatusDialog();
      return;
    }
    if (this.autoUpdateStatusRefreshTimer) {
      clearInterval(this.autoUpdateStatusRefreshTimer);
      this.autoUpdateStatusRefreshTimer = null;
    }
    const content = `<div class="b3-dialog__content sps-auto-status"></div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--outline" data-action="auto-update-run-now">${escapeHtml(
    t("siyuanShare.action.autoUpdateRunNow"),
  )}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--cancel" data-action="close">${escapeHtml(t("siyuanShare.action.close"))}</button>
</div>`;
    let dialog = null;
    const onClick = (event) => {
      const btn = event.target?.closest?.("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "close") {
        dialog?.destroy();
        return;
      }
      if (action === "auto-update-run-now") {
        this.scheduleAutoUpdateNow(0);
        this.renderAutoUpdateStatusDialog();
        return;
      }
      if (action === "auto-update-clear-retry") {
        this.clearAllAutoUpdateRetryStates();
        this.renderAutoUpdateStatusDialog();
        return;
      }
      if (action === "auto-update-clear-history") {
        this.clearAutoUpdateHistory();
        this.renderAutoUpdateStatusDialog();
      }
    };
    dialog = new Dialog({
      title: t("siyuanShare.title.autoUpdateStatus"),
      content,
      width: "min(860px, 94vw)",
      height: "min(82vh, 760px)",
      destroyCallback: () => {
        if (this.autoUpdateStatusRefreshTimer) {
          clearInterval(this.autoUpdateStatusRefreshTimer);
          this.autoUpdateStatusRefreshTimer = null;
        }
        dialog?.element?.removeEventListener?.("click", onClick);
        if (this.autoUpdateStatusDialog === dialog) {
          this.autoUpdateStatusDialog = null;
        }
      },
    });
    this.autoUpdateStatusDialog = dialog;
    dialog.element?.addEventListener?.("click", onClick);
    this.renderAutoUpdateStatusDialog();
    // Periodically refresh the status dialog so countdown / state stays current
    this.autoUpdateStatusRefreshTimer = setInterval(() => {
      if (!this.autoUpdateStatusDialog?.element?.isConnected) {
        clearInterval(this.autoUpdateStatusRefreshTimer);
        this.autoUpdateStatusRefreshTimer = null;
        return;
      }
      this.renderAutoUpdateStatusDialog();
    }, 2000);
  }

  isAutoUpdateEnabledForActiveSite() {
    const active = this.getActiveSite();
    if (!active) return false;
    return !!active.autoUpdateEnabled;
  }

  getAutoUpdateDelayMs() {
    return document?.hidden ? this.autoUpdateHiddenDelayMs : this.autoUpdateDelayMs;
  }

  getAutoUpdateMaxDelayMs() {
    const minDelay = this.getAutoUpdateDelayMs();
    const configured = document?.hidden ? this.autoUpdateHiddenMaxDelayMs : this.autoUpdateMaxDelayMs;
    const maxDelay = Math.max(minDelay, Math.floor(Number(configured) || minDelay));
    return maxDelay;
  }

  getAutoUpdateLoopDelayMs(result = null) {
    const minDelay = this.getAutoUpdateDelayMs();
    const maxDelay = this.getAutoUpdateMaxDelayMs();
    let adaptive = Math.max(minDelay, Math.floor(Number(this.autoUpdateAdaptiveDelayMs) || minDelay));
    const hasActiveWork =
      this.autoUpdateQueue.length > 0 ||
      this.autoUpdateRerunSet.size > 0 ||
      !!String(this.autoUpdateCurrentShareId || "").trim();
    const shouldReset =
      hasActiveWork || !!result?.changed || !!result?.failed || !!result?.interrupted;
    if (shouldReset) {
      adaptive = minDelay;
    } else {
      const factor = Math.max(1.2, Number(this.autoUpdateBackoffFactor) || 1.8);
      adaptive = Math.min(maxDelay, Math.max(minDelay, Math.ceil(adaptive * factor)));
    }
    this.autoUpdateAdaptiveDelayMs = adaptive;
    const jitterRatio = Math.max(0, Math.min(0.4, Number(this.autoUpdateDelayJitterRatio) || 0));
    const jitter = jitterRatio > 0 ? Math.floor(Math.random() * Math.max(1, Math.floor(adaptive * jitterRatio))) : 0;
    return Math.min(maxDelay, adaptive + jitter);
  }

  scheduleAutoUpdateNow(delayMs = 0) {
    if (!this.autoUpdateLoopRunner) return;
    if (!this.isAutoUpdateEnabledForActiveSite()) return;
    // If currently processing, skip rescheduling — the active loop will reschedule when done
    if (this.autoUpdating) return;
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer);
      this.autoUpdateTimer = null;
    }
    const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
    const minDelay = this.getAutoUpdateDelayMs();
    if (delay <= minDelay + 1000) {
      this.autoUpdateAdaptiveDelayMs = minDelay;
    }
    this.autoUpdateNextRunAt = nowTs() + delay;
    this.refreshAutoUpdateStatusTextInDock();
    this.autoUpdateTimer = setTimeout(this.autoUpdateLoopRunner, delay);
  }

  refreshAutoUpdateLoop({immediate = false} = {}) {
    if (this.isAutoUpdateEnabledForActiveSite()) {
      this.startAutoUpdate({immediate});
      this.scheduleAutoUpdateStructureReconcile({immediate: true, reset: false});
      return;
    }
    this.stopAutoUpdateStructureReconcile();
    this.stopAutoUpdate({clearState: false});
    if (Object.keys(this.autoUpdateShareStates || {}).length > 0) {
      this.autoUpdateShareStates = {};
      this.refreshDocTreeMarksLater();
    }
  }

  startAutoUpdate({immediate = false} = {}) {
    if (!this.isAutoUpdateEnabledForActiveSite()) {
      this.stopAutoUpdate({clearState: true});
      return;
    }
    if (this.autoUpdateLoopRunner) {
      if (immediate) this.scheduleAutoUpdateNow(0);
      return;
    }
    this.autoUpdateAdaptiveDelayMs = this.getAutoUpdateDelayMs();
    const loop = async () => {
      if (this.autoUpdateLoopRunner !== loop) return;
      if (this.autoUpdateTimer) {
        clearTimeout(this.autoUpdateTimer);
        this.autoUpdateTimer = null;
      }
      const scheduleNext = (result) => {
        if (this.autoUpdateLoopRunner !== loop) return;
        const delay = this.getAutoUpdateLoopDelayMs(result);
        this.autoUpdateNextRunAt = nowTs() + delay;
        this.refreshAutoUpdateStatusTextInDock();
        this.autoUpdateTimer = setTimeout(loop, delay);
      };
      if (!this.isAutoUpdateEnabledForActiveSite()) {
        this.stopAutoUpdate({clearState: true});
        return;
      }
      const result = await this.runAutoUpdateOnce();
      if (this.autoUpdateLoopRunner !== loop) return;
      scheduleNext(result);
    };
    this.autoUpdateLoopRunner = loop;
    const startDelay = immediate ? 0 : this.getAutoUpdateDelayMs();
    this.autoUpdateNextRunAt = nowTs() + startDelay;
    this.refreshAutoUpdateStatusTextInDock();
    this.autoUpdateTimer = setTimeout(loop, startDelay);
  }

  stopAutoUpdate({clearState = false, refreshTreeOnClear = true, preservePendingOnPause = false} = {}) {
    const shouldPreservePending = !clearState && !!preservePendingOnPause;
    const pendingResumeQueueShareIds = shouldPreservePending
      ? this.normalizeAutoUpdateQueue([
          ...this.autoUpdateQueue,
          String(this.autoUpdateCurrentShareId || "").trim(),
        ])
      : [];
    const pendingResumeQuietDeadlineByShare = {};
    const pendingResumeQuietShareIds = shouldPreservePending
      ? this.normalizeAutoUpdateQueue(Array.from(this.autoUpdateQuietPendingSet || [])).filter((shareId) => {
          const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[shareId]) || 0));
          if (!deadline) return false;
          pendingResumeQuietDeadlineByShare[shareId] = deadline;
          return true;
        })
      : [];
    this.stopAutoUpdateStructureReconcile();
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer);
      this.autoUpdateTimer = null;
    }
    this.autoUpdateNextRunAt = 0;
    this.refreshAutoUpdateStatusTextInDock();
    this.autoUpdateLoopRunner = null;
    if (this.autoUpdateCurrentController && !this.autoUpdateCurrentController.signal?.aborted) {
      try {
        this.autoUpdateCurrentController.abort();
      } catch {
        // ignore
      }
    }
    this.autoUpdateCurrentController = null;
    this.autoUpdateCurrentShareId = "";
    this.autoUpdating = false;
    this.autoUpdateAdaptiveDelayMs = this.getAutoUpdateDelayMs();
    this.autoUpdateQueue = [];
    this.autoUpdateQueuedSet.clear();
    this.autoUpdateRerunSet.clear();
    this.autoUpdateAbortByQuietSet.clear();
    this.autoUpdateAbortByManualSet.clear();
    this.autoUpdateAbortByNotebookClosedSet.clear();
    this.autoUpdateShareNotebookHintById = {};
    this.autoUpdateManualSkipDetectSet.clear();
    this.autoUpdateManualSkipRealtimeOnceSet.clear();
    if (this.autoUpdateQuietFlushTimer) {
      clearTimeout(this.autoUpdateQuietFlushTimer);
      this.autoUpdateQuietFlushTimer = null;
    }
    this.autoUpdateQuietNextFlushAt = 0;
    this.autoUpdateQuietPendingSet.clear();
    this.autoUpdateQuietDeadlineByShare = {};
    this.autoUpdateQuietFirstEnteredByShare = {};
    if (this.autoUpdateWsFlushTimer) {
      clearTimeout(this.autoUpdateWsFlushTimer);
      this.autoUpdateWsFlushTimer = null;
    }
    this.autoUpdateWsDocIdSet.clear();
    this.autoUpdateWsDetectRunning = false;
    this.autoUpdateWsDetectPending = false;
    if (clearState) {
      this.autoUpdateShareStates = {};
      this.autoUpdateRetryStateByShare = {};
      this.autoUpdateShareChangeSeqById = {};
      this.autoUpdateHistory = [];
      this.autoUpdateLastResult = null;
      if (refreshTreeOnClear) {
        this.refreshDocTreeMarksLater();
      }
    } else if (shouldPreservePending && (pendingResumeQueueShareIds.length > 0 || pendingResumeQuietShareIds.length > 0)) {
      const resumedQuietSet = new Set();
      const resumedQuietDeadlineByShare = {};
      pendingResumeQuietShareIds.forEach((shareIdRaw) => {
        const shareId = String(shareIdRaw || "").trim();
        if (!shareId || !this.getShareById(shareId)) return;
        const deadline = Math.max(0, Math.floor(Number(pendingResumeQuietDeadlineByShare?.[shareId]) || 0));
        if (!deadline) return;
        resumedQuietSet.add(shareId);
        resumedQuietDeadlineByShare[shareId] = deadline;
      });
      const resumedQueueIds = pendingResumeQueueShareIds
        .map((shareIdRaw) => String(shareIdRaw || "").trim())
        .filter((shareId) => shareId && this.getShareById(shareId) && !resumedQuietSet.has(shareId));
      this.autoUpdateQueue = resumedQueueIds;
      this.autoUpdateQueuedSet = new Set(resumedQueueIds);
      this.autoUpdateQuietPendingSet = resumedQuietSet;
      this.autoUpdateQuietDeadlineByShare = resumedQuietDeadlineByShare;
      resumedQueueIds.forEach((shareId) => {
        this.setAutoUpdateShareState(shareId, "queued");
      });
      resumedQuietSet.forEach((shareId) => {
        this.setAutoUpdateShareState(shareId, "quiet");
      });
      if (resumedQuietSet.size > 0) {
        this.scheduleAutoUpdateQuietFlush();
      }
      if (resumedQueueIds.length > 0 || resumedQuietSet.size > 0) {
        this.schedulePersistAutoUpdateRuntime();
      }
    }
  }

  getAutoUpdateScanCursor(siteId) {
    const id = String(siteId || "").trim();
    if (!id) return {updated: "", docId: ""};
    const map = this.normalizeAutoUpdateScanStampBySite(this.settings?.autoUpdateScanStampBySite || {});
    const cursor = this.normalizeAutoUpdateScanCursor(map[id]);
    return cursor || {updated: "", docId: ""};
  }

  async setAutoUpdateScanCursor(siteId, cursorRaw) {
    const id = String(siteId || "").trim();
    const cursor = this.normalizeAutoUpdateScanCursor(cursorRaw);
    if (!id || !cursor) return;
    const nextMap = this.normalizeAutoUpdateScanStampBySite(this.settings?.autoUpdateScanStampBySite || {});
    const prev = this.normalizeAutoUpdateScanCursor(nextMap[id]);
    if (prev && prev.updated === cursor.updated && String(prev.docId || "") === String(cursor.docId || "")) {
      return;
    }
    nextMap[id] = cursor;
    this.settings = {
      ...this.settings,
      autoUpdateScanStampBySite: nextMap,
    };
    await this.saveData(STORAGE_SETTINGS, this.settings);
  }

  getAutoUpdateScanStamp(siteId) {
    return this.getAutoUpdateScanCursor(siteId).updated;
  }

  async setAutoUpdateScanStamp(siteId, stamp) {
    const normalized = normalizeDocUpdatedStamp(stamp);
    if (!normalized) return;
    await this.setAutoUpdateScanCursor(siteId, {updated: normalized, docId: ""});
  }

  setAutoUpdateShareState(shareId, state, {message = ""} = {}) {
    if (this.isUnloading) return;
    const id = String(shareId || "").trim();
    if (!id) return;
    const normalizedState = String(state || "").trim();
    const normalizedMessage = String(message || "");
    const prev = this.autoUpdateShareStates?.[id] || null;
    if (!normalizedState) {
      if (prev) {
        delete this.autoUpdateShareStates[id];
        const forceImmediate = String(prev.state || "") === "syncing";
        this.scheduleDocTreeRefresh(forceImmediate ? 0 : 80, {force: forceImmediate});
        this.refreshAutoUpdateStatusTextInDock();
      }
      return;
    }
    if (prev && prev.state === normalizedState && String(prev.message || "") === normalizedMessage) {
      return;
    }
    this.autoUpdateShareStates[id] = {
      state: normalizedState,
      message: normalizedMessage,
      updatedAt: nowTs(),
    };
    const forceImmediate = normalizedState === "syncing";
    this.scheduleDocTreeRefresh(forceImmediate ? 0 : 80, {force: forceImmediate});
    this.refreshAutoUpdateStatusTextInDock();
    if (this.autoUpdateStatusDialog?.element?.isConnected) {
      this.renderAutoUpdateStatusDialog();
    }
  }

  pruneAutoUpdateShareStates() {
    const shareIdSet = new Set(
      (Array.isArray(this.shares) ? this.shares : [])
        .map((share) => String(share?.id || "").trim())
        .filter((id) => id),
    );
    let changed = false;
    const nextQueue = this.autoUpdateQueue.filter((shareId) => shareIdSet.has(String(shareId || "").trim()));
    if (nextQueue.length !== this.autoUpdateQueue.length) {
      this.autoUpdateQueue = nextQueue;
      this.autoUpdateQueuedSet = new Set(nextQueue);
      changed = true;
    }
    const nextRerun = new Set();
    this.autoUpdateRerunSet.forEach((shareId) => {
      if (!shareIdSet.has(String(shareId || "").trim())) {
        changed = true;
        return;
      }
      nextRerun.add(shareId);
    });
    this.autoUpdateRerunSet = nextRerun;
    const nextQuietAbortSet = new Set();
    this.autoUpdateAbortByQuietSet.forEach((shareId) => {
      const id = String(shareId || "").trim();
      if (!id || !shareIdSet.has(id)) {
        changed = true;
        return;
      }
      nextQuietAbortSet.add(id);
    });
    this.autoUpdateAbortByQuietSet = nextQuietAbortSet;
    const nextManualAbortSet = new Set();
    this.autoUpdateAbortByManualSet.forEach((shareId) => {
      const id = String(shareId || "").trim();
      if (!id || !shareIdSet.has(id)) {
        changed = true;
        return;
      }
      nextManualAbortSet.add(id);
    });
    this.autoUpdateAbortByManualSet = nextManualAbortSet;
    const nextNotebookClosedAbortSet = new Set();
    this.autoUpdateAbortByNotebookClosedSet.forEach((shareId) => {
      const id = String(shareId || "").trim();
      if (!id || !shareIdSet.has(id)) {
        changed = true;
        return;
      }
      nextNotebookClosedAbortSet.add(id);
    });
    this.autoUpdateAbortByNotebookClosedSet = nextNotebookClosedAbortSet;
    if (this.autoUpdateCurrentShareId && !shareIdSet.has(this.autoUpdateCurrentShareId)) {
      if (this.autoUpdateCurrentController && !this.autoUpdateCurrentController.signal?.aborted) {
        try {
          this.autoUpdateCurrentController.abort();
        } catch {
          // ignore
        }
      }
      this.autoUpdateCurrentShareId = "";
      this.autoUpdateCurrentController = null;
      changed = true;
    }
    Object.keys(this.autoUpdateShareStates || {}).forEach((shareId) => {
      if (shareIdSet.has(String(shareId))) return;
      delete this.autoUpdateShareStates[shareId];
      changed = true;
    });
    Object.keys(this.autoUpdateRetryStateByShare || {}).forEach((shareId) => {
      if (shareIdSet.has(String(shareId))) return;
      delete this.autoUpdateRetryStateByShare[shareId];
      changed = true;
    });
    Object.keys(this.autoUpdateShareChangeSeqById || {}).forEach((shareId) => {
      if (shareIdSet.has(String(shareId))) return;
      delete this.autoUpdateShareChangeSeqById[shareId];
      changed = true;
    });
    Object.keys(this.autoUpdateQuietDeadlineByShare || {}).forEach((shareId) => {
      if (shareIdSet.has(String(shareId))) return;
      delete this.autoUpdateQuietDeadlineByShare[shareId];
      delete this.autoUpdateQuietFirstEnteredByShare[shareId];
      this.autoUpdateQuietPendingSet.delete(String(shareId || "").trim());
      changed = true;
    });
    Object.keys(this.autoUpdateStructDigestByShare || {}).forEach((shareId) => {
      if (shareIdSet.has(String(shareId))) return;
      delete this.autoUpdateStructDigestByShare[shareId];
      changed = true;
    });
    Object.keys(this.autoUpdateShareNotebookHintById || {}).forEach((shareId) => {
      if (shareIdSet.has(String(shareId))) return;
      delete this.autoUpdateShareNotebookHintById[shareId];
      changed = true;
    });
    if (changed) {
      this.scheduleAutoUpdateQuietFlush();
      this.refreshDocTreeMarksLater();
      this.refreshAutoUpdateStatusTextInDock();
      this.schedulePersistAutoUpdateRuntime();
    }
  }

  getAutoUpdateShareState(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return null;
    return this.autoUpdateShareStates?.[id] || null;
  }

  getAutoUpdateShareNotebookHint(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return "";
    const notebookId = String(this.autoUpdateShareNotebookHintById?.[id] || "").trim();
    return isValidNotebookId(notebookId) ? notebookId : "";
  }

  setAutoUpdateShareNotebookHint(shareId, notebookId) {
    const id = String(shareId || "").trim();
    const boxId = String(notebookId || "").trim();
    if (!id || !isValidNotebookId(boxId)) return;
    if (!this.autoUpdateShareNotebookHintById || typeof this.autoUpdateShareNotebookHintById !== "object") {
      this.autoUpdateShareNotebookHintById = {};
    }
    if (this.autoUpdateShareNotebookHintById[id] !== boxId) {
      this.autoUpdateShareNotebookHintById[id] = boxId;
    }
  }

  getAutoUpdateShareChangeSeq(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return 0;
    return Math.max(0, Math.floor(Number(this.autoUpdateShareChangeSeqById?.[id]) || 0));
  }

  markAutoUpdateShareChanged(shareIds) {
    const ids = Array.from(
      new Set(
        (Array.isArray(shareIds) ? shareIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => id),
      ),
    );
    if (!ids.length) return;
    if (!this.autoUpdateShareChangeSeqById || typeof this.autoUpdateShareChangeSeqById !== "object") {
      this.autoUpdateShareChangeSeqById = {};
    }
    ids.forEach((id) => {
      const next = this.getAutoUpdateShareChangeSeq(id) + 1;
      this.autoUpdateShareChangeSeqById[id] = next;
    });
  }

  getAutoUpdateQuietWindowMs() {
    const active = this.getActiveSite();
    const seconds = Number(active?.quietWindowSeconds);
    const val = Math.max(30, Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
    return val * 1000;
  }

  hasAutoUpdateQuietPending(shareId) {
    const id = String(shareId || "").trim();
    if (!id) return false;
    if (!(this.autoUpdateQuietPendingSet instanceof Set) || !this.autoUpdateQuietPendingSet.has(id)) {
      return false;
    }
    const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[id]) || 0));
    if (deadline > 0) return true;
    this.autoUpdateQuietPendingSet.delete(id);
    return false;
  }

  scheduleAutoUpdateQuietFlush() {
    if (!(this.autoUpdateQuietPendingSet instanceof Set) || this.autoUpdateQuietPendingSet.size === 0) {
      if (this.autoUpdateQuietFlushTimer) {
        clearTimeout(this.autoUpdateQuietFlushTimer);
        this.autoUpdateQuietFlushTimer = null;
      }
      this.autoUpdateQuietNextFlushAt = 0;
      return;
    }
    const now = nowTs();
    let nextAt = 0;
    const pendingIds = Array.from(this.autoUpdateQuietPendingSet).map((id) => String(id || "").trim()).filter((id) => id);
    pendingIds.forEach((shareId) => {
      if (!this.getShareById(shareId)) {
        this.autoUpdateQuietPendingSet.delete(shareId);
        if (Object.prototype.hasOwnProperty.call(this.autoUpdateQuietDeadlineByShare || {}, shareId)) {
          delete this.autoUpdateQuietDeadlineByShare[shareId];
        }
        delete this.autoUpdateQuietFirstEnteredByShare[shareId];
        return;
      }
      const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[shareId]) || 0));
      if (!deadline) {
        this.autoUpdateQuietPendingSet.delete(shareId);
        if (Object.prototype.hasOwnProperty.call(this.autoUpdateQuietDeadlineByShare || {}, shareId)) {
          delete this.autoUpdateQuietDeadlineByShare[shareId];
        }
        delete this.autoUpdateQuietFirstEnteredByShare[shareId];
        return;
      }
      if (!nextAt || deadline < nextAt) {
        nextAt = deadline;
      }
    });
    if (!nextAt) {
      if (this.autoUpdateQuietFlushTimer) {
        clearTimeout(this.autoUpdateQuietFlushTimer);
        this.autoUpdateQuietFlushTimer = null;
      }
      this.autoUpdateQuietNextFlushAt = 0;
      return;
    }
    if (
      this.autoUpdateQuietFlushTimer &&
      this.autoUpdateQuietNextFlushAt > 0 &&
      this.autoUpdateQuietNextFlushAt <= nextAt + 16
    ) {
      return;
    }
    if (this.autoUpdateQuietFlushTimer) {
      clearTimeout(this.autoUpdateQuietFlushTimer);
      this.autoUpdateQuietFlushTimer = null;
    }
    const delay = Math.max(0, nextAt - now);
    this.autoUpdateQuietNextFlushAt = nextAt;
    this.autoUpdateQuietFlushTimer = setTimeout(() => {
      this.autoUpdateQuietFlushTimer = null;
      this.autoUpdateQuietNextFlushAt = 0;
      void this.flushAutoUpdateQuietPending();
    }, delay + 24);
  }

  async flushAutoUpdateQuietPending() {
    if (!(this.autoUpdateQuietPendingSet instanceof Set) || this.autoUpdateQuietPendingSet.size === 0) {
      return 0;
    }
    if (!this.isAutoUpdateEnabledForActiveSite()) {
      this.autoUpdateQuietPendingSet.clear();
      this.autoUpdateQuietDeadlineByShare = {};
      this.autoUpdateQuietFirstEnteredByShare = {};
      this.autoUpdateQuietNextFlushAt = 0;
      return 0;
    }
    const now = nowTs();
    const dueIds = [];
    const notebooks = await this.refreshNotebookStateForAutoUpdate({force: true});
    for (const shareIdRaw of Array.from(this.autoUpdateQuietPendingSet)) {
      const shareId = String(shareIdRaw || "").trim();
      if (!shareId) continue;
      const share = this.getShareById(shareId);
      if (!share) {
        this.autoUpdateQuietPendingSet.delete(shareId);
        delete this.autoUpdateQuietDeadlineByShare[shareId];
        delete this.autoUpdateQuietFirstEnteredByShare[shareId];
        continue;
      }
      const notebookId = await this.getAutoUpdateShareNotebookId(share);
      if (isValidNotebookId(notebookId) && this.isNotebookClosedForAutoUpdateFromRows(notebookId, notebooks)) {
        this.markAutoUpdateShareSkippedNotebookClosed(shareId, {clearQuiet: true});
        continue;
      }
      const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[shareId]) || 0));
      if (!deadline || deadline > now) continue;
      dueIds.push(shareId);
      this.autoUpdateQuietPendingSet.delete(shareId);
      delete this.autoUpdateQuietDeadlineByShare[shareId];
      delete this.autoUpdateQuietFirstEnteredByShare[shareId];
    }
    let added = 0;
    if (dueIds.length > 0) {
      added = this.enqueueAutoUpdateShareIds(dueIds, {
        ignoreRetryBlock: false,
        markChange: false,
        applyQuietWindow: false,
      });
      const hasPendingQueue =
        added > 0 ||
        dueIds.some((shareId) => this.autoUpdateQueuedSet.has(shareId) || this.autoUpdateCurrentShareId === shareId);
      if (hasPendingQueue) {
        this.scheduleAutoUpdateNow(80);
      }
      this.schedulePersistAutoUpdateRuntime();
    }
    if (this.autoUpdateQuietPendingSet.size > 0) {
      this.scheduleAutoUpdateQuietFlush();
    } else {
      this.autoUpdateQuietNextFlushAt = 0;
    }
    return added;
  }

  async syncAutoUpdateStructDigestAfterShareSuccess(shareId, {expectedChangeSeq = null} = {}) {
    const id = String(shareId || "").trim();
    if (!id) return "";
    if (!this.getShareById(id)) return "";
    const expected = Number.isFinite(Number(expectedChangeSeq))
      ? Math.max(0, Math.floor(Number(expectedChangeSeq)))
      : null;
    if (expected !== null && this.getAutoUpdateShareChangeSeq(id) !== expected) {
      return "";
    }
    let digest = "";
    try {
      digest = normalizeHashHex(await this.computeAutoUpdateStructureDigestForShare(id));
    } catch (err) {
      if (!isAbortError(err)) {
        console.warn("sync auto-update struct digest failed", err);
      }
      return "";
    }
    if (!digest) return "";
    if (expected !== null && this.getAutoUpdateShareChangeSeq(id) !== expected) {
      return "";
    }
    if (!this.autoUpdateStructDigestByShare || typeof this.autoUpdateStructDigestByShare !== "object") {
      this.autoUpdateStructDigestByShare = {};
    }
    if (this.autoUpdateStructDigestByShare[id] !== digest) {
      this.autoUpdateStructDigestByShare[id] = digest;
      this.schedulePersistAutoUpdateRuntime();
    }
    return digest;
  }

  async enqueueAutoUpdateByDocIds(docIds, {source = "", forceDocIds = []} = {}) {
    if (!this.isAutoUpdateEnabledForActiveSite()) return 0;
    const siteId = String(this.getActiveSiteId() || "").trim();
    if (!siteId) return 0;
    const rules = this.buildAutoUpdateShareRules();
    if (!rules.length) return 0;
    const ids = Array.from(
      new Set((Array.isArray(docIds) ? docIds : []).map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!ids.length) return 0;
    if (source === "tree") {
      this.invalidateDocIconCacheByDocIds(ids);
    }
    const metas = await this.queryDocMetaByIds(ids);
    if (!Array.isArray(metas) || metas.length === 0) return 0;
    const shareIdSet = new Set();
    metas.forEach((meta) => this.collectAutoUpdateShareIdsByDocMeta(meta, rules, shareIdSet));
    if (!shareIdSet.size) return 0;
    const forceDocIdSet =
      source === "tree"
        ? new Set(
            (Array.isArray(forceDocIds) ? forceDocIds : [])
              .map((id) => String(id || "").trim())
              .filter((id) => isValidDocId(id)),
          )
        : new Set();
    const forceShareIdSet = new Set();
    if (source === "tree" && forceDocIdSet.size > 0) {
      metas.forEach((meta) => {
        const docId = String(meta?.docId || "").trim();
        if (!forceDocIdSet.has(docId)) return;
        this.collectAutoUpdateShareIdsByDocMeta(meta, rules, forceShareIdSet);
      });
    }
    let candidateShareIds = Array.from(shareIdSet);
    if (source === "tree") {
      const filteredCandidates = candidateShareIds.filter((shareId) => !forceShareIdSet.has(shareId));
      const digestPassed = await this.filterAutoUpdateShareIdsByStructureDigest(filteredCandidates, {
        createBaselineWhenMissing: false,
        freshDocIds: ids,
      });
      candidateShareIds = Array.from(new Set([...forceShareIdSet, ...digestPassed]));
    }
    if (!candidateShareIds.length) return 0;
    candidateShareIds = await this.filterAutoUpdateShareIdsByNotebookClosed(candidateShareIds, {forceRefresh: true});
    if (!candidateShareIds.length) return 0;
    const added = this.enqueueAutoUpdateShareIds(candidateShareIds);
    if (added > 0 || this.autoUpdateQueue.length > 0 || this.autoUpdateQuietPendingSet.size > 0) {
      this.scheduleAutoUpdateNow(source === "tree" ? 80 : 120);
    }
    return added;
  }

  async filterAutoUpdateShareIdsByStructureDigest(
    shareIds,
    {createBaselineWhenMissing = true, freshDocIds = []} = {},
  ) {
    const normalizedShareIds = Array.from(
      new Set(
        (Array.isArray(shareIds) ? shareIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => id),
      ),
    );
    if (!normalizedShareIds.length) return [];
    if (!this.autoUpdateStructDigestByShare || typeof this.autoUpdateStructDigestByShare !== "object") {
      this.autoUpdateStructDigestByShare = {};
    }
    const preferDbIconDocIdSet = new Set(
      (Array.isArray(freshDocIds) ? freshDocIds : [])
        .map((id) => String(id || "").trim())
        .filter((id) => isValidDocId(id)),
    );
    const out = [];
    let digestStoreChanged = false;
    for (const shareId of normalizedShareIds) {
      if (!this.getShareById(shareId)) continue;
      if (
        this.autoUpdateCurrentShareId === shareId ||
        this.autoUpdateQueuedSet?.has?.(shareId) ||
        this.autoUpdateRerunSet?.has?.(shareId)
      ) {
        out.push(shareId);
        continue;
      }
      try {
        const nextDigest = normalizeHashHex(
          await this.computeAutoUpdateStructureDigestForShare(shareId, {preferDbIconDocIdSet}),
        );
        if (!nextDigest) {
          out.push(shareId);
          continue;
        }
        const prevDigest = normalizeHashHex(this.autoUpdateStructDigestByShare?.[shareId]);
        if (!prevDigest) {
          if (createBaselineWhenMissing) {
            this.autoUpdateStructDigestByShare[shareId] = nextDigest;
            digestStoreChanged = true;
          } else {
            out.push(shareId);
          }
          continue;
        }
        if (prevDigest !== nextDigest) {
          out.push(shareId);
        }
      } catch (err) {
        if (!isAbortError(err)) {
          console.warn("auto-update structure digest filter failed", err);
        }
        out.push(shareId);
      }
    }
    if (digestStoreChanged) {
      this.schedulePersistAutoUpdateRuntime();
    }
    return out;
  }

  normalizeAutoUpdateStructureDocs(rows) {
    const out = [];
    const seen = new Set();
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const docId = String(row?.docId || "").trim();
      if (!isValidDocId(docId) || seen.has(docId)) return;
      seen.add(docId);
      out.push({
        docId,
        title: String(row?.title || ""),
        parentId: String(row?.parentId || "").trim(),
        sortIndex: Number.isFinite(Number(row?.sortIndex)) ? Number(row.sortIndex) : index,
        sortOrder: Number.isFinite(Number(row?.sortOrder)) ? Number(row.sortOrder) : index,
        icon: normalizeDocIconValue(row?.icon || ""),
      });
    });
    return out;
  }

  async resolveAutoUpdateStructureScopeDocs(share, {controller = null, preferDbIconDocIdSet = null} = {}) {
    const t = this.t.bind(this);
    if (!share || typeof share !== "object") return [];
    const shareId = String(share?.id || "").trim();
    if (!shareId) return [];
    const fallbackIncludeChildren =
      share?.type === SHARE_TYPES.NOTEBOOK
        ? true
        : typeof share?.includeChildren === "boolean"
          ? share.includeChildren
          : false;
    const option = this.getShareOptionValue(shareId, {fallbackIncludeChildren});
    const excludedDocIds = normalizeDocIdList(option?.excludedDocIds || share?.excludedDocIds || []);
    const notebookIdForShare = await this.getAutoUpdateShareNotebookId(share, {controller});
    if (isValidNotebookId(notebookIdForShare)) {
      const isClosed = await this.isNotebookClosedForAutoUpdate(notebookIdForShare, {forceRefresh: true});
      if (isClosed) return [];
    }
    if (share?.type === SHARE_TYPES.NOTEBOOK) {
      const notebookId = String(share?.notebookId || "").trim();
      if (!isValidNotebookId(notebookId)) return [];
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const tree = await this.listDocsInNotebook(notebookId, {fillIcons: false, controller});
      const docsRaw = Array.isArray(tree?.docs) ? tree.docs : [];
      const normalized = this.normalizeAutoUpdateStructureDocs(docsRaw);
      const filtered = this.filterScopeDocsByExcludedDocIds(normalized, excludedDocIds);
      const docs = this.normalizeAutoUpdateStructureDocs(filtered?.docs || []);
      if (docs.length) {
        await this.fillDocIcons(docs, {preferDbIconDocIdSet});
        applyDefaultDocIcons(docs);
      }
      return docs;
    }
    const docId = String(share?.docId || "").trim();
    if (!isValidDocId(docId)) return [];
    const includeChildren =
      typeof option?.includeChildren === "boolean"
        ? option.includeChildren
        : typeof share?.includeChildren === "boolean"
          ? share.includeChildren
          : false;
    if (!includeChildren) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const row = await this.fetchBlockRow(docId);
      if (!row) return [];
      const icon = await this.resolveDocIcon(docId);
      const docs = this.normalizeAutoUpdateStructureDocs([
        {
          docId,
          title: typeof row?.content === "string" ? row.content : "",
          parentId: "",
          sortIndex: 0,
          sortOrder: 0,
          icon,
        },
      ]);
      if (docs.length) {
        applyDefaultDocIcons(docs);
      }
      return docs;
    }
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const subtree = await this.listDocSubtree(docId, {fillIcons: false, controller});
    const normalized = this.normalizeAutoUpdateStructureDocs(subtree || []);
    const filtered = this.filterScopeDocsByExcludedDocIds(normalized, excludedDocIds, {lockedDocIds: [docId]});
    const docs = this.normalizeAutoUpdateStructureDocs(filtered?.docs || []);
    if (docs.length) {
      await this.fillDocIcons(docs, {preferDbIconDocIdSet});
      applyDefaultDocIcons(docs);
    }
    return docs;
  }

  buildAutoUpdateStructureDigestInput(share, docs) {
    const rows = this.normalizeAutoUpdateStructureDocs(docs || []);
    const rootDocId = share?.type === SHARE_TYPES.DOC ? String(share?.docId || "").trim() : "";
    const ordered = this.buildDocSelectionRows(rows, {rootDocId});
    const normalizedRows = ordered.map((doc, index) => ({
      docId: String(doc?.docId || "").trim(),
      title: String(doc?.title || ""),
      parentId: String(doc?.parentId || ""),
      sortIndex: normalizeSortIndexForHash(doc?.sortIndex ?? index),
      sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder) || index)),
      icon: normalizeDocIconValue(doc?.icon || ""),
    }));
    const key =
      share?.type === SHARE_TYPES.NOTEBOOK ? String(share?.notebookId || "").trim() : String(share?.docId || "").trim();
    return JSON.stringify({
      version: 1,
      shareId: String(share?.id || "").trim(),
      type: String(share?.type || ""),
      key,
      rows: normalizedRows,
    });
  }

  async computeAutoUpdateStructureDigestForShare(shareId, {controller = null, preferDbIconDocIdSet = null} = {}) {
    const id = String(shareId || "").trim();
    if (!id) return "";
    const share = this.getShareById(id);
    if (!share) return "";
    const docs = await this.resolveAutoUpdateStructureScopeDocs(share, {controller, preferDbIconDocIdSet});
    const input = this.buildAutoUpdateStructureDigestInput(share, docs);
    if (!input) return "";
    return normalizeHashHex(await hashTextSha256(input));
  }

  async refreshAutoUpdateStructDigestForShare(shareId, {controller = null} = {}) {
    const id = String(shareId || "").trim();
    if (!id) return "";
    try {
      const digest = await this.computeAutoUpdateStructureDigestForShare(id, {controller});
      if (!digest) return "";
      if (!this.autoUpdateStructDigestByShare || typeof this.autoUpdateStructDigestByShare !== "object") {
        this.autoUpdateStructDigestByShare = {};
      }
      if (this.autoUpdateStructDigestByShare[id] !== digest) {
        this.autoUpdateStructDigestByShare[id] = digest;
        this.schedulePersistAutoUpdateRuntime();
      }
      return digest;
    } catch (err) {
      if (!isAbortError(err)) {
        console.warn("refresh auto-update struct digest failed", err);
      }
      return "";
    }
  }

  stopAutoUpdateStructureReconcile() {
    if (this.autoUpdateStructReconcileTimer) {
      clearTimeout(this.autoUpdateStructReconcileTimer);
      this.autoUpdateStructReconcileTimer = null;
    }
    this.autoUpdateStructReconcileQueue = [];
    this.autoUpdateStructReconcileRunning = false;
    this.autoUpdateStructReconcileSiteId = "";
  }

  scheduleAutoUpdateStructureReconcile({immediate = false, reset = false} = {}) {
    if (!this.isAutoUpdateEnabledForActiveSite()) return;
    const siteId = String(this.getActiveSiteId() || "").trim();
    if (!siteId) return;
    const shareIds = (Array.isArray(this.shares) ? this.shares : [])
      .map((share) => String(share?.id || "").trim())
      .filter((id) => id);
    if (!shareIds.length) return;
    const shouldReset =
      reset ||
      this.autoUpdateStructReconcileSiteId !== siteId ||
      !Array.isArray(this.autoUpdateStructReconcileQueue) ||
      this.autoUpdateStructReconcileQueue.length === 0;
    if (shouldReset) {
      this.autoUpdateStructReconcileQueue = shareIds;
      this.autoUpdateStructReconcileSiteId = siteId;
    }
    if (this.autoUpdateStructReconcileRunning) return;
    if (this.autoUpdateStructReconcileTimer) {
      if (!immediate) return;
      clearTimeout(this.autoUpdateStructReconcileTimer);
      this.autoUpdateStructReconcileTimer = null;
    }
    const delay = immediate ? 180 : 1200;
    this.autoUpdateStructReconcileTimer = setTimeout(() => {
      this.autoUpdateStructReconcileTimer = null;
      void this.runAutoUpdateStructureReconcileStep({siteId});
    }, delay);
  }

  async runAutoUpdateStructureReconcileStep({siteId = ""} = {}) {
    const activeSiteId = String(this.getActiveSiteId() || "").trim();
    const expectedSiteId = String(siteId || activeSiteId).trim();
    if (!activeSiteId || !expectedSiteId || activeSiteId !== expectedSiteId) {
      this.stopAutoUpdateStructureReconcile();
      return;
    }
    if (!this.isAutoUpdateEnabledForActiveSite()) {
      this.stopAutoUpdateStructureReconcile();
      return;
    }
    if (this.autoUpdating || this.autoUpdateCurrentController || this.backgroundSyncing) {
      this.scheduleAutoUpdateStructureReconcile({immediate: false, reset: false});
      return;
    }
    const queue = Array.isArray(this.autoUpdateStructReconcileQueue) ? this.autoUpdateStructReconcileQueue : [];
    const shareId = String(queue.shift() || "").trim();
    this.autoUpdateStructReconcileQueue = queue;
    if (!shareId) {
      this.stopAutoUpdateStructureReconcile();
      return;
    }
    if (this.autoUpdateStructReconcileRunning) return;
    this.autoUpdateStructReconcileRunning = true;
    try {
      const share = this.getShareById(shareId);
      if (share) {
        const notebookId = await this.getAutoUpdateShareNotebookId(share);
        const isClosed =
          isValidNotebookId(notebookId) &&
          (await this.isNotebookClosedForAutoUpdate(notebookId, {forceRefresh: true}));
        const digest = await this.computeAutoUpdateStructureDigestForShare(shareId);
        if (digest) {
          const prevDigest = normalizeHashHex(this.autoUpdateStructDigestByShare?.[shareId]);
          if (!prevDigest) {
            this.autoUpdateStructDigestByShare[shareId] = digest;
            this.schedulePersistAutoUpdateRuntime();
          } else if (isClosed) {
            if (prevDigest !== digest) {
              this.autoUpdateStructDigestByShare[shareId] = digest;
              this.schedulePersistAutoUpdateRuntime();
            }
          } else if (prevDigest !== digest) {
            const added = this.enqueueAutoUpdateShareIds([shareId], {suppressQuietReset: true});
            if (added > 0 || this.autoUpdateQueuedSet.has(shareId)) {
              this.scheduleAutoUpdateNow(80);
            }
          }
        }
      }
    } catch (err) {
      if (!isAbortError(err)) {
        console.warn("auto-update structure reconcile failed", err);
      }
    } finally {
      this.autoUpdateStructReconcileRunning = false;
    }
    if (
      this.isAutoUpdateEnabledForActiveSite() &&
      String(this.getActiveSiteId() || "").trim() === activeSiteId &&
      this.autoUpdateStructReconcileQueue.length > 0
    ) {
      this.scheduleAutoUpdateStructureReconcile({immediate: false, reset: false});
    }
  }

  normalizeAutoUpdateDocMetaRow(row) {
    const docId = String(row?.id || "").trim();
    if (!isValidDocId(docId)) return null;
    const notebookId = String(row?.box || row?.notebookId || "").trim();
    const path = String(row?.path || "").trim();
    const updated = normalizeDocUpdatedStamp(row?.updated);
    const pathIds = new Set(collectDocIdsFromPath(path));
    pathIds.add(docId);
    return {
      docId,
      notebookId,
      path,
      updated,
      pathIds,
    };
  }

  async queryChangedDocMetaSince(sinceCursor, {controller = null} = {}) {
    const t = this.t.bind(this);
    const cursor = this.normalizeAutoUpdateScanCursor(sinceCursor);
    const sinceUpdated = normalizeDocUpdatedStamp(cursor?.updated);
    if (!sinceUpdated) return [];
    const sinceDocId = isValidDocId(cursor?.docId) ? String(cursor.docId || "").trim() : "";
    const quotedUpdated = escapeSqlString(sinceUpdated);
    const quotedDocId = escapeSqlString(sinceDocId || "");
    throwIfAborted(controller, t("siyuanShare.message.cancelled"));
    const rows = await this.querySqlRows(
      `SELECT id, box, path, updated FROM blocks WHERE type='d' AND (updated > '${quotedUpdated}' OR (updated = '${quotedUpdated}' AND id > '${quotedDocId}')) ORDER BY updated ASC, id ASC`,
    );
    if (!Array.isArray(rows)) {
      throw new Error("Auto update detection failed while querying changed docs");
    }
    return rows.map((row) => this.normalizeAutoUpdateDocMetaRow(row)).filter(Boolean);
  }

  async queryDocMetaByIds(docIds, {controller = null} = {}) {
    const t = this.t.bind(this);
    const ids = Array.from(
      new Set((Array.isArray(docIds) ? docIds : []).map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!ids.length) return [];
    const out = [];
    for (const part of chunkArray(ids, 200)) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const quoted = part.map((id) => `'${escapeSqlString(id)}'`).join(",");
      const rows = await this.querySqlRows(
        `SELECT id, box, path, updated FROM blocks WHERE type='d' AND id IN (${quoted})`,
      );
      if (!Array.isArray(rows)) {
        throw new Error("Auto update detection failed while querying doc meta");
      }
      rows.forEach((row) => {
        const normalized = this.normalizeAutoUpdateDocMetaRow(row);
        if (normalized) out.push(normalized);
      });
    }
    return out;
  }

  async queryRefImpactedDocIdsByTargets(targetDocIds, {controller = null} = {}) {
    const t = this.t.bind(this);
    const schema = await this.resolveRefQuerySchema();
    if (!schema) return [];
    const targets = Array.from(
      new Set(
        (Array.isArray(targetDocIds) ? targetDocIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => isValidDocId(id)),
      ),
    );
    if (!targets.length) return [];
    const impacted = new Set();
    for (const part of chunkArray(targets, 120)) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const quoted = part.map((id) => `'${escapeSqlString(id)}'`).join(",");
      const rows = await this.querySqlRows(
        `SELECT DISTINCT ${schema.rootCol} AS docId FROM ${schema.table} WHERE ${schema.targetCol} IN (${quoted})`,
      );
      if (!Array.isArray(rows)) {
        throw new Error("Auto update detection failed while querying refs");
      }
      rows.forEach((row) => {
        const docId = String(row?.docId || "").trim();
        if (isValidDocId(docId)) impacted.add(docId);
      });
    }
    return Array.from(impacted);
  }

  isDocMetaExcludedByRoots(docMeta, excludedSet) {
    if (!docMeta || !(excludedSet instanceof Set) || excludedSet.size === 0) return false;
    if (excludedSet.has(docMeta.docId)) return true;
    for (const id of docMeta.pathIds || []) {
      if (excludedSet.has(id)) return true;
    }
    return false;
  }

  buildAutoUpdateShareRules() {
    return (Array.isArray(this.shares) ? this.shares : [])
      .map((share) => {
        const shareId = String(share?.id || "").trim();
        if (!shareId) return null;
        const fallbackIncludeChildren =
          share?.type === SHARE_TYPES.NOTEBOOK
            ? true
            : typeof share?.includeChildren === "boolean"
              ? share.includeChildren
              : false;
        const option = this.getShareOptionValue(shareId, {fallbackIncludeChildren});
        const excludedDocIds = normalizeDocIdList(option?.excludedDocIds || share?.excludedDocIds || []);
        const excludedSet = new Set(excludedDocIds);
        if (share?.type === SHARE_TYPES.DOC && isValidDocId(share?.docId)) {
          excludedSet.delete(String(share.docId || "").trim());
        }
        return {
          shareId,
          type: String(share?.type || ""),
          docId: String(share?.docId || "").trim(),
          notebookId: String(share?.notebookId || "").trim(),
          includeChildren: !!option?.includeChildren,
          excludedSet,
        };
      })
      .filter(Boolean);
  }

  collectAutoUpdateShareIdsByDocMeta(docMeta, rules, outSet) {
    if (!docMeta || !Array.isArray(rules) || !(outSet instanceof Set)) return;
    const notebookId = String(docMeta?.notebookId || "").trim();
    rules.forEach((rule) => {
      if (rule.type === SHARE_TYPES.NOTEBOOK) {
        if (!rule.notebookId || docMeta.notebookId !== rule.notebookId) return;
        if (this.isDocMetaExcludedByRoots(docMeta, rule.excludedSet)) return;
        outSet.add(rule.shareId);
        this.setAutoUpdateShareNotebookHint(rule.shareId, rule.notebookId || notebookId);
        return;
      }
      if (rule.type !== SHARE_TYPES.DOC || !rule.docId) return;
      if (docMeta.docId === rule.docId) {
        outSet.add(rule.shareId);
        this.setAutoUpdateShareNotebookHint(rule.shareId, notebookId);
        return;
      }
      if (!rule.includeChildren) return;
      if (!docMeta.pathIds?.has?.(rule.docId)) return;
      if (this.isDocMetaExcludedByRoots(docMeta, rule.excludedSet)) return;
      outSet.add(rule.shareId);
      this.setAutoUpdateShareNotebookHint(rule.shareId, notebookId);
    });
  }

  async filterAutoUpdateShareIdsByNotebookClosed(shareIds, {forceRefresh = true} = {}) {
    const normalizedShareIds = Array.from(
      new Set(
        (Array.isArray(shareIds) ? shareIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => id),
      ),
    );
    if (!normalizedShareIds.length) return [];
    const notebooks = await this.refreshNotebookStateForAutoUpdate({force: forceRefresh});
    const openShareIds = [];
    for (const shareId of normalizedShareIds) {
      const share = this.getShareById(shareId);
      if (!share) continue;
      const notebookId = await this.getAutoUpdateShareNotebookId(share);
      if (isValidNotebookId(notebookId) && this.isNotebookClosedForAutoUpdateFromRows(notebookId, notebooks)) {
        this.markAutoUpdateShareSkippedNotebookClosed(shareId, {clearQuiet: true});
        continue;
      }
      openShareIds.push(shareId);
    }
    return openShareIds;
  }

  async detectAutoUpdateShareCandidates({siteId = "", controller = null} = {}) {
    const activeSiteId = String(siteId || this.getActiveSiteId()).trim();
    if (!activeSiteId) {
      return {
        sinceCursor: {updated: "", docId: ""},
        nextCursor: {updated: "", docId: ""},
        sinceStamp: "",
        nextStamp: "",
        shareIds: [],
        changedCount: 0,
      };
    }
    const fallbackUpdated = formatDocUpdatedStampFromMs(nowTs() - 90 * 1000);
    const sinceCursor = this.getAutoUpdateScanCursor(activeSiteId);
    const effectiveCursor = this.normalizeAutoUpdateScanCursor(sinceCursor) || {
      updated: fallbackUpdated,
      docId: "",
    };
    const changedMetas = await this.queryChangedDocMetaSince(effectiveCursor, {controller});
    if (!Array.isArray(changedMetas) || changedMetas.length === 0) {
      return {
        sinceCursor: effectiveCursor,
        nextCursor: effectiveCursor,
        sinceStamp: normalizeDocUpdatedStamp(effectiveCursor?.updated),
        nextStamp: normalizeDocUpdatedStamp(effectiveCursor?.updated),
        shareIds: [],
        changedCount: 0,
      };
    }
    const changedIds = Array.from(new Set(changedMetas.map((meta) => String(meta?.docId || "").trim())));
    const changedSet = new Set(changedIds);
    const refImpactedDocIds = await this.queryRefImpactedDocIdsByTargets(changedIds, {controller});
    const extraDocIds = Array.from(
      new Set(
        (Array.isArray(refImpactedDocIds) ? refImpactedDocIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => isValidDocId(id) && !changedSet.has(id)),
      ),
    );
    const extraMetas = extraDocIds.length ? await this.queryDocMetaByIds(extraDocIds, {controller}) : [];
    const allMetas = [...changedMetas, ...(Array.isArray(extraMetas) ? extraMetas : [])];
    const rules = this.buildAutoUpdateShareRules();
    const shareIdSet = new Set();
    allMetas.forEach((meta) => this.collectAutoUpdateShareIdsByDocMeta(meta, rules, shareIdSet));
    const nextCursor = changedMetas.reduce(
      (maxCursor, meta) => {
        const stamp = normalizeDocUpdatedStamp(meta?.updated);
        const docId = String(meta?.docId || "").trim();
        if (!stamp || !isValidDocId(docId)) return maxCursor;
        const maxStamp = normalizeDocUpdatedStamp(maxCursor?.updated);
        const maxDocId = isValidDocId(maxCursor?.docId) ? String(maxCursor.docId || "").trim() : "";
        if (!maxStamp || stamp > maxStamp || (stamp === maxStamp && docId > maxDocId)) {
          return {updated: stamp, docId};
        }
        return maxCursor;
      },
      {
        updated: normalizeDocUpdatedStamp(effectiveCursor?.updated) || fallbackUpdated,
        docId: isValidDocId(effectiveCursor?.docId) ? String(effectiveCursor.docId || "").trim() : "",
      },
    );
    return {
      sinceCursor: effectiveCursor,
      nextCursor,
      sinceStamp: normalizeDocUpdatedStamp(effectiveCursor?.updated),
      nextStamp: normalizeDocUpdatedStamp(nextCursor?.updated) || formatDocUpdatedStampFromMs(nowTs()) || "",
      shareIds: Array.from(shareIdSet),
      changedCount: changedMetas.length,
    };
  }

  enqueueAutoUpdateShareIds(
    shareIds,
    {
      ignoreRetryBlock = false,
      markChange = true,
      applyQuietWindow = true,
      suppressQuietReset = false,
      manualSkipTag = "",
    } = {},
  ) {
    const normalized = Array.from(
      new Set(
        (Array.isArray(shareIds) ? shareIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => id),
      ),
    );
    if (!normalized.length) return 0;
    if (markChange && applyQuietWindow) {
      const quietMs = this.getAutoUpdateQuietWindowMs();
      if (quietMs > 0) {
        const now = nowTs();
        const dedupWindowMs = Math.max(0, Math.floor(Number(AUTO_UPDATE_QUIET_DEDUP_WINDOW_MS) || 0));
        if (!this.autoUpdateQuietDeadlineByShare || typeof this.autoUpdateQuietDeadlineByShare !== "object") {
          this.autoUpdateQuietDeadlineByShare = {};
          this.autoUpdateQuietFirstEnteredByShare = {};
        }
        const removeQueuedShare = (id) => {
          if (this.autoUpdateQueuedSet.has(id)) {
            this.autoUpdateQueue = this.autoUpdateQueue.filter((queuedId) => String(queuedId || "").trim() !== id);
            this.autoUpdateQueuedSet.delete(id);
          }
          this.autoUpdateRerunSet.delete(id);
        };
        let deferred = 0;
        const immediateIds = [];
        normalized.forEach((shareId) => {
          if (!this.getShareById(shareId)) return;
          if (this.autoUpdateManualSkipRealtimeOnceSet.has(shareId)) {
            this.autoUpdateManualSkipRealtimeOnceSet.delete(shareId);
            return;
          }
          if (manualSkipTag === "detect" && this.autoUpdateManualSkipDetectSet.has(shareId)) {
            this.autoUpdateManualSkipDetectSet.delete(shareId);
            return;
          }
          const deadline = Math.max(0, Math.floor(Number(this.autoUpdateQuietDeadlineByShare?.[shareId]) || 0));
          const alreadyQuiet = this.autoUpdateQuietPendingSet.has(shareId) && deadline > now;
          if (alreadyQuiet && suppressQuietReset) {
            this.setAutoUpdateShareState(shareId, "quiet");
            return;
          }
          const isCurrent = this.autoUpdateCurrentShareId === shareId;
          const isQueued = this.autoUpdateQueuedSet.has(shareId) || this.autoUpdateRerunSet.has(shareId);
          if (suppressQuietReset && !alreadyQuiet && (isCurrent || isQueued)) {
            immediateIds.push(shareId);
            return;
          }
          const lastDeadlineSetAt = alreadyQuiet && deadline > 0 ? deadline - quietMs : 0;
          if (alreadyQuiet && dedupWindowMs > 0 && lastDeadlineSetAt > 0 && now - lastDeadlineSetAt <= dedupWindowMs) {
            return;
          }
          const firstEnteredAt = Math.max(0, Math.floor(Number(this.autoUpdateQuietFirstEnteredByShare?.[shareId]) || 0));
          const maxQuietDurationMs = quietMs * Math.max(1, this.autoUpdateQuietMaxMultiplier || 5);
          if (alreadyQuiet && firstEnteredAt > 0 && now - firstEnteredAt >= maxQuietDurationMs) {
            this.autoUpdateQuietPendingSet.delete(shareId);
            delete this.autoUpdateQuietDeadlineByShare[shareId];
            delete this.autoUpdateQuietFirstEnteredByShare[shareId];
            immediateIds.push(shareId);
            return;
          }
          this.markAutoUpdateShareChanged([shareId]);
          removeQueuedShare(shareId);
          this.autoUpdateQuietPendingSet.add(shareId);
          this.autoUpdateQuietDeadlineByShare[shareId] = now + quietMs;
          if (!firstEnteredAt) {
            this.autoUpdateQuietFirstEnteredByShare[shareId] = now;
          }
          if (
            this.autoUpdateCurrentShareId === shareId &&
            this.autoUpdateCurrentController &&
            !this.autoUpdateCurrentController.signal?.aborted
          ) {
            this.autoUpdateAbortByQuietSet.add(shareId);
            try {
              this.autoUpdateCurrentController.abort();
            } catch {
              // ignore
            }
          }
          this.setAutoUpdateShareState(shareId, "quiet");
          deferred += 1;
        });
        if (deferred > 0) {
          this.scheduleAutoUpdateQuietFlush();
          this.schedulePersistAutoUpdateRuntime();
        }
        if (immediateIds.length > 0) {
          return this.enqueueAutoUpdateShareIds(immediateIds, {
            ignoreRetryBlock,
            markChange,
            applyQuietWindow: false,
            suppressQuietReset: false,
          });
        }
        return 0;
      }
    }
    const now = nowTs();
    let added = 0;
    normalized.forEach((shareId) => {
      if (markChange) {
        this.markAutoUpdateShareChanged([shareId]);
      }
      if (!ignoreRetryBlock) {
        const retry = this.isAutoUpdateRetryBlocked(shareId, now);
        if (retry.blocked) {
          const message =
            retry.message ||
            this.buildAutoUpdateRetryMessage({
              attempt: retry.attempt || 1,
              retryAt: retry.retryAt,
              error: "",
            });
          this.setAutoUpdateShareState(shareId, "error", {message});
          this.scheduleAutoUpdateRetryWakeup();
          return;
        }
      }
      if (this.autoUpdateCurrentShareId && this.autoUpdateCurrentShareId === shareId) {
        this.autoUpdateRerunSet.add(shareId);
        if (this.getAutoUpdateShareState(shareId)?.state !== "syncing") {
          this.setAutoUpdateShareState(shareId, "queued");
        }
        return;
      }
      if (this.autoUpdateQueuedSet.has(shareId)) {
        this.setAutoUpdateShareState(shareId, "queued");
        return;
      }
      this.autoUpdateQueue.push(shareId);
      this.autoUpdateQueuedSet.add(shareId);
      this.setAutoUpdateShareState(shareId, "queued");
      this.pushAutoUpdateHistory("info", this.t("siyuanShare.message.autoUpdateQueued"), {shareId});
      added += 1;
    });
    if (added > 0) {
      this.schedulePersistAutoUpdateRuntime();
    }
    return added;
  }

  async processAutoUpdateQueue({siteId = ""} = {}) {
    const currentSiteId = String(siteId || this.getActiveSiteId()).trim();
    let hadFailure = false;
    let interrupted = false;
    while (this.autoUpdateQueue.length > 0) {
      if (!this.isAutoUpdateEnabledForActiveSite()) {
        interrupted = true;
        break;
      }
      if (String(this.getActiveSiteId() || "") !== currentSiteId) {
        interrupted = true;
        break;
      }
      if (this.backgroundSyncing) {
        interrupted = true;
        break;
      }
      const shareId = String(this.autoUpdateQueue.shift() || "").trim();
      if (!shareId) continue;
      this.autoUpdateQueuedSet.delete(shareId);
      const retryGate = this.isAutoUpdateRetryBlocked(shareId);
      if (retryGate.blocked) {
        const blockedMessage =
          retryGate.message ||
          this.buildAutoUpdateRetryMessage({
            attempt: retryGate.attempt || 1,
            retryAt: retryGate.retryAt,
          });
        this.setAutoUpdateShareState(shareId, "error", {message: blockedMessage});
        continue;
      }
      const share = this.getShareById(shareId);
      if (!share) {
        this.setAutoUpdateShareState(shareId, "");
        this.clearAutoUpdateRetryState(shareId);
        continue;
      }
      this.autoUpdateAbortByNotebookClosedSet.delete(shareId);
      const shareNotebookId = await this.getAutoUpdateShareNotebookId(share);
      if (isValidNotebookId(shareNotebookId)) {
        const isClosed = await this.isNotebookClosedForAutoUpdate(shareNotebookId, {forceRefresh: true});
        if (isClosed) {
          this.markAutoUpdateShareSkippedNotebookClosed(shareId, {clearQuiet: true});
          continue;
        }
      }
      const controller = new AbortController();
      this.autoUpdateCurrentShareId = shareId;
      this.autoUpdateCurrentController = controller;
      const expectedChangeSeq = this.getAutoUpdateShareChangeSeq(shareId);
      let notebookCloseMonitorTimer = null;
      let notebookCloseMonitorRunning = false;
      const stopNotebookCloseMonitor = () => {
        if (!notebookCloseMonitorTimer) return;
        clearInterval(notebookCloseMonitorTimer);
        notebookCloseMonitorTimer = null;
      };
      const scheduleNotebookCloseMonitor = () => {
        if (!isValidNotebookId(shareNotebookId)) return;
        notebookCloseMonitorTimer = setInterval(() => {
          if (notebookCloseMonitorRunning) return;
          notebookCloseMonitorRunning = true;
          void this.isNotebookClosedForAutoUpdate(shareNotebookId, {forceRefresh: true})
            .then((isClosed) => {
              if (!isClosed) return;
              this.autoUpdateAbortByNotebookClosedSet.add(shareId);
              if (controller && !controller.signal?.aborted) {
                try {
                  controller.abort();
                } catch {
                  // ignore
                }
              }
            })
            .finally(() => {
              notebookCloseMonitorRunning = false;
            });
        }, AUTO_UPDATE_NOTEBOOK_CLOSE_MONITOR_MS);
      };
      this.setAutoUpdateShareState(shareId, "syncing");
      this.pushAutoUpdateHistory("info", this.t("siyuanShare.message.autoUpdateSyncing"), {shareId});
      try {
        await this.persistAutoUpdateRuntimeNow();
      } catch {
        // ignore
      }
      scheduleNotebookCloseMonitor();
      try {
        await this.updateShare(shareId, {background: true, controller, autoUpdateExpectedChangeSeq: expectedChangeSeq});
        this.autoUpdateAbortByNotebookClosedSet.delete(shareId);
        this.clearAutoUpdateRetryState(shareId);
        if (this.autoUpdateRerunSet.has(shareId)) {
          this.autoUpdateRerunSet.delete(shareId);
          if (this.hasAutoUpdateQuietPending(shareId)) {
            this.setAutoUpdateShareState(shareId, "quiet");
            this.scheduleAutoUpdateQuietFlush();
          } else if (!this.autoUpdateQueuedSet.has(shareId)) {
            this.autoUpdateQueue.push(shareId);
            this.autoUpdateQueuedSet.add(shareId);
            this.setAutoUpdateShareState(shareId, "queued");
          }
        } else if (this.hasAutoUpdateQuietPending(shareId)) {
          this.setAutoUpdateShareState(shareId, "quiet");
          this.scheduleAutoUpdateQuietFlush();
        } else {
          this.setAutoUpdateShareState(shareId, "");
        }
        this.pushAutoUpdateHistory("success", this.t("siyuanShare.message.autoUpdateSuccess"), {shareId});
      } catch (err) {
        if (isAbortError(err)) {
          if (this.autoUpdateAbortByNotebookClosedSet.has(shareId)) {
            this.autoUpdateAbortByNotebookClosedSet.delete(shareId);
            this.markAutoUpdateShareSkippedNotebookClosed(shareId, {clearQuiet: true});
            continue;
          }
          if (this.autoUpdateAbortByQuietSet.has(shareId)) {
            this.autoUpdateAbortByQuietSet.delete(shareId);
            if (this.autoUpdateQueuedSet.has(shareId)) {
              this.autoUpdateQueue = this.autoUpdateQueue.filter((id) => String(id || "").trim() !== shareId);
              this.autoUpdateQueuedSet.delete(shareId);
            }
            this.autoUpdateRerunSet.delete(shareId);
            if (this.hasAutoUpdateQuietPending(shareId)) {
              this.setAutoUpdateShareState(shareId, "quiet");
              this.scheduleAutoUpdateQuietFlush();
            } else {
              this.setAutoUpdateShareState(shareId, "");
            }
            continue;
          }
          if (this.autoUpdateAbortByManualSet.has(shareId)) {
            this.autoUpdateAbortByManualSet.delete(shareId);
            if (this.autoUpdateQueuedSet.has(shareId)) {
              this.autoUpdateQueue = this.autoUpdateQueue.filter((id) => String(id || "").trim() !== shareId);
              this.autoUpdateQueuedSet.delete(shareId);
            }
            this.autoUpdateRerunSet.delete(shareId);
            if (this.hasAutoUpdateQuietPending(shareId)) {
              this.setAutoUpdateShareState(shareId, "quiet");
              this.scheduleAutoUpdateQuietFlush();
            } else {
              this.setAutoUpdateShareState(shareId, "");
            }
            continue;
          }
          interrupted = true;
          if (this.getShareById(shareId) && !this.autoUpdateQueuedSet.has(shareId) && this.isAutoUpdateEnabledForActiveSite()) {
            this.autoUpdateQueue.unshift(shareId);
            this.autoUpdateQueuedSet.add(shareId);
            this.setAutoUpdateShareState(shareId, "queued");
          } else if (!this.getShareById(shareId)) {
            this.autoUpdateRerunSet.delete(shareId);
            this.setAutoUpdateShareState(shareId, "");
          }
          break;
        }
        if (isValidNotebookId(shareNotebookId)) {
          const isClosed = await this.isNotebookClosedForAutoUpdate(shareNotebookId, {forceRefresh: true});
          if (isClosed) {
            this.markAutoUpdateShareSkippedNotebookClosed(shareId, {clearQuiet: true});
            continue;
          }
        }
        const isDocTreeFetchEmptyError = String(err?.message || "")
          .includes("Doc tree fetch failed: listDocsByPath returned empty.");
        if (!isValidNotebookId(shareNotebookId) && isDocTreeFetchEmptyError) {
          try {
            const fallbackNotebookId = await this.getAutoUpdateShareNotebookId(share);
            if (isValidNotebookId(fallbackNotebookId)) {
              const isClosed = await this.isNotebookClosedForAutoUpdate(fallbackNotebookId, {forceRefresh: true});
              if (isClosed) {
                this.markAutoUpdateShareSkippedNotebookClosed(shareId, {clearQuiet: true});
                continue;
              }
            }
          } catch {
            // ignore fallback notebook resolution errors
          }
        }
        this.autoUpdateRerunSet.delete(shareId);
        hadFailure = true;
        this.markAutoUpdateShareFailure(shareId, err);
      } finally {
        stopNotebookCloseMonitor();
        this.autoUpdateCurrentShareId = "";
        this.autoUpdateCurrentController = null;
      }
    }
    this.scheduleAutoUpdateRetryWakeup();
    this.schedulePersistAutoUpdateRuntime();
    return {hadFailure, interrupted};
  }

  async runAutoUpdateOnce() {
    if (!this.isAutoUpdateEnabledForActiveSite()) return null;
    if (!this.settings.siteUrl || !this.settings.apiKey) return null;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    if (this.autoUpdating) return null;
    if (this.backgroundSyncing) return null;
    const siteId = String(this.getActiveSiteId() || "").trim();
    if (!siteId) return null;
    this.autoUpdating = true;
    this.autoUpdateLastScanAt = nowTs();
    this.refreshAutoUpdateStatusTextInDock();
    try {
      await this.flushAutoUpdateQuietPending();
      const result = await this.detectAutoUpdateShareCandidates({siteId});
      const shareIds = Array.isArray(result?.shareIds) ? result.shareIds : [];
      const openShareIds =
        shareIds.length > 0
          ? await this.filterAutoUpdateShareIdsByNotebookClosed(shareIds, {forceRefresh: true})
          : [];
      if (openShareIds.length > 0) {
        this.enqueueAutoUpdateShareIds(openShareIds, {suppressQuietReset: true, manualSkipTag: "detect"});
      }
      const retryShareIds = this.getDueAutoUpdateRetryShareIds();
      const openRetryShareIds =
        retryShareIds.length > 0
          ? await this.filterAutoUpdateShareIdsByNotebookClosed(retryShareIds, {forceRefresh: true})
          : [];
      if (openRetryShareIds.length > 0) {
        this.enqueueAutoUpdateShareIds(openRetryShareIds, {
          ignoreRetryBlock: true,
          markChange: false,
          applyQuietWindow: false,
        });
      }
      const queueResult = await this.processAutoUpdateQueue({siteId});
      if (String(this.getActiveSiteId() || "") !== siteId) {
        this.autoUpdateLastResult = {
          changed: openShareIds.length > 0,
          retried: openRetryShareIds.length,
          failed: !!queueResult?.hadFailure,
          interrupted: true,
        };
        return {
          changed: openShareIds.length > 0,
          failed: !!queueResult?.hadFailure,
          interrupted: true,
        };
      }
      if (!queueResult?.interrupted && Number(result?.changedCount) > 0) {
        const nextCursor = this.normalizeAutoUpdateScanCursor(result?.nextCursor || {updated: result?.nextStamp, docId: ""});
        if (nextCursor?.updated) {
          await this.setAutoUpdateScanCursor(siteId, nextCursor);
        }
      }
      const finalResult = {
        changed: openShareIds.length > 0,
        retried: openRetryShareIds.length,
        failed: !!queueResult?.hadFailure,
        interrupted: !!queueResult?.interrupted,
      };
      this.autoUpdateLastResult = finalResult;
      return {
        changed: finalResult.changed,
        failed: finalResult.failed,
        interrupted: finalResult.interrupted,
      };
    } catch (err) {
      if (!isAbortError(err)) {
        console.warn("auto update failed", err);
        this.pushAutoUpdateHistory("error", this.t("siyuanShare.message.autoUpdateLoopError"), {
          detail: String(err?.message || err || ""),
        });
      }
      this.autoUpdateLastResult = null;
      return null;
    } finally {
      this.autoUpdating = false;
      this.refreshAutoUpdateStatusTextInDock();
      this.scheduleAutoUpdateRetryWakeup();
    }
  }

  getBackgroundSyncDelayMs() {
    const hidden = document?.hidden;
    const min = hidden ? this.backgroundSyncHiddenMinDelayMs : this.backgroundSyncMinDelayMs;
    const max = hidden ? this.backgroundSyncHiddenMaxDelayMs : this.backgroundSyncMaxDelayMs;
    const base = Math.min(Math.max(this.backgroundSyncDelayMs || min, min), max);
    const jitter = Math.floor(Math.random() * 60 * 1000);
    return base + jitter;
  }

  updateBackgroundSyncDelay({success = false, changed = false} = {}) {
    if (!success || changed) {
      this.backgroundSyncDelayMs = this.backgroundSyncMinDelayMs;
      return;
    }
    const next = Math.ceil((this.backgroundSyncDelayMs || this.backgroundSyncMinDelayMs) * 1.6);
    this.backgroundSyncDelayMs = Math.min(next, this.backgroundSyncMaxDelayMs);
  }

  startBackgroundSync({immediate = false} = {}) {
    if (this.backgroundSyncLoopRunner) {
      if (immediate && this.backgroundSyncTimer) {
        clearTimeout(this.backgroundSyncTimer);
        this.backgroundSyncTimer = setTimeout(this.backgroundSyncLoopRunner, 0);
      }
      return;
    }
    const loop = async () => {
      if (this.backgroundSyncLoopRunner !== loop) return;
      if (this.backgroundSyncTimer) {
        clearTimeout(this.backgroundSyncTimer);
        this.backgroundSyncTimer = null;
      }
      const scheduleNext = () => {
        if (this.backgroundSyncLoopRunner !== loop) return;
        const delay = this.getBackgroundSyncDelayMs();
        this.backgroundSyncTimer = setTimeout(loop, delay);
      };
      if (!this.settings.siteUrl || !this.settings.apiKey) {
        scheduleNext();
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        scheduleNext();
        return;
      }
      const result = await this.runBackgroundSyncOnce();
      if (result) {
        this.updateBackgroundSyncDelay(result);
      }
      if (this.backgroundSyncLoopRunner !== loop) return;
      scheduleNext();
    };
    this.backgroundSyncLoopRunner = loop;
    this.backgroundSyncTimer = setTimeout(loop, immediate ? 0 : this.getBackgroundSyncDelayMs());
  }

  stopBackgroundSync() {
    if (this.backgroundSyncTimer) {
      clearTimeout(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
    }
    this.backgroundSyncLoopRunner = null;
    this.backgroundSyncing = false;
  }

  async runBackgroundSyncOnce() {
    if (!this.settings.siteUrl || !this.settings.apiKey) return null;
    if (this.backgroundSyncing) return null;
    if (this.autoUpdating || this.autoUpdateCurrentController) return null;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    this.backgroundSyncing = true;
    let success = false;
    let changed = false;
    const prevSignature = getShareSignature(this.shares);
    try {
      await this.verifyRemote({silent: true, background: true});
      const shares = await this.syncRemoteShares({silent: true, background: true});
      const nextSignature = getShareSignature(shares);
      changed = nextSignature !== prevSignature;
      success = true;
    } catch {
      // silent background sync: ignore
    } finally {
      this.backgroundSyncing = false;
    }
    return {success, changed};
  }
}

function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (input) => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return null;
    seen.add(input);
    if (Array.isArray(input)) {
      return input.map((item) => normalize(item));
    }
    const out = {};
    Object.keys(input)
      .sort()
      .forEach((key) => {
        out[key] = normalize(input[key]);
      });
    return out;
  };
  return JSON.stringify(normalize(value));
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

module.exports = SiYuanSharePlugin;
module.exports.default = SiYuanSharePlugin;

