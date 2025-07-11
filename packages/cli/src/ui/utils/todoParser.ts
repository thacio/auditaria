/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface TodoItem {
  content: string;
  id: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Extracts todo list from TodoWrite tool's returnDisplay string
 * which contains a system reminder with the JSON todo list
 */
export function extractTodosFromDisplay(resultDisplay: string): TodoItem[] | null {
  try {
    // Look for the system reminder section
    const systemReminderMatch = resultDisplay.match(
      /<system-reminder>[\s\S]*?Here are the latest contents of your todo list:\s*(.*?)\. Continue on with the tasks/
    );
    
    if (!systemReminderMatch) {
      return null;
    }
    
    const todosJsonString = systemReminderMatch[1].trim();
    const todos = JSON.parse(todosJsonString) as TodoItem[];
    
    // Validate the structure
    if (!Array.isArray(todos)) {
      return null;
    }
    
    // Basic validation of todo items
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
 * Checks if the result display is from a TodoWrite tool
 */
export function isTodoWriteResult(resultDisplay: string): boolean {
  return resultDisplay.includes('Todos have been modified successfully') &&
         resultDisplay.includes('<system-reminder>') &&
         resultDisplay.includes('Your todo list has changed');
}