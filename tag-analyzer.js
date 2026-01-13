// tag-analyzer.js v2 - Analyzes tag corpus and identifies issues
const fs = require('fs').promises;
const path = require('path');

class TagAnalyzer {
  constructor(jsonDirectory) {
    this.jsonDirectory = jsonDirectory;
    this.tagFrequency = new Map(); // tag -> count
    this.tagCategories = new Map(); // tagName -> {category -> count}
    this.tagSources = new Map(); // tag -> [file paths]
    this.allTags = new Set();
    
    // Analysis results
    this.issues = {
      inconsistentNaming: [], // Groups of tags that look like the same thing
      miscategorized: [],     // Tags that appear in multiple categories
      likelyGarbage: []       // Non-ASCII tags only
    };
  }

  /**
   * Scan all JSON files and build tag corpus
   */
  async scanDirectory() {
    console.log(`📂 Scanning ${this.jsonDirectory}...`);
    
    const files = await this.getJsonFiles(this.jsonDirectory);
    console.log(`   Found ${files.length} JSON files`);
    
    let processed = 0;
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf8');
        const data = JSON.parse(content);
        
        this.processFile(file, data);
        processed++;
        
        if (processed % 1000 === 0) {
          console.log(`   Processed ${processed}/${files.length}...`);
        }
      } catch (error) {
        console.error(`   ⚠️ Error processing ${file}: ${error.message}`);
      }
    }
    
    console.log(`✅ Scanned ${processed} files, found ${this.allTags.size} unique tags`);
  }

  /**
   * Recursively get all JSON files
   */
  async getJsonFiles(dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.getJsonFiles(fullPath));
      } else if (entry.name.endsWith('.json')) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  /**
   * Process a single JSON file
   */
  processFile(filePath, data) {
    // Handle both flat array and categorized object formats
    let tags = [];
    
    if (Array.isArray(data.tags)) {
      tags = data.tags;
    } else if (typeof data.tags === 'object') {
      // Categorized format: {artist: [...], character: [...], ...}
      for (const [category, categoryTags] of Object.entries(data.tags)) {
        if (Array.isArray(categoryTags)) {
          tags.push(...categoryTags.map(t => `${category}:${t}`));
        }
      }
    }
    
    for (const tag of tags) {
      const normalized = tag.toLowerCase().trim();
      const { category, name } = this.parseTag(normalized);
      
      this.allTags.add(normalized);
      
      // Track frequency
      this.tagFrequency.set(normalized, (this.tagFrequency.get(normalized) || 0) + 1);
      
      // Track categories per base tag name
      if (!this.tagCategories.has(name)) {
        this.tagCategories.set(name, new Map());
      }
      const catMap = this.tagCategories.get(name);
      catMap.set(category, (catMap.get(category) || 0) + 1);
      
      // Track sources (limit to first 5 for memory)
      if (!this.tagSources.has(normalized)) {
        this.tagSources.set(normalized, []);
      }
      const sources = this.tagSources.get(normalized);
      if (sources.length < 5) {
        sources.push(filePath);
      }
    }
  }

  /**
   * Parse tag into category and name
   */
  parseTag(tag) {
    if (tag.includes(':')) {
      const [category, ...rest] = tag.split(':');
      return { category, name: rest.join(':') };
    }
    return { category: 'general', name: tag };
  }

  /**
   * Normalize tag name for comparison (strips formatting differences)
   */
  normalizeForComparison(tagName) {
    return tagName
      .toLowerCase()
      .replace(/[_\s-]+/g, '') // Remove separators
      .replace(/\([^)]*\)/g, '') // Remove parentheticals
      .trim();
  }

  /**
   * Run all analysis passes
   */
  analyze() {
    console.log('\n🔍 Analyzing tags...');
    
    this.findInconsistentNaming();
    this.findMiscategorized();
    this.findGarbage();
    
    console.log('\n📊 Analysis complete:');
    console.log(`   - ${this.issues.inconsistentNaming.length} naming inconsistency groups`);
    console.log(`   - ${this.issues.miscategorized.length} miscategorized tags`);
    console.log(`   - ${this.issues.likelyGarbage.length} likely garbage tags (non-ASCII)`);
  }

  /**
   * Find tags that are likely the same thing with different formatting
   */
  findInconsistentNaming() {
    const normalizedGroups = new Map(); // normalized -> [original tags]
    
    for (const tag of this.allTags) {
      const { name } = this.parseTag(tag);
      const normalized = this.normalizeForComparison(name);
      
      if (normalized.length < 3) continue; // Skip very short
      
      if (!normalizedGroups.has(normalized)) {
        normalizedGroups.set(normalized, []);
      }
      normalizedGroups.get(normalized).push(tag);
    }
    
    // Find groups with multiple variants
    for (const [normalized, variants] of normalizedGroups) {
      if (variants.length > 1) {
        // Get unique base names (ignoring category)
        const baseNames = [...new Set(variants.map(v => this.parseTag(v).name))];
        
        if (baseNames.length > 1) {
          // Calculate which variant is most common
          const variantCounts = variants.map(v => ({
            tag: v,
            count: this.tagFrequency.get(v) || 0
          })).sort((a, b) => b.count - a.count);
          
          this.issues.inconsistentNaming.push({
            normalized,
            variants: variantCounts,
            suggestedCanonical: variantCounts[0].tag,
            totalOccurrences: variantCounts.reduce((sum, v) => sum + v.count, 0)
          });
        }
      }
    }
    
    // Sort by total occurrences (most impactful first)
    this.issues.inconsistentNaming.sort((a, b) => b.totalOccurrences - a.totalOccurrences);
  }

  /**
   * Find tags appearing in multiple categories
   */
  findMiscategorized() {
    for (const [name, categories] of this.tagCategories) {
      if (categories.size > 1) {
        const categoryBreakdown = [...categories.entries()]
          .map(([cat, count]) => ({ category: cat, count }))
          .sort((a, b) => b.count - a.count);
        
        this.issues.miscategorized.push({
          tagName: name,
          categories: categoryBreakdown,
          suggestedCategory: categoryBreakdown[0].category,
          totalOccurrences: categoryBreakdown.reduce((sum, c) => sum + c.count, 0)
        });
      }
    }
    
    // Sort by occurrence count
    this.issues.miscategorized.sort((a, b) => b.totalOccurrences - a.totalOccurrences);
  }

  /**
   * Find garbage tags - only non-ASCII characters
   */
  findGarbage() {
    // Pattern to detect non-ASCII characters
    const nonAsciiPattern = /[^\x00-\x7F]/;
    
    for (const tag of this.allTags) {
      const { name } = this.parseTag(tag);
      const count = this.tagFrequency.get(tag) || 0;
      
      if (nonAsciiPattern.test(name)) {
        this.issues.likelyGarbage.push({
          tag,
          count,
          reason: 'Contains non-ASCII characters',
          samples: this.tagSources.get(tag) || []
        });
      }
    }
    
    // Sort by count descending (higher count = more impactful to review)
    this.issues.likelyGarbage.sort((a, b) => b.count - a.count);
  }

  /**
   * Generate analysis report
   */
  generateReport() {
    // Build full tag list with frequencies for global search
    const allTagsWithFrequency = [...this.tagFrequency.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
    
    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalFiles: this.tagSources.size,
        uniqueTags: this.allTags.size,
        issueGroups: {
          inconsistentNaming: this.issues.inconsistentNaming.length,
          miscategorized: this.issues.miscategorized.length,
          likelyGarbage: this.issues.likelyGarbage.length
        }
      },
      issues: this.issues,
      // Include ALL tags for global search
      allTags: allTagsWithFrequency
    };
    
    return report;
  }

  /**
   * Save report to file
   */
  async saveReport(outputPath) {
    const report = this.generateReport();
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Report saved to ${outputPath}`);
    console.log(`   Total tags indexed: ${report.allTags.length}`);
  }
}

// CLI usage
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: node tag-analyzer.js <json-directory> [output-report.json]');
    console.log('Example: node tag-analyzer.js ./TagSaver ./tag-analysis-report.json');
    process.exit(1);
  }
  
  const jsonDir = args[0];
  const outputPath = args[1] || './tag-analysis-report.json';
  
  const analyzer = new TagAnalyzer(jsonDir);
  await analyzer.scanDirectory();
  analyzer.analyze();
  await analyzer.saveReport(outputPath);
}

if (require.main === module) {
  main().catch(console.error);
}
module.exports = TagAnalyzer;
