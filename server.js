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
// CONFIGURACIÓN POSTGRESQL CON RECUPERACIÓN
// ============================================================
let db = null;
let useDatabase = false;
let dbInitialized = false;

async function initDatabase() {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
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
        console.log('✅ PostgreSQL conectado exitosamente');
        
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
        
        // Verificar y crear estadísticas
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
        
        // Crear índices para rendimiento
        await db.query(`CREATE INDEX IF NOT EXISTS idx_productos_fecha ON productos(fecha DESC)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_curiosidades_fecha ON curiosidades(fecha DESC)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_hooks_producto ON social_hooks(producto_id)`);
        
        console.log('✅ Tablas PostgreSQL listas');
        useDatabase = true;
        dbInitialized = true;
        return true;
        
    } catch (err) {
        console.error('❌ Error PostgreSQL:', err.message);
        useDatabase = false;
        dbInitialized = false;
        return false;
    }
}

// ============================================================
// ALMACENAMIENTO JSON (FALLBACK PERSISTENTE)
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const ESTADISTICAS_PATH = path.join(DATA_DIR, 'estadisticas.json');
const SOCIAL_HOOKS_PATH = path.join(DATA_DIR, 'social_hooks.json');

// Crear directorio y archivos JSON
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📁 Directorio data creado');
}

const initJsonFile = (filePath, defaultData) => {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
        console.log(`📄 Archivo creado: ${path.basename(filePath)}`);
    }
};

initJsonFile(ARTICULOS_PATH, []);
initJsonFile(CURIOSIDADES_PATH, []);
initJsonFile(ESTADISTICAS_PATH, {
    totalClics: 0,
    clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
    curiosidadesGeneradas: 0,
    productosPublicados: 0,
    hooksGenerados: 0,
    ultimaActualizacion: new Date().toISOString()
});
initJsonFile(SOCIAL_HOOKS_PATH, []);

