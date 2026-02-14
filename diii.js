/**
 * web-diii REPL-only app
 * Minimal serial REPL + script browser iii devices.
 */

class iiiConnection {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readableStreamClosed = null;
        this.writableStreamClosed = null;
        this.isConnected = false;
        this.lineBuffer = '';
        this.onDataReceived = null;
        this.onConnectionChange = null;
        this._textEncoder = new TextEncoder();
    }

    async connect() {
        try {
            this.port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: 0xCAFE, usbProductId: 0x1101 }]
            });

            await this.port.open({
                baudRate: 115200,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });

            this.isConnected = true;

            const textDecoder = new TextDecoderStream();
            this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            const textEncoder = new TextEncoderStream();
            this.writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            this.startReading();

            if (this.onConnectionChange) {
                this.onConnectionChange(true);
            }

            return true;
        } catch (error) {
            console.error('Connection error:', error);
            if (this.onConnectionChange) {
                this.onConnectionChange(false, error.message || 'connection failed');
            }
            return false;
        }
    }

    async startReading() {
        try {
            while (this.isConnected) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (!value) continue;

                this.lineBuffer += value;

                let newlineIndex = -1;
                while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
                    const line = this.lineBuffer.substring(0, newlineIndex);
                    this.lineBuffer = this.lineBuffer.substring(newlineIndex + 1);
                    if (line && this.onDataReceived) {
                        this.onDataReceived(line);
                    }
                }
            }
        } catch (error) {
            console.error('Read error:', error);
            if (!this.isConnected) return;

            this.isConnected = false;
            if (this.reader) {
                await this.reader.cancel().catch(() => {});
            }
            if (this.writer) {
                await this.writer.close().catch(() => {});
            }

            this.reader = null;
            this.writer = null;
            this.lineBuffer = '';

            if (this.port) {
                await this.port.close().catch(() => {});
                this.port = null;
            }

            if (this.onConnectionChange) {
                this.onConnectionChange(false, 'device disconnected. please reconnect >');
            }
        }
    }

    async write(data) {
        if (!this.isConnected || !this.writer) {
            throw new Error('Not connected');
        }

        let payload = String(data);
        const byteLength = this._textEncoder.encode(payload).length;
        if (byteLength % 64 === 0) {
            payload += '\n';
        }

        await this.writer.write(payload);
    }

    async writeLine(line) {
        await this.write(`${line}\n`);
    }

    async disconnect() {
        this.isConnected = false;

        if (this.reader) {
            await this.reader.cancel().catch(() => {});
            await this.readableStreamClosed?.catch(() => {});
        }
        if (this.writer) {
            await this.writer.close().catch(() => {});
            await this.writableStreamClosed?.catch(() => {});
        }
        if (this.port) {
            await this.port.close().catch(() => {});
        }

        this.port = null;
        this.reader = null;
        this.writer = null;
        this.lineBuffer = '';

        if (this.onConnectionChange) {
            this.onConnectionChange(false);
        }
    }
}

class DruidApp {
    constructor() {
        this.iiiDevice = new iiiConnection();

        this.commandHistory = [];
        this.historyIndex = -1;
        this.currentInput = '';

        this.cacheElements();
        this.bindEvents();
        this.checkBrowserSupport();

        this.outputLine('//// welcome. connect to an iii compatible grid or arc to begin.');
    }

    cacheElements() {
        this.elements = {
            scriptReferenceBtn: document.getElementById('scriptReferenceBtn'),

            connectionBtn: document.getElementById('replConnectionBtn'),
            replStatusIndicator: document.getElementById('replStatusIndicator'),
            replStatusText: document.getElementById('replStatusText'),

            output: document.getElementById('output'),
            replInput: document.getElementById('replInput'),
            replPane: document.getElementById('replPane'),
            uploadBtn: document.getElementById('uploadBtn'),
            restartBtn: document.getElementById('restartBtn'),
            helpBtn: document.getElementById('helpBtn'),
            clearBtn: document.getElementById('clearBtn'),

            fileInput: document.getElementById('fileInput'),

            browserWarning: document.getElementById('browserWarning'),
            closeWarning: document.getElementById('closeWarning')
        };
    }

