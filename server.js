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

// Cache
const cache = new Map();
const CACHE_TTL = 300000;

// Configuración de APIs
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

// Gemini DURO
let genAI;
let model;
try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
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

// ============ 🆕 BÚSQUEDA DE NOTICIAS REALES CON NEWS API ============
async function buscarNoticiasReales(categoria) {
    if (!NEWS_API_KEY) return null;
    
    const queries = {
        kitchen: 'smart kitchen USA',
        'smart-home': 'smart home technology USA',
        lifestyle: 'home lifestyle trends USA',
        wedding: 'wedding registry essentials',
        default: 'home trends USA'
    };
    
    const query = queries[categoria] || queries.default;
    
    try {
        const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: query,
                apiKey: NEWS_API_KEY,
                language: 'en',
                sortBy: 'relevancy',
                pageSize: 3
            },
            timeout: 8000
        });
        
        if (response.data.articles && response.data.articles.length > 0) {
            console.log(`📰 Encontradas ${response.data.articles.length} noticias reales sobre ${categoria}`);
            return response.data.articles;
        }
    } catch (error) {
        console.log('⚠️ Error News API:', error.message);
    }
    return null;
}

// ============ 🆕 BÚSQUEDA DE IMÁGENES CON GOOGLE CUSTOM SEARCH ============
async function buscarImagenGoogle(producto, categoria) {
    if (!GOOGLE_API_KEY || !GOOGLE_CX) return null;
    
    try {
        const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: {
                key: GOOGLE_API_KEY,
                cx: GOOGLE_CX,
                q: `${producto} ${categoria} luxury home`,
                searchType: 'image',
                num: 3,
                imgSize: 'large',
                safe: 'active'
            },
            timeout: 8000
        });
        
        if (response.data.items && response.data.items.length > 0) {
            console.log(`📸 Google Images: encontradas ${response.data.items.length} imágenes`);
            return {
                url: response.data.items[0].link,
                fuente: 'google',
                titulo: response.data.items[0].title
            };
        }
    } catch (error) {
        console.log('⚠️ Error Google Images:', error.message);
    }
    return null;
}

