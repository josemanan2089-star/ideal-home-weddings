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

// Inicializar Gemini con manejo de errores
let genAI;
let model;

try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // 🔥 MODELO CORREGIDO - Usar gemini-pro que es más estable
    model = genAI.getGenerativeModel({ model: "gemini-pro" });
    console.log('✅ Gemini inicializado con modelo: gemini-pro');
} catch (error) {
    console.error('❌ Error inicializando Gemini:', error.message);
}

// Archivos de datos
const ARTICULOS_PATH = path.join(__dirname, 'articulos.json');
const CURIOSIDADES_PATH = path.join(__dirname, 'curiosidades.json');

// Inicializar archivos
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));

// ============ FUNCIÓN CON FALLBACK PARA GEMINI ============
async function callGemini(prompt, fallbackData) {
    if (!model) {
        console.log('⚠️ Gemini no disponible, usando fallback');
        return fallbackData;
    }
    
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        return text;
    } catch (error) {
        console.error('❌ Error llamando a Gemini:', error.message);
        return null;
    }
}

// ============ GENERAR CURIOSIDAD FEMENINA (VERSIÓN CORREGIDA) ============
async function generarCuriosidadFemenina() {
    const prompt = `
    Genera una CURIOSIDAD FEMENINA sobre hogar, lujo, estilo de vida o tendencias en Estados Unidos.
    
    Debe ser un dato REAL que sorprenda y atrape a mujeres de 25-45 años en USA (NYC, Miami, Beverly Hills).
    
    Formato EXACTO (texto plano, sin markdown):
    
    TITULO: [Frase corta que genere intriga, máximo 60 caracteres]
    
    DATO: [El dato sorprendente, con estadística o hecho real sobre el mercado americano]
    
    REFLEXION: [Por qué esto es importante para la mujer americana moderna, conexión emocional]
    
    CIERRE: [Frase que la haga sentir parte de un grupo exclusivo de mujeres que "saben"]
    
    EJEMPLO REAL:
    TITULO: El secreto que las novias de Manhattan esconden en su cocina
    DATO: El 78% de las mujeres de alto poder adquisitivo en NYC consideran que un composter de lujo es más importante que un auto europeo en 2026.
    REFLEXION: Porque el verdadero estatus ya no se muestra en el garaje, sino en lo que NO sale de tu cocina.
    CIERRE: Las mujeres que saben, ya tienen el suyo. ¿Tú también quieres ser de las que saben?
    
    Genera UNA curiosidad ÚNICA y SORPRENDENTE enfocada en el mercado americano.
    `;
    
    const fallback = {
        titulo: "El secreto que las mujeres de NYC ya conocen",
        dato: "El 73% de las mujeres de alto poder adquisitivo en Manhattan invierten más en tecnología para el hogar que en bolsos de lujo en 2026.",
        reflexion: "Porque el verdadero lujo ya no se lleva puesto, se vive en casa.",
        cierre: "Las mujeres que saben, ya están en el futuro. ¿Te unes al club?"
    };
    
    const response = await callGemini(prompt, null);
    
    if (!response) {
        return fallback;
    }
    
    // Parsear
    const titulo = response.match(/TITULO:\s*(.+)/i)?.[1] || fallback.titulo;
    const dato = response.match(/DATO:\s*(.+)/i)?.[1] || fallback.dato;
    const reflexion = response.match(/REFLEXION:\s*(.+)/i)?.[1] || fallback.reflexion;
    const cierre = response.match(/CIERRE:\s*(.+)/i)?.[1] || fallback.cierre;
    
    return { titulo, dato, reflexion, cierre };
}

// ============ GENERAR ARTÍCULO CON PRODUCTO AMAZON ============
async function generarArticuloConProducto(url, imagenUrl = '') {
    // Extraer ASIN
    let asin = '';
    const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
    if (asinMatch) asin = asinMatch[1];
    
    const prompt = `
    Genera un ARTÍCULO de revista para un producto de Amazon enfocado en mujeres americanas de alto poder adquisitivo (NYC, Miami, Beverly Hills).
    
    URL del producto: ${url}
    
    Responde SOLO con JSON válido, sin markdown, sin texto adicional:
    {
        "titulo": "Título magnético en inglés que atrape a mujeres (máx 70 caracteres)",
        "intro": "Frase de apertura que genere curiosidad inmediata",
        "problema": "El problema que toda mujer americana enfrenta y este producto resuelve",
        "solucion": "Cómo este producto es la solución que todas buscan",
        "beneficio": "El beneficio emocional (estatus, tranquilidad, admiración social)",
        "cierre": "Frase de llamado a la acción que genere FOMO"
    }
    
    Tono: Asesora de confianza, sofisticado, como Vogue o Architectural Digest.
    Enfoque: Estilo de vida americano, hogar de lujo, silent luxury, status femenino en USA.
    `;
    
    const fallback = {
        titulo: "The Silent Luxury Essential Every Woman Needs",
        intro: "This is the secret that women in the know are adding to their homes",
        problema: "You've been living with clutter and inefficiency without realizing there's a better way",
        solucion: "This revolutionary product transforms your daily routine into a seamless luxury experience",
        beneficio: "Join the elite circle of women who understand true status isn't shown, it's lived",
        cierre: "The women who know, already have theirs. Will you be next?"
    };
    
    const response = await callGemini(prompt, null);
    
    let content;
    if (response) {
        try {
            const cleanJson = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            content = JSON.parse(cleanJson);
        } catch (e) {
            console.error('Error parsing JSON:', e);
            content = fallback;
        }
    } else {
        content = fallback;
    }
    
    return {
        id: Date.now(),
        asin: asin,
        titulo: content.titulo || fallback.titulo,
        intro: content.intro || fallback.intro,
        problema: content.problema || fallback.problema,
        solucion: content.solucion || fallback.solucion,
        beneficio: content.beneficio || fallback.beneficio,
        cierre: content.cierre || fallback.cierre,
        imagen: imagenUrl || (asin ? `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg` : 'https://picsum.photos/400/300'),
        link: url,
        fecha: new Date().toISOString(),
        clicks: 0
    };
}

// ============ ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        gemini: model ? 'active' : 'inactive'
    });
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
        console.error('❌ Error publicación automática:', error.message);
    }
}

// Publicar curiosidad cada 6 horas
cron.schedule('0 */6 * * *', () => {
    console.log('⏰ CRON: Ejecutando publicación automática...');
    publicarCuriosidadAutomatica();
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     ✨ SISTEMA ARTÍCULOS + CURIOSIDADES ✨       ║
    ╠══════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                               ║
    ║  📰 Artículos: /api/articulos                    ║
    ║  💎 Curiosidades: /api/curiosidades              ║
    ║  🤖 Gemini: ${model ? '✅ ACTIVADO (gemini-pro)' : '❌ NO DISPONIBLE'}    
    ║  ⏰ Auto-curiosidad: CADA 6 HORAS                ║
    ║  💨 Cache: ACTIVADO (5 min)                      ║
    ╚══════════════════════════════════════════════════╝
    `);
    
    // Generar curiosidad inicial si no hay
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    if (data.length === 0) {
        console.log('📦 No hay curiosidades, generando una inicial...');
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});
