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

// Cache
const cache = new Map();
const CACHE_TTL = 300000;

// Gemini
let genAI;
let model;
try {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-pro" });
    console.log('✅ Gemini inicializado');
} catch (error) {
    console.log('⚠️ Gemini no disponible');
}

// Configuración de almacenamiento persistente
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const CONFIG_PATH = path.join(DATA_DIR, 'bot-config.json');

// Crear directorios
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));
if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        enabled: true,
        schedule: '0 */2 * * *', // Cada 2 horas
        lastRun: null,
        category: ['kitchen', 'smart-home', 'lifestyle', 'wedding', 'sustainability']
    }));
}

// ============ CATÁLOGO DE PRODUCTOS AMAZON USA ============
const amazonProducts = [
    { asin: "B0C3H7K2X1", name: "Smart Composter", category: "kitchen", price: "$499" },
    { asin: "B09Y2X8W4V", name: "Air Purifier", category: "smart-home", price: "$299" },
    { asin: "B08K7J5H3G", name: "Smart Mirror", category: "lifestyle", price: "$399" },
    { asin: "B07M9N2P4R", name: "Robot Vacuum", category: "smart-home", price: "$599" },
    { asin: "B0B5Z9L3W7", name: "Smart Lock", category: "security", price: "$199" },
    { asin: "B0A8K4M2N6", name: "Smart Lighting", category: "lifestyle", price: "$89" },
    { asin: "B09X7K3P1M", name: "Indoor Composter", category: "kitchen", price: "$349" },
    { asin: "B08R2H6W9T", name: "Smart Coffee Maker", category: "kitchen", price: "$199" },
    { asin: "B07K5L3P2N", name: "Smart Thermostat", category: "smart-home", price: "$249" }
];

// ============ PROMPT OPTIMIZADO PARA SEO USA ============
function generateSEOPrompt(product, category) {
    return `
Actúa como periodista senior de Business Insider / NY Post especializado en tendencias de consumo en Estados Unidos.

Genera un artículo SEO optimizado para Google USA sobre este producto:

PRODUCTO: ${product.name} (ASIN: ${product.asin})
CATEGORÍA: ${category}
PRECIO: ${product.price}

REQUERIMIENTOS OBLIGATORIOS:

1. TÍTULO (SEO Title): máximo 65 caracteres, debe generar click. Usar formato:
   - "Americans Are Quietly Replacing [X] With This — And It's Saving Them $Y in 2026"
   - "Why Every [City] Homeowner Is Switching to [Product]"
   - "The $[Price] Gadget That's Selling Out Across America"

2. META DESCRIPTION: máximo 160 caracteres, incluir keyword principal y beneficio.

3. SLUG: formato /[keyword]-trend-usa-2026

4. KEYWORDS PRINCIPALES (5-7):
   - Incluir: "USA", "American homes", "2026 trends", "[category] gadgets"

5. ESTRUCTURA DEL ARTÍCULO:

[H1] Título principal

[INTRO - Hook emocional]
- Dato impactante sobre hábitos de consumo americano
- Estadística o tendencia realista
- Conectar con el problema que resuelve el producto

[H2] The Problem That's Costing Americans Time and Money
- Describir el problema actual
- Datos sobre desperdicio/ineficiencia
- Frustración que siente el consumidor

[H2] Why [City/Region] Families Are Making the Switch
- Testimonio aspiracional
- Beneficios tangibles
- Comparación antes/después

[H2] What Makes [Product] Different
- Características clave del producto
- Por qué es superior a alternativas
- Tecnología/innovación

[H2] The Verdict: Is It Worth the Investment?
- Análisis costo-beneficio
- ROI emocional y financiero
- Comparación con precios de mercado

[CIERRE - Call to Action]
- Urgencia (stock limitado, tendencia creciente)
- Enlace a Amazon
- Frase de cierre aspiracional

6. TONO:
- Periodístico, no promocional
- Datos realistas (ej: "according to recent surveys", "homeowners report")
- Persuasivo pero creíble

7. IMAGEN SUGERIDA:
Prompt para IA: "modern American ${category} scene, ${product.name} in luxury home, natural lighting, lifestyle photography, 4K"

Responde SOLO con JSON válido en este formato:
{
  "titulo": "",
  "meta": "",
  "slug": "",
  "keywords": [],
  "contenido": "",
  "imagen_prompt": ""
}
`;
}

