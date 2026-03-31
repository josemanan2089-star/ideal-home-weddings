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

// Middlewares
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// CONEXIÓN A POSTGRES (Railway)
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Verificar conexión a Postgres
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Error conectando a Postgres:', err.message);
    } else {
        console.log('✅ Conectado a Postgres en Railway');
        release();
        inicializarBaseDatos();
    }
});

async function inicializarBaseDatos() {
    try {
        // Verificar si hay estadísticas
        const statsCheck = await pool.query('SELECT * FROM estadisticas WHERE id = 1');
        if (statsCheck.rows.length === 0) {
            await pool.query(`
                INSERT INTO estadisticas (id, total_clics, curiosidades_generadas, productos_publicados, hooks_generados)
                VALUES (1, 0, 0, 0, 0)
            `);
            console.log('✅ Estadísticas inicializadas');
        }
        
        // Verificar configuración
        const configCheck = await pool.query("SELECT * FROM configuracion WHERE clave = 'protocolo'");
        if (configCheck.rows.length === 0) {
            await pool.query(`
                INSERT INTO configuracion (clave, valor) VALUES 
                    ('protocolo', 'COMMANDER MXL'),
                    ('version', '3.0.2'),
                    ('angulo_actual', 'A')
            `);
            console.log('✅ Configuración inicializada');
        }
        
        console.log('✅ Base de datos lista');
    } catch (e) {
        console.error('❌ Error inicializando BD:', e.message);
    }
}

// ============================================================
// MOTORES GEMINI
// ============================================================
let contentModel = null;
let salesModel = null;
let trafficModel = null;
let isContentAvailable = false;
let isSalesAvailable = false;
let isTrafficAvailable = false;
let contentModelName = 'none';
let salesModelName = 'none';
let trafficModelName = 'none';

const MODELOS_PRIORIDAD = ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function initGeminiMotor(apiKey, motor) {
    if (!apiKey || apiKey === 'tu_api_key_aqui' || apiKey === '' || apiKey === 'undefined') {
        console.log(`⚠️ [${motor}] API_KEY no configurada`);
        return { model: null, modelName: 'none', available: false };
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey.trim());
        
        for (const modelName of MODELOS_PRIORIDAD) {
            try {
                const testModel = genAI.getGenerativeModel({ model: modelName });
                const result = await Promise.race([
                    testModel.generateContent('ping'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
                ]);
                
                if (result && result.response) {
                    console.log(`✅ [${motor}] ACTIVADO: ${modelName}`);
                    return { model: testModel, modelName: modelName, available: true };
                }
            } catch (e) {
                console.log(`⚠️ [${motor}] ${modelName} no disponible: ${e.message}`);
            }
        }
        
        console.log(`❌ [${motor}] No se pudo activar Gemini`);
        return { model: null, modelName: 'none', available: false };
    } catch (e) {
        console.log(`❌ [${motor}] Error inicializando: ${e.message}`);
        return { model: null, modelName: 'none', available: false };
    }
}

async function initGeminiMotors() {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║   🧠 PROTOCOLO "COMMANDER MXL" - Conectando Motores Gemini      ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');
    
    const contentKey = process.env.GEMINI_API_KEY_CONTENT;
    console.log('🏭 CONTENT:', contentKey ? `${contentKey.substring(0, 15)}...` : 'NO CONFIGURADA');
    const contentResult = await initGeminiMotor(contentKey, 'CONTENT');
    contentModel = contentResult.model;
    contentModelName = contentResult.modelName;
    isContentAvailable = contentResult.available;
    
    const salesKey = process.env.GEMINI_API_KEY_SALES;
    console.log('🧠 MASTERMIND:', salesKey ? `${salesKey.substring(0, 15)}...` : 'NO CONFIGURADA');
    const salesResult = await initGeminiMotor(salesKey, 'MASTERMIND');
    salesModel = salesResult.model;
    salesModelName = salesResult.modelName;
    isSalesAvailable = salesResult.available;
    
    const trafficKey = process.env.GEMINI_API_KEY_TRAFFIC;
    console.log('🚀 TRAFFIC:', trafficKey ? `${trafficKey.substring(0, 15)}...` : 'NO CONFIGURADA');
    const trafficResult = await initGeminiMotor(trafficKey, 'TRAFFIC');
    trafficModel = trafficResult.model;
    trafficModelName = trafficResult.modelName;
    isTrafficAvailable = trafficResult.available;
    
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('📊 ESTADO DE MOTORES:');
    console.log(`   🏭 CONTENT: ${isContentAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${contentModelName})`);
    console.log(`   🧠 MASTERMIND: ${isSalesAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${salesModelName})`);
    console.log(`   🚀 TRAFFIC: ${isTrafficAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${trafficModelName})`);
    console.log('══════════════════════════════════════════════════════════════════\n');
}

