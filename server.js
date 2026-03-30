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

// Archivos con volumen persistente
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, 'data');

const ARTICULOS_PATH = path.join(DATA_DIR, 'articulos.json');
const CURIOSIDADES_PATH = path.join(DATA_DIR, 'curiosidades.json');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Crear directorios
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Inicializar archivos
if (!fs.existsSync(ARTICULOS_PATH)) fs.writeFileSync(ARTICULOS_PATH, JSON.stringify([]));
if (!fs.existsSync(CURIOSIDADES_PATH)) fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify([]));

// ============ PLANTILLAS ============
const plantillasCuriosidades = [
    {
        titulo: "El secreto que las mujeres de NYC esconden en su cocina",
        dato: "El 78% de las mujeres de alto poder adquisitivo en Manhattan consideran que un composter de lujo es más importante que un auto europeo en 2026.",
        reflexion: "Porque el verdadero estatus ya no se muestra en el garaje, sino en lo que NO sale de tu cocina.",
        cierre: "Las mujeres que saben, ya tienen el suyo. ¿Tú también quieres ser de las que saben?"
    },
    {
        titulo: "La tendencia que está eliminando las bolsas de basura en Beverly Hills",
        dato: "El 63% de las casas de lujo en Beverly Hills ya han eliminado por completo los desechos orgánicos de sus bolsas de basura.",
        reflexion: "En 2026, tener una casa 'zero-waste' es el nuevo símbolo de estatus silencioso que todas quieren mostrar.",
        cierre: "Mientras tus vecinas siguen sacando bolsas apestosas, tú ya estás en el futuro del lujo sostenible."
    },
    {
        titulo: "El gadget que está reemplazando a los bolsos de diseñador en Miami",
        dato: "Las mujeres de Miami están invirtiendo más en tecnología para el hogar que en bolsos de lujo. El aumento es del 156% desde 2024.",
        reflexion: "Porque el verdadero lujo ahora se vive en casa, no se lleva puesto. La comodidad es el nuevo estatus.",
        cierre: "Las mujeres que saben, ya tienen el suyo. ¿Te unes al club de las que invierten en su hogar?"
    }
];

const plantillasArticulos = [
    {
        titulo: "The Silent Luxury Revolution: Why NYC Women Are Ditching Designer Bags",
        intro: "There's a new status symbol in town, and it doesn't go on your arm—it goes in your kitchen.",
        problema: "You've been spending thousands on items that impress others for 5 seconds, while your home remains cluttered and inefficient.",
        solucion: "This revolutionary appliance transforms your daily routine into a seamless luxury experience.",
        beneficio: "Join the elite circle of women who understand true status isn't shown, it's lived.",
        cierre: "The women who know, already have theirs. Will you be next?"
    }
];

// ============ FUNCIONES ============
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

// Función para capturar carrusel SIN axios (usando fetch nativo)
async function capturarCarruselAmazon(asin) {
    try {
        const imagenes = [];
        
        // Generar URLs de imágenes de Amazon
        const variantes = ['51', '61', '71', '81', '91'];
        for (const variant of variantes) {
            imagenes.push({
                url: `https://images-na.ssl-images-amazon.com/images/I/${variant}${asin}._AC_SL1500_.jpg`,
                tipo: 'carrusel',
                calidad: 'alta'
            });
        }
        
        return {
            success: true,
            imagenes: imagenes,
            videoUrl: `https://www.amazon.com/dp/${asin}`,
            asin: asin
        };
        
    } catch (error) {
        console.error('Error capturando carrusel:', error);
        return {
            success: false,
            imagenes: [],
            videoUrl: null,
            asin: asin
        };
    }
}

async function generarCuriosidadFemenina() {
    const indice = Math.floor(Math.random() * plantillasCuriosidades.length);
    return plantillasCuriosidades[indice];
}

