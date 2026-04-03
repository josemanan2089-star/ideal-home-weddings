const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const compression = require('compression');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const AFFILIATE_TAG = process.env.AMAZON_AFFILIATE_TAG || 'farolaldiauno-20';

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// MIDDLEWARES DE ALTA VELOCIDAD
app.use(compression());
app.use(cors());
app.use(express.json());

// ==========================================
// 1. TRACKING REAL (IMPRESIONES + CTR) - PIEZA CLAVE 💰
// ==========================================
app.post('/api/track/impression', async (req, res) => {
    const { id } = req.body;
    try {
        await db.query(`
            UPDATE articulos 
            SET impresiones = impresiones + 1,
                ctr = CASE 
                    WHEN (impresiones + 1) > 0 THEN clics::decimal / (impresiones + 1)
                    ELSE 0 
                END
            WHERE id = $1
        `, [id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 2. REDIRECCIÓN INTELIGENTE (TRACKING DE COMISIONES)
// ==========================================
app.get('/go/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Registramos el clic y recalculamos CTR al instante
        const result = await db.query(`
            UPDATE articulos 
            SET clics = clics + 1,
                ctr = CASE 
                    WHEN impresiones > 0 THEN (clics + 1)::decimal / impresiones
                    ELSE 0 
                END
            WHERE id = $1 
            RETURNING link, titulo
        `, [id]);

        if (result.rows.length > 0) {
            let url = result.rows[0].link;
            const cleanTitle = result.rows[0].titulo.substring(0, 20).replace(/\s+/g, '_');
            const separator = url.includes('?') ? '&' : '?';
            
            // Subtag dinámico para saber EXACTAMENTE qué producto generó la comisión
            const finalUrl = `${url}${separator}tag=${AFFILIATE_TAG}&ascsubtag=mxl_${id}_${cleanTitle}`;
            res.redirect(302, finalUrl);
        } else {
            res.redirect('/');
        }
    } catch (e) { res.redirect('/'); }
});

// ==========================================
// 3. PRIORIZACIÓN POR DINERO (ORDEN INTELIGENTE)
// ==========================================
app.get('/api/productos', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM articulos 
            WHERE status = 'active' 
            ORDER BY 
                ctr DESC,    -- Lo que más clics genera primero
                clics DESC,  -- Popularidad
                fecha DESC   -- Novedad
            LIMIT 50
        `);
        res.json({ items: result.rows });
    } catch (e) { res.json({ items: [] }); }
});

// RUTAS DE PANEL COMMANDER (MANTENIENDO PODER DE EDICIÓN)
app.post('/api/commander/inject', async (req, res) => {
    const { tituloReal, imagenUrl, categoria, url, precio } = req.body;
    const id = Date.now();
    await db.query(`INSERT INTO articulos (id, titulo, imagen, categoria, link, precio) VALUES ($1,$2,$3,$4,$5,$6)`, 
    [id, tituloReal, imagenUrl, categoria, url, precio]);
    res.json({ success: true });
});

app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`💰 MACHINE ACTIVE ON PORT ${PORT}`));
