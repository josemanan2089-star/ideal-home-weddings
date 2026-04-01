const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const compression = require('compression');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// ============================================================
// AFFILIATE TAG
// ============================================================
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'mxlgold-20';

function addAffiliateTag(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('tag', AFFILIATE_TAG);
        return u.toString();
    } catch { return url; }
}

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '7.0' }));

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`User-agent: *\nAllow: /\nDisallow: /mxl-panel-2026.html\nDisallow: /api/commander/\n\nSitemap: https://${req.headers.host}/sitemap.xml`);
});

// ============================================================
// DB POSTGRESQL
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const cache = { products: null, insights: null, news: null, ts: {} };
const CACHE_TTL = 60 * 1000;
function cacheValid(key) {
    return cache[key] && cache.ts[key] && (Date.now() - cache.ts[key] < CACHE_TTL);
}

async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT,
                curiosidad TEXT, imagen TEXT, categoria VARCHAR(100),
                link TEXT, keyword TEXT, clics INT DEFAULT 0,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS curiosidades (
                id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT,
                imagen TEXT, keyword TEXT, producto_id BIGINT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS noticias (
                id BIGINT PRIMARY KEY, titulo TEXT, resumen TEXT, fuente TEXT,
                imagen TEXT, link TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS clics (
                id BIGSERIAL PRIMARY KEY, producto_id BIGINT,
                tipo VARCHAR(20) DEFAULT 'product',
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Safe migrations
        await db.query(`ALTER TABLE articulos ADD COLUMN IF NOT EXISTS clics INT DEFAULT 0`).catch(() => {});
        await db.query(`ALTER TABLE articulos ADD COLUMN IF NOT EXISTS keyword TEXT`).catch(() => {});
        await db.query(`ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS keyword TEXT`).catch(() => {});
        await db.query(`ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS producto_id BIGINT`).catch(() => {});
        console.log('✅ DB Ready v7.0');
    } catch (e) { console.error('❌ DB Error:', e.message); }
}

// ============================================================
// GEMINI — ROTATE 3 KEYS
// ============================================================
const geminiKeys = [
    process.env.GEMINI_API_KEY_CONTENT,
    process.env.GEMINI_API_KEY_SALES,
    process.env.GEMINI_API_KEY_TRAFFIC
].filter(Boolean);

let geminiIndex = 0;
async function generateContent(prompt) {
    for (let i = 0; i < geminiKeys.length; i++) {
        try {
            const key = geminiKeys[(geminiIndex + i) % geminiKeys.length];
            const genAI = new GoogleGenerativeAI(key.trim());
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent(prompt);
            geminiIndex = (geminiIndex + i + 1) % geminiKeys.length;
            return result.response.text().replace(/```json|```/g, '').trim();
        } catch (e) { console.warn(`⚠️ Gemini key ${i} failed: ${e.message}`); }
    }
    throw new Error('All Gemini keys failed');
}

// ============================================================
// IMAGES: Pexels → Unsplash → Fallback
// ============================================================
async function fetchPexels(keyword) {
    const key = process.env.PEXELS_API_KEY;
    if (!key) return null;
    try {
        const q = encodeURIComponent(keyword + ' luxury');
        const res = await fetch(`https://api.pexels.com/v1/search?query=${q}&per_page=5&orientation=landscape`, {
            headers: { Authorization: key }
        });
        const data = await res.json();
        if (data.photos?.length > 0) return data.photos[Math.floor(Math.random() * data.photos.length)].src.large;
    } catch (e) { console.warn('Pexels failed:', e.message); }
    return null;
}

async function fetchUnsplash(keyword) {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return null;
    try {
        const q = encodeURIComponent(keyword + ' luxury');
        const res = await fetch(`https://api.unsplash.com/search/photos?query=${q}&per_page=5&orientation=landscape`, {
            headers: { Authorization: `Client-ID ${key}` }
        });
        const data = await res.json();
        if (data.results?.length > 0) return data.results[Math.floor(Math.random() * data.results.length)].urls.regular;
    } catch (e) { console.warn('Unsplash failed:', e.message); }
    return null;
}

async function getImage(keyword) {
    const img = await fetchPexels(keyword) || await fetchUnsplash(keyword);
    if (img) return img;
    const fallback = ['280229','258154','1643383','323780','1571460','2093107','1457842','276724'];
    const id = fallback[Math.floor(Math.random() * fallback.length)];
    return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1200`;
}

// ============================================================
// HELPER — Find related product by keyword
// ============================================================
async function findRelatedProduct(keyword) {
    try {
        const words = keyword.toLowerCase().split(' ').filter(w => w.length > 3);
        if (!words.length) return null;
        const conditions = words.map((w, i) => `LOWER(titulo) LIKE $${i + 1}`).join(' OR ');
        const r = await db.query(
            `SELECT id, titulo, link, imagen, categoria FROM articulos WHERE ${conditions} ORDER BY clics DESC LIMIT 1`,
            words.map(w => `%${w}%`)
        );
        return r.rows[0] || null;
    } catch { return null; }
}

// ============================================================
// AUTO-PILOT — Insights (formerly curiosidades) in ENGLISH
// Targeting USA + Europe high-income women
// ============================================================
const SEO_TOPICS = [
    { topic: 'best luxury kitchen appliances Amazon 2026', keyword: 'luxury kitchen appliances' },
    { topic: 'smart home gadgets wealthy women NYC buy', keyword: 'smart home luxury gadgets' },
    { topic: 'luxury bedroom upgrade Amazon best sellers', keyword: 'luxury bedroom products' },
    { topic: 'best wine cooler refrigerator luxury home bar', keyword: 'luxury wine cooler' },
    { topic: 'best air purifier luxury apartment 2026', keyword: 'luxury air purifier home' },
    { topic: 'luxury espresso machine coffee maker Amazon', keyword: 'luxury espresso machine' },
    { topic: 'heated towel warmer rack bathroom luxury', keyword: 'heated towel rack luxury' },
    { topic: 'smart lighting luxury home interior design', keyword: 'smart lighting luxury home' },
    { topic: 'luxury mattress best sleep quality 2026', keyword: 'luxury mattress brand' },
    { topic: 'best robotic vacuum luxury apartment women', keyword: 'luxury robotic vacuum' },
    { topic: 'outdoor luxury patio furniture Manhattan penthouse', keyword: 'luxury outdoor furniture' },
    { topic: 'luxury scented candle home fragrance Amazon', keyword: 'luxury scented candle home' },
    { topic: 'best luxury skincare devices home use', keyword: 'luxury skincare device' },
    { topic: 'high end standing desk home office luxury', keyword: 'luxury home office desk' },
    { topic: 'luxury throw blanket cashmere Amazon bestseller', keyword: 'cashmere throw blanket luxury' },
];

let topicIndex = 0;

async function publishInsight() {
    if (!geminiKeys.length) return;
    console.log('⏰ [CRON] Generating SEO insight...');
    try {
        const topic = SEO_TOPICS[topicIndex % SEO_TOPICS.length];
        topicIndex++;

        const prompt = `You are a senior editor at Architectural Digest and a former features writer for The New York Times Style section. You have lived in Manhattan's Upper East Side for 15 years. You write naturally, the way a well-educated American woman talks to her friends — confident, specific, a little witty, never stiff or translated.

TOPIC: "${topic.topic}"

READER: A 42-year-old woman. She lives in a Tribeca loft or a Chelsea townhouse. She shops on Amazon Prime but she's not cheap — she just knows where to find quality. She reads the Sunday Times, follows interior designers on Instagram, and has a second home in the Hamptons or Cotswolds.

WRITE TWO THINGS:

1. title — A headline that feels like it belongs in a magazine. Conversational but smart. Uses real search keywords naturally. Max 12 words. NOT clickbait. NOT translated. Examples of the TONE we want:
   ✅ "The Wine Cooler Our Editor Finally Splurged On (And Never Looked Back)"
   ✅ "Why Every Smart Home in 2026 Starts With This One Upgrade"
   ✅ "The Heated Towel Rail That Makes a $200 Hotel Bathroom Feel Possible at Home"
   ❌ "The 5 Products Elite Women Want" (too generic)
   ❌ "Discover the luxury secrets" (sounds translated)

2. body — Exactly 3 sentences written like a friend texting you a recommendation:
   Sentence 1: A surprising or specific fact that makes you go "huh, I didn't know that."
   Sentence 2: Why this particular thing matters right now — a cultural moment, a shift in how people live.
   Sentence 3: End naturally with "You can find it on Amazon — usually for less than you'd think."

- keyword: The exact phrase someone types into Google when they're ready to buy this (3–5 words, no brand names).
- Sound like a native American or British English speaker. No stiff phrasing. No "discover", "unveil", "embrace". Write the way smart people actually talk.

Respond ONLY raw JSON, no markdown:
{"title": "...", "body": "...", "keyword": "..."}`;

        const raw = await generateContent(prompt);
        const data = JSON.parse(raw);
        const image = await getImage(data.keyword || topic.keyword);
        const related = await findRelatedProduct(data.keyword || topic.keyword);

        await db.query(
            `INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, keyword, producto_id, fecha)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [Date.now(), data.title, data.body, image,
             data.keyword, related?.id || null, new Date().toISOString()]
        );
        cache.insights = null;
        console.log(`✨ [SEO] Insight: "${data.title}" → Product: ${related?.titulo || 'none yet'}`);
    } catch (e) { console.error('❌ Insight error:', e.message); }
}

