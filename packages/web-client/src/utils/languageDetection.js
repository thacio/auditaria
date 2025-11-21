/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Language detection for Monaco Editor

/**
 * Map of file extensions to Monaco language identifiers
 */
const LANGUAGE_MAP = {
  // JavaScript
  'js': 'javascript',
  'jsx': 'javascript',
  'mjs': 'javascript',
  'cjs': 'javascript',

  // TypeScript
  'ts': 'typescript',
  'tsx': 'typescript',

  // Python
  'py': 'python',
  'pyw': 'python',
  'pyi': 'python',

  // Web
  'html': 'html',
  'htm': 'html',
  'xhtml': 'html',
  'xml': 'xml',
  'svg': 'xml',

  // Styling
  'css': 'css',
  'scss': 'scss',
  'sass': 'sass',
  'less': 'less',

  // Data formats
  'json': 'json',
  'jsonc': 'json',
  'yaml': 'yaml',
  'yml': 'yaml',
  'toml': 'toml',
  'xml': 'xml',

  // Markdown
  'md': 'markdown',
  'markdown': 'markdown',
  'mdown': 'markdown',
  'mdx': 'markdown',

  // Shell
  'sh': 'shell',
  'bash': 'shell',
  'zsh': 'shell',

  // Programming languages
  'java': 'java',
  'c': 'c',
  'h': 'c',
  'cpp': 'cpp',
  'cc': 'cpp',
  'cxx': 'cpp',
  'hpp': 'cpp',
  'hh': 'cpp',
  'cs': 'csharp',
  'go': 'go',
  'rs': 'rust',
  'php': 'php',
  'rb': 'ruby',
  'sql': 'sql',
  'r': 'r',
  'swift': 'swift',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'lua': 'lua',
  'pl': 'perl',
  'pm': 'perl',
  'scala': 'scala',
  'clj': 'clojure',
  'erl': 'erlang',
  'ex': 'elixir',
  'exs': 'elixir',
  'fs': 'fsharp',
  'fsx': 'fsharp',
  'hs': 'haskell',
  'vb': 'vb',
  'm': 'objective-c',
  'mm': 'objective-c',

  // Config files
  'ini': 'ini',
  'cfg': 'ini',
  'conf': 'ini',
  'properties': 'properties',
  'env': 'shell',

  // Build/Package
  'gradle': 'groovy',
  'groovy': 'groovy',
  'makefile': 'makefile',
  'mk': 'makefile',
  'cmake': 'cmake',

  // Other
  'diff': 'diff',
  'patch': 'diff',
  'graphql': 'graphql',
  'gql': 'graphql',
  'proto': 'protobuf',
  'dockerfile': 'dockerfile',
  'handlebars': 'handlebars',
  'hbs': 'handlebars',
  'pug': 'pug',
  'jade': 'pug',
  'bat': 'bat',
  'cmd': 'bat',
  'ps1': 'powershell',
  'psm1': 'powershell',
  'tex': 'latex',
  'sol': 'sol',
  'dart': 'dart',
  'vue': 'vue',
  'svelte': 'svelte',
  'razor': 'razor',
  'cshtml': 'razor'
};

/**
 * Special filename patterns that override extension detection
 */
const FILENAME_LANGUAGES = {
  'dockerfile': 'dockerfile',
  'makefile': 'makefile',
  'rakefile': 'ruby',
  'gemfile': 'ruby',
  'vagrantfile': 'ruby',
  'brewfile': 'ruby',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.npmignore': 'ignore',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.babelrc': 'json',
  'tsconfig.json': 'jsonc',
  'package.json': 'json',
  'composer.json': 'json'
};

/**
 * Detect programming language from filename
 * @param {string} filename - Name of the file
 * @returns {string} Monaco language identifier
 */
export function detectLanguage(filename) {
  if (!filename) {
    return 'plaintext';
  }

  const lowerFilename = filename.toLowerCase();

  // Check special filenames first
  if (FILENAME_LANGUAGES[lowerFilename]) {
    return FILENAME_LANGUAGES[lowerFilename];
  }

  // Handle special cases without extension
  if (lowerFilename === 'dockerfile') return 'dockerfile';
  if (lowerFilename === 'makefile') return 'makefile';
  if (lowerFilename.startsWith('.env')) return 'shell';

  // Get file extension
  const parts = filename.split('.');
  if (parts.length < 2) {
    return 'plaintext';
  }

  // Handle special config files
  if (lowerFilename.endsWith('.config.js')) return 'javascript';
  if (lowerFilename.endsWith('.config.ts')) return 'typescript';
  if (lowerFilename.endsWith('.test.js')) return 'javascript';
  if (lowerFilename.endsWith('.test.ts')) return 'typescript';
  if (lowerFilename.endsWith('.spec.js')) return 'javascript';
  if (lowerFilename.endsWith('.spec.ts')) return 'typescript';

  // Handle double extensions like .d.ts
  if (parts.length >= 3) {
    const doubleExt = parts.slice(-2).join('.').toLowerCase();
    if (doubleExt === 'd.ts') return 'typescript';
  }

  // Check single extension
  const ext = parts[parts.length - 1].toLowerCase();
  return LANGUAGE_MAP[ext] || 'plaintext';
}

/**
 * Get human-readable language name
 * @param {string} monacoLang - Monaco language identifier
 * @returns {string} Display name
 */
export function getLanguageDisplayName(monacoLang) {
  const displayNames = {
    'javascript': 'JavaScript',
    'typescript': 'TypeScript',
    'python': 'Python',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'sass': 'Sass',
    'less': 'Less',
    'json': 'JSON',
    'jsonc': 'JSON with Comments',
    'yaml': 'YAML',
    'markdown': 'Markdown',
    'shell': 'Shell Script',
    'java': 'Java',
    'c': 'C',
    'cpp': 'C++',
    'csharp': 'C#',
    'go': 'Go',
    'rust': 'Rust',
    'php': 'PHP',
    'ruby': 'Ruby',
    'sql': 'SQL',
    'plaintext': 'Plain Text'
  };

  return displayNames[monacoLang] || monacoLang.charAt(0).toUpperCase() + monacoLang.slice(1);
}

/**
 * Check if language supports markdown preview
 * @param {string} monacoLang - Monaco language identifier
 * @returns {boolean}
 */
export function supportsMarkdownPreview(monacoLang) {
  return monacoLang === 'markdown';
}

/**
 * Get default tab size for language
 * @param {string} monacoLang - Monaco language identifier
 * @returns {number}
 */
export function getDefaultTabSize(monacoLang) {
  const tabSizes = {
    'python': 4,
    'go': 4,
    'makefile': 4,
    'yaml': 2,
    'json': 2,
    'javascript': 2,
    'typescript': 2,
    'html': 2,
    'css': 2,
    'scss': 2
  };

  return tabSizes[monacoLang] || 2;
}