// ============ FUNCIÓN PRINCIPAL: GENERAR ARTÍCULO SEO USA ============
async function generateSEOArticle() {
    // Seleccionar producto aleatorio
    const product = amazonProducts[Math.floor(Math.random() * amazonProducts.length)];
    
    const prompt = generateSEOPrompt(product, product.category);
    
    try {
        if (!model) {
            return generateFallbackArticle(product);
        }
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Limpiar y parsear JSON
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const content = JSON.parse(cleanJson);
        
        // Construir artículo completo
        return {
            id: Date.now(),
            asin: product.asin,
            titulo: content.titulo,
            meta: content.meta,
            slug: content.slug,
            keywords: content.keywords,
            contenido: content.contenido,
            imagen: `https://images-na.ssl-images-amazon.com/images/I/51${product.asin}._AC_SL1500_.jpg`,
            imagenPrompt: content.imagen_prompt,
            productName: product.name,
            productPrice: product.price,
            link: `https://amazon.com/dp/${product.asin}`,
            fecha: new Date().toISOString(),
            categoria: product.category,
            clicks: 0,
            publicadoPor: 'bot-usa-seo'
        };
        
    } catch (error) {
        console.error('Error generando artículo:', error);
        return generateFallbackArticle(product);
    }
}

// Fallback si Gemini falla
function generateFallbackArticle(product) {
    const titles = [
        `Americans Are Quietly Replacing Their ${product.category} With This $${product.price} Gadget`,
        `Why Every Modern Home in America Needs This $${product.price} ${product.name}`,
        `The ${product.name} Trend Taking Over American Homes in 2026`
    ];
    
    return {
        id: Date.now(),
        asin: product.asin,
        titulo: titles[Math.floor(Math.random() * titles.length)],
        meta: `Discover why American homeowners are switching to ${product.name}. Save money, reduce waste, and upgrade your ${product.category} with this innovative $${product.price} solution.`,
        slug: `${product.name.toLowerCase().replace(/\s+/g, '-')}-trend-usa-2026`,
        keywords: [product.category, "USA homes", "2026 trends", "smart home", "American lifestyle"],
        contenido: `
<h2>The Problem That's Costing Americans Time and Money</h2>
<p>Recent surveys show that American households spend an average of $2,300 annually on inefficiencies in their ${product.category}. From wasted energy to time-consuming manual processes, homeowners are actively seeking smarter solutions.</p>

<h2>Why NYC Families Are Making the Switch</h2>
<p>"I didn't realize how much time I was wasting until I tried this," says Sarah from Manhattan. "Now I have more time for what matters." The ${product.name} is becoming the must-have item for discerning homeowners across the United States.</p>

<h2>What Makes ${product.name} Different</h2>
<p>Priced at ${product.price}, this innovative solution combines cutting-edge technology with intuitive design. Unlike traditional alternatives, it offers features that actually simplify your daily routine rather than complicate it.</p>

<h2>The Verdict: Is It Worth the Investment?</h2>
<p>Considering the average American spends ${Math.floor(Number(product.price.replace('$', '')) * 3)} over three years on outdated solutions, the ${product.price} investment pays for itself in just months. Add the convenience factor, and it's a no-brainer for modern households.</p>

<p>Ready to upgrade your ${product.category}? <a href="https://amazon.com/dp/${product.asin}" target="_blank">Check the latest price on Amazon →</a></p>
        `,
        imagenPrompt: `modern American ${product.category} scene, ${product.name} in luxury home, natural lighting`,
        productName: product.name,
        productPrice: product.price,
        link: `https://amazon.com/dp/${product.asin}`,
        fecha: new Date().toISOString(),
        categoria: product.category,
        clicks: 0,
        publicadoPor: 'bot-fallback'
    };
}

// ============ PUBLICAR ARTÍCULO GENERADO ============
async function publicarArticuloAutomatico() {
    console.log('🤖 Bot SEO USA: Generando nuevo artículo...');
    
    try {
        const nuevoArticulo = await generateSEOArticle();
        
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(nuevoArticulo);
        
        // Mantener solo últimos 100 artículos
        if (data.length > 100) data.pop();
        
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        
        // Actualizar configuración
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH));
        config.lastRun = new Date().toISOString();
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        
        console.log(`✅ Artículo publicado: "${nuevoArticulo.titulo}"`);
        console.log(`📊 Keywords: ${nuevoArticulo.keywords.join(', ')}`);
        
        cache.clear();
        
        return nuevoArticulo;
        
    } catch (error) {
        console.error('❌ Error en publicación automática:', error);
        return null;
    }
}

// ============ ENDPOINTS ============

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        gemini: model ? 'active' : 'inactive',
        articulos: JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
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