// ============================================================
// FUNCIONES CRUD MEJORADAS
// ============================================================
async function guardarProducto(producto) {
    console.log(`💾 Guardando producto: ${producto.titulo.substring(0, 50)}...`);
    
    if (useDatabase && db) {
        try {
            await db.query(`
                INSERT INTO productos (id, asin, titulo, meta, intro, curiosidad, contenido, imagen, categoria, link, clicks, fecha)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO UPDATE SET
                titulo = EXCLUDED.titulo,
                meta = EXCLUDED.meta,
                intro = EXCLUDED.intro,
                curiosidad = EXCLUDED.curiosidad,
                contenido = EXCLUDED.contenido,
                clicks = productos.clicks + 1
            `, [
                producto.id, producto.asin, producto.titulo, producto.meta, 
                producto.intro, producto.curiosidad, producto.contenido, 
                producto.imagen, producto.categoria, producto.link, 
                producto.clicks || 0, producto.fecha
            ]);
            
            await db.query(`
                UPDATE estadisticas 
                SET valor = jsonb_set(valor, '{productosPublicados}', 
                ((COALESCE(valor->>'productosPublicados', '0')::int) + 1)::text::jsonb),
                updated_at = CURRENT_TIMESTAMP 
                WHERE clave = 'global'
            `);
            
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
        
        console.log('✅ Producto guardado en JSON fallback');
        return true;
    } catch (err) {
        console.error('❌ Error guardando en JSON:', err.message);
        return false;
    }
}

async function obtenerProductos(limit = 100) {
    if (useDatabase && db) {
        try {
            const result = await db.query(
                `SELECT * FROM productos ORDER BY fecha DESC LIMIT $1`,
                [limit]
            );
            console.log(`📦 PostgreSQL: ${result.rows.length} productos obtenidos`);
            return result.rows;
        } catch (err) {
            console.error('❌ DB Error obteniendo productos:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        console.log(`📁 JSON fallback: ${data.length} productos obtenidos`);
        return data;
    } catch (err) {
        console.error('❌ Error leyendo JSON:', err.message);
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
                return { 
                    ...stats, 
                    productosActivos: productos.length,
                    storage: 'postgresql'
                };
            }
        } catch (err) {
            console.error('❌ DB Error obteniendo estadísticas:', err.message);
        }
    }
    
    try {
        const stats = JSON.parse(fs.readFileSync(ESTADISTICAS_PATH));
        const productos = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        return { 
            ...stats, 
            productosActivos: productos.length,
            storage: 'json_fallback'
        };
    } catch (err) {
        console.error('❌ Error obteniendo estadísticas:', err.message);
        return { 
            totalClics: 0, 
            productosPublicados: 0, 
            productosActivos: 0,
            storage: 'error'
        };
    }
}

async function guardarCuriosidad(curiosidad) {
    if (useDatabase && db) {
        try {
            await db.query(`
                INSERT INTO curiosidades (id, titulo_es, titulo_en, texto_es, texto_en, 
                meta_descripcion_en, descripcion_visual_es, descripcion_visual_en, 
                imagen, imagen_fuente, productoSugerido, angulo_usado, fecha)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            `, [
                curiosidad.id, curiosidad.titulo_es, curiosidad.titulo_en, 
                curiosidad.texto_es, curiosidad.texto_en, curiosidad.meta_descripcion_en,
                curiosidad.descripcion_visual_es, curiosidad.descripcion_visual_en,
                curiosidad.imagen, curiosidad.imagenFuente, curiosidad.productoSugerido,
                curiosidad.anguloUsado, curiosidad.fecha
            ]);
            
            await db.query(`
                UPDATE estadisticas 
                SET valor = jsonb_set(valor, '{curiosidadesGeneradas}', 
                ((COALESCE(valor->>'curiosidadesGeneradas', '0')::int) + 1)::text::jsonb),
                updated_at = CURRENT_TIMESTAMP 
                WHERE clave = 'global'
            `);
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
                UPDATE estadisticas 
                SET valor = jsonb_set(valor, '{hooksGenerados}', 
                ((COALESCE(valor->>'hooksGenerados', '0')::int) + $1)::text::jsonb),
                updated_at = CURRENT_TIMESTAMP 
                WHERE clave = 'global'
            `, [total]);
            return true;
        } catch (err) {
            console.error('❌ DB Error guardando hooks:', err.message);
        }
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
        data.unshift(registro);
        if (data.length > 100) data.pop();
        fs.writeFileSync(SOCIAL_HOOKS_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error('❌ Error guardando hooks en JSON:', err.message);
        return false;
    }
}

async function registrarClick(productoId) {
    if (useDatabase && db) {
        try {
            await db.query(`UPDATE productos SET clicks = clicks + 1 WHERE id = $1`, [productoId]);
            await db.query(`
                UPDATE estadisticas 
                SET valor = jsonb_set(valor, '{totalClics}', 
                ((COALESCE(valor->>'totalClics', '0')::int) + 1)::text::jsonb),
                updated_at = CURRENT_TIMESTAMP 
                WHERE clave = 'global'
            `);
            return true;
        } catch (err) {
            console.error('❌ DB Error registrando click:', err.message);
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
    } catch (err) {
        console.error('❌ Error registrando click en JSON:', err.message);
        return false;
    }
}

// ============================================================
// MOTORES GEMINI - COMPLETOS
// ============================================================
let sistemaListo = false;
let inicializando = true;
let isContentAvailable = false, isSalesAvailable = false, isTrafficAvailable = false;
let contentModel = null, salesModel = null, trafficModel = null;
let contentModelName = 'pending', salesModelName = 'pending', trafficModelName = 'pending';

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
    
    const missingKeys = [];
    if (!process.env.GEMINI_API_KEY_CONTENT) missingKeys.push('CONTENT');
    if (!process.env.GEMINI_API_KEY_SALES) missingKeys.push('SALES');
    if (!process.env.GEMINI_API_KEY_TRAFFIC) missingKeys.push('TRAFFIC');
    
    if (missingKeys.length > 0) {
        console.log(`⚠️ ADVERTENCIA: Faltan API keys para: ${missingKeys.join(', ')}`);
        console.log('   El sistema funcionará en modo FALLBACK para esos motores\n');
    }
    
    // CONTENT
    const contentKey = process.env.GEMINI_API_KEY_CONTENT;
    console.log(`🏭 CONTENT: ${contentKey ? `${contentKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const contentResult = await initGeminiMotor(contentKey, 'CONTENT');
    contentModel = contentResult.model;
    contentModelName = contentResult.modelName;
    isContentAvailable = contentResult.available;
    
    // MASTERMIND (SALES)
    const salesKey = process.env.GEMINI_API_KEY_SALES;
    console.log(`🧠 MASTERMIND: ${salesKey ? `${salesKey.substring(0, 15)}...` : 'NO CONFIGURADA'}`);
    const salesResult = await initGeminiMotor(salesKey, 'MASTERMIND');
    salesModel = salesResult.model;
    salesModelName = salesResult.modelName;
    isSalesAvailable = salesResult.available;
    
    // TRAFFIC
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
// CONFIGURACIÓN DE CONTENIDO
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

async function obtenerImagen(query) {
    const idx = Math.floor(Math.random() * imagenesRespaldo.length);
    return { url: imagenesRespaldo[idx], fuente: 'respaldo', alt: query || 'luxury home' };
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
// GENERADORES DE CONTENIDO CON TIMEOUTS
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

app.get('/health', async (req, res) => {
    const productos = await obtenerProductos(1);
    res.json({
        status: 'ok',
        protocol: 'COMMANDER MXL v3.1',
        timestamp: new Date().toISOString(),
        sistemaListo: sistemaListo,
        inicializando: inicializando,
        database: useDatabase ? 'postgresql' : 'json_fallback',
        dbInitialized: dbInitialized,
        productosCount: productos.length,
        uptime: process.uptime(),
        content: isContentAvailable ? 'active' : (inicializando ? 'pending' : 'inactive'),
        mastermind: isSalesAvailable ? 'active' : (inicializando ? 'pending' : 'inactive'),
        traffic: isTrafficAvailable ? 'active' : (inicializando ? 'pending' : 'inactive'),
        contentModel: contentModelName,
        mastermindModel: salesModelName,
        trafficModel: trafficModelName
    });
});

app.post('/api/commander/inject', async (req, res) => {
    const startTime = Date.now();
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🎯 [COMMANDER MXL] ORDEN RECIBIDA');
    
    try {
        const { url, imagenUrl, categoria } = req.body;
        
        if (!url || !imagenUrl) {
            return res.status(400).json({ 
                success: false, 
                error: '⚠️ COMANDANTE: Debes inyectar URL y URL de imagen' 
            });
        }
        
        console.log(`📦 Producto: ${url.substring(0, 80)}...`);
        
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
            producto: { id: producto.id, titulo: producto.titulo, url: producto.link },
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

app.get('/api/productos', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const data = await obtenerProductos(limit);
        res.json(data);
    } catch (e) {
        console.error('Error en /api/productos:', e.message);
        res.json([]);
    }
});

app.get('/api/curiosidades', async (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/hooks', async (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(SOCIAL_HOOKS_PATH));
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
            contentDisponible: isContentAvailable,
            mastermindDisponible: isSalesAvailable,
            trafficDisponible: isTrafficAvailable,
            contentModelo: contentModelName,
            mastermindModelo: salesModelName,
            trafficModelo: trafficModelName,
            sistemaListo: sistemaListo,
            inicializando: inicializando
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

// Frontend
const indexPath = path.join(__dirname, 'index.html');
if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MXL Commander - API Activa</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;}
        .card{background:white;border-radius:20px;padding:40px;max-width:600px;margin:20px;box-shadow:0 20px 60px rgba(0,0,0,0.3);}
        h1{color:#ff4500;margin-bottom:10px;font-size:2.5rem;}
        .status{background:#1a1a2e;color:white;padding:20px;border-radius:12px;margin:20px 0;}
        .endpoint{background:#f0f0f0;padding:10px;margin:10px 0;border-radius:8px;font-family:monospace;font-size:0.9rem;}
        .badge{display:inline-block;background:#ff4500;color:white;padding:4px 8px;border-radius:4px;font-size:0.7rem;margin-left:10px;}
        a{color:#ff4500;text-decoration:none;}
        .footer{text-align:center;margin-top:20px;color:#666;font-size:0.8rem;}
    </style>
</head>
<body>
    <div class="card">
        <h1>🧠 MXL Commander</h1>
        <p>Protocolo Triple Núcleo v3.1</p>
        <div class="status">
            <strong>Estado:</strong> <span id="status">🔄 Inicializando...</span><br>
            <strong>Almacenamiento:</strong> <span id="storage">-</span><br>
            <strong>Productos:</strong> <span id="productosCount">-</span><br>
            <strong>Motores:</strong> <span id="motores">-</span>
        </div>
        <h3>📡 Endpoints Disponibles</h3>
        <div class="endpoint">POST /api/commander/inject <span class="badge">Inyectar Producto</span></div>
        <div class="endpoint">GET /api/productos <span class="badge">Listar Productos</span></div>
        <div class="endpoint">GET /api/estadisticas <span class="badge">Estadísticas</span></div>
        <div class="endpoint">GET /health <span class="badge">Healthcheck</span></div>
        <div class="footer">
            COMMANDER MXL • Sistema Operativo
        </div>
    </div>
    <script>
        async function loadStatus() {
            try {
                const res = await fetch('/health');
                const data = await res.json();
                document.getElementById('status').innerHTML = data.sistemaListo ? '✅ Activo' : '🔄 Inicializando';
                document.getElementById('storage').innerHTML = data.database === 'postgresql' ? '🐘 PostgreSQL' : '📁 JSON Fallback';
                document.getElementById('productosCount').innerHTML = data.productosCount || 0;
                
                let motoresHtml = '';
                motoresHtml += data.content === 'active' ? '🏭✅' : '🏭⚠️';
                motoresHtml += ' ';
                motoresHtml += data.mastermind === 'active' ? '🧠✅' : '🧠⚠️';
                motoresHtml += ' ';
                motoresHtml += data.traffic === 'active' ? '🚀✅' : '🚀⚠️';
                document.getElementById('motores').innerHTML = motoresHtml;
            } catch(e) {
                document.getElementById('status').innerHTML = '⚠️ Error de conexión';
            }
        }
        loadStatus();
        setInterval(loadStatus, 10000);
    </script>
</body>
</html>`);
}

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(indexPath));
app.get('/panel', (req, res) => res.sendFile(indexPath));

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
async function start() {
    console.log('\n🚀 Iniciando COMMANDER MXL v3.1...\n');
    
    await initDatabase();
    await initGeminiMotors();
    
    // Programar CRON para curiosidades cada 3 horas
    cron.schedule('0 */3 * * *', async () => {
        console.log('⏰ [CRON] Generando curiosidad automática...');
        await publicarCuriosidadAutomatica();
    });
    
    // Generar primera curiosidad si no hay
    try {
        const curiosidades = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        if (curiosidades.length === 0) {
            console.log('📝 Generando primera curiosidad en 5 segundos...');
            setTimeout(() => publicarCuriosidadAutomatica(), 5000);
        }
    } catch (e) {
        console.log('📝 Generando primera curiosidad en 5 segundos...');
        setTimeout(() => publicarCuriosidadAutomatica(), 5000);
    }
    
    sistemaListo = true;
    inicializando = false;
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     🧠 PROTOCOLO "COMMANDER MXL v3.1" - SERVIDOR ACTIVO        ║
╠══════════════════════════════════════════════════════════════════╣
║  🚀 Puerto: ${PORT}                                               ║
║  🗄️  Storage: ${useDatabase ? 'PostgreSQL ✅' : 'JSON Fallback ⚠️'}  ║
║  🏭 CONTENT: ${isContentAvailable ? '✅' : '⚠️'}  MASTERMIND: ${isSalesAvailable ? '✅' : '⚠️'}  TRAFFIC: ${isTrafficAvailable ? '✅' : '⚠️'}  ║
║  📊 API: /api/productos | /api/estadisticas | /health           ║
║  🎯 Panel: /panel                                                ║
║  💡 Healthcheck disponible para Railway                         ║
╚══════════════════════════════════════════════════════════════════╝
        `);
    });
}

// Manejo de cierre graceful
process.on('SIGTERM', async () => {
    console.log('🛑 Recibida señal SIGTERM, cerrando conexiones...');
    if (db) {
        await db.end();
        console.log('✅ Conexiones PostgreSQL cerradas');
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 Recibida señal SIGINT, cerrando conexiones...');
    if (db) {
        await db.end();
        console.log('✅ Conexiones PostgreSQL cerradas');
    }
    process.exit(0);
});

start();
