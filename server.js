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

function agregarAffiliateTag(url) {
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

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', version: '6.0' }));

// ============================================================
// ROBOTS.TXT — Google sabe qué indexar
// ============================================================
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

const cache = { productos: null, curiosidades: null, noticias: null, ts: {} };
const CACHE_TTL = 60 * 1000;
function cacheValido(key) {
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
                id BIGSERIAL PRIMARY KEY, producto_id BIGINT, tipo VARCHAR(20) DEFAULT 'producto',
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Migracion segura — añadir columnas si la tabla ya existia
        await db.query(`ALTER TABLE articulos ADD COLUMN IF NOT EXISTS clics INT DEFAULT 0`).catch(() => {});
        await db.query(`ALTER TABLE articulos ADD COLUMN IF NOT EXISTS keyword TEXT`).catch(() => {});
        await db.query(`ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS keyword TEXT`).catch(() => {});
        await db.query(`ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS producto_id BIGINT`).catch(() => {});
        console.log('✅ DB Lista v6.0');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR GEMINI — ROTACIÓN 3 KEYS
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
        } catch (e) { console.warn(`⚠️ Gemini key ${i} falló: ${e.message}`); }
    }
    throw new Error('Todos los motores Gemini fallaron');
}

// ============================================================
// IMÁGENES: Pexels → Unsplash → Fija
// ============================================================
async function buscarImagenPexels(keyword) {
    const key = process.env.PEXELS_API_KEY;
    if (!key) return null;
    try {
        const q = encodeURIComponent(keyword + ' luxury');
        const res = await fetch(`https://api.pexels.com/v1/search?query=${q}&per_page=5&orientation=landscape`, {
            headers: { Authorization: key }
        });
        const data = await res.json();
        if (data.photos?.length > 0) return data.photos[Math.floor(Math.random() * data.photos.length)].src.large;
    } catch (e) { console.warn('Pexels falló:', e.message); }
    return null;
}

async function buscarImagenUnsplash(keyword) {
    const key = process.env.UNSPLASH_ACCESS_KEY;
    if (!key) return null;
    try {
        const q = encodeURIComponent(keyword + ' luxury');
        const res = await fetch(`https://api.unsplash.com/search/photos?query=${q}&per_page=5&orientation=landscape`, {
            headers: { Authorization: `Client-ID ${key}` }
        });
        const data = await res.json();
        if (data.results?.length > 0) return data.results[Math.floor(Math.random() * data.results.length)].urls.regular;
    } catch (e) { console.warn('Unsplash falló:', e.message); }
    return null;
}

