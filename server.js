const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/extract', async (req, res) => {
    let { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL tidak boleh kosong.' });
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, line Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        const htmlRaw = response.data;
        const $ = cheerio.load(htmlRaw);

        // Extrak Inline CSS & External CSS Links
        let cssContent = '/* --- CSS Extracted --- */\n\n';
        let cssCount = 0;
        
        $('style').each((i, el) => {
            cssCount++;
            cssContent += `/* Style Block ${cssCount} */\n` + $(el).html() + '\n\n';
        });

        $('link[rel="stylesheet"]').each((i, el) => {
            cssCount++;
            const href = $(el).attr('href');
            cssContent += `/* External Link ${i + 1}:${href} */\n`;
        });

        // Extrak Inline JS & Script Sources
        let jsContent = '// --- JavaScript Extracted ---\n\n';
        let jsCount = 0;

        $('script').each((i, el) => {
            jsCount++;
            const src = $(el).attr('src');
            const inlineScript = $(el).html();

            if (src) {
                jsContent += `// External Script ${i + 1}:${src}\n`;
            } else if (inlineScript) {
                jsContent += `// Inline Script Block\n${inlineScript}\n\n`;
            }
        });

        const totalBytes = Buffer.byteLength(htmlRaw + cssContent + jsContent, 'utf8');
        const sizeFormatted = totalBytes > 1024 * 1024 
            ? (totalBytes / (1024 * 1024)).toFixed(2) + ' MB' 
            : (totalBytes / 1024).toFixed(2) + ' KB';

        res.json({
            url,
            html: htmlRaw,
            css: cssContent,
            js: jsContent,
            stats: {
                cssCount,
                jsCount,
                size: sizeFormatted
            }
        });

    } catch (err) {
        res.status(500).json({ 
            error: 'Gagal mengambil source code. Pastikan URL valid dan situs tidak memblokir crawler.',
            details: err.message 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server SourceCode Extractor berjalan di http://localhost:${PORT}`);
});
