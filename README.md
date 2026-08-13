# SourceCode Extractor

Website premium dark-mode untuk mengekstrak **HTML, CSS, dan JavaScript** dari website mana pun hanya dengan memasukkan URL-nya.

## ✨ Fitur

- Input URL + tombol **Extract Source Code**
- Ekstraksi penuh: HTML, seluruh CSS (eksternal + inline), seluruh JS (eksternal + inline)
- Tab terpisah **Preview / HTML / CSS / JS** dengan syntax highlighting (Prism.js) + line numbering
- **Copy code**, **Download HTML**, **Download CSS**, **Download JS**, **Download All (.zip)**
- **Search** di dalam source code (highlight + navigasi next/prev)
- Statistik: jumlah file CSS, jumlah file JS, total ukuran, waktu proses
- **Preview langsung** website di dalam iframe (via `srcdoc` + `<base>` agar tidak diblokir `X-Frame-Options`)
- **Riwayat URL** tersimpan di `localStorage`, bisa diklik ulang atau dihapus satu-satu / semua
- Loading animation & error handling yang informatif (URL invalid, timeout, situs memblokir, dsb.)
- Desain dark glassmorphism ala VS Code + DevTools, fully responsive

## 🧱 Struktur Proyek

```
sourcecode-extractor/
├── package.json
├── server.js              # Express + Axios + Cheerio (backend ekstraksi)
└── public/
    ├── index.html
    ├── css/style.css      # Dark theme, glassmorphism, neon glow
    └── js/app.js          # Logic frontend (tabs, search, zip, history)
```

## 🚀 Cara Menjalankan

Butuh **Node.js versi 18 ke atas**.

```bash
# 1. Masuk ke folder proyek
cd sourcecode-extractor

# 2. Install dependencies
npm install

# 3. Jalankan server
npm start
```

Lalu buka **http://localhost:3000** di browser.

Untuk mode pengembangan dengan auto-reload (butuh `nodemon`, sudah termasuk di `devDependencies`):

```bash
npm run dev
```

## ⚙️ Cara Kerja

1. Frontend mengirim `POST /api/extract` dengan `{ url }` ke backend.
2. Backend (`server.js`) mengambil HTML halaman via **Axios**, lalu mem-parsingnya dengan **Cheerio** untuk menemukan semua `<link rel="stylesheet">`, `<style>`, `<script src>`, dan `<script>` inline.
3. Setiap file CSS/JS eksternal di-resolve ke URL absolut lalu diunduh paralel.
4. Semua hasil (HTML, daftar file CSS, daftar file JS, statistik) dikirim balik sebagai JSON ke frontend.
5. Frontend menampilkannya di editor bergaya VS Code dengan syntax highlighting, membangun preview via `iframe.srcdoc`, dan menyimpan riwayat URL di `localStorage`.

## 📝 Catatan

- Beberapa website memblokir scraping otomatis (proteksi bot/anti-scraping) — dalam kasus ini pesan error akan menjelaskan status responsnya.
- Preview menggunakan `srcdoc` dengan tag `<base>` yang menunjuk ke domain asli, sehingga aset relatif (gambar, css, js) tetap mencoba dimuat dari sumber aslinya.
- Batas ukuran per aset adalah 8MB dan maksimum 40 file CSS/JS per tipe untuk menjaga performa server.

## 🛠️ Teknologi

Express · Axios · Cheerio · Prism.js · JSZip · HTML/CSS/JavaScript murni di sisi klien.
