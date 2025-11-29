/**
 * SlashAutocompleteManager - Inline autocomplete for slash commands
 * Provides CLI-like autocomplete experience in the web interface
 */

import { escapeHtml } from '../utils/formatters.js';

export class SlashAutocompleteManager {
    constructor(inputElement, options = {}) {
        this.input = inputElement;
        this.commands = [];
        this.suggestions = [];
        this.selectedIndex = 0;
        this.isVisible = false;
        this.completionStart = 0;
        this.debounceTimer = null;
        this.debounceDelay = options.debounceDelay || 50;
        this.maxSuggestions = options.maxSuggestions || 100;
        this.onSelect = options.onSelect || null;

        // Create dropdown element
        this.dropdownEl = this.createDropdown();

        // Bind event handlers
        this.handleInputBound = this.handleInput.bind(this);
        this.handleBlurBound = this.handleBlur.bind(this);
        this.handleScrollBound = this.handleScroll.bind(this);

        // Attach listeners
        this.input.addEventListener('input', this.handleInputBound);
        this.input.addEventListener('blur', this.handleBlurBound);

        // Hide on scroll
        const messagesContainer = document.querySelector('.messages-container');
        if (messagesContainer) {
            messagesContainer.addEventListener('scroll', this.handleScrollBound);
        }
    }

