class ConfirmationQueue {
    constructor(client) {
        this.client = client;
        this.queue = this.loadQueue();
        this.isDialogVisible = false;

        // Process the queue on initialization
        this.showNext();
    }

    loadQueue() {
        try {
            const storedQueue = sessionStorage.getItem('confirmationQueue');
            const queue = storedQueue ? JSON.parse(storedQueue) : [];
            // Basic validation of queue items
            if (Array.isArray(queue) && queue.every(item => item && item.callId)) {
                return queue;
            }
        } catch (e) {
            console.error("Failed to load or parse confirmation queue:", e);
        }
        return [];
    }

    saveQueue() {
        try {
            sessionStorage.setItem('confirmationQueue', JSON.stringify(this.queue));
        } catch (e) {
            console.error("Failed to save confirmation queue:", e);
        }
    }

    add(confirmation) {
        // Avoid adding duplicates
        if (!this.queue.some(c => c.callId === confirmation.callId)) {
            this.queue.push(confirmation);
            this.saveQueue();
        }
        this.showNext();
    }

    remove(callId) {
        const wasVisible = this.isDialogVisible && this.queue[0]?.callId === callId;
        this.queue = this.queue.filter(c => c.callId !== callId);
        this.saveQueue();

        if (wasVisible) {
            this.hideConfirmationDialog();
            this.isDialogVisible = false;
            this.showNext();
        }
    }

    next() {
        if (this.queue.length > 0) {
            this.queue.shift(); // Remove the confirmation that was just handled
            this.saveQueue();
        }
        this.isDialogVisible = false;
        this.hideConfirmationDialog();
        this.showNext();
    }

    showNext() {
        if (this.isDialogVisible || this.queue.length === 0) {
            return;
        }

        this.isDialogVisible = true;
        const confirmation = this.queue[0];
        this.showConfirmationDialog(confirmation);
    }

    showConfirmationDialog(confirmationData) {
        this.hideConfirmationDialog(); // Ensure no other dialog is visible

        const dialog = document.createElement('div');
        dialog.className = 'confirmation-dialog';
        dialog.setAttribute('data-call-id', confirmationData.callId);

        const content = document.createElement('div');
        content.className = 'confirmation-content';

        const toolInfo = document.createElement('div');
        toolInfo.className = 'confirmation-tool-info';
        toolInfo.innerHTML = `
            <h3>Tool Confirmation Required</h3>
            <p><strong>Tool:</strong> ${confirmationData.toolName}</p>
        `;
        content.appendChild(toolInfo);

        const detailsContainer = this.createConfirmationDetails(confirmationData.confirmationDetails);
        content.appendChild(detailsContainer);

        const question = document.createElement('div');
        question.className = 'confirmation-question';
        question.textContent = this.getConfirmationQuestion(confirmationData.confirmationDetails);
        content.appendChild(question);

        const buttonsContainer = this.createConfirmationButtons(confirmationData);
        content.appendChild(buttonsContainer);

        dialog.appendChild(content);
        document.body.appendChild(dialog);

        const firstButton = dialog.querySelector('.confirmation-button');
        if (firstButton) {
            firstButton.focus();
        }
    }

    hideConfirmationDialog() {
        const existingDialog = document.querySelector('.confirmation-dialog');
        if (existingDialog) {
            existingDialog.remove();
        }
    }