    bindEvents() {
        const on = (element, eventName, handler) => {
            if (element) element.addEventListener(eventName, handler);
        };

        on(this.elements.connectionBtn, 'click', () => this.toggleConnection());
        on(this.elements.replInput, 'keydown', (e) => this.handleReplInput(e));
        on(this.elements.uploadBtn, 'click', () => this.openUploadPicker());
        on(this.elements.restartBtn, 'click', () => this.restartDevice());
        on(this.elements.helpBtn, 'click', () => this.showHelp());
        on(this.elements.clearBtn, 'click', () => this.clearOutput());
        on(this.elements.fileInput, 'change', (e) => this.handleFileSelect(e));

        on(this.elements.closeWarning, 'click', () => {
            this.elements.browserWarning.style.display = 'none';
        });

        on(this.elements.scriptReferenceBtn, 'click', () => {
            window.open('https://monome.org/docs/iii/', '_blank');
        });

        this.iiiDevice.onDataReceived = (data) => this.handleiiiOutput(data);
        this.iiiDevice.onConnectionChange = (connected, error) => this.handleConnectionChange(connected, error);

        this.setupDragAndDrop();
    }

    checkBrowserSupport() {
        if ('serial' in navigator) return;
        if (this.elements.browserWarning) this.elements.browserWarning.style.display = 'flex';
        if (this.elements.connectionBtn) this.elements.connectionBtn.disabled = true;
        this.outputLine('ERROR: Web Serial API not supported in this browser.');
        this.outputLine('Please use Chrome, Edge, or Opera.');
    }

    outputText(text) {
        if (!this.elements.output) return;
        this.elements.output.appendChild(document.createTextNode(text));
        this.elements.output.scrollTop = this.elements.output.scrollHeight;
    }

    outputLine(text) {
        this.outputText(`${text}\n`);
    }

    outputHTML(html) {
        if (!this.elements.output) return;
        const span = document.createElement('span');
        span.innerHTML = html;
        this.elements.output.appendChild(span);
        this.elements.output.scrollTop = this.elements.output.scrollHeight;
    }

    clearOutput() {
        if (this.elements.output) this.elements.output.textContent = '';
    }

    handleReplInput(event) {
        const input = this.elements.replInput;
        if (!input) return;

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const code = input.value.trim();
            if (!code) return;
            this.sendReplCommand(code);
            return;
        }

        const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
        const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        const noModifiers = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;

        if (noModifiers && event.key === 'ArrowUp' && atStart) {
            event.preventDefault();
            this.navigateReplHistory('up');
            return;
        }

        if (noModifiers && event.key === 'ArrowDown' && atEnd) {
            event.preventDefault();
            this.navigateReplHistory('down');
            return;
        }

