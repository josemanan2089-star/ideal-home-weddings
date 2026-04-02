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

const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'farolaldiauno-20';

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

app.get('/health', (req, res) => res.json({ status: 'ok', version: '8.2.1' }));

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`User-agent: *\nAllow: /\nDisallow: /mxl-panel-2026.html\nDisallow: /api/commander/\n\nSitemap: https://${req.headers.host}/sitemap.xml`);
});

// ============================================================
// DB
// ============================================================
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS articulos (
            id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT,
            curiosidad TEXT, imagen TEXT, categoria VARCHAR(100),
            link TEXT, keyword TEXT, clics INT DEFAULT 0,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS curiosidades (
            id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT,
            imagen TEXT, keyword TEXT, producto_id BIGINT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS noticias (
            id BIGINT PRIMARY KEY, titulo TEXT, resumen TEXT, fuente TEXT,
            imagen TEXT, link TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS clics (
            id BIGSERIAL PRIMARY KEY, producto_id BIGINT,
            tipo VARCHAR(20) DEFAULT 'product',
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        // Safe migrations
        for (const sql of [
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS clics INT DEFAULT 0`,
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS keyword TEXT`,
            `ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS keyword TEXT`,
            `ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS producto_id BIGINT`,
            // v8.2.1: section targeting column
            `ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS seccion VARCHAR(60) DEFAULT 'trending'`,
            `ALTER TABLE articulos    ADD COLUMN IF NOT EXISTS seccion VARCHAR(60) DEFAULT 'trending'`,
        ]) { await db.query(sql).catch(() => {}); }
        console.log('✅ DB Ready v8.2.1');
    } catch (e) { console.error('❌ DB Error:', e.message); }
}

// ============================================================
// GEMINI — ROTATE 3 KEYS  (v8.2.1: 10s delay on fail)
// ============================================================
const geminiKeys = [
    process.env.GEMINI_API_KEY_CONTENT,
    process.env.GEMINI_API_KEY_SALES,
    process.env.GEMINI_API_KEY_TRAFFIC
].filter(Boolean);

let geminiIndex = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateContent(prompt) {
    for (let i = 0; i < geminiKeys.length; i++) {
        try {
            const key = geminiKeys[(geminiIndex + i) % geminiKeys.length];
            const genAI = new GoogleGenerativeAI(key.trim());
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent(prompt);
            geminiIndex = (geminiIndex + i + 1) % geminiKeys.length;
            return result.response.text().replace(/```json|```/g, '').trim();
        } catch (e) {
            console.warn(`⚠️ Gemini key ${i} failed: ${e.message}`);
            // v8.2.1 — 10s delay before trying next key to avoid chain-429
            if (i < geminiKeys.length - 1) {
                console.log(`⏳ Waiting 10s before next Gemini key attempt...`);
                await sleep(10000);
            }
        }
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
        const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword + ' luxury')}&per_page=5&orientation=landscape`, { headers: { Authorization: key } });
        const data = await res.json();
        if (data.photos?.length) return data.photos[Math.floor(Math.random() * data.photos.length)].src.large;
    } catch {}
    return null;
}

async function fetchUnsplash(keyword) {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return null;
    try {
        const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword + ' luxury')}&per_page=5&orientation=landscape`, { headers: { Authorization: `Client-ID ${key}` } });
        const data = await res.json();
        if (data.results?.length) return data.results[Math.floor(Math.random() * data.results.length)].urls.regular;
    } catch {}
    return null;
}

