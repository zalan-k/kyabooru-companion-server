// server.js - Tag Saver Local Server
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const sharp = require('sharp');
const glob = require('glob');
const fs = require('fs').promises;

const TagProcessor = require('./tag-processor');
const TagAnalyzer = require('./tag-analyzer');
const DatabaseAnalyzer = require('./db-analyzer');
const { DanbooruUploader } = require('./danbooru-uploader');
const tagProcessor = new TagProcessor('./tag-taxonomy.json');

const booruUploader = new DanbooruUploader({
  baseUrl:  process.env.DANBOORU_URL  || 'http://192.168.0.205:3000',
  username: process.env.DANBOORU_USER || 'kyabatsu',
  apiKey:   process.env.DANBOORU_KEY  || 'EPBFXUJbxWFsBPq2QZaf7TcY',
});

// Public URL is what we return to the UI for "view on booru" links.
// If you reverse-proxy later, set DANBOORU_PUBLIC_URL separately.
const BOORU_PUBLIC_URL = (
  process.env.DANBOORU_PUBLIC_URL ||
  process.env.DANBOORU_URL ||
  'http://192.168.0.205:3000'
).replace(/\/$/, '');

const BOORU_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];

// Constants
const STAGING_DIR = 'C:\\Users\\zalka\\Downloads\\TagSaver';
const TAXONOMY_FILE = path.join(__dirname, 'tag-taxonomy.json');
const TRASH_DIR = path.join(STAGING_DIR, '.trash');

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
  
  // PROCESS TAGS THROUGH TAXONOMY
  const processedTags = tags;//tagProcessor.processTags(tags);

  // Prepare tag data
  const tagData = processedTags.map(tagString => {
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

// ============================================
// TAXONOMY/CONFIG MANAGEMENT
// ============================================
/**
 * Load or initialize tag taxonomy
 */
async function loadOrInitializeTaxonomy() {
  try {
    const data = await fs.readFile(TAXONOMY_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📝 tag-taxonomy.json not found, creating with initial analysis...');
      
      // Create empty structure
      const emptyTaxonomy = {
        aliases: {},
        exclusions: {
          blacklist: [],
          whitelist: []
        },
        hierarchy: {},
        suggestions: {
          aliases: [],
          garbage: [],
          dismissed: {
            aliases: [],
            garbage: []
          },
          lastRun: null
        }
      };
      
      await fs.writeFile(TAXONOMY_FILE, JSON.stringify(emptyTaxonomy, null, 2));
      
      // Run initial analysis
      const suggestions = await runTagAnalysis();
      emptyTaxonomy.suggestions = suggestions;
      await fs.writeFile(TAXONOMY_FILE, JSON.stringify(emptyTaxonomy, null, 2));
      
      return emptyTaxonomy;
    }
    throw error;
  }
}

/**
 * Save taxonomy to disk
 */
async function saveTaxonomy(taxonomy) {
  await fs.writeFile(TAXONOMY_FILE, JSON.stringify(taxonomy, null, 2));
  // Reload in tag processor
  await tagProcessor.reloadConfig();
}

/**
 * Run tag analysis and generate suggestions
 */
async function runTagAnalysis() {
  console.log('🔍 Running tag analysis...');
  
  try {
    // Load current taxonomy to get dismissed suggestions
    let currentTaxonomy;
    try {
      const data = await fs.readFile(TAXONOMY_FILE, 'utf8');
      currentTaxonomy = JSON.parse(data);
    } catch (error) {
      currentTaxonomy = {
        aliases: {},
        exclusions: { blacklist: [], whitelist: [] },
        hierarchy: {},
        suggestions: { dismissed: { aliases: [], garbage: [] } }
      };
    }
    
    const existingAliases = new Set();
    for (const [canonicalTag, data] of Object.entries(currentTaxonomy.aliases || {})) {
      // canonicalTag is already like "meta:virtual_youtuber" or "tagname"
      existingAliases.add(canonicalTag.toLowerCase());
      
      // Also add all variants so they don't get re-suggested
      if (data.variants && Array.isArray(data.variants)) {
        for (const variant of data.variants) {
          existingAliases.add(variant.toLowerCase());
        }
      }
    }
    const blacklist = new Set(currentTaxonomy.exclusions?.blacklist || []);
    const whitelist = new Set(currentTaxonomy.exclusions?.whitelist || []);
    const dismissedAliases = new Set(currentTaxonomy.suggestions?.dismissed?.aliases || []);
    const dismissedGarbage = new Set(currentTaxonomy.suggestions?.dismissed?.garbage || []);
    
    // 1. Analyze staging JSON files
    const fileAnalyzer = new TagAnalyzer(STAGING_DIR);
    await fileAnalyzer.scanDirectory();
    fileAnalyzer.analyze();
    const fileReport = fileAnalyzer.generateReport();
    
    // 2. Analyze database
    const dbAnalyzer = new DatabaseAnalyzer(DB_PATH);
    await dbAnalyzer.connect();
    const dbVariations = await dbAnalyzer.findPotentialVariations({ skipCategories: [] });
    dbAnalyzer.close();
    
    // 3. Merge and filter suggestions
    const aliasSuggestions = [];
    const garbageSuggestions = [];
    
    // Process file analyzer inconsistent naming
    for (const issue of fileReport.issues.inconsistentNaming) {
      const canonical = issue.suggestedCanonical;
      const { category, name: canonicalName } = parseTagName(canonical);
      const normalizedName = canonicalName.toLowerCase().replace(/[\s-]+/g, '_');
      const fullTag = category && category !== 'general' ? `${category}:${normalizedName}` : normalizedName;

      if (existingAliases.has(fullTag)) continue;
      if (dismissedAliases.has(fullTag)) continue;
      if (blacklist.has(canonical) || whitelist.has(canonical)) continue;
      
      // Extract variants (excluding the canonical itself)
      const variants = issue.variants
        .filter(v => v.tag !== canonical)
        .map(v => v.tag);
      
      if (variants.length > 0) {
        const { category } = parseTagName(canonical);
        const normalizedName = canonicalName.toLowerCase().replace(/[\s-]+/g, '_');
        const fullCanonical = category && category !== 'general' 
          ? `${category}:${normalizedName}` 
          : normalizedName;
        
        aliasSuggestions.push({
          canonical: fullCanonical,  // Store WITH category prefix
          category,
          variants,
          confidence: Math.min(0.95, issue.totalOccurrences / 100)
        });
      }
    }
    
    // Process database variations
    for (const dup of dbVariations) {
      const canonical = dup.canonical;
      
      // Parse and normalize
      const { category, name } = parseTagName(canonical);
      const normalizedName = name.toLowerCase().replace(/[\s-]+/g, '_');
      
      // Reconstruct full tag for comparison
      const fullTag = category && category !== 'general' ? `${category}:${normalizedName}` : normalizedName;

      // Skip if already in user config or dismissed
      if (existingAliases.has(fullTag)) continue;
      if (dismissedAliases.has(fullTag)) continue;
      if (blacklist.has(canonical) || whitelist.has(canonical)) continue;
      
      // Check if we already have this suggestion from file analysis
      const existing = aliasSuggestions.find(s => s.canonical === canonical);
      if (existing) continue;
      
      const variants = dup.variants
        .filter(v => v.original !== canonical)
        .map(v => v.original);
      
      if (variants.length > 0 && dup.variants.length > 1) {
        const category = dup.variants[0].category || 'general';
        const totalCount = dup.variants.reduce((sum, v) => sum + v.count, 0);
        
        aliasSuggestions.push({
          canonical: canonical.toLowerCase().replace(/[\s-]+/g, '_'),
          category,
          variants,
          confidence: Math.min(0.95, totalCount / 50)
        });
      }
    }
    
    // Process garbage suggestions
    for (const issue of fileReport.issues.likelyGarbage) {
      const tag = issue.tag;
      
      // Skip if in whitelist or dismissed
      if (whitelist.has(tag)) continue;
      if (dismissedGarbage.has(tag)) continue;
      if (blacklist.has(tag)) continue; // Already blacklisted
      
      garbageSuggestions.push({
        tag,
        reason: issue.reason,
        count: issue.count
      });
    }
    
    // Sort suggestions by confidence/count
    aliasSuggestions.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    garbageSuggestions.sort((a, b) => b.count - a.count);
    
    console.log(`✅ Analysis complete: ${aliasSuggestions.length} alias suggestions, ${garbageSuggestions.length} garbage suggestions`);
    
    return {
      aliases: aliasSuggestions.slice(0, 50), // Limit to top 50
      garbage: garbageSuggestions.slice(0, 50),
      dismissed: currentTaxonomy.suggestions?.dismissed || { aliases: [], garbage: [] },
      lastRun: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('❌ Analysis failed:', error);
    return {
      aliases: [],
      garbage: [],
      dismissed: { aliases: [], garbage: [] },
      lastRun: new Date().toISOString()
    };
  }
}

/**
 * Parse tag into category and name
 */
function parseTagName(tag) {
  if (tag && tag.includes(':')) {
    const [category, ...rest] = tag.split(':');
    return { category, name: rest.join(':') };
  }
  return { category: 'general', name: tag || '' };
}

// ============================================
// STAGING AREA MANAGEMENT
// ============================================

/**
 * Scan staging directory and return image metadata
 */
async function scanStagingDirectory(limit = 50, offset = 0, sort = 'newest') {
  try {
    const jsonFiles = glob.sync(`${STAGING_DIR}/**/*.json`);
    const validFiles = jsonFiles.filter(f => !f.includes('.trash'));

    // Build a sortable record for every file. For mtime sorts that's just
    // a stat; for tag-count sorts we have to read the JSON.
    const needsJson = sort === 'tags-desc' || sort === 'tags-asc';

    const records = await Promise.all(
      validFiles.map(async (file) => {
        const stats = await fs.stat(file);
        const record = { file, mtime: stats.mtime, tagCount: 0 };

        if (needsJson) {
          try {
            const json = JSON.parse(await fs.readFile(file, 'utf8'));
            if (json.tags) {
              if (Array.isArray(json.tags)) {
                record.tagCount = json.tags.length;
              } else if (typeof json.tags === 'object') {
                for (const list of Object.values(json.tags)) {
                  if (Array.isArray(list)) record.tagCount += list.length;
                }
              }
            }
          } catch {
            // Unreadable JSON ranks as 0 tags — better than crashing the page.
          }
        }
        return record;
      })
    );

    // Apply sort
    switch (sort) {
      case 'oldest':
        records.sort((a, b) => a.mtime - b.mtime);
        break;
      case 'tags-desc':
        records.sort((a, b) => b.tagCount - a.tagCount || b.mtime - a.mtime);
        break;
      case 'tags-asc':
        records.sort((a, b) => a.tagCount - b.tagCount || b.mtime - a.mtime);
        break;
      case 'newest':
      default:
        records.sort((a, b) => b.mtime - a.mtime);
        break;
    }

    const total = records.length;
    const paginated = records.slice(offset, offset + limit);

    const images = await Promise.all(
      paginated.map(async ({ file }) => {
        try {
          const jsonData = JSON.parse(await fs.readFile(file, 'utf8'));
          const id = path.basename(file, '.json');

          const baseName = file.replace('.json', '');
          const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];
          let imagePath = null;
          for (const ext of imageExts) {
            const testPath = baseName + ext;
            try {
              await fs.access(testPath);
              imagePath = testPath;
              break;
            } catch {
              // try next ext
            }
          }

          let tags = [];
          let tagCount = 0;
          if (jsonData.tags) {
            if (Array.isArray(jsonData.tags)) {
              tags = jsonData.tags;
              tagCount = tags.length;
            } else if (typeof jsonData.tags === 'object') {
              for (const [category, tagList] of Object.entries(jsonData.tags)) {
                if (Array.isArray(tagList)) {
                  tagCount += tagList.length;
                  for (const tag of tagList) {
                    tags.push(category === 'general' ? tag : `${category}:${tag}`);
                  }
                }
              }
            }
          }

          return {
            id,
            filename: path.basename(imagePath || file),
            filePath: imagePath,
            jsonPath: file,
            tags,
            tagCount,
            sourceUrl: jsonData.sourceUrl,
            imageUrl: jsonData.imageUrl,
            poolId: jsonData.poolId || null,
            poolIndex: jsonData.poolIndex || null,
            phash: jsonData.imageHash,
            mediaType: jsonData.mediaType || 'image',
            timestamp: jsonData.timestamp,
            booruPostId: jsonData.booruPostId || null,
            booruPublicUrl: jsonData.booruPostId
              ? `${BOORU_PUBLIC_URL}/posts/${jsonData.booruPostId}`
              : null,
          };
        } catch (error) {
          console.error(`Error loading ${file}:`, error);
          return null;
        }
      })
    );

    return {
      images: images.filter(Boolean),
      hasMore: offset + limit < total,
      total,
    };
  } catch (error) {
    console.error('Error scanning staging directory:', error);
    throw error;
  }
}

/**
 * Load a single staging image by ID
 */
async function loadStagingImage(id) {
  const jsonPath = path.join(STAGING_DIR, `${id}.json`);
  
  try {
    const jsonData = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    
    // Find corresponding image
    const baseName = jsonPath.replace('.json', '');
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];
    let imagePath = null;
    
    for (const ext of imageExts) {
      const testPath = baseName + ext;
      try {
        await fs.access(testPath);
        imagePath = testPath;
        break;
      } catch (e) {
        // Continue
      }
    }
    
    // Extract tags
    let tags = [];
    if (jsonData.tags) {
      if (Array.isArray(jsonData.tags)) {
        tags = jsonData.tags;
      } else if (typeof jsonData.tags === 'object') {
        for (const [category, tagList] of Object.entries(jsonData.tags)) {
          if (Array.isArray(tagList)) {
            for (const tag of tagList) {
              tags.push(category === 'general' ? tag : `${category}:${tag}`);
            }
          }
        }
      }
    }
    
    return {
      id,
      filename: path.basename(imagePath || jsonPath),
      filePath: imagePath,
      jsonPath,
      tags,
      sourceUrl: jsonData.sourceUrl,
      imageUrl: jsonData.imageUrl,
      poolId: jsonData.poolId || null,
      poolIndex: jsonData.poolIndex || null,
      phash: jsonData.imageHash,
      mediaType: jsonData.mediaType || 'image',
      timestamp: jsonData.timestamp
    };
  } catch (error) {
    console.error(`Error loading staging image ${id}:`, error);
    return null;
  }
}

/**
 * Update staging image metadata
 */
async function updateStagingImage(id, updates) {
  const jsonPath = path.join(STAGING_DIR, `${id}.json`);
  
  try {
    // Load existing data
    const jsonData = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    
    // Update fields
    if (updates.sourceUrl !== undefined) jsonData.sourceUrl = updates.sourceUrl;
    if (updates.poolId !== undefined) jsonData.poolId = updates.poolId;
    if (updates.poolIndex !== undefined) jsonData.poolIndex = updates.poolIndex;
    
    // Handle tags - convert to categorized format
    if (updates.tags !== undefined) {
      const categorized = {
        artist: [],
        character: [],
        copyright: [],
        general: [],
        meta: []
      };
      
      for (const tag of updates.tags) {
        const { category, name } = parseTagName(tag);
        if (categorized[category]) {
          categorized[category].push(name);
        } else {
          categorized.general.push(tag);
        }
      }
      
      jsonData.tags = categorized;
    }
    
    // Write back
    await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2));
    
    return true;
  } catch (error) {
    console.error(`Error updating staging image ${id}:`, error);
    return false;
  }
}

