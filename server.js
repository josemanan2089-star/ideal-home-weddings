// ============================================================
// v8.4.0 — LUXURY COPY GENERATOR (PSYCHOLOGICAL SALES)
// ============================================================

const LUXURY_TONE_PROMPT = `You are a senior luxury copywriter for Architectural Digest, Vogue Living, and The Cut. 
You write exclusively for high-net-worth women in New York City, Miami, and Los Angeles.

CRITICAL RULES:
- NEVER use: "amazing", "great", "good", "nice", "high quality" (these are cheap words)
- ALWAYS use: emotional, status-driven, lifestyle-focused language
- Make her feel this product is a SECRET that other women don't know yet
- Convert technical features into EMOTIONS and SOCIAL STATUS
- Add subtle social proof (e.g., "what SoHo moms are switching to")
- Add elegant urgency (e.g., "only X allocated for Prime this week")

PRODUCT INFORMATION:
- Title: {titulo}
- Category: {categoria}
- Raw info: {rawInfo}

Generate ONLY valid JSON, no explanations:
{
  "title": "aspirational, exclusive, desire-driven title (max 12 words, includes city reference like NYC/Miami/LA when possible)",
  "meta": "one sentence that hooks her emotionally — makes her feel she NEEDS this (max 20 words)",
  "teaser": "2-3 sentences explaining why this is the quiet standard among elite women. Include a subtle social proof and an elegant urgency.",
  "keyword": "3-5 word search phrase in American English that a wealthy woman types when ready to buy",
  "badge": "one of: Amazon's Choice, Best Seller, Limited Stock, Editor's Pick, Top Rated, NYC's Favorite, Miami's Hidden Gem"
}`;

async function generateLuxuryCopy(titulo, categoria, rawInfo = '') {
    if (!geminiKeys.length) throw new Error('No Gemini keys available');
    
    const prompt = LUXURY_TONE_PROMPT
        .replace('{titulo}', titulo)
        .replace('{categoria}', categoria)
        .replace('{rawInfo}', rawInfo);
    
    const raw = await generateContent(prompt);
    return JSON.parse(raw);
}

// ============================================================
// v8.4.0 — CORRECT EXISTING PRODUCTS (AUDIT + FIX)
// ============================================================

async function auditAndFixLowQualityProducts() {
    console.log('🔍 [AUDIT] Scanning products for low-quality copy...');
    
    try {
        // Find products with generic/cheap descriptions
        const cheapWords = ['amazing', 'great', 'good', 'nice', 'high quality', 'very good', 'excellent'];
        const conditions = cheapWords.map((_, i) => `(LOWER(curiosidad) LIKE $${i+1} OR LOWER(meta) LIKE $${i+1})`).join(' OR ');
        const params = cheapWords.map(w => `%${w}%`);
        
        const lowQuality = await db.query(`
            SELECT id, titulo, categoria, curiosidad, meta, clics 
            FROM articulos 
            WHERE ${conditions}
            ORDER BY clics DESC
            LIMIT 50
        `, params);
        
        console.log(`📊 [AUDIT] Found ${lowQuality.rows.length} products with low-quality copy`);
        
        let fixed = 0;
        for (const product of lowQuality.rows) {
            try {
                console.log(`✍️ [FIX] Regenerating copy for: ${product.titulo}`);
                
                const luxuryCopy = await generateLuxuryCopy(
                    product.titulo, 
                    product.categoria || 'Luxury Home',
                    product.curiosidad || ''
                );
                
                const metaWithBadge = JSON.stringify({ 
                    badge: luxuryCopy.badge || "Editor's Pick", 
                    text: luxuryCopy.meta 
                });
                
                await db.query(`
                    UPDATE articulos 
                    SET meta = $1, curiosidad = $2, keyword = $3
                    WHERE id = $4
                `, [metaWithBadge, luxuryCopy.teaser, luxuryCopy.keyword, product.id]);
                
                await audit('AUTO_UPGRADE_LUXURY', product.id, luxuryCopy.title, AFFILIATE_TAG, 
                    `old_clics:${product.clics} | new_badge:${luxuryCopy.badge}`);
                
                fixed++;
                
                // Rate limit to avoid Gemini flooding
                await sleep(2000);
                
            } catch (e) {
                console.error(`❌ [FIX] Failed for product ${product.id}:`, e.message);
            }
        }
        
        console.log(`✅ [AUDIT] Completed. Fixed ${fixed} products with luxury copy.`);
        return { total: lowQuality.rows.length, fixed };
        
    } catch (e) {
        console.error('❌ [AUDIT] Error:', e.message);
        return { total: 0, fixed: 0, error: e.message };
    }
}

