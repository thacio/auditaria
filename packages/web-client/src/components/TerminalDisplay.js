/**
 * Terminal Display Component
 * Displays captured terminal output and handles keyboard input
 */

export class TerminalDisplay {
    constructor(wsManager) {
        this.wsManager = wsManager;
        this.modal = null;
        this.contentElement = null;
        this.isVisible = false;
        this.initializeModal();
    }
    
    initializeModal() {
        // Create modal structure
        this.modal = document.createElement('div');
        this.modal.className = 'terminal-modal';
        this.modal.style.display = 'none';
        this.modal.innerHTML = `
            <div class="terminal-modal-content">
                <div class="terminal-header">
                    <h3 id="terminal-title">Terminal Screen</h3>
                    <div class="terminal-help">
                        Use arrow keys, Enter, Escape, Tab to navigate
                    </div>
                </div>
                <div id="terminal-content" class="terminal-content"></div>
                <div class="terminal-footer">
                    <div class="terminal-status">
                        <span id="terminal-status-text">Interactive mode - Keyboard input is captured</span>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(this.modal);
        this.contentElement = document.getElementById('terminal-content');
        
        // Set up keyboard event handler
        this.setupKeyboardHandler();
    }
    
    setupKeyboardHandler() {
        // Capture keyboard events when terminal is visible
        document.addEventListener('keydown', (e) => {
            if (!this.isVisible) return;
            
            // Prevent default browser behavior for special keys
            const preventDefaultKeys = [
                'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                'Enter', 'Escape', 'Tab', 'Backspace', ' '
            ];
            
            if (preventDefaultKeys.includes(e.key)) {
                e.preventDefault();
            }
            
            // Convert keyboard event to terminal input format
            const keyData = this.convertKeyEvent(e);
            
            // Send to CLI via WebSocket
            if (keyData) {
                this.wsManager.sendTerminalInput(keyData);
            }
        });
        
        // Also capture regular character input
        document.addEventListener('keypress', (e) => {
            if (!this.isVisible) return;
            
            e.preventDefault();
            
            // Send character input
            const keyData = {
                name: null,
                sequence: e.key,
                ctrl: e.ctrlKey,
                meta: e.metaKey,
                shift: e.shiftKey,
                alt: e.altKey
            };
            
            this.wsManager.sendTerminalInput(keyData);
        });
    }
    
    convertKeyEvent(event) {
        // Map browser key events to terminal key format compatible with Ink/React
        const keyMap = {
            'ArrowUp': { name: 'up', sequence: '\x1b[A' },
            'ArrowDown': { name: 'down', sequence: '\x1b[B' },
            'ArrowLeft': { name: 'left', sequence: '\x1b[D' },
            'ArrowRight': { name: 'right', sequence: '\x1b[C' },
            'Enter': { name: 'return', sequence: '\r' },
            'Escape': { name: 'escape', sequence: '\x1b' },
            'Tab': { name: 'tab', sequence: '\t' },
            'Backspace': { name: 'backspace', sequence: '\x7f' },
            ' ': { name: 'space', sequence: ' ' }
        };
        
        if (keyMap[event.key]) {
            return {
                ...keyMap[event.key],
                ctrl: event.ctrlKey,
                meta: event.metaKey,
                shift: event.shiftKey,
                alt: event.altKey
            };
        }
        
        // Handle Ctrl+C
        if (event.ctrlKey && event.key === 'c') {
            return {
                name: 'c',
                sequence: '\x03',
                ctrl: true,
                meta: false,
                shift: false,
                alt: false
            };
        }
        
        // Handle Ctrl+D
        if (event.ctrlKey && event.key === 'd') {
            return {
                name: 'd',
                sequence: '\x04',
                ctrl: true,
                meta: false,
                shift: false,
                alt: false
            };
        }
        
        return null;
    }
    
    show(terminalData) {
        if (!terminalData || !terminalData.content) {
            this.hide();
            return;
        }
        
        // Update content with HTML from ANSI conversion
        this.contentElement.innerHTML = terminalData.content;
        
        // Apply terminal styling
        this.contentElement.style.fontFamily = 'monospace';
        this.contentElement.style.whiteSpace = 'pre';
        this.contentElement.style.overflow = 'auto';
        this.contentElement.style.padding = '10px';
        this.contentElement.style.backgroundColor = '#0d1117';
        this.contentElement.style.color = '#c9d1d9';
        this.contentElement.style.borderRadius = '6px';
        this.contentElement.style.minHeight = '400px';
        this.contentElement.style.maxHeight = '70vh';
        
        // Show modal
        this.modal.style.display = 'flex';
        this.isVisible = true;
        
        // Auto-scroll to bottom after a short delay to ensure content is rendered
        setTimeout(() => {
            this.contentElement.scrollTop = this.contentElement.scrollHeight;
        }, 10);
        
        // Focus on the modal for keyboard input
        this.modal.focus();
    }
    
    hide() {
        this.modal.style.display = 'none';
        this.isVisible = false;
    }
    
    update(terminalData) {
        if (this.isVisible && terminalData && terminalData.content) {
            // Update the content
            this.contentElement.innerHTML = terminalData.content;
            // Auto-scroll to bottom after a short delay to ensure content is rendered
            setTimeout(() => {
                this.contentElement.scrollTop = this.contentElement.scrollHeight;
            }, 10);
        } else if (!terminalData || !terminalData.content) {
            this.hide();
        }
    }
}