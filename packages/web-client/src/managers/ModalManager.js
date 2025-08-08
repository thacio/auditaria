/**
 * Modal management for commands, MCP servers, and debug logs
 */

import { escapeHtml, getMCPServerStatusInfo, getDebugLogIconAndColor } from '../utils/formatters.js';

export class ModalManager {
    constructor() {
        this.initializeElements();
        this.initializeData();
        this.setupEventHandlers();
    }
    
    initializeElements() {
        // Slash Commands Modal elements
        this.slashCommandsButton = document.getElementById('slash-commands-button');
        this.slashCommandsModal = document.getElementById('slash-commands-modal');
        this.slashCommandsBackdrop = document.getElementById('slash-commands-backdrop');
        this.slashCommandsClose = document.getElementById('slash-commands-close');
        this.commandsSearch = document.getElementById('commands-search');
        this.commandsList = document.getElementById('commands-list');
        
        // MCP Servers Modal elements
        this.mcpServersButton = document.getElementById('mcp-servers-button');
        this.mcpServersModal = document.getElementById('mcp-servers-modal');
        this.mcpServersBackdrop = document.getElementById('mcp-servers-backdrop');
        this.mcpServersClose = document.getElementById('mcp-servers-close');
        this.mcpSearch = document.getElementById('mcp-search');
        this.mcpServersList = document.getElementById('mcp-servers-list');
        
        // Debug Logs Modal elements
        this.debugLogsButton = document.getElementById('debug-logs-button');
        this.debugLogsModal = document.getElementById('debug-logs-modal');
        this.debugLogsBackdrop = document.getElementById('debug-logs-backdrop');
        this.debugLogsClose = document.getElementById('debug-logs-close');
        this.debugSearch = document.getElementById('debug-search');
        this.debugLogsList = document.getElementById('debug-logs-list');
    }
    
    initializeData() {
        // Initialize data stores
        this.slashCommands = [];
        this.filteredCommands = [];
        
        this.mcpServers = [];
        this.blockedMcpServers = [];
        this.filteredMcpServers = [];
        
        this.debugLogs = [];
        this.filteredDebugLogs = [];
    }
    
    setupEventHandlers() {
        // Slash commands modal handlers
        this.setupModal(
            this.slashCommandsButton,
            this.slashCommandsModal,
            this.slashCommandsBackdrop,
            this.slashCommandsClose,
            this.commandsSearch,
            () => this.showSlashCommandsModal(),
            () => this.hideSlashCommandsModal(),
            (term) => this.filterCommands(term)
        );
        
        // MCP servers modal handlers
        this.setupModal(
            this.mcpServersButton,
            this.mcpServersModal,
            this.mcpServersBackdrop,
            this.mcpServersClose,
            this.mcpSearch,
            () => this.showMCPServersModal(),
            () => this.hideMCPServersModal(),
            (term) => this.filterMCPServers(term)
        );
        
        // Debug logs modal handlers
        this.setupModal(
            this.debugLogsButton,
            this.debugLogsModal,
            this.debugLogsBackdrop,
            this.debugLogsClose,
            this.debugSearch,
            () => this.showDebugLogsModal(),
            () => this.hideDebugLogsModal(),
            (term) => this.filterDebugLogs(term)
        );
    }
    
