/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: File icons utility using Material Icon Theme

// Material icons base path (served from jsDelivr CDN)
// Using the generated icons from vscode-material-icons npm package
// const ICONS_BASE_PATH = '/assets/material-icons';
const ICONS_BASE_PATH = 'https://cdn.jsdelivr.net/npm/material-icon-theme@5.14.0/icons';

/**
 * Get Material icon path for a file
 * Uses vscode-material-icons naming convention
 * @param {string} filename - Name of the file (e.g., "index.js", "README.md")
 * @returns {string} Path to icon SVG file
 */
export function getFileIcon(filename) {
  if (!filename) {
    return `${ICONS_BASE_PATH}/file.svg`;
  }

  const lowerFilename = filename.toLowerCase();

  // Material Icon Theme special file mappings
  const specialFiles = {
    'package.json': 'npm',
    'package-lock.json': 'npm',
    'tsconfig.json': 'tsconfig',
    'jsconfig.json': 'jsconfig',
    'webpack.config.js': 'webpack',
    'vite.config.js': 'vite',
    'vite.config.ts': 'vite',
    'rollup.config.js': 'rollup',
    'dockerfile': 'docker',
    'makefile': 'makefile',
    'readme.md': 'readme',
    'readme': 'readme',
    'license': 'document',
    'license.md': 'document',
    'license.txt': 'document',
    'changelog.md': 'changelog',
    'changelog': 'changelog',
    '.gitignore': 'git',
    '.env': 'settings',
    '.env.local': 'settings',
    '.env.development': 'settings',
    '.env.production': 'settings',
    'yarn.lock': 'yarn',
    'pnpm-lock.yaml': 'pnpm',
    'composer.json': 'php',
    'cargo.toml': 'rust',
    'go.mod': 'go-mod',
    'go.sum': 'go-mod',
    'gemfile': 'gemfile',
    '.eslintrc': 'eslint',
    '.eslintrc.js': 'eslint',
    '.eslintrc.json': 'eslint',
    '.prettierrc': 'prettier',
    '.prettierrc.json': 'prettier',
    'babel.config.js': 'babel',
    '.babelrc': 'babel',
    'next.config.js': 'next',
    'nuxt.config.js': 'nuxt',
    'vue.config.js': 'vue-config'
  };

  // Check for special files first
  if (specialFiles[lowerFilename]) {
    return `${ICONS_BASE_PATH}/${specialFiles[lowerFilename]}.svg`;
  }

  // Extension-based mapping
  const ext = lowerFilename.split('.').pop();

  const extensionMap = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'jsx': 'react',
    'ts': 'typescript',
    'tsx': 'react_ts',

    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'sass',
    'sass': 'sass',
    'less': 'less',
    'styl': 'stylus',

    // Data
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'settings',
    'xml': 'xml',

    // Markdown
    'md': 'markdown',
    'mdx': 'mdx',

    // Images
    'png': 'image',
    'jpg': 'image',
    'jpeg': 'image',
    'gif': 'image',
    'svg': 'svg',
    'ico': 'image',
    'webp': 'image',

    // Media
    'mp4': 'video',
    'mp3': 'audio',
    'wav': 'audio',
    'ogg': 'audio',
    'webm': 'video',

    // Archives
    'zip': 'zip',
    'tar': 'zip',
    'gz': 'zip',
    'rar': 'zip',
    '7z': 'zip',

    // Programming Languages
    'py': 'python',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'h',
    'hpp': 'hpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'rb': 'ruby',
    'swift': 'swift',
    'kt': 'kotlin',
    'lua': 'lua',
    'pl': 'perl',
    'sh': 'console',
    'bash': 'console',
    'zsh': 'console',
    'sql': 'database',

    // Frameworks
    'vue': 'vue',
    'svelte': 'svelte',
    'astro': 'astro',

    // Config
    'env': 'settings',
    'pdf': 'pdf',
    'txt': 'document',
    'lock': 'lock',

    // Build tools
    'gradle': 'gradle',
    'dockerfile': 'docker'
  };

  const iconName = extensionMap[ext] || 'file';
  return `${ICONS_BASE_PATH}/${iconName}.svg`;
}

/**
 * Get Material icon path for a folder
 * @param {string} folderName - Name of the folder
 * @param {boolean} isOpen - Whether folder is expanded
 * @returns {string} Path to icon SVG file
 */
export function getFolderIcon(folderName, isOpen = false) {
  const lowerName = (folderName || '').toLowerCase();

  // Special folder mappings to Material Icon Theme names
  const specialFolders = {
    'node_modules': 'folder-node',
    '.git': 'folder-git',
    '.github': 'folder-github',
    '.vscode': 'folder-vscode',
    'src': 'folder-src',
    'test': 'folder-test',
    'tests': 'folder-test',
    '__tests__': 'folder-test',
    'dist': 'folder-dist',
    'build': 'folder-dist',
    'public': 'folder-public',
    'assets': 'folder-images',
    'images': 'folder-images',
    'styles': 'folder-css',
    'css': 'folder-css',
    'docs': 'folder-docs',
    'documentation': 'folder-docs',
    'components': 'folder-components',
    'utils': 'folder-utils',
    'helpers': 'folder-helper',
    'lib': 'folder-lib',
    'config': 'folder-config',
    'api': 'folder-api',
    'routes': 'folder-routes',
    'controllers': 'folder-controller',
    'models': 'folder-database',
    'views': 'folder-views',
    'middleware': 'folder-middleware',
    'services': 'folder-server',
    'scripts': 'folder-scripts',
    'docker': 'folder-docker',
    'kubernetes': 'folder-kubernetes',
    'terraform': 'folder-terraform',
    'functions': 'folder-functions',
    'hooks': 'folder-hook',
    'plugins': 'folder-plugin',
    'packages': 'folder-packages'
  };

  let folderIcon = specialFolders[lowerName];

  // If no special folder found, use generic folder
  if (!folderIcon) {
    folderIcon = 'folder';
  }

  // Add -open suffix for expanded folders
  if (isOpen) {
    return `${ICONS_BASE_PATH}/${folderIcon}-open.svg`;
  }

  return `${ICONS_BASE_PATH}/${folderIcon}.svg`;
}
