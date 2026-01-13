// tag-processor.js - Tag normalization and hierarchy system
const fs = require('fs').promises;
const path = require('path');

class TagProcessor {
  constructor(configPath = './tag-taxonomy.json') {
    this.configPath = configPath;
    this.config = null;
    this.aliasMap = new Map(); // Flattened alias lookup
    this.hierarchyMap = new Map(); // Tag -> parent relationships
  }

  /**
   * Load and parse the taxonomy configuration
   */
  async loadConfig() {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      
      // Build flattened alias map for quick lookups
      this._buildAliasMap();
      
      // Build hierarchy map
      this._buildHierarchyMap();
      
      console.log('✅ Tag taxonomy loaded successfully');
      console.log(`   - ${this.aliasMap.size} aliases defined`);
      console.log(`   - ${this.hierarchyMap.size} hierarchy rules`);
      
      return true;
    } catch (error) {
      console.error('❌ Failed to load tag taxonomy:', error);
      throw error;
    }
  }

  /**
   * Build a flattened map of all aliases for O(1) lookups
   */
  _buildAliasMap() {
    this.aliasMap.clear();
    
    if (!this.config.aliases) return;
    
    // Detect format by checking first entry
    const firstKey = Object.keys(this.config.aliases)[0];
    const firstValue = this.config.aliases[firstKey];
    
    // New format: { canonical: { category, variants: [] } }
    if (firstValue && typeof firstValue === 'object' && firstValue.hasOwnProperty('variants')) {
      for (const [canonical, data] of Object.entries(this.config.aliases)) {
        const category = data.category || 'general';
        const variants = data.variants || [];
        const canonicalLower = canonical.toLowerCase().trim();
        
        for (const variant of variants) {
          const variationLower = variant.toLowerCase().trim();
          
          // Map variant to canonical (without category)
          this.aliasMap.set(variationLower, canonicalLower);
          
          // Also map with category prefix
          this.aliasMap.set(`${category}:${variationLower}`, `${category}:${canonicalLower}`);
        }
      }
    }
    // Old format: { category: { variant: canonical } }
    else {
      for (const [category, aliases] of Object.entries(this.config.aliases)) {
        if (category.startsWith('_')) continue; // Skip comments
        
        for (const [variation, canonical] of Object.entries(aliases)) {
          const variationLower = variation.toLowerCase().trim();
          const canonicalLower = canonical.toLowerCase().trim();
          
          this.aliasMap.set(variationLower, canonicalLower);
          this.aliasMap.set(`${category}:${variationLower}`, `${category}:${canonicalLower}`);
        }
      }
    }
  }

  /**
   * Build hierarchy map for parent tag lookups
   */
  _buildHierarchyMap() {
    this.hierarchyMap.clear();
    
    if (!this.config.hierarchy) return;
    
    for (const [tag, config] of Object.entries(this.config.hierarchy)) {
      if (tag.startsWith('_')) continue;
      
      this.hierarchyMap.set(tag.toLowerCase(), {
        parents: config.parents || [],
        category: config.category || 'general'
      });
    }
  }

  /**
   * Normalize a single tag to its canonical form
   * @param {string} tag - Tag to normalize (can be "category:name" or just "name")
   * @returns {string} - Canonical form of the tag
   */
  normalizeTag(tag) {
    if (!tag) return null;
    
    const tagLower = tag.toLowerCase().trim();
    
    // Check if this tag has an alias
    if (this.aliasMap.has(tagLower)) {
      return this.aliasMap.get(tagLower);
    }
    
    // If no alias found, return normalized version (lowercase, trimmed)
    return tagLower;
  }

  /**
   * Check if a tag should be filtered out
   * @param {string} tag - Tag to check
   * @returns {boolean} - True if tag should be removed
   */
  shouldFilterTag(tag) {
    if (!tag || !this.config.blacklist) return false;
    
    const tagName = this._getTagName(tag);
    
    // Check exact matches
    if (this.config.blacklist.exact) {
      if (this.config.blacklist.exact.includes(tagName.toLowerCase())) {
        return true;
      }
    }
    
    // Check regex patterns
    if (this.config.blacklist.patterns) {
      for (const pattern of this.config.blacklist.patterns) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(tagName)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Get parent tags for a given tag based on hierarchy
   * @param {string} tag - Tag to get parents for
   * @returns {Array<string>} - Array of parent tags (with categories)
   */
  getParentTags(tag) {
    const tagName = this._getTagName(tag);
    const tagLower = tagName.toLowerCase();
    
    if (!this.hierarchyMap.has(tagLower)) {
      return [];
    }
    
    const config = this.hierarchyMap.get(tagLower);
    
    // Return parents with proper category prefixes
    return config.parents.map(parent => {
      // Check if parent has its own category defined
      if (this.hierarchyMap.has(parent.toLowerCase())) {
        const parentConfig = this.hierarchyMap.get(parent.toLowerCase());
        if (parentConfig.category && parentConfig.category !== 'general') {
          return `${parentConfig.category}:${parent}`;
        }
      }
      return parent;
    });
  }

  /**
   * Process an array of tags: normalize, apply hierarchy, filter
   * @param {Array<string>} tags - Array of tags to process
   * @returns {Array<string>} - Processed, deduplicated tags
   */
  processTags(tags) {
    if (!tags || !Array.isArray(tags)) return [];
    
    const processedTags = new Set();
    
    // Step 1: Normalize and filter
    for (let tag of tags) {
      // Skip empty tags
      if (!tag || !tag.trim()) continue;
      
      // Normalize to canonical form
      tag = this.normalizeTag(tag);
      
      // Filter blacklisted tags
      if (this.shouldFilterTag(tag)) {
        console.log(`🚫 Filtered tag: ${tag}`);
        continue;
      }
      
      // Add the normalized tag
      processedTags.add(tag);
      
      // Step 2: Apply hierarchy - add parent tags
      const parents = this.getParentTags(tag);
      for (const parent of parents) {
        const normalizedParent = this.normalizeTag(parent);
        processedTags.add(normalizedParent);
      }
    }
    
    return Array.from(processedTags).sort();
  }

  /**
   * Extract tag name from "category:name" format
   * @param {string} tag - Tag with optional category
   * @returns {string} - Just the tag name
   */
  _getTagName(tag) {
    if (!tag) return '';
    
    if (tag.includes(':')) {
      const parts = tag.split(':', 2);
      return parts[1] || parts[0];
    }
    
    return tag;
  }

  /**
   * Parse a tag into category and name components
   * @param {string} tag - Tag to parse
   * @returns {Object} - {category: string, name: string}
   */
  parseTag(tag) {
    if (!tag) return { category: 'general', name: '' };
    
    if (tag.includes(':')) {
      const [category, name] = tag.split(':', 2);
      return { category: category || 'general', name: name || '' };
    }
    
    return { category: 'general', name: tag };
  }

  /**
   * Reload configuration from disk (useful for hot-reloading)
   */
  async reloadConfig() {
    console.log('🔄 Reloading tag taxonomy...');
    return await this.loadConfig();
  }

  /**
   * Add a new alias programmatically
   * @param {string} variation - Tag variation
   * @param {string} canonical - Canonical form
   * @param {string} category - Category (optional)
   */
  addAlias(variation, canonical, category = null) {
    const variationLower = variation.toLowerCase().trim();
    const canonicalLower = canonical.toLowerCase().trim();
    
    this.aliasMap.set(variationLower, canonicalLower);
    
    if (category) {
      this.aliasMap.set(`${category}:${variationLower}`, `${category}:${canonicalLower}`);
    }
    
    console.log(`✅ Added alias: ${variation} → ${canonical}`);
  }

  /**
   * Add a new hierarchy relationship programmatically
   * @param {string} childTag - Child tag
   * @param {Array<string>} parentTags - Array of parent tags
   * @param {string} category - Category of child tag
   */
  addHierarchy(childTag, parentTags, category = 'general') {
    const childLower = childTag.toLowerCase().trim();
    
    this.hierarchyMap.set(childLower, {
      parents: parentTags,
      category: category
    });
    
    console.log(`✅ Added hierarchy: ${childTag} → [${parentTags.join(', ')}]`);
  }
}

module.exports = TagProcessor;