// Publicar artículo manual
app.post('/api/publicar-articulo', async (req, res) => {
    try {
        const { url, imagenUrl, imageSize, imagePosition } = req.body;
        
        if (url) {
            // Si viene URL, usar producto de Amazon específico
            const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
            if (asinMatch) {
                const product = amazonProducts.find(p => p.asin === asinMatch[1]) || {
                    asin: asinMatch[1],
                    name: "Amazon Product",
                    category: "home",
                    price: "$0"
                };
                const nuevoArticulo = await generateSEOArticleForProduct(product);
                const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
                data.unshift(nuevoArticulo);
                fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
                cache.clear();
                return res.json({ success: true, articulo: nuevoArticulo });
            }
        }
        
        // Si no hay URL específica, generar automático
        const nuevoArticulo = await generateSEOArticle();
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        cache.clear();
        res.json({ success: true, articulo: nuevoArticulo });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

async function generateSEOArticleForProduct(product) {
    const prompt = generateSEOPrompt(product, product.category);
    
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const content = JSON.parse(cleanJson);
        
        return {
            id: Date.now(),
            asin: product.asin,
            titulo: content.titulo,
            meta: content.meta,
            slug: content.slug,
            keywords: content.keywords,
            contenido: content.contenido,
            imagen: `https://images-na.ssl-images-amazon.com/images/I/51${product.asin}._AC_SL1500_.jpg`,
            link: `https://amazon.com/dp/${product.asin}`,
            fecha: new Date().toISOString(),
            categoria: product.category,
            clicks: 0,
            publicadoPor: 'manual'
        };
    } catch (error) {
        return generateFallbackArticle(product);
    }
}

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

// Editar artículo
app.put('/api/editar-articulo/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const index = data.findIndex(a => a.id == id);
        if (index !== -1) {
            data[index] = { ...data[index], ...updates };
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            cache.clear();
            res.json({ success: true, articulo: data[index] });
        } else {
            res.status(404).json({ success: false, error: 'No encontrado' });
        }
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

// Obtener curiosidades
app.get('/api/curiosidades', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

// Generar curiosidad
app.post('/api/generar-curiosidad', async (req, res) => {
    try {
        const curiosidadesBase = [
            { titulo: "Americans Are Spending Less on Designer Bags, More on This", dato: "Sales of smart home devices have increased 156% since 2024" },
            { titulo: "The Kitchen Trend That's Saving NYC Families $2,000/Year", dato: "Smart composters reduce food waste by 73%" }
        ];
        const random = curiosidadesBase[Math.floor(Math.random() * curiosidadesBase.length)];
        const curiosidadCompleta = {
            id: Date.now(),
            ...random,
            fecha: new Date().toISOString(),
            compartidas: 0
        };
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
        data.unshift(curiosidadCompleta);
        if (data.length > 30) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true, curiosidad: curiosidadCompleta });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para capturar carrusel
app.post('/api/capturar-carrusel', async (req, res) => {
    try {
        const { url } = req.body;
        const asinMatch = url?.match(/(?:dp|product)\/([A-Z0-9]{10})/);
        if (!asinMatch) {
            return res.status(400).json({ success: false, error: 'No se pudo extraer ASIN' });
        }
        
        const imagenes = [];
        const variantes = ['51', '61', '71', '81', '91'];
        for (const variant of variantes) {
            imagenes.push({
                url: `https://images-na.ssl-images-amazon.com/images/I/${variant}${asinMatch[1]}._AC_SL1500_.jpg`,
                tipo: 'carrusel'
            });
        }
        
        res.json({
            success: true,
            asin: asinMatch[1],
            imagenes: imagenes,
            video: { embedUrl: url, thumbnail: imagenes[0]?.url }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ CRON JOBS ============
// Publicar cada 2 horas
cron.schedule('0 */2 * * *', async () => {
    console.log('⏰ CRON: Ejecutando Bot SEO USA...');
    await publicarArticuloAutomatico();
});

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    const articulosCount = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    console.log(`
    ╔═══════════════════════════════════════════════════════════════╗
    ║     🔥 BOT SEO USA - SISTEMA DE INGRESOS AUTOMÁTICOS 🔥      ║
    ╠═══════════════════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                                            ║
    ║  🤖 Gemini: ${model ? '✅ ACTIVADO' : '❌ NO DISPONIBLE'}                    ║
    ║  📰 Artículos generados: ${articulosCount}                                 ║
    ║  ⏰ Auto-publicación: CADA 2 HORAS (Bot activo)               ║
    ║  🎯 SEO USA: Títulos clickbait + Keywords estratégicas        ║
    ║  💰 Monetización: Amazon Affiliate integrado                  ║
    ║  💾 Datos persistentes: ${DATA_DIR}                           ║
    ╚═══════════════════════════════════════════════════════════════╝
    `);
    
    // Publicar un artículo inicial si no hay
    if (articulosCount === 0) {
        console.log('📦 No hay artículos, generando primero...');
        setTimeout(() => publicarArticuloAutomatico(), 3000);
    }
});