    createConfirmationDetails(confirmationDetails) {
        const container = document.createElement('div');
        container.className = 'confirmation-details';

        switch (confirmationDetails.type) {
            case 'edit':
                container.innerHTML = `
                    <div class="confirmation-edit">
                        <p><strong>File:</strong> ${confirmationDetails.fileName}</p>
                        <div class="confirmation-diff">
                            <pre>${confirmationDetails.fileDiff || 'No diff available'}</pre>
                        </div>
                    </div>
                `;
                break;
            case 'exec':
                container.innerHTML = `
                    <div class="confirmation-exec">
                        <p><strong>Command:</strong></p>
                        <div class="confirmation-command">
                            <code>${confirmationDetails.command}</code>
                        </div>
                    </div>
                `;
                break;
            case 'info':
                const urlsHtml = confirmationDetails.urls && confirmationDetails.urls.length > 0
                    ? `<ul>${confirmationDetails.urls.map(url => `<li>${url}</li>`).join('')}</ul>`
                    : '';
                container.innerHTML = `
                    <div class="confirmation-info">
                        <p><strong>Description:</strong> ${confirmationDetails.prompt}</p>
                        ${urlsHtml ? `<p><strong>URLs to fetch:</strong></p>${urlsHtml}` : ''}
                    </div>
                `;
                break;
            default: // MCP
                container.innerHTML = `
                    <div class="confirmation-mcp">
                        <p><strong>MCP Server:</strong> ${confirmationDetails.serverName || 'Unknown'}</p>
                        <p><strong>Tool:</strong> ${confirmationDetails.toolName || 'Unknown'}</p>
                    </div>
                `;
                break;
        }
        return container;
    }

    getConfirmationQuestion(confirmationDetails) {
        switch (confirmationDetails.type) {
            case 'edit':
                return 'Apply this change?';
            case 'exec':
                return 'Allow execution?';
            case 'info':
                return 'Do you want to proceed?';
            default: // MCP
                return `Allow execution of MCP tool "${confirmationDetails.toolName}" from server "${confirmationDetails.serverName}"?`;
        }
    }

    createConfirmationButtons(confirmationData) {
        const container = document.createElement('div');
        container.className = 'confirmation-buttons';

        const buttons = this.getConfirmationButtons(confirmationData.confirmationDetails);

        buttons.forEach((buttonConfig, index) => {
            const button = document.createElement('button');
            button.className = `confirmation-button ${buttonConfig.type}`;
            button.textContent = buttonConfig.label;
            button.onclick = () => this.client.handleConfirmationResponse(confirmationData.callId, buttonConfig.outcome);

            button.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    const nextButton = container.children[(index + 1) % buttons.length];
                    nextButton.focus();
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prevButton = container.children[(index - 1 + buttons.length) % buttons.length];
                    prevButton.focus();
                } else if (e.key === 'Escape') {
                    this.client.handleConfirmationResponse(confirmationData.callId, 'cancel');
                }
            });

            container.appendChild(button);
        });

        return container;
    }

    getConfirmationButtons(confirmationDetails) {
        switch (confirmationDetails.type) {
            case 'edit':
                return [
                    { label: 'Yes, allow once', outcome: 'proceed_once', type: 'primary' },
                    { label: 'Yes, allow always', outcome: 'proceed_always', type: 'primary' },
                    { label: 'Modify with external editor', outcome: 'modify_with_editor', type: 'secondary' },
                    { label: 'No (esc)', outcome: 'cancel', type: 'cancel' }
                ];
            case 'exec':
                const rootCommand = confirmationDetails.rootCommand || 'command';
                return [
                    { label: 'Yes, allow once', outcome: 'proceed_once', type: 'primary' },
                    { label: `Yes, allow always "${rootCommand} ..."`, outcome: 'proceed_always', type: 'primary' },
                    { label: 'No (esc)', outcome: 'cancel', type: 'cancel' }
                ];
            case 'info':
                return [
                    { label: 'Yes, allow once', outcome: 'proceed_once', type: 'primary' },
                    { label: 'Yes, allow always', outcome: 'proceed_always', type: 'primary' },
                    { label: 'No (esc)', outcome: 'cancel', type: 'cancel' }
                ];
            default: // MCP
                const toolName = confirmationDetails.toolName || 'tool';
                const serverName = confirmationDetails.serverName || 'server';
                return [
                    { label: 'Yes, allow once', outcome: 'proceed_once', type: 'primary' },
                    { label: `Yes, always allow tool "${toolName}" from server "${serverName}"`, outcome: 'proceed_always_tool', type: 'primary' },
                    { label: `Yes, always allow all tools from server "${serverName}"`, outcome: 'proceed_always_server', type: 'primary' },
                    { label: 'No (esc)', outcome: 'cancel', type: 'cancel' }
                ];
        }
    }
}