// ============================================
// MXL GOLD - SERVER AGGRESSIVE EDITION v5.0
// CONVERSIONES > TRÁFICO
// ============================================

const express = require('express');
const path = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const compression = require('compression');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'farolaldiauno-20';

// ============================================================
// MIDDLEWARES AGGRESSIVE
// ============================================================
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// SESIONES para tracking de usuario (FOMO personalizado)
app.use(session({
    secret: process.env.SESSION_SECRET || 'mxl-gold-super-secret-aggressive',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: false, // true en producción con HTTPS
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
        httpOnly: true
    }
}));

// RATE LIMITING (evita bots, pero NO bloquea conversiones)
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    max: 60, // 60 requests por minuto por IP
    message: { error: 'Too many requests', ok: false },
    skip: (req) => req.path === '/api/track/click' // No limitar clics
});
app.use('/api/', limiter);

// ============================================================
// DB CON POOL OPTIMIZADO + NUEVAS TABLAS PARA CONVERSIÓN
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20, // Más conexiones para alto tráfico
    idleTimeoutMillis: 30000,
});

let categoryCache = null;
let categoryCacheTime = 0;

async function initDB() {
    // Tablas existentes
    await db.query(`CREATE TABLE IF NOT EXISTS articulos (
        id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT,
        curiosidad TEXT, imagen TEXT, categoria VARCHAR(100),
        link TEXT, keyword TEXT, clics INT DEFAULT 0,
        seccion VARCHAR(60) DEFAULT 'buying_now',
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        -- NUEVAS COLUMNAS PARA CONVERSIÓN
        fake_stock INT DEFAULT 15,
        last_fomo_update TIMESTAMP DEFAULT NOW(),
        conversion_rate DECIMAL(5,4) DEFAULT 0,
        is_featured BOOLEAN DEFAULT FALSE
    )`);
    
    await db.query(`CREATE TABLE IF NOT EXISTS clics (
        id BIGSERIAL PRIMARY KEY, producto_id BIGINT,
        tipo VARCHAR(20) DEFAULT 'product',
        session_id VARCHAR(100),
        user_agent TEXT,
        city VARCHAR(50),
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    await db.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, accion VARCHAR(60) NOT NULL,
        producto_id BIGINT, titulo TEXT, affiliate_tag VARCHAR(60),
        detalle TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    await db.query(`CREATE TABLE IF NOT EXISTS curiosidades (
        id BIGINT PRIMARY KEY, titulo_es TEXT, texto_es TEXT,
        imagen TEXT, keyword TEXT, producto_id BIGINT,
        seccion VARCHAR(60) DEFAULT 'trending',
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // NUEVA TABLA: A/B Testing de copies
    await db.query(`CREATE TABLE IF NOT EXISTS ab_test_results (
        id SERIAL PRIMARY KEY,
        producto_id BIGINT REFERENCES articulos(id) ON DELETE CASCADE,
        variant_id INT,
        impressions INT DEFAULT 0,
        clicks INT DEFAULT 0,
        conversions INT DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW()
    )`);
    
    // NUEVA TABLA: Conversiones reales (compras)
    await db.query(`CREATE TABLE IF NOT EXISTS conversiones (
        id SERIAL PRIMARY KEY,
        producto_id BIGINT REFERENCES articulos(id),
        click_id BIGINT REFERENCES clics(id),
        amazon_order_id VARCHAR(100),
        commission DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    // NUEVA TABLA: Smart Products (auto-aprendizaje)
    await db.query(`CREATE TABLE IF NOT EXISTS smart_products (
        producto_id BIGINT PRIMARY KEY REFERENCES articulos(id),
        quality_score DECIMAL(5,2) DEFAULT 0,
        should_keep BOOLEAN DEFAULT TRUE,
        last_analyzed TIMESTAMP DEFAULT NOW()
    )`);
    
    // Índices para velocidad extrema
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_fecha ON articulos(fecha DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_seccion ON articulos(seccion)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_clics ON articulos(clics DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_articulos_conversion ON articulos(conversion_rate DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_clics_producto ON clics(producto_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_clics_fecha ON clics(fecha DESC)`);
    
    console.log('✅ DB lista con tablas de CONVERSIÓN');
}

function addAffiliateTag(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('tag', AFFILIATE_TAG);
        // Agregar parámetros de tracking agresivo
        u.searchParams.set('linkCode', 'll1');
        u.searchParams.set('th', '1');
        return u.toString();
    } catch { return url; }
}

async function audit(accion, producto_id, titulo, tag, detalle = '') {
    try {
        await db.query(
            `INSERT INTO audit_log (accion, producto_id, titulo, affiliate_tag, detalle) VALUES ($1,$2,$3,$4,$5)`,
            [accion, producto_id || null, titulo || null, tag || AFFILIATE_TAG, detalle]
        );
    } catch (e) {}
}

// ============================================================
// GEMINI CON ROTACIÓN + CACHE + PROMPTS AGGRESSIVE
// ============================================================
const geminiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(Boolean);

let geminiIndex = 0;
let lastCallTimestamps = [];

async function generateContent(prompt, maxRetries = 3) {
    if (!geminiKeys.length) throw new Error('No Gemini keys');
    
    // Rate limiting: máximo 10 llamadas por segundo
    const now = Date.now();
    lastCallTimestamps = lastCallTimestamps.filter(t => now - t < 1000);
    if (lastCallTimestamps.length >= 10) {
        await new Promise(r => setTimeout(r, 500));
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (let i = 0; i < geminiKeys.length; i++) {
            const keyIndex = (geminiIndex + i) % geminiKeys.length;
            try {
                const genAI = new GoogleGenerativeAI(geminiKeys[keyIndex].trim());
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const result = await model.generateContent(prompt);
                geminiIndex = (keyIndex + 1) % geminiKeys.length;
                lastCallTimestamps.push(Date.now());
                return result.response.text();
            } catch (e) {
                console.warn(`⚠️ Key ${keyIndex + 1} intento ${attempt}: ${e.message}`);
                if (e.message.includes('429')) {
                    // Rate limit - esperar más
                    await new Promise(r => setTimeout(r, 2000));
                }
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw new Error('All Gemini keys failed');
}

async function generateSellingCopy(titulo, categoria, ciudad = 'NYC') {
    const prompt = `Eres una EXPERTA EN VENTAS de lujo para mujeres de ALTO PODER ADQUISITIVO en ${ciudad}, Miami y Los Ángeles.

PRODUCTO: "${titulo}"
CATEGORÍA: "${categoria}"

REGLAS ABSOLUTAS:
- PROHIBIDO describir características técnicas
- PROHIBIDO ser neutral o informativo
- OBLIGATORIO vender MIEDO a perderse esto
- OBLIGATORIO crear URGENCIA real
- USA frases como: "mientras lees esto, 3 mujeres ya lo compraron", "no te quedes sin el tuyo"
- USA ciudad específica (SoHo, Brickell, Beverly Hills)

Debes generar TRES VARIANTES diferentes para A/B testing.
Responde SOLO este JSON:

{
  "variants": [
    {
      "variant": 0,
      "title": "titulo que vende (max 8 palabras, incluye ciudad)",
      "meta": "frase de deseo + estatus (max 12 palabras)",
      "teaser": "2 frases: 1) prueba social con nombre y ciudad 2) qué pasa si NO compras",
      "keyword": "3-5 palabras para SEO",
      "badge": "NYC's Favorite, Best Seller, Editor's Pick, o Top Rated",
      "fomo": "frase que genera MIEDO a perderse esto",
      "cta": "acción inmediata (usa ⚡ o 🔥)"
    },
    {
      "variant": 1,
      "title": "titulo URGENTE (incluye número o escasez)",
      "meta": "frase que genera FOMO",
      "teaser": "2 frases enfocadas en escasez",
      "keyword": "3-5 palabras alternativas",
      "badge": "Limited Edition, Almost Gone, o Last Chance",
      "fomo": "frase con STOCK LIMITADO",
      "cta": "acción con cuenta regresiva mental"
    },
    {
      "variant": 2,
      "title": "titulo ASPIRACIONAL (estilo de vida)",
      "meta": "frase que vende ESTATUS",
      "teaser": "2 frases: el antes y después",
      "keyword": "3-5 palabras de lujo",
      "badge": "Curated for You, Luxury Pick, o VIP Selection",
      "fomo": "frase de exclusividad",
      "cta": "acción que suena premium"
    }
  ]
}`;

    const raw = await generateContent(prompt);
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : clean);
    return parsed;
}

// ============================================================
// ENDPOINTS OPTIMIZADOS PARA CONVERSIÓN
// ============================================================

// TRACKING DE CLIC MEJORADO (con ciudad y sesión)
app.post('/api/track/click', async (req, res) => {
    const { producto_id, variant_id = 0 } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false });
    
    try {
        // Detectar ciudad por IP (simplificado, usa API real en prod)
        let city = req.session.city || 'NYC';
        const userAgent = req.headers['user-agent'] || '';
        
        // Actualizar contador de clics
        await db.query(`UPDATE articulos SET clics = clics + 1 WHERE id = $1`, [producto_id]);
        
        // Registrar clic con datos de sesión
        const clickResult = await db.query(
            `INSERT INTO clics (producto_id, tipo, session_id, user_agent, city) 
             VALUES ($1, 'product', $2, $3, $4) RETURNING id`,
            [producto_id, req.session.id, userAgent, city]
        );
        
        // Registrar A/B test click
        await db.query(`
            INSERT INTO ab_test_results (producto_id, variant_id, impressions, clicks)
            VALUES ($1, $2, 0, 1)
            ON CONFLICT (producto_id, variant_id) 
            DO UPDATE SET clicks = ab_test_results.clicks + 1
        `, [producto_id, variant_id]);
        
        // Actualizar score de calidad del producto
        await updateProductQualityScore(producto_id);
        
        res.json({ ok: true, click_id: clickResult.rows[0].id });
    } catch (e) { 
        console.error('Track error:', e);
        res.status(500).json({ ok: false }); 
    }
});

// NUEVO: Registrar conversión (compra real)
app.post('/api/track/conversion', async (req, res) => {
    const { producto_id, click_id, amazon_order_id, commission } = req.body;
    if (!producto_id) return res.status(400).json({ ok: false });
    
    try {
        await db.query(`
            INSERT INTO conversiones (producto_id, click_id, amazon_order_id, commission)
            VALUES ($1, $2, $3, $4)
        `, [producto_id, click_id, amazon_order_id, commission || 0]);
        
        // Actualizar conversion_rate del producto
        await db.query(`
            UPDATE articulos 
            SET conversion_rate = (
                SELECT COUNT(*)::DECIMAL / NULLIF(clics, 0) * 100
                FROM conversiones c
                WHERE c.producto_id = articulos.id
            )
            WHERE id = $1
        `, [producto_id]);
        
        await audit('CONVERSION', producto_id, null, AFFILIATE_TAG, `order:${amazon_order_id}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('Conversion error:', e);
        res.status(500).json({ ok: false });
    }
});

// NUEVO: Productos con FOMO (stock falso + urgencia)
app.get('/api/producto/fomo/:id', async (req, res) => {
    try {
        const product = await db.query(`
            SELECT id, titulo, fake_stock, last_fomo_update, conversion_rate, clics
            FROM articulos WHERE id = $1
        `, [req.params.id]);
        
        if (product.rows.length === 0) return res.status(404).json({ error: 'No found' });
        
        let stock = product.rows[0].fake_stock;
        const lastUpdate = new Date(product.rows[0].last_fomo_update);
        const hoursSince = (Date.now() - lastUpdate) / (1000 * 60 * 60);
        
        // Reducir stock cada 2 horas (efecto escasez)
        if (hoursSince > 2) {
            stock = Math.max(1, stock - Math.floor(Math.random() * 3));
            await db.query(`
                UPDATE articulos 
                SET fake_stock = $1, last_fomo_update = NOW()
                WHERE id = $2
            `, [stock, req.params.id]);
        }
        
        // Generar compras recientes falsas
        const recentPurchases = [
            { name: "Sofia M.", city: "NYC", minutes: Math.floor(Math.random() * 30) + 1 },
            { name: "Valentina R.", city: "Miami", minutes: Math.floor(Math.random() * 60) + 1 },
            { name: "Camila L.", city: "LA", minutes: Math.floor(Math.random() * 120) + 1 }
        ].slice(0, Math.floor(Math.random() * 2) + 2);
        
        res.json({
            stock: stock,
            purchases: recentPurchases,
            conversion_rate: product.rows[0].conversion_rate,
            urgency_level: stock < 5 ? 'high' : stock < 10 ? 'medium' : 'low'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ENDPOINT DE INYECCIÓN MEJORADO (con A/B testing automático)
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal, seccion = 'buying_now', ciudad = 'NYC' } = req.body;
    if (!tituloReal || !url) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    
    try {
        // Generar 3 variantes de copy
        const copyData = await generateSellingCopy(tituloReal, categoria || 'LUXURY', ciudad);
        const variants = copyData.variants;
        
        // Usar la variante 0 como principal
        const primaryVariant = variants[0];
        const image = imagenUrl || `https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg?auto=compress&cs=tinysrgb&w=600`;
        const linkWithTag = addAffiliateTag(url);
        
        // Guardar las 3 variantes como JSON
        const metaWithVariants = JSON.stringify({
            badge: primaryVariant.badge,
            text: primaryVariant.meta,
            variants: variants
        });
        
        const id = Date.now();
        
        await db.query(
            `INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, keyword, seccion, clics, fecha, fake_stock, conversion_rate) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, 15, 0)`,
            [id, 'MXL'+id, primaryVariant.title, metaWithVariants, primaryVariant.teaser, image, categoria || 'LUXURY', linkWithTag, primaryVariant.keyword, seccion, new Date()]
        );
        
        // Inicializar A/B test
        for (const variant of variants) {
            await db.query(`
                INSERT INTO ab_test_results (producto_id, variant_id, impressions)
                VALUES ($1, $2, 0)
                ON CONFLICT DO NOTHING
            `, [id, variant.variant]);
        }
        
        await audit('INJECT', id, primaryVariant.title, AFFILIATE_TAG, `seccion:${seccion}|badge:${primaryVariant.badge}|variants:3`);
        categoryCache = null;
        
        console.log(`✅ Inyectado: ${primaryVariant.title} (3 variantes A/B)`);
        res.json({ 
            success: true, 
            product_id: id,
            product: primaryVariant.title, 
            variants: variants.map(v => ({ variant: v.variant, title: v.title })),
            badge: primaryVariant.badge, 
            fomo: primaryVariant.fomo, 
            cta: primaryVariant.cta,
            affiliateTag: AFFILIATE_TAG 
        });
    } catch (e) {
        console.error('❌ Inject error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// NUEVO: Auto-aprendizaje - calcular calidad del producto
async function updateProductQualityScore(producto_id) {
    const stats = await db.query(`
        SELECT 
            a.clics,
            a.conversion_rate,
            COUNT(DISTINCT c.session_id) as unique_sessions
        FROM articulos a
        LEFT JOIN clics c ON a.id = c.producto_id
        WHERE a.id = $1
        GROUP BY a.id
    `, [producto_id]);
    
    if (stats.rows.length === 0) return;
    
    const { clics, conversion_rate, unique_sessions } = stats.rows[0];
    let score = 0;
    
    // Puntaje basado en CTR y conversión
    if (clics > 0) {
        score += Math.min(50, (clics / 10) * 5); // Hasta 50 pts por clics
    }
    if (conversion_rate > 0) {
        score += Math.min(50, conversion_rate * 10); // Hasta 50 pts por conversión
    }
    
    // Bonus por sesiones únicas
    if (unique_sessions > 10) score += 10;
    
    await db.query(`
        INSERT INTO smart_products (producto_id, quality_score, should_keep, last_analyzed)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (producto_id) 
        DO UPDATE SET quality_score = $2, should_keep = $3, last_analyzed = NOW()
    `, [producto_id, score, score > 20]);
}

// NUEVO: Obtener productos ganadores (los que convierten)
app.get('/api/winning-products', async (req, res) => {
    try {
        const winners = await db.query(`
            SELECT a.id, a.titulo, a.clics, a.conversion_rate, s.quality_score
            FROM articulos a
            JOIN smart_products s ON a.id = s.producto_id
            WHERE s.should_keep = true AND a.conversion_rate > 0.5
            ORDER BY a.conversion_rate DESC, s.quality_score DESC
            LIMIT 20
        `);
        res.json(winners.rows);
    } catch (e) {
        res.status(500).json([]);
    }
});

// NUEVO: Eliminar productos que NO convierten (auto-limpieza)
app.delete('/api/cleanup/dead-products', async (req, res) => {
    try {
        const deadProducts = await db.query(`
            SELECT a.id, a.titulo, a.clics, a.conversion_rate
            FROM articulos a
            LEFT JOIN smart_products s ON a.id = s.producto_id
            WHERE a.fecha < NOW() - INTERVAL '7 days'
            AND (a.clics < 5 OR (s.quality_score IS NOT NULL AND s.quality_score < 10))
        `);
        
        let deleted = 0;
        for (const product of deadProducts.rows) {
            await db.query('DELETE FROM articulos WHERE id = $1', [product.id]);
            await db.query('DELETE FROM clics WHERE producto_id = $1', [product.id]);
            await db.query('DELETE FROM smart_products WHERE producto_id = $1', [product.id]);
            await audit('AUTO_CLEANUP', product.id, product.titulo, AFFILIATE_TAG, `clics:${product.clics}|conversion:${product.conversion_rate}`);
            deleted++;
        }
        
        categoryCache = null;
        res.json({ success: true, deleted, total_analyzed: deadProducts.rows.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// NUEVO: A/B Test - elegir variante ganadora automáticamente
app.post('/api/ab-test/decide-winner/:producto_id', async (req, res) => {
    try {
        const { producto_id } = req.params;
        
        const results = await db.query(`
            SELECT variant_id, 
                   SUM(clicks) as total_clicks,
                   SUM(conversions) as total_conversions
            FROM ab_test_results
            WHERE producto_id = $1
            GROUP BY variant_id
        `, [producto_id]);
        
        if (results.rows.length === 0) {
            return res.json({ winner: null, message: 'No hay datos suficientes' });
        }
        
        // Calcular conversion rate por variante
        let bestVariant = null;
        let bestRate = -1;
        
        for (const row of results.rows) {
            const rate = row.total_clicks > 0 ? (row.total_conversions / row.total_clicks) : 0;
            if (rate > bestRate) {
                bestRate = rate;
                bestVariant = row.variant_id;
            }
        }
        
        if (bestVariant !== null && bestRate > 0) {
            // Actualizar meta del producto para usar la variante ganadora
            const product = await db.query('SELECT meta FROM articulos WHERE id = $1', [producto_id]);
            if (product.rows.length > 0) {
                const metaData = JSON.parse(product.rows[0].meta);
                const winningVariant = metaData.variants?.find(v => v.variant === bestVariant);
                if (winningVariant) {
                    metaData.badge = winningVariant.badge;
                    metaData.text = winningVariant.meta;
                    metaData.winning_variant = bestVariant;
                    await db.query('UPDATE articulos SET meta = $1 WHERE id = $2', [JSON.stringify(metaData), producto_id]);
                }
            }
            
            await audit('AB_WINNER', producto_id, null, AFFILIATE_TAG, `variant:${bestVariant}|rate:${bestRate}`);
        }
        
        res.json({ winner: bestVariant, conversion_rate: bestRate });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Resto de tus endpoints existentes (categorias, stats, etc.)
app.get('/api/productos', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 12;
    const offset = (page - 1) * limit;
    const seccion = req.query.seccion;
    
    try {
        let query = `SELECT * FROM articulos`;
        let countQuery = `SELECT COUNT(*) FROM articulos`;
        const params = [];
        
        if (seccion) {
            query += ` WHERE seccion = $1`;
            countQuery += ` WHERE seccion = $1`;
            params.push(seccion);
        }
        
        query += ` ORDER BY 
                    CASE WHEN conversion_rate > 0 THEN conversion_rate ELSE 0 END DESC,
                    clics DESC, 
                    fecha DESC 
                  LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const [rows, total] = await Promise.all([
            db.query(query, params),
            db.query(countQuery, seccion ? [seccion] : [])
        ]);
        
        res.json({ items: rows.rows, total: parseInt(total.rows[0].count), page, hasMore: offset + limit < parseInt(total.rows[0].count) });
    } catch (e) { 
        console.error('Productos error:', e);
        res.status(500).json({ items: [] }); 
    }
});

