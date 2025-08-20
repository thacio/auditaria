/**
 * Tool rendering component
 */

import { escapeHtml, getToolStatusIndicator, getTodoStatusIcon } from '../utils/formatters.js';

/**
 * Render a tool group
 */
export function renderToolGroup(tools) {
    const toolListEl = document.createElement('div');
    toolListEl.className = 'tool-list';
    
    tools.forEach(tool => {
        const toolItemEl = renderToolItem(tool);
        toolListEl.appendChild(toolItemEl);
    });
    
    return toolListEl;
}

/**
 * Render a single tool item
 */
function renderToolItem(tool) {
    const toolItemEl = document.createElement('div');
    toolItemEl.className = 'tool-item tool-item-expanded'; // Start expanded
    
    // Add data attribute with callId for tracking
    if (tool.callId) {
        toolItemEl.setAttribute('data-call-id', tool.callId);
    }
    
    // Tool header with status indicator, name, and status text
    const toolHeaderEl = createToolHeader(tool);
    toolItemEl.appendChild(toolHeaderEl);
    
    // Create collapsible content container
    const collapsibleContentEl = document.createElement('div');
    collapsibleContentEl.className = 'tool-collapsible-content';
    
    // Tool description
    if (tool.description) {
        const toolDescEl = document.createElement('div');
        toolDescEl.className = 'tool-description';
        toolDescEl.textContent = tool.description;
        collapsibleContentEl.appendChild(toolDescEl);
    }
    
    // Tool output/result display
    const toolOutputEl = createToolOutput(tool);
    if (toolOutputEl) {
        collapsibleContentEl.appendChild(toolOutputEl);
    }
    
    toolItemEl.appendChild(collapsibleContentEl);
    
    // Add click handler for collapsing/expanding
    toolHeaderEl.addEventListener('click', () => {
        toolItemEl.classList.toggle('tool-item-expanded');
        toolItemEl.classList.toggle('tool-item-collapsed');
    });
    
    return toolItemEl;
}

/**
 * Create tool header element
 */
function createToolHeader(tool) {
    const toolHeaderEl = document.createElement('div');
    toolHeaderEl.className = 'tool-header tool-header-clickable';
    
    // Add expand/collapse indicator
    const expandIndicatorEl = document.createElement('span');
    expandIndicatorEl.className = 'tool-expand-indicator';
    expandIndicatorEl.textContent = '▼'; // Down arrow when expanded
    
    const toolStatusIndicatorEl = document.createElement('span');
    toolStatusIndicatorEl.className = `tool-status-indicator tool-status-${tool.status.toLowerCase()}`;
    toolStatusIndicatorEl.textContent = getToolStatusIndicator(tool.status);
    
    const toolNameEl = document.createElement('span');
    toolNameEl.className = 'tool-name';
    toolNameEl.textContent = tool.name;
    
    const toolStatusEl = document.createElement('span');
    toolStatusEl.className = `tool-status tool-status-${tool.status.toLowerCase()}`;
    toolStatusEl.textContent = tool.status;
    
    toolHeaderEl.appendChild(expandIndicatorEl);
    toolHeaderEl.appendChild(toolStatusIndicatorEl);
    toolHeaderEl.appendChild(toolNameEl);
    toolHeaderEl.appendChild(toolStatusEl);
    
    return toolHeaderEl;
}

/**
 * Create tool output element
 */
function createToolOutput(tool) {
    // Show output for tools with resultDisplay OR for error/canceled states with messages
    const shouldShowOutput = tool.resultDisplay || 
                           (tool.status === 'Error' || tool.status === 'Canceled') ||
                           (tool.status === 'Executing' && tool.liveOutput);
    
    if (!shouldShowOutput) {
        return null;
    }
    
    const toolOutputEl = document.createElement('div');
    toolOutputEl.className = 'tool-output';
    
    // Determine what content to display
    let outputContent = tool.resultDisplay;
    if (!outputContent && tool.status === 'Error') {
        outputContent = 'Tool execution failed';
    }
    if (!outputContent && tool.status === 'Canceled') {
        outputContent = 'Tool execution was canceled';
    }
    if (!outputContent && tool.status === 'Executing' && tool.liveOutput) {
        outputContent = tool.liveOutput;
    }
    
    if (typeof outputContent === 'string') {
        // Handle string output
        if (tool.name === 'TodoWrite' && isTodoWriteResult(outputContent)) {
            const todos = extractTodosFromDisplay(outputContent);
            if (todos) {
                toolOutputEl.appendChild(renderTodoList(todos));
            } else {
                const outputPreEl = document.createElement('pre');
                outputPreEl.className = 'tool-output-text';
                outputPreEl.textContent = outputContent;
                toolOutputEl.appendChild(outputPreEl);
            }
        } else {
            // Regular text output - preserve formatting
            const outputPreEl = document.createElement('pre');
            outputPreEl.className = 'tool-output-text';
            outputPreEl.textContent = outputContent;
            toolOutputEl.appendChild(outputPreEl);
        }
    } else if (outputContent && typeof outputContent === 'object') {
        // Handle diff/file output
        if (outputContent.fileDiff) {
            const diffEl = createDiffOutput(outputContent);
            toolOutputEl.appendChild(diffEl);
        } else {
            // Fallback for other object types
            const objOutputEl = document.createElement('pre');
            objOutputEl.className = 'tool-output-object';
            objOutputEl.textContent = JSON.stringify(outputContent, null, 2);
            toolOutputEl.appendChild(objOutputEl);
        }
    } else if (!outputContent) {
        // Fallback for when we want to show output but have no content
        const fallbackEl = document.createElement('div');
        fallbackEl.className = 'tool-output-fallback';
        fallbackEl.textContent = 'No output available';
        toolOutputEl.appendChild(fallbackEl);
    }
    
    return toolOutputEl;
}

