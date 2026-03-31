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

// Middlewares de alto rendimiento
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// CONFIGURACIÓN POSTGRESQL - PROTOCOLO MXL
// ============================================================
let db = null;
let useDatabase = false;

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
        
        await db.query('SELECT NOW()');
        console.log('✅ PostgreSQL conectado exitosamente');
        
        // Sincronización de tablas con el nombre 'articulos'
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
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
        
        // Inicializar Estadísticas Globales
        const statsCheck = await db.query("SELECT * FROM estadisticas WHERE clave = 'global'");
        if (statsCheck.rows.length === 0) {
            await db.query("INSERT INTO estadisticas (clave, valor) VALUES ($1, $2)", 
            ['global', JSON.stringify({
                totalClics: 0, clicsPorAngulo: { A: 0, B: 0, C: 0, D: 0 },
                curiosidadesGeneradas: 0, productosPublicados: 0, hooksGenerados: 0,
                ultimaActualizacion: new Date().toISOString()
            })]);
        }
        
        console.log('✅ Tablas PostgreSQL listas (Mando MXL)');
        useDatabase = true;
        return true;
    } catch (err) {
        console.error('❌ Error PostgreSQL:', err.message);
        useDatabase = false;
        return false;
    }
}

// ============================================================
// FUNCIONES CRUD - SINCRONIZADAS
// ============================================================
async function guardarProducto(producto) {
    if (useDatabase && db) {
        try {
            await db.query(`
                INSERT INTO articulos (id, asin, titulo, meta, intro, curiosidad, contenido, imagen, categoria, link, clicks, fecha)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (id) DO UPDATE SET
                titulo = EXCLUDED.titulo, meta = EXCLUDED.meta, intro = EXCLUDED.intro,
                curiosidad = EXCLUDED.curiosidad, contenido = EXCLUDED.contenido,
                clicks = articulos.clicks + 1
            `, [producto.id, producto.asin, producto.titulo, producto.meta, producto.intro,
                producto.curiosidad, producto.contenido, producto.imagen, producto.categoria,
                producto.link, producto.clicks || 0, producto.fecha]);
            return true;
        } catch (err) { console.error('❌ DB Error guardando:', err.message); }
    }
    return false;
}

async function obtenerProductos(limit = 100) {
    if (useDatabase && db) {
        try {
            const result = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT $1`, [limit]);
            return result.rows;
        } catch (err) { console.error('❌ DB Error obteniendo:', err.message); }
    }
    return [];
}

// ============================================================
// MOTORES GEMINI - TRIPLE NÚCLEO MXL
// ============================================================
let isContentAvailable = false, isSalesAvailable = false, isTrafficAvailable = false;
let contentModel = null, salesModel = null, trafficModel = null;

async function initGeminiMotors() {
    const keys = {
        content: process.env.GEMINI_API_KEY_CONTENT,
        sales: process.env.GEMINI_API_KEY_SALES,
        traffic: process.env.GEMINI_API_KEY_TRAFFIC
    };

    if (keys.content) {
        const genAI = new GoogleGenerativeAI(keys.content.trim());
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        isContentAvailable = true;
        console.log('🏭 [CONTENT] Motor Activo');
    }
    if (keys.sales) {
        const genAI = new GoogleGenerativeAI(keys.sales.trim());
        salesModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        isSalesAvailable = true;
        console.log('🧠 [MASTERMIND] Motor Activo');
    }
    if (keys.traffic) {
        const genAI = new GoogleGenerativeAI(keys.traffic.trim());
        trafficModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        isTrafficAvailable = true;
        console.log('🚀 [TRAFFIC] Motor Activo');
    }
}

// ============================================================
// GENERADORES DE CONTENIDO (MXL GOLD MINER)
// ============================================================
async function generarArticuloCompleto(url, imagenUrl, categoria) {
    if (!isSalesAvailable) return { titulo: "Producto Exclusivo 2026", curiosidad: "Secreto de lujo" };
    
    const prompt = `Eres DAVID OGILVY. Genera un artículo de LUJO para este link: ${url}. Responde solo JSON: {"titulo": "...", "meta": "...", "intro": "...", "curiosidad": "...", "contenido": "...", "keywords": []}`;
    
    try {
        const result = await salesModel.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) { return { titulo: "Inversión de Lujo 2026", curiosidad: "Exclusivo para NYC" }; }
}

// ============================================================
// ENDPOINTS API
// ============================================================
app.get('/health', async (req, res) => {
    const productos = await obtenerProductos(1);
    res.json({ status: 'ok', database: useDatabase ? 'postgresql' : 'fallback', count: productos.length });
});

app.get('/api/productos', async (req, res) => {
    const data = await obtenerProductos(100);
    res.json(data);
});

app.post('/api/commander/inject', async (req, res) => {
    console.log('🎯 [COMMANDER MXL] INYECTANDO PRODUCTO...');
    const { url, imagenUrl, categoria } = req.body;
    
    const copy = await generarArticuloCompleto(url, imagenUrl, categoria);
    const producto = {
        id: Date.now(),
        asin: "AMZ" + Date.now(),
        titulo: copy.titulo,
        meta: copy.meta || copy.titulo,
        intro: copy.intro || "",
        curiosidad: copy.curiosidad || "",
        contenido: copy.contenido || "",
        imagen: imagenUrl,
        categoria: categoria || 'LUXURY',
        link: url,
        fecha: new Date().toISOString()
    };
    
    await guardarProducto(producto);
    res.json({ success: true, producto: producto.titulo });
});

// Frontend Estático
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
async function start() {
    await initDatabase();
    await initGeminiMotors();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔══════════════════════════════════════════════════════════════════╗
║     🧠 PROTOCOLO "COMMANDER MXL v3.1" - SERVIDOR ACTIVO        ║
╠══════════════════════════════════════════════════════════════════╣
║ 🚀 Puerto: ${PORT}                                              ║
║ 🗄️ Storage: ${useDatabase ? 'PostgreSQL ✅' : 'Fallback ⚠️'}    ║
║ 🏭 CONTENT: ${isContentAvailable ? '✅' : '⚠️'}  MASTERMIND: ${isSalesAvailable ? '✅' : '⚠️'}  ║
╚══════════════════════════════════════════════════════════════════╝
        `);
    });
}

start();
