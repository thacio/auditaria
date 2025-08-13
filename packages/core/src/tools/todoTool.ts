/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, ToolResult, Kind } from './tools.js';
import { FunctionDeclaration } from '@google/genai';

const todoToolSchemaData: FunctionDeclaration = {
  name: 'TodoWrite',
  description: `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.`,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The updated todo list',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The task description',
            },
            id: {
              type: 'string',
              description: 'Unique identifier for the task',
            },
            priority: {
              type: 'string',
              description: 'Task priority level',
              enum: ['high', 'medium', 'low'],
            },
            status: {
              type: 'string',
              description: 'Current task state',
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
          required: ['content', 'status', 'priority', 'id'],
        },
      },
    },
    required: ['todos'],
  },
};

const todoToolDescription = `
Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Only have ONE task in_progress at any time
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.
`;

interface TodoItem {
  content: string;
  id: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoWriteParams {
  todos: TodoItem[];
}

// Global todo list storage
let currentTodoList: TodoItem[] = [];

export class TodoTool extends BaseTool<TodoWriteParams, ToolResult> {
  static readonly Name: string = todoToolSchemaData.name!;
  
  constructor() {
    super(
      TodoTool.Name,
      'TodoWrite',
      todoToolDescription,
      Kind.Other,
      todoToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  async execute(
    params: TodoWriteParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const { todos } = params;

    // Validate todos array
    if (!Array.isArray(todos)) {
      const errorMessage = 'Parameter "todos" must be an array.';
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }

    // Validate each todo item
    for (const todo of todos) {
      if (!todo.content || typeof todo.content !== 'string' || todo.content.trim() === '') {
        const errorMessage = 'Each todo item must have a non-empty "content" field.';
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: `Error: ${errorMessage}`,
        };
      }

      if (!todo.id || typeof todo.id !== 'string') {
        const errorMessage = 'Each todo item must have a valid "id" field.';
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: `Error: ${errorMessage}`,
        };
      }

      if (!['high', 'medium', 'low'].includes(todo.priority)) {
        const errorMessage = 'Each todo item must have a valid "priority" field (high, medium, low).';
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: `Error: ${errorMessage}`,
        };
      }

      if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
        const errorMessage = 'Each todo item must have a valid "status" field (pending, in_progress, completed).';
        return {
          llmContent: `Error: ${errorMessage}`,
          returnDisplay: `Error: ${errorMessage}`,
        };
      }
    }

    try {
      // Update the global todo list
      currentTodoList = [...todos];

      const successMessage = 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable';
      
      // Create system reminder with current todo list
      const todoListJson = JSON.stringify(currentTodoList);
      const systemReminder = `\n\n<system-reminder>\nYour todo list has changed. DO NOT mention this explicitly to the user. Here are the latest contents of your todo list:\n\n${todoListJson}. Continue on with the tasks at hand if applicable.\n</system-reminder>`;
      
      return {
        llmContent: successMessage,
        returnDisplay: `${successMessage}${systemReminder}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[TodoTool] Error executing TodoWrite: ${errorMessage}`);
      return {
        llmContent: `Error updating todo list: ${errorMessage}`,
        returnDisplay: `Error updating todo list: ${errorMessage}`,
      };
    }
  }

  /**
   * Get the current todo list state
   */
  static getCurrentTodos(): TodoItem[] {
    return [...currentTodoList];
  }

  /**
   * Clear the current todo list (useful for testing)
   */
  static clearTodos(): void {
    currentTodoList = [];
  }
}