// ============================================================
// v8.4.0 — ENDPOINT: Manual trigger for audit/fix
// ============================================================

app.post('/api/admin/upgrade-to-luxury', async (req, res) => {
    const { productId } = req.body;
    
    try {
        if (productId) {
            // Fix single product
            const product = await db.query(`SELECT * FROM articulos WHERE id = $1`, [productId]);
            if (!product.rows.length) {
                return res.status(404).json({ success: false, error: 'Product not found' });
            }
            
            const luxuryCopy = await generateLuxuryCopy(
                product.rows[0].titulo,
                product.rows[0].categoria || 'Luxury Home',
                product.rows[0].curiosidad || ''
            );
            
            const metaWithBadge = JSON.stringify({ 
                badge: luxuryCopy.badge || "Editor's Pick", 
                text: luxuryCopy.meta 
            });
            
            await db.query(`
                UPDATE articulos 
                SET meta = $1, curiosidad = $2, keyword = $3
                WHERE id = $4
            `, [metaWithBadge, luxuryCopy.teaser, luxuryCopy.keyword, productId]);
            
            await audit('MANUAL_UPGRADE_LUXURY', productId, luxuryCopy.title, AFFILIATE_TAG);
            
            res.json({ 
                success: true, 
                product: product.rows[0].titulo,
                newCopy: { title: luxuryCopy.title, meta: luxuryCopy.meta, teaser: luxuryCopy.teaser }
            });
            
        } else {
            // Fix all low-quality products
            const result = await auditAndFixLowQualityProducts();
            res.json({ success: true, ...result });
        }
        
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// v8.4.0 — UPGRADE inject endpoint to use luxury copy
// ============================================================

// Replace your existing /api/commander/inject with this:
app.post('/api/commander/inject', async (req, res) => {
    const { url, imagenUrl, categoria, tituloReal, seccion = 'buying_now' } = req.body;
    if (!geminiKeys.length || !tituloReal) {
        return res.status(400).json({ success: false, error: 'Missing product name or AI engine' });
    }
    
    try {
        // Generate LUXURY copy automatically
        const luxuryCopy = await generateLuxuryCopy(tituloReal, categoria || 'Luxury Home', '');
        
        const image = imagenUrl || await getImage(luxuryCopy.keyword || tituloReal);
        const linkWithTag = addAffiliateTag(url);
        const metaWithBadge = JSON.stringify({ 
            badge: luxuryCopy.badge || "Editor's Pick", 
            text: luxuryCopy.meta 
        });
        
        const id = Date.now();
        
        // Verify affiliate tag
        const tagInLink = new URL(linkWithTag).searchParams.get('tag');
        if (tagInLink !== AFFILIATE_TAG) {
            throw new Error(`Tag mismatch: expected ${AFFILIATE_TAG}, got ${tagInLink}`);
        }
        
        await db.query(`
            INSERT INTO articulos (id, asin, titulo, meta, curiosidad, imagen, categoria, link, keyword, seccion, clics, fecha) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11)
        `, [id, 'MXL'+id, luxuryCopy.title, metaWithBadge, luxuryCopy.teaser, image, categoria, linkWithTag, luxuryCopy.keyword, seccion, new Date().toISOString()]);
        
        await audit('INJECT_LUXURY', id, luxuryCopy.title, tagInLink, `seccion:${seccion} | categoria:${categoria}`);
        
        res.json({ 
            success: true, 
            product: luxuryCopy.title,
            badge: luxuryCopy.badge,
            teaser: luxuryCopy.teaser,
            meta: luxuryCopy.meta,
            seccion, 
            affiliateTag: AFFILIATE_TAG,
            image
        });
        
    } catch (e) {
        console.error('❌ Inject error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// v8.4.0 — Schedule automatic weekly audit
// ============================================================

// Run audit every Sunday at 3 AM
cron.schedule('0 3 * * 0', () => {
    console.log('🕒 [CRON] Running weekly luxury copy audit...');
    auditAndFixLowQualityProducts();
});