/**
 * Delete staging image (move to trash)
 */
async function deleteStagingImage(id) {
  try {
    // Ensure trash directory exists
    await fs.mkdir(TRASH_DIR, { recursive: true });
    
    const jsonPath = path.join(STAGING_DIR, `${id}.json`);
    const baseName = jsonPath.replace('.json', '');
    
    // Find and move JSON
    try {
      const trashJsonPath = path.join(TRASH_DIR, `${id}.json`);
      await fs.rename(jsonPath, trashJsonPath);
    } catch (error) {
      console.error(`Failed to move JSON to trash:`, error);
    }
    
    // Find and move image
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];
    for (const ext of imageExts) {
      const imagePath = baseName + ext;
      try {
        await fs.access(imagePath);
        const trashImagePath = path.join(TRASH_DIR, `${id}${ext}`);
        await fs.rename(imagePath, trashImagePath);
        break;
      } catch (e) {
        // File doesn't exist, try next
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error deleting staging image ${id}:`, error);
    return false;
  }
}

/**
 * Load everything we need to upload one staging item:
 *   - raw categorized JSON (uploader.processTags expects this shape)
 *   - the matching image file path
 *
 * Throws if the JSON is missing/unreadable or no image with a known
 * extension sits next to it. The route turns these into per-id failures.
 */
async function loadBooruJob(id) {
  const jsonPath = path.join(STAGING_DIR, `${id}.json`);
  const metadata = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
 
  const baseName = jsonPath.replace(/\.json$/, '');
  for (const ext of BOORU_IMAGE_EXTS) {
    const candidate = baseName + ext;
    try {
      await fs.access(candidate);
      return { id, jsonPath, imagePath: candidate, metadata };
    } catch {
      // try next extension
    }
  }
  throw new Error('Image file not found');
}
 
/**
 * Resolve body into a flat list of staging IDs.
 * Returns [] if nothing to upload (route validates inputs upstream).
 */
async function resolveBooruTargetIds({ ids, all, force }) {
  if (Array.isArray(ids) && ids.length > 0) return ids;
  if (!all) return [];
 
  const files = glob.sync(`${STAGING_DIR}/**/*.json`).filter(f => !f.includes('.trash'));
  const out = [];
  for (const file of files) {
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      if (force || !json.booruPostId) {
        out.push(path.basename(file, '.json'));
      }
    } catch {
      // skip unreadable
    }
  }
  return out;
}

 
/**
 * For each pool we're about to upload into, find an already-uploaded
 * sibling outside this batch — its post ID becomes the parent_id.
 */
async function findExistingPoolParents(poolIds) {
  if (poolIds.size === 0) return new Map();
 
  const files = glob.sync(`${STAGING_DIR}/**/*.json`).filter(f => !f.includes('.trash'));
  const candidates = new Map(); // poolId -> { postId, poolIndex }
 
  for (const file of files) {
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!poolIds.has(json.poolId) || !json.booruPostId) continue;
 
      const idx = json.poolIndex ?? 0;
      const existing = candidates.get(json.poolId);
      if (!existing || idx < existing.poolIndex) {
        candidates.set(json.poolId, { postId: json.booruPostId, poolIndex: idx });
      }
    } catch {
      // skip unreadable
    }
  }
 
  const out = new Map();
  for (const [poolId, info] of candidates) out.set(poolId, info.postId);
  return out;
}

 
function groupAndOrderByPool(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.metadata.poolId ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.metadata.poolIndex ?? 0) - (b.metadata.poolIndex ?? 0));
  }
  return groups;
}
 
/**
 * Validate body shape. Returns null if OK, or an error message.
 * Both routes call this before doing anything else.
 */
function validateBooruUploadBody(body) {
  const { ids, all = false } = body || {};
  if (Array.isArray(ids) && ids.length > 0) return null;
  if (all) return null;
  return 'Body must include `ids` array or `all: true`';
}

/**
 * Run an upload batch. Calls onProgress (if provided) at three phases:
 *   { phase: 'start', total }
 *   { phase: 'item',  completed, total, result }   -- once per id
 *   { phase: 'done',  total, succeeded, failed }
 *
 * Returns the same summary object the bulk JSON endpoint responds with.
 * Body is assumed valid (route layer validates).
 */
/**
 * UPLOAD-ONLY pass. For each target id:
 *   - Skip if already has booruUploadId (idempotent on restarts).
 *   - Call /uploads.json.
 *   - Write booruUploadId + booruMediaAssetId to the sidecar.
 *   - Emit SSE progress.
 *
 * Posting is the worker's job. This function returns once all uploads
 * are done.
 */
async function runBooruUploads({ ids, all, force }, onProgress) {
  const emit = onProgress || (() => {});
  const results = [];
  let completed = 0;

  const targetIds = await resolveBooruTargetIds({ ids, all, force });
  const total = targetIds.length;

  emit({ phase: 'start', total });

  if (total === 0) {
    emit({ phase: 'done', total: 0, succeeded: 0, failed: 0 });
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  for (const id of targetIds) {
    let result;
    try {
      const job = await loadBooruJob(id);

      if (job.metadata.booruUploadId && !force) {
        result = {
          id, success: true,
          uploadAssetId: job.metadata.booruUploadId,
          alreadyUploaded: true,
        };
      } else {
        const { uploadAssetId, mediaAssetId } =
          await booruUploader.uploadFileOnly(job.imagePath);

        job.metadata.booruUploadId = uploadAssetId;
        job.metadata.booruMediaAssetId = mediaAssetId;
        await fs.writeFile(job.jsonPath, JSON.stringify(job.metadata, null, 2));

        result = {
          id, success: true,
          uploadAssetId,
          mediaAssetId,
          alreadyUploaded: false,
        };
      }
    } catch (err) {
      result = {
        id, success: false,
        error: err.message,
        phase: err.phase,
        status: err.status,
        body: err.body,
      };
    }

    results.push(result);
    completed++;
    emit({ phase: 'item', completed, total, result });

    if (completed < total) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  emit({ phase: 'done', total, succeeded, failed });

  return { total, succeeded, failed, results };
}

// ============================================================
// POST WORKER — runs concurrently with uploads, processes the
// "uploaded but not posted" backlog from sidecars.
// ============================================================

const POST_WORKER = {
  running: false,
  scheduled: false,
  AI_POLL_TIMEOUT_MS: 5000,        // give up on AI tags after this
  AI_POLL_INTERVAL_MS: 500,
  AI_THRESHOLDS: {
    general: 0.25,
    meta: 0.25,
  },
  POLITENESS_GAP_MS: 500,
  MAINTENANCE_INTERVAL_MS: 5 * 60 * 1000,
  DUPLICATE_LOG: path.join(STAGING_DIR, 'duplicate-failures.log'),
};

/**
 * Find sidecars that have been uploaded but not yet posted.
 * Sorted so pool members are grouped and ordered by poolIndex.
 */
async function findPendingPosts() {
  const files = glob.sync(`${STAGING_DIR}/**/*.json`).filter(f => !f.includes('.trash'));
  const pending = [];

  for (const file of files) {
    try {
      const json = JSON.parse(await fs.readFile(file, 'utf8'));
      if (json.booruUploadId && json.booruMediaAssetId && !json.booruPostId) {
        pending.push({
          jsonPath: file,
          id: path.basename(file, '.json'),
          metadata: json,
        });
      }
    } catch {
      // skip unreadable
    }
  }

  pending.sort((a, b) => {
    const aPool = a.metadata.poolId || '';
    const bPool = b.metadata.poolId || '';
    if (aPool !== bPool) return aPool.localeCompare(bPool);
    return (a.metadata.poolIndex ?? 0) - (b.metadata.poolIndex ?? 0);
  });

  return pending;
}

/**
 * Block until AI tags for the asset appear, or timeout. Returns the
 * tag array (empty if timed out).
 */
async function waitForAiTags(mediaAssetId) {
  const deadline = Date.now() + POST_WORKER.AI_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tags = await booruUploader.getAiTags(mediaAssetId);
    if (tags.length > 0) return tags;
    await new Promise(r => setTimeout(r, POST_WORKER.AI_POLL_INTERVAL_MS));
  }
  return [];
}

/**
 * Merge AI tags into metadata.tags, in place.
 *
 * Rules:
 *   - Only `general` and `meta` are merged. character / copyright /
 *     artist / rating tags are dropped — handled manually in staging.
 *   - `rating:*` tags from autotagger (which it labels as general)
 *     are also dropped.
 *   - Per-category confidence threshold from AI_THRESHOLDS.
 */
function mergeAiTags(metadata, aiTags) {
  if (!metadata.tags || typeof metadata.tags !== 'object' || Array.isArray(metadata.tags)) {
    metadata.tags = {};
  }
  for (const cat of ['general', 'meta']) {
    if (!Array.isArray(metadata.tags[cat])) metadata.tags[cat] = [];
  }

  for (const aiTag of aiTags) {
    const tag = aiTag.tag;
    const score = aiTag.score ?? 0;
    const category = aiTag.category || 'general';

    if (category !== 'general' && category !== 'meta') continue;
    if (tag.startsWith('rating:')) continue;

    const threshold = POST_WORKER.AI_THRESHOLDS[category];
    if (score < threshold) continue;

    if (!metadata.tags[category].includes(tag)) {
      metadata.tags[category].push(tag);
    }
  }
}

/** Pull a Danbooru post ID from a 422 duplicate error body. */
function extractDuplicatePostId(body) {
  if (!body) return null;
  const md5Errs = body.errors?.md5;
  if (Array.isArray(md5Errs)) {
    for (const msg of md5Errs) {
      const match = String(msg).match(/\/posts\/(\d+)|post #(\d+)/);
      if (match) return parseInt(match[1] || match[2], 10);
    }
  }
  if (body.post_id) return parseInt(body.post_id, 10);
  return null;
}

/** Append one line to the duplicate-failures log. Best-effort. */
async function logDuplicateFailure(filename, errBody) {
  try {
    const conflictId = extractDuplicatePostId(errBody);
    const line = [
      new Date().toISOString(),
      filename,
      conflictId ? `duplicate_of=${conflictId}` : 'duplicate_unknown',
      JSON.stringify(errBody || {}),
    ].join('\t') + '\n';
    await fs.appendFile(POST_WORKER.DUPLICATE_LOG, line);
  } catch (err) {
    console.error('Failed to write duplicate log:', err.message);
  }
}

/** One worker tick — drains the pending queue once. */
async function postWorkerTick() {
  if (POST_WORKER.running) {
    POST_WORKER.scheduled = true;
    return;
  }
  POST_WORKER.running = true;

  try {
    const pending = await findPendingPosts();
    if (pending.length === 0) return;

    console.log(`[post-worker] processing ${pending.length} pending posts`);

    const poolParents = new Map();

    for (const { id, jsonPath, metadata } of pending) {
      try {
        const aiTags = await waitForAiTags(metadata.booruMediaAssetId);
        if (aiTags.length === 0) {
          console.warn(`[post-worker] no AI tags for ${id} after ${POST_WORKER.AI_POLL_TIMEOUT_MS}ms; posting without`);
        }
        mergeAiTags(metadata, aiTags);

        const poolId = metadata.poolId;
        let parentId = null;
        if (poolId) {
          if (poolParents.has(poolId)) {
            parentId = poolParents.get(poolId);
          } else {
            const existing = await findExistingPoolParents(new Set([poolId]));
            parentId = existing.get(poolId) ?? null;
          }
        }

        let postId;
        try {
          postId = await booruUploader.createPostFromAsset(
            metadata.booruUploadId, metadata, parentId
          );
        } catch (err) {
          const isDup = err.phase === 'post'
            && err.status === 422
            && extractDuplicatePostId(err.body) !== null;
          if (!isDup) throw err;

          try {
            postId = await booruUploader.createPostFromAsset(
              metadata.booruUploadId, metadata, parentId, { duplicateOverride: true }
            );
          } catch (overrideErr) {
            await logDuplicateFailure(
              path.basename(jsonPath, '.json'),
              overrideErr.body || err.body
            );
            console.error(`[post-worker] duplicate override failed for ${id}; logged and skipping`);
            continue;
          }
        }

        metadata.booruPostId = postId;
        await fs.writeFile(jsonPath, JSON.stringify(metadata, null, 2));
        if (poolId && !poolParents.has(poolId)) poolParents.set(poolId, postId);
      } catch (err) {
        console.error(`[post-worker] failed to post ${id}:`, err.message);
      }

      await new Promise(r => setTimeout(r, POST_WORKER.POLITENESS_GAP_MS));
    }

    console.log('[post-worker] tick complete');
  } finally {
    POST_WORKER.running = false;
    if (POST_WORKER.scheduled) {
      POST_WORKER.scheduled = false;
      setImmediate(postWorkerTick);
    }
  }
}

/** Public entry — coalesces concurrent calls. */
function kickPostWorker() {
  postWorkerTick().catch(err => console.error('[post-worker] tick threw:', err));
}

// Maintenance: catch any sidecars uploaded outside the SSE flow.
setInterval(kickPostWorker, POST_WORKER.MAINTENANCE_INTERVAL_MS);

// ============================================================
// Route — place near the other /api/staging routes
// ============================================================
 
// Bulk JSON response (back-compat with v1).
app.post('/api/staging/upload-to-booru', async (req, res) => {
  const validationError = validateBooruUploadBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
 
  try {
    const { ids, all = false, force = false } = req.body;
    const summary = await runBooruUploads({ ids, all, force });
    kickPostWorker();
    res.json(summary);
  } catch (err) {
    console.error('Error in upload-to-booru:', err);
    res.status(500).json({ error: err.message });
  }
});
 
// Streaming SSE per-item progress.
app.post('/api/staging/upload-to-booru/stream', async (req, res) => {
  const validationError = validateBooruUploadBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
 
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable buffering if reverse-proxied
  res.flushHeaders();

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }
  
  res.write(': ping\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.socket && typeof res.socket.uncork === 'function') {
      res.socket.uncork();         // ensure immediate send
    }
  };
 
  // If the client disconnects mid-stream, stop emitting (the loop is sequential
  // and the next emit will silently no-op into a closed socket; that's fine).
  try {
    const { ids, all = false, force = false } = req.body;
    await runBooruUploads({ ids, all, force }, (progress) => {
      send(progress.phase, progress);
    });
    kickPostWorker();
  } catch (err) {
    console.error('Error in upload-to-booru/stream:', err);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

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
// ============================================
// API ENDPOINTS
// ============================================

// GET /api/config - Get full taxonomy/config
app.get('/api/config', async (req, res) => {
  try {
    const taxonomy = await loadOrInitializeTaxonomy();
    res.json(taxonomy);
  } catch (error) {
    console.error('Error loading config:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/config/aliases - Update aliases
app.put('/api/config/aliases', async (req, res) => {
  try {
    const taxonomy = await loadOrInitializeTaxonomy();
    taxonomy.aliases = req.body;
    await saveTaxonomy(taxonomy);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving aliases:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/config/exclusions - Update exclusions
app.put('/api/config/exclusions', async (req, res) => {
  try {
    const taxonomy = await loadOrInitializeTaxonomy();
    taxonomy.exclusions = req.body;
    await saveTaxonomy(taxonomy);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving exclusions:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/config/hierarchy - Update hierarchy
app.put('/api/config/hierarchy', async (req, res) => {
  try {
    const taxonomy = await loadOrInitializeTaxonomy();
    taxonomy.hierarchy = req.body;
    await saveTaxonomy(taxonomy);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving hierarchy:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/config/analyze - Run tag analysis
app.post('/api/config/analyze', async (req, res) => {
  try {
    const suggestions = await runTagAnalysis();
    
    // Update taxonomy with new suggestions
    const taxonomy = await loadOrInitializeTaxonomy();
    taxonomy.suggestions = suggestions;
    await saveTaxonomy(taxonomy);
    
    res.json({
      success: true,
      newSuggestions: {
        aliases: suggestions.aliases.length,
        garbage: suggestions.garbage.length
      }
    });
  } catch (error) {
    console.error('Error running analysis:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/staging/images - List staging images (paginated)
app.get('/api/staging/images', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const validSorts = ['newest', 'oldest', 'tags-desc', 'tags-asc'];
    const sort = validSorts.includes(req.query.sort) ? req.query.sort : 'newest';

    const result = await scanStagingDirectory(limit, offset, sort);
    res.json(result);
  } catch (error) {
    console.error('Error listing staging images:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/staging/images/:id - Get single staging image metadata
app.get('/api/staging/images/:id', async (req, res) => {
  try {
    const image = await loadStagingImage(req.params.id);
    
    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    res.json(image);
  } catch (error) {
    console.error('Error loading staging image:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/staging/images/:id - Update staging image
app.put('/api/staging/images/:id', async (req, res) => {
  try {
    const success = await updateStagingImage(req.params.id, req.body);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to update image' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating staging image:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/staging/images/batch
//   body: { ids: string[], addTags?: string[] }
//   Adds `addTags` to every image in `ids`, deduped (union).
//   Returns: { total, succeeded, failed, results: [{id, success, error?}] }
app.patch('/api/staging/images/batch', async (req, res) => {
  try {
    const { ids, addTags = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '`ids` must be a non-empty array' });
    }
    if (!Array.isArray(addTags)) {
      return res.status(400).json({ error: '`addTags` must be an array' });
    }
    if (addTags.length === 0) {
      return res.json({ total: 0, succeeded: 0, failed: 0, results: [] });
    }

    const results = [];
    for (const id of ids) {
      const jsonPath = path.join(STAGING_DIR, `${id}.json`);
      try {
        const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));

        // Union with existing flat-tag list. The on-disk shape may be
        // category-bucketed; we read both and write back in a normalized
        // flat-array shape that loadStagingImage already handles.
        const existing = new Set();
        if (Array.isArray(json.tags)) {
          json.tags.forEach(t => existing.add(t));
        } else if (json.tags && typeof json.tags === 'object') {
          for (const [cat, list] of Object.entries(json.tags)) {
            if (!Array.isArray(list)) continue;
            list.forEach(t => existing.add(cat === 'general' ? t : `${cat}:${t}`));
          }
        }
        addTags.forEach(t => existing.add(t));

        json.tags = Array.from(existing);
        await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }

    res.json({
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    console.error('Error in /staging/images/batch PATCH:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/staging/images/:id - Delete staging image
app.delete('/api/staging/images/:id', async (req, res) => {
  try {
    const success = await deleteStagingImage(req.params.id);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete image' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting staging image:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/staging/images/batch
//   body: { ids: string[] }
//   Deletes JSON sidecar + image file for each. Mirrors the single-image
//   DELETE behavior (whatever your existing route does — adapt if you've
//   changed it to move-to-trash, cascade pool cleanup, etc.).
app.delete('/api/staging/images/batch', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '`ids` must be a non-empty array' });
    }

    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.webm', '.mp4'];
    const results = [];

    for (const id of ids) {
      const jsonPath = path.join(STAGING_DIR, `${id}.json`);
      try {
        // Remove image file (whichever extension exists)
        const baseName = jsonPath.replace(/\.json$/, '');
        for (const ext of imageExts) {
          const candidate = baseName + ext;
          try {
            await fs.unlink(candidate);
            break;
          } catch {
            // try next ext
          }
        }
        // Remove JSON sidecar
        await fs.unlink(jsonPath);
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }

    res.json({
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  } catch (err) {
    console.error('Error in /staging/images/batch DELETE:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staging/image/:id - Get full-size image
app.get('/api/staging/image/:id', async (req, res) => {
  try {
    const image = await loadStagingImage(req.params.id);
    
    if (!image || !image.filePath) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    res.sendFile(image.filePath);
  } catch (error) {
    console.error('Error serving image:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/staging/thumbnail/:id - Get thumbnail
app.get('/api/staging/thumbnail/:id', async (req, res) => {
  try {
    const size = parseInt(req.query.size) || 200;
    const image = await loadStagingImage(req.params.id);
    
    if (!image || !image.filePath) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // For videos, return placeholder or first frame
    if (image.mediaType === 'video') {
      // TODO: Extract video thumbnail
      return res.status(501).json({ error: 'Video thumbnails not yet implemented' });
    }
    
    // Generate thumbnail using sharp
    const thumbnail = await sharp(image.filePath)
      .resize(size, size, { fit: 'inside' })
      .jpeg({ quality: 85 })
      .toBuffer();
    
    res.type('image/jpeg');
    res.send(thumbnail);
  } catch (error) {
    console.error('Error generating thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stats - Get statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Count staging images
    const staging = await scanStagingDirectory(1, 0);
    
    // Count unique tags in database
    const tagCount = await promiseDb('SELECT COUNT(*) as count FROM tags');
    
    res.json({
      imageCount: staging.total,
      uniqueTags: tagCount[0].count
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/health - Health check (rename from /api/status)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

module.exports = {
  loadOrInitializeTaxonomy,
  saveTaxonomy,
  runTagAnalysis,
  scanStagingDirectory,
  loadStagingImage,
  updateStagingImage,
  deleteStagingImage
};

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
  
  try {
    await loadOrInitializeTaxonomy();
    console.log('  Tag taxonomy initialized');
  } catch (error) {
    console.error('  Tag taxonomy initialization failed:', error);
  }

  app.listen(PORT, 'localhost', () => {
    console.log(`Tag Saver Server running on http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    console.log(`Staging: ${STAGING_DIR}`);
    console.log('API endpoints:');
    console.log('  POST /api/images - Save image with tags');
    console.log('  GET  /api/images/check-duplicate/:hash - Check duplicate');
    console.log('  GET  /api/tags/search?q=term - Search tags');
    console.log('  GET  /api/pools/:id/highest-index - Get pool info');
    console.log('  GET  /api/export - Export all data');
    console.log('  GET  /api/status - Server status');
    console.log('  GET  /api/config - Get taxonomy config');
    console.log('  POST /api/config/analyze - Run tag analysis');
    console.log('  GET  /api/staging/images - List staging images');
    console.log('  GET  /api/health - Server health check');
  });

  try {
    await tagProcessor.loadConfig();
    console.log('  Tag processor initialized');
  } catch (error) {
    console.error('  Tag processor failed to load, tags will not be normalized');
  }
}

startServer().catch(console.error);