async function generarArticuloConProducto(url, imagenUrl = '', imageSize = 'medium', imagePosition = 'center') {
    const asin = extraerASIN(url);
    const plantilla = plantillasArticulos[0];
    
    // Capturar carrusel si hay ASIN
    let imagenesCarrusel = [];
    if (asin) {
        const carrusel = await capturarCarruselAmazon(asin);
        if (carrusel.success) {
            imagenesCarrusel = carrusel.imagenes.slice(0, 5);
        }
    }
    
    return {
        id: Date.now(),
        asin: asin,
        titulo: plantilla.titulo,
        intro: plantilla.intro,
        problema: plantilla.problema,
        solucion: plantilla.solucion,
        beneficio: plantilla.beneficio,
        cierre: plantilla.cierre,
        imagen: imagenUrl || (imagenesCarrusel[0]?.url || `https://picsum.photos/400/300`),
        imagenesCarrusel: imagenesCarrusel,
        imageSize: imageSize,
        imagePosition: imagePosition,
        link: url,
        fecha: new Date().toISOString(),
        clicks: 0,
        orden: 0
    };
}

// ============ ENDPOINTS ============

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        dataPath: DATA_DIR,
        articulos: JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// API para capturar carrusel
app.post('/api/capturar-carrusel', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        const asin = extraerASIN(url);
        if (!asin) {
            return res.status(400).json({ success: false, error: 'No se pudo extraer ASIN' });
        }
        
        const carrusel = await capturarCarruselAmazon(asin);
        
        res.json({
            success: true,
            asin: asin,
            imagenes: carrusel.imagenes,
            video: { embedUrl: carrusel.videoUrl, thumbnail: carrusel.imagenes[0]?.url }
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/articulos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/publicar-articulo', async (req, res) => {
    try {
        const { url, imagenUrl, imageSize, imagePosition } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'URL requerida' });
        }
        
        const nuevoArticulo = await generarArticuloConProducto(url, imagenUrl, imageSize, imagePosition);
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        data.unshift(nuevoArticulo);
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
        
        res.json({ success: true, articulo: nuevoArticulo });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/ordenar-articulos', (req, res) => {
    try {
        const { articulos: nuevosArticulos } = req.body;
        if (!nuevosArticulos || !Array.isArray(nuevosArticulos)) {
            return res.status(400).json({ success: false, error: 'Datos inválidos' });
        }
        
        fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(nuevosArticulos, null, 2));
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/editar-articulo/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const data = JSON.parse(fs.readFileSync(ARTICULOS_PATH));
        const index = data.findIndex(a => a.id == id);
        
        if (index !== -1) {
            data[index] = { ...data[index], ...updates };
            fs.writeFileSync(ARTICULOS_PATH, JSON.stringify(data, null, 2));
            res.json({ success: true, articulo: data[index] });
        } else {
            res.status(404).json({ success: false, error: 'No encontrado' });
        }
    } catch (error) {
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

app.get('/api/curiosidades', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
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
        if (data.length > 30) data.pop();
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true, curiosidad: curiosidadCompleta });
    } catch (error) {
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

// ============ INICIAR SERVIDOR ============
app.listen(PORT, '0.0.0.0', () => {
    const articulosCount = JSON.parse(fs.readFileSync(ARTICULOS_PATH)).length;
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║     ✨ SISTEMA CON ALMACENAMIENTO PERSISTENTE ✨        ║
    ╠══════════════════════════════════════════════════════════╣
    ║  🚀 Puerto: ${PORT}                                       ║
    ║  💾 Datos persistentes en: ${DATA_DIR}                    ║
    ║  📰 Artículos guardados: ${articulosCount}                ║
    ║  🎬 Captura de carrusel: ✅ ACTIVADO (sin axios)         ║
    ║  💾 Los datos NO se pierden al redeployar                ║
    ╚══════════════════════════════════════════════════════════╝
    `);
    
    // Inicializar con contenido si está vacío
    const data = JSON.parse(fs.readFileSync(CURIOSIDADES_PATH));
    if (data.length === 0) {
        console.log('📦 Inicializando con plantillas...');
        for (const plantilla of plantillasCuriosidades.slice(0, 3)) {
            const curiosidad = {
                id: Date.now() + Math.random(),
                ...plantilla,
                fecha: new Date().toISOString(),
                compartidas: 0
            };
            data.push(curiosidad);
        }
        fs.writeFileSync(CURIOSIDADES_PATH, JSON.stringify(data, null, 2));
        console.log('✅ Cargadas 3 curiosidades iniciales');
    }
});
