/**
 * Markdown processing utilities
 */

/**
 * Clean HTML specifically for list spacing issues
 */
export function cleanListHTML(html) {
    return html
        // Remove extra whitespace around list containers
        .replace(/\s*<(ul|ol)>/g, '<$1>')
        .replace(/<\/(ul|ol)>\s*/g, '</$1>')
        // Remove extra whitespace around list items
        .replace(/\s*<li>/g, '<li>')
        .replace(/<\/li>\s*/g, '</li>')
        // Remove paragraph tags inside list items (common marked.js issue)
        .replace(/<li><p>(.*?)<\/p><\/li>/g, '<li>$1</li>')
        // Handle nested lists - remove extra spacing
        .replace(/<\/li>\s*<(ul|ol)>/g, '</li><$1>')
        .replace(/<\/(ul|ol)>\s*<\/li>/g, '</$1></li>')
        // Remove trailing paragraph tags only at the end
        .replace(/<\/p>\s*$/, '</p>')
        .trim();
}

/**
 * Clean multiple line breaks throughout ALL HTML content
 */
export function cleanMultipleLineBreaks(html) {
    return html
        // Convert multiple consecutive <br> tags to single ones
        .replace(/(<br\s*\/?>){2,}/gi, '<br>')
        // Convert multiple newlines to single ones
        .replace(/\n{3,}/g, '\n\n')
        // Remove multiple paragraph breaks (empty paragraphs)
        .replace(/(<p>\s*<\/p>){2,}/gi, '<p></p>')
        // Clean up excessive spacing between paragraph tags
        .replace(/(<\/p>)\s{2,}(<p>)/gi, '$1\n$2')
        // Clean up excessive whitespace
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/**
 * Process markdown text with marked.js and apply cleaning
 */
export function processMarkdown(text) {
    if (!window.marked || !text) {
        return text;
    }
    
    try {
        // Convert markdown to HTML using marked.js
        let html = marked.parse(text);
        
        // Apply cleaning functions
        html = cleanListHTML(html);
        html = cleanMultipleLineBreaks(html);
        
        return html;
    } catch (error) {
        console.error('Error processing markdown:', error);
        return text;
    }
}

/**
 * Convert HTML content to clean plain text (like CLI would display)
 */
export function convertHtmlToFormattedText(html) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    
    let result = '';
    
    const processNode = (node, indent = '') => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text) {
                result += text;
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            
            switch (tagName) {
                case 'h1':
                case 'h2':
                case 'h3':
                case 'h4':
                case 'h5':
                case 'h6':
                    if (result && !result.endsWith('\n\n')) {
                        result += '\n\n';
                    }
                    result += node.textContent.trim() + '\n\n';
                    break;
                    
                case 'p':
                    if (result && !result.endsWith('\n') && !result.endsWith('\n\n')) {
                        result += '\n\n';
                    }
                    for (const child of node.childNodes) {
                        processNode(child, indent);
                    }
                    result += '\n\n';
                    break;
                    
                case 'ul':
                    result += '\n';
                    const ulItems = Array.from(node.children).filter(child => child.tagName.toLowerCase() === 'li');
                    ulItems.forEach(li => {
                        result += indent + '• ' + li.textContent.trim() + '\n';
                    });
                    result += '\n';
                    break;
                    
                case 'ol':
                    result += '\n';
                    const olItems = Array.from(node.children).filter(child => child.tagName.toLowerCase() === 'li');
                    olItems.forEach((li, index) => {
                        result += indent + (index + 1) + '. ' + li.textContent.trim() + '\n';
                    });
                    result += '\n';
                    break;
                    
                case 'br':
                    result += '\n';
                    break;
                    
                case 'strong':
                case 'b':
                case 'em':
                case 'i':
                case 'code':
                    result += node.textContent;
                    break;
                    
                case 'pre':
                    result += '\n\n' + node.textContent + '\n\n';
                    break;
                    
                case 'blockquote':
                    const lines = node.textContent.trim().split('\n');
                    result += '\n';
                    lines.forEach(line => {
                        if (line.trim()) {
                            result += line.trim() + '\n';
                        }
                    });
                    result += '\n';
                    break;
                    
                case 'table':
                    result += '\n';
                    const rows = node.querySelectorAll('tr');
                    rows.forEach((row) => {
                        const cells = row.querySelectorAll('td, th');
                        const cellTexts = Array.from(cells).map(cell => cell.textContent.trim());
                        result += cellTexts.join(' | ') + '\n';
                    });
                    result += '\n';
                    break;
                    
                case 'hr':
                    result += '\n---\n\n';
                    break;
                    
                default:
                    for (const child of node.childNodes) {
                        processNode(child, indent);
                    }
                    break;
            }
        }
    };
    
    for (const child of tempDiv.childNodes) {
        processNode(child);
    }
    
    return result
        .trim()
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/`(.*?)`/g, '$1')
        .replace(/~~(.*?)~~/g, '$1')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/^\s*[-*+]\s+/gm, '• ')
        .replace(/^\s*(\d+)\.\s+/gm, '$1. ')
        .replace(/<[^>]*>/g, '');
}

