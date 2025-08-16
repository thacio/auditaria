const fs = require('fs');
const path = require('path');

// Color mappings from semantic-colors to Colors
const colorMappings = {
  'theme.text.primary': '',  // No color needed (default text)
  'theme.text.secondary': 'Colors.Gray',
  'theme.text.accent': 'Colors.AccentPurple',
  'theme.text.link': 'Colors.AccentBlue',
  'theme.status.error': 'Colors.AccentRed',
  'theme.status.warning': 'Colors.AccentYellow',
  'theme.status.success': 'Colors.AccentGreen',
  'theme.border.default': 'Colors.Gray',
  'theme.ui.gradient': 'theme.ui.gradient', // Keep gradient as is
  'theme.ui.symbol': 'Colors.Gray',
};

function resolveFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Remove conflict markers and keep our version with i18n
  content = content.replace(/<<<<<<< HEAD[\s\S]*?=======[\s\S]*?>>>>>>> [a-f0-9]+/g, (match) => {
    // Extract the HEAD version (ours with i18n)
    const headMatch = match.match(/<<<<<<< HEAD([\s\S]*?)=======/);
    if (headMatch) {
      return headMatch[1];
    }
    return match;
  });
  
  // Replace import statement
  content = content.replace(
    /import\s*{\s*theme\s*}\s*from\s*['"]\.\.\/semantic-colors\.js['"];?/g,
    "import { Colors } from '../colors.js';"
  );
  
  // Replace color references
  for (const [oldColor, newColor] of Object.entries(colorMappings)) {
    if (newColor === '') {
      // Remove color prop entirely for default text
      content = content.replace(
        new RegExp(`color={${oldColor.replace('.', '\\.')}}`, 'g'),
        ''
      );
    } else if (newColor !== oldColor) {
      content = content.replace(
        new RegExp(oldColor.replace('.', '\\.'), 'g'),
        newColor
      );
    }
  }
  
  // Clean up any double spaces or empty color props
  content = content.replace(/\s+color=""/g, '');
  content = content.replace(/\s{2,}/g, ' ');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Resolved: ${filePath}`);
}

// Process all conflicted files
const files = process.argv.slice(2);
files.forEach(file => {
  const fullPath = path.resolve(file);
  if (fs.existsSync(fullPath)) {
    resolveFile(fullPath);
  }
});