// ============================================================
// FUNCIONES CON POSTGRES
// ============================================================

async function guardarProducto(producto) {
    const query = `
        INSERT INTO articulos (id, asin, titulo, meta, intro, curiosidad, contenido, imagen, categoria, link, fecha, clicks)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
            titulo = EXCLUDED.titulo,
            clicks = articulos.clicks + 1
    `;
    await pool.query(query, [
        producto.id, producto.asin, producto.titulo, producto.meta,
        producto.intro, producto.curiosidad, producto.contenido,
        producto.imagen, producto.categoria, producto.link,
        producto.fecha, producto.clicks || 0
    ]);
}

async function guardarCuriosidad(curiosidad) {
    const query = `
        INSERT INTO curiosidades (id, titulo_es, titulo_en, texto_es, texto_en, 
            meta_descripcion_en, descripcion_visual_es, descripcion_visual_en, 
            imagen, productoSugerido, fecha)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;
    await pool.query(query, [
        curiosidad.id, curiosidad.titulo_es, curiosidad.titulo_en,
        curiosidad.texto_es, curiosidad.texto_en,
        curiosidad.meta_descripcion_en, curiosidad.descripcion_visual_es,
        curiosidad.descripcion_visual_en, curiosidad.imagen,
        curiosidad.productoSugerido, curiosidad.fecha
    ]);
}

async function guardarHooks(productoId, productoTitulo, hooks) {
    const query = `
        INSERT INTO social_hooks (id, producto_id, productoTitulo, hooks, fecha)
        VALUES ($1, $2, $3, $4, $5)
    `;
    await pool.query(query, [Date.now(), productoId, productoTitulo, JSON.stringify(hooks), new Date().toISOString()]);
}

async function actualizarEstadisticas(tipo) {
    if (tipo === 'producto') {
        await pool.query(`UPDATE estadisticas SET productos_publicados = productos_publicados + 1, ultima_actualizacion = NOW() WHERE id = 1`);
    } else if (tipo === 'curiosidad') {
        await pool.query(`UPDATE estadisticas SET curiosidades_generadas = curiosidades_generadas + 1, ultima_actualizacion = NOW() WHERE id = 1`);
    } else if (tipo === 'hooks') {
        await pool.query(`UPDATE estadisticas SET hooks_generados = hooks_generados + 1, ultima_actualizacion = NOW() WHERE id = 1`);
    } else if (tipo === 'click') {
        await pool.query(`UPDATE estadisticas SET total_clics = total_clics + 1, ultima_actualizacion = NOW() WHERE id = 1`);
    }
}

// ============================================================
// FUNCIONES DE GENERACIÓN (igual que antes pero con BD)
// ============================================================

const angulosVenta = {
    'A': 'ESTATUS - Lujo Silencioso',
    'B': 'FOMO - Escasez y Urgencia',
    'C': 'INVERSIÓN - Valor patrimonial'
};
let anguloActual = 'A';

const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026", kw_en: "best luxury smart home gadgets 2026" }
];

const imagenesRespaldo = [
    'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg'
];

function extraerASIN(url) {
    if (!url) return null;
    const match = url.match(/(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i);
    return match ? match[1] : null;
}

async function generarArticuloCompleto(url, imagenUrl, categoria) {
    const fallback = {
        titulo: "The Investment Every NYC Woman Is Making in 2026",
        meta_descripcion: "Discover why high-income women are investing in this exclusive piece.",
        intro: "There's a reason interior designers in Beverly Hills keep this one detail to themselves.",
        descripcion_visual: "The finish catches light differently.",
        problema: "Your home whispers when it should speak.",
        solucion: "This piece commands presence.",
        beneficio_estatus: "They'll compliment your taste.",
        prueba_social: "Isabella from Miami: 'My decorator asked where I found it.'",
        cierre: "The women who know, know.",
        curiosidad: "Insiders say these pieces appreciate 30%.",
        palabras_clave: ["luxury home investment"]
    };
    
    if (!isSalesAvailable || !salesModel) {
        console.log('⚠️ [MASTERMIND] No disponible, usando fallback');
        return fallback;
    }
    
    try {
        console.log(`🧠 [MASTERMIND] Generando artículo...`);
        const prompt = `Eres DAVID OGILVY + GARY HALBERT. Genera un artículo de venta para producto de lujo.
URL: ${url}
Categoría: ${categoria}
RESPONDE SOLO CON JSON: {"titulo":"...","meta_descripcion":"...","intro":"...","descripcion_visual":"...","problema":"...","solucion":"...","beneficio_estatus":"...","prueba_social":"...","cierre":"...","curiosidad":"...","palabras_clave":[]}`;
        
        const result = await salesModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        console.log(`⚠️ [MASTERMIND] Error: ${e.message}`);
        return fallback;
    }
}

async function generarHooksParaProducto(producto) {
    const fallbackHooks = {
        pinterest: ["✨ The $10M Secret NYC Women Are Whispering About • Save this"],
        twitter: ["The investment that outperformed her 401k"]
    };
    
    if (!isTrafficAvailable || !trafficModel) {
        console.log('⚠️ [TRAFFIC] No disponible, usando fallback');
        return fallbackHooks;
    }
    
    try {
        console.log(`🚀 [TRAFFIC] Generando hooks...`);
        const prompt = `Genera hooks virales para: ${producto.titulo}
RESPONDE SOLO CON JSON: {"pinterest":["hook1","hook2"],"twitter":["hook1","hook2"]}`;
        
        const result = await trafficModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        console.log(`⚠️ [TRAFFIC] Error: ${e.message}`);
        return fallbackHooks;
    }
}

async function generarCuriosidad() {
    const fallback = {
        titulo_es: "El secreto de lujo que las mujeres de NYC ya conocen",
        titulo_en: "The luxury secret NYC women already know",
        texto_es: "Descubre por qué las mujeres de alto poder adquisitivo están invirtiendo en esto.",
        texto_en: "Discover why high-income women are investing in this.",
        meta_descripcion_en: "Luxury secrets 2026",
        descripcion_visual_es: "Elegancia y estatus en cada detalle.",
        descripcion_visual_en: "Elegance in every detail.",
        productoSugerido: "luxury home product"
    };
    
    if (!isContentAvailable || !contentModel) return fallback;
    
    try {
        const prompt = `Genera una curiosidad viral de lujo. RESPONDE SOLO CON JSON: {"titulo_es":"...","titulo_en":"...","texto_es":"...","texto_en":"...","meta_descripcion_en":"...","descripcion_visual_es":"...","descripcion_visual_en":"...","productoSugerido":"..."}`;
        const result = await contentModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        return fallback;
    }
}

async function publicarCuriosidadAutomatica() {
    console.log('🏭 [CONTENT] Generando curiosidad...');
    try {
        const g = await generarCuriosidad();
        const nueva = {
            id: Date.now(),
            ...g,
            imagen: imagenesRespaldo[0],
            fecha: new Date().toISOString()
        };
        await guardarCuriosidad(nueva);
        await actualizarEstadisticas('curiosidad');
        console.log(`✅ [CONTENT] Publicada: ${nueva.titulo_en}`);
        return nueva;
    } catch (e) {
        console.log('❌ [CONTENT] Error:', e.message);
        return null;
    }
}

function generarHTMLArticulo(url, imagenUrl, copy) {
    return `<!DOCTYPE html><html><head><title>${copy.titulo}</title><meta name="description" content="${copy.meta_descripcion}"></head><body><h1>${copy.titulo}</h1><img src="${imagenUrl}"><p>${copy.intro}</p><a href="${url}">COMPRAR</a></body></html>`;
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', async (req, res) => {
    let dbOk = false;
    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch(e) { dbOk = false; }
    
    res.json({
        status: 'ok',
        protocol: 'COMMANDER MXL',
        database: dbOk ? 'connected' : 'error',
        content: isContentAvailable ? 'active' : 'inactive',
        mastermind: isSalesAvailable ? 'active' : 'inactive',
        traffic: isTrafficAvailable ? 'active' : 'inactive',
        timestamp: new Date().toISOString()
    });
});

app.post('/api/commander/inject', async (req, res) => {
    console.log('\n🎯 [COMMANDER MXL] ORDEN RECIBIDA');
    
    try {
        const { url, imagenUrl, categoria } = req.body;
        
        if (!url || !imagenUrl) {
            return res.status(400).json({ success: false, error: 'URL y imagen requeridas' });
        }
        
        // PASO 1: MASTERMIND genera artículo
        const copy = await generarArticuloCompleto(url, imagenUrl, categoria || 'LUXURY');
        
        // PASO 2: Guardar producto
        const producto = {
            id: Date.now(),
            asin: extraerASIN(url),
            titulo: copy.titulo,
            meta: copy.meta_descripcion,
            intro: copy.intro,
            curiosidad: copy.curiosidad,
            contenido: generarHTMLArticulo(url, imagenUrl, copy),
            imagen: imagenUrl,
            categoria: categoria || 'LUXURY',
            link: url,
            fecha: new Date().toISOString(),
            clicks: 0
        };
        
        await guardarProducto(producto);
        await actualizarEstadisticas('producto');
        
        // PASO 3: TRAFFIC genera hooks
        const hooks = await generarHooksParaProducto(producto);
        await guardarHooks(producto.id, producto.titulo, hooks);
        await actualizarEstadisticas('hooks');
        
        console.log(`✅ ORDEN COMPLETADA: ${producto.titulo}`);
        
        res.json({
            success: true,
            message: 'Orden ejecutada',
            producto: { id: producto.id, titulo: producto.titulo },
            hooks: hooks
        });
        
    } catch (e) {
        console.error('❌ Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/productos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM articulos ORDER BY fecha DESC LIMIT 50');
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/curiosidades', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50');
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/hooks', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM social_hooks ORDER BY fecha DESC LIMIT 20');
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/estadisticas', async (req, res) => {
    try {
        const stats = await pool.query('SELECT * FROM estadisticas WHERE id = 1');
        const productos = await pool.query('SELECT COUNT(*) FROM articulos');
        const curiosidades = await pool.query('SELECT COUNT(*) FROM curiosidades');
        
        res.json({
            total_clics: stats.rows[0]?.total_clics || 0,
            curiosidades_generadas: stats.rows[0]?.curiosidades_generadas || 0,
            productos_publicados: stats.rows[0]?.productos_publicados || 0,
            hooks_generados: stats.rows[0]?.hooks_generados || 0,
            productos_activos: parseInt(productos.rows[0]?.count || 0),
            curiosidades_activas: parseInt(curiosidades.rows[0]?.count || 0),
            contentDisponible: isContentAvailable,
            mastermindDisponible: isSalesAvailable,
            trafficDisponible: isTrafficAvailable,
            contentModelo: contentModelName,
            mastermindModelo: salesModelName,
            trafficModelo: trafficModelName
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.post('/api/click/:id', async (req, res) => {
    try {
        await pool.query('UPDATE articulos SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
        await actualizarEstadisticas('click');
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.use(express.static(path.join(__dirname, '/')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// CRON cada 3 horas
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ [CRON] CONTENT generando curiosidad...');
    await publicarCuriosidadAutomatica();
});

// INICIO
const startServer = async () => {
    await initGeminiMotors();
    
    // Verificar si hay curiosidades
    const curResult = await pool.query('SELECT COUNT(*) FROM curiosidades');
    if (parseInt(curResult.rows[0]?.count || 0) === 0) {
        setTimeout(() => publicarCuriosidadAutomatica(), 5000);
    }
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 COMMANDER MXL en puerto ${PORT}`);
        console.log(`   📊 BD: ${process.env.DATABASE_URL ? 'configurada' : 'NO CONFIGURADA'}`);
        console.log(`   🏭 CONTENT: ${isContentAvailable ? '✅' : '⚠️'}`);
        console.log(`   🧠 MASTERMIND: ${isSalesAvailable ? '✅' : '⚠️'}`);
        console.log(`   🚀 TRAFFIC: ${isTrafficAvailable ? '✅' : '⚠️'}\n`);
    });
};

startServer();
