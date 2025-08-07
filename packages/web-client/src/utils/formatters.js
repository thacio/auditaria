/**
 * Text formatting and utility functions
 */

/**
 * Escape HTML special characters
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Shorten a file path for display
 */
export function shortenPath(path, maxLength) {
    if (path.length <= maxLength) return path;
    const segments = path.split(/[\/\\]/);
    if (segments.length <= 2) return path;
    
    // Try to keep last 2 segments
    const lastTwo = segments.slice(-2).join('/');
    if (lastTwo.length <= maxLength - 3) {
        return `.../${lastTwo}`;
    }
    
    // Just keep the last segment
    const last = segments[segments.length - 1];
    return `.../${last}`;
}

/**
 * Format duration in milliseconds to human readable format
 */
export function formatDuration(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    if (minutes === 0) {
        return `${seconds}s`;
    } else {
        return `${minutes}m ${seconds}s`;
    }
}

/**
 * Get message type label
 */
export function getMessageTypeLabel(type) {
    const labels = {
        'user': 'YOU',
        'user_shell': 'SHELL',
        'gemini': 'AUDITARIA',
        'gemini_content': 'AUDITARIA',
        'info': 'SYSTEM',
        'error': 'ERROR',
        'tool_group': 'TOOLS',
        'about': 'ABOUT',
        'stats': 'STATS',
        'model_stats': 'MODEL',
        'tool_stats': 'TOOLS',
        'quit': 'SESSION END',
        'compression': 'COMPRESSION'
    };
    return labels[type] || type.toUpperCase();
}

/**
 * Get message content text from history item
 */
export function getMessageContent(historyItem) {
    if (historyItem.text) {
        return historyItem.text;
    }
    
    switch (historyItem.type) {
        case 'tool_group':
            const toolCount = historyItem.tools?.length || 0;
            return `Executed ${toolCount} tool${toolCount !== 1 ? 's' : ''}`;
        case 'stats':
            return `Session completed in ${historyItem.duration || 'unknown time'}`;
        case 'quit':
            return `Session ended after ${historyItem.duration || 'unknown time'}`;
        case 'compression':
            const comp = historyItem.compression;
            if (comp) {
                return `Context compressed: ${comp.originalTokenCount || 'N/A'} → ${comp.newTokenCount || 'N/A'} tokens`;
            }
            return 'Context compression applied';
        default:
            return JSON.stringify(historyItem, null, 2);
    }
}

/**
 * Get tool status indicator character
 */
export function getToolStatusIndicator(status) {
    switch (status) {
        case 'Pending': return 'o';
        case 'Executing': return '⊷';
        case 'Success': return '✔';
        case 'Confirming': return '?';
        case 'Canceled': return '-';
        case 'Error': return '✗';
        default: return '•';
    }
}

/**
 * Get TODO status icon
 */
export function getTodoStatusIcon(status) {
    switch (status) {
        case 'pending':
            return '☐';
        case 'in_progress':
            return '☐';
        case 'completed':
            return '☑';
        default:
            return '☐';
    }
}

/**
 * Check if a message is an AI message
 */
export function isAIMessage(historyItem) {
    return historyItem && (historyItem.type === 'gemini' || historyItem.type === 'gemini_content');
}

/**
 * Get MCP server status info
 */
export function getMCPServerStatusInfo(status) {
    switch (status) {
        case 'connected':
            return { icon: '🟢', text: 'Ready', className: 'connected' };
        case 'connecting':
            return { icon: '🔄', text: 'Starting...', className: 'connecting' };
        case 'disconnected':
        default:
            return { icon: '🔴', text: 'Disconnected', className: 'disconnected' };
    }
}

/**
 * Get debug log icon and color based on type
 */
export function getDebugLogIconAndColor(type) {
    switch (type) {
        case 'error':
            return { icon: '✖', color: '#ef4444' }; // Red
        case 'warn':
            return { icon: '⚠', color: '#f59e0b' }; // Yellow/Orange
        case 'debug':
            return { icon: '🔍', color: '#6b7280' }; // Gray
        case 'log':
        default:
            return { icon: 'ℹ', color: '#3b82f6' }; // Blue
    }
}