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

// Archivos de datos
const ARTICULOS_PATH = path.join(__dirname, 'articulos.json');
const CURIOSIDADES_PATH = path.join(__dirname, 'curiosidades.json');

// Inicializar archivos
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));

// ============ GENERAR CURIOSIDAD FEMENINA ============
async function generarCuriosidadFemenina() {
    const prompt = `
    Genera una CURIOSIDAD FEMENINA sobre hogar, lujo, estilo de vida o tendencias.
    
    Debe ser un dato REAL que sorprenda y atrape a mujeres de 25-45 años en USA.
    
    Formato EXACTO (texto plano):
    
    TITULO: [Frase corta que genere intriga, máximo 60 caracteres]
    
    DATO: [El dato sorprendente, con estadística o hecho real]
    
    REFLEXION: [Por qué esto es importante para ella, conexión emocional]
    
    CIERRE: [Frase que la haga sentir parte de un grupo exclusivo]
    
    EJEMPLOS:
    TITULO: El secreto que las novias de Manhattan esconden
    DATO: El 78% de las mujeres de alto poder adquisitivo en NYC consideran que un composter de lujo es más importante que un auto europeo.
    REFLEXION: Porque en 2026, el verdadero estatus no se muestra en el garaje, sino en lo que NO sale de tu cocina.
    CIERRE: Las mujeres que saben, ya tienen el suyo. ¿Tú también quieres ser de las que saben?
    
    Genera UNA curiosidad ÚNICA y SORPRENDENTE.
    `;
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    // Parsear
    const titulo = text.match(/TITULO:\s*(.+)/i)?.[1] || "✨ El Secreto Femenino";
    const dato = text.match(/DATO:\s*(.+)/i)?.[1] || "Descubre el nuevo símbolo de estatus silencioso";
    const reflexion = text.match(/REFLEXION:\s*(.+)/i)?.[1] || "Porque las mujeres que saben, viven mejor";
    const cierre = text.match(/CIERRE:\s*(.+)/i)?.[1] || "Únete al club de las que saben";
    
    return { titulo, dato, reflexion, cierre };
}

// ============ GENERAR ARTÍCULO CON PRODUCTO AMAZON ============
async function generarArticuloConProducto(url, imagenUrl = '') {
    // Extraer ASIN
    let asin = '';
    const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
    if (asinMatch) asin = asinMatch[1];
    
    const prompt = `
    Genera un ARTÍCULO de revista para un producto de Amazon enfocado en mujeres.
    
    URL del producto: ${url}
    
    Formato JSON:
    {
        "titulo": "Título magnético que atrape a mujeres (máx 70 caracteres)",
        "intro": "Frase de apertura que genere curiosidad inmediata",
        "problema": "El problema que toda mujer enfrenta y este producto resuelve",
        "solucion": "Cómo este producto es la solución que todas buscan",
        "beneficio": "El beneficio emocional que obtiene (estatus, tranquilidad, admiración)",
        "cierre": "Frase de llamado a la acción que genere FOMO"
    }
    
    Tono: Asesor de confianza, sofisticado, como Vogue o Architectural Digest.
    Enfoque: Estilo de vida, hogar de lujo, silent luxury, status femenino.
    `;
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const content = JSON.parse(cleanJson);
    
    return {
        id: Date.now(),
        asin: asin,
        titulo: content.titulo,
        intro: content.intro,
        problema: content.problema,
        solucion: content.solucion,
        beneficio: content.beneficio,
        cierre: content.cierre,
        imagen: imagenUrl || (asin ? `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg` : ''),
        link: url,
        fecha: new Date().toISOString(),
        clicks: 0
    };
}

// ============ ENDPOINTS ============

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

// ============ API ARTÍCULOS ============
app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/publicar-articulo', async (req, res) => {
    try {
        const { url, imagenUrl } = req.body;
        
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        const nuevoArticulo = await generarArticuloConProducto(url, imagenUrl);
        
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        
        cache.clear();
        res.json({ success: true, articulo: nuevoArticulo });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const index = data.findIndex(a => a.id == id);
        if (index !== -1) {
            data[index].clicks = (data[index].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// ============ API CURIOSIDADES ============
app.get('/api/curiosidades', (req, res) => {
    const cached = cache.get('curiosidades');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
    }
    
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        cache.set('curiosidades', { data, timestamp: Date.now() });
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const nuevaCuriosidad = await generarCuriosidadFemenina();
        
        const curiosidadCompleta = {
            id: Date.now(),
            ...nuevaCuriosidad,
            fecha: new Date().toISOString(),
            compartidas: 0
        };
        
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(curiosidadCompleta);
        
        // Mantener solo las últimas 30 curiosidades
        if (data.length > 30) data.pop();
        
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        cache.clear();
        res.json({ success: true, curiosidad: curiosidadCompleta });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/compartir-curiosidad/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const index = data.findIndex(c => c.id == id);
        if (index !== -1) {
            data[index].compartidas = (data[index].compartidas || 0) + 1;
            fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// ============ PUBLICACIÓN AUTOMÁTICA ============
async function publicarCuriosidadAutomatica() {
    console.log('🤖 Generando curiosidad automática...');
    try {
        const nuevaCuriosidad = await generarCuriosidadFemenina();
        
        const curiosidadCompleta = {
            id: Date.now(),
            ...nuevaCuriosidad,
            fecha: new Date().toISOString(),
            compartidas: 0
        };
        
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(curiosidadCompleta);
        if (data.length > 30) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        cache.clear();
        console.log(`✅ Nueva curiosidad: ${curiosidadCompleta.titulo}`);
        
    } catch (error) {
        console.error('Error publicación automática:', error);
    }
}

// Publicar curiosidad cada 6 horas
cron.schedule('0 */6 * * *', () => {
    publicarCuriosidadAutomatica();
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     ✨ SISTEMA ARTÍCULOS + CURIOSIDADES ✨       ║
    ╠══════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                               ║
    ║  📰 Artículos: /api/articulos                    ║
    ║  💎 Curiosidades: /api/curiosidades              ║
    ║  🤖 Gemini: ACTIVADO                             ║
    ║  ⏰ Auto-curiosidad: CADA 6 HORAS                ║
    ║  💨 Cache: ACTIVADO (5 min)                      ║
    ╚══════════════════════════════════════════════════╝
    `);
    
    // Generar curiosidad inicial si no hay
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    if (data.length === 0) {
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});
