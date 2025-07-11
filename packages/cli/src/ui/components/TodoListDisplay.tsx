/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';

interface TodoItem {
  content: string;
  id: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoListDisplayProps {
  todos: TodoItem[];
}

export const TodoListDisplay: React.FC<TodoListDisplayProps> = ({ todos }) => {
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return '☐';
      case 'in_progress':
        return '☐';
      case 'completed':
        return '☒';
      default:
        return '☐';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending':
        return Colors.Foreground;
      case 'in_progress':
        return Colors.AccentBlue;
      case 'completed':
        return Colors.AccentGreen;
      default:
        return Colors.Foreground;
    }
  };

  const isStrikethrough = (status: string) => status === 'completed';

  return (
    <Box flexDirection="column">
      <Text color={Colors.Foreground} bold>
        Update Todos
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {todos.map((todo, index) => (
          <Box key={todo.id} flexDirection="row" marginTop={index === 0 ? 0 : 0}>
            <Text color={getStatusColor(todo.status)}>
              {index === 0 ? '⎿ ' : '  '}
              {getStatusIcon(todo.status)}{' '}
            </Text>
            <Text 
              color={getStatusColor(todo.status)}
              strikethrough={isStrikethrough(todo.status)}
            >
              {todo.content}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};