    setupModal(button, modal, backdrop, closeBtn, searchInput, showFn, hideFn, filterFn) {
        button?.addEventListener('click', showFn);
        closeBtn?.addEventListener('click', hideFn);
        backdrop?.addEventListener('click', hideFn);
        searchInput?.addEventListener('input', (e) => filterFn(e.target.value));
        
        // ESC key handler
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && modal?.style.display !== 'none') {
                hideFn();
            }
        });
    }
    
    // Slash Commands Modal Methods
    showSlashCommandsModal() {
        this.slashCommandsModal.style.display = 'block';
        setTimeout(() => {
            this.slashCommandsModal.classList.add('show');
        }, 10);
        
        this.commandsSearch.focus();
        
        if (this.slashCommands.length === 0) {
            this.commandsList.innerHTML = '<div class="commands-loading">Loading commands...</div>';
        }
    }
    
    hideSlashCommandsModal() {
        this.slashCommandsModal.classList.remove('show');
        setTimeout(() => {
            this.slashCommandsModal.style.display = 'none';
        }, 300);
        
        this.commandsSearch.value = '';
        this.filteredCommands = [...this.slashCommands];
    }
    
    handleSlashCommands(commandsData) {
        this.slashCommands = commandsData.commands || [];
        this.filteredCommands = [...this.slashCommands];
        this.renderCommands();
        this.slashCommandsButton.disabled = false;
    }
    
    filterCommands(searchTerm) {
        const term = searchTerm.toLowerCase();
        this.filteredCommands = this.slashCommands.filter(command => {
            return command.name.toLowerCase().includes(term) ||
                   (command.description && command.description.toLowerCase().includes(term)) ||
                   (command.altNames && command.altNames.some(alias => alias.toLowerCase().includes(term)));
        });
        this.renderCommands();
    }
    
    renderCommands() {
        if (this.filteredCommands.length === 0) {
            this.commandsList.innerHTML = '<div class="commands-loading">No commands found</div>';
            return;
        }
        
        const html = this.filteredCommands.map(command => this.renderCommand(command)).join('');
        this.commandsList.innerHTML = html;
    }
    
    renderCommand(command) {
        let html = `
            <div class="command-item">
                <div class="command-name">/${command.name}</div>
                <div class="command-description">${escapeHtml(command.description || 'No description available')}</div>
        `;
        
        if (command.altNames && command.altNames.length > 0) {
            html += `<div class="command-aliases">Aliases: ${command.altNames.map(alias => `/${alias}`).join(', ')}</div>`;
        }
        
        if (command.subCommands && command.subCommands.length > 0) {
            html += '<div class="command-subcommands">';
            command.subCommands.forEach(subcommand => {
                html += `
                    <div class="subcommand-item">
                        <div class="subcommand-name">/${command.name} ${subcommand.name}</div>
                        <div class="subcommand-description">${escapeHtml(subcommand.description || 'No description available')}</div>
                    </div>
                `;
            });
            html += '</div>';
        }
        
        html += '</div>';
        return html;
    }
    
    // MCP Servers Modal Methods
    showMCPServersModal() {
        this.mcpServersModal.style.display = 'block';
        setTimeout(() => {
            this.mcpServersModal.classList.add('show');
        }, 10);
        
        this.mcpSearch.focus();
        
        if (this.mcpServers.length === 0 && this.blockedMcpServers.length === 0) {
            this.mcpServersList.innerHTML = '<div class="mcp-loading">Loading MCP servers...</div>';
        }
    }
    
    hideMCPServersModal() {
        this.mcpServersModal.classList.remove('show');
        setTimeout(() => {
            this.mcpServersModal.style.display = 'none';
        }, 300);
    }
    
    handleMCPServers(data) {
        this.mcpServers = data.servers || [];
        this.blockedMcpServers = data.blockedServers || [];
        this.filteredMcpServers = [...this.mcpServers];
        this.renderMCPServers();
        this.mcpServersButton.disabled = false;
    }
    
    filterMCPServers(searchTerm) {
        const term = searchTerm.toLowerCase();
        this.filteredMcpServers = this.mcpServers.filter(server => {
            const matchesServer = server.name.toLowerCase().includes(term) ||
                                (server.description && server.description.toLowerCase().includes(term));
            
            const matchesTools = server.tools && server.tools.some(tool => 
                tool.name.toLowerCase().includes(term) ||
                (tool.description && tool.description.toLowerCase().includes(term))
            );
            
            return matchesServer || matchesTools;
        });
        this.renderMCPServers();
    }
    
    renderMCPServers() {
        if (this.filteredMcpServers.length === 0 && this.blockedMcpServers.length === 0) {
            this.mcpServersList.innerHTML = `
                <div class="mcp-no-servers">
                    <div class="mcp-no-servers-title">No MCP Servers Available</div>
                    <div class="mcp-no-servers-description">
                        No MCP servers are currently configured. 
                        Configure MCP servers to extend Auditaria with additional tools and capabilities.
                    </div>
                </div>
            `;
            return;
        }
        
        let html = '';
        
        this.filteredMcpServers.forEach(server => {
            html += this.renderMCPServer(server);
        });
        
        this.blockedMcpServers.forEach(server => {
            html += this.renderBlockedMCPServer(server);
        });
        
        this.mcpServersList.innerHTML = html;
    }
    
    renderMCPServer(server) {
        const statusInfo = getMCPServerStatusInfo(server.status);
        const displayName = server.extensionName ? 
            `${server.name} (from ${server.extensionName})` : 
            server.name;
        
        let html = `
            <div class="mcp-server-item">
                <div class="mcp-server-header">
                    <span class="mcp-server-status ${statusInfo.className}">${statusInfo.icon}</span>
                    <div class="mcp-server-name">${escapeHtml(displayName)}</div>
                    <div class="mcp-server-status-text">${statusInfo.text}</div>
                </div>
        `;
        
        if (server.description) {
            html += `<div class="mcp-server-description">${escapeHtml(server.description)}</div>`;
        }
        
        if (server.tools && server.tools.length > 0) {
            html += `
                <div class="mcp-tools-section">
                    <div class="mcp-tools-header">Tools (${server.tools.length})</div>
            `;
            
            server.tools.forEach(tool => {
                html += `
                    <div class="mcp-tool-item">
                        <div class="mcp-tool-name">${escapeHtml(tool.name)}</div>
                `;
                if (tool.description) {
                    html += `<div class="mcp-tool-description">${escapeHtml(tool.description)}</div>`;
                }
                html += `</div>`;
            });
            
            html += `</div>`;
        } else {
            const noToolsMessage = server.status === 'connecting' ? 
                'Tools will appear when ready' : 
                'No tools available';
            html += `<div class="mcp-tools-section"><div class="mcp-tools-header">${noToolsMessage}</div></div>`;
        }
        
        html += `</div>`;
        return html;
    }
    
    renderBlockedMCPServer(server) {
        const displayName = server.extensionName ? 
            `${server.name} (from ${server.extensionName})` : 
            server.name;
            
        return `
            <div class="mcp-server-item">
                <div class="mcp-server-header">
                    <span class="mcp-server-status blocked">🔴</span>
                    <div class="mcp-server-name">${escapeHtml(displayName)}</div>
                    <div class="mcp-server-status-text">Blocked</div>
                </div>
            </div>
        `;
    }
    
    // Debug Logs Modal Methods
    showDebugLogsModal() {
        this.debugLogsModal.style.display = 'block';
        setTimeout(() => {
            this.debugLogsModal.classList.add('show');
        }, 10);
        
        this.debugSearch.focus();
        
        if (this.debugLogs.length === 0) {
            this.debugLogsList.innerHTML = '<div class="debug-loading">Loading debug logs...</div>';
        }
    }
    
    hideDebugLogsModal() {
        this.debugLogsModal.classList.remove('show');
        setTimeout(() => {
            this.debugLogsModal.style.display = 'none';
        }, 300);
    }
    
    handleConsoleMessages(messages) {
        this.debugLogs = messages || [];
        this.filteredDebugLogs = [...this.debugLogs];
        this.renderDebugLogs();
        this.debugLogsButton.disabled = false;
    }
    
    filterDebugLogs(searchTerm) {
        const term = searchTerm.toLowerCase();
        this.filteredDebugLogs = this.debugLogs.filter(log => {
            return log.content.toLowerCase().includes(term) ||
                   log.type.toLowerCase().includes(term);
        });
        this.renderDebugLogs();
    }
    
    renderDebugLogs() {
        if (this.filteredDebugLogs.length === 0) {
            this.debugLogsList.innerHTML = `
                <div class="debug-no-logs">
                    <div class="debug-no-logs-title">No Debug Logs Available</div>
                    <div class="debug-no-logs-description">
                        No console messages have been captured yet. 
                        Debug logs will appear here when the CLI generates console output.
                    </div>
                </div>
            `;
            return;
        }
        
        let html = '';
        
        this.filteredDebugLogs.forEach(log => {
            html += this.renderDebugLogItem(log);
        });
        
        this.debugLogsList.innerHTML = html;
    }
    
    renderDebugLogItem(log) {
        const { icon, color } = getDebugLogIconAndColor(log.type);
        const countDisplay = log.count && log.count > 1 ? ` <span class="debug-log-count">(x${log.count})</span>` : '';
        
        return `
            <div class="debug-log-item">
                <div class="debug-log-header">
                    <span class="debug-log-icon" style="color: ${color};">${icon}</span>
                    <span class="debug-log-type">${log.type.toUpperCase()}</span>
                    ${countDisplay}
                </div>
                <div class="debug-log-content">${escapeHtml(log.content)}</div>
            </div>
        `;
    }
    
    // CLI Action Modal Methods
    handleCliActionRequired(data) {
        const modal = document.getElementById('cli-action-modal');
        const titleEl = document.getElementById('cli-action-title');
        const messageEl = document.getElementById('cli-action-message');
        
        if (data.active) {
            if (titleEl) titleEl.textContent = data.title || 'CLI Action Required';
            if (messageEl) messageEl.textContent = data.message || 'Please complete the action in the CLI terminal.';
            modal.style.display = 'flex';
        } else {
            modal.style.display = 'none';
        }
    }
}