async function obtenerImagen(keyword) {
    const img = await buscarImagenPexels(keyword) || await buscarImagenUnsplash(keyword);
    if (img) return img;
    const fijas = ['280229','258154','1643383','323780','1571460','2093107','1457842','276724'];
    const id = fijas[Math.floor(Math.random() * fijas.length)];
    return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1200`;
}

// ============================================================
// HELPER — Producto relacionado por keyword
// ============================================================
async function encontrarProductoRelacionado(keyword) {
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
// PILOTO — Curiosidades SEO linkadas a producto
// ============================================================
const TEMAS_SEO = [
    { tema: 'best luxury kitchen appliances Amazon 2026', keyword: 'luxury kitchen appliances' },
    { tema: 'smart home gadgets millionaires NYC buy', keyword: 'smart home luxury' },
    { tema: 'luxury bedroom upgrade products Amazon', keyword: 'luxury bedroom decor' },
    { tema: 'wine cooler refrigerator luxury home bar', keyword: 'luxury wine cooler' },
    { tema: 'best air purifier luxury apartment', keyword: 'luxury air purifier home' },
    { tema: 'luxury coffee maker espresso machine Amazon', keyword: 'luxury espresso machine' },
    { tema: 'heated towel rack bathroom luxury Amazon', keyword: 'heated towel rack luxury' },
    { tema: 'smart lighting luxury home Philips Hue', keyword: 'smart lighting luxury home' },
    { tema: 'luxury mattress sleep quality Amazon 2026', keyword: 'luxury mattress brand' },
    { tema: 'high end vacuum cleaner luxury apartment', keyword: 'luxury vacuum cleaner' },
    { tema: 'outdoor luxury furniture patio Manhattan', keyword: 'luxury outdoor furniture' },
    { tema: 'luxury candle home fragrance Amazon bestseller', keyword: 'luxury candle home decor' },
];
let temaIndex = 0;

async function publicarCuriosidadViral() {
    if (!geminiKeys.length) return;
    console.log('⏰ [CRON] Generando curiosidad SEO...');
    try {
        const temaActual = TEMAS_SEO[temaIndex % TEMAS_SEO.length];
        temaIndex++;

        const prompt = `Eres experto en SEO, marketing de afiliados Amazon y copywriting de lujo.

TEMA: "${temaActual.tema}"
AUDIENCIA: Mujeres 35-55, alto poder adquisitivo, NYC/Miami/Beverly Hills.

OBJETIVO: Artículo que rankee en Google Y genere clics hacia Amazon.

REGLAS:
- titulo_es: Título tipo Vogue Living con keyword real. Máx 12 palabras. Ej: "Las 5 Cafeteras de Lujo Que Todo Penthouse en NYC Necesita en 2026"
- texto_es: 3 oraciones. (1) Dato o estadística real. (2) Por qué la élite lo quiere. (3) CTA suave: termina con "Lo encuentras en Amazon por menos de lo que imaginas." Máx 100 palabras.
- keyword: Lo que alguien escribe en Google para comprar esto (inglés, 3-5 palabras).
- PROHIBIDO: Títulos abstractos o filosóficos sin producto real.

SOLO JSON sin markdown: {"titulo_es":"...","texto_es":"...","keyword":"..."}`;

        const raw = await generateContent(prompt);
        const data = JSON.parse(raw);
        const imagen = await obtenerImagen(data.keyword || temaActual.keyword);
        const productoRelacionado = await encontrarProductoRelacionado(data.keyword || temaActual.keyword);

        await db.query(
            `INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, keyword, producto_id, fecha)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [Date.now(), data.titulo_es, data.texto_es, imagen,
             data.keyword, productoRelacionado?.id || null, new Date().toISOString()]
        );
        cache.curiosidades = null;
        console.log(`✨ Curiosidad: "${data.titulo_es}" → Producto: ${productoRelacionado?.titulo || 'sin enlace aun'}`);
    } catch (e) { console.error('❌ Error curiosidad:', e.message); }
}