// ============ 🆕 BÚSQUEDA DE IMÁGENES CON UNSPLASH ============
async function buscarImagenUnsplash(producto, categoria) {
    if (!UNSPLASH_ACCESS_KEY) return null;
    
    try {
        const response = await axios.get('https://api.unsplash.com/search/photos', {
            params: {
                query: `luxury ${categoria} ${producto} modern home`,
                per_page: 3,
                orientation: 'landscape'
            },
            headers: { 'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}` },
            timeout: 8000
        });
        
        if (response.data.results && response.data.results.length > 0) {
            console.log(`📸 Unsplash: imagen encontrada`);
            return {
                url: response.data.results[0].urls.regular,
                fuente: 'unsplash',
                credit: response.data.results[0].user.name
            };
        }
    } catch (error) {
        console.log('⚠️ Error Unsplash:', error.message);
    }
    return null;
}

// ============ BÚSQUEDA DE IMÁGENES REALES DE AMAZON ============
async function buscarImagenAmazonReal(asin) {
    const patronesImagenes = [
        `https://m.media-amazon.com/images/I/61${asin}._AC_SL1500_.jpg`,
        `https://m.media-amazon.com/images/I/71${asin}._AC_SL1500_.jpg`,
        `https://m.media-amazon.com/images/I/81${asin}._AC_SL1500_.jpg`,
        `https://m.media-amazon.com/images/I/51${asin}._AC_SL1500_.jpg`,
        `https://m.media-amazon.com/images/I/61${asin}._AC_SX679_.jpg`,
        `https://images-na.ssl-images-amazon.com/images/I/61${asin}._AC_SL1500_.jpg`
    ];
    
    for (const url of patronesImagenes) {
        try {
            const response = await axios.head(url, { timeout: 3000 });
            if (response.status === 200) {
                console.log(`✅ Imagen Amazon encontrada: ${url.substring(0, 80)}...`);
                return { url, fuente: 'amazon', tipo: 'producto_real' };
            }
        } catch(e) {}
    }
    
    // Scraping como último recurso
    try {
        const { data } = await axios.get(`https://www.amazon.com/dp/${asin}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 5000
        });
        
        const matchAlta = data.match(/"hiRes":"(https:[^"]+)"/);
        if (matchAlta) {
            return { url: matchAlta[1].replace(/\\/g, ''), fuente: 'amazon_scrape', tipo: 'producto_real' };
        }
        
        const matchDinamico = data.match(/data-a-dynamic-image="({.+?})"/);
        if (matchDinamico) {
            const imagenes = JSON.parse(matchDinamico[1].replace(/&quot;/g, '"'));
            const urls = Object.keys(imagenes);
            if (urls.length > 0) return { url: urls[0], fuente: 'amazon_carrusel', tipo: 'producto_real' };
        }
    } catch(e) {}
    
    return null;
}

// ============ FUNCIÓN PRINCIPAL: OBTENER LA MEJOR IMAGEN ============
async function obtenerMejorImagen(asin, categoria, producto) {
    // 1. Prioridad: imagen real del producto en Amazon
    const imagenAmazon = await buscarImagenAmazonReal(asin);
    if (imagenAmazon) return imagenAmazon;
    
    // 2. Google Images
    const imagenGoogle = await buscarImagenGoogle(producto, categoria);
    if (imagenGoogle) return imagenGoogle;
    
    // 3. Unsplash
    const imagenUnsplash = await buscarImagenUnsplash(producto, categoria);
    if (imagenUnsplash) return imagenUnsplash;
    
    // 4. Placeholders por categoría
    const placeholders = {
        kitchen: 'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
        'smart-home': 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
        lifestyle: 'https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg',
        wedding: 'https://images.pexels.com/photos/1024967/pexels-photo-1024967.jpeg',
        default: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg'
    };
    
    return {
        url: placeholders[categoria] || placeholders.default,
        fuente: 'placeholder',
        tipo: 'fallback'
    };
}

// ============ PROMPT GEMINI DURO CON NOTICIAS REALES ============
function generarPromptDuro(producto, categoria, asin, noticias) {
    let contextoNoticias = '';
    if (noticias && noticias.length > 0) {
        contextoNoticias = `\n\nNOTICIAS REALES SOBRE EL TEMA:\n${noticias.map(n => `- ${n.title}`).join('\n')}\n`;
    }
    
    return `
Actúa como periodista de NEW YORK POST / BUSINESS INSIDER. Escribe un artículo VIRAL que haga que la gente NO PUEDA DEJAR DE LEER.

PRODUCTO: ${producto}
CATEGORÍA: ${categoria}
ASIN: ${asin}
${contextoNoticias}

REGLAS DE ORO:
1. TÍTULO: debe golpear con dato impactante o cambio de hábito (máx 70 caracteres)
2. INTRO: enganchar en 3 segundos con un problema que duele
3. CURIOSIDAD: un dato que haga decir "OMG" (usar las noticias reales si están disponibles)
4. PRUEBA SOCIAL: testimonio realista con nombre y ciudad
5. CIERRE: generar FOMO (miedo a quedarse fuera)

ESTRUCTURA JSON:
{
    "titulo": "",
    "intro": "",
    "problema": "",
    "solucion": "",
    "prueba_social": "",
    "cierre": "",
    "curiosidad": "",
    "palabras_clave": []
}

TONO: AGGRESSIVE, CONTROVERSIAL, COMO REVELANDO UN SECRETO QUE NADIE QUIERE QUE SEPAS.
`;
}

// ============ GENERAR ARTÍCULO DURO COMPLETO ============
async function generarArticuloDuro(url, categoria = "kitchen") {
    const asin = extraerASIN(url);
    const nombreProducto = `Smart ${categoria.charAt(0).toUpperCase() + categoria.slice(1)} Essential`;
    
    // Buscar noticias reales sobre la categoría
    const noticiasReales = await buscarNoticiasReales(categoria);
    
    // Obtener la mejor imagen
    const imagen = await obtenerMejorImagen(asin, categoria, nombreProducto);
    console.log(`📸 Imagen seleccionada: ${imagen.fuente}`);
    
    // Contenido por defecto (fallback)
    let contenido = {
        titulo: `Americans Are Quietly Replacing Their ${categoria} — And It's Saving Them Thousands`,
        intro: "Here's something that will make you furious about how much money you've been throwing away...",
        problema: "The average American household loses over $2,300 annually on kitchen waste and inefficiency.",
        solucion: `This $299 innovation is the secret that wealthy families have been using to eliminate waste entirely.`,
        prueba_social: "NYC homeowners report saving up to 4 hours a week after making the switch.",
        cierre: "While your neighbors are still throwing money away, you could be part of the 78% who already made the change.",
        curiosidad: "The average American spends 38 DAYS per year dealing with kitchen waste.",
        palabras_clave: [categoria, "smart home", "USA", "save money", "2026 trends"]
    };
    
    // Usar Gemini si está disponible
    if (model) {
        try {
            const prompt = generarPromptDuro(nombreProducto, categoria, asin, noticiasReales);
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            const geminiContent = JSON.parse(cleanJson);
            contenido = { ...contenido, ...geminiContent };
            console.log('🔥 Gemini generó contenido DURO');
        } catch (error) {
            console.log('⚠️ Error Gemini, usando plantilla:', error.message);
        }
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
        .article-container {
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        h1 {
            font-size: 2.5rem;
            line-height: 1.2;
            margin-bottom: 20px;
            font-weight: 700;
        }
        .lead {
            font-size: 1.2rem;
            color: #666;
            border-left: 4px solid #ff4500;
            padding-left: 20px;
            margin: 20px 0;
        }
        .viral-fact {
            background: #fff5f0;
            padding: 20px;
            border-radius: 12px;
            margin: 30px 0;
            border-left: 4px solid #ff4500;
        }
        .viral-fact strong {
            color: #ff4500;
            font-size: 1.1rem;
        }
        img {
            width: 100%;
            border-radius: 12px;
            margin: 30px 0;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        h2 {
            font-size: 1.5rem;
            margin: 30px 0 15px;
        }
        .btn-buy {
            display: inline-block;
            background: #ff4500;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 40px;
            font-weight: bold;
            margin: 30px 0;
            text-align: center;
            transition: all 0.3s;
            width: 100%;
        }
        .btn-buy:hover {
            background: #e03e00;
            transform: translateY(-2px);
        }
        .social-proof {
            background: #f8f8f8;
            padding: 20px;
            border-radius: 12px;
            margin: 30px 0;
            font-style: italic;
            border-left: 3px solid #ff4500;
        }
        .image-credit {
            font-size: 10px;
            color: #999;
            text-align: right;
            margin-top: -20px;
            margin-bottom: 20px;
        }
        footer {
            margin-top: 60px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            font-size: 12px;
            color: #999;
        }
        @media (max-width: 600px) {
            h1 { font-size: 1.8rem; }
        }
    </style>
</head>
<body>
    <div class="article-container">
        <h1>${contenido.titulo}</h1>
        
        <div class="viral-fact">
            <strong>🔥 VIRAL FACT:</strong> ${contenido.curiosidad}
        </div>
        
        <img src="${imagen.url}" alt="${contenido.titulo}" onerror="this.src='https://picsum.photos/800/600'">
        <div class="image-credit">📸 ${imagen.fuente === 'amazon' ? 'Imagen real del producto' : 'Imagen de referencia'}</div>
        
        <div class="lead">
            ${contenido.intro}
        </div>
        
        <h2>The Problem That's Costing Americans a Fortune</h2>
        <p>${contenido.problema}</p>
        
        <h2>The Simple Solution That's Changing Everything</h2>
        <p>${contenido.solucion}</p>
        
        <div class="social-proof">
            "${contenido.prueba_social}"
        </div>
        
        <h2>Why Everyone Is Making the Switch</h2>
        <p>${contenido.cierre}</p>
        
        <a href="${url}" class="btn-buy" target="_blank">🔴 CHECK PRICE ON AMAZON →</a>
        
        <footer>
            <p>As an Amazon Associate we earn from qualifying purchases. Prices and availability subject to change.</p>
            <p style="margin-top: 10px;">🔥 ${Math.floor(Math.random() * 100)} people are viewing this right now</p>
            ${noticiasReales ? `<p style="margin-top: 10px; font-size: 10px;">📰 Trending now: ${noticiasReales[0]?.title.substring(0, 60)}...</p>` : ''}
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
        imagen: imagen.url,
        imagenFuente: imagen.fuente,
        curiosidad: contenido.curiosidad,
        palabras_clave: contenido.palabras_clave,
        link: url,
        fecha: new Date().toISOString(),
        clicks: 0,
        viral_score: Math.floor(Math.random() * 100),
        noticias_referencia: noticiasReales ? noticiasReales.slice(0, 2).map(n => n.title) : []
    };
}

// ============ GENERAR CURIOSIDAD VIRAL ============
async function generarCuriosidadViral() {
    const curiosidades = [
        "Americans throw away $2,300 worth of food per household every year — enough to buy this device twice.",
        "The average person spends 38 DAYS per year dealing with kitchen waste.",
        "78% of NYC homeowners say their kitchen is now their favorite room after making one simple change.",
        "Smart home device sales have increased 156% since 2024.",
        "Why Upper East Side families are judging their neighbors by what ISN'T in their trash.",
        "The $0 trash movement is taking over Beverly Hills — here's what they're using.",
        "Miami homeowners are saving 4 hours a week with this one kitchen upgrade."
    ];
    
    const random = curiosidades[Math.floor(Math.random() * curiosidades.length)];
    
    return {
        id: Date.now(),
        texto: random,
        fecha: new Date().toISOString(),
        viral: true
    };
}

// ============ ENDPOINTS ============

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        gemini: model ? 'active' : 'inactive',
        newsApi: NEWS_API_KEY ? 'active' : 'inactive',
        googleImages: GOOGLE_API_KEY && GOOGLE_CX ? 'active' : 'inactive',
        unsplash: UNSPLASH_ACCESS_KEY ? 'active' : 'inactive',
        articulos: JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// Publicar artículo
app.post('/api/publicar-articulo', async (req, res) => {
    try {
        const { url, categoria } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        console.log('🔥 Generando artículo DURO para:', url);
        const nuevoArticulo = await generarArticuloDuro(url, categoria || 'kitchen');
        
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

// Ordenar artículos
app.put('/api/ordenar-articulos', (req, res) => {
    try {
        const { articulos: nuevosArticulos } = req.body;
        if (!nuevosArticulos || !Array.isArray(nuevosArticulos)) {
            return res.status(400).json({ success: false, error: 'Datos inválidos' });
        }
        
        const articulosConOrden = nuevosArticulos.map((art, idx) => ({
            ...art,
            orden: idx,
            fecha: new Date(Date.now() - idx * 60000).toISOString()
        }));
        
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(articulosConOrden, null, 2));
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

// Generar curiosidad
app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const nuevaCuriosidad = await generarCuriosidadViral();
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(nuevaCuriosidad);
        if (data.length > 30) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true, curiosidad: nuevaCuriosidad });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/curiosidades', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

// Endpoint para capturar carrusel de imágenes
app.post('/api/capturar-carrusel', async (req, res) => {
    try {
        const { url } = req.body;
        const asin = extraerASIN(url);
        
        if (!asin) {
            return res.status(400).json({ success: false, error: 'No se pudo extraer ASIN' });
        }
        
        const imagenPrincipal = await buscarImagenAmazonReal(asin);
        
        const imagenesCarrusel = [];
        const variantes = ['51', '61', '71', '81', '91'];
        for (const variant of variantes) {
            const urlImg = `https://m.media-amazon.com/images/I/${variant}${asin}._AC_SL1500_.jpg`;
            try {
                const response = await axios.head(urlImg, { timeout: 2000 });
                if (response.status === 200) {
                    imagenesCarrusel.push({ url: urlImg, tipo: 'carrusel' });
                }
            } catch(e) {}
        }
        
        res.json({
            success: true,
            asin: asin,
            imagenPrincipal: imagenPrincipal?.url || null,
            imagenesCarrusel: imagenesCarrusel.slice(0, 5)
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ CRON - PUBLICAR CADA 2 HORAS ============
const productosAutomaticos = [
    { url: "https://amazon.com/dp/B0C3H7K2X1", categoria: "kitchen" },
    { url: "https://amazon.com/dp/B09Y2X8W4V", categoria: "smart-home" },
    { url: "https://amazon.com/dp/B08K7J5H3G", categoria: "lifestyle" },
    { url: "https://amazon.com/dp/B0B5Z9L3W7", categoria: "smart-home" },
    { url: "https://amazon.com/dp/B0A8K4M2N6", categoria: "kitchen" },
    { url: "https://amazon.com/dp/B09X7K3P1M", categoria: "kitchen" },
    { url: "https://amazon.com/dp/B08R2H6W9T", categoria: "kitchen" },
    { url: "https://amazon.com/dp/B07K5L3P2N", categoria: "smart-home" }
];

async function publicarAutomatico() {
    console.log('🤖 Bot DURO: Generando artículo viral automático...');
    
    const random = productosAutomaticos[Math.floor(Math.random() * productosAutomaticos.length)];
    const nuevoArticulo = await generarArticuloDuro(random.url, random.categoria);
    
    const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
    data.unshift(nuevoArticulo);
    if (data.length > 50) data.pop();
    fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
    
    console.log(`🔥 ARTÍCULO VIRAL: ${nuevoArticulo.titulo}`);
    console.log(`📸 Imagen: ${nuevoArticulo.imagenFuente}`);
    console.log(`📊 Viral Score: ${nuevoArticulo.viral_score}`);
}

// Programar publicación cada 2 horas
cron.schedule('0 */2 * * *', () => {
    publicarAutomatico();
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    const articulosCount = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    console.log(`
    ╔══════════════════════════════════════════════════════════════════════════╗
    ║     🔥🔥🔥 ARTÍCULOS VIRALES USA - SISTEMA COMPLETO 🔥🔥🔥             ║
    ╠══════════════════════════════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                                                       ║
    ║  🤖 Gemini: ${model ? '✅ ACTIVADO' : '⚠️ NO DISPONIBLE'}                                    ║
    ║  📰 News API: ${NEWS_API_KEY ? '✅ ACTIVADO' : '❌ NO CONFIGURADO'}                                ║
    ║  📸 Google Images: ${GOOGLE_API_KEY && GOOGLE_CX ? '✅ ACTIVADO' : '❌ NO CONFIGURADO'}                       ║
    ║  🖼️ Unsplash: ${UNSPLASH_ACCESS_KEY ? '✅ ACTIVADO' : '❌ NO CONFIGURADO'}                                   ║
    ║  📰 Artículos guardados: ${articulosCount}                                                 ║
    ║  ⏰ Auto-publicación: CADA 2 HORAS                                              ║
    ║  🎯 Títulos que golpean: ✅                                                        ║
    ║  🔥 Curiosidades virales: ✅                                                       ║
    ║  💰 Monetización: Amazon Affiliate integrado                                       ║
    ╚══════════════════════════════════════════════════════════════════════════════╝
    `);
    
    // Publicar un artículo inicial si no hay
    if (articulosCount === 0) {
        console.log('📦 No hay artículos, generando primero...');
        setTimeout(() => publicarAutomatico(), 3000);
    }
});