        if (this.historyIndex !== -1 && event.key.length === 1) {
            this.historyIndex = -1;
            this.currentInput = '';
        }
    }

    navigateReplHistory(direction) {
        const input = this.elements.replInput;
        if (!input || this.commandHistory.length === 0) return;

        if (direction === 'up') {
            if (this.historyIndex === -1) {
                this.currentInput = input.value;
            }
            if (this.historyIndex < this.commandHistory.length - 1) {
                this.historyIndex += 1;
                input.value = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
                input.selectionStart = input.selectionEnd = input.value.length;
            }
            return;
        }

        if (this.historyIndex === -1) return;
        this.historyIndex -= 1;
        input.value = this.historyIndex === -1
            ? this.currentInput
            : this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
        input.selectionStart = input.selectionEnd = input.value.length;
    }

    async sendReplCommand(code) {
        this.outputLine(`>> ${code}`);

        if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== code) {
            this.commandHistory.push(code);
        }

        if (!this.iiiDevice.isConnected) {
            this.outputLine('no iii device connected.');
            this.elements.replInput.value = '';
            this.historyIndex = -1;
            this.currentInput = '';
            return;
        }

        try {
            const fileSelectMatch = code.match(/^\^\^s\s+(.+)$/);
            if (fileSelectMatch) {
                await this.openAndSelectRemoteFile(fileSelectMatch[1].trim());
                this.elements.replInput.value = '';
                this.historyIndex = -1;
                this.currentInput = '';
                return;
            }

            for (const line of code.split('\n')) {
                await this.iiiDevice.writeLine(line);
                await this.delay(1);
            }
            this.elements.replInput.value = '';
            this.historyIndex = -1;
            this.currentInput = '';
        } catch (error) {
            this.outputLine(`Error: ${error.message}`);
        }
    }

    async toggleConnection() {
        if (this.iiiDevice.isConnected) {
            await this.disconnect();
            return;
        }
        await this.connect();
    }

    async connect() {
        this.outputLine('Connecting to iii device...');
        const connected = await this.iiiDevice.connect();
        if (connected) {
            this.outputLine('Connected! Ready to code.');
            this.outputLine('Drag and drop a lua file here to auto-upload.');
            this.outputLine('');
        }
    }

    async disconnect() {
        await this.iiiDevice.disconnect();
        this.outputLine('');
        this.outputLine('Disconnected from iii device.');
        this.outputLine('');
    }

    handleConnectionChange(connected, error) {
        if (!this.elements.connectionBtn || !this.elements.replStatusIndicator || !this.elements.replStatusText) return;

        if (connected) {
            this.elements.connectionBtn.textContent = 'disconnect';
            this.elements.replStatusIndicator.classList.add('connected');
            this.elements.replStatusText.textContent = 'connected';
            this.elements.replInput?.focus();
            return;
        }

        this.elements.connectionBtn.textContent = 'connect';
        this.elements.replStatusIndicator.classList.remove('connected');
        this.elements.replStatusText.textContent = error || 'not connected';

        if (error && error.includes('disconnected')) {
            this.outputLine('');
            this.outputLine(error);
        }
    }

    handleiiiOutput(data) {
        const cleaned = String(data).replace(/\r/g, '');
        if (!cleaned) return;

        if (!cleaned.includes('^^')) {
            this.outputLine(cleaned);
            return;
        }

        const parts = cleaned.split('^^');
        for (const part of parts) {
            if (!part.trim()) continue;
            const eventMatch = part.match(/^(\w+)\(([^)]*)\)/);

            if (!eventMatch) {
                this.outputLine(part.trim());
                continue;
            }

            const event = eventMatch[1];
            const args = eventMatch[2]
                ? eventMatch[2].split(',').map((item) => item.trim())
                : [];

            this.handleiiiEvent(event, args);
        }
    }

    handleiiiEvent(event, args) {
        this.outputLine(`^^${event}(${args.join(', ')})`);
    }

    getUploadLines(text) {
        return String(text)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .map((line) => line.replace(/\s+$/g, ''));
    }

    async openAndSelectRemoteFile(fileName) {
        const normalizedName = String(fileName || '').trim();
        if (!normalizedName) {
            throw new Error('Missing file name for ^^s');
        }

        await this.iiiDevice.writeLine('^^s');
        await this.delay(100);
        await this.iiiDevice.writeLine(normalizedName);
        await this.delay(100);
        await this.iiiDevice.writeLine('^^f');
        await this.delay(100);
    }

    async sendScriptTextToiii(fileName, text) {
        const baseName = fileName;
        const lines = this.getUploadLines(text);

        // Match diii upload protocol:
        // ^^s, <filename>, ^^f, ^^s, <file lines>, ^^w
        await this.openAndSelectRemoteFile(baseName);
        await this.iiiDevice.writeLine('^^s');
        await this.delay(100);

        for (const line of lines) {
            await this.iiiDevice.writeLine(line);
            await this.delay(1);
        }

        await this.delay(100);
        await this.iiiDevice.writeLine('^^w');
        await this.delay(100);
    }

    async uploadTextAsScript(name, text) {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device (click connect in the header)');
            return;
        }

        try {
            this.outputLine(`Uploading ${name}...`);
            await this.sendScriptTextToiii(name, text);
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}`);
        }
    }

    openUploadPicker() {
        if (!this.elements.fileInput) return;
        this.elements.fileInput.value = '';
        this.elements.fileInput.click();
    }

    async handleFileSelect(event) {
        const file = event.target?.files?.[0];
        if (!file) return;

        if (!file.name.toLowerCase().endsWith('.lua')) {
            this.outputLine('Error: Only .lua files are supported');
            return;
        }

        try {
            const text = await file.text();
            await this.uploadTextAsScript(file.name, text);
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}`);
        }
    }

    setupDragAndDrop() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
            document.body.addEventListener(eventName, (event) => {
                event.preventDefault();
                event.stopPropagation();
            }, false);
        });

        if (!this.elements.replPane) return;

        this.elements.replPane.addEventListener('drop', async (event) => {
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return;

            const file = files[0];
            if (!file.name.endsWith('.lua')) {
                this.outputLine('Error: Only .lua files are supported');
                return;
            }

            const text = await file.text();
            await this.uploadTextAsScript(file.name, text);
        });

        this.elements.replPane.addEventListener('dragover', () => {
            this.elements.replPane.style.opacity = '0.7';
        });

        this.elements.replPane.addEventListener('dragleave', () => {
            this.elements.replPane.style.opacity = '1';
        });

        this.elements.replPane.addEventListener('drop', () => {
            this.elements.replPane.style.opacity = '1';
        });
    }

    restartDevice() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }
        this.outputLine('> ^^r');
        this.iiiDevice.writeLine('^^r');
    }

    showHelp() {
        this.outputLine('');
        this.outputLine(' iii commands:');
        this.outputLine(' ^^s <name>  select file (sends ^^s, name, ^^f)');
        this.outputLine(' ^^p         print script');
        this.outputLine(' ^^c         clear script');
        this.outputLine(' ^^z         reboot script');
        this.outputLine(' ^^r         reboot device');
        this.outputLine(' ^^b         reboot into bootloader mode');
        this.outputLine('');
        this.outputHTML('TODO: iii script reference link GOES HERE');
       
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DruidApp();
});