    /**
     * Create the dropdown DOM element
     */
    createDropdown() {
        const dropdown = document.createElement('div');
        dropdown.className = 'slash-autocomplete-dropdown';
        dropdown.innerHTML = '<div class="autocomplete-list"></div>';

        // Insert dropdown before the input container
        const inputContainer = this.input.closest('.input-container');
        if (inputContainer) {
            inputContainer.style.position = 'relative';
            inputContainer.insertBefore(dropdown, inputContainer.firstChild);
        } else {
            // Fallback: insert next to input
            this.input.parentNode.insertBefore(dropdown, this.input);
        }

        // Handle click on suggestions
        dropdown.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Prevent blur
            const item = e.target.closest('.autocomplete-item');
            if (item) {
                const index = parseInt(item.dataset.index, 10);
                if (!isNaN(index) && this.suggestions[index]) {
                    this.insertSuggestion(this.suggestions[index]);
                }
            }
        });

        return dropdown;
    }

    /**
     * Set available slash commands
     */
    setCommands(commands) {
        this.commands = commands || [];
    }

    /**
     * Handle input changes with debounce
     */
    handleInput() {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.updateSuggestions();
        }, this.debounceDelay);
    }

    /**
     * Handle blur - hide dropdown after small delay
     */
    handleBlur() {
        setTimeout(() => {
            this.hide();
        }, 150);
    }

    /**
     * Handle scroll - hide dropdown
     */
    handleScroll() {
        if (this.isVisible) {
            this.hide();
        }
    }

    /**
     * Handle keyboard navigation
     * @returns {boolean} True if the event was consumed
     */
    handleKeyDown(event) {
        if (!this.isVisible) {
            return false;
        }

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                this.selectIndex(this.selectedIndex + 1);
                return true;

            case 'ArrowUp':
                event.preventDefault();
                this.selectIndex(this.selectedIndex - 1);
                return true;

            case 'Tab':
                if (this.suggestions.length > 0) {
                    event.preventDefault();
                    this.insertSuggestion(this.suggestions[this.selectedIndex]);
                    return true;
                }
                break;

            case 'Enter':
                if (this.suggestions.length > 0 && this.isVisible) {
                    event.preventDefault();
                    this.insertSuggestion(this.suggestions[this.selectedIndex]);
                    return true;
                }
                break;

            case 'Escape':
                event.preventDefault();
                this.hide();
                return true;
        }

        return false;
    }

    /**
     * Update suggestions based on current input
     */
    updateSuggestions() {
        const text = this.input.value;
        const cursorPos = this.input.selectionStart;

        // Parse the query to find slash command context
        const parsed = this.parseQuery(text, cursorPos);

        if (!parsed) {
            this.hide();
            return;
        }

        // Get completion context (which commands to suggest)
        const context = this.getCompletionContext(parsed);

        if (!context) {
            this.hide();
            return;
        }

        // Filter commands
        const suggestions = this.filterCommands(
            context.partialText,
            context.commands,
            context.parentPath
        );

        if (suggestions.length === 0) {
            this.hide();
            return;
        }

        // Check for perfect match - hide if exact match with no subcommands
        if (this.isPerfectMatch(context, suggestions)) {
            this.hide();
            return;
        }

        this.suggestions = suggestions.slice(0, this.maxSuggestions);
        this.selectedIndex = 0;
        this.completionStart = parsed.slashIndex;
        this.show();
        this.renderSuggestions();
    }

    /**
     * Parse query to extract slash command context
     */
    parseQuery(text, cursorPosition) {
        // Get text before cursor
        const beforeCursor = text.slice(0, cursorPosition);

        // Find the last slash before cursor
        const lastSlashIndex = beforeCursor.lastIndexOf('/');

        if (lastSlashIndex === -1) {
            return null; // Not in slash command context
        }

        // Check if slash is at start of line or after whitespace (valid command start)
        if (lastSlashIndex > 0) {
            const charBefore = beforeCursor[lastSlashIndex - 1];
            if (charBefore !== ' ' && charBefore !== '\n' && charBefore !== '\t') {
                return null; // Slash is part of a path, not a command
            }
        }

        // Get text after slash
        const afterSlash = beforeCursor.slice(lastSlashIndex + 1);

        // Check if there's a newline between slash and cursor
        if (afterSlash.includes('\n')) {
            return null; // Command interrupted by newline
        }

        // Split into parts for nested commands
        const parts = afterSlash.split(/\s+/).filter(p => p);
        const hasTrailingSpace = afterSlash.length > 0 && /\s$/.test(afterSlash);

        return {
            slashIndex: lastSlashIndex,
            parts,
            hasTrailingSpace,
            partialText: hasTrailingSpace ? '' : (parts[parts.length - 1] || ''),
            afterSlash
        };
    }

    /**
     * Get completion context by walking the command tree
     */
    getCompletionContext(parsed) {
        let currentCommands = this.commands;
        let matchedPath = [];

        // Walk through matched parts
        for (let i = 0; i < parsed.parts.length; i++) {
            const part = parsed.parts[i];
            const isLast = i === parsed.parts.length - 1;

            if (isLast && !parsed.hasTrailingSpace) {
                // This is the part being typed - complete it
                return {
                    commands: currentCommands,
                    parentPath: matchedPath,
                    partialText: part
                };
            }

            // Find matching command (check name and altNames)
            const match = currentCommands.find(c =>
                c.name.toLowerCase() === part.toLowerCase() ||
                (c.altNames && c.altNames.some(a => a.toLowerCase() === part.toLowerCase()))
            );

            if (!match) {
                return null; // Invalid command path
            }

            matchedPath.push(match.name);

            if (match.subCommands && match.subCommands.length > 0) {
                currentCommands = match.subCommands;
            } else {
                // Command has no subcommands
                if (isLast && parsed.hasTrailingSpace) {
                    // User typed a space after a command with no subcommands
                    return null;
                }
                return null;
            }
        }

        // No parts or trailing space - complete next level
        return {
            commands: currentCommands,
            parentPath: matchedPath,
            partialText: ''
        };
    }

    /**
     * Filter commands based on partial text
     */
    filterCommands(partialText, commands, parentPath = []) {
        if (!commands || commands.length === 0) {
            return [];
        }

        const results = [];
        const lower = partialText.toLowerCase();

        for (const cmd of commands) {
            // Skip hidden commands
            if (cmd.hidden) continue;

            let matchScore = -1;
            let matchedOn = null;

            // Check main name
            const nameIndex = cmd.name.toLowerCase().indexOf(lower);
            if (nameIndex !== -1) {
                matchScore = nameIndex === 0 ? 0 : 1; // Prefix match scores highest
                matchedOn = cmd.name;
            }

            // Check alt names if no main match
            if (matchScore === -1 && cmd.altNames) {
                for (const alias of cmd.altNames) {
                    const aliasIndex = alias.toLowerCase().indexOf(lower);
                    if (aliasIndex !== -1) {
                        matchScore = aliasIndex === 0 ? 0.5 : 1.5;
                        matchedOn = alias;
                        break;
                    }
                }
            }

            // If empty partial, include all
            if (!partialText) {
                matchScore = 0;
                matchedOn = cmd.name;
            }

            if (matchScore !== -1) {
                const fullPath = [...parentPath, cmd.name].join(' ');
                results.push({
                    label: '/' + fullPath,
                    value: cmd.name,
                    description: cmd.description || '',
                    command: cmd,
                    matchScore,
                    matchedOn,
                    hasSubCommands: cmd.subCommands && cmd.subCommands.length > 0
                });
            }
        }

        // Sort: prefix matches first, then by name
        results.sort((a, b) => {
            if (a.matchScore !== b.matchScore) {
                return a.matchScore - b.matchScore;
            }
            return a.value.localeCompare(b.value);
        });

        return results;
    }

    /**
     * Check if current input is a perfect match
     */
    isPerfectMatch(context, suggestions) {
        if (!context.partialText || suggestions.length === 0) {
            return false;
        }

        const lower = context.partialText.toLowerCase();
        const exactMatch = suggestions.find(s =>
            s.value.toLowerCase() === lower ||
            (s.command.altNames && s.command.altNames.some(a => a.toLowerCase() === lower))
        );

        // Perfect match only if exact match and command has no subcommands
        if (exactMatch && !exactMatch.hasSubCommands) {
            return true;
        }

        return false;
    }

    /**
     * Select a suggestion by index
     */
    selectIndex(index) {
        if (this.suggestions.length === 0) return;

        // Wrap around
        if (index < 0) {
            index = this.suggestions.length - 1;
        } else if (index >= this.suggestions.length) {
            index = 0;
        }

        this.selectedIndex = index;
        this.updateSelection();
        this.scrollToSelected();
    }

    /**
     * Update visual selection
     */
    updateSelection() {
        const items = this.dropdownEl.querySelectorAll('.autocomplete-item');
        items.forEach((item, i) => {
            item.classList.toggle('selected', i === this.selectedIndex);
        });
    }

    /**
     * Scroll dropdown to show selected item
     */
    scrollToSelected() {
        const list = this.dropdownEl.querySelector('.autocomplete-list');
        const selected = list.querySelector('.autocomplete-item.selected');
        if (selected) {
            selected.scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Render suggestions in dropdown
     */
    renderSuggestions() {
        const list = this.dropdownEl.querySelector('.autocomplete-list');

        if (this.suggestions.length === 0) {
            list.innerHTML = '<div class="autocomplete-empty">No matching commands</div>';
            return;
        }

        list.innerHTML = this.suggestions.map((s, i) => {
            const selected = i === this.selectedIndex ? 'selected' : '';
            const subIcon = s.hasSubCommands ? '<span class="autocomplete-subicon">+</span>' : '';

            return `
                <div class="autocomplete-item ${selected}" data-index="${i}">
                    <span class="autocomplete-command">${escapeHtml(s.label)}${subIcon}</span>
                    <span class="autocomplete-description">${escapeHtml(s.description)}</span>
                </div>
            `;
        }).join('');
    }

    /**
     * Insert selected suggestion into input
     */
    insertSuggestion(suggestion) {
        if (!suggestion) return;

        const text = this.input.value;
        const cursorPos = this.input.selectionStart;
        const parsed = this.parseQuery(text, cursorPos);

        if (!parsed) return;

        // Get the context to build full command path
        const context = this.getCompletionContext(parsed);
        if (!context) return;

        // Build the full command with the selected value
        const fullCommand = [...context.parentPath, suggestion.value].join(' ');

        // Calculate replacement range
        const replaceStart = parsed.slashIndex + 1; // After the /
        const replaceEnd = cursorPos;

        // Build new text
        const before = text.slice(0, parsed.slashIndex + 1);
        const after = text.slice(replaceEnd);
        const newText = before + fullCommand + ' ' + after.trimStart();

        // Update input
        this.input.value = newText;

        // Position cursor after the inserted command
        const newCursorPos = parsed.slashIndex + 1 + fullCommand.length + 1;
        this.input.setSelectionRange(newCursorPos, newCursorPos);

        // Trigger input event for auto-resize
        this.input.dispatchEvent(new Event('input', { bubbles: true }));

        // Callback
        if (this.onSelect) {
            this.onSelect(suggestion);
        }

        // Check if selected command has subcommands - show them
        if (suggestion.hasSubCommands) {
            // Small delay to let input update
            setTimeout(() => {
                this.updateSuggestions();
            }, 10);
        } else {
            this.hide();
        }
    }

    /**
     * Show the dropdown
     */
    show() {
        if (!this.isVisible) {
            this.dropdownEl.classList.add('visible');
            this.isVisible = true;
        }
    }

    /**
     * Hide the dropdown
     */
    hide() {
        if (this.isVisible) {
            this.dropdownEl.classList.remove('visible');
            this.isVisible = false;
            this.suggestions = [];
            this.selectedIndex = 0;
        }
    }

    /**
     * Cleanup
     */
    destroy() {
        clearTimeout(this.debounceTimer);
        this.input.removeEventListener('input', this.handleInputBound);
        this.input.removeEventListener('blur', this.handleBlurBound);

        const messagesContainer = document.querySelector('.messages-container');
        if (messagesContainer) {
            messagesContainer.removeEventListener('scroll', this.handleScrollBound);
        }

        if (this.dropdownEl && this.dropdownEl.parentNode) {
            this.dropdownEl.parentNode.removeChild(this.dropdownEl);
        }
    }
}
