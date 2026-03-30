const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// 🚀 ESTO FUERZA A RAILWAY A VER TUS ARCHIVOS
app.use(express.static(path.join(__dirname, '/')));

const DB_PATH = path.join(__dirname, 'productos.json');

if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([]));
}

// RUTA EXPLÍCITA PARA EL HOME
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// RUTA PARA QUE EL PANEL NO DE ERROR
app.get('/mxl-panel-2026.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'mxl-panel-2026.html'));
});

app.post('/api/publicar', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH));
        data.unshift(req.body); 
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
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
