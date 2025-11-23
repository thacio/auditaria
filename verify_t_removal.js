#!/usr/bin/env node
/**
 * Verification script to check t() removal progress
 * Run this after each batch to verify completion
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('=== t() Removal Verification ===\n');

// Check for remaining t() imports
console.log('1. Checking for remaining t() imports...');
try {
  const importResult = execSync(
    `grep -r "import.*\\bt\\b.*from '@thacio/auditaria-cli-core'" packages/cli/src --include="*.ts" --include="*.tsx"`,
    { encoding: 'utf-8' }
  );
  const importLines = importResult.trim().split('\n').filter(Boolean);
  console.log(`   ❌ FAIL: Found ${importLines.length} files with t() imports:\n`);
  importLines.forEach(line => console.log(`      ${line}`));
  console.log('');
} catch (error) {
  if (error.status === 1) {
    console.log('   ✅ PASS: No t() imports found\n');
  } else {
    console.log(`   ⚠️  ERROR: ${error.message}\n`);
  }
}

// Check for remaining t() calls
console.log('2. Checking for remaining t() function calls...');
try {
  const callResult = execSync(
    `grep -r "\\bt(" packages/cli/src --include="*.ts" --include="*.tsx" | grep -v "// " | grep -v "test"`,
    { encoding: 'utf-8' }
  );
  const callLines = callResult.trim().split('\n').filter(Boolean);
  // Filter out common false positives
  const realCalls = callLines.filter(line => {
    return !line.includes('import') &&
           !line.includes('export') &&
           !line.includes('const t =') &&
           !line.includes('function t(') &&
           !line.match(/\w+t\(/); // Exclude things like "set(", "get(", etc.
  });

  if (realCalls.length > 0) {
    console.log(`   ⚠️  POTENTIAL: Found ${realCalls.length} potential t() calls (review needed):\n`);
    realCalls.slice(0, 10).forEach(line => console.log(`      ${line}`));
    if (realCalls.length > 10) {
      console.log(`      ... and ${realCalls.length - 10} more`);
    }
    console.log('');
  } else {
    console.log('   ✅ PASS: No obvious t() calls found\n');
  }
} catch (error) {
  if (error.status === 1) {
    console.log('   ✅ PASS: No t() calls found\n');
  } else {
    console.log(`   ⚠️  ERROR: ${error.message}\n`);
  }
}

// Check TypeScript compilation
console.log('3. Checking TypeScript compilation...');
try {
  execSync('npm run typecheck', { encoding: 'utf-8', stdio: 'pipe' });
  console.log('   ✅ PASS: TypeScript compilation successful\n');
} catch (error) {
  console.log('   ❌ FAIL: TypeScript compilation errors found');
  console.log('   Run `npm run typecheck` to see details\n');
}

// Summary statistics
console.log('4. Summary Statistics...');
try {
  const allTsFiles = execSync(
    `find packages/cli/src -name "*.ts" -o -name "*.tsx" | wc -l`,
    { encoding: 'utf-8' }
  ).trim();

  console.log(`   Total TypeScript files: ${allTsFiles}`);

  const filesWithImports = execSync(
    `grep -r "import.*from '@thacio/auditaria-cli-core'" packages/cli/src --include="*.ts" --include="*.tsx" -l | wc -l`,
    { encoding: 'utf-8' }
  ).trim();

  console.log(`   Files still importing from core: ${filesWithImports}`);
  console.log('');
} catch (error) {
  console.log(`   ⚠️  Could not gather statistics: ${error.message}\n`);
}

console.log('=== Verification Complete ===\n');

// Exit code
process.exit(0);
