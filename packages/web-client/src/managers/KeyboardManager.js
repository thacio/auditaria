/**
 * Extensible keyboard shortcut manager
 */
export class KeyboardManager {
    constructor() {
        this.shortcuts = new Map();
        this.isEnabled = false;
        this.setupGlobalListener();
    }
    
    /**
     * Register a keyboard shortcut
     * @param {string} key - The key code (e.g., 'Escape', 'KeyS')
     * @param {function} callback - Function to call when shortcut is pressed
     * @param {object} modifiers - Optional modifiers like { ctrl: true, shift: true }
     */
    register(key, callback, modifiers = {}) {
        const shortcutKey = this.createShortcutKey(key, modifiers);
        this.shortcuts.set(shortcutKey, callback);
    }
    
    /**
     * Unregister a keyboard shortcut
     */
    unregister(key, modifiers = {}) {
        const shortcutKey = this.createShortcutKey(key, modifiers);
        this.shortcuts.delete(shortcutKey);
    }
    
    /**
     * Create a unique key for the shortcut map
     */
    createShortcutKey(key, modifiers) {
        const parts = [];
        if (modifiers.ctrl) parts.push('ctrl');
        if (modifiers.shift) parts.push('shift');
        if (modifiers.alt) parts.push('alt');
        if (modifiers.meta) parts.push('meta');
        parts.push(key);
        return parts.join('+');
    }
    
    /**
     * Enable keyboard shortcuts
     */
    enable() {
        this.isEnabled = true;
    }
    
    /**
     * Disable keyboard shortcuts
     */
    disable() {
        this.isEnabled = false;
    }
    
    /**
     * Set up global keyboard listener
     */
    setupGlobalListener() {
        document.addEventListener('keydown', (event) => {
            if (!this.isEnabled) return;
            
            const modifiers = {
                ctrl: event.ctrlKey,
                shift: event.shiftKey,
                alt: event.altKey,
                meta: event.metaKey
            };
            
            const shortcutKey = this.createShortcutKey(event.code, modifiers);
            const callback = this.shortcuts.get(shortcutKey);
            
            if (callback) {
                event.preventDefault();
                callback(event);
            }
        });
    }
    
    /**
     * Clear all registered shortcuts
     */
    clear() {
        this.shortcuts.clear();
    }
}