async function getImage(keyword) {
    const img = await fetchPexels(keyword) || await fetchUnsplash(keyword);
    if (img) return img;
    const ids = ['280229','258154','1643383','323780','1571460','2093107','1457842','276724'];
    const id = ids[Math.floor(Math.random() * ids.length)];
    return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1200`;
}

// ============================================================
// HELPER — related product by keyword
// ============================================================
async function findRelatedProduct(keyword) {
    try {
        const words = keyword.toLowerCase().split(' ').filter(w => w.length > 3);
        if (!words.length) return null;
        const conditions = words.map((w, i) => `LOWER(titulo) LIKE $${i + 1}`).join(' OR ');
        const r = await db.query(
            `SELECT id, titulo, link, imagen FROM articulos WHERE ${conditions} ORDER BY clics DESC LIMIT 1`,
            words.map(w => `%${w}%`)
        );
        return r.rows[0] || null;
    } catch { return null; }
}

// ============================================================
// v8.2.1 — SECTION STRATEGY
//
// "What They're Buying Right Now"  → impulse picks $25–$50
// "Trending This Week"             → popular / aspirational
// ============================================================

// Products targeting the $25–$50 impulse-buy sweet spot
// These feed the "What They're Buying Right Now" section
const SECTION_BUYING_NOW = [
    { topic: 'best luxury scented candle home fragrance Amazon $25-$45', keyword: 'luxury scented candle home', seccion: 'buying_now' },
    { topic: 'silk eye mask luxury sleep quality Amazon $25-$40', keyword: 'luxury silk sleep mask', seccion: 'buying_now' },
    { topic: 'premium linen napkins tablecloth luxury Amazon $25-$45', keyword: 'luxury linen table decor', seccion: 'buying_now' },
    { topic: 'luxury bath salts spa set gift Amazon $28-$48', keyword: 'luxury bath spa salts set', seccion: 'buying_now' },
    { topic: 'artisan ceramic mug luxury gift Amazon $22-$42', keyword: 'luxury ceramic mug artisan', seccion: 'buying_now' },
    { topic: 'luxury hand cream gift set Amazon $25-$50', keyword: 'luxury hand cream gift set', seccion: 'buying_now' },
    { topic: 'cashmere socks luxury women Amazon $30-$50', keyword: 'luxury cashmere socks women', seccion: 'buying_now' },
    { topic: 'crystal luxury wine glasses set Amazon $35-$50', keyword: 'crystal luxury wine glasses', seccion: 'buying_now' },
    { topic: 'luxury kitchen gadgets bestseller Amazon $28-$48', keyword: 'luxury kitchen gadgets', seccion: 'buying_now' },
    { topic: 'aromatherapy diffuser luxury home Amazon $30-$48', keyword: 'luxury aromatherapy diffuser', seccion: 'buying_now' },
];

// Products for the "Trending This Week" section — higher price, aspirational
const SECTION_TRENDING = [
    { topic: 'smart lighting luxury home Amazon $50-$90', keyword: 'smart lighting luxury home', seccion: 'trending' },
    { topic: 'luxury cashmere throw blanket Amazon $60-$95', keyword: 'cashmere throw blanket luxury', seccion: 'trending' },
    { topic: 'heated towel warmer rack bathroom luxury $55-$85', keyword: 'heated towel rack luxury', seccion: 'trending' },
    { topic: 'luxury pillow set sleep quality Amazon $55-$90', keyword: 'luxury sleep pillow set', seccion: 'trending' },
    { topic: 'luxury desk accessories home office Amazon $45-$80', keyword: 'luxury home office accessories', seccion: 'trending' },
    { topic: 'best luxury kitchen appliances Amazon 2026', keyword: 'luxury kitchen appliances', seccion: 'trending' },
    { topic: 'luxury espresso machine coffee maker Amazon', keyword: 'luxury espresso machine', seccion: 'trending' },
    { topic: 'best air purifier luxury apartment 2026', keyword: 'luxury air purifier home', seccion: 'trending' },
    { topic: 'best robotic vacuum luxury apartment women', keyword: 'luxury robotic vacuum', seccion: 'trending' },
    { topic: 'smart home gadgets wealthy women NYC buy', keyword: 'smart home luxury gadgets', seccion: 'trending' },
];

let topicIndex = 0;
function getNextTopic() {
    topicIndex++;
    // 60% buying_now ($25–$50), 40% trending (aspirational)
    if (topicIndex % 5 <= 1) {
        const i = Math.floor(Math.random() * SECTION_TRENDING.length);
        return SECTION_TRENDING[i];
    }
    const i = topicIndex % SECTION_BUYING_NOW.length;
    return SECTION_BUYING_NOW[i];
}

// ============================================================
// AUTO-PILOT — Insights  (v8.2.1: every 45 min)
// ============================================================
async function publishInsight() {
    if (!geminiKeys.length) return;
    console.log('⏰ [CRON] Generating SEO insight...');
    try {
        const topic = getNextTopic();
        const isBuyingNow = topic.seccion === 'buying_now';

        const sectionContext = isBuyingNow
            ? `SECTION: "What They're Buying Right Now" — impulse purchase, under $50, something a friend texts you about.`
            : `SECTION: "Trending This Week" — aspirational, the item everyone in the know has discovered this month.`;

        const raw = await generateContent(`You are a senior editor at Architectural Digest and former features writer for The New York Times Style section. You have lived in Manhattan's Upper East Side for 15 years. You write naturally — confident, specific, a little witty, never stiff or translated.

TOPIC: "${topic.topic}"
${sectionContext}

READER: A 42-year-old woman. Tribeca loft or Chelsea townhouse. Shops Amazon Prime but has high standards. Reads the Sunday Times, follows interior designers on Instagram, second home in the Hamptons or Cotswolds.

WRITE:
1. title — Magazine headline, conversational but smart, uses real search keywords naturally. Max 12 words.
   ✅ "The Wine Cooler Our Editor Finally Splurged On (And Never Looked Back)"
   ✅ "Why Every Smart Home in 2026 Starts With This One Upgrade"
   ❌ "The 5 Products Elite Women Want" (too generic)

2. body — Exactly 3 sentences like a friend texting a recommendation:
   Sentence 1: A surprising or specific fact.
   Sentence 2: Why this matters right now — a cultural moment, a shift in how people live.
   Sentence 3: End with "You can find it on Amazon — usually for less than you'd think."

3. keyword — Exact phrase someone types in Google when ready to buy this (3–5 words, no brand names).

Sound like a native American or British English speaker. No "discover", "unveil", "embrace".
Respond ONLY raw JSON: {"title":"...","body":"...","keyword":"..."}`);

        const data = JSON.parse(raw);
        const image = await getImage(data.keyword || topic.keyword);
        const related = await findRelatedProduct(data.keyword || topic.keyword);

        await db.query(
            `INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, keyword, producto_id, seccion, fecha) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [Date.now(), data.title, data.body, image, data.keyword, related?.id || null, topic.seccion, new Date().toISOString()]
        );
        console.log(`✨ [${topic.seccion.toUpperCase()}] Insight: "${data.title}" → linked: ${related?.titulo || 'none yet'}`);
    } catch (e) { console.error('❌ Insight error:', e.message); }
}

