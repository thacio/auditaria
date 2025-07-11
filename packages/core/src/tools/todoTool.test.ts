/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TodoTool } from './todoTool.js';

describe('TodoTool', () => {
  let todoTool: TodoTool;

  beforeEach(() => {
    todoTool = new TodoTool();
    TodoTool.clearTodos(); // Clear any existing todos before each test
  });

  describe('Basic functionality', () => {
    it('should have correct static properties', () => {
      expect(TodoTool.Name).toBe('TodoWrite');
      expect(todoTool.name).toBe('TodoWrite');
      expect(todoTool.displayName).toBe('TodoWrite');
    });

    it('should have correct schema', () => {
      const schema = todoTool.schema;
      expect(schema.name).toBe('TodoWrite');
      expect(schema.description).toContain('structured task list');
      expect(schema.parameters).toBeDefined();
    });
  });

  describe('Parameter validation', () => {
    it('should reject non-array todos parameter', async () => {
      const result = await todoTool.execute(
        { todos: 'invalid' as any },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('must be an array');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should reject todo items with missing content', async () => {
      const invalidTodos = [
        {
          id: '1',
          priority: 'high' as const,
          status: 'pending' as const,
          // missing content
        }
      ];

      const result = await todoTool.execute(
        { todos: invalidTodos as any },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('non-empty "content" field');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should reject todo items with empty content', async () => {
      const invalidTodos = [
        {
          id: '1',
          content: '',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: invalidTodos as any },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('non-empty "content" field');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should reject todo items with missing id', async () => {
      const invalidTodos = [
        {
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
          // missing id
        }
      ];

      const result = await todoTool.execute(
        { todos: invalidTodos as any },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('valid "id" field');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should reject todo items with invalid priority', async () => {
      const invalidTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'invalid' as any,
          status: 'pending' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: invalidTodos },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('valid "priority" field');
      expect(result.returnDisplay).toContain('Error');
    });

    it('should reject todo items with invalid status', async () => {
      const invalidTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'invalid' as any,
        }
      ];

      const result = await todoTool.execute(
        { todos: invalidTodos },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('valid "status" field');
      expect(result.returnDisplay).toContain('Error');
    });
  });

  describe('Valid todo operations', () => {
    it('should successfully create and store a single todo', async () => {
      const validTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: validTodos },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('Todos have been modified successfully');
      expect(result.returnDisplay).toContain('Todos have been modified successfully');
      expect(result.returnDisplay).toContain('<system-reminder>');
      
      // Check that todos are stored
      const currentTodos = TodoTool.getCurrentTodos();
      expect(currentTodos).toHaveLength(1);
      expect(currentTodos[0]).toEqual(validTodos[0]);
    });

    it('should successfully create and store multiple todos', async () => {
      const validTodos = [
        {
          id: '1',
          content: 'First task',
          priority: 'high' as const,
          status: 'pending' as const,
        },
        {
          id: '2', 
          content: 'Second task',
          priority: 'medium' as const,
          status: 'in_progress' as const,
        },
        {
          id: '3',
          content: 'Third task',
          priority: 'low' as const,
          status: 'completed' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: validTodos },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('Todos have been modified successfully');
      expect(result.returnDisplay).toContain('Todos have been modified successfully');
      
      // Check that todos are stored
      const currentTodos = TodoTool.getCurrentTodos();
      expect(currentTodos).toHaveLength(3);
      expect(currentTodos).toEqual(validTodos);
    });

    it('should update existing todos when called again', async () => {
      // First set
      const firstTodos = [
        {
          id: '1',
          content: 'First task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      await todoTool.execute({ todos: firstTodos }, new AbortController().signal);
      
      // Updated set
      const updatedTodos = [
        {
          id: '1',
          content: 'First task',
          priority: 'high' as const,
          status: 'completed' as const,
        },
        {
          id: '2',
          content: 'New task',
          priority: 'medium' as const,
          status: 'pending' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: updatedTodos },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('Todos have been modified successfully');
      
      // Check that todos are updated
      const currentTodos = TodoTool.getCurrentTodos();
      expect(currentTodos).toHaveLength(2);
      expect(currentTodos).toEqual(updatedTodos);
    });

    it('should handle empty todos list', async () => {
      const result = await todoTool.execute(
        { todos: [] },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toContain('Todos have been modified successfully');
      expect(result.returnDisplay).toContain('Todos have been modified successfully');
      
      // Check that todos list is empty
      const currentTodos = TodoTool.getCurrentTodos();
      expect(currentTodos).toHaveLength(0);
    });
  });

  describe('Response format', () => {
    it('should include system reminder in return display', async () => {
      const validTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: validTodos },
        new AbortController().signal,
      );
      
      expect(result.returnDisplay).toContain('<system-reminder>');
      expect(result.returnDisplay).toContain('Your todo list has changed');
      expect(result.returnDisplay).toContain('DO NOT mention this explicitly to the user');
      expect(result.returnDisplay).toContain('Continue on with the tasks at hand if applicable');
    });

    it('should include todo list JSON in system reminder', async () => {
      const validTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: validTodos },
        new AbortController().signal,
      );
      
      const expectedJson = JSON.stringify(validTodos);
      expect(result.returnDisplay).toContain(expectedJson);
    });

    it('should include success message in llmContent', async () => {
      const validTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      const result = await todoTool.execute(
        { todos: validTodos },
        new AbortController().signal,
      );
      
      expect(result.llmContent).toBe('Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable');
    });
  });

  describe('Static utility methods', () => {
    it('should return current todos', () => {
      const validTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      // Execute to set todos
      todoTool.execute({ todos: validTodos }, new AbortController().signal);
      
      const currentTodos = TodoTool.getCurrentTodos();
      expect(currentTodos).toEqual(validTodos);
    });

    it('should clear todos', () => {
      const validTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      // Execute to set todos
      todoTool.execute({ todos: validTodos }, new AbortController().signal);
      
      // Verify todos exist
      expect(TodoTool.getCurrentTodos()).toHaveLength(1);
      
      // Clear todos
      TodoTool.clearTodos();
      
      // Verify todos are cleared
      expect(TodoTool.getCurrentTodos()).toHaveLength(0);
    });

    it('should return a copy of todos (immutable)', () => {
      const validTodos = [
        {
          id: '1',
          content: 'Test task',
          priority: 'high' as const,
          status: 'pending' as const,
        }
      ];

      // Execute to set todos
      todoTool.execute({ todos: validTodos }, new AbortController().signal);
      
      const currentTodos = TodoTool.getCurrentTodos();
      
      // Mutate the returned array
      currentTodos.push({
        id: '2',
        content: 'New task',
        priority: 'low' as const,
        status: 'pending' as const,
      });
      
      // Original should be unchanged
      const originalTodos = TodoTool.getCurrentTodos();
      expect(originalTodos).toHaveLength(1);
    });
  });

  describe('All priority and status combinations', () => {
    it('should accept all valid priority values', async () => {
      const priorities: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
      
      for (const priority of priorities) {
        const validTodos = [
          {
            id: '1',
            content: `Task with ${priority} priority`,
            priority,
            status: 'pending' as const,
          }
        ];

        const result = await todoTool.execute(
          { todos: validTodos },
          new AbortController().signal,
        );
        
        expect(result.llmContent).toContain('Todos have been modified successfully');
      }
    });

    it('should accept all valid status values', async () => {
      const statuses: Array<'pending' | 'in_progress' | 'completed'> = ['pending', 'in_progress', 'completed'];
      
      for (const status of statuses) {
        const validTodos = [
          {
            id: '1',
            content: `Task with ${status} status`,
            priority: 'medium' as const,
            status,
          }
        ];

        const result = await todoTool.execute(
          { todos: validTodos },
          new AbortController().signal,
        );
        
        expect(result.llmContent).toContain('Todos have been modified successfully');
      }
    });
  });
});