// ============================================================
// PILOTO — Noticias de lujo
// ============================================================
async function publicarNoticiaLujo() {
    const newsKey = process.env.NEWS_API_KEY;
    if (!newsKey || !geminiKeys.length) return;
    try {
        const queries = ['luxury home', 'luxury lifestyle NYC', 'elite real estate Manhattan'];
        const q = encodeURIComponent(queries[Math.floor(Math.random() * queries.length)]);
        const res = await fetch(
            `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=5`,
            { headers: { 'X-Api-Key': newsKey } }
        );
        const data = await res.json();
        const articulo = data.articles?.find(a => a.title && a.description);
        if (!articulo) return;

        const raw = await generateContent(
            `Copywriter de lujo y SEO para afiliados Amazon. Reescribe para mujeres de alto poder adquisitivo NYC.
             Título estilo Architectural Digest o Vogue Living. Resumen termina con CTA suave hacia Amazon.
             Noticia: "${articulo.title} — ${articulo.description}"
             SOLO JSON: {"titulo":"...","resumen":"...","keyword":"..."}`
        );
        const copy = JSON.parse(raw);
        const imagen = articulo.urlToImage || await obtenerImagen(copy.keyword || 'luxury');

        await db.query(
            `INSERT INTO noticias (id, titulo, resumen, fuente, imagen, link, fecha) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [Date.now(), copy.titulo, copy.resumen, articulo.source?.name || 'MXL Gold', imagen, articulo.url, new Date().toISOString()]
        );
        cache.noticias = null;
        console.log(`📰 Noticia: ${copy.titulo}`);
    } catch (e) { console.error('❌ Error noticias:', e.message); }
}

// ============================================================
// ENDPOINTS
// ============================================================

// 📊 TRACKING — registrar clic
app.post('/api/track/click', async (req, res) => {
    const { producto_id, tipo = 'producto' } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false });
    try {
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [producto_id]);
        await db.query(`INSERT INTO clics (producto_id, tipo) VALUES ($1, $2)`, [producto_id, tipo]);
        cache.productos = null;
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false }); }
});

// 📊 Top productos por clics (para Commander)
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

// Inyectar producto
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    if (!geminiKeys.length || !tituloReal) return res.status(400).json({ success: false, error: 'Falta tituloReal o motor IA' });
    try {
        const raw = await generateContent(
            `Copywriter experto afiliados Amazon y psicología de compra de lujo.
             PRODUCTO: "${tituloReal}" — AUDIENCIA: Mujeres 35-55, NYC/Miami/Beverly Hills.
             - titulo: Nombre elevado con adjetivo de lujo. Máx 10 palabras.
             - meta: Beneficio principal, 20 palabras, para Google.
             - curiosidad: 2-3 oraciones. Dato → exclusividad → urgencia suave. Máx 60 palabras.
             - keyword: 3-4 palabras inglés para buscar en Google.
             SOLO JSON: {"titulo":"...","meta":"...","curiosidad":"...","keyword":"..."}`
        );
        const copy = JSON.parse(raw);
        const imagen = imagenUrl || await obtenerImagen(copy.keyword || tituloReal);
        const linkConTag = agregarAffiliateTag(url);

        await db.query(
            `INSERT INTO articulos (id,asin,titulo,meta,curiosidad,imagen,categoria,link,keyword,clics,fecha)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10)`,
            [Date.now(),'MXL'+Date.now(),copy.titulo,copy.meta,copy.curiosidad,
             imagen,categoria,linkConTag,copy.keyword,new Date().toISOString()]
        );
        cache.productos = null;
        res.json({ success: true, producto: copy.titulo, affiliateTag: AFFILIATE_TAG, imagen });
    } catch (e) {
        console.error('❌ Error inject:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Búsqueda Google desde Commander
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
        cache.productos = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/productos', async (req, res) => {
    if (cacheValido('productos')) return res.json(cache.productos);
    const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
    cache.productos = r.rows; cache.ts.productos = Date.now();
    res.json(r.rows);
});

// Curiosidades con JOIN al producto relacionado
app.get('/api/curiosidades', async (req, res) => {
    if (cacheValido('curiosidades')) return res.json(cache.curiosidades);
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
    cache.curiosidades = r.rows; cache.ts.curiosidades = Date.now();
    res.json(r.rows);
});

app.get('/api/noticias', async (req, res) => {
    if (cacheValido('noticias')) return res.json(cache.noticias);
    const r = await db.query(`SELECT * FROM noticias ORDER BY fecha DESC LIMIT 20`);
    cache.noticias = r.rows; cache.ts.noticias = Date.now();
    res.json(r.rows);
});

app.get('/api/stats', async (req, res) => {
    try {
        const [prods, curios, news, topClic] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query('SELECT COUNT(*) FROM curiosidades'),
            db.query('SELECT COUNT(*) FROM noticias'),
            db.query('SELECT titulo, clics FROM articulos ORDER BY clics DESC LIMIT 1')
        ]);
        res.json({
            productos: parseInt(prods.rows[0].count),
            curiosidades: parseInt(curios.rows[0].count),
            noticias: parseInt(news.rows[0].count),
            topProducto: topClic.rows[0] || null,
            affiliateTag: AFFILIATE_TAG,
            motor: geminiKeys.length ? `Gemini 2.5 Flash ✅ (${geminiKeys.length} keys)` : '❌ Sin API Key',
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
            `<url><loc>${host}/#producto-${p.id}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`
        ).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>${urls}</urlset>`);
    } catch (e) { res.status(500).send('Error sitemap'); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    console.log(`🔑 Gemini keys: ${geminiKeys.length}`);
    cron.schedule('*/15 * * * *', () => publicarCuriosidadViral()); // Cada 15 min
    cron.schedule('0 */2 * * *', () => publicarNoticiaLujo());
    setTimeout(() => publicarCuriosidadViral(), 10000);
    setTimeout(() => publicarNoticiaLujo(), 30000);
    app.listen(PORT, '0.0.0.0', () =>
        console.log(`🚀 MXL v6.0 — TAG:${AFFILIATE_TAG} — Keys:${geminiKeys.length} — Puerto:${PORT}`)
    );
}
start();
