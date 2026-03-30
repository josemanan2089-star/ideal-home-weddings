const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const DB_PATH = path.join(__dirname, 'productos.json');

if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

// RUTAS PRINCIPALES
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/mxl-panel-2026.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'mxl-panel-2026.html'));
});

// ENDPOINT PARA PUBLICAR CON GEMINI
app.post('/api/publicar-con-ia', async (req, res) => {
    try {
        const { url, customImage, imageSize, imagePosition } = req.body;
        
        // Extraer ASIN de Amazon
        let asin = '';
        const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
        if (asinMatch) asin = asinMatch[1];
        
        // Prompt para Gemini
        const prompt = `
        Actúa como experto en copywriting de lujo para revista de hogar en USA.
        Genera contenido para este producto de Amazon (ASIN: ${asin || 'desconocido'}).
        
        Formato JSON:
        {
            "title_en": "Título corto y magnético (máx 60 caracteres)",
            "title_es": "Título en español igual de magnético",
            "curiosity_en": "Una curiosidad de lujo que enganche al lector de NYC/Miami/Beverly Hills (2-3 líneas)",
            "curiosity_es": "Misma curiosidad en español",
            "description_en": "Descripción seductora que termine con llamado a la acción (4-5 líneas)",
            "description_es": "Descripción en español",
            "seo_keywords": ["palabras", "clave", "en", "inglés"]
        }
        
        Tono: Sofisticado, aspiracional, "silent luxury", para mujeres de alto poder adquisitivo.
        Enfoque: Hogar, decoración, cocina, tecnología invisible, sostenibilidad de lujo.
        `;
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Limpiar y parsear JSON
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const iaContent = JSON.parse(cleanJson);
        
        // Guardar producto con configuraciones visuales
        const nuevoProducto = {
            id: Date.now(),
            asin: asin,
            title_en: iaContent.title_en,
            title_es: iaContent.title_es,
            curiosity_en: iaContent.curiosity_en,
            curiosity_es: iaContent.curiosity_es,
            description_en: iaContent.description_en,
            description_es: iaContent.description_es,
            image: customImage || `https://images-na.ssl-images-amazon.com/images/I/51${asin}._AC_.jpg`,
            imageSize: imageSize || 'medium',
            imagePosition: imagePosition || 'center',
            link: url,
            seo_keywords: iaContent.seo_keywords || [],
            fecha: new Date().toISOString(),
            views: 0,
            clicks: 0
        };
        
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        data.unshift(nuevoProducto);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        
        res.json({ success: true, producto: nuevoProducto });
        
    } catch (error) {
        console.error('Error Gemini:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT PARA EDITAR PRODUCTO (imagen, tamaño, posición)
app.put('/api/editar-producto/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { image, imageSize, imagePosition, title_en, title_es, description_en, description_es } = req.body;
        
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const index = data.findIndex(p => p.id == id);
        
        if (index !== -1) {
            if (image) data[index].image = image;
            if (imageSize) data[index].imageSize = imageSize;
            if (imagePosition) data[index].imagePosition = imagePosition;
            if (title_en) data[index].title_en = title_en;
            if (title_es) data[index].title_es = title_es;
            if (description_en) data[index].description_en = description_en;
            if (description_es) data[index].description_es = description_es;
            
            fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
            res.json({ success: true, producto: data[index] });
        } else {
            res.status(404).json({ success: false, error: 'Producto no encontrado' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT PARA CONTADOR DE CLICKS
app.post('/api/click/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const index = data.findIndex(p => p.id == id);
        if (index !== -1) {
            data[index].clicks = (data[index].clicks || 0) + 1;
            fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

app.get('/api/productos', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        res.json(data);
    } catch (e) {
        res.json([]);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 MXL GOLD MINER ONLINE EN PUERTO ${PORT}`);
});
