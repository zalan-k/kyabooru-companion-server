// db-analyzer.js - Analyze existing tags and suggest taxonomy improvements
const sqlite3 = require('better-sqlite3')
const path = require('path');

/**
 * Normalize tag name to canonical form (lowercase, underscores)
 */
function normalizeTagName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')  // Replace spaces with underscores
    .replace(/_{2,}/g, '_'); // Collapse multiple separators
}

class DatabaseAnalyzer {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Connect to database
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) reject(err);
        else {
          console.log('✅ Connected to database');
          resolve();
        }
      });
    });
  }

  /**
   * Run a query and return results
   */
  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
  
  /**
 * Find tags with low occurrence counts (potential garbage)
 */
async findLowOccurrenceTags(threshold = 3) {
  console.log(`\n🔍 Finding tags with fewer than ${threshold} occurrences...`);
  
  const results = await this.query(`
    SELECT name, category, count 
    FROM tags 
    WHERE count < ? 
    ORDER BY count ASC, name ASC
    LIMIT 100
  `, [threshold]);
  
  console.log(`\nFound ${results.length} low-occurrence tags:`);
  console.log('─'.repeat(60));
  
  const byCategory = {};
  const forTransformation = []; // artist/character/copyright
  const forRemoval = []; // general/meta
  
  for (const tag of results) {
    if (!byCategory[tag.category]) {
      byCategory[tag.category] = [];
    }
    byCategory[tag.category].push({ name: tag.name, count: tag.count });
    
    // Separate by whether they should be removed or just transformed
    if (['artist', 'character', 'copyright'].includes(tag.category)) {
      forTransformation.push(tag);
    } else {
      forRemoval.push(tag);
    }
  }
  
  // Show tags suggested for TRANSFORMATION (not removal)
  if (forTransformation.length > 0) {
    console.log('\n🔄 TRANSFORM TO CANONICAL (keep these, just normalize):');
    console.log('─'.repeat(60));
    const transformByCategory = {};
    forTransformation.forEach(t => {
      if (!transformByCategory[t.category]) transformByCategory[t.category] = [];
      transformByCategory[t.category].push(t);
    });
    
    for (const [category, tags] of Object.entries(transformByCategory)) {
      console.log(`\n📂 ${category.toUpperCase()} (${tags.length} tags):`);
      tags.slice(0, 20).forEach(t => {
        const normalized = normalizeTagName(t.name);
        if (normalized !== t.name) {
          console.log(`   ${t.name} → ${normalized} (${t.count})`);
        } else {
          console.log(`   ${t.name} (${t.count}) ✓ already canonical`);
        }
      });
      if (tags.length > 20) {
        console.log(`   ... and ${tags.length - 20} more`);
      }
    }
  }
  
  // Show tags suggested for REMOVAL
  if (forRemoval.length > 0) {
    console.log('\n🗑️  SUGGESTED FOR REMOVAL (potential garbage):');
    console.log('─'.repeat(60));
    const removalByCategory = {};
    forRemoval.forEach(t => {
      if (!removalByCategory[t.category]) removalByCategory[t.category] = [];
      removalByCategory[t.category].push(t);
    });
    
    for (const [category, tags] of Object.entries(removalByCategory)) {
      console.log(`\n📂 ${category.toUpperCase()} (${tags.length} tags):`);
      tags.slice(0, 20).forEach(t => {
        console.log(`   ${t.name} (${t.count})`);
      });
      if (tags.length > 20) {
        console.log(`   ... and ${tags.length - 20} more`);
      }
    }
  }
  
  return results;
}

