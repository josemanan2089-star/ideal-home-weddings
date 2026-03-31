const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const compression = require('compression');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middlewares
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// CONFIGURACIÓN POSTGRESQL - CON RECUPERACIÓN AUTOMÁTICA
// ============================================================
let db = null;
let useDatabase = false;
let dbInitialized = false;

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        console.log('📁 DATABASE_URL no configurada, usando JSON fallback');
        return false;
    }
    
    try {
        db = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });
        
        // Test conexión
        await db.query('SELECT NOW()');
        console.log('✅ PostgreSQL conectado');
        
        // Crear tablas si no existen
        await db.query(`
            CREATE TABLE IF NOT EXISTS productos (
                id BIGINT PRIMARY KEY,
                asin VARCHAR(20),
                titulo TEXT NOT NULL,
                meta TEXT,
                intro TEXT,
                curiosidad TEXT,
                contenido TEXT,
                imagen TEXT,
                categoria VARCHAR(100),
                link TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                clicks INTEGER DEFAULT 0
            );
            
            CREATE TABLE IF NOT EXISTS curiosidades (
                id BIGINT PRIMARY KEY,
                titulo_es TEXT,
                titulo_en TEXT,
                texto_es TEXT,
                texto_en TEXT,
                meta_descripcion_en TEXT,
                descripcion_visual_es TEXT,
                descripcion_visual_en TEXT,
                imagen TEXT,
                imagen_fuente TEXT,
                productoSugerido TEXT,
                angulo_usado VARCHAR(1),
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS social_hooks (
                id BIGINT PRIMARY KEY,
                producto_id BIGINT,
                producto_titulo TEXT,
                hooks JSONB,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS estadisticas (
                clave VARCHAR(50) PRIMARY KEY,
                valor JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Insertar estadísticas si no existen
        const statsCheck = await db.query(`SELECT * FROM estadisticas WHERE clave = 'global'`);
        if (statsCheck.rows.length === 0) {
            await db.query(`
                INSERT INTO estadisticas (clave, valor) VALUES ($1, $2)
            `, ['global', JSON.stringify({
                totalClics: 0,
                clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
                curiosidadesGeneradas: 0,
                productosPublicados: 0,
                hooksGenerados: 0,
                ultimaActualizacion: new Date().toISOString()
            })]);
            console.log('📊 Estadísticas inicializadas');
        }
        
        // Crear índices
        await db.query(`CREATE INDEX IF NOT EXISTS idx_productos_fecha ON productos(fecha DESC)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_curiosidades_fecha ON curiosidades(fecha DESC)`);
        
        console.log('✅ Tablas PostgreSQL listas');
        useDatabase = true;
        dbInitialized = true;
        return true;
        
    } catch (err) {
        console.error('❌ Error PostgreSQL:', err.message);
        useDatabase = false;
        return false;
    }
}

// ============================================================
// FUNCIONES DE ALMACENAMIENTO CON FALLBACK AUTOMÁTICO
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const ESTADISTICAS_PATH = path.join(DATA_DIR, 'estadisticas.json');
const SOCIAL_HOOKS_PATH = path.join(DATA_DIR, 'social_hooks.json');

// Crear directorio JSON si no existe
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const initJsonFile = (filePath, defaultData) => {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
    }
};
initJsonFile(ARTICULOS_PATH, []);
initJsonFile(CURIOSIDADES_PATH, []);
initJsonFile(ESTADISTICAS_PATH, {
    totalClics: 0, clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
    curiosidadesGeneradas: 0, productosPublicados: 0, hooksGenerados: 0,
    ultimaActualizacion: new Date().toISOString()
});
initJsonFile(SOCIAL_HOOKS_PATH, []);

// Guardar producto
async function guardarProducto(producto) {
    if (useDatabase && db) {
        try {
            await db.query(`
                INSERT INTO productos (id, asin, titulo, meta, intro, curiosidad, contenido, imagen, categoria, link, clicks, fecha)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO UPDATE SET
                titulo = EXCLUDED.titulo, meta = EXCLUDED.meta, intro = EXCLUDED.intro,
                curiosidad = EXCLUDED.curiosidad, contenido = EXCLUDED.contenido,
                clicks = productos.clicks + 1
            `, [producto.id, producto.asin, producto.titulo, producto.meta, producto.intro,
                producto.curiosidad, producto.contenido, producto.imagen, producto.categoria,
                producto.link, producto.clicks || 0, producto.fecha]);
            
            await db.query(`
                UPDATE estadisticas SET valor = jsonb_set(valor, '{productosPublicados}', 
                ((valor->>'productosPublicados')::int + 1)::text::jsonb)
                WHERE clave = 'global'
            `);
            console.log('✅ Guardado en PostgreSQL');
            return true;
        } catch (err) {
            console.error('❌ DB Error:', err.message);
        }
    }
    
    // Fallback JSON
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(producto);
        if (data.length > 100) data.pop();
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.productosPublicados++;
        stats.ultimaActualizacion = new Date().toISOString();
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        console.log('✅ Guardado en JSON fallback');
        return true;
    } catch (err) {
        console.error('❌ JSON Error:', err.message);
        return false;
    }
}

// Obtener productos (CRÍTICO para frontend)
async function obtenerProductos(limit = 100) {
    if (useDatabase && db) {
        try {
            const result = await db.query(
                `SELECT * FROM productos ORDER BY fecha DESC LIMIT $1`,
                [limit]
            );
            console.log(`📦 PostgreSQL: ${result.rows.length} productos`);
            return result.rows;
        } catch (err) {
            console.error('❌ DB Error:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        console.log(`📁 JSON fallback: ${data.length} productos`);
        return data;
    } catch {
        return [];
    }
}

async function obtenerEstadisticas() {
    if (useDatabase && db) {
        try {
            const result = await db.query(
                `SELECT valor FROM estadisticas WHERE clave = 'global'`
            );
            if (result.rows.length > 0) {
                const stats = result.rows[0].valor;
                const productos = await obtenerProductos(1);
                return { ...stats, productosActivos: productos.length };
            }
        } catch (err) {
            console.error('❌ DB Error:', err.message);
        }
    }
    
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        const productos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        return { ...stats, productosActivos: productos.length };
    } catch {
        return { totalClics: 0, productosPublicados: 0, productosActivos: 0 };
    }
}

// Guardar curiosidad
async function guardarCuriosidad(curiosidad) {
    if (useDatabase && db) {
        try {
            await db.query(`
                INSERT INTO curiosidades (id, titulo_es, titulo_en, texto_es, texto_en, 
                meta_descripcion_en, descripcion_visual_es, descripcion_visual_en, 
                imagen, imagen_fuente, productoSugerido, angulo_usado, fecha)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            `, [curiosidad.id, curiosidad.titulo_es, curiosidad.titulo_en, curiosidad.texto_es,
                curiosidad.texto_en, curiosidad.meta_descripcion_en, curiosidad.descripcion_visual_es,
                curiosidad.descripcion_visual_en, curiosidad.imagen, curiosidad.imagenFuente,
                curiosidad.productoSugerido, curiosidad.anguloUsado, curiosidad.fecha]);
            
            await db.query(`
                UPDATE estadisticas SET valor = jsonb_set(valor, '{curiosidadesGeneradas}', 
                ((valor->>'curiosidadesGeneradas')::int + 1)::text::jsonb)
                WHERE clave = 'global'
            `);
            return true;
        } catch (err) {
            console.error('❌ DB Error:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(curiosidad);
        if (data.length > 50) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.curiosidadesGeneradas++;
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        return true;
    } catch (err) {
        return false;
    }
}

async function guardarHooks(producto, hooks) {
    const registro = {
        id: Date.now(),
        productoId: producto.id,
        productoTitulo: producto.titulo,
        hooks: hooks,
        fecha: new Date().toISOString()
    };
    
    if (useDatabase && db) {
        try {
            await db.query(`
                INSERT INTO social_hooks (id, producto_id, producto_titulo, hooks, fecha)
                VALUES ($1, $2, $3, $4, $5)
            `, [registro.id, producto.id, producto.titulo, JSON.stringify(hooks), registro.fecha]);
            
            const total = (hooks.pinterest?.length || 0) + (hooks.twitter?.length || 0) +
                         (hooks.instagram?.length || 0) + (hooks.facebook?.length || 0);
            
            await db.query(`
                UPDATE estadisticas SET valor = jsonb_set(valor, '{hooksGenerados}', 
                ((valor->>'hooksGenerados')::int + $1)::text::jsonb)
                WHERE clave = 'global'
            `, [total]);
            return true;
        } catch (err) {
            console.error('❌ DB Error:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
        data.unshift(registro);
        if (data.length > 100) data.pop();
        fs.writeFileSync(SOCIAL_HOOKS_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        return false;
    }
}

async function registrarClick(productoId) {
    if (useDatabase && db) {
        try {
            await db.query(`UPDATE productos SET clicks = clicks + 1 WHERE id = $1`, [productoId]);
            await db.query(`
                UPDATE estadisticas SET valor = jsonb_set(valor, '{totalClics}', 
                ((valor->>'totalClics')::int + 1)::text::jsonb)
                WHERE clave = 'global'
            `);
            return true;
        } catch (err) {
            console.error('❌ DB Error:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const idx = data.findIndex(p => p.id == productoId);
        if (idx !== -1) {
            data[idx].clicks = (data[idx].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        }
        return true;
    } catch {
        return false;
    }
}

// ============================================================
// ESTADO DE MOTORES GEMINI
// ============================================================
let sistemaListo = false;
let inicializando = true;
let isContentAvailable = false, isSalesAvailable = false, isTrafficAvailable = false;
let contentModel = null, salesModel = null, trafficModel = null;
let contentModelName = 'pending', salesModelName = 'pending', trafficModelName = 'pending';

const MODELOS_PRIORIDAD = ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function initGeminiMotor(apiKey, motor) {
    if (!apiKey || apiKey === 'tu_api_key_aqui') {
        console.log(`⚠️ [${motor}] Sin API_KEY`);
        return { model: null, modelName: 'none', available: false };
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey.trim());
        for (const modelName of MODELOS_PRIORIDAD) {
            try {
                const testModel = genAI.getGenerativeModel({ model: modelName });
                await Promise.race([
                    testModel.generateContent('ping'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
                ]);
                console.log(`✅ [${motor}] ACTIVADO: ${modelName}`);
                return { model: testModel, modelName, available: true };
            } catch (e) {
                console.log(`⚠️ [${motor}] ${modelName} no disponible`);
            }
        }
        return { model: null, modelName: 'none', available: false };
    } catch (e) {
        return { model: null, modelName: 'none', available: false };
    }
}

// ============================================================
// ÁNGULOS DE VENTA
// ============================================================
let anguloVentaActual = 'A';
const angulosPrompt = {
    'A': 'Ángulo ESTATUS: exclusividad, lujo silencioso',
    'B': 'Ángulo FOMO: escasez y urgencia',
    'C': 'Ángulo BIO-HACKING: optimización humana',
    'D': 'Ángulo INVERSIÓN: valor patrimonial'
};

const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026", kw_en: "best luxury smart home gadgets 2026" },
    { tema: "home wellness spa bathroom luxury", kw_en: "luxury home spa bathroom ideas" }
];

const imagenesRespaldo = [
    'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
    'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg'
];

function extraerASIN(url) {
    if (!url) return null;
    const match = url.match(/(?:dp|product)\/([A-Z0-9]{10})/i);
    return match ? match[1] : null;
}

function getFallbackCopy() {
    return {
        titulo: "The Investment Every NYC Woman Is Making in 2026",
        meta_descripcion: "Discover why high-income women are investing in this exclusive piece.",
        intro: "There's a reason interior designers keep this secret.",
        descripcion_visual: "The finish catches light differently.",
        problema: "Your home whispers when it should speak.",
        solucion: "This piece commands presence.",
        beneficio_estatus: "They'll compliment your taste.",
        prueba_social: "Isabella from Miami: 'My decorator asked where I found it.'",
        cierre: "Will you be one of them before it sells out?",
        curiosidad: "These pieces appreciate 30% within 18 months.",
        palabras_clave: ["luxury home investment"]
    };
}

function getFallbackHooks() {
    return {
        pinterest: ["✨ The $10M Secret NYC Women Are Whispering About"],
        twitter: ["The investment that outperformed her 401k"],
        instagram: ["The quiet luxury piece designers keep secret"],
        facebook: ["Women in NYC are investing in something unexpected"]
    };
}

async function generarArticuloCompleto(url, imagenUrl, categoria) {
    if (!isSalesAvailable || !salesModel) return getFallbackCopy();
    
    try {
        const prompt = `Genera un artículo de venta para producto de lujo. URL: ${url}
        Ángulo: ${angulosPrompt[anguloVentaActual]}
        Responde SOLO con JSON: {"titulo":"...","meta_descripcion":"...","intro":"...","descripcion_visual":"...","problema":"...","solucion":"...","beneficio_estatus":"...","prueba_social":"...","cierre":"...","curiosidad":"...","palabras_clave":[...]}`;
        
        const result = await Promise.race([
            salesModel.generateContent(prompt),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 25000))
        ]);
        
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        return { ...getFallbackCopy(), ...data };
    } catch (e) {
        return getFallbackCopy();
    }
}

async function generarHooksParaProducto(producto) {
    if (!isTrafficAvailable || !trafficModel) return getFallbackHooks();
    
    try {
        const prompt = `Genera hooks virales. Producto: ${producto.titulo}
        Responde SOLO con JSON: {"pinterest":[...],"twitter":[...],"instagram":[...],"facebook":[...]}`;
        
        const result = await Promise.race([
            trafficModel.generateContent(prompt),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 25000))
        ]);
        
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        return getFallbackHooks();
    }
}

async function generarCuriosidadConGemini() {
    if (!isContentAvailable || !contentModel) {
        return {
            titulo_es: "El 75% de mujeres en NYC ya conoce este secreto",
            titulo_en: "Best luxury home products 2026",
            texto_es: "Descubre por qué las mujeres de Manhattan invierten en esto",
            texto_en: "Discover why Manhattan women are investing",
            productoSugerido: "luxury home decor"
        };
    }
    
    try {
        const tema = TEMAS_SEO[Math.floor(Date.now() / 3600000) % TEMAS_SEO.length];
        const prompt = `Genera curiosidad viral. Tema: ${tema.tema}
        Responde SOLO con JSON: {"titulo_es":"...","titulo_en":"...","texto_es":"...","texto_en":"...","productoSugerido":"..."}`;
        
        const result = await Promise.race([
            contentModel.generateContent(prompt),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
        ]);
        
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        return {
            titulo_es: "Secretos del lujo silencioso",
            titulo_en: "Silent luxury secrets",
            texto_es: "Lo que las mujeres adineradas no cuentan",
            texto_en: "What wealthy women don't tell",
            productoSugerido: "luxury decor"
        };
    }
}

function generarHTMLArticulo(url, imagenUrl, categoria, copy) {
    return `<!DOCTYPE html>
<html><head><title>${copy.titulo}</title>
<meta name="description" content="${copy.meta_descripcion}">
<meta property="og:image" content="${imagenUrl}">
<style>
body{font-family:system-ui;background:#fffaf7;}
.hero{background:linear-gradient(135deg,#1a1a2e,#2d2d44);padding:60px 20px;text-align:center;}
.hero h1{color:#fff;}
.btn-buy{display:block;background:#ff4500;color:#fff;padding:16px;text-align:center;border-radius:50px;margin:30px 0;}
</style></head>
<body><div class="hero"><h1>${copy.titulo}</h1></div>
<div style="max-width:800px;margin:0 auto;padding:40px 20px;">
<p>${copy.intro}</p>
<img src="${imagenUrl}" style="max-width:100%;margin:20px 0;">
<p>${copy.descripcion_visual}</p>
<a href="${url}" class="btn-buy">🔴 VER PRECIO EN AMAZON →</a>
<p>${copy.cierre}</p>
<footer>© 2026 MXL GOLD MINER</footer>
</div></body></html>`;
}

// ============================================================
// ENDPOINTS API
// ============================================================

app.get('/health', async (req, res) => {
    const productos = await obtenerProductos(1);
    res.json({
        status: 'ok',
        protocol: 'COMMANDER MXL v3.1',
        sistemaListo,
        database: useDatabase ? 'postgresql' : 'json_fallback',
        productosCount: productos.length,
        content: isContentAvailable ? 'active' : 'inactive',
        mastermind: isSalesAvailable ? 'active' : 'inactive',
        traffic: isTrafficAvailable ? 'active' : 'inactive'
    });
});

app.post('/api/commander/inject', async (req, res) => {
    try {
        const { url, imagenUrl, categoria } = req.body;
        if (!url || !imagenUrl) {
            return res.status(400).json({ success: false, error: 'URL e imagen requeridas' });
        }
        
        const copy = await generarArticuloCompleto(url, imagenUrl, categoria);
        const producto = {
            id: Date.now(),
            asin: extraerASIN(url),
            titulo: copy.titulo,
            meta: copy.meta_descripcion,
            intro: copy.intro,
            curiosidad: copy.curiosidad,
            contenido: generarHTMLArticulo(url, imagenUrl, categoria, copy),
            imagen: imagenUrl,
            categoria: categoria || 'LUXURY',
            link: url,
            fecha: new Date().toISOString(),
            clicks: 0
        };
        
        await guardarProducto(producto);
        const hooks = await generarHooksParaProducto(producto);
        await guardarHooks(producto, hooks);
        
        res.json({
            success: true,
            producto: { id: producto.id, titulo: producto.titulo },
            hooks,
            storage: useDatabase ? 'postgresql' : 'json_fallback'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/productos', async (req, res) => {
    const data = await obtenerProductos(parseInt(req.query.limit) || 100);
    res.json(data);
});

app.get('/api/curiosidades', async (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        res.json(data);
    } catch { res.json([]); }
});

app.get('/api/hooks', async (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
        res.json(data);
    } catch { res.json([]); }
});

app.get('/api/estadisticas', async (req, res) => {
    const stats = await obtenerEstadisticas();
    res.json({
        ...stats,
        storage: useDatabase ? 'postgresql' : 'json_fallback',
        contentDisponible: isContentAvailable,
        mastermindDisponible: isSalesAvailable,
        trafficDisponible: isTrafficAvailable
    });
});

app.post('/api/click/:id', async (req, res) => {
    await registrarClick(parseInt(req.params.id));
    res.json({ success: true });
});

app.post('/api/angulo/:angulo', (req, res) => {
    const angulo = req.params.angulo.toUpperCase();
    if (angulosPrompt[angulo]) {
        anguloVentaActual = angulo;
        res.json({ success: true, angulo });
    } else {
        res.status(400).json({ success: false });
    }
});

// Frontend
const indexPath = path.join(__dirname, 'index.html');
if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `<!DOCTYPE html><html><head><title>MXL Commander</title></head><body><h1>MXL Commander API</h1><p>API activa. Usa /api/ endpoints.</p></body></html>`);
}
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(indexPath));
app.get('/panel', (req, res) => res.sendFile(indexPath));

// ============================================================
// INICIO
// ============================================================
async function start() {
    await initDatabase();
    await initGeminiMotors();
    
    cron.schedule('0 */3 * * *', async () => {
        const g = await generarCuriosidadConGemini();
        const img = await (async () => ({ url: imagenesRespaldo[0], fuente: 'respaldo' }))();
        await guardarCuriosidad({
            id: Date.now(),
            titulo_es: g.titulo_es,
            titulo_en: g.titulo_en,
            texto_es: g.texto_es,
            texto_en: g.texto_en,
            imagen: img.url,
            productoSugerido: g.productoSugerido,
            fecha: new Date().toISOString()
        });
    });
    
    sistemaListo = true;
    inicializando = false;
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 MXL Commander v3.1 en puerto ${PORT}`);
        console.log(`🗄️  Storage: ${useDatabase ? 'PostgreSQL ✅' : 'JSON Fallback ⚠️'}`);
        console.log(`🏭 CONTENT: ${isContentAvailable ? '✅' : '⚠️'} | MASTERMIND: ${isSalesAvailable ? '✅' : '⚠️'} | TRAFFIC: ${isTrafficAvailable ? '✅' : '⚠️'}\n`);
    });
}

start();
