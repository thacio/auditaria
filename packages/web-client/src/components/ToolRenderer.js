/**
 * Tool rendering component
 */

import { escapeHtml, getToolStatusIndicator, getTodoStatusIcon } from '../utils/formatters.js';
import { processMarkdown } from '../utils/markdown.js'; // AUDITARIA: For rendering tool output as markdown
import { createEmbeddedStreamViewer, destroyEmbeddedStreamViewer, freezeEmbeddedStreamViewer } from './BrowserStreamViewer.js';
import { createAgentControls } from './agentControlsFactory.js';

// AUDITARIA: Track active stream viewers for cleanup
const activeStreamViewers = new Map();

// AUDITARIA: Browser step status icons and colors
const BROWSER_STEP_STATUS = {
    pending: { icon: '○', colorClass: 'browser-step-pending' },
    executing: { icon: '◐', colorClass: 'browser-step-executing' },
    completed: { icon: '●', colorClass: 'browser-step-completed' },
    error: { icon: '✗', colorClass: 'browser-step-error' },
};

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
    // AUDITARIA DEBUG: Log tool output processing
    console.log('[ToolRenderer] createToolOutput called:', {
        toolName: tool.name,
        status: tool.status,
        hasResultDisplay: !!tool.resultDisplay,
        resultDisplayType: typeof tool.resultDisplay,
        resultDisplayPreview: typeof tool.resultDisplay === 'string'
            ? tool.resultDisplay.substring(0, 100)
            : tool.resultDisplay,
        hasLiveOutput: !!tool.liveOutput,
    });

    // Show output for tools with resultDisplay OR for error/canceled states with messages
    const shouldShowOutput = tool.resultDisplay ||
                           (tool.status === 'Error' || tool.status === 'Canceled') ||
                           (tool.status === 'Executing' && tool.liveOutput);

    if (!shouldShowOutput) {
        console.log('[ToolRenderer] No output to show for tool:', tool.name);
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
        console.log('[ToolRenderer] Using liveOutput:', outputContent.substring(0, 100));
    }

    console.log('[ToolRenderer] Processing outputContent:', {
        type: typeof outputContent,
        isString: typeof outputContent === 'string',
        startsWithBrowserSteps: typeof outputContent === 'string' && outputContent.startsWith('{"browserSteps"'),
        preview: typeof outputContent === 'string' ? outputContent.substring(0, 150) : outputContent,
    });

    if (typeof outputContent === 'string') {
        // AUDITARIA: Check for browser step display data (JSON string)
        const browserStepData = tryParseBrowserStepDisplay(outputContent);
        console.log('[ToolRenderer] tryParseBrowserStepDisplay result:', browserStepData);
        if (browserStepData) {
            console.log('[ToolRenderer] Rendering browser steps!', browserStepData);
            toolOutputEl.appendChild(renderBrowserSteps(browserStepData));
        } else if (tool.name === 'TodoWrite' && isTodoWriteResult(outputContent)) {
            // Handle TodoWrite output
            const todos = extractTodosFromDisplay(outputContent);
            if (todos) {
                toolOutputEl.appendChild(renderTodoList(todos));
            } else {
                const outputPreEl = document.createElement('pre');
                outputPreEl.className = 'tool-output-text';
                outputPreEl.textContent = outputContent;
                toolOutputEl.appendChild(outputPreEl);
            }
        } else if (tool.renderOutputAsMarkdown && processMarkdown) {
            // AUDITARIA: Render as markdown for tools that flag their output as markdown
            const markdownEl = document.createElement('div');
            markdownEl.className = 'tool-output-markdown';
            markdownEl.innerHTML = processMarkdown(outputContent);
            toolOutputEl.appendChild(markdownEl);
        } else {
            // Regular text output - preserve formatting
            const outputPreEl = document.createElement('pre');
            outputPreEl.className = 'tool-output-text';
            outputPreEl.textContent = outputContent;
            toolOutputEl.appendChild(outputPreEl);
        }
    } else if (outputContent && typeof outputContent === 'object') {
        // AUDITARIA: Check for browser step display data (object)
        if (outputContent.browserSteps && Array.isArray(outputContent.browserSteps)) {
            toolOutputEl.appendChild(renderBrowserSteps(outputContent));
            return toolOutputEl;
        }
        // Handle new write_todos tool format
        if (outputContent.todos && Array.isArray(outputContent.todos)) {
            toolOutputEl.appendChild(renderWriteTodosList(outputContent.todos));
        } else if (outputContent.fileDiff) {
            // Handle diff/file output
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
 * Render TODO list for new write_todos tool
 */
function renderWriteTodosList(todos) {
    const todoListEl = document.createElement('div');
    todoListEl.className = 'todo-list-container write-todos-container';

    const titleEl = document.createElement('h4');
    titleEl.className = 'todo-list-title';

    // Calculate completion stats
    const totalTodos = todos.length;
    const activeTodos = todos.filter(t => t.status !== 'cancelled' && t.status !== 'completed').length;
    const completedTodos = todos.filter(t => t.status === 'completed').length;
    const cancelledTodos = todos.filter(t => t.status === 'cancelled').length;

    titleEl.textContent = `Todos (${completedTodos}/${totalTodos - cancelledTodos} completed)`;
    todoListEl.appendChild(titleEl);

    todos.forEach((todo, index) => {
        const todoItemEl = document.createElement('div');
        todoItemEl.className = `todo-item status-${todo.status}`;

        const iconEl = document.createElement('span');
        iconEl.className = 'todo-item-icon';
        iconEl.textContent = getTodoStatusIcon(todo.status);

        const contentEl = document.createElement('span');
        contentEl.className = 'todo-item-content';
        // Use 'description' field from new write_todos format
        contentEl.textContent = todo.description || todo.content || `Task ${index + 1}`;

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

// ============================================================================
// AUDITARIA: Browser Step Display (Phase 7)
// ============================================================================

/**
 * Try to parse browser step display data from a string
 * @param {string} input - Potential JSON string with browser step data
 * @returns {object|null} - Parsed data or null if not valid
 */
function tryParseBrowserStepDisplay(input) {
    if (typeof input !== 'string') {
        return null;
    }

    // Quick check to avoid parsing non-browser step JSON
    if (!input.startsWith('{"browserSteps"')) {
        return null;
    }

    try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.browserSteps)) {
            return parsed;
        }
    } catch {
        // Not valid JSON
    }

    return null;
}

/**
 * Render browser steps display
 * @param {object} data - Browser step display data
 * @returns {HTMLElement} - Container element with rendered steps
 */
function renderBrowserSteps(data) {
    // DEBUG: Log what data we're receiving
    console.log('[ToolRenderer] renderBrowserSteps called with data:', {
        sessionId: data.sessionId,
        action: data.action,
        status: data.status,
        stepNumber: data.stepNumber,
        hasScreenshot: !!data.screenshot,
        dataKeys: Object.keys(data)
    });

    const containerEl = document.createElement('div');
    containerEl.className = 'browser-steps-container';

    // AUDITARIA: Agent controls are now embedded in the stream viewer (see BrowserStreamViewer.js)
    // This ensures controls move to fullscreen mode along with the viewer

    // AUDITARIA: Add browser stream viewer if we have a sessionId
    // FIX: Create viewer on FIRST encounter with sessionId (not just when status='running')
    // This fixes API key mode where AI SDK's onStepFinish only fires AFTER steps complete
    // NOTE: data.status is STEP status, not TASK status. We should NOT freeze based on step status
    // because more steps may follow. The viewer will be cleaned up when the tool completes.
    console.log('[ToolRenderer] Checking stream viewer conditions:', {
        hasSessionId: !!data.sessionId,
        hasExistingViewer: data.sessionId ? activeStreamViewers.has(data.sessionId) : false,
        actualStatus: data.status
    });
    if (data.sessionId) {
        // Check if stream viewer already exists for this session
        if (!activeStreamViewers.has(data.sessionId)) {
            try {
                // Create viewer on first encounter - use 'running' as initial status for controls
                const streamContainer = createEmbeddedStreamViewer(data.sessionId, 'running');
                containerEl.appendChild(streamContainer);
                activeStreamViewers.set(data.sessionId, streamContainer);

                console.log('[ToolRenderer] Created stream viewer for session:', data.sessionId);
            } catch (error) {
                console.warn('[ToolRenderer] Failed to create stream viewer:', error);
            }
        } else {
            // Reuse existing stream viewer - make sure it's attached to current container
            const existingViewer = activeStreamViewers.get(data.sessionId);
            if (existingViewer && existingViewer.parentNode !== containerEl) {
                containerEl.appendChild(existingViewer);
            }
        }
        // NOTE: Don't freeze here - data.status is step status, not task status
        // The viewer stays active until the tool execution completes
    }

    // Header with session info and URL
    if (data.sessionId || data.currentUrl) {
        const headerEl = document.createElement('div');
        headerEl.className = 'browser-steps-header';

        let headerText = '';
        if (data.sessionId) {
            headerText += `Session: ${escapeHtml(data.sessionId)}`;
        }
        if (data.currentUrl) {
            if (headerText) headerText += ' • ';
            const truncatedUrl = data.currentUrl.length > 50
                ? data.currentUrl.substring(0, 50) + '...'
                : data.currentUrl;
            headerText += escapeHtml(truncatedUrl);
        }

        headerEl.textContent = headerText;
        containerEl.appendChild(headerEl);
    }

    // Steps list
    const stepsListEl = document.createElement('div');
    stepsListEl.className = 'browser-steps-list';

    data.browserSteps.forEach(step => {
        const stepEl = document.createElement('div');
        stepEl.className = `browser-step ${BROWSER_STEP_STATUS[step.status]?.colorClass || ''}`;

        // Status icon
        const iconEl = document.createElement('span');
        iconEl.className = 'browser-step-icon';
        iconEl.textContent = BROWSER_STEP_STATUS[step.status]?.icon || '○';

        // Step number
        const numberEl = document.createElement('span');
        numberEl.className = 'browser-step-number';
        numberEl.textContent = `${step.stepNumber}. `;

        // Action type
        const actionEl = document.createElement('span');
        actionEl.className = 'browser-step-action';
        actionEl.textContent = formatBrowserAction(step.action);

        stepEl.appendChild(iconEl);
        stepEl.appendChild(numberEl);
        stepEl.appendChild(actionEl);

        // Reasoning (if available)
        if (step.reasoning) {
            const reasoningEl = document.createElement('span');
            reasoningEl.className = 'browser-step-reasoning';
            const truncatedReasoning = step.reasoning.length > 60
                ? step.reasoning.substring(0, 60) + '...'
                : step.reasoning;
            reasoningEl.textContent = ` - ${truncatedReasoning}`;
            stepEl.appendChild(reasoningEl);
        }

        stepsListEl.appendChild(stepEl);
    });

    containerEl.appendChild(stepsListEl);

    // Overall status indicator
    const statusEl = document.createElement('div');
    statusEl.className = `browser-steps-status browser-steps-status-${data.status}`;

    switch (data.status) {
        case 'running':
            statusEl.textContent = 'Running...';
            break;
        case 'completed':
            statusEl.textContent = `Completed (${data.browserSteps.length} step${data.browserSteps.length !== 1 ? 's' : ''})`;
            break;
        case 'error':
            statusEl.textContent = 'Error occurred';
            break;
        case 'cancelled':
            statusEl.textContent = 'Cancelled';
            break;
        default:
            statusEl.textContent = data.status;
    }

    containerEl.appendChild(statusEl);

    return containerEl;
}

/**
 * Format browser action type for display
 * @param {string} action - Raw action type
 * @returns {string} - Formatted action name
 */
function formatBrowserAction(action) {
    const actionMap = {
        click: 'Click',
        type: 'Type',
        navigate: 'Navigate',
        goto: 'Go to',
        scroll: 'Scroll',
        keypress: 'Key press',
        wait: 'Wait',
        screenshot: 'Screenshot',
        extract: 'Extract',
        observe: 'Observe',
    };
    return actionMap[action?.toLowerCase()] || action || 'Action';
}

// ============================================================================
// AUDITARIA: Agent Execution Controls (Phase 8)
// Now imported from agentControlsFactory.js for reuse in fullscreen mode
// ============================================================================