const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// Cache para respuestas rápidas
const cache = new Map();
const CACHE_TTL = 300000; // 5 minutos

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const DB_PATH = path.join(__dirname, 'productos.json');

if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

// ============ GENERAR CURIOSIDADES FEMENINAS QUE ATRAPAN ============
async function generarCuriosidadFemenina(url) {
    const prompt = `
    Eres una experta en tendencias femeninas de lujo para revista como Cosmopolitan, Vogue, o Architectural Digest.
    
    GENERA UNA "CURIOSIDAD" QUE ATRAPE A MUJERES:
    
    Formato EXACTO (texto plano, no JSON):
    
    TÍTULO: [Frase corta que haga decir "OMG" o "No sabía eso"]
    
    CURIOSIDAD: [Dato impactante sobre hogar de lujo que las mujeres NECESITAN saber]
    
    BENEFICIO: [Por qué ESTE producto es el secreto que todas las mujeres de NYC/Miami ya tienen]
    
    CIERRE: [Frase que genere FOMO - "miedo a quedarse fuera"]
    
    EJEMPLO:
    TÍTULO: El secreto que las novias de Manhattan esconden en su cocina
    CURIOSIDAD: ¿Sabías que el 78% de las mujeres de alto poder adquisitivo en NYC consideran que tener un composter es más importante que un auto de lujo?
    BENEFICIO: Este pequeño dispositivo elimina el 100% de los olores de cocina y convierte tu basura en abono en 4 horas. Es el "silencio dorado" que todas quieren.
    CIERRE: Mientras tu amiga sigue sacando bolsas apestosas, tú ya estás en el futuro. ¿Te unes al club de las que saben?
    
    IMPORTANTE: Tono ASÍ DE PODEROSO. Que genere curiosidad, envidia social y ganas de comprar.
    `;
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    // Parsear el formato
    const titulo = text.match(/TÍTULO:\s*(.+)/i)?.[1] || "✨ El Secreto que Todas Quieren";
    const curiosidad = text.match(/CURIOSIDAD:\s*(.+)/i)?.[1] || "Descubre por qué las mujeres más elegantes están cambiando su hogar";
    const beneficio = text.match(/BENEFICIO:\s*(.+)/i)?.[1] || "Transforma tu hogar con este esencial de lujo silencioso";
    const cierre = text.match(/CIERRE:\s*(.+)/i)?.[1] || "Las que saben, ya lo tienen. ¿Te unes?";
    
    return { titulo, curiosidad, beneficio, cierre };
}

// ============ PUBLICAR ARTÍCULO CON CURIOSIDAD ============
app.post('/api/publicar-curiosidad', async (req, res) => {
    try {
        const { url, imagenUrl } = req.body;
        
        // Extraer ASIN
        let asin = '';
        const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
        if (asinMatch) asin = asinMatch[1];
        
        // Generar curiosidad con Gemini
        const curiosidadData = await generarCuriosidadFemenina(url);
        
        const nuevoArticulo = {
            id: Date.now(),
            asin: asin,
            titulo: curiosidadData.titulo,
            curiosidad: curiosidadData.curiosidad,
            beneficio: curiosidadData.beneficio,
            cierre: curiosidadData.cierre,
            imagen: imagenUrl || (asin ? `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg` : ''),
            link: url,
            fecha: new Date().toISOString(),
            clicks: 0,
            compartidos: 0
        };
        
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        
        // Limpiar cache
        cache.clear();
        
        res.json({ success: true, articulo: nuevoArticulo });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ PUBLICACIÓN AUTOMÁTICA CADA 3 HORAS ============
const articulosEjemplo = [
    'https://amazon.com/dp/B0C3H7K2X1',
    'https://amazon.com/dp/B09Y2X8W4V',
    'https://amazon.com/dp/B08K7J5H3G',
    'https://amazon.com/dp/B07M9N2P4R'
];

async function publicarAutomatico() {
    console.log('🤖 Publicando artículo automático...');
    const urlAleatoria = articulosEjemplo[Math.floor(Math.random() * articulosEjemplo.length)];
    
    try {
        const curiosidadData = await generarCuriosidadFemenina(urlAleatoria);
        
        const nuevoArticulo = {
            id: Date.now(),
            titulo: curiosidadData.titulo,
            curiosidad: curiosidadData.curiosidad,
            beneficio: curiosidadData.beneficio,
            cierre: curiosidadData.cierre,
            imagen: `https://picsum.photos/400/300?random=${Date.now()}`,
            link: urlAleatoria,
            fecha: new Date().toISOString(),
            clicks: 0
        };
        
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        
        cache.clear();
        console.log(`✅ Nuevo artículo: ${nuevoArticulo.titulo}`);
        
    } catch (error) {
        console.error('Error publicación automática:', error);
    }
}

// CRON: Cada 3 horas
cron.schedule('0 */3 * * *', () => {
    publicarAutomatico();
});

// ============ ENDPOINTS RÁPIDOS CON CACHE ============

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// API con cache para velocidad
app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/click/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const index = data.findIndex(a => a.id == id);
        if (index !== -1) {
            data[index].clicks = (data[index].clicks || 0) + 1;
            fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
            cache.clear();
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║  ✨ CURIOSIDADES FEMENINAS ✨         ║
    ║  🚀 Puerto: ${PORT}                     ║
    ║  🤖 Gemini: ACTIVADO                   ║
    ║  ⏰ Auto-publicación: CADA 3 HORAS    ║
    ║  💨 Cache: ACTIVADO (5 min)           ║
    ╚════════════════════════════════════════╝
    `);
    
    // Publicar un artículo inicial si no hay
    const data = JSON.parse(fs.readFileSync(DB_PATH));
    if (data.length === 0) {
        setTimeout(() => publicarAutomatico(), 5000);
    }
});