// ============================================================
// AUTO-PILOT — Luxury News in ENGLISH
// ============================================================
async function publishLuxuryNews() {
    const newsKey = process.env.NEWS_API_KEY;
    if (!newsKey || !geminiKeys.length) return;
    try {
        const queries = ['luxury home decor', 'luxury lifestyle NYC', 'elite real estate London', 'luxury interior design'];
        const q = encodeURIComponent(queries[Math.floor(Math.random() * queries.length)]);
        const res = await fetch(
            `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=5`,
            { headers: { 'X-Api-Key': newsKey } }
        );
        const data = await res.json();
        const article = data.articles?.find(a => a.title && a.description);
        if (!article) return;

        const raw = await generateContent(
            `You are a features editor at Vogue Living and a contributor to The Telegraph's lifestyle section. You write in natural, confident British-American English — never stiff, never translated. You're rewriting a news story for your readers: affluent women in New York, London, and LA who are curious, educated, and have excellent taste.

REWRITE THIS ARTICLE with your own voice:
"${article.title} — ${article.description}"

RULES:
- title: Write it like a magazine cover line. Specific, smart, a little unexpected. Not generic. Max 12 words.
- summary: 3 sentences max. Make it feel like a tip from a well-connected friend, not a press release. End with a natural product recommendation toward Amazon — something like "It's the kind of thing you find on Amazon and wonder how you lived without it."
- keyword: What someone types in Google to find and buy the product mentioned (3–5 words).
- Write exactly as a native American or British English speaker would. No stiff phrases, no "discover", no translated tone.

Respond ONLY raw JSON: {"title":"...","summary":"...","keyword":"..."}`
        );
        const copy = JSON.parse(raw);
        const image = article.urlToImage || await getImage(copy.keyword || 'luxury home');

        await db.query(
            `INSERT INTO noticias (id, titulo, resumen, fuente, imagen, link, fecha) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [Date.now(), copy.title, copy.summary, article.source?.name || 'MXL Gold', image, article.url, new Date().toISOString()]
        );
        cache.news = null;
        console.log(`📰 News: ${copy.title}`);
    } catch (e) { console.error('❌ News error:', e.message); }
}

// ============================================================
// ENDPOINTS
// ============================================================

// Track click
app.post('/api/track/click', async (req, res) => {
    const { producto_id, tipo = 'product' } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false });
    try {
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [producto_id]);
        await db.query(`INSERT INTO clics (producto_id, tipo) VALUES ($1, $2)`, [producto_id, tipo]);
        cache.products = null;
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false }); }
});

// Top clicked products
app.get('/api/track/top', async (req, res) => {
    try {
        const r = await db.query(`
            SELECT a.id, a.titulo, a.categoria, a.clics, a.link,
                   COUNT(c.id) FILTER (WHERE c.fecha > NOW() - INTERVAL '7 days') AS clics_semana
            FROM articulos a
            LEFT JOIN clics c ON c.producto_id = a.id
            GROUP BY a.id, a.titulo, a.categoria, a.clics, a.link
            ORDER BY a.clics DESC LIMIT 20
        `);
        res.json(r.rows);
    } catch (e) { res.status(500).json([]); }
});

// Inject product — generate English copy
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    if (!geminiKeys.length || !tituloReal) return res.status(400).json({ success: false, error: 'Missing product name or AI engine' });
    try {
        const raw = await generateContent(
            `You are a shopping editor at The Cut and a contributing writer for Domino Magazine. You write product recommendations the way a trusted friend texts them — direct, specific, genuinely enthusiastic but never pushy. Your readers are women aged 35–55 in New York, Miami, Los Angeles, and London. They use Amazon Prime, they have high standards, and they can smell a lazy product description from a mile away.

PRODUCT: "${tituloReal}"

Write copy that sounds like YOU discovered this product and can't stop recommending it:

- title: The product's name, elevated. Sounds like something you'd see in a magazine gift guide. Specific adjectives. Max 10 words. NOT "luxury [product]" as a formula — be creative.
  ✅ "The Espresso Machine That Turned Our Kitchen Into a Café"
  ✅ "A Wine Cooler So Good It Changed How We Entertain"
  ❌ "Luxury Espresso Machine for Elite Women" (too stiff)

- meta: One sentence, 20 words, for Google. States the main benefit clearly. Reads like a subtitle, not an ad.

- teaser: 2 sentences. First: a specific detail or fact about why this product is genuinely worth it. Second: who it's perfect for, described naturally — not "elite women" but something like "anyone who's ever stood in a Pottery Barn and thought, I could do this at home." Max 55 words.

- keyword: 3–4 words someone types into Google when they're ready to buy this. No brand names.

Write ONLY in natural American or British English. Respond ONLY raw JSON:
{"title":"...","meta":"...","teaser":"...","keyword":"..."}`
        );
        const copy = JSON.parse(raw);
        const image = imagenUrl || await getImage(copy.keyword || tituloReal);
        const linkWithTag = addAffiliateTag(url);

        await db.query(
            `INSERT INTO articulos (id,asin,titulo,meta,curiosidad,imagen,categoria,link,keyword,clics,fecha)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10)`,
            [Date.now(),'MXL'+Date.now(), copy.title, copy.meta, copy.teaser,
             image, categoria, linkWithTag, copy.keyword, new Date().toISOString()]
        );
        cache.products = null;
        res.json({ success: true, product: copy.title, affiliateTag: AFFILIATE_TAG, image });
    } catch (e) {
        console.error('❌ Inject error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Google search from Commander
app.get('/api/commander/buscar', async (req, res) => {
    const { q } = req.query;
    const googleKey = process.env.GOOGLE_API_KEY;
    const googleCX  = process.env.GOOGLE_CX;
    if (!googleKey || !googleCX || !q) return res.status(400).json({ results: [] });
    try {
        const query = encodeURIComponent(q + ' site:amazon.com');
        const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCX}&q=${query}&num=5`);
        const data = await r.json();
        res.json({ results: (data.items || []).map(item => ({
            titulo: item.title, link: item.link, snippet: item.snippet,
            imagen: item.pagemap?.cse_image?.[0]?.src || null
        }))});
    } catch (e) { res.status(500).json({ results: [], error: e.message }); }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        await db.query('DELETE FROM clics WHERE producto_id = $1', [req.params.id]);
        cache.products = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/productos', async (req, res) => {
    if (cacheValid('products')) return res.json(cache.products);
    const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
    cache.products = r.rows; cache.ts.products = Date.now();
    res.json(r.rows);
});