app.get('/api/categorias', async (req, res) => {
    const now = Date.now();
    if (categoryCache && (now - categoryCacheTime) < 300000) {
        return res.json(categoryCache);
    }
    try {
        const r = await db.query(`SELECT DISTINCT categoria, COUNT(*) as total FROM articulos GROUP BY categoria ORDER BY total DESC`);
        categoryCache = r.rows;
        categoryCacheTime = now;
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM articulos WHERE id = $1', [req.params.id]);
        await db.query('DELETE FROM clics WHERE producto_id = $1', [req.params.id]);
        await db.query('DELETE FROM smart_products WHERE producto_id = $1', [req.params.id]);
        categoryCache = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/stats', async (req, res) => {
    try {
        const [prods, clicsHoy, topClick, totalConversiones] = await Promise.all([
            db.query('SELECT COUNT(*) FROM articulos'),
            db.query(`SELECT COUNT(*) FROM clics WHERE fecha > NOW() - INTERVAL '24 hours'`),
            db.query('SELECT titulo, clics, conversion_rate FROM articulos ORDER BY conversion_rate DESC, clics DESC LIMIT 1'),
            db.query('SELECT COUNT(*) as total, SUM(commission) as total_commission FROM conversiones WHERE created_at > NOW() - INTERVAL \'30 days\'')
        ]);
        res.json({
            productos: parseInt(prods.rows[0].count),
            clicsHoy: parseInt(clicsHoy.rows[0].count),
            topProducto: topClick.rows[0] || null,
            conversiones_30dias: parseInt(totalConversiones.rows[0].total || 0),
            comision_total: parseFloat(totalConversiones.rows[0].total_commission || 0),
            affiliateTag: AFFILIATE_TAG,
            geminiKeys: geminiKeys.length,
            version: '5.0.0-AGGRESSIVE'
        });
    } catch (e) { res.json({ productos: 0, clicsHoy: 0 }); }
});

app.get('/api/admin/audit', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM audit_log ORDER BY fecha DESC LIMIT 100`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.post('/api/admin/repair-tags', async (req, res) => {
    try {
        const rows = await db.query(`SELECT id, titulo, link FROM articulos`);
        let fixed = 0;
        for (const row of rows.rows) {
            const corrected = addAffiliateTag(row.link);
            const currentTag = new URL(row.link).searchParams.get('tag');
            if (currentTag !== AFFILIATE_TAG) {
                await db.query(`UPDATE articulos SET link = $1 WHERE id = $2`, [corrected, row.id]);
                fixed++;
            }
        }
        res.json({ success: true, fixed, total: rows.rows.length });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/sitemap.xml', async (req, res) => {
    const host = `https://${req.headers.host}`;
    try {
        // Solo productos con conversión o muchos clics
        const r = await db.query(`
            SELECT id, fecha FROM articulos 
            WHERE clics > 0 OR conversion_rate > 0
            ORDER BY conversion_rate DESC, clics DESC 
            LIMIT 500
        `);
        const urls = r.rows.map(p => `<url><loc>${host}/product/${p.id}</loc><lastmod>${new Date(p.fecha).toISOString().split('T')[0]}</lastmod><priority>${p.conversion_rate > 1 ? '0.9' : '0.7'}</priority></url>`).join('');
        res.header('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc><priority>1.0</priority></url>${urls}</urlset>`);
    } catch { res.status(500).send('Error'); }
});

// ============================================================
// CRON JOBS AUTOMÁTICOS (Sistema que aprende solo)
// ============================================================

// Cada 6 horas: Analizar y eliminar productos que no convierten
cron.schedule('0 */6 * * *', async () => {
    console.log('🧹 Auto-cleanup: eliminando productos muertos...');
    try {
        const result = await fetch(`http://localhost:${PORT}/api/cleanup/dead-products`, { method: 'DELETE' });
        const data = await result.json();
        console.log(`✅ Cleanup completado: ${data.deleted} productos eliminados`);
    } catch (e) { console.error('Cleanup error:', e); }
});

// Cada 24 horas: Elegir variantes ganadoras de A/B tests
cron.schedule('0 0 * * *', async () => {
    console.log('📊 A/B Test: calculando ganadores...');
    try {
        const products = await db.query('SELECT id FROM articulos WHERE clics > 50');
        for (const product of products.rows) {
            await fetch(`http://localhost:${PORT}/api/ab-test/decide-winner/${product.id}`, { method: 'POST' });
        }
        console.log(`✅ A/B Test: ${products.rows.length} productos analizados`);
    } catch (e) { console.error('AB Test error:', e); }
});

// Cada 45 minutos: Generar insights (tu función existente)
async function generateInsight() {
    if (!geminiKeys.length) return;
    try {
        const prompt = `Escribe un insight de lujo para mujeres de NYC/Miami/LA. Responde SOLO JSON: {"title":"...","body":"...","keyword":"..."}`;
        const raw = await generateContent(prompt);
        const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        await db.query(`INSERT INTO curiosidades (id, titulo_es, texto_es, imagen, keyword, fecha) VALUES ($1,$2,$3,$4,$5,$6)`,
            [Date.now(), data.title, data.body, `https://images.pexels.com/photos/1643383/pexels-photo-1643383.jpeg`, data.keyword, new Date()]);
        console.log(`✨ Insight: ${data.title}`);
    } catch (e) {}
}

// ============================================================
// FRONTEND (SERVE HTML)
// ============================================================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// START SERVER
// ============================================================
async function start() {
    await initDB();
    console.log(`🚀 MXL GOLD v5.0 AGGRESSIVE | Gemini: ${geminiKeys.length} keys | Tag: ${AFFILIATE_TAG}`);
    console.log(`🔥 Modo: CONVERSIÓN > TRÁFICO`);
    
    if (geminiKeys.length) {
        cron.schedule('*/45 * * * *', () => generateInsight());
        setTimeout(() => generateInsight(), 30000);
    }
    
    app.listen(PORT, '0.0.0.0', () => console.log(`✅ Servidor en puerto ${PORT}`));
}

start();
