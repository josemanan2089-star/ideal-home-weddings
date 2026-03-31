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

// Middlewares básicos
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// CONFIGURACIÓN DE BASE DE DATOS - CONEXIÓN PERSISTENTE
// ============================================================
let db = null;
let useDatabase = false;
let dbConnected = false;
let dbConnectionAttempts = 0;
const MAX_DB_ATTEMPTS = 3;

// Función para conectar a PostgreSQL con reintentos
async function connectToDatabase() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
        console.log('📁 No se encontró DATABASE_URL, usando almacenamiento JSON local');
        useDatabase = false;
        return false;
    }
    
    try {
        db = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
            keepAlive: true,
        });
        
        // Probar conexión
        const client = await db.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        
        console.log(`✅ PostgreSQL conectado exitosamente: ${result.rows[0].now}`);
        useDatabase = true;
        dbConnected = true;
        
        // Verificar tablas existentes (creadas manualmente por mxl)
        const tablesCheck = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name IN ('productos', 'curiosidades', 'social_hooks', 'estadisticas')
        `);
        
        console.log(`📊 Tablas encontradas: ${tablesCheck.rows.map(r => r.table_name).join(', ') || 'NINGUNA'}`);
        
        if (tablesCheck.rows.length === 0) {
            console.log('⚠️ No se encontraron tablas. Creando estructura...');
            await createTablesIfNotExist();
        }
        
        return true;
    } catch (err) {
        console.error('❌ Error conectando a PostgreSQL:', err.message);
        useDatabase = false;
        dbConnected = false;
        
        if (dbConnectionAttempts < MAX_DB_ATTEMPTS) {
            dbConnectionAttempts++;
            console.log(`🔄 Reintentando conexión en 5 segundos... (Intento ${dbConnectionAttempts}/${MAX_DB_ATTEMPTS})`);
            setTimeout(() => connectToDatabase(), 5000);
        } else {
            console.log('📁 Usando almacenamiento JSON como fallback definitivo');
        }
        return false;
    }
}

// Crear tablas si no existen (estructura compatible con mxl)
async function createTablesIfNotExist() {
    if (!db) return false;
    
    try {
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
                valor JSONB,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_productos_fecha ON productos(fecha DESC);
            CREATE INDEX IF NOT EXISTS idx_curiosidades_fecha ON curiosidades(fecha DESC);
            CREATE INDEX IF NOT EXISTS idx_hooks_producto ON social_hooks(producto_id);
        `);
        
        // Inicializar estadísticas
        const statsCheck = await db.query(`SELECT * FROM estadisticas WHERE clave = 'global'`);
        if (statsCheck.rows.length === 0) {
            const statsDefault = {
                totalClics: 0,
                clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
                curiosidadesGeneradas: 0,
                productosPublicados: 0,
                hooksGenerados: 0,
                ultimaActualizacion: new Date().toISOString()
            };
            await db.query(
                `INSERT INTO estadisticas (clave, valor) VALUES ($1, $2)`,
                ['global', statsDefault]
            );
            console.log('📊 Estadísticas inicializadas');
        }
        
        console.log('✅ Tablas creadas/verificadas correctamente');
        return true;
    } catch (err) {
        console.error('❌ Error creando tablas:', err.message);
        return false;
    }
}

// ============================================================
// DIRECTORIOS PERSISTENTES (FALLBACK JSON)
// ============================================================
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH && process.env.RAILWAY_VOLUME_MOUNT_PATH.trim() !== ''
    ? process.env.RAILWAY_VOLUME_MOUNT_PATH
    : null;

const DATA_DIR = VOLUME_PATH
    ? path.join(VOLUME_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const ESTADISTICAS_PATH = path.join(DATA_DIR, 'estadisticas.json');
const SOCIAL_HOOKS_PATH = path.join(DATA_DIR, 'social_hooks.json');

// Crear archivos JSON de fallback
const initJsonFiles = () => {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`📁 Directorio JSON creado: ${DATA_DIR}`);
    }
    
    const initFile = (filePath, defaultData) => {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
        }
    };
    
    initFile(ARTICULOS_PATH, []);
    initFile(CURIOSIDADES_PATH, []);
    initFile(ESTADISTICAS_PATH, {
        totalClics: 0,
        clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
        curiosidadesGeneradas: 0,
        productosPublicados: 0,
        hooksGenerados: 0,
        ultimaActualizacion: new Date().toISOString()
    });
    initFile(SOCIAL_HOOKS_PATH, []);
};

initJsonFiles();

// ============================================================
// FUNCIONES DE ALMACENAMIENTO (Prioridad PostgreSQL)
// ============================================================

