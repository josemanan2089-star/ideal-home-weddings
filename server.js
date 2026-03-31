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
// ESTADO GLOBAL
// ============================================================
let dbConnected = false;
let contentAvailable = false;
let salesAvailable = false;
let trafficAvailable = false;
let contentModelName = 'none';
let salesModelName = 'none';
let trafficModelName = 'none';
let contentModel = null;
let salesModel = null;
let trafficModel = null;

// ============================================================
// CONEXIÓN A POSTGRES (CON RECONEXIÓN)
// ============================================================
let pool = null;

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        console.log('⚠️ DATABASE_URL no configurada - usando modo archivos');
        return false;
    }
    
    try {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000
        });
        
        await pool.query('SELECT 1');
        dbConnected = true;
        console.log('✅ Conectado a PostgreSQL');
        
        // Crear tablas si no existen
        await criarTabelas();
        return true;
    } catch (e) {
        console.error('❌ Error conectando a PostgreSQL:', e.message);
        dbConnected = false;
        return false;
    }
}

async function criarTabelas() {
    if (!pool) return;
    
    const queries = [
        `CREATE TABLE IF NOT EXISTS articulos (
            id BIGINT PRIMARY KEY,
            asin VARCHAR(20),
            titulo TEXT NOT NULL,
            meta TEXT,
            intro TEXT,
            curiosidad TEXT,
            contenido TEXT,
            imagen TEXT,
            categoria VARCHAR(50) DEFAULT 'LUXURY',
            link TEXT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            clicks INTEGER DEFAULT 0
        )`,
        `CREATE TABLE IF NOT EXISTS curiosidades (
            id BIGINT PRIMARY KEY,
            titulo_es TEXT,
            titulo_en TEXT,
            texto_es TEXT,
            texto_en TEXT,
            meta_descripcion_en TEXT,
            descripcion_visual_es TEXT,
            descripcion_visual_en TEXT,
            imagen TEXT,
            productoSugerido TEXT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS estadisticas (
            id SERIAL PRIMARY KEY,
            total_clics INTEGER DEFAULT 0,
            clics_por_producto JSONB DEFAULT '{}',
            curiosidades_generadas INTEGER DEFAULT 0,
            productos_publicados INTEGER DEFAULT 0,
            hooks_generados INTEGER DEFAULT 0,
            ultima_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS social_hooks (
            id BIGINT PRIMARY KEY,
            producto_id BIGINT,
            productoTitulo TEXT,
            hooks JSONB,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `INSERT INTO estadisticas (id, total_clics, curiosidades_generadas, productos_publicados, hooks_generados)
         SELECT 1, 0, 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM estadisticas WHERE id = 1)`
    ];
    
    for (const query of queries) {
        try {
            await pool.query(query);
        } catch (e) {
            console.log(`⚠️ Error en query: ${e.message}`);
        }
    }
    console.log('✅ Tablas verificadas');
}

// ============================================================
// MOTORES GEMINI (CON TIMEOUT)
// ============================================================
const MODELOS = ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function initGeminiMotor(apiKey, motor) {
    if (!apiKey || apiKey === '' || apiKey === 'tu_api_key_aqui') {
        console.log(`⚠️ [${motor}] API_KEY no configurada`);
        return { model: null, name: 'none', available: false };
    }
    
    try {
        const genAI = new GoogleGenerativeAI(apiKey.trim());
        
        for (const modelName of MODELOS) {
            try {
                const testModel = genAI.getGenerativeModel({ model: modelName });
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('timeout')), 8000)
                );
                const result = await Promise.race([
                    testModel.generateContent('ping'),
                    timeoutPromise
                ]);
                
                if (result && result.response) {
                    console.log(`✅ [${motor}] ACTIVADO: ${modelName}`);
                    return { model: testModel, name: modelName, available: true };
                }
            } catch (e) {
                console.log(`⚠️ [${motor}] ${modelName} no disponible`);
            }
        }
        return { model: null, name: 'none', available: false };
    } catch (e) {
        console.log(`❌ [${motor}] Error: ${e.message}`);
        return { model: null, name: 'none', available: false };
    }
}

async function initMotors() {
    console.log('\n🔌 Inicializando motores Gemini...');
    
    const contentKey = process.env.GEMINI_API_KEY_CONTENT;
    const contentResult = await initGeminiMotor(contentKey, 'CONTENT');
    contentModel = contentResult.model;
    contentModelName = contentResult.name;
    contentAvailable = contentResult.available;
    
    const salesKey = process.env.GEMINI_API_KEY_SALES;
    const salesResult = await initGeminiMotor(salesKey, 'MASTERMIND');
    salesModel = salesResult.model;
    salesModelName = salesResult.name;
    salesAvailable = salesResult.available;
    
    const trafficKey = process.env.GEMINI_API_KEY_TRAFFIC;
    const trafficResult = await initGeminiMotor(trafficKey, 'TRAFFIC');
    trafficModel = trafficResult.model;
    trafficModelName = trafficResult.name;
    trafficAvailable = trafficResult.available;
    
    console.log(`\n📊 Estado final:`);
    console.log(`   🏭 CONTENT: ${contentAvailable ? '✅' : '⚠️'} (${contentModelName})`);
    console.log(`   🧠 MASTERMIND: ${salesAvailable ? '✅' : '⚠️'} (${salesModelName})`);
    console.log(`   🚀 TRAFFIC: ${trafficAvailable ? '✅' : '⚠️'} (${trafficModelName})`);
}

// ============================================================
// FUNCIONES DE RESPALDO (FALLBACK)
// ============================================================
function getFallbackCopy() {
    return {
        titulo: "The Investment Every NYC Woman Is Making in 2026",
        meta_descripcion: "Discover why high-income women are investing in this exclusive piece. Limited availability.",
        intro: "There's a reason interior designers keep this one detail to themselves.",
        descripcion_visual: "The finish catches light differently. It's a statement of arrival.",
        problema: "Your home whispers when it should speak.",
        solucion: "This piece commands presence. Everything around it looks more considered.",
        beneficio_estatus: "They won't compliment the piece. They'll compliment your taste.",
        prueba_social: "Isabella from Miami: 'My decorator asked where I found it.'",
        cierre: "The women who know, know. Will you be one of them?",
        curiosidad: "Insiders say these pieces appreciate 30% within 18 months.",
        palabras_clave: ["luxury home investment", "what NYC women are buying"]
    };
}

function getFallbackHooks() {
    return {
        pinterest: [
            "✨ The $10M Secret NYC Women Are Whispering About • Save this",
            "🕊️ Luxury isn't loud. It's silent. And she knows where to find it."
        ],
        twitter: [
            "The investment that outperformed her 401k? A piece so exclusive, only 47 women own it.",
            "She doesn't chase trends. She sets them. And this is what's next."
        ]
    };
}

// ============================================================
// ENDPOINTS
// ============================================================

// Healthcheck - CRÍTICO PARA RAILWAY
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        protocol: 'COMMANDER MXL',
        timestamp: new Date().toISOString(),
        database: dbConnected ? 'connected' : 'disconnected',
        content: contentAvailable ? 'active' : 'inactive',
        mastermind: salesAvailable ? 'active' : 'inactive',
        traffic: trafficAvailable ? 'active' : 'inactive',
        uptime: process.uptime()
    });
});

// Endpoint principal de inyección
app.post('/api/commander/inject', async (req, res) => {
    console.log('\n🎯 [COMMANDER] ORDEN RECIBIDA');
    
    try {
        const { url, imagenUrl, categoria } = req.body;
        
        if (!url || !imagenUrl) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL y URL de imagen son requeridas' 
            });
        }
        
        // Generar copy (con o sin Gemini)
        let copy = getFallbackCopy();
        if (salesAvailable && salesModel) {
            try {
                const prompt = `Genera un artículo de venta para producto de lujo. URL: ${url}. Responde SOLO JSON con: titulo, meta_descripcion, intro, descripcion_visual, problema, solucion, beneficio_estatus, prueba_social, cierre, curiosidad, palabras_clave.`;
                const result = await salesModel.generateContent(prompt);
                const text = result.response.text();
                const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                copy = JSON.parse(clean);
            } catch(e) {
                console.log('⚠️ Error generando copy, usando fallback');
            }
        }
        
        // Crear producto
        const producto = {
            id: Date.now(),
            asin: (url.match(/(?:dp|product)\/([A-Z0-9]{10})/i) || [])[1] || null,
            titulo: copy.titulo,
            meta: copy.meta_descripcion,
            intro: copy.intro,
            curiosidad: copy.curiosidad,
            contenido: `<html><body><h1>${copy.titulo}</h1><img src="${imagenUrl}"><p>${copy.intro}</p><a href="${url}">COMPRAR</a></body></html>`,
            imagen: imagenUrl,
            categoria: categoria || 'LUXURY',
            link: url,
            fecha: new Date().toISOString(),
            clicks: 0
        };
        
        // Guardar en BD si está disponible
        if (dbConnected && pool) {
            try {
                await pool.query(
                    `INSERT INTO articulos (id, asin, titulo, meta, intro, curiosidad, contenido, imagen, categoria, link, fecha, clicks)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                     ON CONFLICT (id) DO NOTHING`,
                    [producto.id, producto.asin, producto.titulo, producto.meta, 
                     producto.intro, producto.curiosidad, producto.contenido, 
                     producto.imagen, producto.categoria, producto.link, 
                     producto.fecha, producto.clicks]
                );
                await pool.query(`UPDATE estadisticas SET productos_publicados = productos_publicados + 1 WHERE id = 1`);
            } catch(e) {
                console.log('⚠️ Error guardando en BD:', e.message);
            }
        }
        
        // Generar hooks
        let hooks = getFallbackHooks();
        if (trafficAvailable && trafficModel) {
            try {
                const prompt = `Genera hooks virales para: ${producto.titulo}. Responde SOLO JSON con: pinterest (array de 2), twitter (array de 2)`;
                const result = await trafficModel.generateContent(prompt);
                const text = result.response.text();
                const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                hooks = JSON.parse(clean);
                
                if (dbConnected && pool) {
                    await pool.query(
                        `INSERT INTO social_hooks (id, producto_id, productoTitulo, hooks, fecha)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [Date.now(), producto.id, producto.titulo, JSON.stringify(hooks), new Date().toISOString()]
                    );
                    await pool.query(`UPDATE estadisticas SET hooks_generados = hooks_generados + 1 WHERE id = 1`);
                }
            } catch(e) {
                console.log('⚠️ Error generando hooks, usando fallback');
            }
        }
        
        console.log(`✅ ORDEN COMPLETADA: ${producto.titulo}`);
        
        res.json({
            success: true,
            message: 'Producto procesado exitosamente',
            producto: { id: producto.id, titulo: producto.titulo },
            hooks: hooks
        });
        
    } catch (e) {
        console.error('❌ Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoints de consulta
app.get('/api/productos', async (req, res) => {
    if (!dbConnected || !pool) return res.json([]);
    try {
        const result = await pool.query('SELECT * FROM articulos ORDER BY fecha DESC LIMIT 50');
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/curiosidades', async (req, res) => {
    if (!dbConnected || !pool) return res.json([]);
    try {
        const result = await pool.query('SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT 50');
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/hooks', async (req, res) => {
    if (!dbConnected || !pool) return res.json([]);
    try {
        const result = await pool.query('SELECT * FROM social_hooks ORDER BY fecha DESC LIMIT 20');
        res.json(result.rows);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/estadisticas', async (req, res) => {
    res.json({
        contentDisponible: contentAvailable,
        mastermindDisponible: salesAvailable,
        trafficDisponible: trafficAvailable,
        contentModelo: contentModelName,
        mastermindModelo: salesModelName,
        trafficModelo: trafficModelName,
        dbConnected: dbConnected,
        totalClics: 0,
        curiosidadesGeneradas: 0,
        productosPublicados: 0,
        hooksGenerados: 0
    });
});

app.post('/api/click/:id', async (req, res) => {
    if (dbConnected && pool) {
        try {
            await pool.query('UPDATE articulos SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
            await pool.query('UPDATE estadisticas SET total_clics = total_clics + 1 WHERE id = 1');
        } catch(e) {}
    }
    res.json({ success: true });
});

// Archivos estáticos
app.use(express.static(path.join(__dirname, '/')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// ============================================================
// FUNCIÓN DE CURIOSIDADES (OPCIONAL, NO CRÍTICA)
// ============================================================
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
    
    if (!contentAvailable || !contentModel) return fallback;
    
    try {
        const prompt = `Genera una curiosidad viral de lujo. Responde SOLO JSON con: titulo_es, titulo_en, texto_es, texto_en, meta_descripcion_en, descripcion_visual_es, descripcion_visual_en, productoSugerido`;
        const result = await contentModel.generateContent(prompt);
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(clean);
    } catch (e) {
        return fallback;
    }
}

async function publicarCuriosidad() {
    if (!dbConnected || !pool) return;
    try {
        const g = await generarCuriosidad();
        await pool.query(
            `INSERT INTO curiosidades (id, titulo_es, titulo_en, texto_es, texto_en, meta_descripcion_en, descripcion_visual_es, descripcion_visual_en, imagen, productoSugerido, fecha)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [Date.now(), g.titulo_es, g.titulo_en, g.texto_es, g.texto_en, 
             g.meta_descripcion_en, g.descripcion_visual_es, g.descripcion_visual_en,
             'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
             g.productoSugerido, new Date().toISOString()]
        );
        await pool.query(`UPDATE estadisticas SET curiosidades_generadas = curiosidades_generadas + 1 WHERE id = 1`);
        console.log('✅ Curiosidad publicada');
    } catch (e) {
        console.log('⚠️ Error publicando curiosidad:', e.message);
    }
}

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
async function startServer() {
    console.log('\n🚀 INICIANDO COMMANDER MXL...\n');
    
    // Inicializar base de datos (no bloqueante)
    await initDatabase();
    
    // Inicializar motores Gemini (no bloqueante)
    await initMotors();
    
    // Configurar CRON (cada 3 horas)
    cron.schedule('0 */3 * * *', async () => {
        console.log('⏰ [CRON] Generando curiosidad...');
        await publicarCuriosidad();
    });
    
    // Iniciar servidor
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎖️ COMMANDER MXL - SERVIDOR ACTIVO`);
        console.log(`${'='.repeat(60)}`);
        console.log(`📍 Puerto: ${PORT}`);
        console.log(`🗄️ Base de datos: ${dbConnected ? '✅ Conectada' : '⚠️ No disponible (modo archivos)'}`);
        console.log(`🏭 CONTENT: ${contentAvailable ? '✅ Activo' : '⚠️ Inactivo'}`);
        console.log(`🧠 MASTERMIND: ${salesAvailable ? '✅ Activo' : '⚠️ Inactivo'}`);
        console.log(`🚀 TRAFFIC: ${trafficAvailable ? '✅ Activo' : '⚠️ Inactivo'}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`\n💡 Endpoints:`);
        console.log(`   GET  /health - Estado del servicio`);
        console.log(`   POST /api/commander/inject - Inyectar producto`);
        console.log(`   GET  /panel - Panel de control`);
        console.log(`${'='.repeat(60)}\n`);
    });
}

startServer();
