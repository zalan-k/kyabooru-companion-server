// server.js - Tag Saver Local Server
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const sharp = require('sharp');
const glob = require('glob');
const fs = require('fs').promises;

const app = express();
const PORT = 3737; // Fixed port for the extension to connect to

class TagCache {
  constructor() {
    this.cache = new Map();
    this.lastUpdate = Date.now();
    this.CACHE_TTL = 30000; // 30 seconds
  }
  
  get(query) {
    const key = query.toLowerCase();
    const entry = this.cache.get(key);
    
    if (entry && (Date.now() - entry.timestamp) < this.CACHE_TTL) {
      console.log(`🚀 Cache HIT for: ${query}`);
      return entry.data;
    }
    
    console.log(`💾 Cache MISS for: ${query}`);
    return null;
  }
  
  set(query, data) {
    const key = query.toLowerCase();
    this.cache.set(key, {
      data: data,
      timestamp: Date.now()
    });
    
    // Cleanup old entries (keep cache size reasonable)
    if (this.cache.size > 1000) {
      const oldEntries = Array.from(this.cache.entries())
        .filter(([k, v]) => (Date.now() - v.timestamp) > this.CACHE_TTL);
      
      oldEntries.forEach(([key]) => this.cache.delete(key));
    }
  }
  
  invalidate() {
    console.log('🗑️ Invalidating tag cache');
    this.cache.clear();
  }
}

const tagCache = new TagCache();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=5, max=1000');
  next();
});

// Database setup
const DB_PATH = path.join(process.cwd(), 'tag_saver.db');
let db;

// Initialize database
async function initDatabase() {
  db = new sqlite3.Database(DB_PATH);
  
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -64000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    
    PRAGMA wal_autocheckpoint = 0;
    PRAGMA checkpoint_fullfsync = 0;
    PRAGMA locking_mode = EXCLUSIVE;
    PRAGMA count_changes = 0;

    PRAGMA optimize;
  `);

  // Create tables
  db.serialize(() => {
    // Images table
    db.run(`
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        image_url TEXT,
        image_hash TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        pool_id TEXT,
        pool_index INTEGER,
        media_type TEXT DEFAULT 'image',
        file_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Tags table
    db.run(`
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT DEFAULT 'general',
        count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Image-Tag relationships
    db.run(`
      CREATE TABLE IF NOT EXISTS image_tags (
        image_id INTEGER,
        tag_id INTEGER,
        PRIMARY KEY (image_id, tag_id),
        FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);
    
    // Indexes for performance
    db.run(`CREATE INDEX IF NOT EXISTS idx_images_hash ON images(image_hash)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_images_url ON images(url)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pool ON images(pool_id, pool_index)`);
  });
  
  console.log('Database initialized at:', DB_PATH);
}

