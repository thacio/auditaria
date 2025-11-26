/**
 * Test script for i18n transformer
 * Run with: node scripts/i18n-transform/test-transform.mjs
 */

import { transformCode } from './babel-transformer.js';
import fs from 'fs';
import path from 'path';

const testFile = './packages/cli/src/ui/components/I18nTestCases.tsx';
const source = fs.readFileSync(testFile, 'utf8');

console.log('=== TRANSFORMING:', testFile, '===\n');

try {
  const result = await transformCode(source, testFile, { debug: false });

  if (result.modified) {
    console.log('=== TRANSFORMATIONS (' + result.transformCount + ' strings) ===\n');
    result.transformations.forEach((t, i) => {
      console.log(`${i + 1}. [${t.type}]`);
      console.log(`   Original: ${t.original.slice(0, 80)}${t.original.length > 80 ? '...' : ''}`);
      console.log(`   Transformed: ${t.transformed.slice(0, 80)}${t.transformed.length > 80 ? '...' : ''}`);
      console.log('');
    });

    console.log('\n=== TRANSFORMED CODE ===\n');
    console.log(result.code);
  } else {
    console.log('No transformations made');
  }
} catch (e) {
  console.error('Error:', e.message);
  console.error(e.stack);
}
