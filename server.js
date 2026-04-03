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
            seccion VARCHAR(60) DEFAULT 'buying_now',
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
        await db.query(`CREATE TABLE IF NOT EXISTS audit_log (
            id BIGSERIAL PRIMARY KEY,
            accion VARCHAR(60) NOT NULL,
            producto_id BIGINT,
            titulo TEXT,
            affiliate_tag VARCHAR(60),
            detalle TEXT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Migraciones
        for (const sql of [
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS clics INT DEFAULT 0`,
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS keyword TEXT`,
            `ALTER TABLE articulos ADD COLUMN IF NOT EXISTS seccion VARCHAR(60) DEFAULT 'buying_now'`,
            `ALTER TABLE curiosidades ADD COLUMN IF NOT EXISTS seccion VARCHAR(60) DEFAULT 'trending'`,
        ]) { await db.query(sql).catch(() => {}); }
        
        console.log('✅ DB Ready v4.0');
    } catch (e) { console.error('❌ DB Error:', e.message); }
}

async function audit(accion, producto_id, titulo, tag, detalle = '') {
    try {
        await db.query(
            `INSERT INTO audit_log (accion, producto_id, titulo, affiliate_tag, detalle) VALUES ($1,$2,$3,$4,$5)`,
            [accion, producto_id || null, titulo || null, tag || AFFILIATE_TAG, detalle]
        );
    } catch (e) { console.warn('⚠️ Audit failed:', e.message); }
}

// ============================================================
// GEMINI CON ROTACIÓN DE 3 KEYS + RETRY
// ============================================================
const geminiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(Boolean);

let geminiIndex = 0;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateContent(prompt, maxRetries = 3) {
    if (!geminiKeys.length) throw new Error('No Gemini keys available');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (let i = 0; i < geminiKeys.length; i++) {
            try {
                const key = geminiKeys[(geminiIndex + i) % geminiKeys.length];
                const genAI = new GoogleGenerativeAI(key.trim());
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const result = await model.generateContent(prompt);
                geminiIndex = (geminiIndex + i + 1) % geminiKeys.length;
                const text = result.response.text();
                if (text && text.length > 10) return text.trim();
            } catch (e) {
                console.warn(`⚠️ Gemini key ${i+1} attempt ${attempt}: ${e.message}`);
                if (e.message?.includes('429')) await sleep(5000);
            }
        }
        if (attempt < maxRetries) await sleep(3000);
    }
    throw new Error('All Gemini keys failed after retries');
}

// ============================================================
// PROMPT OPTIMIZADO PARA VENDER (NO DESCRIBIR)
// ============================================================
async function generateConversionCopy(titulo, categoria) {
    const prompt = `Eres una editora de lujo para Architectural Digest. Escribes para mujeres de alto poder adquisitivo en NYC, Miami y LA.

PRODUCTO: "${titulo}"
CATEGORÍA: "${categoria}"

REGLAS (NO LAS ROMPAS):
- NO uses: "amazing", "great", "good", "nice", "best", "excellent"
- Usa lenguaje emocional, de estatus y escasez
- Incluye referencias a ciudades (NYC, Miami, LA, SoHo, Brickell)
- Haz que sienta que lo necesita AHORA

Responde SOLO este JSON (sin texto extra):
{
  "title": "título aspiracional con ciudad (max 12 palabras)",
  "meta": "frase que enganche (max 20 palabras)",
  "teaser": "2-3 frases con prueba social + urgencia",
  "keyword": "3-5 palabras de búsqueda",
  "badge": "Editor's Pick, Best Seller, NYC's Favorite, o Top Rated",
  "fomo_line": "frase de escasez (max 12 palabras)",
  "cta": "llamada a acción persuasiva"
}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const raw = await generateContent(prompt);
            let clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const match = clean.match(/\{[\s\S]*\}/);
            if (match) clean = match[0];
            
            const parsed = JSON.parse(clean);
            
            // Validar campos requeridos
            const required = ['title', 'meta', 'teaser', 'keyword', 'badge', 'fomo_line', 'cta'];
            if (required.every(f => parsed[f] && parsed[f].length > 3)) {
                console.log(`✅ Copy generado: ${parsed.title.slice(0, 50)}...`);
                return parsed;
            }
            throw new Error('Campos incompletos');
        } catch (e) {
            console.warn(`⚠️ Intento ${attempt} falló: ${e.message}`);
            if (attempt === 3) {
                // Fallback
                return {
                    title: `${titulo} — The NYC Standard for ${categoria}`,
                    meta: `The ${categoria.toLowerCase()} that discerning women are switching to.`,
                    teaser: `Premium quality. Effortless style. The quiet confidence of owning the best. Join thousands of women who've made the switch.`,
                    keyword: `${categoria.toLowerCase()} luxury`,
                    badge: "Editor's Pick",
                    fomo_line: `Limited stock for Prime delivery this week.`,
                    cta: `View on Amazon →`
                };
            }
            await sleep(2000);
        }
    }
}

// ============================================================
// ENDPOINTS
// ============================================================