// ============================================================
// AUTO-PILOT — Luxury News
// ============================================================
async function publishLuxuryNews() {
    const newsKey = process.env.NEWS_API_KEY;
    if (!newsKey || !geminiKeys.length) return;
    try {
        const queries = ['luxury home decor', 'luxury lifestyle NYC', 'elite real estate London', 'luxury interior design'];
        const q = encodeURIComponent(queries[Math.floor(Math.random() * queries.length)]);
        const res = await fetch(`https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=5`, { headers: { 'X-Api-Key': newsKey } });
        const data = await res.json();
        const article = data.articles?.find(a => a.title && a.description);
        if (!article) return;

        const raw = await generateContent(`You are a features editor at Vogue Living and contributor to The Telegraph's lifestyle section. You write in natural, confident British-American English — never stiff, never translated.

Rewrite this article for affluent women in New York, London, and LA:
"${article.title} — ${article.description}"

- title: Magazine cover line. Specific, smart, a little unexpected. Max 12 words.
- summary: 3 sentences max. Feel like a tip from a well-connected friend, not a press release. End naturally toward Amazon.
- keyword: What someone types in Google to find and buy the product mentioned (3–5 words).

Respond ONLY raw JSON: {"title":"...","summary":"...","keyword":"..."}`);

        const copy = JSON.parse(raw);
        const image = article.urlToImage || await getImage(copy.keyword || 'luxury home');

        await db.query(
            `INSERT INTO noticias (id, titulo, resumen, fuente, imagen, link, fecha) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [Date.now(), copy.title, copy.summary, article.source?.name || 'MXL Gold', image, article.url, new Date().toISOString()]
        );
        console.log(`📰 News: ${copy.title}`);
    } catch (e) { console.error('❌ News error:', e.message); }
}

// ============================================================
// ENDPOINTS
// ============================================================

// Track click
app.post('/api/track/click', async (req, res) => {
    const { producto_id, tipo = 'product' } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false, error: 'Missing producto_id' });
    try {
        const update = await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1 RETURNING id, titulo, clics`, [producto_id]);
        await db.query(`INSERT INTO clics (producto_id, tipo) VALUES ($1, $2)`, [producto_id, tipo]);
        const product = update.rows[0] || null;
        res.json({
            ok: true,
            producto_id,
            tipo,
            total_clics: product?.clics || null,
            titulo: product?.titulo || null,
            timestamp: new Date().toISOString()
        });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Top clicked
app.get('/api/track/top', async (req, res) => {
    try {
        const r = await db.query(`
            SELECT a.id, a.titulo, a.categoria, a.clics, a.link,
                   COUNT(c.id) FILTER (WHERE c.fecha > NOW() - INTERVAL '7 days') AS clics_semana,
                   COUNT(c.id) FILTER (WHERE c.fecha > NOW() - INTERVAL '1 day') AS clics_hoy
            FROM articulos a LEFT JOIN clics c ON c.producto_id = a.id
            GROUP BY a.id, a.titulo, a.categoria, a.clics, a.link
            ORDER BY a.clics DESC LIMIT 20
        `);
        res.json(r.rows);
    } catch { res.status(500).json([]); }
});

// Products — paginated + category + section filter
app.get('/api/productos', async (req, res) => {
    const page      = Math.max(1, parseInt(req.query.page) || 1);
    const limit     = 12;
    const offset    = (page - 1) * limit;
    const categoria = req.query.categoria || null;
    const seccion   = req.query.seccion   || null;
    try {
        const conditions = [];
        const params = [limit, offset];
        if (categoria) { conditions.push(`UPPER(categoria) = $${params.length + 1}`); params.push(categoria.toUpperCase()); }
        if (seccion)   { conditions.push(`seccion = $${params.length + 1}`); params.push(seccion); }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const countParams = params.slice(2); // strip limit/offset
        const [rows, total] = await Promise.all([
            db.query(`SELECT * FROM articulos ${where} ORDER BY fecha DESC LIMIT $1 OFFSET $2`, params),
            db.query(`SELECT COUNT(*) FROM articulos ${where}`, countParams)
        ]);
        res.json({
            items:   rows.rows,
            total:   parseInt(total.rows[0].count),
            page, pages: Math.ceil(parseInt(total.rows[0].count) / limit),
            hasMore: offset + limit < parseInt(total.rows[0].count)
        });
    } catch { res.status(500).json({ items:[], total:0, page:1, pages:1, hasMore:false }); }
});

// Single product
app.get('/api/productos/:id', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM articulos WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Available categories
app.get('/api/categorias', async (req, res) => {
    try {
        const r = await db.query(`SELECT DISTINCT categoria, COUNT(*) as total FROM articulos GROUP BY categoria ORDER BY total DESC`);
        res.json(r.rows);
    } catch { res.status(500).json([]); }
});

// Insights — paginated + section filter + related product JOIN
app.get('/api/curiosidades', async (req, res) => {
    const page    = Math.max(1, parseInt(req.query.page) || 1);
    const limit   = 9;
    const offset  = (page - 1) * limit;
    const seccion = req.query.seccion || null;
    try {
        const where = seccion ? `AND c.seccion = $3` : '';
        const params = seccion ? [limit, offset, seccion] : [limit, offset];
        const countParams = seccion ? [seccion] : [];
        const [rows, total] = await Promise.all([
            db.query(`SELECT c.*, a.titulo AS producto_titulo, a.link AS producto_link,
                             a.imagen AS producto_imagen, a.id AS producto_id_ref
                      FROM curiosidades c LEFT JOIN articulos a ON a.id = c.producto_id
                      WHERE 1=1 ${where}
                      ORDER BY c.fecha DESC LIMIT $1 OFFSET $2`, params),
            db.query(`SELECT COUNT(*) FROM curiosidades ${seccion ? 'WHERE seccion = $1' : ''}`, countParams)
        ]);
        res.json({ items: rows.rows, total: parseInt(total.rows[0].count), page, hasMore: offset + limit < parseInt(total.rows[0].count) });
    } catch { res.status(500).json({ items:[], total:0, page:1, hasMore:false }); }
});

app.get('/api/noticias', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM noticias ORDER BY fecha DESC LIMIT 20`);
        res.json(r.rows);
    } catch { res.status(500).json([]); }
});

// Inject product — v8.2.1: section-aware injection
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal, seccion = 'buying_now' } = req.body;
    if (!geminiKeys.length || !tituloReal) return res.status(400).json({ success: false, error: 'Missing product name or AI engine' });
    try {
        const isBuyingNow = seccion === 'buying_now';
        const sectionHint = isBuyingNow
            ? `SECTION TARGET: "What They're Buying Right Now" — under $50, impulse buy, feels like a friend's recommendation.`
            : `SECTION TARGET: "Trending This Week" — aspirational item, the one everyone wants right now.`;

        const raw = await generateContent(`You are a shopping editor at The Cut and contributing writer for Domino Magazine. You write product recommendations the way a trusted friend texts them — direct, specific, genuinely enthusiastic but never pushy. Readers: women aged 35–55 in New York, Miami, Los Angeles, and London.

PRODUCT: "${tituloReal}"
${sectionHint}

Write copy that sounds like YOU discovered this and can't stop recommending it:
- title: Product name elevated. Sounds like a magazine gift guide. Specific adjectives. Max 10 words. NOT "luxury [product]" as a formula.
  ✅ "The Espresso Machine That Turned Our Kitchen Into a Café"
  ✅ "A Wine Cooler So Good It Changed How We Entertain"
- meta: One sentence, 20 words, for Google. States the main benefit clearly. Reads like a subtitle.
- teaser: 2 sentences. First: a specific detail or fact about why this product is genuinely worth it. Second: who it's perfect for, described naturally. Max 55 words.
- keyword: 3–4 words someone types in Google when ready to buy this. No brand names.
- badge: ONE of these ONLY — pick the most fitting for this product type:
  "Amazon's Choice" | "Best Seller" | "Limited Stock" | "Editor's Pick" | "Top Rated"

Write ONLY in natural American or British English. Respond ONLY raw JSON:
{"title":"...","meta":"...","teaser":"...","keyword":"...","badge":"..."}`);

        const copy = JSON.parse(raw);
        const image = imagenUrl || await getImage(copy.keyword || tituloReal);
        const linkWithTag = addAffiliateTag(url);
        const metaWithBadge = JSON.stringify({ badge: copy.badge || 'Editor\'s Pick', text: copy.meta });

        await db.query(
            `INSERT INTO articulos (id,asin,titulo,meta,curiosidad,imagen,categoria,link,keyword,seccion,clics,fecha) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11)`,
            [Date.now(), 'MXL'+Date.now(), copy.title, metaWithBadge, copy.teaser, image, categoria, linkWithTag, copy.keyword, seccion, new Date().toISOString()]
        );
        res.json({ success: true, product: copy.title, badge: copy.badge, seccion, affiliateTag: AFFILIATE_TAG, image });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete product
app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        await db.query('DELETE FROM clics WHERE producto_id = $1', [req.params.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

// Google search from Commander
app.get('/api/commander/buscar', async (req, res) => {
    const { q } = req.query;
    const googleKey = process.env.GOOGLE_API_KEY, googleCX = process.env.GOOGLE_CX;
    if (!googleKey || !googleCX || !q) return res.status(400).json({ results: [] });
    try {
        const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCX}&q=${encodeURIComponent(q + ' site:amazon.com')}&num=5`);
        const data = await r.json();
        res.json({ results: (data.items || []).map(i => ({ titulo: i.title, link: i.link, snippet: i.snippet, imagen: i.pagemap?.cse_image?.[0]?.src || null })) });
    } catch { res.status(500).json({ results: [] }); }
});

// Stats
app.get('/api/stats', async (req, res) => {
    try {
        const [prods, insights, news, topClick, clicksHoy, buyingNow, trending] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query('SELECT COUNT(*) FROM curiosidades'),
            db.query('SELECT COUNT(*) FROM noticias'),
            db.query('SELECT titulo, clics FROM articulos ORDER BY clics DESC LIMIT 1'),
            db.query(`SELECT COUNT(*) FROM clics WHERE fecha > NOW() - INTERVAL '24 hours'`),
            db.query(`SELECT COUNT(*) FROM articulos WHERE seccion = 'buying_now'`),
            db.query(`SELECT COUNT(*) FROM articulos WHERE seccion = 'trending'`),
        ]);
        res.json({
            productos:    parseInt(prods.rows[0].count),
            curiosidades: parseInt(insights.rows[0].count),
            noticias:     parseInt(news.rows[0].count),
            clicsHoy:     parseInt(clicksHoy.rows[0].count),
            topProducto:  topClick.rows[0] || null,
            affiliateTag: AFFILIATE_TAG,
            secciones: {
                buying_now: parseInt(buyingNow.rows[0].count),
                trending:   parseInt(trending.rows[0].count),
            },
            motor: geminiKeys.length ? `Gemini 2.5 Flash ✅ (${geminiKeys.length} keys)` : '❌ No API Key',
            pexels:   process.env.PEXELS_API_KEY        ? '✅' : '❌',
            unsplash: process.env.UNSPLASH_ACCESS_KEY   ? '✅' : '❌',
            newsApi:  process.env.NEWS_API_KEY           ? '✅' : '❌',
            google:   (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) ? '✅' : '❌',
            version:  '8.2.1'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sitemap
app.get('/sitemap.xml', async (req, res) => {
    const host = `https://${req.headers.host}`;
    try {
        const r = await db.query('SELECT id, titulo, fecha FROM articulos ORDER BY fecha DESC LIMIT 500');
        const urls = r.rows.map(p => {
            const slug = (p.titulo || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
            return `<url><loc>${host}/product/${p.id}/${slug}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
        }).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>${urls}</urlset>`);
    } catch { res.status(500).send('Sitemap error'); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    console.log(`🔑 Gemini keys: ${geminiKeys.length}`);

    // v8.2.1 — publishInsight every 45 min (was 15 min)
    cron.schedule('*/45 * * * *', () => publishInsight());
    cron.schedule('0 */2 * * *',  () => publishLuxuryNews());

    setTimeout(() => publishInsight(),    10000);
    setTimeout(() => publishLuxuryNews(), 30000);
    app.listen(PORT, '0.0.0.0', () =>
        console.log(`🚀 MXL v8.2.1 — TAG:${AFFILIATE_TAG} — Keys:${geminiKeys.length} — Port:${PORT}`)
    );
}
start();