// Helper functions
function promiseDb(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function promiseDbRun(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// Add Hamming distance calculation function
function calculateHammingDistance(hash1, hash2) {
  if (!hash1 || !hash2) {
    return Infinity;
  }
  
  try {
    // Convert hex to binary
    const bin1 = hexToBinary(hash1);
    const bin2 = hexToBinary(hash2);
    
    // Ensure equal length
    const minLength = Math.min(bin1.length, bin2.length);
    
    // Count differing bits
    let distance = 0;
    for (let i = 0; i < minLength; i++) {
      if (bin1[i] !== bin2[i]) {
        distance++;
      }
    }
    
    // Add difference in length as additional distance
    distance += Math.abs(bin1.length - bin2.length);
    
    return distance;
  } catch (error) {
    console.error("Error calculating hamming distance:", error);
    return Infinity;
  }
}

async function computeImageHash(imagePath) {
  try {
    // ✅ UPDATED: Use 16x16 for pHash (matches client implementation)
    const { data, info } = await sharp(imagePath)
      .resize(16, 16, { 
        fit: 'fill',
        kernel: sharp.kernel.cubic,
        background: { r: 255, g: 255, b: 255 } // ✅ White background for transparency
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // ✅ Convert to grayscale matrix (same as client)
    const size = 16;
    const grayPixels = [];
    
    for (let y = 0; y < size; y++) {
      grayPixels[y] = [];
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3; // RGB data (3 channels per pixel)
        // ✅ EXACT same ITU-R BT.709 grayscale conversion as client
        grayPixels[y][x] = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      }
    }
    
    // ✅ Apply 2D DCT (same as client implementation)
    const dctSize = 8;
    const dct = [];
    for (let u = 0; u < dctSize; u++) {
      dct[u] = [];
      for (let v = 0; v < dctSize; v++) {
        let sum = 0;
        for (let x = 0; x < size; x++) {
          for (let y = 0; y < size; y++) {
            sum += grayPixels[x][y] * 
                   Math.cos((2*x + 1) * u * Math.PI / (2*size)) *
                   Math.cos((2*y + 1) * v * Math.PI / (2*size));
          }
        }
        const cu = u === 0 ? 1/Math.sqrt(2) : 1;
        const cv = v === 0 ? 1/Math.sqrt(2) : 1;
        dct[u][v] = (2/size) * cu * cv * sum;
      }
    }
    
    // ✅ Get average of DCT coefficients (excluding DC component)
    let sum = 0;
    let count = 0;
    for (let y = 0; y < dctSize; y++) {
      for (let x = 0; x < dctSize; x++) {
        if (x !== 0 || y !== 0) { // Skip DC component
          sum += dct[y][x];
          count++;
        }
      }
    }
    const avg = sum / count;
    
    // ✅ Generate hash (same as client)
    let hashBits = '';
    for (let y = 0; y < dctSize; y++) {
      for (let x = 0; x < dctSize; x++) {
        if (x !== 0 || y !== 0) {
          hashBits += dct[y][x] >= avg ? '1' : '0';
        }
      }
    }
    
    // Convert to hex
    return binaryToHex(hashBits);
  } catch (error) {
    console.error(`Error computing pHash for ${imagePath}:`, error);
    return null;
  }
}

// Convert hex string to binary string
function hexToBinary(hex) {
  let binary = '';
  for (let i = 0; i < hex.length; i++) {
    const decimal = parseInt(hex[i], 16);
    const bits = decimal.toString(2).padStart(4, '0');
    binary += bits;
  }
  return binary;
}

function binaryToHex(binaryStr) {
  let output = '';
  for (let i = 0; i < binaryStr.length; i += 4) {
    const chunk = binaryStr.substr(i, 4);
    const decimal = parseInt(chunk, 2);
    output += decimal.toString(16);
  }
  return output;
}

// Enhanced duplicate checking with similarity threshold
async function checkForDuplicateWithSimilarity(imageHash, similarityThreshold = 8) {
  if (!imageHash) {
    return { isDuplicate: false };
  }

  try {
    // Get all images with hashes
    const allImages = await promiseDb(
      'SELECT id, url, image_url, image_hash, timestamp FROM images WHERE image_hash IS NOT NULL'
    );

    // Check for exact match first
    const exactMatch = allImages.find(img => img.image_hash === imageHash);
    if (exactMatch) {
      return {
        isDuplicate: true,
        exactMatch: true,
        originalRecord: exactMatch
      };
    }

    // Check for similar matches using Hamming distance
    for (const img of allImages) {
      const distance = calculateHammingDistance(imageHash, img.image_hash);
      if (distance <= similarityThreshold) {
        return {
          isDuplicate: true,
          exactMatch: false,
          originalRecord: img
        };
      }
    }

    return { isDuplicate: false };
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    return { isDuplicate: false };
  }
}

// Save image with tags
app.post('/api/images', async (req, res) => {
  const startTime = process.hrtime.bigint();
  
  try {
    const { url, tags, imageUrl, imageHash, poolId, poolIndex, mediaType = 'image', similarityThreshold = 8 } = req.body;
    
    if (!url || !tags || !Array.isArray(tags)) {
      return res.status(400).json({ error: 'Missing required fields: url, tags' });
    }
    
    // Enhanced duplicate check with similarity
    let duplicateInfo = null;
    if (imageHash) {
      const duplicateResult = await checkForDuplicateWithSimilarity(imageHash, similarityThreshold);
      
      if (duplicateResult.isDuplicate) {
        console.log(`📋 Duplicate detected but continuing with save: ${duplicateResult.exactMatch ? 'exact' : 'similar'} match`);
        duplicateInfo = {
          isDuplicate: true,
          exactMatch: duplicateResult.exactMatch,
          originalRecord: duplicateResult.originalRecord
        };
        // ✅ Continue with save instead of returning error
      }
    }

    const tempId = Date.now();
    res.json({ 
      success: true, 
      imageId: tempId, 
      processing: true,
      duplicateInfo: duplicateInfo // ✅ Include duplicate info in response
    });
    
    processImageInBackground(url, tags, imageUrl, imageHash, poolId, poolIndex, mediaType, startTime);
    
  } catch (error) {
    console.error('❌ Error saving image:', error);
    res.status(500).json({ error: error.message });
  }
});

// Background processing function
async function processImageInBackground(url, tags, imageUrl, imageHash, poolId, poolIndex, mediaType, startTime, duplicateInfo = null) {
  try {
    console.log(`🔄 Background processing started...`);
    if (duplicateInfo) {
      console.log(`📋 DUPLICATE SAVE: ${duplicateInfo.exactMatch ? 'Exact' : 'Similar'} duplicate saved anyway`);
      console.log(`📋 Original: ${duplicateInfo.originalRecord.timestamp}, New: ${new Date().toISOString()}`);
    }
    let imageId;
    
    // Handle pool conflicts
    if (poolId && poolIndex !== undefined) {
      await promiseDbRun(
        'UPDATE images SET pool_index = pool_index + 1 WHERE pool_id = ? AND pool_index >= ?',
        [poolId, poolIndex]
      );
    }
    
    // Insert image
    const imageResult = await promiseDbRun(`
      INSERT INTO images (url, image_url, image_hash, pool_id, pool_index, media_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [url, imageUrl, imageHash, poolId, poolIndex, mediaType]);
    
    imageId = imageResult.id;
    
    // Process tags without transaction (autocommit each operation)
    await processBatchTagsAutocommit(imageId, tags);
    
  } catch (error) {
    console.error('❌ Background processing failed:', error);
  }
}

async function processBatchTagsAutocommit(imageId, tags) {
  console.log(`🚀 Autocommit processing ${tags.length} tags...`);
  const start = process.hrtime.bigint();
  
  // Prepare tag data
  const tagData = tags.map(tagString => {
    let category = 'general';
    let name = tagString;
    if (tagString.includes(':')) {
      [category, name] = tagString.split(':', 2);
    }
    return { name, category };
  });
  
  const uniqueTagNames = [...new Set(tagData.map(t => t.name))];
  
  // Get existing tags
  const existingTags = await promiseDb(
    `SELECT id, name FROM tags WHERE name IN (${uniqueTagNames.map(() => '?').join(',')})`,
    uniqueTagNames
  );
  
  const existingTagMap = new Map(existingTags.map(t => [t.name, t.id]));
  const newTags = tagData.filter(t => !existingTagMap.has(t.name));
  
  // Insert new tags if any
  if (newTags.length > 0) {
    const insertValues = newTags.map(() => '(?, ?, 1)').join(',');
    const insertParams = newTags.flatMap(t => [t.name, t.category]);
    
    const result = await promiseDbRun(
      `INSERT INTO tags (name, category, count) VALUES ${insertValues}`,
      insertParams
    );
    
    const firstNewId = result.id - newTags.length + 1;
    newTags.forEach((tag, index) => {
      existingTagMap.set(tag.name, firstNewId + index);
    });
  }
  
  // Update existing counts and link tags (parallel)
  const operations = [];
  
  if (existingTags.length > 0) {
    const existingIds = existingTags.map(t => t.id);
    operations.push(
      promiseDbRun(
        `UPDATE tags SET count = count + 1 WHERE id IN (${existingIds.map(() => '?').join(',')})`,
        existingIds
      )
    );
  }
  
  // Link all tags to image
  const linkValues = tagData.map(() => '(?, ?)').join(',');
  const linkParams = tagData.flatMap(t => [imageId, existingTagMap.get(t.name)]);
  operations.push(
    promiseDbRun(
      `INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES ${linkValues}`,
      linkParams
    )
  );
  
  // Execute remaining operations in parallel
  await Promise.all(operations);
  tagCache.invalidate();
  const time = Number(process.hrtime.bigint() - start) / 1000000;
  console.log(`✅ Autocommit tags completed in ${time.toFixed(2)}ms`);
}

// Updated duplicate check endpoint with similarity support
app.get('/api/images/check-duplicate/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const similarityThreshold = parseInt(req.query.threshold) || 8;
    
    const duplicateResult = await checkForDuplicateWithSimilarity(hash, similarityThreshold);
    
    res.json({ 
      exists: duplicateResult.isDuplicate,
      exactMatch: duplicateResult.exactMatch || false,
      duplicate: duplicateResult.originalRecord || null
    });
  } catch (error) {
    console.error('Error checking duplicate:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search tags for autocomplete
app.get('/api/tags/search', async (req, res) => {
  const startTime = process.hrtime.bigint();
  
  try {
    const { q, limit = 30 } = req.query;
    
    if (!q || q.length < 2) {
      return res.json([]);
    }
    
    // Check cache first
    const cached = tagCache.get(q);
    if (cached) {
      return res.json(cached);
    }
    
    const tags = await promiseDb(`
      SELECT name, category, count 
      FROM tags 
      WHERE name LIKE ? 
      ORDER BY count DESC, name ASC 
      LIMIT ?
    `, [`%${q}%`, parseInt(limit)]);
    
    // Format for extension compatibility
    const formatted = tags.map(tag => 
      tag.category === 'general' ? tag.name : `${tag.category}:${tag.name}`
    );
    
    // Cache the result
    tagCache.set(q, formatted);
    
    const time = Number(process.hrtime.bigint() - startTime) / 1000000;
    console.log(`🔍 Tag search "${q}": ${formatted.length} results in ${time.toFixed(1)}ms`);
    
    res.json(formatted);
  } catch (error) {
    console.error('Error searching tags:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/warmup', async (req, res) => {
  console.log('🔥 Warming up server...');
  
  try {
    // Warm up database connection
    await promiseDb('SELECT COUNT(*) as count FROM tags LIMIT 1');
    
    // Pre-cache common tag searches
    const commonQueries = ['a', 'an', 'art', 'character', 'general'];
    for (const query of commonQueries) {
      if (query.length >= 2) {
        const tags = await promiseDb(`
          SELECT name, category FROM tags 
          WHERE name LIKE ? 
          ORDER BY count DESC 
          LIMIT 10
        `, [`%${query}%`]);
        
        const formatted = tags.map(tag => 
          tag.category === 'general' ? tag.name : `${tag.category}:${tag.name}`
        );
        
        tagCache.set(query, formatted);
      }
    }
    
    console.log('✅ Server warmed up');
    res.json({ status: 'warmed', cached: tagCache.cache.size });
  } catch (error) {
    console.error('❌ Warmup failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get pool highest index
app.get('/api/pools/:poolId/highest-index', async (req, res) => {
  try {
    const { poolId } = req.params;
    const result = await promiseDb(
      'SELECT MAX(pool_index) as highest FROM images WHERE pool_id = ?',
      [poolId]
    );
    
    const highest = result[0]?.highest;
    res.json({ 
      success: true, 
      highestIndex: highest !== null ? highest : null 
    });
  } catch (error) {
    console.error('Error getting pool index:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export database
app.get('/api/export', async (req, res) => {
  try {
    const images = await promiseDb(`
      SELECT 
        i.*,
        GROUP_CONCAT(
          CASE 
            WHEN t.category = 'general' THEN t.name 
            ELSE t.category || ':' || t.name 
          END
        ) as tags
      FROM images i
      LEFT JOIN image_tags it ON i.id = it.image_id
      LEFT JOIN tags t ON it.tag_id = t.id
      GROUP BY i.id
      ORDER BY i.created_at DESC
    `);
    
    // Format for export
    const exportData = images.map(img => ({
      sourceUrl: img.url,
      imageUrl: img.image_url,
      tags: img.tags ? img.tags.split(',') : [],
      timestamp: img.timestamp,
      imageHash: img.image_hash,
      mediaType: img.media_type,
      poolId: img.pool_id,
      poolIndex: img.pool_index
    }));
    
    res.json(exportData);
  } catch (error) {
    console.error('Error exporting:', error);
    res.status(500).json({ error: error.message });
  }
});

// Server status
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'running', 
    version: '1.0.0',
    database: DB_PATH,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rebuild-from-files', async (req, res) => {
  try {
    const { folderPath, purgeFirst = true } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ error: 'folderPath is required' });
    }
    
    console.log(`🔧 Starting database rebuild from: ${folderPath}`);
    
    // Purge database if requested
    if (purgeFirst) {
      console.log('🗑️ Purging existing database...');
      await promiseDbRun('DELETE FROM image_tags');
      await promiseDbRun('DELETE FROM images');
      await promiseDbRun('DELETE FROM tags');
      console.log('✅ Database purged');
    }
    
    // Find all JSON files
    const jsonFiles = glob.sync(`${folderPath}/**/*.json`);
    console.log(`📄 Found ${jsonFiles.length} JSON files`);
    
    let processed = 0;
    let errors = 0;
    
    for (const jsonFile of jsonFiles) {
      try {
        // Read JSON metadata
        const jsonData = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
        
        // Find corresponding image file
        const baseName = jsonFile.replace('.json', '');
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];
        let imagePath = null;
        
        for (const ext of imageExts) {
          const testPath = baseName + ext;
          try {
            await fs.access(testPath);
            imagePath = testPath;
            break;
          } catch (e) {
            // File doesn't exist, try next extension
          }
        }
        
        if (!imagePath) {
          console.log(`⚠️ No image file found for ${jsonFile}`);
          continue;
        }
        
        // Compute hash from actual image file
        let imageHash = null;
        const isVideo = /\.(webm|mp4|mov)$/i.test(imagePath);
        
        if (!isVideo) {
          imageHash = await computeImageHash(imagePath);
        }
        
        // Prepare data from JSON
        const url = jsonData.sourceUrl || jsonData.url || 'unknown';
        const imageUrl = jsonData.imageUrl || '';
        const mediaType = jsonData.mediaType || (isVideo ? 'video' : 'image');
        const timestamp = jsonData.timestamp || new Date().toISOString();
        const poolId = jsonData.poolId || null;
        const poolIndex = jsonData.poolIndex || null;
        
        // Extract tags
        let tags = [];
        if (jsonData.tags) {
          if (Array.isArray(jsonData.tags)) {
            // Tags as array: ["general:tag1", "artist:tag2"]
            tags = jsonData.tags;
          } else if (typeof jsonData.tags === 'object') {
            // Tags as object: {"general": ["tag1"], "artist": ["tag2"]}
            for (const [category, tagList] of Object.entries(jsonData.tags)) {
              if (Array.isArray(tagList)) {
                for (const tag of tagList) {
                  tags.push(category === 'general' ? tag : `${category}:${tag}`);
                }
              }
            }
          }
        }
        
        if (tags.length === 0) {
          console.log(`⚠️ No tags found in ${jsonFile}`);
          continue;
        }
        
        // Insert into database
        const imageResult = await promiseDbRun(`
          INSERT INTO images (url, image_url, image_hash, pool_id, pool_index, media_type, timestamp, file_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [url, imageUrl, imageHash, poolId, poolIndex, mediaType, timestamp, imagePath]);
        
        const imageId = imageResult.id;
        
        // Process tags
        await processBatchTagsAutocommit(imageId, tags);
        
        processed++;
        if (processed % 10 === 0) {
          console.log(`📊 Processed ${processed}/${jsonFiles.length} files...`);
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${jsonFile}:`, error);
        errors++;
      }
    }
    
    console.log(`✅ Database rebuild complete: ${processed} processed, ${errors} errors`);
    
    res.json({
      success: true,
      processed,
      errors,
      total: jsonFiles.length
    });
    
  } catch (error) {
    console.error('❌ Rebuild failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// TAG VISUALIZATION
// Get all tags with their relationships for visualization
app.get('/api/admin/tag-graph', async (req, res) => {
  try {
    // Get all tags with counts
    const tags = await promiseDb(`
      SELECT name, category, count 
      FROM tags 
      WHERE category != 'general'
      ORDER BY count DESC
    `);

    // Get current hierarchy from taxonomy
    const taxonomyData = await fs.readFile('./tag-taxonomy.json', 'utf8');
    const taxonomy = JSON.parse(taxonomyData);

    // Format for visualization
    const nodes = tags.map(tag => ({
      id: tag.name,
      label: tag.name,
      category: tag.category,
      count: tag.count,
      parents: taxonomy.hierarchy?.[tag.name]?.parents || []
    }));

    // Get all aliases
    const aliases = {};
    if (taxonomy.aliases) {
      for (const [category, categoryAliases] of Object.entries(taxonomy.aliases)) {
        if (category.startsWith('_')) continue;
        for (const [variation, canonical] of Object.entries(categoryAliases)) {
          if (!aliases[canonical]) {
            aliases[canonical] = [];
          }
          aliases[canonical].push(variation);
        }
      }
    }

    res.json({
      nodes,
      aliases,
      taxonomy: taxonomy.hierarchy || {}
    });
  } catch (error) {
    console.error('Error generating tag graph:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save updated taxonomy
app.post('/api/admin/tag-graph', async (req, res) => {
  try {
    const { hierarchy, aliases } = req.body;

    // Read current taxonomy
    const taxonomyData = await fs.readFile('./tag-taxonomy.json', 'utf8');
    const taxonomy = JSON.parse(taxonomyData);

    // Update hierarchy and aliases
    taxonomy.hierarchy = hierarchy;
    taxonomy.aliases = aliases;
    taxonomy.lastUpdated = new Date().toISOString();

    // Write back
    await fs.writeFile(
      './tag-taxonomy.json',
      JSON.stringify(taxonomy, null, 2),
      'utf8'
    );

    // Reload in server
    await tagProcessor.reloadConfig();

    res.json({ success: true, message: 'Taxonomy updated' });
  } catch (error) {
    console.error('Error saving taxonomy:', error);
    res.status(500).json({ error: error.message });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function startServer() {
  await initDatabase();
  
  app.listen(PORT, 'localhost', () => {
    console.log(`Tag Saver Server running on http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    console.log('API endpoints:');
    console.log('  POST /api/images - Save image with tags');
    console.log('  GET  /api/images/check-duplicate/:hash - Check duplicate');
    console.log('  GET  /api/tags/search?q=term - Search tags');
    console.log('  GET  /api/pools/:id/highest-index - Get pool info');
    console.log('  GET  /api/export - Export all data');
    console.log('  GET  /api/status - Server status');
  });
}

startServer().catch(console.error);