async findPotentialVariations(options = {}) {
  const { skipCategories = ['artist', 'character', 'copyright'] } = options;
  
  console.log(`\n🔍 Finding potential tag variations...`);
  
  const allTags = await this.query(`
    SELECT name, category, count 
    FROM tags 
    ORDER BY name
  `);
  
  const variations = new Map();
  
  // Group tags by normalized form
  for (const tag of allTags) {
    const normalized = normalizeTagName(tag.name);
    
    if (!variations.has(normalized)) {
      variations.set(normalized, []);
    }
    
    variations.get(normalized).push({
      original: tag.name,
      category: tag.category,
      count: tag.count
    });
  }
    
    // Find groups with multiple variations
    const duplicates = [];
    
    for (const [normalized, variants] of variations.entries()) {
      if (variants.length > 1) {
        // Sort by count descending
        variants.sort((a, b) => b.count - a.count);
        
        duplicates.push({
          normalized,
          canonical: normalized,  // Use normalized form as canonical
          variants
        });
      }
    }
    
    console.log(`\nFound ${duplicates.length} tags with variations:`);
    console.log('─'.repeat(60));
    
    // Sort by total occurrences
    duplicates.sort((a, b) => {
      const totalA = a.variants.reduce((sum, v) => sum + v.count, 0);
      const totalB = b.variants.reduce((sum, v) => sum + v.count, 0);
      return totalB - totalA;
    });
    
  // Filter out skipped categories for DISPLAY only
  const displayDuplicates = duplicates.filter(dup => 
    !skipCategories.includes(dup.variants[0].category)
  );
  
  console.log(`Showing ${displayDuplicates.length} variations (excluding: ${skipCategories.join(', ')})`);
  
  // Show top 30 (filtered)
  for (const dup of displayDuplicates.slice(0, 30)) {
    const totalCount = dup.variants.reduce((sum, v) => sum + v.count, 0);
    console.log(`\n🔄 "${dup.canonical}" (${totalCount} total):`);
    
    dup.variants.forEach((v, idx) => {
      const marker = idx === 0 ? '👑 MOST COMMON →' : '              →';
      console.log(`   ${marker} ${v.category}:${v.original} (${v.count})`);
    });
    console.log(`   ✅ CANONICAL:    ${dup.canonical}`);
  }
  
  // Return ALL duplicates (unfiltered) for alias generation
  return duplicates;
}

  /**
   * Suggest aliases based on variations
   */
  async generateAliasSuggestions() {
    console.log(`\n💡 Generating alias suggestions...`);
    
    const variations = await this.findPotentialVariations();
    
    const suggestions = {
      artist: {},
      character: {},
      general: {},
      copyright: {},
      meta: {}
    };
    
    for (const dup of variations) {
      if (dup.variants.length < 2) continue;
      
      // Use most common variant as canonical
      const canonical = normalizeTagName(dup.variants[0].original);
      const category = dup.variants[0].category;
      
      // Add ALL variations as aliases (including the original most-common one)
      for (let i = 0; i < dup.variants.length; i++) {
        const variant = dup.variants[i];
        const variantNormalized = variant.original;
        
        // Skip if this IS the canonical form
        if (variantNormalized === canonical) continue;
        
        if (suggestions[category]) {
          suggestions[category][variantNormalized] = canonical;
        }
      }
    }
    
    console.log('\n📋 Suggested aliases (add to tag-taxonomy.json):');
    console.log(JSON.stringify({ aliases: suggestions }, null, 2));
    return suggestions;
  }

  /**
   * Find tags that might need hierarchy (e.g., character tags without parent)
   */
  async findOrphanedTags() {
    console.log(`\n🔍 Finding potentially orphaned character/artist tags...`);
    
    // This is a basic heuristic - you'd refine it based on your data
    const characterTags = await this.query(`
      SELECT name, count 
      FROM tags 
      WHERE category = 'character' 
      AND count > 5
      ORDER BY count DESC
      LIMIT 50
    `);
    
    console.log(`\nTop character tags (may need hierarchy):`);
    console.log('─'.repeat(60));
    
    for (const tag of characterTags) {
      console.log(`   character:${tag.name} (${tag.count})`);
      console.log(`      → Suggestion: Add parents like [copyright_name, vtuber/anime/etc]`);
    }
    
    return characterTags;
  }

  /**
   * Get tag statistics
   */
  async getStatistics() {
    console.log(`\n📊 Database Statistics`);
    console.log('═'.repeat(60));
    
    const totalTags = await this.query('SELECT COUNT(*) as count FROM tags');
    const totalImages = await this.query('SELECT COUNT(*) as count FROM images');
    const byCategory = await this.query(`
      SELECT category, COUNT(*) as count, SUM(count) as totalOccurrences
      FROM tags 
      GROUP BY category 
      ORDER BY totalOccurrences DESC
    `);
    
    console.log(`\n📸 Total images: ${totalImages[0].count}`);
    console.log(`🏷️  Total unique tags: ${totalTags[0].count}`);
    console.log(`\nTags by category:`);
    
    for (const cat of byCategory) {
      console.log(`   ${cat.category.padEnd(15)} ${String(cat.count).padStart(6)} tags  (${cat.totalOccurrences} occurrences)`);
    }
    
    return {
      totalTags: totalTags[0].count,
      totalImages: totalImages[0].count,
      byCategory
    };
  }

  /**
   * Run full analysis
   */
  async runFullAnalysis(options = {}) {
    const {
      lowOccurrenceThreshold = 3,
      showStatistics = true,
      findVariations = true,
      generateSuggestions = true,
      findOrphans = true
    } = options;
    
    console.log('🚀 Starting full database analysis...');
    console.log('═'.repeat(60));
    
    if (showStatistics) {
      await this.getStatistics();
    }
    
    if (findVariations) {
      await this.findPotentialVariations();
    }
    
    await this.findLowOccurrenceTags(lowOccurrenceThreshold);
    
    if (generateSuggestions) {
      await this.generateAliasSuggestions();
    }
    
    if (findOrphans) {
      await this.findOrphanedTags();
    }
    
    console.log('\n✅ Analysis complete!');
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      console.log('👋 Database connection closed');
    }
  }
}

// CLI Usage
if (require.main === module) {
  const dbPath = process.argv[2] || './tag_saver.db';
  
  const analyzer = new DatabaseAnalyzer(dbPath);
  
  analyzer.connect()
    .then(() => analyzer.runFullAnalysis())
    .then(() => analyzer.close())
    .catch(error => {
      console.error('❌ Error:', error);
      analyzer.close();
      process.exit(1);
    });
}

if (require.main === module) {
  main().catch(console.error);
}
module.exports = DatabaseAnalyzer;