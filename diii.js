/**
 * web-diii REPL-only app
 * Minimal serial REPL + script browser iii devices.
 */

class iiiConnection {
    constructor() {
        this.port = null;
        this.preferredPort = null;
        this.reader = null;
        this.writer = null;
        this.readableStreamClosed = null;
        this.writableStreamClosed = null;
        this.isConnected = false;
        this.lineBuffer = '';
        this.partialLineFlushTimer = null;
        this.partialLineFlushDelayMs = 40;
        this.onDataReceived = null;
        this.onConnectionChange = null;
        this._textEncoder = new TextEncoder();
    }

    async connect(port = null) {
        try {
            this.port = port || this.preferredPort;

            if (!this.port) {
                this.port = await navigator.serial.requestPort({
                    filters: [{ usbVendorId: 0xCAFE, usbProductId: 0x1101 }]
                });
            }

            this.preferredPort = this.port;

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
            const browserError = String(error?.message || error || 'unknown serial error');

            if (this.onConnectionChange) {
                this.onConnectionChange(false, 'connection failed', { browserError, reason: 'connect-failed' });
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

                if (this.lineBuffer) {
                    this.schedulePartialLineFlush();
                } else {
                    this.clearPartialLineFlush();
                }
            }

            this.flushPartialLineBuffer();
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
            this.flushPartialLineBuffer();

            if (this.port) {
                await this.port.close().catch(() => {});
                this.port = null;
            }

            if (this.onConnectionChange) {
                this.onConnectionChange(false, 'disconnected');
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
        this.clearPartialLineFlush();

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
        this.flushPartialLineBuffer();

        if (this.onConnectionChange) {
            this.onConnectionChange(false);
        }
    }

    schedulePartialLineFlush() {
        this.clearPartialLineFlush();

        this.partialLineFlushTimer = setTimeout(() => {
            this.flushPartialLineBuffer();
        }, this.partialLineFlushDelayMs);
    }

    clearPartialLineFlush() {
        if (!this.partialLineFlushTimer) return;
        clearTimeout(this.partialLineFlushTimer);
        this.partialLineFlushTimer = null;
    }

    flushPartialLineBuffer() {
        this.clearPartialLineFlush();

        if (!this.lineBuffer) return;

        const partial = this.lineBuffer;
        this.lineBuffer = '';
        if (partial && this.onDataReceived) {
            this.onDataReceived(partial);
        }
    }
}

class DruidApp {
    constructor() {
        this.iiiDevice = new iiiConnection();
        this.selectedPort = null;
        this.selectedPortInfo = null;
        this.hasConnectedThisSession = false;
        this.pendingConnectAttemptType = null;
        this.autoReconnectEnabled = false;
        this.autoReconnectTimer = null;
        this.reconnectDelayMs = 900;
        this.isManualDisconnect = false;

        this.commandHistory = [];
        this.historyIndex = -1;
        this.currentInput = '';
        this.pendingLuaCapture = null;
        this.pendingFilenameCapture = null;
        this.activeFileName = null;
        this.reconnectAfterRestartTimer = null;
        this.toastTimer = null;
        this.toastElement = null;
        this.fileEntries = [];
        this.firstEquivalentFileNames = new Set();
        this.fileFreeSpaceBytes = null;
        this.openMenuFile = null;
        this.isExplorerCollapsed = true;
        this.fileRunQueue = Promise.resolve();
        this.pendingSuppressedOutputLines = [];
        this.explorerWidthStorageKey = 'webdiii.explorerWidth';
        this.explorerWidthDefault = 280;
        this.explorerWidthMin = 220;
        this.explorerWidthMax = 520;
        this.isResizingExplorer = false;
        this.explorerResizePointerId = null;
        this.explorerResizeStartX = 0;
        this.explorerResizeStartWidth = this.explorerWidthDefault;
        this.midiMonitorVisible = false;
        this.midiAccess = null;
        this.midiPermissionRequested = false;
        this.midiInputNames = new Set();
        this.midiLogLimit = 600;
        this.midiAudioMuted = true;
        this.midiAudioContext = null;
        this.midiActiveVoices = new Map();
        this.midiWidthStorageKey = 'webdiii.midiWidth';
        this.midiWidthDefault = 340;
        this.midiWidthMin = 220;
        this.midiWidthMax = 560;
        this.isResizingMidi = false;
        this.midiResizePointerId = null;
        this.midiResizeStartX = 0;
        this.midiResizeStartWidth = this.midiWidthDefault;

        this.cacheElements();
        this.bindEvents();
        this.restoreExplorerWidth();
        this.setExplorerCollapsed(true);
        this.checkBrowserSupport();
        this.renderFileList();
        this.setMidiMonitorVisible(false);
        this.updateMidiAudioButton();
        this.updateMidiMonitorStatus('closed');

        this.outputLine('//// welcome. connect to an iii compatible grid or arc to begin.');
    }

    cacheElements() {
        this.elements = {
            scriptReferenceBtn: document.getElementById('scriptReferenceBtn'),

            splitContainer: document.getElementById('splitContainer'),
            fileExplorerPane: document.getElementById('fileExplorerPane'),
            explorerResizer: document.getElementById('explorerResizer'),
            fileList: document.getElementById('fileList'),
            fileSpaceFooter: document.getElementById('fileSpaceFooter'),
            toggleExplorerBtn: document.getElementById('toggleExplorerBtn'),
            explorerChevron: document.getElementById('explorerChevron'),

            connectionBtn: document.getElementById('replConnectionBtn'),
            replStatusPill: document.getElementById('replStatusPill'),
            replStatusIndicator: document.getElementById('replStatusIndicator'),
            replStatusText: document.getElementById('replStatusText'),

            output: document.getElementById('output'),
            replInput: document.getElementById('replInput'),
            replPane: document.getElementById('replPane'),
            replShell: document.getElementById('replShell'),
            uploadBtn: document.getElementById('uploadBtn'),
            restartBtn: document.getElementById('restartBtn'),
            bootloaderBtn: document.getElementById('bootloaderBtn'),
            reformatBtn: document.getElementById('reformatBtn'),
            clearBtn: document.getElementById('clearBtn'),
            midiMonitorToggleBtn: document.getElementById('midiMonitorToggleBtn'),
            midiResizer: document.getElementById('midiResizer'),
            midiMonitorPane: document.getElementById('midiMonitorPane'),
            midiMonitorStatus: document.getElementById('midiMonitorStatus'),
            midiMonitorLog: document.getElementById('midiMonitorLog'),
            midiAudioToggleBtn: document.getElementById('midiAudioToggleBtn'),
            midiClearBtn: document.getElementById('midiClearBtn'),

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
        on(this.elements.replStatusPill, 'click', () => this.toggleConnection());
        on(this.elements.replInput, 'keydown', (e) => this.handleReplInput(e));
        on(document, 'keydown', (e) => this.handleGlobalShortcuts(e));
        on(this.elements.toggleExplorerBtn, 'click', () => this.toggleExplorer());
        on(this.elements.explorerResizer, 'pointerdown', (e) => this.startExplorerResize(e));
        on(this.elements.explorerResizer, 'keydown', (e) => this.handleExplorerResizerKeydown(e));
        on(this.elements.uploadBtn, 'click', () => this.openUploadPicker());
        on(this.elements.restartBtn, 'click', () => this.restartDevice());
        on(this.elements.bootloaderBtn, 'click', () => this.bootloaderDevice());
        on(this.elements.reformatBtn, 'click', () => this.reformatFs());
        on(this.elements.clearBtn, 'click', () => this.clearOutput());
        on(this.elements.midiMonitorToggleBtn, 'click', () => this.toggleMidiMonitor());
        on(this.elements.midiResizer, 'pointerdown', (e) => this.startMidiResize(e));
        on(this.elements.midiResizer, 'keydown', (e) => this.handleMidiResizerKeydown(e));
        on(this.elements.midiAudioToggleBtn, 'click', () => this.toggleMidiAudioMute());
        on(this.elements.midiClearBtn, 'click', () => this.clearMidiMonitorLog());
        on(this.elements.fileInput, 'change', (e) => this.handleFileSelect(e));
        on(document, 'click', (e) => this.handleDocumentClick(e));

        on(this.elements.closeWarning, 'click', () => {
            this.elements.browserWarning.style.display = 'none';
        });

        on(this.elements.scriptReferenceBtn, 'click', () => {
            window.open('https://monome.org/docs/iii/', '_blank');
        });

        this.iiiDevice.onDataReceived = (data) => this.handleiiiOutput(data);
        this.iiiDevice.onConnectionChange = (connected, error) => this.handleConnectionChange(connected, error);

        if ('serial' in navigator) {
            navigator.serial.addEventListener('connect', (event) => this.handleSerialPortConnect(event));
            navigator.serial.addEventListener('disconnect', (event) => this.handleSerialPortDisconnect(event));
        }

        this.setupDragAndDrop();
    }

    checkBrowserSupport() {
        if ('serial' in navigator) return;
        if (this.elements.browserWarning) this.elements.browserWarning.style.display = 'flex';
        if (this.elements.connectionBtn) this.elements.connectionBtn.disabled = true;
        this.outputLine('ERROR: Web Serial API not supported in this browser.');
        this.outputLine('Please use Chrome, Edge, or Opera.');
    }

    toggleExplorer() {
        this.setExplorerCollapsed(!this.isExplorerCollapsed);
    }

    setExplorerCollapsed(collapsed) {
        this.isExplorerCollapsed = Boolean(collapsed);
        this.elements.fileExplorerPane?.classList.toggle('collapsed', this.isExplorerCollapsed);
        this.elements.explorerResizer?.classList.toggle('hidden', this.isExplorerCollapsed);

        if (this.elements.fileExplorerPane) {
            if (this.isExplorerCollapsed) {
                this.elements.fileExplorerPane.style.width = '';
                this.elements.fileExplorerPane.style.minWidth = '';
                this.elements.fileExplorerPane.style.maxWidth = '';
            } else {
                this.restoreExplorerWidth();
            }
        }

        if (this.elements.explorerResizer) {
            this.elements.explorerResizer.setAttribute('aria-hidden', String(this.isExplorerCollapsed));
            this.elements.explorerResizer.setAttribute('aria-disabled', String(this.isExplorerCollapsed));
            this.elements.explorerResizer.tabIndex = this.isExplorerCollapsed ? -1 : 0;
        }
        if (this.elements.toggleExplorerBtn) {
            this.elements.toggleExplorerBtn.setAttribute('aria-expanded', String(!this.isExplorerCollapsed));
        }
        if (this.elements.explorerChevron) {
            this.elements.explorerChevron.textContent = this.isExplorerCollapsed ? '›' : '‹';
        }

        this.updateExplorerResizerA11y();
    }

    clampExplorerWidth(width) {
        const containerWidth = this.elements.splitContainer?.clientWidth || 0;
        const dynamicMax = containerWidth > 0
            ? Math.max(this.explorerWidthMin, containerWidth - 320)
            : this.explorerWidthMax;
        const hardMax = Math.max(this.explorerWidthMin, Math.min(this.explorerWidthMax, dynamicMax));
        return Math.max(this.explorerWidthMin, Math.min(hardMax, Math.round(width)));
    }

    setExplorerWidth(width, { persist = true } = {}) {
        const pane = this.elements.fileExplorerPane;
        if (!pane || !Number.isFinite(Number(width))) return;

        const clamped = this.clampExplorerWidth(Number(width));
        pane.style.width = `${clamped}px`;
        pane.style.minWidth = `${clamped}px`;
        pane.style.maxWidth = `${clamped}px`;
        this.updateExplorerResizerA11y(clamped);

        if (persist) {
            try {
                window.localStorage.setItem(this.explorerWidthStorageKey, String(clamped));
            } catch {
                // ignore localStorage failures
            }
        }
    }

    restoreExplorerWidth() {
        let restored = this.explorerWidthDefault;

        try {
            const raw = window.localStorage.getItem(this.explorerWidthStorageKey);
            if (raw != null) {
                const parsed = Number.parseInt(raw, 10);
                if (Number.isFinite(parsed)) {
                    restored = parsed;
                }
            }
        } catch {
            // ignore localStorage failures
        }

        this.setExplorerWidth(restored, { persist: false });
    }

    getExplorerWidth() {
        return this.elements.fileExplorerPane?.getBoundingClientRect?.().width || this.explorerWidthDefault;
    }

    updateExplorerResizerA11y(width = this.getExplorerWidth()) {
        const resizer = this.elements.explorerResizer;
        if (!resizer) return;

        const maxWidth = this.clampExplorerWidth(Number.MAX_SAFE_INTEGER);
        const currentWidth = this.clampExplorerWidth(width);
        resizer.setAttribute('aria-valuemin', String(this.explorerWidthMin));
        resizer.setAttribute('aria-valuemax', String(maxWidth));
        resizer.setAttribute('aria-valuenow', String(currentWidth));
        resizer.setAttribute('aria-valuetext', `${currentWidth} pixels`);
    }

    handleExplorerResizerKeydown(event) {
        if (this.isExplorerCollapsed) return;

        const key = event.key;
        const isArrow = key === 'ArrowLeft' || key === 'ArrowRight';
        const isBoundary = key === 'Home' || key === 'End';
        if (!isArrow && !isBoundary) return;

        event.preventDefault();

        const currentWidth = this.getExplorerWidth();
        const step = event.shiftKey ? 48 : 16;

        if (key === 'Home') {
            this.setExplorerWidth(this.explorerWidthMin);
            return;
        }

        if (key === 'End') {
            this.setExplorerWidth(this.clampExplorerWidth(Number.MAX_SAFE_INTEGER));
            return;
        }

        const direction = key === 'ArrowRight' ? 1 : -1;
        this.setExplorerWidth(currentWidth + (direction * step));
    }

    startExplorerResize(event) {
        if (this.isExplorerCollapsed) return;
        if (!this.elements.fileExplorerPane || !this.elements.explorerResizer) return;

        event.preventDefault();

        this.isResizingExplorer = true;
        this.explorerResizePointerId = event.pointerId;
        this.explorerResizeStartX = event.clientX;
        this.explorerResizeStartWidth = this.elements.fileExplorerPane.getBoundingClientRect().width;

        this.elements.explorerResizer.classList.add('dragging');
        this.elements.explorerResizer.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-explorer');

        this.boundExplorerResizeMove = this.boundExplorerResizeMove || ((e) => this.handleExplorerResizeMove(e));
        this.boundExplorerResizeEnd = this.boundExplorerResizeEnd || ((e) => this.endExplorerResize(e));

        window.addEventListener('pointermove', this.boundExplorerResizeMove);
        window.addEventListener('pointerup', this.boundExplorerResizeEnd);
        window.addEventListener('pointercancel', this.boundExplorerResizeEnd);
    }

    handleExplorerResizeMove(event) {
        if (!this.isResizingExplorer) return;
        if (this.explorerResizePointerId != null && event.pointerId !== this.explorerResizePointerId) return;

        const delta = event.clientX - this.explorerResizeStartX;
        this.setExplorerWidth(this.explorerResizeStartWidth + delta);
    }

    endExplorerResize(event) {
        if (!this.isResizingExplorer) return;
        if (event && this.explorerResizePointerId != null && event.pointerId !== this.explorerResizePointerId) return;

        this.isResizingExplorer = false;
        this.explorerResizePointerId = null;

        this.elements.explorerResizer?.classList.remove('dragging');
        document.body.classList.remove('is-resizing-explorer');

        if (event && this.elements.explorerResizer?.hasPointerCapture?.(event.pointerId)) {
            this.elements.explorerResizer.releasePointerCapture(event.pointerId);
        }

        if (this.boundExplorerResizeMove) {
            window.removeEventListener('pointermove', this.boundExplorerResizeMove);
        }
        if (this.boundExplorerResizeEnd) {
            window.removeEventListener('pointerup', this.boundExplorerResizeEnd);
            window.removeEventListener('pointercancel', this.boundExplorerResizeEnd);
        }
    }

    outputText(text, options = {}) {
        const { autoScroll = true } = options;
        if (!this.elements.output) return;
        this.elements.output.appendChild(document.createTextNode(text));
        if (autoScroll) {
            this.elements.output.scrollTop = this.elements.output.scrollHeight;
        }
    }

    outputLine(text, options = {}) {
        this.outputText(`${text}\n`, options);
    }

    outputHTML(html, options = {}) {
        const { autoScroll = true } = options;
        if (!this.elements.output) return;
        const span = document.createElement('span');
        span.innerHTML = html;
        this.elements.output.appendChild(span);
        if (autoScroll) {
            this.elements.output.scrollTop = this.elements.output.scrollHeight;
        }
    }

    showToast(message, type = 'info') {
        if (!this.toastElement) {
            this.toastElement = document.createElement('div');
            this.toastElement.className = 'app-toast';
            document.body.appendChild(this.toastElement);
        }

        this.toastElement.className = `app-toast visible ${type}`;
        this.toastElement.textContent = message;

        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
        }

        this.toastTimer = setTimeout(() => {
            if (this.toastElement) {
                this.toastElement.className = 'app-toast';
            }
            this.toastTimer = null;
        }, 2600);
    }

    clearOutput() {
        if (this.elements.output) this.elements.output.textContent = '';
    }

    setMidiMonitorVisible(visible) {
        this.midiMonitorVisible = Boolean(visible);

        const pane = this.elements.midiMonitorPane;
        const resizer = this.elements.midiResizer;
        if (pane) {
            pane.classList.toggle('hidden', !this.midiMonitorVisible);
            pane.setAttribute('aria-hidden', String(!this.midiMonitorVisible));

            if (this.midiMonitorVisible) {
                this.restoreMidiWidth();
            }
        }

        if (resizer) {
            resizer.classList.toggle('hidden', !this.midiMonitorVisible);
            resizer.setAttribute('aria-hidden', String(!this.midiMonitorVisible));
            resizer.setAttribute('aria-disabled', String(!this.midiMonitorVisible));
            resizer.tabIndex = this.midiMonitorVisible ? 0 : -1;
        }

        if (this.elements.midiMonitorToggleBtn) {
            this.elements.midiMonitorToggleBtn.textContent = this.midiMonitorVisible ? 'hide midi' : 'midi';
            this.elements.midiMonitorToggleBtn.setAttribute('aria-expanded', String(this.midiMonitorVisible));
        }

        this.updateMidiResizerA11y();
    }

    clampMidiWidth(width) {
        const containerWidth = this.elements.replShell?.clientWidth || this.elements.replPane?.clientWidth || 0;
        const dynamicMax = containerWidth > 0
            ? Math.max(this.midiWidthMin, containerWidth - 360)
            : this.midiWidthMax;
        const hardMax = Math.max(this.midiWidthMin, Math.min(this.midiWidthMax, dynamicMax));
        return Math.max(this.midiWidthMin, Math.min(hardMax, Math.round(width)));
    }

    setMidiWidth(width, { persist = true } = {}) {
        const pane = this.elements.midiMonitorPane;
        if (!pane || !Number.isFinite(Number(width))) return;

        const clamped = this.clampMidiWidth(Number(width));
        pane.style.width = `${clamped}px`;
        pane.style.minWidth = `${clamped}px`;
        pane.style.maxWidth = `${clamped}px`;
        this.updateMidiResizerA11y(clamped);

        if (persist) {
            try {
                window.localStorage.setItem(this.midiWidthStorageKey, String(clamped));
            } catch {
                // ignore localStorage failures
            }
        }
    }

    restoreMidiWidth() {
        let restored = this.midiWidthDefault;

        try {
            const raw = window.localStorage.getItem(this.midiWidthStorageKey);
            if (raw != null) {
                const parsed = Number.parseInt(raw, 10);
                if (Number.isFinite(parsed)) {
                    restored = parsed;
                }
            }
        } catch {
            // ignore localStorage failures
        }

        this.setMidiWidth(restored, { persist: false });
    }

    getMidiWidth() {
        return this.elements.midiMonitorPane?.getBoundingClientRect?.().width || this.midiWidthDefault;
    }

    updateMidiResizerA11y(width = this.getMidiWidth()) {
        const resizer = this.elements.midiResizer;
        if (!resizer || !this.midiMonitorVisible) return;

        const maxWidth = this.clampMidiWidth(Number.MAX_SAFE_INTEGER);
        const currentWidth = this.clampMidiWidth(width);
        resizer.setAttribute('aria-valuemin', String(this.midiWidthMin));
        resizer.setAttribute('aria-valuemax', String(maxWidth));
        resizer.setAttribute('aria-valuenow', String(currentWidth));
        resizer.setAttribute('aria-valuetext', `${currentWidth} pixels`);
    }

    handleMidiResizerKeydown(event) {
        if (!this.midiMonitorVisible) return;

        const key = event.key;
        const isArrow = key === 'ArrowLeft' || key === 'ArrowRight';
        const isBoundary = key === 'Home' || key === 'End';
        if (!isArrow && !isBoundary) return;

        event.preventDefault();

        const currentWidth = this.getMidiWidth();
        const step = event.shiftKey ? 48 : 16;

        if (key === 'Home') {
            this.setMidiWidth(this.midiWidthMin);
            return;
        }

        if (key === 'End') {
            this.setMidiWidth(this.clampMidiWidth(Number.MAX_SAFE_INTEGER));
            return;
        }

        const direction = key === 'ArrowLeft' ? 1 : -1;
        this.setMidiWidth(currentWidth + (direction * step));
    }

    startMidiResize(event) {
        if (!this.midiMonitorVisible) return;
        if (!this.elements.midiMonitorPane || !this.elements.midiResizer) return;

        event.preventDefault();

        this.isResizingMidi = true;
        this.midiResizePointerId = event.pointerId;
        this.midiResizeStartX = event.clientX;
        this.midiResizeStartWidth = this.elements.midiMonitorPane.getBoundingClientRect().width;

        this.elements.midiResizer.classList.add('dragging');
        this.elements.midiResizer.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-midi');

        this.boundMidiResizeMove = this.boundMidiResizeMove || ((e) => this.handleMidiResizeMove(e));
        this.boundMidiResizeEnd = this.boundMidiResizeEnd || ((e) => this.endMidiResize(e));

        window.addEventListener('pointermove', this.boundMidiResizeMove);
        window.addEventListener('pointerup', this.boundMidiResizeEnd);
        window.addEventListener('pointercancel', this.boundMidiResizeEnd);
    }

    handleMidiResizeMove(event) {
        if (!this.isResizingMidi) return;
        if (this.midiResizePointerId != null && event.pointerId !== this.midiResizePointerId) return;

        const delta = event.clientX - this.midiResizeStartX;
        this.setMidiWidth(this.midiResizeStartWidth - delta);
    }

    endMidiResize(event) {
        if (!this.isResizingMidi) return;
        if (event && this.midiResizePointerId != null && event.pointerId !== this.midiResizePointerId) return;

        this.isResizingMidi = false;
        this.midiResizePointerId = null;

        this.elements.midiResizer?.classList.remove('dragging');
        document.body.classList.remove('is-resizing-midi');

        if (event && this.elements.midiResizer?.hasPointerCapture?.(event.pointerId)) {
            this.elements.midiResizer.releasePointerCapture(event.pointerId);
        }

        if (this.boundMidiResizeMove) {
            window.removeEventListener('pointermove', this.boundMidiResizeMove);
        }
        if (this.boundMidiResizeEnd) {
            window.removeEventListener('pointerup', this.boundMidiResizeEnd);
            window.removeEventListener('pointercancel', this.boundMidiResizeEnd);
        }
    }

    updateMidiMonitorStatus(text) {
        if (!this.elements.midiMonitorStatus) return;
        this.elements.midiMonitorStatus.textContent = String(text || '');
    }

    clearMidiMonitorLog() {
        if (this.elements.midiMonitorLog) {
            this.elements.midiMonitorLog.textContent = '';
        }
    }

    updateMidiAudioButton() {
        if (!this.elements.midiAudioToggleBtn) return;
        this.elements.midiAudioToggleBtn.textContent = this.midiAudioMuted ? 'unmute' : 'mute';
        this.elements.midiAudioToggleBtn.setAttribute('aria-pressed', String(!this.midiAudioMuted));
    }

    async toggleMidiAudioMute() {
        if (this.midiAudioMuted) {
            const ready = await this.ensureMidiAudioContext();
            if (!ready) {
                this.appendMidiSystemLine('audio unavailable in this browser');
                return;
            }
            this.midiAudioMuted = false;
            this.updateMidiAudioButton();
            this.appendMidiSystemLine('audio monitor unmuted');
            return;
        }

        this.midiAudioMuted = true;
        this.stopAllMidiVoices();
        this.updateMidiAudioButton();
        this.appendMidiSystemLine('audio monitor muted');
    }

    async ensureMidiAudioContext() {
        if (!this.midiAudioContext) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return false;
            this.midiAudioContext = new AudioCtx();
        }

        if (this.midiAudioContext.state === 'suspended') {
            await this.midiAudioContext.resume();
        }

        return this.midiAudioContext.state === 'running';
    }

    midiNoteToFrequency(note) {
        return 440 * Math.pow(2, (Number(note) - 69) / 12);
    }

    getMidiVoiceKey(channel, note) {
        return `${channel}:${note}`;
    }

    stopMidiVoice(channel, note, releaseSeconds = 0.22) {
        const key = this.getMidiVoiceKey(channel, note);
        const voice = this.midiActiveVoices.get(key);
        if (!voice || !this.midiAudioContext) return;

        const now = this.midiAudioContext.currentTime;
        const endAt = now + Math.max(0.03, releaseSeconds);

        voice.gain.gain.cancelScheduledValues(now);
        const current = Math.max(0.0001, voice.gain.gain.value || 0.0001);
        voice.gain.gain.setValueAtTime(current, now);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

        voice.osc1.stop(endAt + 0.01);
        voice.osc2.stop(endAt + 0.01);
        this.midiActiveVoices.delete(key);
    }

    stopAllMidiVoices() {
        for (const key of this.midiActiveVoices.keys()) {
            const [channel, note] = key.split(':').map((value) => Number(value));
            this.stopMidiVoice(channel, note, 0.06);
        }
    }

    playMidiPianoNote(channel, note, velocity) {
        if (this.midiAudioMuted || !this.midiAudioContext) return;

        const clampedVelocity = Math.max(1, Math.min(127, Number(velocity) || 0));
        const frequency = this.midiNoteToFrequency(note);
        const now = this.midiAudioContext.currentTime;
        const key = this.getMidiVoiceKey(channel, note);

        this.stopMidiVoice(channel, note, 0.02);

        const osc1 = this.midiAudioContext.createOscillator();
        const osc2 = this.midiAudioContext.createOscillator();
        const filter = this.midiAudioContext.createBiquadFilter();
        const gain = this.midiAudioContext.createGain();

        osc1.type = 'triangle';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(frequency, now);
        osc2.frequency.setValueAtTime(frequency * 2, now);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1900, now);
        filter.Q.setValueAtTime(0.8, now);

        const velocityGain = 0.08 + ((clampedVelocity / 127) * 0.22);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(velocityGain, now + 0.006);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, velocityGain * 0.45), now + 0.36);

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(this.midiAudioContext.destination);

        osc1.start(now);
        osc2.start(now);

        this.midiActiveVoices.set(key, { osc1, osc2, gain });
    }

    handleMidiAudioMessage(bytes) {
        if (this.midiAudioMuted || !this.midiAudioContext || !Array.isArray(bytes) || bytes.length === 0) {
            return;
        }

        const status = bytes[0] || 0;
        if (status >= 0xF0) return;

        const command = status & 0xF0;
        const channel = (status & 0x0F) + 1;
        const note = bytes[1] || 0;
        const velocity = bytes[2] || 0;

        if (command === 0x90 && velocity > 0) {
            this.playMidiPianoNote(channel, note, velocity);
            return;
        }

        if (command === 0x80 || (command === 0x90 && velocity === 0)) {
            this.stopMidiVoice(channel, note, 0.22);
        }
    }

    async toggleMidiMonitor() {
        if (this.midiMonitorVisible) {
            this.setMidiMonitorVisible(false);
            return;
        }

        this.setMidiMonitorVisible(true);

        if (!this.midiAccess && !this.midiPermissionRequested) {
            await this.initializeMidiAccess();
            return;
        }

        if (!this.midiAccess) {
            this.updateMidiMonitorStatus('midi unavailable (permission required)');
            return;
        }

        this.updateMidiMonitorStatus(this.getMidiInputsSummary());
    }

    async initializeMidiAccess() {
        if (!('requestMIDIAccess' in navigator)) {
            this.updateMidiMonitorStatus('webmidi unsupported in this browser');
            this.appendMidiSystemLine('WebMIDI API not supported in this browser.');
            return false;
        }

        this.midiPermissionRequested = true;
        this.updateMidiMonitorStatus('requesting midi permission...');

        try {
            this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
            this.midiAccess.onstatechange = (event) => this.handleMidiStateChange(event);
            this.attachMidiInputHandlers();
            this.updateMidiMonitorStatus(this.getMidiInputsSummary());
            this.appendMidiSystemLine('MIDI monitor ready. Listening for incoming messages...');
            return true;
        } catch (error) {
            const reason = String(error?.message || error || 'permission denied');
            this.updateMidiMonitorStatus('midi unavailable (permission denied)');
            this.appendMidiSystemLine(`MIDI permission failed: ${reason}`);
            this.outputLine(`MIDI monitor unavailable: ${reason}`);
            return false;
        }
    }

    attachMidiInputHandlers() {
        if (!this.midiAccess) return;

        this.midiInputNames = new Set();
        for (const input of this.midiAccess.inputs.values()) {
            if (!input) continue;
            const name = input.name || input.manufacturer || input.id || 'unknown input';
            if (this.isIiiMidiInput(input)) {
                input.onmidimessage = (event) => this.handleMidiMessage(event, input);
                this.midiInputNames.add(name);
            } else {
                input.onmidimessage = null;
            }
        }
    }

    isIiiMidiInput(input) {
        const label = String(input?.name || '').toLowerCase();
        return label.includes('iii');
    }

    handleMidiStateChange(event) {
        const port = event?.port;
        if (!port || port.type !== 'input') {
            this.updateMidiMonitorStatus(this.getMidiInputsSummary());
            return;
        }

        const isIii = this.isIiiMidiInput(port);

        if (port.state === 'connected' && isIii) {
            port.onmidimessage = (midiEvent) => this.handleMidiMessage(midiEvent, port);
            this.appendMidiSystemLine(`input connected: ${port.name || port.id || 'unknown input'}`);
        } else if (port.state === 'disconnected' && isIii) {
            this.appendMidiSystemLine(`input disconnected: ${port.name || port.id || 'unknown input'}`);
        }

        this.attachMidiInputHandlers();
        this.updateMidiMonitorStatus(this.getMidiInputsSummary());
    }

    getMidiInputsSummary() {
        if (!this.midiAccess) return 'midi unavailable';
        const count = this.midiInputNames.size;
        if (count === 0) return 'connected: no iii midi inputs found';
        if (count === 1) return `connected: 1 iii midi input (${[...this.midiInputNames][0] || 'unnamed'})`;
        return `connected: ${count} iii midi inputs`;
    }

    handleMidiMessage(event) {
        if (!event?.data || event.data.length === 0) return;

        const bytes = Array.from(event.data);
        this.handleMidiAudioMessage(bytes);
        const parsed = this.parseMidiMessage(bytes);
        this.appendMidiLogLine({
            typeClass: parsed.typeClass,
            typeLabel: parsed.label,
            detailLabel: parsed.detail,
            timestamp: Date.now()
        });
    }

    parseMidiMessage(bytes) {
        const status = bytes[0] || 0;
        const data1 = bytes[1] || 0;
        const data2 = bytes[2] || 0;

        if (status >= 0xF0) {
            if (status === 0xF8) {
                return { typeClass: 'midi-type-system', label: 'clock', detail: '' };
            }
            return { typeClass: 'midi-type-system', label: 'system', detail: `status ${status}` };
        }

        const command = status & 0xF0;
        const channel = (status & 0x0F) + 1;

        if (command === 0x80 || (command === 0x90 && data2 === 0)) {
            return {
                typeClass: 'midi-type-note-off',
                label: 'note off',
                detail: `ch ${channel} note ${data1} vel ${data2}`
            };
        }

        if (command === 0x90) {
            return {
                typeClass: 'midi-type-note-on',
                label: 'note on',
                detail: `ch ${channel} note ${data1} vel ${data2}`
            };
        }

        if (command === 0xA0) {
            return {
                typeClass: 'midi-type-poly-aftertouch',
                label: 'poly aftertouch',
                detail: `ch ${channel} note ${data1} pressure ${data2}`
            };
        }

        if (command === 0xB0) {
            return {
                typeClass: 'midi-type-control-change',
                label: 'cc',
                detail: `ch ${channel} cc ${data1} val ${data2}`
            };
        }

        if (command === 0xC0) {
            return {
                typeClass: 'midi-type-program-change',
                label: 'program',
                detail: `ch ${channel} program ${data1}`
            };
        }

        if (command === 0xD0) {
            return {
                typeClass: 'midi-type-channel-pressure',
                label: 'channel pressure',
                detail: `ch ${channel} pressure ${data1}`
            };
        }

        if (command === 0xE0) {
            const value = ((data2 << 7) | data1) - 8192;
            return {
                typeClass: 'midi-type-pitch-bend',
                label: 'pitch bend',
                detail: `ch ${channel} value ${value}`
            };
        }

        return {
            typeClass: 'midi-type-system',
            label: 'midi',
            detail: `status ${status}`
        };
    }

    appendMidiSystemLine(text) {
        this.appendMidiLogLine({
            typeClass: 'midi-type-system',
            typeLabel: 'system',
            detailLabel: String(text || ''),
            timestamp: Date.now()
        });
    }

    appendMidiDetailText(detailElement, detailLabel) {
        const raw = String(detailLabel || '');
        if (!raw) return;

        const highlightPattern = /(\b(?:ch|note|vel)\s+)(\d+)/g;
        let cursor = 0;
        let match = null;

        while ((match = highlightPattern.exec(raw)) !== null) {
            const [fullMatch, prefix, value] = match;
            const start = match.index;
            if (start > cursor) {
                detailElement.appendChild(document.createTextNode(raw.slice(cursor, start)));
            }

            detailElement.appendChild(document.createTextNode(prefix));

            const strong = document.createElement('strong');
            strong.textContent = value;
            detailElement.appendChild(strong);

            cursor = start + fullMatch.length;
        }

        if (cursor < raw.length) {
            detailElement.appendChild(document.createTextNode(raw.slice(cursor)));
        }
    }

    appendMidiLogLine({ typeClass, typeLabel, detailLabel, timestamp }) {
        const log = this.elements.midiMonitorLog;
        if (!log) return;

        const line = document.createElement('div');
        line.className = 'midi-line';

        const time = document.createElement('span');
        time.className = 'midi-line-time';
        const when = new Date(Number(timestamp) || Date.now());
        const hh = String(when.getHours()).padStart(2, '0');
        const mm = String(when.getMinutes()).padStart(2, '0');
        const ss = String(when.getSeconds()).padStart(2, '0');
        time.textContent = `${hh}:${mm}:${ss} `;
        line.appendChild(time);

        const type = document.createElement('span');
        type.className = typeClass || 'midi-type-system';
        type.textContent = `${typeLabel || 'midi'} `;
        line.appendChild(type);

        const detail = document.createElement('span');
        detail.className = 'midi-line-meta';
        this.appendMidiDetailText(detail, detailLabel);
        line.appendChild(detail);

        log.appendChild(line);

        while (log.childElementCount > this.midiLogLimit) {
            log.removeChild(log.firstChild);
        }

        log.scrollTop = log.scrollHeight;
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

    handleGlobalShortcuts(event) {
        if (event.defaultPrevented) return;

        const isConnectToggle = (event.metaKey || event.ctrlKey)
            && event.shiftKey
            && !event.altKey
            && String(event.key).toLowerCase() === 'c';

        if (!isConnectToggle) return;

        event.preventDefault();
        this.toggleConnection();
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
        const isHelpShortcut = /^h$/i.test(code.trim());
        const isUploadShortcut = /^u$/i.test(code.trim());
        const containsFsCommand = /\bfs_[a-zA-Z0-9_]*\b/.test(code);
        const containsFsRunFile = /\bfs_run_file\s*\(/.test(code);
        const containsFsRemoveFile = /\bfs_remove_file\s*\(/.test(code);
        const containsFsReformat = /\bfs_reformat\s*\(/.test(code);
        const containsCleanCommand = /(?:^|\s)\^\^c(?:\s|$)/i.test(code);
        const shouldAutoOpenExplorer = containsFsRunFile || containsFsRemoveFile || containsFsReformat;

        if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== code) {
            this.commandHistory.push(code);
        }

        if (isHelpShortcut) {
            this.showHelp();
            this.elements.replInput.value = '';
            this.historyIndex = -1;
            this.currentInput = '';
            return;
        }

        if (isUploadShortcut) {
            this.openUploadPicker();
            this.elements.replInput.value = '';
            this.historyIndex = -1;
            this.currentInput = '';
            return;
        }

        if (!this.iiiDevice.isConnected) {
            this.outputLine('no iii device connected.');
            this.elements.replInput.value = '';
            this.historyIndex = -1;
            this.currentInput = '';
            return;
        }

        if (containsFsRemoveFile) {
            const singleTargetMatch = code.match(/\bfs_remove_file\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            const promptLabel = singleTargetMatch
                ? `Delete ${singleTargetMatch[1]}?`
                : 'Run fs_remove_file command?';
            if (!window.confirm(promptLabel)) {
                return;
            }
        }

        if (containsFsReformat) {
            if (!window.confirm('Reformat filesystem? This will erase all files on your iii device.')) {
                return;
            }
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

            if (shouldAutoOpenExplorer) {
                this.setExplorerCollapsed(false);
            }

            if (containsFsCommand) {
                await this.delay(150);
                await this.refreshFileList();
            }

            if (containsCleanCommand) {
                this.activeFileName = null;
                this.renderFileList();
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

    async connect(options = {}) {
        const { auto = false } = options;
        this.pendingConnectAttemptType = auto ? 'auto' : 'manual';

        try {
            if (!auto) {
                this.outputLine('Connecting to iii device...');
            }

            let reconnectPort = this.selectedPort;

            if (reconnectPort && 'serial' in navigator) {
                try {
                    const availablePorts = await navigator.serial.getPorts();
                    const matchingPort = this.findMatchingPort(availablePorts, reconnectPort, this.selectedPortInfo);
                    if (matchingPort) {
                        reconnectPort = matchingPort;
                        this.selectedPort = matchingPort;
                    }
                } catch {
                    // ignore and fall back to the remembered port object
                }
            }

            let connected = await this.iiiDevice.connect(reconnectPort);

            if (!connected && this.selectedPort && !auto) {
                this.selectedPort = null;
                this.selectedPortInfo = null;
                connected = await this.iiiDevice.connect();
            }

            if (connected) {
                this.selectedPort = this.iiiDevice.port;
                this.selectedPortInfo = this.getPortInfo(this.selectedPort);
                this.hasConnectedThisSession = true;
                this.autoReconnectEnabled = true;
                this.clearAutoReconnectTimer();
                this.setExplorerCollapsed(false);
                const deviceType = await this.updateConnectedDeviceLabel();

                if (auto) {
                    if (deviceType) {
                        this.outputLine(`${deviceType} reconnected.`);
                    } else {
                        this.outputLine('Reconnected.');
                    }
                } else if (deviceType) {
                    this.outputLine(`${deviceType} connected! Ready to code.`);
                } else {
                    this.outputLine('Connected! Ready to code.');
                }

                if (!auto) {
                    this.outputLine('Drag and drop a lua file here to auto-upload.');
                    this.outputLine('');
                }

                await this.refreshFileList();
                return true;
            }

            if (auto) {
                this.scheduleAutoReconnect();
            }

            return false;
        } finally {
            this.pendingConnectAttemptType = null;
        }
    }

    async updateConnectedDeviceLabel() {
        if (!this.iiiDevice.isConnected || !this.elements.replStatusText) {
            return null;
        }

        try {
            const lines = await this.executeLuaCapture('print(device_id())');
            const deviceType = lines.map((line) => String(line).trim()).find((line) => line.length > 0);
            this.elements.replStatusText.textContent = deviceType
                ? deviceType
                : 'connected';
            return deviceType || null;
        } catch {
            this.elements.replStatusText.textContent = 'connected';
            return null;
        }
    }

    async disconnect(manual = true) {
        this.isManualDisconnect = manual;
        if (manual) {
            this.autoReconnectEnabled = false;
            this.clearAutoReconnectTimer();
        }

        await this.iiiDevice.disconnect();
        this.outputLine('');
        this.outputLine('disconnected');
        this.outputLine('');
        this.activeFileName = null;
        this.fileFreeSpaceBytes = null;
        this.fileEntries = [];
        this.updateFileSpaceFooter(null);
        this.renderFileList();
    }

    handleConnectionChange(connected, error, detail = null) {
        if (!this.elements.connectionBtn || !this.elements.replStatusIndicator || !this.elements.replStatusText) return;

        if (connected) {
            this.elements.connectionBtn.textContent = 'disconnect';
            this.elements.replStatusIndicator.classList.add('connected');
            this.elements.replStatusText.textContent = 'connected';
            this.elements.replInput?.focus();
            this.hasConnectedThisSession = true;
            this.isManualDisconnect = false;
            return;
        }

        this.elements.connectionBtn.textContent = 'connect';
        this.elements.replStatusIndicator.classList.remove('connected');

        const browserError = String(detail?.browserError || '').trim();
        const isConnectFailure = error === 'connection failed';
        const isManualConnectFailure = isConnectFailure && this.pendingConnectAttemptType === 'manual';

        if (isManualConnectFailure || (!this.hasConnectedThisSession && isConnectFailure)) {
            this.elements.replStatusText.textContent = 'connection failed';
            if (browserError) {
                this.outputLine(`Browser error: ${browserError}`);
            }
        } else if (this.hasConnectedThisSession) {
            this.elements.replStatusText.textContent = 'disconnected';
        } else {
            this.elements.replStatusText.textContent = 'not connected';
        }

        if (error && error.includes('disconnected')) {
            this.outputLine('');
            this.outputLine(error);

            if (this.autoReconnectEnabled && !this.isManualDisconnect && this.selectedPort) {
                this.scheduleAutoReconnect();
            }
        }

        this.isManualDisconnect = false;
    }

    handleSerialPortConnect(event) {
        if (!this.autoReconnectEnabled || this.iiiDevice.isConnected || !this.selectedPort) {
            return;
        }

        const eventPort = event?.port;
        if (eventPort && !this.isSamePort(eventPort, this.selectedPort, this.selectedPortInfo)) {
            return;
        }

        this.scheduleAutoReconnect(150);
    }

    async handleSerialPortDisconnect(event) {
        if (!this.selectedPort) {
            return;
        }

        const eventPort = event?.port;
        if (eventPort && !this.isSamePort(eventPort, this.selectedPort, this.selectedPortInfo)) {
            return;
        }

        if (this.autoReconnectEnabled && !this.isManualDisconnect) {
            if (this.iiiDevice.isConnected) {
                await this.disconnect(false);
            }
            this.scheduleAutoReconnect();
        }
    }

    getPortInfo(port) {
        try {
            return port?.getInfo?.() || null;
        } catch {
            return null;
        }
    }

    isSamePort(portA, portB, preferredInfo = null) {
        if (!portA || !portB) return false;
        if (portA === portB) return true;

        const infoA = this.getPortInfo(portA);
        const infoB = preferredInfo || this.getPortInfo(portB);
        if (!infoA || !infoB) return false;

        return infoA.usbVendorId === infoB.usbVendorId
            && infoA.usbProductId === infoB.usbProductId;
    }

    findMatchingPort(ports, preferredPort, preferredInfo = null) {
        if (!Array.isArray(ports) || ports.length === 0) {
            return null;
        }

        const exactMatch = ports.find((port) => port === preferredPort);
        if (exactMatch) return exactMatch;

        if (!preferredInfo) {
            return null;
        }

        return ports.find((port) => {
            const info = this.getPortInfo(port);
            if (!info) return false;

            return info.usbVendorId === preferredInfo.usbVendorId
                && info.usbProductId === preferredInfo.usbProductId;
        }) || null;
    }

    clearAutoReconnectTimer() {
        if (!this.autoReconnectTimer) return;
        clearTimeout(this.autoReconnectTimer);
        this.autoReconnectTimer = null;
    }

    scheduleAutoReconnect(delay = this.reconnectDelayMs) {
        if (!this.autoReconnectEnabled || this.iiiDevice.isConnected || !this.selectedPort || this.autoReconnectTimer) {
            return;
        }

        this.autoReconnectTimer = setTimeout(async () => {
            this.autoReconnectTimer = null;

            if (!this.autoReconnectEnabled || this.iiiDevice.isConnected) {
                return;
            }

            await this.connect({ auto: true });
        }, delay);
    }

    handleiiiOutput(data) {
        const cleaned = String(data).replace(/\r/g, '');
        if (!cleaned) return;

        if (this.handleSuppressedOutputLine(cleaned)) {
            return;
        }

        if (this.handleLuaCaptureLine(cleaned)) {
            return;
        }

        if (this.handleFilenameCaptureLine(cleaned)) {
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

    formatSizeKb(bytes) {
        const kb = (Number(bytes) || 0) / 1024;
        return `${Math.round(kb)}kb`;
    }

    updateFileSpaceFooter(bytes) {
        if (!this.elements.fileSpaceFooter) return;

        if (!Number.isFinite(Number(bytes))) {
            this.elements.fileSpaceFooter.textContent = 'free space: -- kb';
            return;
        }

        const kb = Math.round(Number(bytes) / 1024);
        this.elements.fileSpaceFooter.textContent = `free space: ${kb} kb`;
    }

    isInitFile(name) {
        return name === 'init.lua' || name === 'init';
    }

    getSortedFileEntries() {
        const entries = [...this.fileEntries];
        return entries.sort((a, b) => {
            const order = (name) => {
                if (this.isInitFile(name)) return 0;
                if (name === 'lib.lua') return 1;
                return 2;
            };

            const rankDiff = order(a.name) - order(b.name);
            if (rankDiff !== 0) return rankDiff;
            return a.name.localeCompare(b.name);
        });
    }

    async openAndSelectRemoteFile(fileName) {
        const normalizedName = String(fileName || '').trim();
        if (!normalizedName) {
            throw new Error('Missing file name for ^^s');
        }

        this.queueSuppressedOutputLine('-- receiving data');
        this.queueSuppressedOutputLine(`-- set filename: ${normalizedName}`);

        await this.iiiDevice.writeLine('^^s');
        await this.delay(100);
        await this.iiiDevice.writeLine(normalizedName);
        await this.delay(100);
        await this.iiiDevice.writeLine('^^f');
        await this.delay(100);
    }

    queueSuppressedOutputLine(line, ttlMs = 2500) {
        const value = String(line || '');
        if (!value) return;
        this.pendingSuppressedOutputLines.push({
            line: value,
            expiresAt: Date.now() + ttlMs
        });
    }

    handleSuppressedOutputLine(line) {
        if (!this.pendingSuppressedOutputLines.length) return false;

        const now = Date.now();
        this.pendingSuppressedOutputLines = this.pendingSuppressedOutputLines.filter((entry) => entry.expiresAt > now);

        const matchIndex = this.pendingSuppressedOutputLines.findIndex((entry) => entry.line === line);
        if (matchIndex === -1) return false;

        this.pendingSuppressedOutputLines.splice(matchIndex, 1);
        return true;
    }

    async sendScriptTextToiii(fileName, text) {
        const baseName = fileName;
        const lines = this.getUploadLines(text);

        await this.executeLuaCapture(`fs_remove_file(${this.luaQuote(baseName)})`);

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
            await this.refreshFileList();
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
            this.setExplorerCollapsed(false);
            const text = await file.text();
            await this.uploadTextAsScript(file.name, text);
            await this.enqueueRunFile(file.name, { prepRuntimeWithLib: true });
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}`);
        }
    }

    handleDocumentClick(event) {
        if (!this.openMenuFile) return;
        if (event.target?.closest('.file-row')) return;
        this.openMenuFile = null;
        this.renderFileList();
    }

    renderFileList() {
        if (!this.elements.fileList) return;

        this.elements.fileList.textContent = '';

        if (!this.iiiDevice.isConnected) {
            const empty = document.createElement('div');
            empty.className = 'file-list-empty';
            empty.textContent = 'connect to load files';
            this.elements.fileList.appendChild(empty);
            return;
        }

        if (this.fileEntries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'file-list-empty';
            empty.textContent = 'no files';
            this.elements.fileList.appendChild(empty);
            return;
        }

        const sortedEntries = this.getSortedFileEntries();
        const pinnedCount = sortedEntries.filter((entry) => entry.name === 'lib.lua' || this.isInitFile(entry.name)).length;

        for (let index = 0; index < sortedEntries.length; index += 1) {
            const entry = sortedEntries[index];
            const row = document.createElement('div');
            row.className = 'file-row';

            const main = document.createElement('div');
            main.className = 'file-main';
            const isLibFile = entry.name === 'lib.lua';

            const playBtn = document.createElement('button');
            playBtn.className = `file-play-btn${this.activeFileName === entry.name ? ' active' : ''}`;
            playBtn.type = 'button';
            playBtn.textContent = '▶';
            playBtn.setAttribute('aria-label', `run ${entry.name}`);
            playBtn.addEventListener('click', async (event) => {
                event.stopPropagation();
                await this.enqueueRunFile(entry.name, { prepRuntimeWithLib: true });
            });
            main.appendChild(playBtn);

            const label = document.createElement('div');
            label.className = 'file-label';
            label.textContent = `${entry.name} (${this.formatSizeKb(entry.size)})`;

            main.appendChild(label);

            if (entry.name !== 'init.lua' && this.firstEquivalentFileNames.has(entry.name)) {
                const firstBadge = document.createElement('span');
                firstBadge.className = 'file-first-pill';
                firstBadge.textContent = 'first';
                firstBadge.setAttribute('aria-label', `${entry.name} matches init.lua`);
                main.appendChild(firstBadge);
            }

            const menuBtn = document.createElement('button');
            menuBtn.className = 'file-menu-btn';
            menuBtn.type = 'button';
            menuBtn.textContent = '⋯';
            menuBtn.setAttribute('aria-label', `actions for ${entry.name}`);
            menuBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.openMenuFile = this.openMenuFile === entry.name ? null : entry.name;
                this.renderFileList();
            });

            const menu = document.createElement('div');
            menu.className = `file-menu${this.openMenuFile === entry.name ? ' open' : ''}`;

            const actions = (isLibFile
                ? [
                    { label: 'read', fn: () => this.showFile(entry.name) },
                    { label: 'run', fn: () => this.enqueueRunFile(entry.name, { prepRuntimeWithLib: true }) },
                    { label: 'download', fn: () => this.downloadFile(entry.name) },
                    { label: 'delete', fn: () => this.deleteFile(entry.name) }
                ]
                : [
                    { label: 'first', fn: () => this.copyToInit(entry.name) },
                    { label: 'read', fn: () => this.showFile(entry.name) },
                    { label: 'run', fn: () => this.enqueueRunFile(entry.name, { prepRuntimeWithLib: true }) },
                    { label: 'download', fn: () => this.downloadFile(entry.name) },
                    { label: 'rename', fn: () => this.renameFile(entry.name) },
                    { label: 'delete', fn: () => this.deleteFile(entry.name) }
                ])
                .sort((a, b) => {
                    const priorityOf = (label) => {
                        if (label === 'run') return 0;
                        if (label === 'delete') return 2;
                        return 1;
                    };
                    const priorityDiff = priorityOf(a.label) - priorityOf(b.label);
                    if (priorityDiff !== 0) return priorityDiff;
                    return a.label.localeCompare(b.label);
                });

            for (const action of actions) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'file-menu-item';
                item.textContent = action.label;
                item.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    this.openMenuFile = null;
                    this.renderFileList();
                    await action.fn();
                });
                menu.appendChild(item);
            }

            row.appendChild(main);
            row.appendChild(menuBtn);
            row.appendChild(menu);
            this.elements.fileList.appendChild(row);

            if (pinnedCount > 0 && index === pinnedCount - 1 && index < sortedEntries.length - 1) {
                const separator = document.createElement('div');
                separator.className = 'file-list-separator';
                this.elements.fileList.appendChild(separator);
            }
        }
    }

    luaQuote(value) {
        return `'${String(value)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')}'`;
    }

    handleLuaCaptureLine(line) {
        const capture = this.pendingLuaCapture;
        if (!capture) return false;

        if (line === capture.beginToken) {
            capture.started = true;
            return true;
        }

        if (line === capture.endToken) {
            clearTimeout(capture.timeoutId);
            const { resolve, lines, error } = capture;
            this.pendingLuaCapture = null;
            resolve({ lines, error });
            return true;
        }

        if (!capture.started) return false;

        if (line.startsWith(capture.errorPrefix)) {
            capture.error = line;
            return true;
        }

        capture.lines.push(line);
        return true;
    }

    handleFilenameCaptureLine(line) {
        const capture = this.pendingFilenameCapture;
        if (!capture) return false;

        const match = line.match(/^-- filename:\s*(.+)$/);
        if (!match) return false;

        clearTimeout(capture.timeoutId);
        this.pendingFilenameCapture = null;
        capture.resolve(match[1].trim());
        return true;
    }

    async requestActiveFileName() {
        if (!this.iiiDevice.isConnected) return null;
        if (this.pendingFilenameCapture) {
            throw new Error('File selection request already in progress');
        }

        const resultPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingFilenameCapture = null;
                reject(new Error('Timed out waiting for filename response'));
            }, 2500);

            this.pendingFilenameCapture = { resolve, reject, timeoutId };
        });

        await this.iiiDevice.writeLine('^^g');
        return resultPromise;
    }

    async executeLuaCapture(commands) {
        if (!this.iiiDevice.isConnected) {
            throw new Error('Not connected to usb device');
        }

        if (this.pendingLuaCapture) {
            throw new Error('Device is busy, please try again');
        }

        const captureId = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
        const beginToken = `__webdiii_begin:${captureId}`;
        const endToken = `__webdiii_end:${captureId}`;
        const errorPrefix = '__webdiii_err:';

        const resultPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingLuaCapture = null;
                reject(new Error('Timed out waiting for device response'));
            }, 7000);

            this.pendingLuaCapture = {
                beginToken,
                endToken,
                errorPrefix,
                started: false,
                lines: [],
                error: null,
                timeoutId,
                resolve,
                reject
            };
        });

        await this.iiiDevice.writeLine(`print(${this.luaQuote(beginToken)})`);

        const lines = Array.isArray(commands)
            ? commands
            : String(commands).split('\n');

        for (const rawLine of lines) {
            const line = String(rawLine).trim();
            if (!line) continue;
            await this.iiiDevice.writeLine(
                `do local __ok, __err = pcall(function() ${line} end); if not __ok then print(${this.luaQuote(errorPrefix)} .. tostring(__err)) end end`
            );
        }

        await this.iiiDevice.writeLine(`print(${this.luaQuote(endToken)})`);

        const result = await resultPromise;
        if (result.error) {
            throw new Error(result.error);
        }
        return result.lines;
    }

    async refreshFileList() {
        if (!this.iiiDevice.isConnected) {
            this.fileEntries = [];
            this.firstEquivalentFileNames = new Set();
            this.fileFreeSpaceBytes = null;
            this.updateFileSpaceFooter(null);
            this.renderFileList();
            return;
        }

        try {
            const lines = await this.executeLuaCapture(
                'local __free = fs_free_space() or 0; print("__webdiii_free\\t" .. tostring(__free)); for _, __name in ipairs(fs_list_files()) do local __size = fs_file_size(__name) or 0; print("__webdiii_file\\t" .. __name .. "\\t" .. tostring(__size)) end'
            );

            const entries = [];
            for (const line of lines) {
                if (line.startsWith('__webdiii_free\t')) {
                    const freeRaw = line.split('\t')[1];
                    this.fileFreeSpaceBytes = Number.parseInt(freeRaw, 10);
                    continue;
                }
                if (!line.startsWith('__webdiii_file\t')) continue;
                const parts = line.split('\t');
                if (parts.length < 3) continue;
                const name = parts[1];
                const size = Number.parseInt(parts[2], 10) || 0;
                entries.push({ name, size });
            }

            this.fileEntries = entries;

            try {
                await this.refreshFirstEquivalentFileNames(entries);
            } catch {
                this.firstEquivalentFileNames = new Set();
            }

            try {
                this.activeFileName = await this.requestActiveFileName();
            } catch {
                this.activeFileName = null;
            }

            this.updateFileSpaceFooter(this.fileFreeSpaceBytes);
            this.renderFileList();
        } catch (error) {
            this.firstEquivalentFileNames = new Set();
            this.fileFreeSpaceBytes = null;
            this.updateFileSpaceFooter(null);
            this.outputLine(`File list error: ${error.message}`);
        }
    }

    async refreshFirstEquivalentFileNames(entries) {
        const hasInitLua = entries.some((entry) => entry.name === 'init.lua');
        if (!hasInitLua) {
            this.firstEquivalentFileNames = new Set();
            return;
        }

        const candidateNames = entries
            .map((entry) => entry.name)
            .filter((name) => name !== 'init.lua');

        if (candidateNames.length === 0) {
            this.firstEquivalentFileNames = new Set();
            return;
        }

        const luaList = candidateNames.map((name) => this.luaQuote(name)).join(', ');
        const lines = await this.executeLuaCapture(
            `local function __norm(__s) if not __s then return nil end return (__s:gsub("%z+$", "")) end local __init = __norm(fs_read_file('init.lua')); if __init then for _, __name in ipairs({${luaList}}) do local __data = __norm(fs_read_file(__name)); if __data and __data == __init then print("__webdiii_firsteq\\t" .. __name) end end end`
        );

        const matches = new Set();
        for (const line of lines) {
            if (!line.startsWith('__webdiii_firsteq\t')) continue;
            const name = line.split('\t')[1];
            if (name) matches.add(name);
        }

        this.firstEquivalentFileNames = matches;
    }

    async readRemoteFile(fileName) {
        const lines = await this.executeLuaCapture(
            `local __webdiii_data = fs_read_file(${this.luaQuote(fileName)}); if __webdiii_data then print(__webdiii_data) end`
        );
        return lines.join('\n');
    }

    async copyToInit(fileName) {
        try {
            await this.executeLuaCapture(
                `local __d = fs_read_file(${this.luaQuote(fileName)}); if __d then fs_write_file('init.lua', __d) else error('copy failed: cannot read source file') end`
            );
            this.outputLine(`Copied ${fileName} to init.lua`);
            await this.refreshFileList();
        } catch (error) {
            this.outputLine(`Copy error: ${error.message}`);
        }
    }

    async downloadFile(fileName) {
        try {
            const content = await this.readRemoteFile(fileName);
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            this.outputLine(`Downloaded ${fileName}`);
        } catch (error) {
            this.outputLine(`Download error: ${error.message}`);
        }
    }

    async showFile(fileName) {
        try {
            if (!this.elements.output) return;

            const topSpacerLine = document.createElement('span');
            topSpacerLine.textContent = '\n';
            this.elements.output.appendChild(topSpacerLine);

            const headerLine = document.createElement('span');
            headerLine.textContent = `${fileName} contents:\n`;
            this.elements.output.appendChild(headerLine);

            const afterHeaderSpacerLine = document.createElement('span');
            afterHeaderSpacerLine.textContent = '\n';
            this.elements.output.appendChild(afterHeaderSpacerLine);

            const lines = await this.executeLuaCapture(`print(fs_read_file(${this.luaQuote(fileName)}))`);
            for (const line of lines) {
                this.outputLine(line, { autoScroll: false });
            }

            const trailingSpacerLine = document.createElement('span');
            trailingSpacerLine.textContent = '\n';
            this.elements.output.appendChild(trailingSpacerLine);

            this.elements.output.scrollTop = topSpacerLine.offsetTop;
        } catch (error) {
            this.outputLine(`Show error: ${error.message}`);
        }
    }

    async prepareRuntimeWithLib() {
        this.queueSuppressedOutputLine('-- re-init with no script');
        this.queueSuppressedOutputLine('-- init: skip script');
        this.queueSuppressedOutputLine('-- init: writing lib.lua');
        await this.iiiDevice.writeLine('^^c');
        await this.delay(120);

        await this.executeLuaCapture("fs_run_file('lib.lua')");

        this.activeFileName = null;
        this.renderFileList();
    }

    async enqueueRunFile(fileName, options = {}) {
        const task = async () => {
            await this.runFile(fileName, options);
        };

        this.fileRunQueue = this.fileRunQueue
            .catch(() => {})
            .then(task);

        return this.fileRunQueue;
    }

    async runFile(fileName, options = {}) {
        const { prepRuntimeWithLib = false } = options;

        try {
            if (prepRuntimeWithLib) {
                await this.prepareRuntimeWithLib();
            }

            await this.openAndSelectRemoteFile(fileName);
            const lines = await this.executeLuaCapture(`fs_run_file(${this.luaQuote(fileName)})`);
            for (const line of lines) {
                this.outputLine(line);
            }
            this.activeFileName = fileName;
            this.renderFileList();
            this.outputLine(`Running ${fileName}`);
        } catch (error) {
            this.outputLine(`Run error: ${error.message}`);
        }
    }

    normalizeLuaFileName(rawName) {
        const trimmed = String(rawName || '').trim();
        if (!trimmed) return '';
        return trimmed.toLowerCase().endsWith('.lua') ? trimmed : `${trimmed}.lua`;
    }

    async renameFile(oldName) {
        const proposed = window.prompt('Rename file', oldName);
        if (proposed == null) return;

        await this.refreshFileList();

        const newName = this.normalizeLuaFileName(proposed);
        if (!newName) {
            this.outputLine('Rename canceled: invalid filename');
            return;
        }

        if (newName === oldName) {
            return;
        }

        if (this.fileEntries.some((entry) => entry.name === newName)) {
            this.showToast(`Rename blocked: ${newName} already exists`, 'warn');
            return;
        }

        try {
            await this.executeLuaCapture(
                `local __d = fs_read_file(${this.luaQuote(oldName)}); if __d then fs_write_file(${this.luaQuote(newName)}, __d); fs_remove_file(${this.luaQuote(oldName)}) else error('rename failed: cannot read source file') end`
            );
            this.outputLine(`Renamed ${oldName} to ${newName}`);
            await this.refreshFileList();
        } catch (error) {
            this.outputLine(`Rename error: ${error.message}`);
        }
    }

    async deleteFile(fileName) {
        if (!window.confirm(`Delete ${fileName}?`)) {
            return;
        }

        try {
            await this.executeLuaCapture(`fs_remove_file(${this.luaQuote(fileName)})`);
            this.outputLine(`Deleted ${fileName}`);
            await this.refreshFileList();
        } catch (error) {
            this.outputLine(`Delete error: ${error.message}`);
        }
    }

    setupDragAndDrop() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
            document.body.addEventListener(eventName, (event) => {
                event.preventDefault();
                event.stopPropagation();
            }, false);
        });

        document.body.addEventListener('drop', async (event) => {
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return;

            const file = files[0];
            if (!file.name.endsWith('.lua')) {
                this.outputLine('Error: Only .lua files are supported');
                return;
            }

            this.setExplorerCollapsed(false);

            const text = await file.text();
            await this.uploadTextAsScript(file.name, text);
            await this.enqueueRunFile(file.name, { prepRuntimeWithLib: true });
        });
    }

    restartDevice() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }
        this.outputLine('> ^^r');
        this.iiiDevice.writeLine('^^r');

        if (this.reconnectAfterRestartTimer) {
            clearTimeout(this.reconnectAfterRestartTimer);
        }

        this.reconnectAfterRestartTimer = setTimeout(async () => {
            if (!this.iiiDevice.isConnected) {
                await this.connect({ auto: true });
            }
            this.reconnectAfterRestartTimer = null;
        }, 1000);
    }

    bootloaderDevice() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }
        this.outputLine('> ^^b');
        this.iiiDevice.writeLine('^^b');
    }

    async reformatFs() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device');
            return;
        }

        if (!window.confirm('Reformat filesystem? This will erase all files on your iii device.')) {
            return;
        }

        try {
            this.outputLine('> fs_reformat()');
            await this.executeLuaCapture('fs_reformat()');
            await this.refreshFileList();
        } catch (error) {
            this.outputLine(`Reformat error: ${error.message}`);
        }
    }

    showHelp() {
        this.outputLine('');
        this.outputLine(' web-diii helpers:');
        this.outputLine(' h            show this help');
        this.outputLine(' u            open file picker (same as upload button)');
        this.outputLine(' Cmd/Ctrl+Shift+C  connect/disconnect');
        this.outputLine('');
        this.outputLine(' common iii commands:');
        this.outputLine(' ^^p          print active script');
        this.outputLine(' ^^c          clear active script');
        this.outputLine(' ^^r          reboot device');
        this.outputLine(' ^^b          reboot into bootloader mode');
        this.outputLine(' ^^g          print name of active script');
        this.outputLine('');
        this.outputHTML('Docs: <a href="https://monome.org/docs/iii/" target="_blank" rel="noopener noreferrer">monome.org/docs/iii</a>\n');
       
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DruidApp();
});
