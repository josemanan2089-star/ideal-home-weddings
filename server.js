const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));
app.use('/temp', express.static(path.join(__dirname, 'temp')));

// Cache
const cache = new Map();
const CACHE_TTL = 300000;

// Gemini
let genAI;
let model;
try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-pro" });
    console.log('✅ Gemini DURO activado');
} catch (error) {
    console.log('⚠️ Gemini no disponible');
}

// Configuración persistente
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));

// ============ FUNCIONES AUXILIARES ============
function extraerASIN(url) {
    const patterns = [
        /(?:dp|product|gp\/product)\/([A-Z0-9]{10})/i,
        /asin=([A-Z0-9]{10})/i,
        /\/dp\/([A-Z0-9]{10})/i
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// ============ 🎯 BUSCAR IMAGEN PARA CURIOSIDAD (GOOGLE/UNSPLASH) ============
async function buscarImagenParaCuriosidad(promptImagen) {
    console.log(`🔍 Buscando imagen para: "${promptImagen.substring(0, 50)}..."`);
    
    // Opción 1: Unsplash si hay API key
    if (process.env.UNSPLASH_ACCESS_KEY) {
        try {
            const response = await axios.get('https://api.unsplash.com/search/photos', {
                params: {
                    query: promptImagen,
                    per_page: 1,
                    orientation: 'landscape'
                },
                headers: { 'Authorization': `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
                timeout: 8000
            });
            
            if (response.data.results && response.data.results.length > 0) {
                console.log('✅ Unsplash: imagen encontrada');
                return {
                    url: response.data.results[0].urls.regular,
                    fuente: 'unsplash',
                    credit: response.data.results[0].user.name
                };
            }
        } catch(e) {
            console.log('⚠️ Unsplash error:', e.message);
        }
    }
    
    // Opción 2: Google Custom Search
    if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) {
        try {
            const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
                params: {
                    key: process.env.GOOGLE_API_KEY,
                    cx: process.env.GOOGLE_CX,
                    q: promptImagen,
                    searchType: 'image',
                    num: 1,
                    imgSize: 'large',
                    safe: 'active'
                },
                timeout: 8000
            });
            
            if (response.data.items && response.data.items.length > 0) {
                console.log('✅ Google Images: imagen encontrada');
                return {
                    url: response.data.items[0].link,
                    fuente: 'google',
                    titulo: response.data.items[0].title
                };
            }
        } catch(e) {
            console.log('⚠️ Google Images error:', e.message);
        }
    }
    
    // Opción 3: Placeholder con imagen temática de Pexels (gratis)
    const placeholders = {
        kitchen: 'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
        luxury: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
        woman: 'https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg',
        home: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
        money: 'https://images.pexels.com/photos/4386361/pexels-photo-4386361.jpeg',
        tech: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
        default: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg'
    };
    
    let placeholderKey = 'default';
    const lowerPrompt = promptImagen.toLowerCase();
    if (lowerPrompt.includes('kitchen')) placeholderKey = 'kitchen';
    if (lowerPrompt.includes('luxury')) placeholderKey = 'luxury';
    if (lowerPrompt.includes('woman') || lowerPrompt.includes('women')) placeholderKey = 'woman';
    if (lowerPrompt.includes('home')) placeholderKey = 'home';
    if (lowerPrompt.includes('money') || lowerPrompt.includes('save')) placeholderKey = 'money';
    if (lowerPrompt.includes('tech') || lowerPrompt.includes('smart')) placeholderKey = 'tech';
    
    console.log(`📸 Usando placeholder: ${placeholderKey}`);
    return {
        url: placeholders[placeholderKey],
        fuente: 'placeholder',
        tipo: 'fallback'
    };
}

// ============ 🎯 GEMINI GENERA CURIOSIDAD CON IMAGEN ============
async function generarCuriosidadConGemini() {
    const prompt = `
    Genera una CURIOSIDAD VIRAL para mujeres de USA (NYC, Miami, Beverly Hills) sobre hogar, lujo, dinero o estilo de vida.
    
    Debe ser un dato IMPACTANTE que haga decir "OMG" y que la gente quiera COMPARTIR.
    
    FORMATO JSON:
    {
        "titulo": "Título corto y magnético (máx 60 caracteres)",
        "texto": "El dato sorprendente que atrapa (2-3 líneas)",
        "imagen_prompt": "Descripción para buscar una imagen impactante que acompañe esta curiosidad (ej: luxury kitchen, elegant woman, NYC apartment)"
    }
    
    EJEMPLOS:
    {
        "titulo": "El secreto que las mujeres de NYC esconden en su cocina",
        "texto": "El 78% de las mujeres de alto poder adquisitivo en Manhattan consideran que un composter de lujo es más importante que un auto europeo en 2026.",
        "imagen_prompt": "luxury modern kitchen with elegant woman, natural light, NYC apartment view"
    }
    
    Genera UNA curiosidad ÚNICA y SORPRENDENTE.
    `;
    
    // Fallback por si Gemini falla
    const fallback = {
        titulo: "El secreto que las mujeres de Manhattan ya conocen",
        texto: "El 73% de las mujeres de alto poder adquisitivo en NYC invierten más en tecnología para el hogar que en bolsos de lujo en 2026.",
        imagen_prompt: "modern luxury kitchen, elegant woman, NYC skyline view"
    };
    
    if (!model) return fallback;
    
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const contenido = JSON.parse(cleanJson);
        console.log('✨ Gemini generó curiosidad viral');
        return contenido;
    } catch (error) {
        console.log('⚠️ Error Gemini curiosidad:', error.message);
        return fallback;
    }
}

// ============ 🎯 GENERAR CURIOSIDAD COMPLETA CON IMAGEN ============
async function generarCuriosidadCompleta() {
    console.log('✨ Generando curiosidad con Gemini...');
    
    // 1. Gemini genera la curiosidad
    const curiosidadGemini = await generarCuriosidadConGemini();
    
    // 2. Buscar imagen para la curiosidad usando el prompt
    console.log(`🔍 Buscando imagen para: "${curiosidadGemini.imagen_prompt}"`);
    const imagen = await buscarImagenParaCuriosidad(curiosidadGemini.imagen_prompt);
    
    // 3. Retornar curiosidad completa con imagen
    const curiosidadCompleta = {
        id: Date.now(),
        titulo: curiosidadGemini.titulo,
        texto: curiosidadGemini.texto,
        imagen: imagen.url,
        imagenFuente: imagen.fuente,
        imagenPrompt: curiosidadGemini.imagen_prompt,
        fecha: new Date().toISOString(),
        compartidas: 0
    };
    
    console.log(`✅ Curiosidad generada: ${curiosidadCompleta.titulo}`);
    console.log(`📸 Imagen: ${curiosidadCompleta.imagenFuente} - ${curiosidadCompleta.imagen.substring(0, 60)}...`);
    
    return curiosidadCompleta;
}

// ============ 🎯 GEMINI GENERA ARTÍCULO CON PRODUCTO ============
async function generarArticuloConGemini(url, imagenUrl = '', categoria = 'kitchen') {
    const asin = extraerASIN(url);
    const nombreProducto = `Smart ${categoria.charAt(0).toUpperCase() + categoria.slice(1)} Essential`;
    
    const prompt = `
    Escribe un ARTÍCULO VIRAL estilo NY Post/Business Insider para mujeres de USA.
    
    PRODUCTO: ${nombreProducto}
    LINK: ${url}
    
    ESTRUCTURA JSON:
    {
        "titulo": "Título clickbait que golpee (máx 70 caracteres)",
        "intro": "Frase que enganche en 3 segundos",
        "problema": "El problema que cuesta dinero/tiempo a las americanas",
        "solucion": "Cómo este producto lo resuelve",
        "prueba_social": "Testimonio con nombre y ciudad (ej: Sarah from Manhattan)",
        "cierre": "Frase que genere FOMO",
        "curiosidad": "Dato impactante sobre el producto o tendencia",
        "palabras_clave": ["palabra1", "palabra2", "palabra3"]
    }
    
    TONO: AGGRESSIVE, CONTROVERSIAL, COMO REVELANDO UN SECRETO.
    `;
    
    const fallback = {
        titulo: `Americans Are Quietly Replacing Their ${categoria} — And It's Saving Them Thousands`,
        intro: "Here's something that will make you furious about how much money you've been throwing away...",
        problema: "The average American household loses over $2,300 annually on kitchen waste and inefficiency.",
        solucion: `This $299 innovation is the secret that wealthy families have been using to eliminate waste entirely.`,
        prueba_social: "NYC homeowners report saving up to 4 hours a week after making the switch.",
        cierre: "While your neighbors are still throwing money away, you could be part of the 78% who already made the change.",
        curiosidad: "The average American spends 38 DAYS per year dealing with kitchen waste.",
        palabras_clave: [categoria, "smart home", "USA", "save money"]
    };
    
    if (!model) return fallback;
    
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const contenido = JSON.parse(cleanJson);
        console.log('🔥 Gemini generó artículo viral');
        return contenido;
    } catch (error) {
        console.log('⚠️ Error Gemini artículo:', error.message);
        return fallback;
    }
}

// ============ GENERAR ARTÍCULO COMPLETO ============
async function generarArticuloDuro(url, imagenUrl = '', categoria = "kitchen") {
    const asin = extraerASIN(url);
    
    // Gemini genera el contenido del artículo
    const contenido = await generarArticuloConGemini(url, imagenUrl, categoria);
    
    // Usar la imagen que el usuario puso (prioridad)
    let imagen = imagenUrl;
    let imagenFuente = 'manual';
    
    // Si no hay imagen manual y hay ASIN, buscar imagen real de Amazon
    if (!imagen && asin) {
        const patrones = [
            `https://m.media-amazon.com/images/I/61${asin}._AC_SL1500_.jpg`,
            `https://m.media-amazon.com/images/I/71${asin}._AC_SL1500_.jpg`,
            `https://m.media-amazon.com/images/I/81${asin}._AC_SL1500_.jpg`,
            `https://m.media-amazon.com/images/I/51${asin}._AC_SL1500_.jpg`
        ];
        
        for (const urlImg of patrones) {
            try {
                const response = await axios.head(urlImg, { timeout: 3000 });
                if (response.status === 200) {
                    imagen = urlImg;
                    imagenFuente = 'amazon';
                    console.log(`✅ Imagen Amazon encontrada: ${urlImg.substring(0, 60)}...`);
                    break;
                }
            } catch(e) {}
        }
    }
    
    // Si aún no hay imagen, placeholder
    if (!imagen) {
        imagen = `https://picsum.photos/seed/${asin || Date.now()}/800/600`;
        imagenFuente = 'placeholder';
        console.log(`📸 Usando placeholder para imagen del artículo`);
    }
    
    // Construir HTML completo del artículo
    const htmlCompleto = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${contenido.titulo}</title>
    <meta name="description" content="${contenido.curiosidad}">
    <meta name="keywords" content="${contenido.palabras_clave.join(', ')}">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Georgia', 'Times New Roman', serif;
            background: #fff;
            color: #1a1a1a;
            line-height: 1.6;
        }
        .article-container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
        h1 { font-size: 2.5rem; line-height: 1.2; margin-bottom: 20px; font-weight: 700; }
        .lead { font-size: 1.2rem; color: #666; border-left: 4px solid #ff4500; padding-left: 20px; margin: 20px 0; }
        .viral-fact { background: #fff5f0; padding: 20px; border-radius: 12px; margin: 30px 0; border-left: 4px solid #ff4500; }
        .viral-fact strong { color: #ff4500; font-size: 1.1rem; }
        img { width: 100%; border-radius: 12px; margin: 30px 0; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        h2 { font-size: 1.5rem; margin: 30px 0 15px; }
        .btn-buy { display: inline-block; background: #ff4500; color: white; padding: 15px 30px; text-decoration: none; border-radius: 40px; font-weight: bold; margin: 30px 0; text-align: center; width: 100%; }
        .btn-buy:hover { background: #e03e00; transform: translateY(-2px); }
        .social-proof { background: #f8f8f8; padding: 20px; border-radius: 12px; margin: 30px 0; font-style: italic; border-left: 3px solid #ff4500; }
        .image-credit { font-size: 10px; color: #999; text-align: right; margin-top: -20px; margin-bottom: 20px; }
        footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; }
        @media (max-width: 600px) { h1 { font-size: 1.8rem; } }
    </style>
</head>
<body>
    <div class="article-container">
        <h1>${contenido.titulo}</h1>
        
        <div class="viral-fact">
            <strong>🔥 VIRAL FACT:</strong> ${contenido.curiosidad}
        </div>
        
        <img src="${imagen}" alt="${contenido.titulo}" onerror="this.src='https://picsum.photos/800/600'">
        <div class="image-credit">📸 ${imagenFuente === 'manual' ? 'Imagen del producto proporcionada' : imagenFuente === 'amazon' ? 'Imagen real del producto' : 'Imagen referencial'}</div>
        
        <div class="lead">${contenido.intro}</div>
        
        <h2>The Problem That's Costing Americans a Fortune</h2>
        <p>${contenido.problema}</p>
        
        <h2>The Simple Solution That's Changing Everything</h2>
        <p>${contenido.solucion}</p>
        
        <div class="social-proof">"${contenido.prueba_social}"</div>
        
        <h2>Why Everyone Is Making the Switch</h2>
        <p>${contenido.cierre}</p>
        
        <a href="${url}" class="btn-buy" target="_blank">🔴 CHECK PRICE ON AMAZON →</a>
        
        <footer>
            <p>As an Amazon Associate we earn from qualifying purchases.</p>
            <p>🔥 ${Math.floor(Math.random() * 100)} people are viewing this right now</p>
        </footer>
    </div>
</body>
</html>
    `;
    
    return {
        id: Date.now(),
        asin: asin,
        titulo: contenido.titulo,
        meta: contenido.curiosidad,
        contenido: htmlCompleto,
        imagen: imagen,
        imagenFuente: imagenFuente,
        curiosidad: contenido.curiosidad,
        palabras_clave: contenido.palabras_clave,
        link: url,
        fecha: new Date().toISOString(),
        clicks: 0
    };
}

// ============ ENDPOINTS ============

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        gemini: model ? 'active' : 'inactive'
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// 🎯 PUBLICAR ARTÍCULO (TÚ pones la imagen)
app.post('/api/publicar-articulo', async (req, res) => {
    try {
        const { url, imagenUrl, categoria } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        console.log('📝 Publicando artículo con Gemini...');
        console.log(`🔗 URL: ${url}`);
        console.log(`🖼️ Imagen: ${imagenUrl || 'auto-buscar'}`);
        
        const nuevoArticulo = await generarArticuloDuro(url, imagenUrl, categoria || 'kitchen');
        
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

// 🎯 GENERAR CURIOSIDAD CON IMAGEN
app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        console.log('✨ Generando curiosidad viral con imagen...');
        const nuevaCuriosidad = await generarCuriosidadCompleta();
        
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(nuevaCuriosidad);
        if (data.length > 30) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        
        console.log(`✅ Curiosidad: ${nuevaCuriosidad.titulo}`);
        console.log(`📸 Imagen: ${nuevaCuriosidad.imagenFuente}`);
        
        res.json({ success: true, curiosidad: nuevaCuriosidad });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener artículos
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

// Obtener curiosidades
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

// Ordenar artículos
app.put('/api/ordenar-articulos', (req, res) => {
    try {
        const { articulos: nuevosArticulos } = req.body;
        if (!nuevosArticulos || !Array.isArray(nuevosArticulos)) {
            return res.status(400).json({ success: false, error: 'Datos inválidos' });
        }
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(nuevosArticulos, null, 2));
        cache.clear();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Click tracking
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

// Compartir curiosidad
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

// ============ CRON - GENERAR CURIOSIDAD CADA 3 HORAS ============
async function generarCuriosidadAutomatica() {
    console.log('🤖 Bot: Generando curiosidad viral automática...');
    const nuevaCuriosidad = await generarCuriosidadCompleta();
    
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    data.unshift(nuevaCuriosidad);
    if (data.length > 30) data.pop();
    fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
    
    console.log(`✨ Nueva curiosidad publicada: ${nuevaCuriosidad.titulo}`);
}

cron.schedule('0 */3 * * *', () => {
    generarCuriosidadAutomatica();
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    const articulosCount = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const curiosidadesCount = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
    
    console.log(`
    ╔════════════════════════════════════════════════════════════════════╗
    ║     🔥🔥🔥 SISTEMA COMPLETO: ARTÍCULOS + CURIOSIDADES 🔥🔥🔥       ║
    ╠════════════════════════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                                                 ║
    ║  🤖 Gemini: ${model ? '✅ ACTIVADO' : '⚠️ NO DISPONIBLE'}                                         ║
    ║  📰 Artículos guardados: ${articulosCount} (TÚ pones la imagen)                         ║
    ║  💎 Curiosidades guardadas: ${curiosidadesCount} (Gemini + imagen automática)              ║
    ║  🖼️ Imágenes curiosidades: Unsplash + Google Images + Placeholders     ║
    ║  ⏰ Auto-curiosidades: CADA 3 HORAS                                    ║
    ║  📸 TÚ controlas las imágenes de los productos de Amazon               ║
    ╚════════════════════════════════════════════════════════════════════╝
    `);
    
    // Generar curiosidad inicial si no hay
    if (curiosidadesCount === 0) {
        console.log('📦 No hay curiosidades, generando primera...');
        setTimeout(() => generarCuriosidadAutomatica(), 3000);
    }
});
