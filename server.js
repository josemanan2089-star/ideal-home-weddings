const express = require('express');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const compression = require('compression');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// DB POSTGRESQL - MANDO MXL
// ============================================================
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS articulos (
                id BIGINT PRIMARY KEY, asin VARCHAR(20), titulo TEXT, meta TEXT, 
                curiosidad TEXT, imagen TEXT, categoria VARCHAR(100), 
                link TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ DB Lista - Familia MXL');
    } catch (e) { console.error('❌ Error DB:', e.message); }
}

// ============================================================
// MOTOR 2.5 - FOCO TOTAL EN EL TÍTULO
// ============================================================
let contentModel = null;
async function initGemini() {
    const key = process.env.GEMINI_API_KEY_CONTENT;
    if (key) {
        const genAI = new GoogleGenerativeAI(key.trim());
        contentModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        console.log("✅ MOTOR MXL 2.5 ACTIVO - EL TÍTULO MANDA");
    }
}

// ============================================================
// INYECCIÓN: LA IA SOLO TRABAJA CON EL TÍTULO QUE TÚ DAS
// ============================================================
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal } = req.body;
    
    if (!contentModel || !tituloReal) return res.status(400).json({ success: false, error: "Faltan datos" });

    console.log(`🎯 [INYECCIÓN MXL] Generando copy para: ${tituloReal}`);
    try {
        // PROMPT DEFINITIVO: La IA no sabe nada de la imagen, solo del título.
        const prompt = `Eres un experto en marketing de lujo en NYC. 
        TEMA OBLIGATORIO: "${tituloReal}".
        
        INSTRUCCIÓN: Escribe un artículo corto, sofisticado y persuasivo basado ÚNICAMENTE en el nombre del producto proporcionado arriba. 
        - Si el nombre dice 'Cama', habla de descanso real. 
        - Si el nombre dice 'Freidora', habla de cocina gourmet.
        - NO intentes adivinar por la URL. USA SOLO EL TÍTULO.
        
        Responde SOLO JSON: {"titulo": "...", "meta": "...", "curiosidad": "..."}`;
        
        const result = await contentModel.generateContent(prompt);
        const copy = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());

        // Guardamos la imagen que TÚ elegiste, sin que la IA la cuestione
        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [Date.now(), "MXL"+Date.now(), copy.titulo, copy.meta, copy.curiosidad, imagenUrl, categoria, url, new Date().toISOString()]);

        console.log(`✅ [MXL] Inyección exitosa basada en título: ${tituloReal}`);
        res.json({ success: true, producto: copy.titulo });
    } catch (e) { 
        console.error('❌ Error:', e.message);
        res.status(500).json({ success: false }); 
    }
});

// APIs de lectura para el Frontend
app.get('/api/productos', async (req, res) => {
    try {
        const r = await db.query(`SELECT * FROM articulos ORDER BY fecha DESC LIMIT 100`);
        res.json(r.rows);
    } catch (e) { res.json([]); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
    await initDB();
    await initGemini();
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 MXL 2.5 - MOTOR CIEGO A IMAGEN v4.5`));
}
start();
