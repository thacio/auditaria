/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { ContextMenu } from './ContextMenu.js';

/**
 * DiffContextMenu — right-click context menu for diff editors.
 *
 * Attaches to a Monaco diff editor's modified side.
 * When the cursor is on a changed hunk:
 *   - Shows "Revert This Change", "Copy Original", "Revert All Changes"
 * When the cursor is NOT on a hunk:
 *   - Falls through to Monaco's native context menu
 *
 * All reverts use executeEdits() so Ctrl+Z works.
 */
export class DiffContextMenu {
  /**
   * @param {object} diffEditor - Monaco IDiffEditor instance
   * @param {object} monaco - Monaco namespace (for Range, etc.)
   */
  constructor(diffEditor, monaco) {
    this.diffEditor = diffEditor;
    this.monaco = monaco;
    this.contextMenu = new ContextMenu();
    this.disposables = [];

    this.attach();
  }

  /**
   * Attach the context menu listener to the modified (right) editor
   */
  attach() {
    const modifiedEditor = this.diffEditor.getModifiedEditor();

    const disposable = modifiedEditor.onContextMenu((e) => {
      const position = e.target?.position;
      if (!position) return;

      const hunk = this.findHunkAtLine(position.lineNumber);
      if (!hunk) {
        // Not on a hunk — let Monaco's native context menu handle it
        return;
      }

      // On a changed hunk — suppress Monaco's menu and show ours
      e.event.preventDefault();
      e.event.stopPropagation();

      const items = this.buildMenuItems(hunk);
      this.contextMenu.show(
        e.event.posx ?? e.event.clientX ?? e.event.browserEvent?.clientX ?? 0,
        e.event.posy ?? e.event.clientY ?? e.event.browserEvent?.clientY ?? 0,
        items
      );
    });

    this.disposables.push(disposable);
  }

  /**
   * Find the diff hunk containing the given line number (in the modified editor)
   * @param {number} lineNumber
   * @returns {object|null} The matching ILineChange or null
   */
  findHunkAtLine(lineNumber) {
    const changes = this.diffEditor.getLineChanges();
    if (!changes) return null;

    for (const change of changes) {
      // Modification or insertion: modifiedEndLineNumber > 0
      if (change.modifiedEndLineNumber > 0) {
        if (lineNumber >= change.modifiedStartLineNumber &&
            lineNumber <= change.modifiedEndLineNumber) {
          return change;
        }
      }
      // Deletion: modifiedEndLineNumber === 0, lines only exist in original
      // The deletion marker sits at modifiedStartLineNumber (the line after which content was deleted)
      else if (change.modifiedEndLineNumber === 0) {
        if (lineNumber === change.modifiedStartLineNumber ||
            lineNumber === change.modifiedStartLineNumber + 1) {
          return change;
        }
      }
    }

    return null;
  }

  /**
   * Build context menu items for a hunk
   * @param {object} hunk - ILineChange
   * @returns {Array} Menu items
   */
  buildMenuItems(hunk) {
    const items = [
      {
        label: 'Revert This Change',
        icon: 'codicon codicon-discard',
        action: () => this.revertHunk(hunk)
      },
      {
        label: 'Copy Original',
        icon: 'codicon codicon-copy',
        action: () => this.copyOriginal(hunk)
      },
      { separator: true },
      {
        label: 'Revert All Changes',
        icon: 'codicon codicon-clear-all',
        action: () => this.revertAll()
      }
    ];

    return items;
  }