/**
 * Create diff output element
 */
function createDiffOutput(outputContent) {
    const diffEl = document.createElement('div');
    diffEl.className = 'tool-output-diff';
    
    if (outputContent.fileName) {
        const fileNameEl = document.createElement('div');
        fileNameEl.className = 'diff-filename';
        fileNameEl.textContent = `File: ${outputContent.fileName}`;
        diffEl.appendChild(fileNameEl);
    }
    
    const diffContentEl = document.createElement('pre');
    diffContentEl.className = 'diff-content';
    
    // Parse and style the diff content
    if (outputContent.fileDiff) {
        const styledDiff = formatDiffContent(outputContent.fileDiff);
        diffContentEl.innerHTML = styledDiff;
    } else {
        diffContentEl.textContent = 'No diff available';
    }
    
    diffEl.appendChild(diffContentEl);
    
    return diffEl;
}

/**
 * Format diff content with proper styling
 */
function formatDiffContent(diffText) {
    const lines = diffText.split('\n');
    return lines.map(line => {
        let className = 'diff-line';
        let displayLine = line;
        
        if (line.startsWith('+')) {
            className += ' diff-line-add';
            displayLine = line; // Keep the + prefix
        } else if (line.startsWith('-')) {
            className += ' diff-line-remove';
            displayLine = line; // Keep the - prefix
        } else if (line.startsWith('@@')) {
            className += ' diff-line-header';
            displayLine = line;
        } else if (line.startsWith(' ')) {
            className += ' diff-line-context';
            displayLine = line;
        } else {
            // Other lines (file headers, etc.)
            className += ' diff-line-context';
            displayLine = line;
        }
        
        // Escape HTML to prevent XSS
        const escaped = escapeHtml(displayLine);
        return `<span class="${className}">${escaped}</span>`;
    }).join('\n');
}

/**
 * Check if text is a TodoWrite result
 */
function isTodoWriteResult(text) {
    return text && text.includes('Todos have been') && text.includes('modified successfully');
}

/**
 * Extract todos from display text
 */
function extractTodosFromDisplay(resultDisplay) {
    try {
        const systemReminderMatch = resultDisplay.match(
            /<system-reminder>[\s\S]*?Here are the latest contents of your todo list:\s*(.*?)\. Continue on with the tasks/
        );
        
        if (!systemReminderMatch) {
            return null;
        }
        
        const todosJsonString = systemReminderMatch[1].trim();
        const todos = JSON.parse(todosJsonString);
        
        if (!Array.isArray(todos)) {
            return null;
        }
        
        for (const todo of todos) {
            if (
                !todo.content ||
                !todo.id ||
                !['high', 'medium', 'low'].includes(todo.priority) ||
                !['pending', 'in_progress', 'completed'].includes(todo.status)
            ) {
                return null;
            }
        }
        
        return todos;
    } catch (error) {
        console.error('Error parsing todos from display:', error);
        return null;
    }
}

/**
 * Render TODO list
 */
function renderTodoList(todos) {
    const todoListEl = document.createElement('div');
    todoListEl.className = 'todo-list-container';

    const titleEl = document.createElement('h4');
    titleEl.className = 'todo-list-title';
    titleEl.textContent = 'Update Todos';
    todoListEl.appendChild(titleEl);

    todos.forEach(todo => {
        const todoItemEl = document.createElement('div');
        todoItemEl.className = `todo-item status-${todo.status}`;

        const iconEl = document.createElement('span');
        iconEl.className = 'todo-item-icon';
        iconEl.textContent = getTodoStatusIcon(todo.status);

        const contentEl = document.createElement('span');
        contentEl.className = 'todo-item-content';
        contentEl.textContent = todo.content;

        todoItemEl.appendChild(iconEl);
        todoItemEl.appendChild(contentEl);
        todoListEl.appendChild(todoItemEl);
    });

    return todoListEl;
}

/**
 * Render about info
 */
export function renderAboutInfo(aboutItem) {
    const aboutEl = document.createElement('div');
    aboutEl.className = 'about-info';
    
    const infoItems = [
        { label: 'CLI Version', value: aboutItem.cliVersion },
        { label: 'OS', value: aboutItem.osVersion },
        { label: 'Model', value: aboutItem.modelVersion },
        { label: 'Auth Type', value: aboutItem.selectedAuthType }
    ];
    
    infoItems.forEach(item => {
        if (item.value) {
            const itemEl = document.createElement('div');
            itemEl.innerHTML = `<strong>${item.label}:</strong> ${escapeHtml(item.value)}`;
            aboutEl.appendChild(itemEl);
        }
    });
    
    return aboutEl;
}