// Insights with related product JOIN
app.get('/api/curiosidades', async (req, res) => {
    if (cacheValid('insights')) return res.json(cache.insights);
    const r = await db.query(`
        SELECT c.*,
               a.titulo AS producto_titulo,
               a.link   AS producto_link,
               a.imagen AS producto_imagen,
               a.id     AS producto_id_ref
        FROM curiosidades c
        LEFT JOIN articulos a ON a.id = c.producto_id
        ORDER BY c.fecha DESC LIMIT 50
    `);
    cache.insights = r.rows; cache.ts.insights = Date.now();
    res.json(r.rows);
});

app.get('/api/noticias', async (req, res) => {
    if (cacheValid('news')) return res.json(cache.news);
    const r = await db.query(`SELECT * FROM noticias ORDER BY fecha DESC LIMIT 20`);
    cache.news = r.rows; cache.ts.news = Date.now();
    res.json(r.rows);
});

app.get('/api/stats', async (req, res) => {
    try {
        const [prods, insights, news, topClick] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query('SELECT COUNT(*) FROM curiosidades'),
            db.query('SELECT COUNT(*) FROM noticias'),
            db.query('SELECT titulo, clics FROM articulos ORDER BY clics DESC LIMIT 1')
        ]);
        res.json({
            productos: parseInt(prods.rows[0].count),
            curiosidades: parseInt(insights.rows[0].count),
            noticias: parseInt(news.rows[0].count),
            topProducto: topClick.rows[0] || null,
            affiliateTag: AFFILIATE_TAG,
            motor: geminiKeys.length ? `Gemini 2.5 Flash ✅ (${geminiKeys.length} keys)` : '❌ No API Key',
            pexels: process.env.PEXELS_API_KEY ? '✅' : '❌',
            unsplash: process.env.UNSPLASH_ACCESS_KEY ? '✅' : '❌',
            newsApi: process.env.NEWS_API_KEY ? '✅' : '❌',
            google: (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) ? '✅' : '❌'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/sitemap.xml', async (req, res) => {
    const host = `https://${req.headers.host}`;
    try {
        const r = await db.query('SELECT id, fecha FROM articulos ORDER BY fecha DESC LIMIT 200');
        const urls = r.rows.map(p =>
            `<url><loc>${host}/#product-${p.id}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`
        ).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>${urls}</urlset>`);
    } catch (e) { res.status(500).send('Sitemap error'); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    console.log(`🔑 Gemini keys: ${geminiKeys.length}`);
    cron.schedule('*/15 * * * *', () => publishInsight());
    cron.schedule('0 */2 * * *', () => publishLuxuryNews());
    setTimeout(() => publishInsight(), 10000);
    setTimeout(() => publishLuxuryNews(), 30000);
    app.listen(PORT, '0.0.0.0', () =>
        console.log(`🚀 MXL v7.0 — TAG:${AFFILIATE_TAG} — Keys:${geminiKeys.length} — Port:${PORT}`)
    );
}
start();
