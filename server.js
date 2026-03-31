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

// ============ CACHE ============
const cache = new Map();
const CACHE_TTL = 300000;

// ============ BOT GEMINI ============
let genAI;
let model;
try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-pro" });
    console.log('✅ Bot Gemini activado');
} catch (error) {
    console.log('⚠️ Bot Gemini no disponible');
}

// ============ RUTAS DE DATOS ============
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH    = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');

if (!fs.existsSync(DATA_DIR))            fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARTICULOS_PATH))      fs.writeFileSync(ARTICULOS_PATH,    JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH))   fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));

// ============ HELPER: EXTRAER ASIN ============
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

// ============ HELPER: BUSCAR IMAGEN PARA CURIOSIDAD ============
async function buscarImagenParaCuriosidad(promptImagen) {
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

    const placeholders = {
        kitchen: 'https://images.pexels.com/photos/2635038/pexels-photo-2635038.jpeg',
        luxury:  'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg',
        woman:   'https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg',
        default: 'https://images.pexels.com/photos/280229/pexels-photo-280229.jpeg'
    };
    let key = 'default';
    if (promptImagen.toLowerCase().includes('kitchen')) key = 'kitchen';
    if (promptImagen.toLowerCase().includes('luxury'))  key = 'luxury';
    if (promptImagen.toLowerCase().includes('woman'))   key = 'woman';
    return { url: placeholders[key], fuente: 'placeholder' };
}

// ============================================================
// MÓDULO 1 — CURIOSIDADES (BOT GEMINI AUTÓNOMO)
// mxl NO toca este módulo. Gemini genera TODO solo.
// ============================================================

async function generarCuriosidadConGemini() {
    const prompt = `
Actúa como redactor de alto impacto VISUAL para MXL GOLD MINER.

Genera una CURIOSIDAD BILINGÜE (ES/EN) para mujeres de alto poder adquisitivo en USA
(Manhattan, Miami, Beverly Hills) y diáspora dominicana.

REGLA CRÍTICA DE ESCRITURA VISUAL:
- Tu texto debe CONECTAR con una imagen de lujo que acompañará el post.
- Usa frases que inviten a mirar: "Como puedes ver en la imagen...", "Ese acabado que ves...", "El detalle que notas..."
- Describe SENSACIONES de tener el objeto, no solo el objeto.
- Lenguaje HIGH-END: como Vogue en español e inglés.

FORMATO JSON (solo JSON, sin nada más):
{
    "titulo_es": "Título magnético español máx 60 chars",
    "titulo_en": "Magnetic English title max 60 chars",
    "texto_es": "Curiosidad impactante en español - conecta con la imagen",
    "texto_en": "Shocking fact in English - connects with the visual",
    "descripcion_visual_es": "Párrafo que describe la imagen con lenguaje sensorial aspiracional (2-3 oraciones)",
    "descripcion_visual_en": "Visual description paragraph in English aspirational tone (2-3 sentences)",
    "imagen_prompt": "Prompt en inglés para buscar imagen en Unsplash/Google (ej: luxury kitchen marble countertop)"
}
    `;

    const fallback = {
        titulo_es: "El secreto que las mujeres de NYC esconden en sus hogares",
        titulo_en: "The secret NYC women hide in their homes",
        texto_es: "El 78% de las mujeres de Manhattan invierten más en tecnología para el hogar que en bolsos de lujo. Como puedes ver en la imagen, el nuevo lujo no se lleva — se vive.",
        texto_en: "78% of Manhattan women invest more in home tech than luxury handbags. As you can see, the new luxury isn't worn — it's lived.",
        descripcion_visual_es: "Ese acabado que ves en la imagen no es casualidad. Es la elección deliberada de una mujer que sabe que el verdadero estatus se siente desde adentro.",
        descripcion_visual_en: "That finish you see in the image is no accident. It's the deliberate choice of a woman who knows real status is felt from within.",
        imagen_prompt: "luxury modern kitchen marble woman NYC view elegant"
    };

    if (!model) return fallback;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const contenido = JSON.parse(cleanJson);
        console.log('✨ Bot Gemini: Curiosidad visual generada');
        return contenido;
    } catch (error) {
        console.log('⚠️ Error Gemini curiosidad:', error.message);
        return fallback;
    }
}

