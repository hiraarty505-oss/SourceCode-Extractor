/**
 * SourceCode Extractor — backend
 * Node.js + Express + Axios + Cheerio
 *
 * POST /api/extract  { url }
 *   -> fetches the target page, parses it with cheerio, resolves every
 *      <link rel="stylesheet"> and <script src> against the page URL,
 *      downloads each asset in parallel, and returns everything the
 *      frontend needs to render tabs, stats and downloads.
 */

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const REQUEST_TIMEOUT = 15000;
const MAX_ASSETS_PER_TYPE = 40; // safety cap so a huge page can't hang the server
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

/** Normalize a user-supplied URL, defaulting to https:// */
function normalizeUrl(input) {
  let value = (input || "").trim();
  if (!value) throw new Error("URL tidak boleh kosong.");
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  const parsed = new URL(value); // throws if invalid
  return parsed.href;
}

/** Fetch a single text resource, returning null on failure instead of throwing */
async function safeFetchText(assetUrl) {
  try {
    const res = await axios.get(assetUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: BROWSER_HEADERS,
      responseType: "text",
      transformResponse: [(d) => d], // keep raw string, no JSON auto-parse
      maxContentLength: 8 * 1024 * 1024, // 8MB safety cap per asset
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return typeof res.data === "string" ? res.data : String(res.data);
  } catch (err) {
    return null;
  }
}

app.post("/api/extract", async (req, res) => {
  const startedAt = Date.now();
  let targetUrl;

  try {
    targetUrl = normalizeUrl(req.body && req.body.url);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "URL tidak valid. Pastikan formatnya benar, contoh: https://example.com" });
  }

  let pageResponse;
  try {
    pageResponse = await axios.get(targetUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: BROWSER_HEADERS,
      responseType: "text",
      transformResponse: [(d) => d],
      maxContentLength: 15 * 1024 * 1024,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
  } catch (err) {
    let message = "Gagal mengambil website. Periksa kembali URL dan coba lagi.";
    if (err.code === "ECONNABORTED") {
      message = "Permintaan timeout. Website terlalu lama merespons.";
    } else if (err.response) {
      message = `Website merespons dengan status ${err.response.status}. Situs mungkin memblokir akses otomatis.`;
    } else if (err.request) {
      message = "Tidak ada respons dari website. Domain mungkin tidak dapat dijangkau.";
    }
    return res.status(502).json({ ok: false, error: message });
  }

  const html = pageResponse.data;
  const finalUrl = (pageResponse.request && pageResponse.request.res && pageResponse.request.res.responseUrl) || targetUrl;

  let $;
  try {
    $ = cheerio.load(html);
  } catch (e) {
    return res.status(422).json({ ok: false, error: "Gagal mem-parsing HTML dari website ini." });
  }

  // ---- Collect CSS sources: external <link rel="stylesheet"> + inline <style> ----
  const cssLinks = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) cssLinks.push(href);
  });

  const inlineStyles = [];
  $("style").each((_, el) => {
    const content = $(el).html();
    if (content && content.trim()) inlineStyles.push(content.trim());
  });

  // ---- Collect JS sources: external <script src> + inline <script> ----
  const jsLinks = [];
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) jsLinks.push(src);
  });

  const inlineScripts = [];
  $("script:not([src])").each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    if (type && type.includes("json")) return; // skip JSON-LD / data blobs
    const content = $(el).html();
    if (content && content.trim()) inlineScripts.push(content.trim());
  });

  // ---- Resolve to absolute URLs, dedupe, cap ----
  const toAbsolute = (list) => {
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      try {
        const abs = new URL(raw, finalUrl).href;
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push(abs);
        }
      } catch (_) {
        /* ignore malformed URLs */
      }
    }
    return out.slice(0, MAX_ASSETS_PER_TYPE);
  };

  const absCssLinks = toAbsolute(cssLinks);
  const absJsLinks = toAbsolute(jsLinks);

  // ---- Fetch all external assets in parallel ----
  const [cssResults, jsResults] = await Promise.all([
    Promise.all(absCssLinks.map((u) => safeFetchText(u))),
    Promise.all(absJsLinks.map((u) => safeFetchText(u))),
  ]);

  const cssFiles = [];
  absCssLinks.forEach((u, i) => {
    if (cssResults[i] !== null) {
      cssFiles.push({ url: u, filename: filenameFromUrl(u, "css", cssFiles.length), content: cssResults[i] });
    }
  });
  inlineStyles.forEach((content, i) => {
    cssFiles.push({ url: null, filename: `inline-style-${i + 1}.css`, content });
  });

  const jsFiles = [];
  absJsLinks.forEach((u, i) => {
    if (jsResults[i] !== null) {
      jsFiles.push({ url: u, filename: filenameFromUrl(u, "js", jsFiles.length), content: jsResults[i] });
    }
  });
  inlineScripts.forEach((content, i) => {
    jsFiles.push({ url: null, filename: `inline-script-${i + 1}.js`, content });
  });

  // ---- Stats ----
  const byteLen = (s) => Buffer.byteLength(s || "", "utf8");
  const totalBytes =
    byteLen(html) +
    cssFiles.reduce((sum, f) => sum + byteLen(f.content), 0) +
    jsFiles.reduce((sum, f) => sum + byteLen(f.content), 0);

  const stats = {
    cssFileCount: cssFiles.length,
    jsFileCount: jsFiles.length,
    totalBytes,
    htmlBytes: byteLen(html),
    durationMs: Date.now() - startedAt,
    cssFailedCount: absCssLinks.length - (cssResults.filter((r) => r !== null).length),
    jsFailedCount: absJsLinks.length - (jsResults.filter((r) => r !== null).length),
  };

  res.json({
    ok: true,
    requestedUrl: targetUrl,
    finalUrl,
    title: $("title").first().text().trim() || null,
    html,
    css: cssFiles,
    js: jsFiles,
    stats,
  });
});

function filenameFromUrl(u, ext, index) {
  try {
    const parsed = new URL(u);
    let base = parsed.pathname.split("/").filter(Boolean).pop() || `asset-${index + 1}`;
    base = base.split("?")[0].split("#")[0];
    if (!base.toLowerCase().endsWith("." + ext)) base += "." + ext;
    return base;
  } catch (_) {
    return `asset-${index + 1}.${ext}`;
  }
}

app.get("/api/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`SourceCode Extractor running → http://localhost:${PORT}`);
});
