#!/usr/bin/env node

/**
 * i18n Key Comparison Tool
 * 
 * Compares two JSON translation files and identifies missing keys.
 * Supports nested JSON structures and provides detailed output.
 * 
 * Usage: node compare-i18n.js <file1> <file2>
 * Or: npx compare-i18n.js <file1> <file2>
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m'
};

/**
 * Recursively extract all keys from a nested object
 * @param {Object} obj - The object to extract keys from
 * @param {string} prefix - The current key prefix for nested keys
 * @returns {Set} Set of all keys in dot notation
 */
function extractKeys(obj, prefix = '') {
  const keys = new Set();
  
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively extract keys from nested objects
      const nestedKeys = extractKeys(value, fullKey);
      nestedKeys.forEach(k => keys.add(k));
    } else {
      // Add leaf keys
      keys.add(fullKey);
    }
  }
  
  return keys;
}

/**
 * Find keys that are in set1 but not in set2
 * @param {Set} set1 - First set of keys
 * @param {Set} set2 - Second set of keys
 * @returns {Array} Sorted array of missing keys
 */
function findMissingKeys(set1, set2) {
  const missing = [];
  for (const key of set1) {
    if (!set2.has(key)) {
      missing.push(key);
    }
  }
  return missing.sort();
}

/**
 * Format and print the comparison results
 * @param {string} file1Name - Name of the first file
 * @param {string} file2Name - Name of the second file
 * @param {Array} missingInFile2 - Keys missing in file2
 * @param {Array} missingInFile1 - Keys missing in file1
 * @param {number} totalKeys1 - Total keys in file1
 * @param {number} totalKeys2 - Total keys in file2
 */
function printResults(file1Name, file2Name, missingInFile2, missingInFile1, totalKeys1, totalKeys2) {
  console.log(`\n${colors.bold}═══════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bold}i18n Translation Key Comparison Report${colors.reset}`);
  console.log(`${colors.bold}═══════════════════════════════════════════════════════${colors.reset}\n`);
  
  // File summary
  console.log(`${colors.cyan}📁 File 1:${colors.reset} ${file1Name}`);
  console.log(`   ${colors.gray}Total keys: ${totalKeys1}${colors.reset}`);
  
  console.log(`${colors.cyan}📁 File 2:${colors.reset} ${file2Name}`);
  console.log(`   ${colors.gray}Total keys: ${totalKeys2}${colors.reset}\n`);
  
  // Missing keys in file2
  console.log(`${colors.yellow}⚠️  Keys in ${colors.bold}${path.basename(file1Name)}${colors.reset}${colors.yellow} but NOT in ${colors.bold}${path.basename(file2Name)}${colors.reset}${colors.yellow}:${colors.reset}`);
  if (missingInFile2.length === 0) {
    console.log(`   ${colors.green}✓ None - All keys from file1 exist in file2${colors.reset}`);
  } else {
    console.log(`   ${colors.red}Found ${missingInFile2.length} missing key(s):${colors.reset}`);
    missingInFile2.forEach(key => {
      console.log(`   ${colors.red}  - ${key}${colors.reset}`);
    });
  }
  
  console.log();
  
  // Missing keys in file1
  console.log(`${colors.yellow}⚠️  Keys in ${colors.bold}${path.basename(file2Name)}${colors.reset}${colors.yellow} but NOT in ${colors.bold}${path.basename(file1Name)}${colors.reset}${colors.yellow}:${colors.reset}`);
  if (missingInFile1.length === 0) {
    console.log(`   ${colors.green}✓ None - All keys from file2 exist in file1${colors.reset}`);
  } else {
    console.log(`   ${colors.red}Found ${missingInFile1.length} missing key(s):${colors.reset}`);
    missingInFile1.forEach(key => {
      console.log(`   ${colors.red}  - ${key}${colors.reset}`);
    });
  }
  
  // Summary
  console.log(`\n${colors.bold}───────────────────────────────────────────────────────${colors.reset}`);
  console.log(`${colors.bold}Summary:${colors.reset}`);
  
  const totalMissing = missingInFile1.length + missingInFile2.length;
  if (totalMissing === 0) {
    console.log(`${colors.green}✅ Perfect match! Both files have identical keys.${colors.reset}`);
  } else {
    console.log(`${colors.yellow}⚠️  Total discrepancies: ${totalMissing} key(s)${colors.reset}`);
    
    // Synchronization percentage
    const commonKeys = Math.min(totalKeys1, totalKeys2) - Math.max(missingInFile1.length, missingInFile2.length);
    const syncPercentage = ((commonKeys / Math.max(totalKeys1, totalKeys2)) * 100).toFixed(1);
    console.log(`${colors.blue}📊 Synchronization: ${syncPercentage}%${colors.reset}`);
  }
  
  console.log(`${colors.bold}═══════════════════════════════════════════════════════${colors.reset}\n`);
}

/**
 * Main function
 */
function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error(`${colors.red}Error: Incorrect number of arguments${colors.reset}`);
    console.log(`\n${colors.bold}Usage:${colors.reset}`);
    console.log('  node compare-i18n.js <file1.json> <file2.json>');
    console.log('  npx compare-i18n.js <file1.json> <file2.json>');
    console.log(`\n${colors.bold}Example:${colors.reset}`);
    console.log('  node compare-i18n.js locales/en.json locales/pt.json');
    process.exit(1);
  }
  
  const [file1Path, file2Path] = args;
  
  try {
    // Check if files exist
    if (!fs.existsSync(file1Path)) {
      console.error(`${colors.red}Error: File not found: ${file1Path}${colors.reset}`);
      process.exit(1);
    }
    
    if (!fs.existsSync(file2Path)) {
      console.error(`${colors.red}Error: File not found: ${file2Path}${colors.reset}`);
      process.exit(1);
    }
    
    // Read and parse JSON files
    console.log(`${colors.gray}Reading files...${colors.reset}`);
    
    const file1Content = fs.readFileSync(file1Path, 'utf8');
    const file2Content = fs.readFileSync(file2Path, 'utf8');
    
    let json1, json2;
    
    try {
      json1 = JSON.parse(file1Content);
    } catch (e) {
      console.error(`${colors.red}Error: Invalid JSON in ${file1Path}${colors.reset}`);
      console.error(`${colors.gray}${e.message}${colors.reset}`);
      process.exit(1);
    }
    
    try {
      json2 = JSON.parse(file2Content);
    } catch (e) {
      console.error(`${colors.red}Error: Invalid JSON in ${file2Path}${colors.reset}`);
      console.error(`${colors.gray}${e.message}${colors.reset}`);
      process.exit(1);
    }
    
    // Extract keys from both files
    console.log(`${colors.gray}Analyzing keys...${colors.reset}`);
    
    const keys1 = extractKeys(json1);
    const keys2 = extractKeys(json2);
    
    // Find missing keys
    const missingInFile2 = findMissingKeys(keys1, keys2);
    const missingInFile1 = findMissingKeys(keys2, keys1);
    
    // Print results
    printResults(
      file1Path,
      file2Path,
      missingInFile2,
      missingInFile1,
      keys1.size,
      keys2.size
    );
    
    // Exit with appropriate code
    const hasDiscrepancies = missingInFile1.length > 0 || missingInFile2.length > 0;
    process.exit(hasDiscrepancies ? 1 : 0);
    
  } catch (error) {
    console.error(`${colors.red}Unexpected error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

// Run the main function
if (require.main === module) {
  main();
}

module.exports = { extractKeys, findMissingKeys };