// Guardar producto (prioridad DB)
async function guardarProducto(producto) {
    console.log(`💾 Guardando producto: ${producto.titulo.substring(0, 50)}...`);
    
    if (useDatabase && db) {
        try {
            await db.query(
                `INSERT INTO productos (id, asin, titulo, meta, intro, curiosidad, contenido, imagen, categoria, link, clicks, fecha)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (id) DO UPDATE SET
                 titulo = EXCLUDED.titulo,
                 meta = EXCLUDED.meta,
                 intro = EXCLUDED.intro,
                 curiosidad = EXCLUDED.curiosidad,
                 contenido = EXCLUDED.contenido,
                 imagen = EXCLUDED.imagen,
                 clicks = productos.clicks + 1`,
                [
                    producto.id, producto.asin, producto.titulo, producto.meta,
                    producto.intro, producto.curiosidad, producto.contenido,
                    producto.imagen, producto.categoria, producto.link,
                    producto.clicks || 0, producto.fecha
                ]
            );
            
            await db.query(
                `UPDATE estadisticas 
                 SET valor = jsonb_set(valor, '{productosPublicados}', ((valor->>'productosPublicados')::int + 1)::text::jsonb),
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE clave = 'global'`
            );
            
            console.log('✅ Producto guardado en PostgreSQL');
            return true;
        } catch (err) {
            console.error('❌ DB Error guardando producto:', err.message);
        }
    }
    
    // Fallback a JSON
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(producto);
        if (data.length > 100) data.pop();
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.productosPublicados++;
        stats.ultimaActualizacion = new Date().toISOString();
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        
        console.log('✅ Producto guardado en JSON (fallback)');
        return true;
    } catch (err) {
        console.error('❌ Error guardando en JSON:', err.message);
        return false;
    }
}

