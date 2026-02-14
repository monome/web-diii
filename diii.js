/**
 * web-druid REPL-only app
 * Minimal serial REPL + script browser for crow/blackbird.
 */

class CrowConnection {
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
                filters: [{ usbVendorId: 0x0483, usbProductId: 0x5740 }]
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
        await this.write(`${line}\r\n`);
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
        this.crow = new CrowConnection();

        this.commandHistory = [];
        this.historyIndex = -1;
        this.currentInput = '';

        this.streamData = { 1: [], 2: [] };
        this.streamContexts = { 1: null, 2: null };

        this.cacheElements();
        this.bindEvents();
        this.checkBrowserSupport();
        this.startStreamAnimation();

        this.outputLine('//// welcome. connect to crow or blackbird to begin.');
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
            resetBtn: document.getElementById('resetBtn'),
            helpBtn: document.getElementById('helpBtn'),
            clearBtn: document.getElementById('clearBtn'),

            streamMonitor1: document.getElementById('streamMonitor1'),
            streamMonitor2: document.getElementById('streamMonitor2'),
            streamCanvas1: document.getElementById('streamCanvas1'),
            streamCanvas2: document.getElementById('streamCanvas2'),
            streamValue1: document.getElementById('streamValue1'),
            streamValue2: document.getElementById('streamValue2'),

            fileInput: document.getElementById('fileInput'),

