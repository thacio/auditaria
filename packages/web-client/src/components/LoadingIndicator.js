/**
 * Loading indicator component for AI thinking states
 */

export class LoadingIndicator {
    constructor() {
        this.loadingIndicator = document.getElementById('loading-indicator');
        this.loadingText = document.getElementById('loading-text');
        this.loadingTime = document.getElementById('loading-time');
        this.loadingHeader = document.getElementById('loading-header');
        this.loadingExpandIndicator = document.getElementById('loading-expand-indicator');
        this.loadingExpandableContent = document.getElementById('loading-expandable-content');
        this.loadingDescription = document.getElementById('loading-description');
        
        this.isThoughtsExpanded = false;
        this.currentThoughtObject = null;
        this.lastLoggedSubject = null;
        this.isLoading = false;
        
        this.setupEventHandlers();
    }
    
    /**
     * Set up event handlers for expansion
     */
    setupEventHandlers() {
        // Loading indicator expand/collapse handler
        this.loadingHeader.addEventListener('click', () => {
            this.toggleThoughtsExpansion();
        });
        
        // Keyboard accessibility for loading header
        this.loadingHeader.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.toggleThoughtsExpansion();
            }
        });
        
        // Set initial state
        this.loadingHeader.style.cursor = 'default';
        this.loadingHeader.setAttribute('aria-label', 'AI is thinking');
    }
    
    /**
     * Update loading state
     */
    updateLoadingState(loadingState) {
        this.isLoading = loadingState.isLoading;
        
        if (loadingState.isLoading) {
            this.show(loadingState);
        } else {
            this.hide();
        }
        
        return this.isLoading;
    }
    
    /**
     * Show loading indicator
     */
    show(loadingState) {
        // Update loading text (subject from thought or fallback)
        const loadingMessage = loadingState.thought || loadingState.currentLoadingPhrase || 'Thinking...';
        this.loadingText.textContent = loadingMessage;
        
        // Update elapsed time with ESC cancel text (matching CLI format)
        const timeText = loadingState.elapsedTime < 60 
            ? `(esc to cancel, ${loadingState.elapsedTime}s)` 
            : `(esc to cancel, ${Math.floor(loadingState.elapsedTime / 60)}m ${loadingState.elapsedTime % 60}s)`;
        this.loadingTime.textContent = timeText;
        
        // Update thought content with full thought object
        this.updateThoughtContent(loadingState.thoughtObject);
        
        // Show the loading indicator with animation
        if (this.loadingIndicator.style.display === 'none') {
            this.loadingIndicator.style.display = 'block';
            this.loadingIndicator.classList.remove('hidden');
            
            // Restore previous expansion state if it was expanded
            if (this.isThoughtsExpanded && this.currentThoughtObject && this.currentThoughtObject.description) {
                this.loadingIndicator.classList.add('expanded');
            }
        }
    }
    
    /**
     * Hide loading indicator
     */
    hide() {
        if (this.loadingIndicator.style.display !== 'none') {
            this.loadingIndicator.classList.add('hidden');
            setTimeout(() => {
                this.loadingIndicator.style.display = 'none';
                this.loadingIndicator.classList.remove('hidden');
                // Keep expansion state persistent across hide/show cycles
            }, 300); // Match animation duration
        }
    }
    
    /**
     * Reset the expansion state (only call when appropriate, like on conversation clear)
     */
    resetThoughtsExpansion() {
        this.isThoughtsExpanded = false;
        this.loadingIndicator.classList.remove('expanded');
        this.currentThoughtObject = null;
    }
    
    /**
     * Toggle the expansion of the thoughts section
     */
    toggleThoughtsExpansion() {
        // Only allow expansion if there's thought content
        if (!this.currentThoughtObject || !this.currentThoughtObject.description) {
            return;
        }
        
        this.isThoughtsExpanded = !this.isThoughtsExpanded;
        
        if (this.isThoughtsExpanded) {
            this.loadingIndicator.classList.add('expanded');
        } else {
            this.loadingIndicator.classList.remove('expanded');
        }
        
        // Update accessibility attribute
        this.loadingHeader.setAttribute('aria-expanded', this.isThoughtsExpanded.toString());
    }
    
    /**
     * Update the thought content with smooth transitions
     */
    updateThoughtContent(thoughtObject) {
        if (!thoughtObject) {
            this.currentThoughtObject = null;
            this.loadingDescription.textContent = '';
            return;
        }
        
        // Store current thought object
        this.currentThoughtObject = thoughtObject;
        
        // Track subject changes for performance
        if (thoughtObject.subject !== this.lastLoggedSubject) {
            this.lastLoggedSubject = thoughtObject.subject;
        }
        
        // Update the description content with smooth fade transition
        this.updateThoughtDescriptionWithFade(this.currentThoughtObject.description || '');
        
        // Show/hide expand indicator based on whether there's description content
        if (this.currentThoughtObject.description && this.currentThoughtObject.description.trim()) {
            this.loadingExpandIndicator.style.display = 'block';
            this.loadingHeader.style.cursor = 'pointer';
            this.loadingHeader.setAttribute('aria-label', 'Expand AI thoughts');
            this.loadingHeader.setAttribute('aria-expanded', this.isThoughtsExpanded.toString());
        } else {
            this.loadingExpandIndicator.style.display = 'none';
            this.loadingHeader.style.cursor = 'default';
            this.loadingHeader.setAttribute('aria-label', 'AI is thinking');
            this.loadingHeader.removeAttribute('aria-expanded');
            // Collapse if expanded and no description
            if (this.isThoughtsExpanded) {
                this.isThoughtsExpanded = false;
                this.loadingIndicator.classList.remove('expanded');
            }
        }
    }
    
    /**
     * Update thought description with smooth fade out/in transition
     */
    updateThoughtDescriptionWithFade(newDescription) {
        const currentDescription = this.loadingDescription.textContent;
        
        // Only animate if content is actually changing and element is visible
        if (currentDescription === newDescription || !this.isThoughtsExpanded) {
            this.loadingDescription.textContent = newDescription;
            return;
        }
        
        // Fade out current content
        this.loadingDescription.classList.add('fading');
        
        // After fade out completes, update content and fade in
        setTimeout(() => {
            this.loadingDescription.textContent = newDescription;
            this.loadingDescription.classList.remove('fading');
        }, 150); // Half of the CSS transition duration for smooth crossfade
    }
    
    /**
     * Get current loading state
     */
    getState() {
        return {
            isLoading: this.isLoading,
            isExpanded: this.isThoughtsExpanded,
            thoughtObject: this.currentThoughtObject
        };
    }
}