const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

const DB_PATH = path.join(__dirname, 'productos.json');

// Inicializar DB
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
    console.log('✅ DB inicializada');
}

// RUTAS
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/mxl-panel-2026.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'mxl-panel-2026.html'));
});

app.post('/api/publicar', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        const nuevo = {
            id: Date.now(),
            title: req.body.tEn || req.body.title || 'Producto',
            title_es: req.body.tEs || '',
            description: req.body.dEn || '',
            description_es: req.body.dEs || '',
            image: req.body.img || req.body.image || '',
            link: req.body.link || '#',
            fecha: new Date().toISOString()
        };
        data.unshift(nuevo);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
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

app.post('/api/ia-bot', (req, res) => {
    // Simulación simple
    res.json({
        success: true,
        tEn: 'Premium Amazon Product',
        tEs: 'Producto Premium Amazon',
        dEn: 'High quality product. Best seller. Fast shipping.',
        dEs: 'Producto de alta calidad. Más vendido. Envío rápido.'
    });
});

// Health check simple
app.get('/health', (req, res) => {
    res.send('OK');
});

// Mantener vivo
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ SERVER ONLINE: ${PORT}`);
});

server.keepAliveTimeout = 0;