/**
 * Convert HTML content back to markdown format
 */
export function convertHtmlToMarkdown(html) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    
    let result = '';
    
    const processNode = (node, indent = '') => {
        if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            
            switch (tagName) {
                case 'h1':
                    result += '\n# ' + node.textContent.trim() + '\n\n';
                    break;
                case 'h2':
                    result += '\n## ' + node.textContent.trim() + '\n\n';
                    break;
                case 'h3':
                    result += '\n### ' + node.textContent.trim() + '\n\n';
                    break;
                case 'h4':
                    result += '\n#### ' + node.textContent.trim() + '\n\n';
                    break;
                case 'h5':
                    result += '\n##### ' + node.textContent.trim() + '\n\n';
                    break;
                case 'h6':
                    result += '\n###### ' + node.textContent.trim() + '\n\n';
                    break;
                    
                case 'p':
                    if (result && !result.endsWith('\n\n') && !result.endsWith('\n')) {
                        result += '\n\n';
                    }
                    for (const child of node.childNodes) {
                        processNode(child, indent);
                    }
                    result += '\n\n';
                    break;
                    
                case 'ul':
                    result += '\n';
                    const ulItems = Array.from(node.children).filter(child => child.tagName.toLowerCase() === 'li');
                    ulItems.forEach(li => {
                        result += indent + '- ';
                        for (const child of li.childNodes) {
                            processNode(child, indent + '  ');
                        }
                        result += '\n';
                    });
                    result += '\n';
                    break;
                    
                case 'ol':
                    result += '\n';
                    const olItems = Array.from(node.children).filter(child => child.tagName.toLowerCase() === 'li');
                    olItems.forEach((li, index) => {
                        result += indent + (index + 1) + '. ';
                        for (const child of li.childNodes) {
                            processNode(child, indent + '   ');
                        }
                        result += '\n';
                    });
                    result += '\n';
                    break;
                    
                case 'br':
                    result += '\n';
                    break;
                    
                case 'strong':
                case 'b':
                    result += '**' + node.textContent + '**';
                    break;
                    
                case 'em':
                case 'i':
                    result += '*' + node.textContent + '*';
                    break;
                    
                case 'code':
                    if (node.parentNode && node.parentNode.tagName.toLowerCase() === 'pre') {
                        // Skip - handled by parent pre
                    } else {
                        result += '`' + node.textContent + '`';
                    }
                    break;
                    
                case 'pre':
                    result += '\n```\n' + node.textContent + '\n```\n\n';
                    break;
                    
                case 'blockquote':
                    result += '\n';
                    const lines = node.textContent.trim().split('\n');
                    lines.forEach(line => {
                        result += '> ' + line.trim() + '\n';
                    });
                    result += '\n';
                    break;
                    
                case 'table':
                    result += '\n';
                    const rows = node.querySelectorAll('tr');
                    rows.forEach((row, rowIndex) => {
                        const cells = row.querySelectorAll('td, th');
                        const cellTexts = Array.from(cells).map(cell => cell.textContent.trim());
                        result += '| ' + cellTexts.join(' | ') + ' |\n';
                        
                        if (rowIndex === 0 && row.querySelector('th')) {
                            result += '|' + cellTexts.map(() => ' --- ').join('|') + '|\n';
                        }
                    });
                    result += '\n';
                    break;
                    
                case 'hr':
                    result += '\n---\n\n';
                    break;
                    
                case 'a':
                    const href = node.getAttribute('href');
                    if (href) {
                        result += '[' + node.textContent + '](' + href + ')';
                    } else {
                        result += node.textContent;
                    }
                    break;
                    
                default:
                    for (const child of node.childNodes) {
                        processNode(child, indent);
                    }
                    break;
            }
        }
    };
    
    for (const child of tempDiv.childNodes) {
        processNode(child);
    }
    
    return result
        .trim()
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n\n-/g, '\n-')
        .replace(/\n\n\d+\./g, '\n$&'.replace('\n\n', '\n'));
}