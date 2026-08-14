(() => {
  "use strict";

  /* ============================================================
     State
     ============================================================ */
  const state = {
    result: null,       // last successful extraction payload from the API
    activeTab: "preview",
    originalPanelHTML: {}, // cache of Prism-highlighted innerHTML per tab, so search can restore it
    searchHits: [],
    searchIndex: -1,
  };

  const HISTORY_KEY = "sce_history_v1";
  const MAX_HISTORY = 25;

  /* ============================================================
     DOM refs
     ============================================================ */
  const $ = (id) => document.getElementById(id);

  const form = $("extractForm");
  const urlInput = $("urlInput");
  const extractBtn = $("extractBtn");
  const loadingPanel = $("loadingPanel");
  const loadingText = $("loadingText");
  const errorPanel = $("errorPanel");
  const errorMessage = $("errorMessage");
  const errorDismiss = $("errorDismiss");
  const workspace = $("workspace");
  const emptyState = $("emptyState");

  const statCss = $("statCss");
  const statJs = $("statJs");
  const statSize = $("statSize");
  const statTime = $("statTime");
  const statUrl = $("statUrl");
  const statUrlChip = $("statUrlChip");

  const fileTree = $("fileTree");
  const historyList = $("historyList");
  const clearHistoryBtn = $("clearHistoryBtn");

  const previewFrame = $("previewFrame");
  const previewFallback = $("previewFallback");

  const codeHtml = $("codeHtml");
  const codeCss = $("codeCss");
  const codeJs = $("codeJs");

  const toolbarMeta = $("toolbarMeta");
  const copyBtn = $("copyBtn");
  const downloadCurrentBtn = $("downloadCurrentBtn");
  const downloadZipBtn = $("downloadZipBtn");

  const searchInput = $("searchInput");
  const searchCount = $("searchCount");
  const searchPrev = $("searchPrev");
  const searchNext = $("searchNext");

  const codeElByTab = { html: codeHtml, css: codeCss, js: codeJs };
  const panelElByTab = {
    preview: $("panel-preview"),
    html: $("panel-html"),
    css: $("panel-css"),
    js: $("panel-js"),
  };

  /* ============================================================
     Helpers
     ============================================================ */
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 KB";
    const kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(kb < 10 ? 2 : 1) + " KB";
    return (kb / 1024).toFixed(2) + " MB";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function showToast(message, kind = "success") {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      toast.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 13 4 4L19 7"/></svg><span></span>`;
      document.body.appendChild(toast);
    }
    toast.querySelector("span").textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove("is-visible"), 2200);
  }

  function triggerDownload(filename, content, mime = "text/plain") {
    const blob = new Blob([content], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ============================================================
     History (localStorage)
     ============================================================ */
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch (_) {
      return [];
    }
  }

  function saveHistoryEntry(entry) {
    let hist = loadHistory().filter((h) => h.url !== entry.url);
    hist.unshift(entry);
    hist = hist.slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    renderHistory();
  }

  function deleteHistoryEntry(url) {
    const hist = loadHistory().filter((h) => h.url !== url);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    renderHistory();
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }

  function renderHistory() {
    const hist = loadHistory();
    historyList.innerHTML = "";
    if (!hist.length) {
      historyList.innerHTML = `<li class="history-empty">Belum ada riwayat scan.</li>`;
      return;
    }
    hist.forEach((h) => {
      const li = document.createElement("li");
      li.className = "history-item";
      li.title = h.url;
      li.innerHTML = `
        <span class="history-item__url">${escapeHtml(h.url)}</span>
        <button class="history-item__del" aria-label="Hapus dari riwayat" title="Hapus">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>`;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".history-item__del")) return;
        urlInput.value = h.url;
        runExtraction(h.url);
      });
      li.querySelector(".history-item__del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteHistoryEntry(h.url);
      });
      historyList.appendChild(li);
    });
  }

  clearHistoryBtn.addEventListener("click", () => {
    if (!loadHistory().length) return;
    if (confirm("Hapus semua riwayat scan?")) clearHistory();
  });

  /* ============================================================
     Extraction flow
     ============================================================ */
  const loadingMessages = [
    "Menghubungkan ke server…",
    "Mengambil dokumen HTML…",
    "Mem-parsing struktur halaman…",
    "Mengunduh file CSS…",
    "Mengunduh file JavaScript…",
    "Menyusun statistik & preview…",
  ];

  let loadingInterval = null;
  function startLoadingCycle() {
    let i = 0;
    loadingText.textContent = loadingMessages[0];
    loadingInterval = setInterval(() => {
      i = (i + 1) % loadingMessages.length;
      loadingText.textContent = loadingMessages[i];
    }, 900);
  }
  function stopLoadingCycle() {
    clearInterval(loadingInterval);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    runExtraction(url);
  });

  document.querySelectorAll(".link-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      urlInput.value = btn.dataset.example;
      runExtraction(btn.dataset.example);
    });
  });

  errorDismiss.addEventListener("click", () => (errorPanel.hidden = true));

  /* ------------------------------------------------------------
     Client-side fallback extractor.
     Used automatically whenever /api/extract is unavailable
     (no backend deployed, 404, network error, etc). Fetches the
     target page — and every linked CSS/JS file — through a public
     CORS proxy, since browsers block direct cross-origin fetches.
     ------------------------------------------------------------ */
  // Beberapa proxy dicoba berurutan — kalau satu down/rate-limited, otomatis
  // lanjut ke proxy berikutnya, supaya fitur tidak gagal total.
  const CORS_PROXIES = [
    (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    (url) => "https://corsproxy.io/?url=" + encodeURIComponent(url),
    (url) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url),
  ];

  function normalizeUrl(input) {
    let u = input.trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
  }

  async function fetchViaProxy(absoluteUrl) {
    let lastError = null;
    for (const buildProxyUrl of CORS_PROXIES) {
      try {
        const res = await fetch(buildProxyUrl(absoluteUrl));
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return await res.text();
      } catch (err) {
        lastError = err;
        // coba proxy berikutnya
      }
    }
    throw new Error(`Gagal mengambil ${absoluteUrl} (semua proxy gagal: ${lastError?.message || "unknown"})`);
  }

  function filenameFromUrl(assetUrl, fallbackExt) {
    try {
      const u = new URL(assetUrl);
      const last = u.pathname.split("/").filter(Boolean).pop();
      return last || `inline.${fallbackExt}`;
    } catch (_) {
      return `inline.${fallbackExt}`;
    }
  }

  async function extractClientSide(rawUrl, onProgress) {
    const startedAt = performance.now();
    const finalUrl = normalizeUrl(rawUrl);

    onProgress("Mengambil dokumen HTML…");
    const html = await fetchViaProxy(finalUrl);

    const doc = new DOMParser().parseFromString(html, "text/html");
    const title = doc.querySelector("title")?.textContent?.trim() || "";

    const cssLinks = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))
      .map((el) => el.getAttribute("href"))
      .filter(Boolean);
    const inlineStyles = Array.from(doc.querySelectorAll("style"))
      .map((el) => el.textContent || "")
      .filter((t) => t.trim());

    const jsLinks = Array.from(doc.querySelectorAll("script[src]"))
      .map((el) => el.getAttribute("src"))
      .filter(Boolean);
    const inlineScripts = Array.from(doc.querySelectorAll("script:not([src])"))
      .map((el) => el.textContent || "")
      .filter((t) => t.trim());

    onProgress("Mengunduh file CSS…");
    const cssResults = await Promise.allSettled(
      cssLinks.map(async (href) => {
        const abs = new URL(href, finalUrl).href;
        const content = await fetchViaProxy(abs);
        return { filename: filenameFromUrl(abs, "css"), url: abs, content };
      })
    );
    const css = cssResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
    inlineStyles.forEach((content, i) =>
      css.push({ filename: `inline-style-${i + 1}.css`, url: "", content })
    );

    onProgress("Mengunduh file JavaScript…");
    const jsResults = await Promise.allSettled(
      jsLinks.map(async (src) => {
        const abs = new URL(src, finalUrl).href;
        const content = await fetchViaProxy(abs);
        return { filename: filenameFromUrl(abs, "js"), url: abs, content };
      })
    );
    const js = jsResults.filter((r) => r.status === "fulfilled").map((r) => r.value);
    inlineScripts.forEach((content, i) =>
      js.push({ filename: `inline-script-${i + 1}.js`, url: "", content })
    );

    onProgress("Menyusun statistik & preview…");
    const totalBytes =
      new Blob([html]).size +
      css.reduce((sum, f) => sum + new Blob([f.content]).size, 0) +
      js.reduce((sum, f) => sum + new Blob([f.content]).size, 0);

    return {
      ok: true,
      requestedUrl: rawUrl,
      finalUrl,
      title,
      html,
      css,
      js,
      stats: {
        cssFileCount: css.length,
        jsFileCount: js.length,
        totalBytes,
        durationMs: Math.round(performance.now() - startedAt),
      },
    };
  }

  async function runExtraction(rawUrl) {
    errorPanel.hidden = true;
    workspace.hidden = true;
    emptyState.hidden = true;
    loadingPanel.hidden = false;
    extractBtn.disabled = true;
    startLoadingCycle();

    let data = null;
    let backendAvailable = true;

    // 1) Try the real backend first (in case one is deployed at /api/extract).
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawUrl }),
      });
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        // No JSON API at this route (likely a 404 HTML page) — no backend deployed.
        backendAvailable = false;
      } else {
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || "Terjadi kesalahan yang tidak diketahui.");
        data = json;
      }
    } catch (err) {
      if (err instanceof TypeError) {
        backendAvailable = false; // network-level failure = no backend reachable
      } else {
        stopLoadingCycle();
        loadingPanel.hidden = true;
        extractBtn.disabled = false;
        errorMessage.textContent = err.message || "Gagal terhubung ke server.";
        errorPanel.hidden = false;
        emptyState.hidden = false;
        return;
      }
    }

    // 2) No backend deployed → fall back to client-side extraction via CORS proxy.
    if (!data && !backendAvailable) {
      try {
        data = await extractClientSide(rawUrl, (msg) => (loadingText.textContent = msg));
      } catch (err) {
        stopLoadingCycle();
        loadingPanel.hidden = true;
        extractBtn.disabled = false;
        errorMessage.textContent =
          err.message ||
          "Tidak dapat mengambil source code. Periksa URL, atau situs target mungkin memblokir akses.";
        errorPanel.hidden = false;
        emptyState.hidden = false;
        return;
      }
    }

    state.result = data;
    renderResult(data);
    saveHistoryEntry({ url: data.requestedUrl, title: data.title, ts: Date.now() });
    workspace.hidden = false;

    stopLoadingCycle();
    loadingPanel.hidden = true;
    extractBtn.disabled = false;
  }

  /* ============================================================
     Rendering results
     ============================================================ */
  function mergeFiles(files, commentStyle) {
    if (!files.length) return "/* Tidak ada file ditemukan */";
    return files
      .map((f) => {
        const header =
          commentStyle === "css"
            ? `/* ===== ${f.filename}${f.url ? " — " + f.url : " (inline)"} ===== */`
            : `// ===== ${f.filename}${f.url ? " — " + f.url : " (inline)"} =====`;
        return `${header}\n${f.content}`;
      })
      .join("\n\n");
  }

  function renderResult(data) {
    // Stats
    statCss.textContent = data.stats.cssFileCount;
    statJs.textContent = data.stats.jsFileCount;
    statSize.textContent = formatBytes(data.stats.totalBytes);
    statTime.textContent = data.stats.durationMs + " ms";
    statUrl.textContent = data.finalUrl;
    statUrlChip.title = data.finalUrl;

    // Merge & highlight code
    const mergedCss = mergeFiles(data.css, "css");
    const mergedJs = mergeFiles(data.js, "js");

    codeHtml.textContent = data.html || "";
    codeCss.textContent = mergedCss;
    codeJs.textContent = mergedJs;

    [codeHtml, codeCss, codeJs].forEach((el) => {
      el.removeAttribute("data-highlighted");
    });

    if (window.Prism) {
      Prism.highlightElement(codeHtml);
      Prism.highlightElement(codeCss);
      Prism.highlightElement(codeJs);
    }

    // cache highlighted HTML so search can be reset later
    state.originalPanelHTML = {
      html: codeHtml.innerHTML,
      css: codeCss.innerHTML,
      js: codeJs.innerHTML,
    };

    // File tree
    fileTree.innerHTML = "";
    addFileTreeItem("index.html", "html", "html");
    data.css.forEach((f) => addFileTreeItem(f.filename, "css", "css"));
    if (!data.css.length) addFileTreeItem("(tidak ada CSS)", "css", null, true);
    data.js.forEach((f) => addFileTreeItem(f.filename, "js", "js"));
    if (!data.js.length) addFileTreeItem("(tidak ada JS)", "js", null, true);

    // Preview via srcdoc + <base> so relative assets still resolve against the original site
    renderPreview(data);

    // Reset to preview tab
    setActiveTab("preview");
    clearSearch();
  }

  function addFileTreeItem(label, tab, dotClass, disabled) {
    const li = document.createElement("li");
    li.innerHTML = `${dotClass ? `<span class="dot dot--${dotClass}"></span>` : ""}<span>${escapeHtml(label)}</span>`;
    if (disabled) {
      li.style.opacity = "0.4";
      li.style.cursor = "default";
    } else {
      li.addEventListener("click", () => setActiveTab(tab));
    }
    fileTree.appendChild(li);
  }

  function renderPreview(data) {
    previewFallback.hidden = true;
    try {
      let html = data.html || "";
      const baseTag = `<base href="${data.finalUrl}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
      } else {
        html = baseTag + html;
      }
      previewFrame.srcdoc = html;
    } catch (e) {
      previewFallback.hidden = false;
    }
  }

  /* ============================================================
     Tabs
     ============================================================ */
  document.querySelectorAll(".editor__tab").forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });

  function setActiveTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll(".editor__tab").forEach((t) => {
      const active = t.dataset.tab === tab;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".editor__panel").forEach((p) => p.classList.remove("is-active"));
    panelElByTab[tab].classList.add("is-active");

    const isCode = tab !== "preview";
    copyBtn.style.display = isCode ? "" : "none";
    downloadCurrentBtn.style.display = isCode ? "" : "none";
    searchInput.parentElement.style.opacity = isCode ? "1" : "0.35";
    searchInput.disabled = !isCode;

    const labels = {
      preview: "Menampilkan pratinjau langsung website",
      html: "Struktur HTML dari dokumen utama",
      css: "Seluruh stylesheet (eksternal + inline) digabung",
      js: "Seluruh script (eksternal + inline) digabung",
    };
    toolbarMeta.textContent = labels[tab];
    clearSearch();

    // re-render active Prism line numbers sizing after becoming visible
    if (isCode && window.Prism && window.Prism.plugins && window.Prism.plugins.lineNumbers) {
      Prism.plugins.lineNumbers.resize(codeElByTab[tab].closest("pre"));
    }
  }

  /* ============================================================
     Copy / Download
     ============================================================ */
  function currentTabRawText() {
    if (state.activeTab === "html") return state.result.html || "";
    if (state.activeTab === "css") return mergeFiles(state.result.css, "css");
    if (state.activeTab === "js") return mergeFiles(state.result.js, "js");
    return "";
  }

  copyBtn.addEventListener("click", async () => {
    const text = currentTabRawText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast("Kode berhasil disalin ke clipboard");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast("Kode berhasil disalin ke clipboard");
    }
  });

  downloadCurrentBtn.addEventListener("click", () => {
    if (!state.result) return;
    const map = {
      html: ["index.html", "text/html"],
      css: ["style.css", "text/css"],
      js: ["script.js", "text/javascript"],
    };
    const conf = map[state.activeTab];
    if (!conf) return;
    triggerDownload(conf[0], currentTabRawText(), conf[1]);
    showToast(`${conf[0]} berhasil diunduh`);
  });

  downloadZipBtn.addEventListener("click", async () => {
    if (!state.result || !window.JSZip) return;
    downloadZipBtn.disabled = true;
    const originalLabel = downloadZipBtn.innerHTML;
    downloadZipBtn.innerHTML = "Menyiapkan ZIP…";
    try {
      const zip = new JSZip();
      const data = state.result;
      zip.file("index.html", data.html || "");

      const cssFolder = zip.folder("css");
      data.css.forEach((f, i) => cssFolder.file(safeZipName(f.filename, i, "css"), f.content));
      cssFolder.file("_all-styles.css", mergeFiles(data.css, "css"));

      const jsFolder = zip.folder("js");
      data.js.forEach((f, i) => jsFolder.file(safeZipName(f.filename, i, "js"), f.content));
      jsFolder.file("_all-scripts.js", mergeFiles(data.js, "js"));

      const meta = [
        `Sumber: ${data.finalUrl}`,
        `Judul: ${data.title || "-"}`,
        `Diekstrak pada: ${new Date().toLocaleString("id-ID")}`,
        `Jumlah file CSS: ${data.stats.cssFileCount}`,
        `Jumlah file JS: ${data.stats.jsFileCount}`,
        `Total ukuran: ${formatBytes(data.stats.totalBytes)}`,
        "",
        "Dihasilkan oleh SourceCode Extractor.",
      ].join("\n");
      zip.file("README.txt", meta);

      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "source-code-export.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast("ZIP berhasil diunduh");
    } catch (e) {
      showToast("Gagal membuat ZIP");
    } finally {
      downloadZipBtn.disabled = false;
      downloadZipBtn.innerHTML = originalLabel;
    }
  });

  function safeZipName(name, index, ext) {
    const clean = (name || `file-${index}.${ext}`).replace(/[\\/:*?"<>|]/g, "_");
    return clean;
  }

  /* ============================================================
     Search within source code
     ============================================================ */
  let searchDebounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => performSearch(searchInput.value), 180);
  });
  searchNext.addEventListener("click", () => jumpSearch(1));
  searchPrev.addEventListener("click", () => jumpSearch(-1));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpSearch(e.shiftKey ? -1 : 1);
  });

  function clearSearch() {
    searchInput.value = "";
    searchCount.textContent = "";
    state.searchHits = [];
    state.searchIndex = -1;
    if (state.activeTab !== "preview") {
      const el = codeElByTab[state.activeTab];
      if (el && state.originalPanelHTML[state.activeTab] !== undefined) {
        el.innerHTML = state.originalPanelHTML[state.activeTab];
      }
    }
  }

  function performSearch(term) {
    const tab = state.activeTab;
    if (tab === "preview") return;
    const el = codeElByTab[tab];
    // restore clean highlighted version before re-searching
    el.innerHTML = state.originalPanelHTML[tab];
    state.searchHits = [];
    state.searchIndex = -1;

    const query = term.trim();
    if (!query) {
      searchCount.textContent = "";
      return;
    }

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    const lowerQuery = query.toLowerCase();
    textNodes.forEach((textNode) => {
      const text = textNode.nodeValue;
      const lower = text.toLowerCase();
      if (!lower.includes(lowerQuery)) return;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let idx = lower.indexOf(lowerQuery);
      while (idx !== -1) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
        const mark = document.createElement("mark");
        mark.className = "search-hit";
        mark.textContent = text.slice(idx, idx + query.length);
        frag.appendChild(mark);
        state.searchHits.push(mark);
        lastIndex = idx + query.length;
        idx = lower.indexOf(lowerQuery, lastIndex);
      }
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      textNode.parentNode.replaceChild(frag, textNode);
    });

    if (state.searchHits.length) {
      state.searchIndex = 0;
      highlightCurrentHit();
    }
    updateSearchCount();
  }

  function jumpSearch(dir) {
    if (!state.searchHits.length) return;
    state.searchIndex = (state.searchIndex + dir + state.searchHits.length) % state.searchHits.length;
    highlightCurrentHit();
    updateSearchCount();
  }

  function highlightCurrentHit() {
    state.searchHits.forEach((m) => m.classList.remove("is-current"));
    const current = state.searchHits[state.searchIndex];
    if (current) {
      current.classList.add("is-current");
      current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function updateSearchCount() {
    if (!state.searchHits.length) {
      searchCount.textContent = searchInput.value ? "0/0" : "";
      return;
    }
    searchCount.textContent = `${state.searchIndex + 1}/${state.searchHits.length}`;
  }

  /* ============================================================
     Init
     ============================================================ */
  renderHistory();
})();