  /**
   * Revert a single hunk: replace modified lines with original lines.
   * Uses executeEdits for undo stack integration (Ctrl+Z works).
   * @param {object} hunk - ILineChange
   */
  revertHunk(hunk) {
    const { Range } = this.monaco;
    const modifiedEditor = this.diffEditor.getModifiedEditor();
    const modifiedModel = modifiedEditor.getModel();
    const originalModel = this.diffEditor.getOriginalEditor().getModel();

    if (!modifiedModel || !originalModel) return;

    let editRange;
    let originalText;

    if (hunk.originalEndLineNumber === 0) {
      // Pure insertion — content only in modified, nothing in original.
      // Delete the inserted lines from modified.
      const lastCol = modifiedModel.getLineMaxColumn(hunk.modifiedEndLineNumber);

      if (hunk.modifiedStartLineNumber === 1) {
        // Insertion at very beginning — delete lines and the trailing newline
        const nextLineExists = hunk.modifiedEndLineNumber < modifiedModel.getLineCount();
        editRange = new Range(
          1, 1,
          nextLineExists ? hunk.modifiedEndLineNumber + 1 : hunk.modifiedEndLineNumber,
          nextLineExists ? 1 : lastCol
        );
      } else {
        // Delete from end of previous line (to eat the newline) through end of last inserted line
        const prevLineLastCol = modifiedModel.getLineMaxColumn(hunk.modifiedStartLineNumber - 1);
        editRange = new Range(
          hunk.modifiedStartLineNumber - 1, prevLineLastCol,
          hunk.modifiedEndLineNumber, lastCol
        );
      }

      originalText = '';
    } else if (hunk.modifiedEndLineNumber === 0) {
      // Pure deletion — content only in original, nothing in modified.
      // Insert the original lines into modified.
      const origLastCol = originalModel.getLineMaxColumn(hunk.originalEndLineNumber);
      originalText = originalModel.getValueInRange(
        new Range(hunk.originalStartLineNumber, 1, hunk.originalEndLineNumber, origLastCol)
      );

      // Insert after modifiedStartLineNumber (the deletion marker line)
      const insertLine = hunk.modifiedStartLineNumber;
      const insertCol = modifiedModel.getLineMaxColumn(insertLine);
      editRange = new Range(insertLine, insertCol, insertLine, insertCol);
      originalText = '\n' + originalText;
    } else {
      // Modification — replace modified lines with original lines
      const origLastCol = originalModel.getLineMaxColumn(hunk.originalEndLineNumber);
      originalText = originalModel.getValueInRange(
        new Range(hunk.originalStartLineNumber, 1, hunk.originalEndLineNumber, origLastCol)
      );

      const modLastCol = modifiedModel.getLineMaxColumn(hunk.modifiedEndLineNumber);
      editRange = new Range(
        hunk.modifiedStartLineNumber, 1,
        hunk.modifiedEndLineNumber, modLastCol
      );
    }

    modifiedEditor.executeEdits('revert-change', [{
      range: editRange,
      text: originalText
    }]);
  }

  /**
   * Copy the original (left-side) content of a hunk to clipboard
   * @param {object} hunk - ILineChange
   */
  copyOriginal(hunk) {
    const { Range } = this.monaco;
    const originalModel = this.diffEditor.getOriginalEditor().getModel();
    if (!originalModel) return;

    if (hunk.originalEndLineNumber === 0) {
      // Pure insertion — no original content to copy
      return;
    }

    const origLastCol = originalModel.getLineMaxColumn(hunk.originalEndLineNumber);
    const text = originalModel.getValueInRange(
      new Range(hunk.originalStartLineNumber, 1, hunk.originalEndLineNumber, origLastCol)
    );

    navigator.clipboard.writeText(text).catch((err) => {
      console.warn('Failed to copy to clipboard:', err);
    });
  }

  /**
   * Revert all changes: replace entire modified content with original content
   */
  revertAll() {
    const modifiedEditor = this.diffEditor.getModifiedEditor();
    const modifiedModel = modifiedEditor.getModel();
    const originalModel = this.diffEditor.getOriginalEditor().getModel();

    if (!modifiedModel || !originalModel) return;

    const originalText = originalModel.getValue();
    const fullRange = modifiedModel.getFullModelRange();

    modifiedEditor.executeEdits('revert-all', [{
      range: fullRange,
      text: originalText
    }]);
  }

  /**
   * Dispose all listeners and the context menu
   */
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    if (this.contextMenu) {
      this.contextMenu.destroy();
      this.contextMenu = null;
    }
  }
}