// Tracking de clics
app.post('/api/track/click', async (req, res) => {
    const { producto_id, tipo = 'product' } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false });
    try {
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [producto_id]);
        await db.query(`INSERT INTO clics (producto_id, tipo) VALUES ($1, $2)`, [producto_id, tipo]);
        res.json({ ok: true, producto_id, timestamp: new Date().toISOString() });
    } catch (e) { res.status(500).json({ ok: false }); }
});

// Productos con filtros
app.get('/api/productos', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 12;
    const offset = (page - 1) * limit;
    const seccion = req.query.seccion || null;
    try {
        const where = seccion ? 'WHERE seccion = $3' : '';
        const params = seccion ? [limit, offset, seccion] : [limit, offset];
        const rows = await db.query(`SELECT * FROM articulos ${where} ORDER BY fecha DESC LIMIT $1 OFFSET $2`, params);
        const total = await db.query(`SELECT COUNT(*) FROM articulos ${where}`, seccion ? [seccion] : []);
        res.json({ items: rows.rows, total: parseInt(total.rows[0].count), page, hasMore: offset + limit < parseInt(total.rows[0].count) });
    } catch { res.status(500).json({ items: [] }); }
});

app.get('/api/categorias', async (req, res) => {
    try {
        const r = await db.query(`SELECT DISTINCT categoria, COUNT(*) as total FROM articulos GROUP BY categoria ORDER BY total DESC`);
        res.json(r.rows);
    } catch { res.json([]); }
});

// ============================================================
// ENDPOINT MEJORADO DE INYECCIÓN (CON COPY DE VENTAS)
// ============================================================
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal, seccion = 'buying_now' } = req.body;
    if (!geminiKeys.length || !tituloReal) {
        return res.status(400).json({ success: false, error: 'Missing product name or AI engine' });
    }
    try {
        // Generar copy de VENTAS (no descripción)
        const copy = await generateConversionCopy(tituloReal, categoria || 'LUXURY');
        
        const image = imagenUrl || `https://images.pexels.com/photos/${['280229','258154','1643383'][Math.floor(Math.random()*3)]}/pexels-photo-xxx.jpeg?auto=compress&cs=tinysrgb&w=600`;
        const linkWithTag = addAffiliateTag(url);
        const metaWithBadge = JSON.stringify({ badge: copy.badge, text: copy.meta });
        const id = Date.now();

        const tagInLink = new URL(linkWithTag).searchParams.get('tag');
        if (tagInLink !== AFFILIATE_TAG) throw new Error(`Tag mismatch`);

        await db.query(
            `INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, keyword, seccion, clics, fecha) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11)`,
            [id, 'MXL'+id, copy.title, metaWithBadge, copy.teaser, image, categoria || 'LUXURY', linkWithTag, copy.keyword, seccion, new Date().toISOString()]
        );
        
        await audit('INJECT_CONVERSION', id, copy.title, tagInLink, `seccion:${seccion} | badge:${copy.badge} | fomo:${copy.fomo_line}`);
        
        console.log(`✅ Inyectado: ${copy.title} (${copy.badge})`);
        
        res.json({ 
            success: true, 
            product: copy.title,
            badge: copy.badge,
            teaser: copy.teaser,
            fomo_line: copy.fomo_line,
            cta: copy.cta,
            affiliateTag: AFFILIATE_TAG,
            image
        });
    } catch (e) {
        console.error('❌ Inject error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Eliminar producto
app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        await db.query('DELETE FROM clics WHERE producto_id = $1', [req.params.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ success: false }); }
});

// ============================================================
// SITEMAP Y STATIC
// ============================================================
app.get('/sitemap.xml', async (req, res) => {
    const host = `https://${req.headers.host}`;
    try {
        const r = await db.query('SELECT id, fecha FROM articulos ORDER BY fecha DESC LIMIT 500');
        const urls = r.rows.map(p => `<url><loc>${host}/product/${p.id}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod></url>`).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc></url>${urls}</urlset>`);
    } catch { res.status(500).send('Error'); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
// AUTO-PILOT (cada 45 min)
// ============================================================
async function generateInsight() {
    if (!geminiKeys.length) return;
    try {
        const prompt = `Escribe un insight de lujo para mujeres de NYC/Miami/LA sobre lo que están comprando ahora. Responde SOLO JSON: {"title":"...","body":"...","keyword":"..."}`;
        const raw = await generateContent(prompt);
        const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        const id = Date.now();
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, keyword, fecha) VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, data.title, data.body, `https://images.pexels.com/photos/1643383/pexels-photo-1643383.jpeg?auto=compress&cs=tinysrgb&w=600`, data.keyword, new Date()]);
        console.log(`✨ Insight: ${data.title}`);
    } catch (e) { console.error('Insight error:', e.message); }
}

// ============================================================
// INICIO
// ============================================================
async function start() {
    await initDB();
    console.log(`🔑 Gemini keys: ${geminiKeys.length}`);
    cron.schedule('*/45 * * * *', () => generateInsight());
    setTimeout(() => generateInsight(), 10000);
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 MXL v4.0 — TAG:${AFFILIATE_TAG} — Port:${PORT}`));
}

start();