// Guardar curiosidad
async function guardarCuriosidad(curiosidad) {
    if (useDatabase && db) {
        try {
            await db.query(
                `INSERT INTO curiosidades (id, titulo_es, titulo_en, texto_es, texto_en, 
                  meta_descripcion_en, descripcion_visual_es, descripcion_visual_en, 
                  imagen, imagen_fuente, productoSugerido, angulo_usado, fecha)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    curiosidad.id, curiosidad.titulo_es, curiosidad.titulo_en,
                    curiosidad.texto_es, curiosidad.texto_en, curiosidad.meta_descripcion_en,
                    curiosidad.descripcion_visual_es, curiosidad.descripcion_visual_en,
                    curiosidad.imagen, curiosidad.imagenFuente, curiosidad.productoSugerido,
                    curiosidad.anguloUsado, curiosidad.fecha
                ]
            );
            
            await db.query(
                `UPDATE estadisticas 
                 SET valor = jsonb_set(valor, '{curiosidadesGeneradas}', ((valor->>'curiosidadesGeneradas')::int + 1)::text::jsonb),
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE clave = 'global'`
            );
            return true;
        } catch (err) {
            console.error('❌ DB Error guardando curiosidad:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(curiosidad);
        if (data.length > 50) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.curiosidadesGeneradas++;
        stats.ultimaActualizacion = new Date().toISOString();
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        return true;
    } catch (err) {
        console.error('❌ Error guardando curiosidad en JSON:', err.message);
        return false;
    }
}

// Guardar hooks
async function guardarHooks(producto, hooks) {
    const registro = {
        id: Date.now(),
        productoId: producto.id,
        productoTitulo: producto.titulo,
        fecha: new Date().toISOString(),
        hooks: hooks
    };
    
    if (useDatabase && db) {
        try {
            await db.query(
                `INSERT INTO social_hooks (id, producto_id, producto_titulo, hooks, fecha)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO NOTHING`,
                [registro.id, producto.id, producto.titulo, JSON.stringify(hooks), registro.fecha]
            );
            
            const totalHooks = (hooks.pinterest?.length || 0) + 
                              (hooks.twitter?.length || 0) +
                              (hooks.instagram?.length || 0) +
                              (hooks.facebook?.length || 0);
            
            await db.query(
                `UPDATE estadisticas 
                 SET valor = jsonb_set(valor, '{hooksGenerados}', ((valor->>'hooksGenerados')::int + $1)::text::jsonb),
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE clave = 'global'`,
                [totalHooks]
            );
            return true;
        } catch (err) {
            console.error('❌ DB Error guardando hooks:', err.message);
        }
    }
    
    try {
        const historial = JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
        historial.unshift(registro);
        if (historial.length > 100) historial.pop();
        fs.writeFileSync(SOCIAL_HOOKS_PATH, JSON.stringify(historial, null, 2));
        
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        stats.hooksGenerados = (stats.hooksGenerados || 0) + 
            (hooks.pinterest?.length || 0) + 
            (hooks.twitter?.length || 0) +
            (hooks.instagram?.length || 0) +
            (hooks.facebook?.length || 0);
        fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        return true;
    } catch (err) {
        console.error('❌ Error guardando hooks en JSON:', err.message);
        return false;
    }
}

// OBTENER PRODUCTOS (CRÍTICO PARA EL FRONTEND)
async function obtenerProductos(limit = 100) {
    console.log(`📋 Obteniendo productos (límite: ${limit})...`);
    
    if (useDatabase && db) {
        try {
            const result = await db.query(
                `SELECT * FROM productos ORDER BY fecha DESC LIMIT $1`,
                [limit]
            );
            console.log(`✅ Encontrados ${result.rows.length} productos en PostgreSQL`);
            return result.rows;
        } catch (err) {
            console.error('❌ DB Error obteniendo productos:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        console.log(`✅ Encontrados ${data.length} productos en JSON fallback`);
        return data;
    } catch (err) {
        console.error('❌ Error leyendo JSON:', err.message);
        return [];
    }
}

async function obtenerCuriosidades(limit = 50) {
    if (useDatabase && db) {
        try {
            const result = await db.query(
                `SELECT * FROM curiosidades ORDER BY fecha DESC LIMIT $1`,
                [limit]
            );
            return result.rows;
        } catch (err) {
            console.error('❌ DB Error obteniendo curiosidades:', err.message);
        }
    }
    try {
        return JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    } catch {
        return [];
    }
}

async function obtenerHooks(limit = 50) {
    if (useDatabase && db) {
        try {
            const result = await db.query(
                `SELECT * FROM social_hooks ORDER BY fecha DESC LIMIT $1`,
                [limit]
            );
            return result.rows;
        } catch (err) {
            console.error('❌ DB Error obteniendo hooks:', err.message);
        }
    }
    try {
        return JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
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
                const productos = await obtenerProductos(100);
                const curiosidades = await obtenerCuriosidades(100);
                return {
                    ...stats,
                    curiosidadesActivas: curiosidades.length,
                    productosActivos: productos.length
                };
            }
        } catch (err) {
            console.error('❌ DB Error obteniendo estadísticas:', err.message);
        }
    }
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const productos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        return {
            ...stats,
            curiosidadesActivas: curiosidades.length,
            productosActivos: productos.length
        };
    } catch {
        return {
            totalClics: 0,
            clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
            curiosidadesGeneradas: 0,
            productosPublicados: 0,
            hooksGenerados: 0,
            curiosidadesActivas: 0,
            productosActivos: 0
        };
    }
}

async function registrarClick(productoId) {
    if (useDatabase && db) {
        try {
            await db.query(`UPDATE productos SET clicks = clicks + 1 WHERE id = $1`, [productoId]);
            await db.query(
                `UPDATE estadisticas 
                 SET valor = jsonb_set(valor, '{totalClics}', ((valor->>'totalClics')::int + 1)::text::jsonb),
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE clave = 'global'`
            );
            return true;
        } catch (err) {
            console.error('❌ DB Error registrando click:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == productoId);
        if (i !== -1) {
            data[i].clicks = (data[i].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            
            const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
            stats.totalClics++;
            stats.ultimaActualizacion = new Date().toISOString();
            fs.writeFileSync(ESTADISTICAS_PATH, JSON.stringify(stats, null, 2));
        }
        return true;
    } catch (err) {
        console.error('❌ Error registrando click en JSON:', err.message);
        return false;
    }
}

// ============================================================
// ESTADO GLOBAL DEL SISTEMA
// ============================================================
let sistemaListo = false;
let inicializando = true;
let isContentAvailable = false;
let isSalesAvailable = false;
let isTrafficAvailable = false;
let contentModelName = 'pending';
let salesModelName = 'pending';
let trafficModelName = 'pending';
let contentModel = null;
let salesModel = null;
let trafficModel = null;

// ============================================================
// CONFIGURACIÓN DE MOTORES GEMINI
// ============================================================
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
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('timeout')), 8000)
                );
                const result = await Promise.race([
                    testModel.generateContent('ping'),
                    timeoutPromise
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
    console.log('║   🧠 PROTOCOLO "COMMANDER MXL" - Inicializando Motores         ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');
    
    const contentKey = process.env.GEMINI_API_KEY_CONTENT;
    console.log(`🏭 CONTENT: ${contentKey ? `${contentKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const contentResult = await initGeminiMotor(contentKey, 'CONTENT');
    contentModel = contentResult.model;
    contentModelName = contentResult.modelName;
    isContentAvailable = contentResult.available;
    
    const salesKey = process.env.GEMINI_API_KEY_SALES;
    console.log(`🧠 MASTERMIND: ${salesKey ? `${salesKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const salesResult = await initGeminiMotor(salesKey, 'MASTERMIND');
    salesModel = salesResult.model;
    salesModelName = salesResult.modelName;
    isSalesAvailable = salesResult.available;
    
    const trafficKey = process.env.GEMINI_API_KEY_TRAFFIC;
    console.log(`🚀 TRAFFIC: ${trafficKey ? `${trafficKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const trafficResult = await initGeminiMotor(trafficKey, 'TRAFFIC');
    trafficModel = trafficResult.model;
    trafficModelName = trafficResult.modelName;
    isTrafficAvailable = trafficResult.available;
    
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('📊 ESTADO FINAL DE MOTORES:');
    console.log(`   🏭 CONTENT: ${isContentAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${contentModelName})`);
    console.log(`   🧠 MASTERMIND: ${isSalesAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${salesModelName})`);
    console.log(`   🚀 TRAFFIC: ${isTrafficAvailable ? '✅ ACTIVO' : '⚠️ NO DISPONIBLE'} (${trafficModelName})`);
    console.log('══════════════════════════════════════════════════════════════════\n');
}

// ============================================================
// ÁNGULOS DE VENTA
// ============================================================
let anguloVentaActual = 'A';
const angulosPrompt = {
    'A': 'Ángulo ESTATUS: exclusividad, lujo silencioso, "el secreto que no cuentan"',
    'B': 'Ángulo FOMO: escasez, urgencia, "solo quedan pocas unidades"',
    'C': 'Ángulo BIO-HACKING: optimización humana, longevidad, energía',
    'D': 'Ángulo INVERSIÓN: activo que no deprecia, herencia'
};

const TEMAS_SEO = [
    { tema: "luxury smart home gadgets 2026", kw_en: "best luxury smart home gadgets 2026" },
    { tema: "home wellness spa bathroom luxury", kw_en: "luxury home spa bathroom ideas" },
    { tema: "luxury kitchen appliances women NYC", kw_en: "luxury kitchen appliances NYC women" },
    { tema: "minimalist luxury bedroom decor 2026", kw_en: "minimalist luxury bedroom 2026" },
    { tema: "smart home automation Beverly Hills", kw_en: "smart home automation Beverly Hills" }
];

const imagenesRespaldo = [
    'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
    'https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg',
    'https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg',
    'https://images.pexels.com/photos/258154/pexels-photo-258154.jpeg',
    'https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg'
];

async function obtenerImagen(query) {
    const idx = Math.floor(Math.random() * imagenesRespaldo.length);
    return { url: imagenesRespaldo[idx], fuente: 'respaldo', alt: query || 'luxury home' };
}

function extraerASIN(url) {
    if (!url) return null;
    const patterns = [
        /(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i,
        /asin=([A-Z0-9]{10})/i
    ];
    for (const p of patterns) {
        const match = url.match(p);
        if (match && match[1]) return match[1];
    }
    return null;
}

function getFallbackCopy() {
    return {
        titulo: "The Investment Every NYC Woman Is Making in 2026",
        meta_descripcion: "Discover why high-income women from Manhattan to Miami are investing in this exclusive piece.",
        intro: "There's a reason interior designers in Beverly Hills keep this one detail to themselves.",
        descripcion_visual: "The finish catches light differently. It's not just design—it's a statement of arrival.",
        problema: "Your home whispers when it should speak.",
        solucion: "This piece doesn't just fill space—it commands presence.",
        beneficio_estatus: "When guests walk in, they won't compliment the piece. They'll compliment your taste.",
        prueba_social: "Isabella from Miami: 'My decorator asked where I found it. I told her it's our little secret.'",
        cierre: "The women who know, know. Will you be one of them before the next shipment sells out?",
        curiosidad: "Insiders say these pieces appreciate 30% within 18 months.",
        palabras_clave: ["luxury home investment 2026", "what NYC women are buying"]
    };
}

function getFallbackHooks() {
    return {
        pinterest: [
            "✨ The $10M Secret NYC Women Are Whispering About • Save this before it's gone",
            "🕊️ Luxury isn't loud. It's silent. And she knows exactly where to find it.",
            "📌 Pinning this for later? So are 10,000 other women who know the secret."
        ],
        twitter: [
            "The investment that outperformed her 401k? A piece so exclusive, only 47 women own it in Manhattan.",
            "She doesn't chase trends. She sets them. And this is what's next.",
            "Miami women have a rule: If more than 5 people know about it, it's no longer luxury."
        ],
        instagram: [
            "The quiet luxury piece that interior designers in Beverly Hills keep to themselves. 🕊️ #LuxuryHome",
            "Your home whispers when it should speak. Let's fix that. ✨",
            "Not everything needs to be seen to be understood. But this? She'll notice. 🎯"
        ],
        facebook: [
            "Women in NYC are investing in something unexpected this year. Here's why.",
            "The one thing she bought that her decorator asked about 3 times.",
            "Is your home a conversation starter or a conversation ender?"
        ]
    };
}

// ============================================================
// MASTERMIND - Generar artículo completo
// ============================================================
async function generarArticuloCompleto(url, imagenUrl, categoria) {
    const fallback = getFallbackCopy();
    
    if (!isSalesAvailable || !salesModel) {
        console.log('⚠️ [MASTERMIND] No disponible, usando fallback');
        return fallback;
    }
    
    try {
        console.log(`\n🧠 [MASTERMIND] Generando artículo...`);
        
        const prompt = `Eres DAVID OGILVY + GARY HALBERT. Genera un artículo de venta para un producto de lujo.

URL: ${url}
Categoría: ${categoria || 'LUXURY'}
Ángulo: ${angulosPrompt[anguloVentaActual]}

RESPONDE SOLO CON JSON (sin markdown):
{
    "titulo": "Título que detiene el scroll (max 60 chars)",
    "meta_descripcion": "Meta description 155 chars",
    "intro": "Gancho psicológico 1 frase",
    "descripcion_visual": "Descripción sensorial del producto",
    "problema": "El deseo inconsciente que satisface (1 frase)",
    "solucion": "Cómo lo resuelve (1 frase)",
    "beneficio_estatus": "Beneficio de estatus (1 frase)",
    "prueba_social": "Testimonio de mujer adinerada con nombre y ubicación",
    "cierre": "CTA con urgencia y exclusividad",
    "curiosidad": "Dato exclusivo que crea FOMO",
    "palabras_clave": ["keyword1", "keyword2", "keyword3"]
}`;
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout after 25s')), 25000)
        );
        
        const result = await Promise.race([
            salesModel.generateContent(prompt),
            timeoutPromise
        ]);
        
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        
        console.log(`✅ [MASTERMIND] Artículo generado: ${data.titulo}`);
        
        return {
            titulo: data.titulo || fallback.titulo,
            meta_descripcion: data.meta_descripcion || fallback.meta_descripcion,
            intro: data.intro || fallback.intro,
            descripcion_visual: data.descripcion_visual || fallback.descripcion_visual,
            problema: data.problema || fallback.problema,
            solucion: data.solucion || fallback.solucion,
            beneficio_estatus: data.beneficio_estatus || fallback.beneficio_estatus,
            prueba_social: data.prueba_social || fallback.prueba_social,
            cierre: data.cierre || fallback.cierre,
            curiosidad: data.curiosidad || fallback.curiosidad,
            palabras_clave: data.palabras_clave || fallback.palabras_clave
        };
    } catch (e) {
        console.log(`⚠️ [MASTERMIND] Error: ${e.message}`);
        return fallback;
    }
}

// ============================================================
// TRAFFIC - Generar hooks virales
// ============================================================
async function generarHooksParaProducto(producto) {
    const fallback = getFallbackHooks();
    
    if (!isTrafficAvailable || !trafficModel) {
        console.log('⚠️ [TRAFFIC] No disponible, usando fallback');
        return fallback;
    }
    
    try {
        console.log(`\n🚀 [TRAFFIC] Generando hooks...`);
        
        const prompt = `Eres el GENERAL DE TRÁFICO. Genera hooks virales para bombardeo externo.

PRODUCTO: ${producto.titulo}
CURIOSIDAD: ${producto.curiosidad || 'Producto de lujo exclusivo'}
ÁNGULO: ${angulosPrompt[anguloVentaActual]}

RESPONDE SOLO CON JSON (sin markdown):
{
    "pinterest": ["hook1", "hook2", "hook3"],
    "twitter": ["hook1", "hook2", "hook3"],
    "instagram": ["hook1", "hook2", "hook3"],
    "facebook": ["hook1", "hook2", "hook3"],
    "metaDescription": "Meta description optimizada 155 chars",
    "seoTitle": "SEO title 60 chars"
}`;
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout after 25s')), 25000)
        );
        
        const result = await Promise.race([
            trafficModel.generateContent(prompt),
            timeoutPromise
        ]);
        
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const hooks = JSON.parse(clean);
        
        console.log(`✅ [TRAFFIC] Hooks generados`);
        return hooks;
    } catch (e) {
        console.log(`⚠️ [TRAFFIC] Error: ${e.message}`);
        return fallback;
    }
}

// ============================================================
// CONTENT - Generar curiosidades
// ============================================================
async function generarCuriosidadConGemini() {
    const temaIdx = Math.floor(Date.now() / 3600000) % TEMAS_SEO.length;
    const tema = TEMAS_SEO[temaIdx];
    const porcentaje = Math.floor(Math.random() * 35 + 60);
    
    const fallback = {
        titulo_es: `El ${porcentaje}% de mujeres en NYC ya conoce este secreto de lujo`,
        titulo_en: `Best ${tema.tema.split(' ').slice(0, 3).join(' ')} 2026`,
        texto_es: `Descubre por qué el ${porcentaje}% de mujeres de alto poder adquisitivo en Manhattan están invirtiendo en este elemento exclusivo.`,
        texto_en: `Discover why ${porcentaje}% of high-income women in Manhattan are investing in this exclusive element.`,
        meta_descripcion_en: `Discover the best luxury home products 2026. What NYC women are buying.`,
        descripcion_visual_es: "Cada detalle en esta imagen habla de elegancia y estatus.",
        descripcion_visual_en: "Every detail in this image speaks of elegance and status.",
        productoSugerido: tema.tema.split(' ')[0] + ' luxury product'
    };
    
    if (!isContentAvailable || !contentModel) {
        console.log('⚠️ [CONTENT] No disponible, usando fallback');
        return fallback;
    }
    
    try {
        console.log(`🏭 [CONTENT] Generando curiosidad...`);
        
        const prompt = `Eres experto en marketing de lujo para mujeres de NYC, Miami, Beverly Hills.
Genera una curiosidad viral.

TEMA: ${tema.tema}
KEYWORD EN: ${tema.kw_en}

RESPONDE SOLO CON JSON (sin markdown):
{
    "titulo_es": "Título en español con número impactante",
    "titulo_en": "Title in English with keyword",
    "texto_es": "Texto persuasivo 2-3 oraciones",
    "texto_en": "Persuasive text 2-3 sentences",
    "meta_descripcion_en": "Meta description 155 chars",
    "descripcion_visual_es": "Descripción sensorial",
    "descripcion_visual_en": "Sensory description",
    "productoSugerido": "Tipo específico de producto Amazon"
}`;
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout after 20s')), 20000)
        );
        
        const result = await Promise.race([
            contentModel.generateContent(prompt),
            timeoutPromise
        ]);
        
        const text = result.response.text();
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const data = JSON.parse(clean);
        
        console.log(`✅ [CONTENT] Curiosidad generada: ${data.titulo_en}`);
        
        return {
            titulo_es: data.titulo_es || fallback.titulo_es,
            titulo_en: data.titulo_en || fallback.titulo_en,
            texto_es: data.texto_es || fallback.texto_es,
            texto_en: data.texto_en || fallback.texto_en,
            meta_descripcion_en: data.meta_descripcion_en || fallback.meta_descripcion_en,
            descripcion_visual_es: data.descripcion_visual_es || fallback.descripcion_visual_es,
            descripcion_visual_en: data.descripcion_visual_en || fallback.descripcion_visual_en,
            productoSugerido: data.productoSugerido || fallback.productoSugerido
        };
    } catch (e) {
        console.log(`⚠️ [CONTENT] Error: ${e.message}`);
        return fallback;
    }
}

async function publicarCuriosidadAutomatica() {
    console.log('🏭 [CONTENT] Generando curiosidad programada...');
    
    try {
        const g = await generarCuriosidadConGemini();
        const img = await obtenerImagen(g.productoSugerido);
        
        const nueva = {
            id: Date.now(),
            titulo_es: g.titulo_es,
            titulo_en: g.titulo_en,
            texto_es: g.texto_es,
            texto_en: g.texto_en,
            meta_descripcion_en: g.meta_descripcion_en,
            descripcion_visual_es: g.descripcion_visual_es,
            descripcion_visual_en: g.descripcion_visual_en,
            imagen: img.url,
            imagenFuente: img.fuente,
            productoSugerido: g.productoSugerido,
            anguloUsado: anguloVentaActual,
            fecha: new Date().toISOString()
        };
        
        await guardarCuriosidad(nueva);
        console.log(`✅ [CONTENT] Publicada: "${nueva.titulo_en}"`);
        return nueva;
    } catch (e) {
        console.log('❌ [CONTENT] Error:', e.message);
        return null;
    }
}

function generarHTMLArticulo(url, imagenUrl, categoria, copy) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${copy.titulo}</title>
    <meta name="description" content="${copy.meta_descripcion}">
    <meta name="keywords" content="${(copy.palabras_clave || []).join(', ')}">
    <meta property="og:image" content="${imagenUrl}">
    <link rel="canonical" href="${url}">
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:system-ui,sans-serif;background:#fffaf7;color:#1a1a1a;line-height:1.6;}
        .hero{background:linear-gradient(135deg,#1a1a2e,#2d2d44);padding:60px 20px;text-align:center;}
        .hero h1{font-size:2rem;color:#fff;max-width:800px;margin:0 auto;}
        .article-body{max-width:800px;margin:0 auto;padding:40px 20px;}
        .btn-buy{display:block;background:#ff4500;color:#fff;padding:16px 30px;text-decoration:none;border-radius:50px;text-align:center;margin:30px 0;font-weight:bold;}
        .btn-buy:hover{background:#ff6b35;}
        .social-proof{background:#fff;border-left:4px solid #ff4500;padding:20px;margin:30px 0;}
        img{max-width:100%;border-radius:12px;margin:20px 0;}
        footer{text-align:center;padding:30px;font-size:12px;border-top:1px solid #eee;}
        @media(max-width:600px){.hero h1{font-size:1.4rem}}
    </style>
</head>
<body>
    <div class="hero">
        <h1>${copy.titulo}</h1>
    </div>
    <div class="article-body">
        <p><strong>✨ ${copy.curiosidad}</strong></p>
        <p>${copy.intro}</p>
        <img src="${imagenUrl}" alt="${copy.titulo}">
        <p>${copy.descripcion_visual}</p>
        <p><strong>${copy.problema}</strong></p>
        <p>${copy.solucion}</p>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow">🔴 VER PRECIO EN AMAZON →</a>
        <p><em>${copy.beneficio_estatus}</em></p>
        <div class="social-proof">
            "${copy.prueba_social}"
        </div>
        <p><strong>${copy.cierre}</strong></p>
        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow">🔥 COMPRAR EN AMAZON →</a>
        <footer>As an Amazon Associate we earn from qualifying purchases. © 2026 MXL GOLD MINER</footer>
    </div>
</body>
</html>`;
}

// ============================================================
// ENDPOINTS API
// ============================================================

// HEALTHCHECK
app.get('/health', async (req, res) => {
    let productosCount = 0;
    try {
        const productos = await obtenerProductos(1);
        productosCount = productos.length;
    } catch(e) {}
    
    res.status(200).json({
        status: 'ok',
        protocol: 'COMMANDER MXL v3.1',
        timestamp: new Date().toISOString(),
        sistemaListo: sistemaListo,
        inicializando: inicializando,
        database: useDatabase ? 'postgresql' : 'json_fallback',
        dbConnected: dbConnected,
        productosCount: productosCount,
        uptime: process.uptime(),
        content: isContentAvailable ? 'active' : (inicializando ? 'pending' : 'inactive'),
        mastermind: isSalesAvailable ? 'active' : (inicializando ? 'pending' : 'inactive'),
        traffic: isTrafficAvailable ? 'active' : (inicializando ? 'pending' : 'inactive'),
        contentModel: contentModelName,
        mastermindModel: salesModelName,
        trafficModel: trafficModelName
    });
});

// ENDPOINT PRINCIPAL - inyectar producto
app.post('/api/commander/inject', async (req, res) => {
    const startTime = Date.now();
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🎯 [COMMANDER MXL] ORDEN RECIBIDA');
    console.log('═══════════════════════════════════════════════════════════');
    
    try {
        const { url, imagenUrl, categoria } = req.body;
        
        if (!url || !imagenUrl) {
            return res.status(400).json({ 
                success: false, 
                error: '⚠️ COMANDANTE: Debes inyectar URL y URL de imagen' 
            });
        }
        
        console.log(`📦 Producto recibido: ${url.substring(0, 80)}...`);
        
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
        
        const elapsed = Date.now() - startTime;
        console.log(`✅ ORDEN COMPLETADA en ${elapsed}ms`);
        console.log(`   📝 Producto: ${producto.titulo}`);
        console.log(`   💾 Almacenamiento: ${useDatabase ? 'PostgreSQL' : 'JSON'}`);
        console.log('═══════════════════════════════════════════════════════════\n');
        
        res.json({
            success: true,
            message: '✅ ORDEN EJECUTADA',
            tiempoProcesamiento: `${elapsed}ms`,
            producto: {
                id: producto.id,
                titulo: producto.titulo,
                url: producto.link
            },
            hooks: hooks,
            storage: useDatabase ? 'postgresql' : 'json_fallback',
            motores: {
                mastermind: isSalesAvailable ? 'activado' : 'fallback',
                traffic: isTrafficAvailable ? 'activado' : 'fallback'
            }
        });
        
    } catch (e) {
        console.error('❌ Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ENDPOINTS DE CONSULTA (ACTUALIZADOS)
app.get('/api/productos', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const data = await obtenerProductos(limit);
        console.log(`📋 GET /api/productos: ${data.length} productos enviados`);
        res.json(data);
    } catch (e) {
        console.error('Error en /api/productos:', e.message);
        res.json([]);
    }
});

app.get('/api/curiosidades', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const data = await obtenerCuriosidades(limit);
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/hooks', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const data = await obtenerHooks(limit);
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/estadisticas', async (req, res) => {
    try {
        const stats = await obtenerEstadisticas();
        res.json({
            ...stats,
            storage: useDatabase ? 'postgresql' : 'json_fallback',
            contentDisponible: isContentAvailable,
            mastermindDisponible: isSalesAvailable,
            trafficDisponible: isTrafficAvailable,
            contentModelo: contentModelName,
            mastermindModelo: salesModelName,
            trafficModelo: trafficModelName,
            sistemaListo: sistemaListo
        });
    } catch (e) {
        console.error('Error en /api/estadisticas:', e.message);
        res.json({ error: e.message });
    }
});

app.post('/api/click/:id', async (req, res) => {
    try {
        await registrarClick(parseInt(req.params.id));
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/angulo/:angulo', (req, res) => {
    const angulo = req.params.angulo.toUpperCase();
    if (angulosPrompt[angulo]) {
        anguloVentaActual = angulo;
        console.log(`🎯 Ángulo rotado a: ${angulo}`);
        res.json({ success: true, angulo: anguloVentaActual });
    } else {
        res.status(400).json({ success: false, error: 'Ángulo inválido. Usa A, B, C o D' });
    }
});

// Rutas estáticas con verificación
const ensureHtmlFile = (filePath, defaultContent) => {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, defaultContent);
        console.log(`📄 Archivo HTML creado: ${path.basename(filePath)}`);
    }
};

const indexPath = path.join(__dirname, 'index.html');
ensureHtmlFile(indexPath, `<!DOCTYPE html>
<html><head><title>MXL Commander API</title><style>body{font-family:system-ui;max-width:800px;margin:0 auto;padding:2rem;background:#fffaf7;}h1{color:#ff4500;}.status{background:#1a1a2e;color:white;padding:1rem;border-radius:8px;}</style></head>
<body><h1>🧠 MXL Commander API</h1><div class="status"><strong>Protocolo:</strong> COMMANDER MXL v3.1<br><strong>Estado:</strong> <span id="status">Cargando...</span><br><strong>Almacenamiento:</strong> <span id="storage">-</span></div>
<script>fetch('/health').then(r=>r.json()).then(d=>{document.getElementById('status').innerText=d.sistemaListo?'✅ Activo':'🔄 Inicializando';document.getElementById('storage').innerText=d.database||'json_fallback';});</script></body></html>`);

const panelPath = path.join(__dirname, 'panel.html');
ensureHtmlFile(panelPath, `<!DOCTYPE html>
<html><head><title>MXL Panel</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0a0f;color:#e0e0e0;font-family:system-ui;padding:2rem;}.container{max-width:1400px;margin:0 auto;}h1{color:#ff4500;margin-bottom:2rem;}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem;}.stat-card{background:#1a1a2e;padding:1rem;border-radius:8px;border-left:3px solid #ff4500;}.stat-value{font-size:2rem;font-weight:bold;color:#ff4500;}.section{background:#1a1a2e;border-radius:8px;padding:1.5rem;margin-bottom:2rem;}pre{background:#0a0a0f;padding:1rem;border-radius:4px;overflow-x:auto;}.refresh-btn{background:#ff4500;color:white;border:none;padding:0.5rem 1rem;border-radius:4px;cursor:pointer;margin-bottom:1rem;}</style></head>
<body><div class="container"><h1>🎯 MXL Commander Panel</h1><button class="refresh-btn" onclick="refreshAll()">🔄 Refrescar</button><div class="stats-grid" id="stats"></div><div class="section"><h2>📊 Últimos Productos</h2><pre id="productos">Cargando...</pre></div></div>
<script>async function refreshAll(){try{const h=await fetch('/health').then(r=>r.json());const s=await fetch('/api/estadisticas').then(r=>r.json());const p=await fetch('/api/productos?limit=5').then(r=>r.json());document.getElementById('stats').innerHTML='<div class="stat-card"><div class="stat-value">'+(s.productosPublicados||0)+'</div><div class="stat-label">Productos</div></div><div class="stat-card"><div class="stat-value">'+(s.curiosidadesGeneradas||0)+'</div><div class="stat-label">Curiosidades</div></div><div class="stat-card"><div class="stat-value">'+(s.hooksGenerados||0)+'</div><div class="stat-label">Hooks</div></div><div class="stat-card"><div class="stat-value">'+(h.database||'JSON')+'</div><div class="stat-label">Storage</div></div>';document.getElementById('productos').innerText=JSON.stringify(p,null,2);}catch(e){console.error(e);}}refreshAll();setInterval(refreshAll,30000);</script></body></html>`);

app.use(express.static(path.join(__dirname, '/')));
app.get('/', (req, res) => res.sendFile(indexPath));
app.get('/panel', (req, res) => res.sendFile(panelPath));

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================

async function inicializarSistemaEnBackground() {
    console.log('\n🔄 Inicializando sistema en segundo plano...');
    
    try {
        await connectToDatabase();
        await initGeminiMotors();
        
        cron.schedule('0 */3 * * *', async () => {
            console.log('⏰ [CRON] Generando curiosidad...');
            await publicarCuriosidadAutomatica();
        });
        
        const curiosidades = await obtenerCuriosidades(1);
        if (curiosidades.length === 0) {
            console.log('📝 Generando primera curiosidad en 5 segundos...');
            setTimeout(() => publicarCuriosidadAutomatica(), 5000);
        }
        
        sistemaListo = true;
        console.log('\n✅ SISTEMA COMPLETAMENTE INICIALIZADO');
        console.log(`   🗄️  Almacenamiento: ${useDatabase ? 'PostgreSQL' : 'JSON Fallback'}`);
        console.log(`   🏭 CONTENT: ${isContentAvailable ? 'ACTIVO' : 'FALLBACK'}`);
        console.log(`   🧠 MASTERMIND: ${isSalesAvailable ? 'ACTIVO' : 'FALLBACK'}`);
        console.log(`   🚀 TRAFFIC: ${isTrafficAvailable ? 'ACTIVO' : 'FALLBACK'}\n`);
    } catch (error) {
        console.error('❌ Error en inicialización:', error);
    } finally {
        inicializando = false;
    }
}

const startServer = () => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     🧠 PROTOCOLO "COMMANDER MXL v3.1" - SERVIDOR ACTIVO        ║
╠══════════════════════════════════════════════════════════════════╣
║  🚀 Puerto: ${PORT}                                               ║
║  🔄 Estado: Inicializando motores en segundo plano...           ║
║  💡 Healthcheck: /health                                         ║
║  📊 API Productos: GET /api/productos                            ║
║  🎯 Panel: /panel                                                ║
╚══════════════════════════════════════════════════════════════════╝
        `);
    });
    
    inicializarSistemaEnBackground();
};

startServer();