            browserWarning: document.getElementById('browserWarning'),
            closeWarning: document.getElementById('closeWarning')
        };

        this.streamContexts[1] = this.elements.streamCanvas1?.getContext('2d') || null;
        this.streamContexts[2] = this.elements.streamCanvas2?.getContext('2d') || null;
    }

    bindEvents() {
        const on = (element, eventName, handler) => {
            if (element) element.addEventListener(eventName, handler);
        };

        on(this.elements.connectionBtn, 'click', () => this.toggleConnection());
        on(this.elements.replInput, 'keydown', (e) => this.handleReplInput(e));
        on(this.elements.resetBtn, 'click', () => this.resetCrow());
        on(this.elements.helpBtn, 'click', () => this.showHelp());
        on(this.elements.clearBtn, 'click', () => this.clearOutput());

        on(this.elements.closeWarning, 'click', () => {
            this.elements.browserWarning.style.display = 'none';
        });

        on(this.elements.scriptReferenceBtn, 'click', () => {
            window.open('https://monome.org/docs/crow/reference', '_blank');
        });

        this.crow.onDataReceived = (data) => this.handleCrowOutput(data);
        this.crow.onConnectionChange = (connected, error) => this.handleConnectionChange(connected, error);

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
        this.hideStreamMonitors();
    }

    hideStreamMonitors() {
        this.elements.streamMonitor1?.classList.remove('active');
        this.elements.streamMonitor2?.classList.remove('active');
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

        if (!this.crow.isConnected) {
            this.outputLine('crow is not connected');
            this.elements.replInput.value = '';
            this.historyIndex = -1;
            this.currentInput = '';
            return;
        }

        try {
            for (const line of code.split('\n')) {
                await this.crow.writeLine(line);
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
        if (this.crow.isConnected) {
            await this.disconnect();
            return;
        }
        await this.connect();
    }

    async connect() {
        this.outputLine('Connecting to crow...');
        const connected = await this.crow.connect();
        if (connected) {
            this.outputLine('Connected! Ready to code.');
            this.outputLine('Drag and drop a lua file here to auto-upload.');
            this.outputLine('');
        }
    }

    async disconnect() {
        await this.crow.disconnect();
        this.outputLine('');
        this.outputLine('Disconnected from crow.');
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

    handleCrowOutput(data) {
        const cleaned = String(data).replace(/\r/g, '');
        if (!cleaned) return;

        if (cleaned.includes('pubview(')) {
            return;
        }

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

            this.handleCrowEvent(event, args);
        }
    }

    handleCrowEvent(event, args) {
        if (event === 'pubview' || event === 'pupdate') {
            return;
        }

        if ((event === 'stream' || event === 'change') && args.length >= 2) {
            const channel = Number.parseInt(args[0], 10);
            const value = Number.parseFloat(args[1]);
            if ((channel === 1 || channel === 2) && Number.isFinite(value)) {
                this.updateStreamMonitor(channel, value);
            }
            return;
        }

        this.outputLine(`^^${event}(${args.join(', ')})`);
    }

    updateStreamMonitor(channel, value) {
        const monitor = this.elements[`streamMonitor${channel}`];
        if (monitor && !monitor.classList.contains('active')) {
            monitor.classList.add('active');
        }

        const now = Date.now();
        this.streamData[channel].push({ time: now, value });

        const cutoff = now - 5000;
        while (this.streamData[channel].length && this.streamData[channel][0].time < cutoff) {
            this.streamData[channel].shift();
        }

        const valueElement = this.elements[`streamValue${channel}`];
        if (valueElement) {
            valueElement.textContent = `${value.toFixed(4)}V`;
        }
    }

    startStreamAnimation() {
        const animate = () => {
            if (this.elements.streamMonitor1?.classList.contains('active') && this.streamData[1].length > 0) {
                this.drawStreamGraph(1);
            }
            if (this.elements.streamMonitor2?.classList.contains('active') && this.streamData[2].length > 0) {
                this.drawStreamGraph(2);
            }
            requestAnimationFrame(animate);
        };

        requestAnimationFrame(animate);
    }

    drawStreamGraph(channel) {
        const canvas = this.elements[`streamCanvas${channel}`];
        const ctx = this.streamContexts[channel];
        const data = this.streamData[channel];
        if (!canvas || !ctx || data.length === 0) return;

        const width = canvas.width;
        const height = canvas.height;
        const padding = 4;
        const graphWidth = width - (padding * 2);
        const graphHeight = height - (padding * 2);

        const styles = getComputedStyle(document.documentElement);
        const bg = styles.getPropertyValue('--bg-subdued').trim();
        const neutral = styles.getPropertyValue('--neutral-medium').trim();
        const lineColor = styles.getPropertyValue('--interactive-selected').trim();

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        let minV = -5;
        let maxV = 5;
        for (const point of data) {
            if (point.value < minV) minV = Math.floor(point.value);
            if (point.value > maxV) maxV = Math.ceil(point.value);
        }

        const range = Math.max(0.0001, maxV - minV);

        const zeroY = padding + graphHeight - ((0 - minV) / range * graphHeight);
        ctx.strokeStyle = neutral;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padding, zeroY);
        ctx.lineTo(width - padding, zeroY);
        ctx.stroke();

        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.beginPath();

        const now = Date.now();
        const timeWindow = 5000;

        data.forEach((point, index) => {
            const timeFromNow = now - point.time;
            const x = padding + graphWidth - (timeFromNow / timeWindow * graphWidth);
            const y = padding + graphHeight - ((point.value - minV) / range * graphHeight);
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });

        ctx.stroke();
    }

    getUploadLines(text) {
        return String(text)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .map((line) => line.replace(/\s+$/g, ''));
    }

    async sendScriptTextToCrow(text, endMarker = '^^w') {
        const lines = this.getUploadLines(text);
        await this.crow.write('^^s');
        await this.delay(200);

        for (const line of lines) {
            await this.crow.writeLine(line);
            await this.delay(1);
        }

        await this.delay(100);
        await this.crow.write(endMarker);
    }

    async uploadTextAsScript(name, text) {
        if (!this.crow.isConnected) {
            this.outputLine('Error: Not connected to usb device (click connect in the header)');
            return;
        }

        try {
            this.outputLine(`Uploading ${name}...`);
            await this.sendScriptTextToCrow(text, '^^w');
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

    resetCrow() {
        if (!this.crow.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }
        this.outputLine('> crow.reset()');
        this.crow.writeLine('crow.reset()');
        this.hideStreamMonitors();
    }

    showHelp() {
        this.outputLine('');
        this.outputLine(' crow commands:');
        this.outputLine(' ^^i          print identity');
        this.outputLine(' ^^v          print version');
        this.outputLine(' ^^p          print current userscript');
        this.outputLine(' ^^r          restart crow');
        this.outputLine(' ^^k          kill running script');
        this.outputLine(' ^^c          clear userscript from flash');
        this.outputLine(' ^^b          enter bootloader mode');
        this.outputLine('');
        this.outputHTML(' crow script reference: <a href="https://monome.org/docs/crow/reference" target="_blank">https://monome.org/docs/crow/reference</a>\n');
        this.outputLine('');
        this.outputHTML(' blackbird addendum: <a href="https://github.com/TomWhitwell/Workshop_Computer/tree/main/releases/41_blackbird/README.md" target="_blank">https://github.com/TomWhitwell/Workshop_Computer/tree/main/releases/41_blackbird/README.md</a>\n');
        this.outputLine('');
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DruidApp();
});
