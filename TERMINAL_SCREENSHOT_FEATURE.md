# Terminal Screenshot Feature for Web Interface

## Overview
This feature allows users to interact with CLI interactive screens (auth, language, theme, editor, privacy, settings) through the web interface by capturing terminal output and forwarding keyboard input.

## How It Works

### 1. Terminal Output Capture
- **Generic Detection**: The system automatically detects when ANY interactive screen is shown (auth, language, theme, editor, settings, privacy, etc.)
- **Stdout Capture**: When a screen is active, `process.stdout.write` is intercepted to capture all terminal output including ANSI escape codes
- **ANSI to HTML**: The captured ANSI codes are converted to HTML using the `ansi-to-html` library
- **Real-time Updates**: Every change to the terminal is immediately captured and broadcast to web clients

### 2. Web Display
- **Terminal Modal**: Instead of showing a warning, the web interface displays a modal with the rendered terminal output
- **Faithful Rendering**: The HTML preserves colors, positioning, and formatting from the terminal
- **Monospace Font**: Uses appropriate monospace fonts to maintain terminal layout

### 3. Keyboard Input Forwarding
- **Key Capture**: The web interface captures all keyboard events when the terminal modal is visible
- **Key Mapping**: Browser keyboard events are mapped to terminal key sequences:
  - Arrow keys → ANSI escape sequences
  - Enter → `\r`
  - Escape → `\x1b`
  - Tab → `\t`
  - Ctrl+C → `\x03`
  - Character keys → Direct input
- **WebSocket Transport**: Key events are sent to the CLI via WebSocket
- **Stdin Emission**: The CLI emits synthetic keypress events that are picked up by Ink's input handlers

### 4. Architecture Components

#### CLI Side:
- **TerminalCaptureContext**: Manages stdout capture and ANSI conversion
- **TerminalCaptureWrapper**: Connects capture to web interface broadcasting
- **WebInterfaceService**: Handles WebSocket communication and broadcasts terminal data
- **App.tsx Integration**: Detects screen states and forwards keyboard input

#### Web Side:
- **TerminalDisplay Component**: Renders terminal output and captures keyboard
- **WebSocketManager**: Handles bidirectional communication
- **Modal UI**: Professional terminal-like display with keyboard hints

## Key Features

### Generic & Future-Proof
- **No Screen-Specific Code**: Works with ANY Ink/React component that renders to stdout
- **Automatic Detection**: Uses existing screen state variables to trigger capture
- **Zero Configuration**: New screens added to the CLI will automatically work

### Minimal Invasion
- **Context-Based**: Uses React Context pattern to avoid modifying core CLI code
- **Conditional Loading**: Only active when web interface is enabled
- **Clean Separation**: Web interface code is clearly marked with comments

### Robust Handling
- **Infinite Loop Prevention**: Careful event handling to avoid feedback loops
- **State Management**: Proper cleanup when screens close
- **Error Handling**: Graceful fallback if ansi-to-html is unavailable

## Supported Screens
All interactive screens are supported automatically:
- `/auth` - Authentication selection
- `/language` - Language selection
- `/theme` - Theme selection
- `/editor` - Editor settings
- `/privacy` - Privacy notice
- `/settings` - General settings
- Any future screens added to the CLI

## Technical Details

### Terminal Capture Flow
1. Screen opens → `isAnyInteractiveScreenOpen` becomes true
2. `TerminalCaptureContext` starts capturing stdout
3. ANSI codes are converted to HTML
4. HTML is broadcast via WebSocket
5. Web client displays in terminal modal

### Keyboard Input Flow
1. User presses key in web interface
2. Browser event is captured and mapped to terminal format
3. Key data sent via WebSocket
4. CLI receives and emits synthetic keypress event
5. Ink components handle the keypress normally

### WebSocket Messages
```javascript
// Terminal capture broadcast
{
  type: 'terminal_capture',
  data: {
    content: '<html>...',  // Rendered HTML
    timestamp: 123456789,
    isInteractive: true
  }
}

// Keyboard input from web
{
  type: 'terminal_input',
  key: {
    name: 'up',
    sequence: '\x1b[A',
    ctrl: false,
    shift: false,
    alt: false,
    meta: false
  }
}
```

## Maintenance Notes

### Adding New Screens
No action required! New screens will automatically work if they:
1. Render to stdout using Ink
2. Have a state variable tracked in App.tsx
3. Use standard `useKeypress` hooks for input

### Debugging
- Check browser console for WebSocket messages
- Verify terminal capture is active in TerminalCaptureContext
- Ensure ansi-to-html is properly installed
- Check keyboard event mapping in TerminalDisplay component

### Performance Considerations
- Terminal capture only active when screens are shown
- Efficient diffing to avoid unnecessary broadcasts
- Minimal overhead when web interface is not connected

## Future Enhancements
- Screen reader support for accessibility
- Mobile touch input mapping
- Copy/paste support in terminal modal
- Terminal resize handling