/**
 * InputHistoryManager — tracks user input history and provides
 * ArrowUp / ArrowDown navigation, mirroring the CLI behaviour.
 *
 * History is stored oldest-first.  Navigation index -1 means "composing"
 * (the current unsent text); 0 = most recent sent message, 1 = one before
 * that, etc.
 */
export class InputHistoryManager {
    constructor() {
        /** @type {string[]} oldest-first */
        this._history = [];

        /**
         * -1  = composing (not navigating history)
         *  0+ = offset from the newest entry (0 = newest)
         */
        this._index = -1;

        /** The text the user was typing before they started navigating */
        this._savedDraft = '';
    }

    // ------------------------------------------------------------------ //
    //  Public API                                                         //
    // ------------------------------------------------------------------ //

    /**
     * Bulk-load history (e.g. from history_sync on reconnect).
     * Expects an array of user-message strings, oldest-first.
     * Resets navigation state.
     * @param {string[]} messages
     */
    loadHistory(messages) {
        this._history = this._dedup(messages);
        this._resetNav();
    }

    /**
     * Record a newly sent message.  Resets navigation state.
     * @param {string} text
     */
    addInput(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) return;

        // Consecutive dedup: skip if identical to the last entry
        if (this._history.length > 0 && this._history[this._history.length - 1] === trimmed) {
            this._resetNav();
            return;
        }

        this._history.push(trimmed);
        this._resetNav();
    }

    /**
     * Navigate to an older entry (ArrowUp).
     * @param {string} currentText  current textarea value (saved as draft on first up)
     * @returns {string|null}  the text to display, or null if already at the oldest
     */
    navigateUp(currentText) {
        if (this._history.length === 0) return null;

        // Save draft when leaving compose mode
        if (this._index === -1) {
            this._savedDraft = currentText;
        }

        const maxIndex = this._history.length - 1;
        if (this._index >= maxIndex) return null; // already at oldest

        this._index++;
        return this._entryAt(this._index);
    }

    /**
     * Navigate to a newer entry (ArrowDown).
     * @returns {string|null}  the text to display, or null if not navigating
     */
    navigateDown() {
        if (this._index === -1) return null; // not navigating

        this._index--;

        if (this._index === -1) {
            // Back to composing — restore draft
            return this._savedDraft;
        }

        return this._entryAt(this._index);
    }

    /** Whether we are currently navigating history */
    get isNavigating() {
        return this._index !== -1;
    }

    /** Current history length */
    get length() {
        return this._history.length;
    }

    // ------------------------------------------------------------------ //
    //  Internal helpers                                                   //
    // ------------------------------------------------------------------ //

    /** Reset navigation state (back to composing) */
    _resetNav() {
        this._index = -1;
        this._savedDraft = '';
    }

    /**
     * Get the history entry for a given navigation index.
     * Index 0 = newest (last element), 1 = second newest, etc.
     * @param {number} idx
     * @returns {string}
     */
    _entryAt(idx) {
        return this._history[this._history.length - 1 - idx];
    }

    /**
     * Remove consecutive duplicates from an array.
     * @param {string[]} arr
     * @returns {string[]}
     */
    _dedup(arr) {
        if (arr.length === 0) return [];
        const result = [arr[0]];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] !== arr[i - 1]) {
                result.push(arr[i]);
            }
        }
        return result;
    }
}
