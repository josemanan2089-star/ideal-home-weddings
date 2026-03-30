const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, '/')));

const DB_PATH = path.join(__dirname, 'productos.json');

// Crear DB si no existe
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

// RUTA PRINCIPAL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// RUTA DEL PANEL
app.get('/mxl-panel-2026.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'mxl-panel-2026.html'));
});

// ENDPOINT PARA PUBLICAR PRODUCTOS
app.post('/api/publicar', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const nuevoProducto = {
            id: Date.now(),
            title: req.body.tEn || req.body.title,
            title_es: req.body.tEs || '',
            description: req.body.dEn || '',
            description_es: req.body.dEs || '',
            image: req.body.img || req.body.image,
            link: req.body.link,
            fecha: req.body.fecha || new Date().toISOString()
        };
        
        data.unshift(nuevoProducto);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true, message: "Producto publicado" });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT PARA IA BOT (GEMINI SIMULADO)
app.post('/api/ia-bot', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ success: false, error: "URL requerida" });
        }
        
        // SIMULACIÓN DE IA (reemplazar con Gemini real)
        // Extraer ASIN de Amazon URL
        let asin = '';
        const asinMatch = url.match(/(?:dp|product)\/([A-Z0-9]{10})/);
        if (asinMatch) asin = asinMatch[1];
        
        // Generar contenido automático
        const tituloGenerado = `Premium Product ${asin || ''}`;
        const tituloEs = `Producto Premium ${asin || ''}`;
        const descripcionGen = `Discover this amazing product on Amazon. Perfect for modern homes. High-quality materials, durable design. Limited time offer!`;
        const descripcionEs = `Descubre este increíble producto en Amazon. Perfecto para hogares modernos. Materiales de alta calidad, diseño duradero. ¡Oferta por tiempo limitado!`;
        
        res.json({
            success: true,
            tEn: tituloGenerado,
            tEs: tituloEs,
            dEn: descripcionGen,
            dEs: descripcionEs
        });
        
    } catch (error) {
        console.error('Error IA Bot:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT PARA OBTENER PRODUCTOS
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