async function publicarCuriosidadAutomatica() {
    console.log('🤖 Bot Gemini: Publicando curiosidad automática...');
    const curiosidadGemini = await generarCuriosidadConGemini();
    const imagen = await buscarImagenParaCuriosidad(curiosidadGemini.imagen_prompt);

    const nuevaCuriosidad = {
        id: Date.now(),
        titulo_es: curiosidadGemini.titulo_es,
        titulo_en: curiosidadGemini.titulo_en,
        texto_es: curiosidadGemini.texto_es,
        texto_en: curiosidadGemini.texto_en,
        descripcion_visual_es: curiosidadGemini.descripcion_visual_es,
        descripcion_visual_en: curiosidadGemini.descripcion_visual_en,
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

// ============================================================
// MÓDULO 2 — PRODUCTOS (MXL PONE LINK + FOTO, GEMINI ESCRIBE)
// mxl provee: URL de Amazon + URL de imagen del producto
// Gemini provee: TODO el copy escrito, conectado con la imagen
// ============================================================

async function generarCopyProductoConGemini(url, imagenUrl, categoria, precio) {
    const prompt = `
Actúa como copywriter de alto impacto VISUAL para MXL GOLD MINER.

PRODUCTO AMAZON: ${url}
IMAGEN DEL PRODUCTO: ${imagenUrl}
CATEGORÍA: ${categoria || 'luxury home'}
PRECIO ESTIMADO: ${precio || 'Alto Ticket USA'}

MISIÓN: Escribir copy que haga que la lectora SIENTA que ya tiene ese producto.
Tu texto debe HABLAR CON LA IMAGEN que mxl seleccionó.

REGLAS DE ESCRITURA VISUAL OBLIGATORIAS:
1. Menciona partes visibles del producto: "Ese acabado que ves...", "La textura que notas en la imagen...", "El diseño que llama tu atención..."
2. Usa lenguaje sensorial: tacto, peso, brillo, elegancia percibida.
3. Conecta la imagen con un estilo de vida aspiracional.
4. Tono: Vogue meets WSJ. Nunca barato, nunca genérico.

FORMATO JSON ESTRICTO (solo JSON):
{
    "titulo": "Título SEO clickbait máx 70 chars",
    "intro": "Frase de enganche en 3 segundos - menciona algo visual del producto",
    "descripcion_visual": "Párrafo aspiracional describiendo lo que se VE en la imagen (3-4 oraciones)",
    "problema": "El problema costoso que este producto resuelve",
    "solucion": "Cómo lo resuelve - describe su apariencia premium visualmente",
    "beneficio_estatus": "El beneficio de estatus social - lenguaje sensorial",
    "prueba_social": "Testimonio con nombre y ciudad (ej: Valentina desde Miami)",
    "cierre": "Frase FOMO que mencione algo visible del producto",
    "curiosidad": "Dato impactante sobre este tipo de producto",
    "palabras_clave": ["luxury", "status", "smart home", "USA", "NYC", "Miami"]
}
    `;

    const fallback = {
        titulo: `The Premium Home Investment Taking Over Manhattan in 2026`,
        intro: "There's a detail in this image that women in NYC's Upper East Side can't stop talking about.",
        descripcion_visual: "Look at the finish you see in the image — that's not a coincidence. Every curve, every material choice speaks to a woman who has stopped settling. This is what intentional luxury looks like in 2026.",
        problema: "You've been spending thousands on items that impress others for seconds, while your home tells a different story.",
        solucion: "This investment piece — the one you see right here — is what separates the homes that are simply expensive from the ones that feel truly exceptional.",
        beneficio_estatus: "Women who own this don't explain it. They let the space speak.",
        prueba_social: "Valentina from Miami: 'I've had guests ask who my designer is. It's just this one piece. That's the secret.'",
        cierre: "While others are still decorating, you could be curating. The difference is visible.",
        curiosidad: "Interior designers in Manhattan report that women are now prioritizing 3 signature home pieces over an entire wardrobe refresh.",
        palabras_clave: ["luxury home", "status symbol", "NYC elite", "Miami luxury", "premium home", "high ticket"]
    };

    if (!model) return fallback;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const copy = JSON.parse(cleanJson);
        console.log('🔥 Bot Gemini: Copy visual generado para mxl');
        return copy;
    } catch (error) {
        console.log('⚠️ Error Gemini copy:', error.message);
        return fallback;
    }
}

function generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy) {
    const paddingMap = { small: '40px', medium: '20px', large: '10px' };
    const imgPadding = paddingMap[imageSize] || '20px';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${copy.titulo}</title>
    <meta name="description" content="${copy.curiosidad}">
    <meta name="keywords" content="${(copy.palabras_clave || []).join(', ')}">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&display=swap');
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Lato',sans-serif; background:#fffaf7; color:#1a1a1a; line-height:1.7; }
        .hero { background:linear-gradient(135deg,#1a1a2e,#16213e); padding:60px 20px; text-align:center; }
        .hero h1 { font-family:'Playfair Display',serif; font-size:2.4rem; color:#fff; max-width:800px; margin:0 auto 20px; line-height:1.25; }
        .hero .viral-fact { display:inline-block; background:#ff4500; color:#fff; padding:10px 22px; border-radius:40px; font-size:13px; font-weight:700; margin-top:10px; }
        .article-body { max-width:800px; margin:0 auto; padding:50px 20px; }
        .intro-lead { font-family:'Playfair Display',serif; font-size:1.25rem; color:#4a3727; border-left:4px solid #ff4500; padding-left:20px; margin:30px 0; font-style:italic; line-height:1.6; }
        .product-image-wrap { text-align:${imagePosition || 'center'}; margin:35px 0; background:#faf7f3; border-radius:20px; padding:${imgPadding}; }
        .product-image-wrap img { max-width:100%; border-radius:12px; object-fit:contain; ${imageSize === 'large' ? 'max-height:600px;' : imageSize === 'small' ? 'max-height:280px;' : 'max-height:420px;'} }
        .visual-description { background:linear-gradient(135deg,#fff5f0,#fdf0e8); border-left:4px solid #c9a87b; padding:25px 25px 25px 30px; border-radius:0 16px 16px 0; margin:30px 0; font-family:'Playfair Display',serif; font-style:italic; color:#4a3727; font-size:1.05rem; line-height:1.7; }
        h2 { font-family:'Playfair Display',serif; font-size:1.6rem; color:#2c2418; margin:40px 0 15px; }
        p { color:#3a2e24; margin-bottom:18px; font-size:1rem; }
        .social-proof { background:#fff; border:1px solid #f0e2d8; border-left:4px solid #ff4500; padding:25px; border-radius:0 16px 16px 0; margin:35px 0; font-style:italic; color:#6b5a48; }
        .social-proof strong { color:#2c2418; display:block; margin-top:12px; font-style:normal; font-size:0.9rem; }
        .btn-buy { display:block; background:linear-gradient(135deg,#ff4500,#ff6b35); color:#fff; padding:18px 35px; text-decoration:none; border-radius:50px; font-weight:700; text-align:center; margin:40px 0; font-size:1.1rem; letter-spacing:0.5px; transition:all .3s; box-shadow:0 8px 25px rgba(255,69,0,.3); }
        .btn-buy:hover { transform:translateY(-2px); box-shadow:0 12px 30px rgba(255,69,0,.4); }
        .curiosity-box { background:#1a1a2e; color:#fff; padding:25px; border-radius:16px; margin:30px 0; text-align:center; }
        .curiosity-box .icon { font-size:2rem; margin-bottom:10px; }
        .curiosity-box p { color:rgba(255,255,255,.85); font-size:0.95rem; }
        footer { margin-top:60px; padding:30px 0; border-top:1px solid #f0e2d8; font-size:11px; color:#aaa; text-align:center; }
        @media(max-width:600px){ .hero h1{font-size:1.6rem} }
    </style>
</head>
<body>
    <div class="hero">
        <h1>${copy.titulo}</h1>
        <span class="viral-fact">🔥 ${copy.curiosidad}</span>
    </div>
    <div class="article-body">
        <div class="intro-lead">${copy.intro}</div>

        <div class="product-image-wrap">
            <img src="${imagenUrl}" alt="${copy.titulo}" loading="lazy">
        </div>

        <div class="visual-description">
            ✨ ${copy.descripcion_visual}
        </div>

        <h2>The Problem That's Costing You Status</h2>
        <p>${copy.problema}</p>

        <h2>Why This Changes Everything</h2>
        <p>${copy.solucion}</p>

        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow noopener">
            🔴 CHECK PRICE ON AMAZON →
        </a>

        <h2>The New Status Signal</h2>
        <p>${copy.beneficio_estatus}</p>

        <div class="social-proof">
            "${copy.prueba_social}"
            <strong>⭐⭐⭐⭐⭐ Verified Purchase</strong>
        </div>

        <div class="curiosity-box">
            <div class="icon">💎</div>
            <p>${copy.cierre}</p>
        </div>

        <a href="${url}" class="btn-buy" target="_blank" rel="nofollow noopener">
            🔥 GET IT ON AMAZON →
        </a>

        <footer>
            <p>As an Amazon Associate we earn from qualifying purchases. | © 2026 MXL GOLD MINER</p>
        </footer>
    </div>
</body>
</html>`;
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// --- CURIOSIDADES (Bot Gemini solo) ---

app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const nuevaCuriosidad = await publicarCuriosidadAutomatica();
        res.json({ success: true, curiosidad: nuevaCuriosidad });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/curiosidades', (req, res) => {
    const cached = cache.get('curiosidades');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        cache.set('curiosidades', { data, timestamp: Date.now() });
        res.json(data);
    } catch(e) { res.json([]); }
});

app.post('/api/compartir-curiosidad/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        const i = data.findIndex(c => c.id == req.params.id);
        if (i !== -1) {
            data[i].compartidas = (data[i].compartidas || 0) + 1;
            fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

// --- PRODUCTOS (mxl pone link + foto, Gemini escribe) ---

// PASO 1: mxl envía URL Amazon + URL imagen → Gemini genera copy
app.post('/api/generar-copy-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, precio } = req.body;
        if (!url)       return res.status(400).json({ success: false, error: 'URL de Amazon requerida' });
        if (!imagenUrl) return res.status(400).json({ success: false, error: 'URL de imagen requerida — mxl debe seleccionarla' });

        console.log('📝 mxl envió link + imagen → Gemini generando copy visual...');
        const copy = await generarCopyProductoConGemini(url, imagenUrl, categoria, precio);

        res.json({
            success: true,
            copy,
            mensaje: '✅ mxl: Revisa el copy. Si apruebas, llama a /api/publicar-producto'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PASO 2: mxl aprueba y publica
app.post('/api/publicar-producto', async (req, res) => {
    try {
        const { url, imagenUrl, categoria, imageSize, imagePosition, copy } = req.body;

        if (!url)       return res.status(400).json({ success: false, error: 'URL Amazon requerida' });
        if (!imagenUrl) return res.status(400).json({ success: false, error: 'URL imagen requerida' });
        if (!copy)      return res.status(400).json({ success: false, error: 'Copy requerido — genera primero con /api/generar-copy-producto' });

        console.log('💰 mxl publicando producto...');

        const htmlCompleto = generarHTMLArticulo(url, imagenUrl, categoria, imageSize, imagePosition, copy);

        const nuevoArticulo = {
            id: Date.now(),
            asin: extraerASIN(url),
            titulo: copy.titulo,
            meta: copy.curiosidad,
            intro: copy.intro,
            curiosidad: copy.curiosidad,
            contenido: htmlCompleto,
            imagen: imagenUrl,
            imageSize: imageSize || 'medium',
            imagePosition: imagePosition || 'center',
            categoria: categoria || 'LUXURY',
            link: url,
            fecha: new Date().toISOString(),
            clicks: 0
        };

        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));

        cache.clear();
        console.log(`✅ Producto publicado: ${nuevoArticulo.titulo}`);
        res.json({ success: true, articulo: nuevoArticulo });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/articulos', (req, res) => {
    const cached = cache.get('articulos');
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        cache.set('articulos', { data, timestamp: Date.now() });
        res.json(data);
    } catch(e) { res.json([]); }
});

app.put('/api/ordenar-articulos', (req, res) => {
    try {
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(req.body.articulos, null, 2));
        cache.clear();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/click-articulo/:id', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const i = data.findIndex(a => a.id == req.params.id);
        if (i !== -1) {
            data[i].clicks = (data[i].clicks || 0) + 1;
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

// ============================================================
// CRON — Curiosidades cada 3 horas (solo Gemini)
// ============================================================
cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ CRON: Bot Gemini publicando curiosidad automática...');
    await publicarCuriosidadAutomatica();
});

// ============================================================
// ARRANQUE
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    const artCount  = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    const curCount  = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH)).length;

    console.log(`
╔══════════════════════════════════════════════════════════╗
║         🏮 MXL GOLD MINER — SISTEMA HÍBRIDO 🏮          ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  💎 CURIOSIDADES (Bot Gemini autónomo)                  ║
║     ✅ Genera curiosidad + imagen cada 3 horas          ║
║     ✅ Texto conectado visualmente con la imagen        ║
║     📊 ${String(curCount).padEnd(3)} curiosidades guardadas               ║
║                                                          ║
║  💰 PRODUCTOS (mxl link+foto → Gemini escribe)          ║
║     ✅ mxl elige link Amazon                            ║
║     ✅ mxl selecciona foto del producto                 ║
║     🤖 Gemini escribe copy visual conectado             ║
║     📊 ${String(artCount).padEnd(3)} productos publicados                 ║
║                                                          ║
║  🚀 Puerto: ${PORT}                                        ║
║  🤖 Bot Gemini: ${model ? '✅ ACTIVADO     ' : '⚠️ NO DISPONIBLE'}               ║
╚══════════════════════════════════════════════════════════╝
    `);

    if (curCount === 0) {
        console.log('📦 Generando primera curiosidad automática...');
        setTimeout(() => publicarCuriosidadAutomatica(), 3000);
    }
});
