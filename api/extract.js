/**
 * Vercel Serverless Function — /api/extract
 * Sama persis logikanya dengan server.js, hanya bentuknya disesuaikan
 * agar berjalan sebagai serverless function di Vercel.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");

const REQUEST_TIMEOUT = 15000;
const MAX_ASSETS_PER_TYPE = 40;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

function normalizeUrl(input) {
  let value = (input || "").trim();
  if (!value) throw new Error("URL tidak boleh kosong.");
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  const parsed = new URL(value);
  return parsed.href;
}

async function safeFetchText(assetUrl) {
  try {
    const res = await axios.get(assetUrl, {
      timeout: REQUEST_TIMEOUT,
      headers: BROWSER_HEADERS,
      responseType: "text",
      transformResponse: [(d) => d],
      maxContentLength: 8 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return typeof res.data === "string" ? res.data : String(res.data);
  } catch (err) {
    return null;
  }
}

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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method tidak diizinkan." });
  }

  const startedAt = Date.now();
  let targetUrl;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    targetUrl = normalizeUrl(body.url);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "URL tidak valid. Contoh: https://example.com" });
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
    if (err.code === "ECONNABORTED") message = "Permintaan timeout. Website terlalu lama merespons.";
    else if (err.response) message = `Website merespons dengan status ${err.response.status}. Situs mungkin memblokir akses otomatis.`;
    else if (err.request) message = "Tidak ada respons dari website. Domain mungkin tidak dapat dijangkau.";
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

  const jsLinks = [];
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) jsLinks.push(src);
  });
  const inlineScripts = [];
  $("script:not([src])").each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    if (type && type.includes("json")) return;
    const content = $(el).html();
    if (content && content.trim()) inlineScripts.push(content.trim());
  });

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
      } catch (_) {}
    }
    return out.slice(0, MAX_ASSETS_PER_TYPE);
  };

  const absCssLinks = toAbsolute(cssLinks);
  const absJsLinks = toAbsolute(jsLinks);

  const [cssResults, jsResults] = await Promise.all([
    Promise.all(absCssLinks.map((u) => safeFetchText(u))),
    Promise.all(absJsLinks.map((u) => safeFetchText(u))),
  ]);

  const cssFiles = [];
  absCssLinks.forEach((u, i) => {
    if (cssResults[i] !== null) cssFiles.push({ url: u, filename: filenameFromUrl(u, "css", cssFiles.length), content: cssResults[i] });
  });
  inlineStyles.forEach((content, i) => cssFiles.push({ url: null, filename: `inline-style-${i + 1}.css`, content }));

  const jsFiles = [];
  absJsLinks.forEach((u, i) => {
    if (jsResults[i] !== null) jsFiles.push({ url: u, filename: filenameFromUrl(u, "js", jsFiles.length), content: jsResults[i] });
  });
  inlineScripts.forEach((content, i) => jsFiles.push({ url: null, filename: `inline-script-${i + 1}.js`, content }));

  const byteLen = (s) => Buffer.byteLength(s || "", "utf8");
  const totalBytes = byteLen(html) + cssFiles.reduce((s, f) => s + byteLen(f.content), 0) + jsFiles.reduce((s, f) => s + byteLen(f.content), 0);

  const stats = {
    cssFileCount: cssFiles.length,
    jsFileCount: jsFiles.length,
    totalBytes,
    htmlBytes: byteLen(html),
    durationMs: Date.now() - startedAt,
    cssFailedCount: absCssLinks.length - cssResults.filter((r) => r !== null).length,
    jsFailedCount: absJsLinks.length - jsResults.filter((r) => r !== null).length,
  };

  res.status(200).json({
    ok: true,
    requestedUrl: targetUrl,
    finalUrl,
    title: $("title").first().text().trim() || null,
    html,
    css: cssFiles,
    js: jsFiles,
    stats,
  });
};
