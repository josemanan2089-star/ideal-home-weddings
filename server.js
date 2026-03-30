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
    console.log('✅ Gemini activado - Redactor Creativo de Alto Impacto');
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

// ============ FUNCIÓN AUXILIAR ============
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

// ============ 🎯 MÓDULO 1: CURIOSIDADES (100% AUTÓNOMO) ============
async function buscarImagenParaCuriosidad(promptImagen) {
    // Unsplash
    if (process.env.UNSPLASH_ACCESS_KEY) {
        try {
            const response = await axios.get('https://api.unsplash.com/search/photos', {
                params: { query: promptImagen, per_page: 1, orientation: 'landscape' },
                headers: { 'Authorization': `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
                timeout: 5000
            });
            if (response.data.results?.length > 0) {
                return { url: response.data.results[0].urls.regular, fuente: 'unsplash' };
            }
        } catch(e) {}
    }
    
    // Google Images
    if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) {
        try {
            const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
                params: {
                    key: process.env.GOOGLE_API_KEY,
                    cx: process.env.GOOGLE_CX,
                    q: promptImagen,
                    searchType: 'image',
                    num: 1,
                    imgSize: 'large'
                },
                timeout: 5000
            });
            if (response.data.items?.length > 0) {
                return { url: response.data.items[0].link, fuente: 'google' };
            }
        } catch(e) {}
    }
    
    // Placeholder temático
    const placeholders = {
        kitchen: 'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
        luxury: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
        woman: 'https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg',
        default: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg'
    };
    
    let key = 'default';
    if (promptImagen.toLowerCase().includes('kitchen')) key = 'kitchen';
    if (promptImagen.toLowerCase().includes('luxury')) key = 'luxury';
    if (promptImagen.toLowerCase().includes('woman')) key = 'woman';
    
    return { url: placeholders[key], fuente: 'placeholder' };
}

async function generarCuriosidadAutonoma() {
    const prompt = `
    Actúa como redactor creativo de alto impacto para MXL GOLD MINER.
    
    Genera una CURIOSIDAD para "El Farol al Día" dirigida a:
    - Mujeres de alto poder adquisitivo en USA (Manhattan, Miami, Beverly Hills)
    - Diáspora dominicana en NY/NJ
    
    La curiosidad debe ser BILINGÜE (ES/EN) sobre lujo, tecnología invisible, estatus.
    
    FORMATO JSON:
    {
        "titulo_es": "Título magnético español (max 60)",
        "titulo_en": "Magnetic title English (max 60)",
        "texto_es": "Dato impactante español",
        "texto_en": "Shocking fact English",
        "imagen_prompt": "Prompt para imagen impactante"
    }
    `;
    
    const fallback = {
        titulo_es: "El secreto que las mujeres de NYC esconden",
        titulo_en: "The secret NYC women hide",
        texto_es: "El 78% de las mujeres de Manhattan invierten más en tecnología para el hogar que en bolsos de lujo.",
        texto_en: "78% of Manhattan women invest more in home tech than luxury handbags.",
        imagen_prompt: "luxury modern kitchen, elegant woman, NYC view"
    };
    
    if (!model) return fallback;
    
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const contenido = JSON.parse(cleanJson);
        console.log('✨ Curiosidad autónoma generada');
        return contenido;
    } catch (error) {
        console.log('⚠️ Error:', error.message);
        return fallback;
    }
}

async function publicarCuriosidadAutonoma() {
    console.log('🤖 Bot: Generando curiosidad autónoma...');
    const curiosidadGemini = await generarCuriosidadAutonoma();
    const imagen = await buscarImagenParaCuriosidad(curiosidadGemini.imagen_prompt);
    
    const nuevaCuriosidad = {
        id: Date.now(),
        titulo_es: curiosidadGemini.titulo_es,
        titulo_en: curiosidadGemini.titulo_en,
        texto_es: curiosidadGemini.texto_es,
        texto_en: curiosidadGemini.texto_en,
        imagen: imagen.url,
        imagenFuente: imagen.fuente,
        fecha: new Date().toISOString(),
        compartidas: 0
    };
    
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    data.unshift(nuevaCuriosidad);
    if (data.length > 30) data.pop();
    fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
    
    console.log(`✨ Nueva curiosidad: ${nuevaCuriosidad.titulo_es}`);
    return nuevaCuriosidad;
}

// ============ 🎯 MÓDULO 2: VENTAS (ASISTENTE - mxl controla) ============
async function generarCopyVentas(url, categoria, precio) {
    const prompt = `
    Actúa como copywriter de alto impacto para MXL GOLD MINER.
    
    PRODUCTO: ${url}
    CATEGORÍA: ${categoria || 'lujo'}
    PRECIO: ${precio || 'Alto Ticket USA ($500-$1,500)'}
    
    Genera el "VENENO" de ventas en JSON:
    {
        "titulo": "Título SEO clickbait (max 70 chars)",
        "intro": "Frase que enganche en 3 segundos",
        "problema": "El problema que cuesta dinero/tiempo/estatus",
        "solucion": "Cómo este producto resuelve el problema",
        "beneficio_estatus": "El beneficio de estatus social",
        "prueba_social": "Testimonio con nombre y ciudad",
        "cierre": "Frase que genere FOMO",
        "curiosidad": "Dato impactante",
        "palabras_clave": []
    }
    
    PALABRAS CLAVE: luxury, status, smart home, USA, NYC, Miami, elite
    `;
    
    const fallback = {
        titulo: `The $${precio?.replace('$', '') || '1,200'} Status Symbol Taking Over Manhattan`,
        intro: "There's a new way women in NYC are showing they've 'made it'.",
        problema: "You've been spending thousands on items that impress others for seconds.",
        solucion: `This $${precio?.replace('$', '') || '1,200'} innovation is the secret wealthy families use.`,
        beneficio_estatus: "Join the elite circle of women who understand true status is lived, not shown.",
        prueba_social: "Carolina from NYC: 'This is my secret. My friends can't stop asking about my home.'",
        cierre: "While others chase trends, you could be setting them.",
        curiosidad: "Women in Manhattan now invest 156% more in home tech than designer bags.",
        palabras_clave: ["luxury", "status", "smart home", "USA", "NYC"]
    };
    
    if (!model) return fallback;
    
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const copy = JSON.parse(cleanJson);
        console.log('🔥 Copy de ventas generado para mxl');
        return copy;
    } catch (error) {
        console.log('⚠️ Error:', error.message);
        return fallback;
    }
}

async function generarArticuloVentaCompleto(url, imagenUrl, categoria, imageSize, imagePosition, copy) {
    const htmlCompleto = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${copy.titulo}</title>
    <meta name="description" content="${copy.curiosidad}">
    <meta name="keywords" content="${copy.palabras_clave.join(', ')}">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Georgia', serif; background: #fff; color: #1a1a1a; line-height: 1.6; }
        .article-container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
        h1 { font-size: 2.5rem; line-height: 1.2; margin-bottom: 20px; }
        .lead { font-size: 1.2rem; color: #666; border-left: 4px solid #ff4500; padding-left: 20px; margin: 20px 0; }
        .viral-fact { background: #fff5f0; padding: 20px; border-radius: 12px; margin: 30px 0; border-left: 4px solid #ff4500; }
        img { width: 100%; border-radius: 12px; margin: 30px 0; object-fit: contain; ${imageSize === 'large' ? 'max-height: 600px;' : imageSize === 'small' ? 'max-height: 300px;' : 'max-height: 450px;'} }
        .image-container { text-align: ${imagePosition}; }
        h2 { font-size: 1.5rem; margin: 30px 0 15px; }
        .btn-buy { display: block; background: #ff4500; color: white; padding: 15px 30px; text-decoration: none; border-radius: 40px; font-weight: bold; text-align: center; margin: 30px 0; }
        .social-proof { background: #f8f8f8; padding: 20px; border-radius: 12px; margin: 30px 0; font-style: italic; border-left: 3px solid #ff4500; }
        footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; }
    </style>
</head>
<body>
    <div class="article-container">
        <h1>${copy.titulo}</h1>
        <div class="viral-fact"><strong>🔥 VIRAL FACT:</strong> ${copy.curiosidad}</div>
        <div class="image-container"><img src="${imagenUrl}" alt="${copy.titulo}"></div>
        <div class="lead">${copy.intro}</div>
        <h2>The Problem That's Costing Americans a Fortune</h2>
        <p>${copy.problema}</p>
        <h2>The Solution That's Changing Everything</h2>
        <p>${copy.solucion}</p>
        <h2>Why This Is the New Status Symbol</h2>
        <p>${copy.beneficio_estatus}</p>
        <div class="social-proof">"${copy.prueba_social}"</div>
        <h2>Why Everyone Is Making the Switch</h2>
        <p>${copy.cierre}</p>
        <a href="${url}" class="btn-buy" target="_blank">🔴 CHECK PRICE ON AMAZON →</a>
        <footer><p>As an Amazon Associate we earn from qualifying purchases.</p></footer>
    </div>
</body>
</html>
    `;
    
    return {
        id: Date.now(),
        asin: extraerASIN(url),
        titulo: copy.titulo,
        meta: copy.curiosidad,
        contenido: htmlCompleto,
        imagen: imagenUrl,
        imageSize: imageSize,
        imagePosition: imagePosition,
        link: url,
        fecha: new Date().toISOString(),
        clicks: 0
    };
}

// ============ ENDPOINTS ============

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// 🎯 ENDPOINT PARA CURIOSIDADES (AUTÓNOMO)
app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const nuevaCuriosidad = await publicarCuriosidadAutonoma();
        res.json({ success: true, curiosidad: nuevaCuriosidad });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🎯 ENDPOINT PARA GENERAR COPY DE VENTAS (mxl lo usa para obtener texto)
app.post('/api/generar-copy-ventas', async (req, res) => {
    try {
        const { url, categoria, precio } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        console.log('📝 mxl solicita copy para producto de alto ticket');
        const copy = await generarCopyVentas(url, categoria, precio);
        
        res.json({ 
            success: true, 
            copy: copy,
            mensaje: "mxl: Revisa el copy. Si te gusta, pega la imagen URL y publica desde el panel."
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🎯 ENDPOINT PARA PUBLICAR VENTA (mxl controla imagen, tamaño, posición)
app.post('/api/publicar-venta', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, imageSize, imagePosition, copy } = req.body;
        
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        if (!imagenUrl) {
            return res.status(400).json({ success: false, error: 'Imagen requerida - mxl debe seleccionarla' });
        }
        if (!copy) {
            return res.status(400).json({ success: false, error: 'Copy requerido - genera primero con /generar-copy-ventas' });
        }
        
        console.log('💰 mxl publicando producto de alto ticket');
        console.log(`🖼️ Imagen seleccionada: ${imagenUrl}`);
        console.log(`📐 Tamaño: ${imageSize} | Posición: ${imagePosition}`);
        
        const nuevoArticulo = await generarArticuloVentaCompleto(url, imagenUrl, categoria, imageSize, imagePosition, copy);
        
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

// ============ CRON - CURIOSIDADES CADA 3 HORAS (AUTÓNOMO) ============
cron.schedule('0 */3 * * *', async () => {
    console.log('🤖 CRON: Generando curiosidad autónoma...');
    await publicarCuriosidadAutonoma();
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    const articulosCount = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const curiosidadesCount = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;
    
    console.log(`
    ╔══════════════════════════════════════════════════════════════════════════╗
    ║     🏮 MXL GOLD MINER - SISTEMA HÍBRIDO 🏮                               ║
    ╠══════════════════════════════════════════════════════════════════════════╣
    ║                                                                          ║
    ║  💎 MÓDULO CURIOSIDADES (100% AUTÓNOMO - DeepSeek):                     ║
    ║     ✅ Genera curiosidades bilingües ES/EN                               ║
    ║     ✅ Busca imágenes automáticamente (Unsplash/Google)                  ║
    ║     ✅ Publica cada 3 horas - Flujo continuo a Google News               ║
    ║     📊 Curiosidades guardadas: ${curiosidadesCount}                              ║
    ║                                                                          ║
    ║  💰 MÓDULO VENTAS (100% CONTROL mxl):                                   ║
    ║     ✅ mxl elige productos de alto ticket ($500-$1,500)                  ║
    ║     ✅ mxl selecciona la imagen que representa el lujo                   ║
    ║     ✅ mxl define tamaño y posición                                      ║
    ║     🤖 DeepSeek SOLO redacta el copy (asistente)                        ║
    ║     📊 Artículos publicados: ${articulosCount}                                   ║
    ║                                                                          ║
    ║  🎯 PÚBLICO: Manhattan, Miami, Beverly Hills + Diáspora dominicana      ║
    ║  🚀 Puerto: ${PORT}                                                      ║
    ║  🤖 Gemini: ${model ? '✅ ACTIVADO' : '⚠️ NO DISPONIBLE'}                                         ║
    ╚══════════════════════════════════════════════════════════════════════════╝
    `);
    
    // Generar curiosidad inicial si no hay
    if (curiosidadesCount === 0) {
        console.log('📦 Generando primera curiosidad...');
        setTimeout(() => publicarCuriosidadAutonoma(), 3000);
    }
});
