/**
 * diii web app
 * Minimal serial REPL + script browser iii devices.
 */

class iiiConnection {
    constructor() {
        this.serialRequestFilters = [
            { usbVendorId: 0xCAFE, usbProductId: 0x1101 },
            { usbVendorId: 0xCAFE, usbProductId: 0x1110 }
        ];
        this.port = null;
        this.preferredPort = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        this.isSerialOscMode = false;
        this.lineBuffer = '';
        this.binaryBuffer = [];
        this.seriesTiltState = { x: 0, y: 0 };
        this.partialLineFlushTimer = null;
        this.partialLineFlushDelayMs = 40;
        this.onDataReceived = null;
        this.onConnectionChange = null;
        this._textEncoder = new TextEncoder();
        this._textDecoder = new TextDecoder();
    }

    async connect(port = null) {
        try {
            this.port = port || this.preferredPort;

            if (!this.port) {
                this.port = await navigator.serial.requestPort({
                    filters: this.serialRequestFilters
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
            this.isSerialOscMode = this.detectSerialOscMode(this.port);
            this.binaryBuffer = [];

            this.reader = this.port.readable.getReader();
            this.writer = this.port.writable.getWriter();

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

                if (this.isSerialOscMode) {
                    this.processSerialOscBytes(value);
                } else {
                    this.processTextBytes(value);
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
                this.writer.releaseLock?.();
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

        await this.writer.write(this._textEncoder.encode(payload));
    }

    async writeLine(line) {
        await this.write(`${line}\n`);
    }

    async writeBytes(bytes) {
        if (!this.isConnected || !this.writer) {
            throw new Error('Not connected');
        }

        let payload = bytes;
        if (!(payload instanceof Uint8Array)) {
            payload = new Uint8Array(payload);
        }

        await this.writer.write(payload);
    }

    async disconnect() {
        this.isConnected = false;
        this.clearPartialLineFlush();

        if (this.reader) {
            await this.reader.cancel().catch(() => {});
        }
        if (this.writer) {
            this.writer.releaseLock?.();
        }
        if (this.port) {
            await this.port.close().catch(() => {});
        }

        this.port = null;
        this.reader = null;
        this.writer = null;
        this.binaryBuffer = [];
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

    detectSerialOscMode(port) {
        try {
            const info = port?.getInfo?.();
            return Number(info?.usbVendorId) === 0xCAFE && Number(info?.usbProductId) === 0x1110;
        } catch {
            return false;
        }
    }

    processTextBytes(bytes) {
        const decoded = this._textDecoder.decode(bytes, { stream: true });
        if (!decoded) return;

        this.lineBuffer += decoded;

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

    processSerialOscBytes(bytes) {
        this.binaryBuffer.push(...bytes);

        let guard = 0;
        while (this.binaryBuffer.length > 0 && guard < 8192) {
            guard += 1;

            if (this.binaryBuffer.length >= 2) {
                const maybeSeriesEvent = this.tryParseSeriesEvent(this.binaryBuffer[0], this.binaryBuffer[1]);
                if (maybeSeriesEvent) {
                    this.binaryBuffer.splice(0, 2);
                    this.emitSerialEventLine(maybeSeriesEvent.event, maybeSeriesEvent.args);
                    continue;
                }
            }

            const mextSize = this.getMextIncomingSize(this.binaryBuffer[0]);
            if (mextSize != null) {
                if (this.binaryBuffer.length < mextSize) {
                    return;
                }

                const header = this.binaryBuffer[0];
                const addr = (header >> 4) & 0x0F;
                const cmd = header & 0x0F;
                const payload = this.binaryBuffer.slice(1, mextSize);
                this.binaryBuffer.splice(0, mextSize);

                const maybeMextEvent = this.parseMextIncomingEvent(addr, cmd, payload);
                if (maybeMextEvent) {
                    this.emitSerialEventLine(maybeMextEvent.event, maybeMextEvent.args);
                }
                continue;
            }

            this.binaryBuffer.shift();
        }
    }

    tryParseSeriesEvent(header, dataByte) {
        if (header === 0x00 || header === 0x10) {
            const x = (dataByte >> 4) & 0x0F;
            const y = dataByte & 0x0F;
            const z = header === 0x00 ? 1 : 0;
            return { event: 'key', args: [x, y, z] };
        }

        if (header === 0xD0) {
            this.seriesTiltState.x = dataByte;
            return { event: 'tilt', args: [0, this.seriesTiltState.x, this.seriesTiltState.y, 0] };
        }

        if (header === 0xD1) {
            this.seriesTiltState.y = dataByte;
            return { event: 'tilt', args: [0, this.seriesTiltState.x, this.seriesTiltState.y, 0] };
        }

        return null;
    }

    getMextIncomingSize(header) {
        const addr = (header >> 4) & 0x0F;
        const cmd = header & 0x0F;

        const lengths = {
            0: { 0: 2, 1: 32, 2: 3, 3: 2, 4: 2, 15: 8 },
            2: { 0: 2, 1: 2 },
            5: { 0: 2, 1: 1, 2: 1 },
            8: { 0: 1, 1: 7 }
        };

        const payloadLength = lengths[addr]?.[cmd];
        if (!Number.isFinite(payloadLength)) {
            return null;
        }

        return 1 + payloadLength;
    }

    parseMextIncomingEvent(addr, cmd, payload) {
        if (addr === 2 && (cmd === 0 || cmd === 1) && payload.length >= 2) {
            const z = cmd === 1 ? 1 : 0;
            return { event: 'key', args: [payload[0], payload[1], z] };
        }

        if (addr === 5 && cmd === 0 && payload.length >= 2) {
            const number = payload[0];
            const delta = payload[1] > 127 ? payload[1] - 256 : payload[1];
            return { event: 'enc', args: [number, delta] };
        }

        if (addr === 5 && (cmd === 1 || cmd === 2) && payload.length >= 1) {
            const number = payload[0];
            const z = cmd === 1 ? 1 : 0;
            return { event: 'enc_key', args: [number, z] };
        }

        if (addr === 8 && cmd === 1 && payload.length >= 7) {
            const number = payload[0];
            const x = this.readInt16LE(payload[1], payload[2]);
            const y = this.readInt16LE(payload[3], payload[4]);
            const z = this.readInt16LE(payload[5], payload[6]);
            return { event: 'tilt', args: [number, x, y, z] };
        }

        return null;
    }

    readInt16LE(low, high) {
        const unsigned = ((high & 0xFF) << 8) | (low & 0xFF);
        return unsigned > 0x7FFF ? unsigned - 0x10000 : unsigned;
    }

    emitSerialEventLine(eventName, args) {
        if (!this.onDataReceived) return;
        this.onDataReceived(`^^${eventName}(${args.join(', ')})`);
    }
}

class WsToSerialBridge {
    constructor(options = {}) {
        this.wsUrl = String(options.wsUrl || '').trim();
        this.handlePayload = options.handlePayload;
        this.decodePayload = options.decodePayload;
        this.encodeSerialEvent = options.encodeSerialEvent;
        this.writeLine = options.writeLine;
        this.isSerialConnected = options.isSerialConnected;
        this.onStatus = options.onStatus;
        this.reconnectDelayMs = Number(options.reconnectDelayMs) > 0 ? Number(options.reconnectDelayMs) : 2000;
        this.maxLinesPerMessage = Number(options.maxLinesPerMessage) > 0 ? Number(options.maxLinesPerMessage) : 128;

        this.socket = null;
        this.isRunning = false;
        this.reconnectTimer = null;
        this.messageChain = Promise.resolve();
        this.pendingEncoderDeltas = new Map();
        this.encoderFlushTimer = null;
        this.encoderFlushDelayMs = 8;
    }

    hasConfiguration() {
        return this.wsUrl.length > 0;
    }

    start() {
        if (!this.hasConfiguration() || this.isRunning) return false;
        this.isRunning = true;
        this.connectSocket();
        return true;
    }

    stop() {
        this.isRunning = false;
        this.clearReconnectTimer();
        this.clearEncoderFlushTimer();
        this.pendingEncoderDeltas.clear();

        const socket = this.socket;
        this.socket = null;
        if (!socket) return;

        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;

        try {
            socket.close();
        } catch {
            // ignore close errors
        }
    }

    connectSocket() {
        if (!this.isRunning || !this.hasConfiguration()) return;

        try {
            const socket = new WebSocket(this.wsUrl);
            socket.binaryType = 'arraybuffer';

            socket.onopen = () => {
                this.emitStatus(`ws bridge connected (${this.wsUrl})`);
            };

            socket.onmessage = (event) => {
                this.messageChain = this.messageChain
                    .then(() => this.handleMessage(event))
                    .catch((error) => {
                        this.emitStatus(`ws bridge message error: ${error.message}`);
                    });
            };

            socket.onerror = () => {
                this.emitStatus('ws bridge socket error');
            };

            socket.onclose = () => {
                if (!this.isRunning) return;
                this.emitStatus('ws bridge disconnected; retrying...');
                this.scheduleReconnect();
            };

            this.socket = socket;
        } catch (error) {
            this.emitStatus(`ws bridge failed to connect: ${error.message}`);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (!this.isRunning || this.reconnectTimer) return;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectSocket();
        }, this.reconnectDelayMs);
    }

    clearReconnectTimer() {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    clearEncoderFlushTimer() {
        if (!this.encoderFlushTimer) return;
        clearTimeout(this.encoderFlushTimer);
        this.encoderFlushTimer = null;
    }

    scheduleEncoderFlush() {
        if (this.encoderFlushTimer) return;

        this.encoderFlushTimer = setTimeout(() => {
            this.encoderFlushTimer = null;
            this.flushEncoderDeltas();
        }, this.encoderFlushDelayMs);
    }

    flushEncoderDeltas() {
        if (!this.isRunning || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.pendingEncoderDeltas.clear();
            return;
        }

        if (typeof this.encodeSerialEvent !== 'function') {
            this.pendingEncoderDeltas.clear();
            return;
        }

        for (const [ring, delta] of this.pendingEncoderDeltas.entries()) {
            if (!Number.isFinite(delta) || delta === 0) continue;

            const packet = this.encodeSerialEvent('enc', [ring, delta]);
            if (!(packet instanceof Uint8Array) || packet.length === 0) {
                continue;
            }

            try {
                this.socket.send(packet);
            } catch (error) {
                this.emitStatus(`ws bridge send error: ${error.message}`);
            }
        }

        this.pendingEncoderDeltas.clear();
    }

    queueEncoderDelta(args = []) {
        const [ringRaw, deltaRaw] = Array.isArray(args) ? args : [];
        const ring = Number.parseInt(String(ringRaw), 10);
        const delta = Number.parseInt(String(deltaRaw), 10);

        if (!Number.isFinite(ring) || !Number.isFinite(delta)) {
            return false;
        }

        const current = this.pendingEncoderDeltas.get(ring) || 0;
        this.pendingEncoderDeltas.set(ring, current + delta);
        this.scheduleEncoderFlush();
        return true;
    }

    async handleMessage(event) {
        if (!this.isRunning) return;
        if (typeof this.handlePayload === 'function') {
            const wasHandled = await this.handlePayload(event.data);
            if (wasHandled) {
                return;
            }
        }
        if (typeof this.decodePayload !== 'function') {
            throw new Error('decodePayload is not configured');
        }
        if (typeof this.writeLine !== 'function') {
            throw new Error('writeLine is not configured');
        }
        if (typeof this.isSerialConnected !== 'function' || !this.isSerialConnected()) {
            return;
        }

        const decoded = await this.decodePayload(event.data);
        if (!Array.isArray(decoded) || decoded.length === 0) {
            return;
        }

        const limited = decoded.slice(0, this.maxLinesPerMessage);
        for (const line of limited) {
            if (!this.isSerialConnected()) {
                break;
            }
            await this.writeLine(String(line));
        }
    }

    sendSerialEvent(eventName, args = []) {
        if (!this.isRunning || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }

        if (String(eventName) === 'enc') {
            return this.queueEncoderDelta(args);
        }

        if (typeof this.encodeSerialEvent !== 'function') {
            return false;
        }

        const packet = this.encodeSerialEvent(eventName, args);
        if (!(packet instanceof Uint8Array) || packet.length === 0) {
            return false;
        }

        try {
            this.socket.send(packet);
            return true;
        } catch (error) {
            this.emitStatus(`ws bridge send error: ${error.message}`);
            return false;
        }
    }

    emitStatus(message) {
        if (typeof this.onStatus === 'function') {
            this.onStatus(String(message));
        }
    }
}

class diiiApp {
    constructor() {
        this.iiiDevice = new iiiConnection();
        this.wsToSerialBridge = null;
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
        this.luaCaptureSeq = 0;
        this.reconnectAfterRestartTimer = null;
        this.fileEntries = [];
        this.firstBadgeFileNames = new Set();
        this.fileFreeSpaceBytes = null;
        this.openMenuFile = null;
        this.isExplorerCollapsed = true;
        this.fileRunQueue = Promise.resolve();
        this.pendingSuppressedOutputLines = [];
        this.lastUploadedScript = null;
        this.explorerWidthStorageKey = 'webdiii.explorerWidth';
        this.explorerWidthDefault = 280;
        this.explorerWidthMin = 220;
        this.explorerWidthMax = 520;
        this.isResizingExplorer = false;
        this.explorerResizePointerId = null;
        this.explorerResizeStartX = 0;
        this.explorerResizeStartWidth = this.explorerWidthDefault;
        this.isWsBridgeMenuOpen = false;

        this.cacheElements();
        this.bindEvents();
        this.restoreExplorerWidth();
        this.setExplorerCollapsed(true);
        this.checkBrowserSupport();
        this.setupWsBridge();
        this.renderFileList();

        this.outputLine('//// welcome. connect to an iii compatible grid or arc to begin.');
    }

    cacheElements() {
        this.elements = {
            scriptReferenceBtn: document.getElementById('scriptReferenceBtn'),
            wsBridgeSettingsBtn: document.getElementById('wsBridgeSettingsBtn'),
            wsBridgeMenu: document.getElementById('wsBridgeMenu'),
            wsBridgeSetUrlBtn: document.getElementById('wsBridgeSetUrlBtn'),
            wsBridgeDisableBtn: document.getElementById('wsBridgeDisableBtn'),

            splitContainer: document.getElementById('splitContainer'),
            fileExplorerPane: document.getElementById('fileExplorerPane'),
            explorerResizer: document.getElementById('explorerResizer'),
            fileList: document.getElementById('fileList'),
            fileSpaceFooter: document.getElementById('fileSpaceFooter'),
            toggleExplorerBtn: document.getElementById('toggleExplorerBtn'),
            refreshExplorerBtn: document.getElementById('refreshExplorerBtn'),
            explorerChevron: document.getElementById('explorerChevron'),

            connectionBtn: document.getElementById('replConnectionBtn'),
            replStatusPill: document.getElementById('replStatusPill'),
            replStatusIndicator: document.getElementById('replStatusIndicator'),
            replStatusText: document.getElementById('replStatusText'),

            output: document.getElementById('output'),
            replInput: document.getElementById('replInput'),
            replPane: document.getElementById('replPane'),
            uploadBtn: document.getElementById('uploadBtn'),
            restartBtn: document.getElementById('restartBtn'),
            bootloaderBtn: document.getElementById('bootloaderBtn'),
            reformatBtn: document.getElementById('reformatBtn'),
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
        on(this.elements.replStatusPill, 'click', () => this.toggleConnection());
        on(this.elements.replInput, 'keydown', (e) => this.handleReplInput(e));
        on(document, 'keydown', (e) => this.handleGlobalShortcuts(e));
        on(this.elements.toggleExplorerBtn, 'click', () => this.toggleExplorer());
        on(this.elements.refreshExplorerBtn, 'click', () => this.refreshFileList());
        on(this.elements.explorerResizer, 'pointerdown', (e) => this.startExplorerResize(e));
        on(this.elements.explorerResizer, 'keydown', (e) => this.handleExplorerResizerKeydown(e));
        on(this.elements.uploadBtn, 'click', () => this.openUploadPicker());
        on(this.elements.restartBtn, 'click', () => this.restartDevice());
        on(this.elements.bootloaderBtn, 'click', () => this.bootloaderDevice());
        on(this.elements.reformatBtn, 'click', () => this.reformatFs());
        on(this.elements.clearBtn, 'click', () => this.clearOutput());
        on(this.elements.fileInput, 'change', (e) => this.handleFileSelect(e));
        on(document, 'click', (e) => this.handleDocumentClick(e));

        on(this.elements.closeWarning, 'click', () => {
            this.elements.browserWarning.style.display = 'none';
        });

        on(this.elements.scriptReferenceBtn, 'click', () => {
            window.open('https://monome.org/docs/iii/code', '_blank');
        });
        on(this.elements.wsBridgeSettingsBtn, 'click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleWsBridgeMenu();
        });
        on(this.elements.wsBridgeMenu, 'click', (event) => event.stopPropagation());
        on(this.elements.wsBridgeSetUrlBtn, 'click', () => this.openWsBridgeUrlPrompt());
        on(this.elements.wsBridgeDisableBtn, 'click', () => this.disableWsBridgeFromMenu());

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

    setupWsBridge() {
        const wsUrl = this.resolveWsBridgeUrl();
        this.configureWsBridge(wsUrl, { announce: Boolean(wsUrl) });
    }

    configureWsBridge(wsUrl, { announce = true } = {}) {
        const normalized = String(wsUrl || '').trim();

        if (this.wsToSerialBridge) {
            this.wsToSerialBridge.stop();
            this.wsToSerialBridge = null;
        }

        if (!normalized) {
            if (announce) {
                this.outputLine('ws bridge disabled.');
            }
            return;
        }

        this.wsToSerialBridge = new WsToSerialBridge({
            wsUrl: normalized,
            handlePayload: (payload) => this.handleBridgeSerialOscPayload(payload),
            decodePayload: (payload) => this.decodeBridgePayloadViaWasm(payload),
            encodeSerialEvent: (eventName, args) => this.encodeSerialOscEventPacket(eventName, args),
            writeLine: (line) => this.iiiDevice.writeLine(line),
            isSerialConnected: () => this.iiiDevice.isConnected,
            onStatus: (message) => this.outputLine(message),
            reconnectDelayMs: 2000,
            maxLinesPerMessage: 128
        });

        if (announce) {
            this.outputLine(`ws bridge configured: ${normalized}`);
        }

        if (this.iiiDevice.isConnected) {
            this.wsToSerialBridge.start();
        }
    }

    persistWsBridgeUrl(value) {
        const normalized = String(value || '').trim();

        try {
            if (normalized) {
                window.localStorage.setItem('webdiii.wsBridgeUrl', normalized);
            } else {
                window.localStorage.removeItem('webdiii.wsBridgeUrl');
            }
        } catch {
            // ignore localStorage failures
        }

        return normalized;
    }

    openWsBridgeMenu() {
        const menu = this.elements.wsBridgeMenu;
        if (!menu) return;
        menu.classList.add('open');
        menu.setAttribute('aria-hidden', 'false');
        this.isWsBridgeMenuOpen = true;
    }

    closeWsBridgeMenu() {
        const menu = this.elements.wsBridgeMenu;
        if (!menu) return;
        menu.classList.remove('open');
        menu.setAttribute('aria-hidden', 'true');
        this.isWsBridgeMenuOpen = false;
    }

    toggleWsBridgeMenu() {
        if (this.isWsBridgeMenuOpen) {
            this.closeWsBridgeMenu();
            return;
        }
        this.openWsBridgeMenu();
    }

    openWsBridgeUrlPrompt() {
        const current = this.wsToSerialBridge?.wsUrl || this.resolveWsBridgeUrl() || '';
        const entered = window.prompt('Set websocket bridge URL (blank disables):', current);
        if (entered == null) {
            this.closeWsBridgeMenu();
            return;
        }

        const normalized = this.persistWsBridgeUrl(entered);
        this.configureWsBridge(normalized, { announce: true });
        this.closeWsBridgeMenu();
    }

    disableWsBridgeFromMenu() {
        this.persistWsBridgeUrl('');
        this.configureWsBridge('', { announce: true });
        this.closeWsBridgeMenu();
    }

    resolveWsBridgeUrl() {
        try {
            const fromQuery = new URLSearchParams(window.location.search).get('ws_bridge');
            if (fromQuery && fromQuery.trim()) {
                return fromQuery.trim();
            }
        } catch {
            // ignore query parsing failures
        }

        try {
            const fromStorage = window.localStorage.getItem('webdiii.wsBridgeUrl');
            if (fromStorage && fromStorage.trim()) {
                return fromStorage.trim();
            }
        } catch {
            // ignore localStorage access failures
        }

        const fromGlobal = window.WEB_DIII_WS_BRIDGE_URL;
        if (typeof fromGlobal === 'string' && fromGlobal.trim()) {
            return fromGlobal.trim();
        }

        return '';
    }

    async decodeBridgePayloadViaWasm(payload) {
        const bridge = window.WebDiiiWasmBridge;
        if (!bridge || typeof bridge.decodeWsToLines !== 'function') {
            return this.decodeBridgePayloadFallback(payload);
        }

        const decoded = await bridge.decodeWsToLines(payload);
        if (!Array.isArray(decoded)) {
            throw new Error('WASM bridge decoder must return string[]');
        }

        return decoded.map((line) => String(line));
    }

    async decodeBridgePayloadFallback(payload) {
        if (typeof payload === 'string') {
            return this.splitBridgeLines(payload);
        }

        const bytes = await this.getBridgePayloadBytes(payload);
        if (bytes) {
            const oscLines = this.decodeOscPacketToLines(bytes);
            if (oscLines.length > 0) {
                return oscLines;
            }

            return this.splitBridgeLines(new TextDecoder().decode(bytes));
        }

        return this.splitBridgeLines(String(payload ?? ''));
    }

    async getBridgePayloadBytes(payload) {
        if (payload instanceof Blob) {
            return new Uint8Array(await payload.arrayBuffer());
        }

        if (payload instanceof ArrayBuffer) {
            return new Uint8Array(payload);
        }

        if (ArrayBuffer.isView(payload)) {
            return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
        }

        return null;
    }

    async handleBridgeSerialOscPayload(payload) {
        if (!this.iiiDevice.isConnected || !this.iiiDevice.isSerialOscMode) {
            return false;
        }

        const bytes = await this.getBridgePayloadBytes(payload);
        if (!bytes || bytes.length === 0) {
            return false;
        }

        let packet;
        try {
            packet = this.readOscPacket(bytes, 0, bytes.length).packet;
        } catch {
            return false;
        }

        const ledPackets = this.oscPacketToSerialOscLedPackets(packet);
        if (ledPackets.length === 0) {
            return false;
        }

        for (const ledPacket of ledPackets) {
            await this.iiiDevice.writeBytes(ledPacket);
        }

        return true;
    }

    oscPacketToSerialOscLedPackets(packet) {
        if (!packet) return [];

        if (packet.type === 'bundle') {
            const packets = [];
            for (const child of packet.elements || []) {
                packets.push(...this.oscPacketToSerialOscLedPackets(child));
            }
            return packets;
        }

        if (packet.type !== 'message') {
            return [];
        }

        return this.oscMessageToSerialOscLedPackets(packet.address, packet.args);
    }

    oscMessageToSerialOscLedPackets(address, args) {
        const normalizedAddress = String(address || '');
        const values = (Array.isArray(args) ? args : []).map((value) => Number.parseInt(String(value), 10));

        const matchesPath = (suffix) => {
            if (normalizedAddress === suffix) {
                return true;
            }
            return normalizedAddress.endsWith(suffix) && normalizedAddress.charAt(normalizedAddress.length - suffix.length - 1) === '/';
        };

        if (matchesPath('/ring/set') && values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
            const ring = values[0] & 0xFF;
            const led = values[1] & 0xFF;
            const level = values[2] & 0x0F;
            return [this.encodeMextPacket(9, 0, [ring, led, level])];
        }

        if (matchesPath('/ring/all') && values.length >= 2 && values.slice(0, 2).every(Number.isFinite)) {
            const ring = values[0] & 0xFF;
            const level = values[1] & 0x0F;
            return [this.encodeMextPacket(9, 1, [ring, level])];
        }

        if (matchesPath('/ring/range') && values.length >= 4 && values.slice(0, 4).every(Number.isFinite)) {
            const ring = values[0] & 0xFF;
            const start = values[1] & 0xFF;
            const end = values[2] & 0xFF;
            const level = values[3] & 0x0F;
            return [this.encodeMextPacket(9, 3, [ring, start, end, level])];
        }

        if (matchesPath('/ring/intensity') && values.length >= 1 && Number.isFinite(values[0])) {
            const brightness = values[0] & 0x0F;
            return [this.encodeMextPacket(9, 4, [0, brightness])];
        }

        if (matchesPath('/ring/map') && values.length >= 65 && values.slice(0, 65).every(Number.isFinite)) {
            const ring = values[0] & 0xFF;
            const packedLevels = this.packRingMapLevels(values.slice(1, 65));
            return [this.encodeMextPacket(9, 2, [ring, ...packedLevels])];
        }

        if (matchesPath('/grid/led/set') && values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
            const x = values[0] & 0xFF;
            const y = values[1] & 0xFF;
            const on = values[2] ? 1 : 0;
            return [this.encodeMextPacket(1, on ? 1 : 0, [x, y])];
        }

        if (matchesPath('/grid/led/all') && values.length >= 1 && Number.isFinite(values[0])) {
            const on = values[0] ? 1 : 0;
            return [this.encodeMextPacket(1, on ? 3 : 2, [])];
        }

        if (matchesPath('/grid/led/intensity') && values.length >= 1 && Number.isFinite(values[0])) {
            const brightness = values[0] & 0x0F;
            return [this.encodeMextPacket(1, 7, [brightness])];
        }

        if (matchesPath('/grid/led/map') && values.length >= 10 && values.slice(0, 10).every(Number.isFinite)) {
            const xOff = values[0] & 0xFF;
            const yOff = values[1] & 0xFF;
            const frame = values.slice(2, 10).map((value) => value & 0xFF);
            return [this.encodeMextPacket(1, 4, [xOff, yOff, ...frame])];
        }

        if (matchesPath('/grid/led/row') && values.length >= 3 && values.every(Number.isFinite)) {
            const xOff = values[0] & 0xFF;
            const y = values[1] & 0xFF;
            const packets = [];
            for (let index = 2; index < values.length; index += 1) {
                const data = values[index] & 0xFF;
                packets.push(this.encodeMextPacket(1, 5, [xOff + ((index - 2) * 8), y, data]));
            }
            return packets;
        }

        if (matchesPath('/grid/led/col') && values.length >= 3 && values.every(Number.isFinite)) {
            const x = values[0] & 0xFF;
            const yOff = values[1] & 0xFF;
            const packets = [];
            for (let index = 2; index < values.length; index += 1) {
                const data = values[index] & 0xFF;
                packets.push(this.encodeMextPacket(1, 6, [x, yOff + ((index - 2) * 8), data]));
            }
            return packets;
        }

        return [];
    }

    parseReplOscCommand(line) {
        const normalized = String(line || '').trim();
        if (!normalized) {
            return { address: '', args: [] };
        }

        const parts = normalized.split(/\s+/).filter((part) => part.length > 0);
        const address = parts[0] || '';
        const args = parts.slice(1).map((token) => {
            const value = Number.parseInt(token, 10);
            if (!Number.isFinite(value)) {
                throw new Error(`invalid OSC integer argument: ${token}`);
            }
            return value;
        });

        return { address, args };
    }

    async sendSerialOscReplCommand(code) {
        const lines = String(code)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        if (lines.length === 0) {
            return true;
        }

        for (const line of lines) {
            if (!line.startsWith('/')) {
                throw new Error('serialosc REPL expects OSC paths, e.g. /ring/set 0 1 15');
            }

            const parsed = this.parseReplOscCommand(line);
            const packets = this.oscMessageToSerialOscLedPackets(parsed.address, parsed.args);
            if (!Array.isArray(packets) || packets.length === 0) {
                throw new Error(`unsupported OSC command: ${parsed.address}`);
            }

            for (const packet of packets) {
                await this.iiiDevice.writeBytes(packet);
            }
        }

        return true;
    }

    encodeMextPacket(addr, cmd, payloadBytes) {
        const payload = Array.isArray(payloadBytes) ? payloadBytes : [];
        const packet = new Uint8Array(1 + payload.length);
        packet[0] = ((addr & 0x0F) << 4) | (cmd & 0x0F);

        for (let index = 0; index < payload.length; index += 1) {
            packet[index + 1] = Number(payload[index]) & 0xFF;
        }

        return packet;
    }

    packRingMapLevels(levels) {
        const packed = new Uint8Array(32);

        for (let index = 0; index < 32; index += 1) {
            const left = Number(levels[index * 2] ?? 0) & 0x0F;
            const right = Number(levels[(index * 2) + 1] ?? 0) & 0x0F;
            packed[index] = (left << 4) | right;
        }

        return packed;
    }

    splitBridgeLines(text) {
        return String(text)
            .split('\n')
            .map((line) => line.replace(/\r/g, '').trim())
            .filter((line) => line.length > 0);
    }

    decodeOscPacketToLines(bytes) {
        try {
            const { packet } = this.readOscPacket(bytes, 0, bytes.length);
            return this.oscPacketToLines(packet);
        } catch {
            return [];
        }
    }

    oscPacketToLines(packet) {
        if (!packet) return [];

        if (packet.type === 'bundle') {
            const lines = [];
            for (const child of packet.elements) {
                lines.push(...this.oscPacketToLines(child));
            }
            return lines;
        }

        if (packet.type !== 'message') return [];
        return this.oscMessageToLines(packet.address, packet.args);
    }

    oscMessageToLines(address, args) {
        const normalizedAddress = String(address || '');
        const [firstArg] = Array.isArray(args) ? args : [];

        if (normalizedAddress === '/diii/line' || normalizedAddress === '/diii/cmd' || normalizedAddress === '/diii/repl') {
            if (firstArg == null) return [];
            return [String(firstArg)];
        }

        if (normalizedAddress === '/diii/lines') {
            if (firstArg == null) return [];

            if (firstArg instanceof Uint8Array) {
                return this.splitBridgeLines(new TextDecoder().decode(firstArg));
            }

            return this.splitBridgeLines(String(firstArg));
        }

        return [];
    }

    readOscPacket(bytes, offset, limit) {
        const first = this.readOscString(bytes, offset, limit);
        const head = first.value;

        if (head === '#bundle') {
            if (first.nextOffset + 8 > limit) {
                throw new Error('Invalid OSC bundle timetag');
            }

            let cursor = first.nextOffset + 8;
            const elements = [];

            while (cursor < limit) {
                const { value: elementSize, nextOffset } = this.readOscInt32(bytes, cursor, limit);
                cursor = nextOffset;

                if (elementSize < 0 || cursor + elementSize > limit) {
                    throw new Error('Invalid OSC bundle element size');
                }

                const elementLimit = cursor + elementSize;
                const parsed = this.readOscPacket(bytes, cursor, elementLimit);
                if (parsed.nextOffset !== elementLimit) {
                    throw new Error('Invalid OSC bundle element alignment');
                }

                elements.push(parsed.packet);
                cursor = elementLimit;
            }

            return {
                packet: { type: 'bundle', elements },
                nextOffset: cursor
            };
        }

        if (!head.startsWith('/')) {
            throw new Error('Invalid OSC address');
        }

        const tag = this.readOscString(bytes, first.nextOffset, limit);
        const typeTags = tag.value;
        if (!typeTags.startsWith(',')) {
            throw new Error('Invalid OSC type tags');
        }

        let cursor = tag.nextOffset;
        const args = [];

        for (const code of typeTags.slice(1)) {
            if (code === 'i') {
                const parsed = this.readOscInt32(bytes, cursor, limit);
                args.push(parsed.value);
                cursor = parsed.nextOffset;
                continue;
            }

            if (code === 'f') {
                const parsed = this.readOscFloat32(bytes, cursor, limit);
                args.push(parsed.value);
                cursor = parsed.nextOffset;
                continue;
            }

            if (code === 's') {
                const parsed = this.readOscString(bytes, cursor, limit);
                args.push(parsed.value);
                cursor = parsed.nextOffset;
                continue;
            }

            if (code === 'b') {
                const parsed = this.readOscBlob(bytes, cursor, limit);
                args.push(parsed.value);
                cursor = parsed.nextOffset;
                continue;
            }

            if (code === 'T') {
                args.push(true);
                continue;
            }

            if (code === 'F') {
                args.push(false);
                continue;
            }

            if (code === 'N') {
                args.push(null);
                continue;
            }

            throw new Error(`Unsupported OSC type: ${code}`);
        }

        return {
            packet: {
                type: 'message',
                address: head,
                args
            },
            nextOffset: cursor
        };
    }

    readOscInt32(bytes, offset, limit) {
        if (offset + 4 > limit) {
            throw new Error('OSC int32 out of bounds');
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
        const value = view.getInt32(0, false);
        return { value, nextOffset: offset + 4 };
    }

    readOscFloat32(bytes, offset, limit) {
        if (offset + 4 > limit) {
            throw new Error('OSC float32 out of bounds');
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
        const value = view.getFloat32(0, false);
        return { value, nextOffset: offset + 4 };
    }

    readOscString(bytes, offset, limit) {
        if (offset >= limit) {
            throw new Error('OSC string out of bounds');
        }

        let end = offset;
        while (end < limit && bytes[end] !== 0) {
            end += 1;
        }

        if (end >= limit) {
            throw new Error('OSC string missing terminator');
        }

        const value = new TextDecoder().decode(bytes.subarray(offset, end));
        let nextOffset = end + 1;
        while (nextOffset % 4 !== 0) {
            nextOffset += 1;
        }

        if (nextOffset > limit) {
            throw new Error('OSC string alignment out of bounds');
        }

        return { value, nextOffset };
    }

    readOscBlob(bytes, offset, limit) {
        const { value: size, nextOffset } = this.readOscInt32(bytes, offset, limit);
        if (size < 0 || nextOffset + size > limit) {
            throw new Error('OSC blob out of bounds');
        }

        const value = bytes.slice(nextOffset, nextOffset + size);
        let alignedOffset = nextOffset + size;
        while (alignedOffset % 4 !== 0) {
            alignedOffset += 1;
        }

        if (alignedOffset > limit) {
            throw new Error('OSC blob alignment out of bounds');
        }

        return { value, nextOffset: alignedOffset };
    }

    encodeSerialOscEventPacket(eventName, args = []) {
        const mapped = this.mapSerialEventToOscMessage(eventName, args);
        if (!mapped) {
            return null;
        }

        return this.encodeOscMessage(mapped.address, mapped.args);
    }

    mapSerialEventToOscMessage(eventName, args = []) {
        const event = String(eventName || '').trim();
        const rawArgs = Array.isArray(args) ? args : [];

        if (event === 'key') {
            const [x, y, z] = rawArgs.map((value) => Number.parseInt(String(value), 10));
            if (![x, y, z].every(Number.isFinite)) {
                return null;
            }

            return {
                address: '/grid/key',
                args: [
                    { type: 'i', value: x },
                    { type: 'i', value: y },
                    { type: 'i', value: z }
                ]
            };
        }

        if (event === 'enc') {
            const [ring, delta] = rawArgs.map((value) => Number.parseInt(String(value), 10));
            if (![ring, delta].every(Number.isFinite)) {
                return null;
            }

            return {
                address: '/enc/delta',
                args: [
                    { type: 'i', value: ring },
                    { type: 'i', value: delta }
                ]
            };
        }

        if (event === 'enc_key') {
            const [ring, z] = rawArgs.map((value) => Number.parseInt(String(value), 10));
            if (![ring, z].every(Number.isFinite)) {
                return null;
            }

            return {
                address: '/enc/key',
                args: [
                    { type: 'i', value: ring },
                    { type: 'i', value: z }
                ]
            };
        }

        if (event === 'tilt') {
            const [n, x, y, z] = rawArgs.map((value) => Number.parseInt(String(value), 10));
            if (![n, x, y, z].every(Number.isFinite)) {
                return null;
            }

            return {
                address: '/tilt',
                args: [
                    { type: 'i', value: n },
                    { type: 'i', value: x },
                    { type: 'i', value: y },
                    { type: 'i', value: z }
                ]
            };
        }

        return null;
    }

    encodeOscMessage(address, args = []) {
        if (!String(address || '').startsWith('/')) {
            return null;
        }

        const argList = Array.isArray(args) ? args : [];
        const tags = [','];
        const chunks = [
            this.encodeOscString(String(address))
        ];

        for (const arg of argList) {
            if (!arg || typeof arg !== 'object') {
                return null;
            }

            if (arg.type === 'i') {
                tags.push('i');
                chunks.push(this.encodeOscInt32(Number(arg.value) || 0));
                continue;
            }

            if (arg.type === 'f') {
                tags.push('f');
                chunks.push(this.encodeOscFloat32(Number(arg.value) || 0));
                continue;
            }

            if (arg.type === 's') {
                tags.push('s');
                chunks.push(this.encodeOscString(String(arg.value ?? '')));
                continue;
            }

            return null;
        }

        chunks.splice(1, 0, this.encodeOscString(tags.join('')));

        const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const output = new Uint8Array(totalSize);
        let offset = 0;

        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }

        return output;
    }

    encodeOscString(value) {
        const encoded = new TextEncoder().encode(String(value));
        const withTerminator = new Uint8Array(encoded.length + 1);
        withTerminator.set(encoded, 0);

        const paddedLength = Math.ceil(withTerminator.length / 4) * 4;
        const padded = new Uint8Array(paddedLength);
        padded.set(withTerminator, 0);
        return padded;
    }

    encodeOscInt32(value) {
        const output = new Uint8Array(4);
        const view = new DataView(output.buffer);
        view.setInt32(0, Number.parseInt(String(value), 10) || 0, false);
        return output;
    }

    encodeOscFloat32(value) {
        const output = new Uint8Array(4);
        const view = new DataView(output.buffer);
        view.setFloat32(0, Number(value) || 0, false);
        return output;
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
        if (this.elements.refreshExplorerBtn) {
            this.elements.refreshExplorerBtn.hidden = this.isExplorerCollapsed;
            this.elements.refreshExplorerBtn.setAttribute('aria-hidden', String(this.isExplorerCollapsed));
            this.elements.refreshExplorerBtn.tabIndex = this.isExplorerCollapsed ? -1 : 0;
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

    clearOutput() {
        if (this.elements.output) this.elements.output.textContent = '';
    }

    setReplControlsEnabled(enabled) {
        const isEnabled = Boolean(enabled);
        const controls = [
            this.elements.connectionBtn,
            this.elements.uploadBtn,
            this.elements.restartBtn,
            this.elements.bootloaderBtn,
            this.elements.reformatBtn,
            this.elements.clearBtn,
            this.elements.replInput
        ];

        for (const control of controls) {
            if (!control) continue;
            control.disabled = !isEnabled;
        }
    }

    setSerialOscUiMode(enabled) {
        document.body?.classList.toggle('serialosc-mode', Boolean(enabled));
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

        const noModifiers = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;

        if (noModifiers && event.key === 'ArrowUp') {
            event.preventDefault();
            this.navigateReplHistory('up');
            return;
        }

        if (noModifiers && event.key === 'ArrowDown') {
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

    resetReplInput() {
        this.elements.replInput.value = '';
        this.historyIndex = -1;
        this.currentInput = '';
    }

    async sendReplCommand(code) {
        this.outputLine(`>> ${code}`);
        const isHelpShortcut = /^h$/i.test(code.trim());
        const isUploadShortcut = /^u$/i.test(code.trim());
        const isReUploadShortcut = /^r$/i.test(code.trim());

        if (this.commandHistory.length === 0 || this.commandHistory[this.commandHistory.length - 1] !== code) {
            this.commandHistory.push(code);
        }

        if (isHelpShortcut) {
            this.showHelp();
            this.resetReplInput();
            return;
        }

        if (isUploadShortcut) {
            this.openUploadPicker();
            this.resetReplInput();
            return;
        }

        if (isReUploadShortcut) {
            await this.refreshUploadAndRunLastScript();
            this.resetReplInput();
            return;
        }

        if (!this.iiiDevice.isConnected) {
            this.outputLine('no iii device connected.');
            this.resetReplInput();
            return;
        }

        try {
            const fileSelectMatch = code.match(/^\^\^s\s+(.+)$/);
            if (fileSelectMatch) {
                await this.openAndSelectRemoteFile(fileSelectMatch[1].trim());
                this.resetReplInput();
                return;
            }

            if (this.iiiDevice.isSerialOscMode) {
                await this.sendSerialOscReplCommand(code);
                this.resetReplInput();
                return;
            }

            for (const line of code.split('\n')) {
                await this.iiiDevice.writeLine(line);
                await this.delay(1);
            }

            this.resetReplInput();
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
                const isSerialOscMode = this.iiiDevice.isSerialOscMode;
                if (!isSerialOscMode) {
                    this.setExplorerCollapsed(false);
                }
                const deviceType = isSerialOscMode ? null : await this.updateConnectedDeviceLabel();

                if (isSerialOscMode && this.elements.replStatusText) {
                    const serialOscLabel = this.getSerialOscStatusLabel();
                    this.elements.replStatusText.textContent = serialOscLabel;
                    this.outputLine('connected in serialosc mode, configure a websocket URL to send controls');
                }

                if (!isSerialOscMode) {
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
                }

                if (!auto && !isSerialOscMode) {
                    this.outputLine('Drag and drop a lua file here to auto-upload.');
                    this.outputLine('');
                }

                this.wsToSerialBridge?.start();

                if (!isSerialOscMode) {
                    await this.refreshFileList();
                } else {
                    this.fileEntries = [];
                    this.firstBadgeFileNames = new Set();
                    this.fileFreeSpaceBytes = null;
                    this.updateFileSpaceFooter(null);
                    this.renderFileList();
                }
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

        this.wsToSerialBridge?.stop();

        await this.iiiDevice.disconnect();
        this.refreshFileList();
        this.outputLine('');
        this.outputLine('disconnected');
        this.outputLine('');
        this.fileFreeSpaceBytes = null;
        this.fileEntries = [];
        this.updateFileSpaceFooter(null);
        this.renderFileList();
    }

    handleConnectionChange(connected, error, detail = null) {
        if (!this.elements.connectionBtn || !this.elements.replStatusIndicator || !this.elements.replStatusText) return;

        if (connected) {
            const isSerialOscMode = this.iiiDevice.isSerialOscMode;
            this.setSerialOscUiMode(isSerialOscMode);
            this.elements.connectionBtn.textContent = 'disconnect';
            this.elements.replStatusIndicator.classList.add('connected');
            this.elements.replStatusText.textContent = isSerialOscMode ? this.getSerialOscStatusLabel() : 'connected';
            if (this.elements.replInput) {
                this.elements.replInput.placeholder = isSerialOscMode
                    ? 'send osc commands live here'
                    : 'send iii commands live here';
            }
            this.setReplControlsEnabled(!isSerialOscMode);
            if (isSerialOscMode && this.elements.replInput) {
                this.elements.replInput.disabled = false;
            }
            if (isSerialOscMode && this.elements.clearBtn) {
                this.elements.clearBtn.disabled = false;
            }
            if (!isSerialOscMode) {
                this.elements.replInput?.focus();
            } else {
                this.elements.replInput?.focus();
            }
            this.hasConnectedThisSession = true;
            this.isManualDisconnect = false;
            return;
        }

        this.setSerialOscUiMode(false);
        this.setReplControlsEnabled(true);
        if (this.elements.replInput) {
            this.elements.replInput.placeholder = 'send iii commands live here';
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

    getSerialOscStatusLabel() {
        const info = this.getPortInfo(this.iiiDevice.port) || this.getPortInfo(this.selectedPort);
        const usbProductId = Number(info?.usbProductId);

        let deviceName = 'device';
        if (usbProductId === 0x1110) {
            deviceName = 'arc';
        }

        return `serialosc ${deviceName}`;
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
        const mappedOsc = this.mapSerialEventToOscMessage(event, args);
        const didSendOsc = this.wsToSerialBridge?.sendSerialEvent(event, args) || false;

        if (mappedOsc) {
            const isHighRateEvent = event === 'enc' || event === 'tilt';
            if (didSendOsc && isHighRateEvent) {
                return;
            }
            const oscArgString = mappedOsc.args.map((arg) => String(arg.value)).join(', ');
            const sendSuffix = didSendOsc ? '' : ' [not sent]';
            this.outputLine(`osc -> ${mappedOsc.address}(${oscArgString})${sendSuffix}`);
        }
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
        const lines = this.getUploadLines(text);

        await this.executeLuaCapture(`fs_remove_file(${this.luaQuote(fileName)})`);

        // Match diii upload protocol:
        // ^^s, <filename>, ^^f, ^^s, <file lines>, ^^w
        await this.openAndSelectRemoteFile(fileName);
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

    async uploadTextAsScript(name, text, options = {}) {
        const { refreshList = true } = options;

        if (!this.iiiDevice.isConnected) {
            this.outputLine('Error: Not connected to usb device (click connect in the header)');
            return;
        }

        try {
            this.outputLine(`Uploading ${name}...`);
            await this.sendScriptTextToiii(name, text);
            if (refreshList) {
                await this.refreshFileList();
            }
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}`);
        }
    }

    supportsFileSystemPicker() {
        return typeof window?.showOpenFilePicker === 'function';
    }

    async chooseLuaFileWithHandle() {
        if (!this.supportsFileSystemPicker()) {
            return null;
        }

        try {
            const handles = await window.showOpenFilePicker({
                multiple: false,
                excludeAcceptAllOption: true,
                types: [{
                    description: 'Lua scripts',
                    accept: {
                        'text/plain': ['.lua'],
                        'application/x-lua': ['.lua']
                    }
                }]
            });

            const handle = handles?.[0];
            if (!handle) return null;

            const file = await handle.getFile();
            return { file, handle };
        } catch (error) {
            if (error?.name === 'AbortError') {
                return null;
            }

            this.outputLine(`File picker error: ${error.message}`);
            return null;
        }
    }

    async openUploadPicker() {
        if (this.supportsFileSystemPicker()) {
            const picked = await this.chooseLuaFileWithHandle();
            if (!picked) return;
            await this.uploadSelectedFile(picked.file, { fileHandle: picked.handle });
            return;
        }

        if (!this.elements.fileInput) return;
        this.elements.fileInput.value = '';
        this.elements.fileInput.click();
    }

    cacheLastUploadedScript({ name, text, fileHandle = null }) {
        if (!name || typeof text !== 'string') return;
        this.lastUploadedScript = {
            name,
            text,
            fileHandle
        };
    }

    async uploadSelectedFile(file, options = {}) {
        if (!file) return false;

        if (!file.name.toLowerCase().endsWith('.lua')) {
            this.outputLine('Error: Only .lua files are supported');
            return false;
        }

        try {
            this.setExplorerCollapsed(false);
            const text = await file.text();
            await this.uploadTextAsScript(file.name, text);
            this.cacheLastUploadedScript({
                name: file.name,
                text,
                fileHandle: options.fileHandle || null
            });
            return true;
        } catch (error) {
            this.outputLine(`Upload error: ${error.message}`);
            return false;
        }
    }

    async getRefreshableLastScript() {
        // no previous upload case
        if (!this.lastUploadedScript) {
            this.outputLine('No previous upload found. Use u to pick a lua file first.');
            return null;
        }

        // previous upload exists
        if (this.lastUploadedScript.fileHandle) {
            try {
                const file = await this.lastUploadedScript.fileHandle.getFile();
                
                return {
                    name: file.name,
                    text: await file.text(),
                    fileHandle: this.lastUploadedScript.fileHandle
                };
            } catch (error) {
                this.outputLine(`Refresh error: ${error.message}`);
                return null;
            }
        }

        // this path is hit if browser doesn't support file system access API
        if (!this.supportsFileSystemPicker()) {
            this.openUploadPicker();
            return null;
        }

        // this path is hit if browser DOES support file system access API
        const picked = await this.chooseLuaFileWithHandle();
        if (!picked) return null;

        return {
            name: picked.file.name,
            text: await picked.file.text(),
            fileHandle: picked.handle
        };
    }

    async refreshUploadAndRunLastScript() {
        if (!this.iiiDevice.isConnected) {
            this.outputLine('no iii device connected.');
            return;
        }

        const script = await this.getRefreshableLastScript();
        if (!script) return;

        try {
            this.outputLine(`r: refreshing ${script.name}`);
            this.queueSuppressedOutputLine('-- re-init with no script', 8000);
            this.queueSuppressedOutputLine('-- init: skip script', 8000);
            this.queueSuppressedOutputLine('-- lua lib', 8000);
            await this.iiiDevice.writeLine('^^c');
            await this.delay(200);
            await this.uploadTextAsScript(script.name, script.text, { refreshList: false });
            this.cacheLastUploadedScript({
                name: script.name,
                text: script.text,
                fileHandle: script.fileHandle
            });
            await this.executeLua(`fs_run_file("lib.lua")`);
            await this.executeLua(`fs_run_file(${this.luaQuote(script.name)})`);
            this.refreshFileList().catch((error) => {
                this.outputLine(`File list error: ${error.message}`);
            });
        } catch (error) {
            this.outputLine(`r command error: ${error.message}`);
        }
    }

    async handleFileSelect(event) {
        const file = event.target?.files?.[0];
        if (!file) return;
        await this.uploadSelectedFile(file);
    }

    handleDocumentClick(event) {
        if (this.isWsBridgeMenuOpen) {
            const clickedSettingsButton = event.target?.closest('#wsBridgeSettingsBtn');
            const clickedMenu = event.target?.closest('#wsBridgeMenu');
            if (!clickedSettingsButton && !clickedMenu) {
                this.closeWsBridgeMenu();
            }
        }

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

        if (this.iiiDevice.isSerialOscMode) {
            const empty = document.createElement('div');
            empty.className = 'file-list-empty';
            empty.textContent = 'reconnect in iii mode to view files';
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
            const isInitLuaFile = entry.name === 'init.lua';

            if (!isLibFile && !isInitLuaFile) {
                const playBtn = document.createElement('button');
                playBtn.className = 'file-play-btn';
                playBtn.type = 'button';
                playBtn.textContent = '▶';
                playBtn.setAttribute('aria-label', `run ${entry.name}`);
                playBtn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    await this.enqueueRunFile(entry.name);
                });
                main.appendChild(playBtn);
            }

            const label = document.createElement('div');
            label.className = 'file-label';
            label.textContent = Number.isFinite(entry.size)
                ? `${entry.name} (${this.formatSizeKb(entry.size)})`
                : entry.name;

            main.appendChild(label);

            if (entry.name !== 'init.lua' && this.firstBadgeFileNames.has(entry.name)) {
                const firstBadge = document.createElement('span');
                firstBadge.className = 'file-first-pill';
                firstBadge.textContent = 'first';
                firstBadge.setAttribute('aria-label', `${entry.name} is configured in init.lua`);
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

            const actions = isInitLuaFile
                ? [
                    { label: 'read', fn: () => this.showFile(entry.name) },
                    { label: 'delete', fn: () => this.deleteFile(entry.name) }
                ]
                : isLibFile
                    ? [
                        { label: 'download', fn: () => this.downloadFile(entry.name) },
                        { label: 'read', fn: () => this.showFile(entry.name) }
                    ]
                    : [
                        { label: 'run', fn: () => this.enqueueRunFile(entry.name) },
                        { label: 'download', fn: () => this.downloadFile(entry.name) },
                        { label: 'first', fn: () => this.configureFirst(entry.name) },
                        { label: 'read', fn: () => this.showFile(entry.name) },
                        { label: 'delete', fn: () => this.deleteFile(entry.name) }
                    ];

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
            this.pendingLuaCapture = null;
            capture.resolve(capture.lines);
            return true;
        }

        if (!capture.started) return false;

        capture.lines.push(line);
        return true;
    }

    async executeLua(command) {
        if (!this.iiiDevice.isConnected) {
            throw new Error('Not connected to usb device');
        }

        await this.iiiDevice.writeLine(command);

        return true;
    }

    async executeLuaCapture(commands) {
        if (!this.iiiDevice.isConnected) {
            throw new Error('Not connected to usb device');
        }

        if (this.pendingLuaCapture) {
            throw new Error('Device is busy, please try again');
        }

        const captureId = ++this.luaCaptureSeq;
        const beginToken = `__webdiii_begin:${captureId}`;
        const endToken = `__webdiii_end:${captureId}`;

        const resultPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingLuaCapture = null;
                reject(new Error('Timed out waiting for device response'));
            }, 7000);

            this.pendingLuaCapture = {
                beginToken,
                endToken,
                started: false,
                lines: [],
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
            await this.iiiDevice.writeLine(`${line}`);
        }

        await this.iiiDevice.writeLine(`print(${this.luaQuote(endToken)})`);

        return resultPromise;
    }

    async refreshFileList() {
        if (!this.iiiDevice.isConnected) {
            this.fileEntries = [];
            this.firstBadgeFileNames = new Set();
            this.fileFreeSpaceBytes = null;
            this.updateFileSpaceFooter(null);
            this.renderFileList();
            return;
        }

        if (this.iiiDevice.isSerialOscMode) {
            this.fileEntries = [];
            this.firstBadgeFileNames = new Set();
            this.fileFreeSpaceBytes = null;
            this.updateFileSpaceFooter(null);
            this.renderFileList();
            return;
        }

        try {
            const lsLines = await this.executeLuaCapture(
                'for _, __name in ipairs(fs_list_files()) do local __size = fs_file_size(__name) or 0; print("__webdiii_file\\t" .. __name .. "\\t" .. tostring(__size)) end'
            );
            const memLines = await this.executeLuaCapture('print(fs_free_space())');

            const entries = this.parseFileEntriesFromLs(lsLines);
            this.fileFreeSpaceBytes = this.parseMemoryFooterFromMem(memLines);

            this.fileEntries = entries;

            try {
                await this.refreshFirstBadgeFileNames(entries);
            } catch {
                this.firstBadgeFileNames = new Set();
            }

            this.updateFileSpaceFooter(this.fileFreeSpaceBytes);
            this.renderFileList();
        } catch (error) {
            this.firstBadgeFileNames = new Set();
            this.fileFreeSpaceBytes = null;
            this.updateFileSpaceFooter(null);
            this.outputLine(`File list error: ${error.message}`);
        }
    }

    getFirstRunFileTargetFromInit(initContent) {
        const content = String(initContent || '');
        const withoutBlockComments = content.replace(/--\[\[[\s\S]*?\]\]/g, '');
        const withoutLineComments = withoutBlockComments.replace(/--.*$/gm, '');
        const match = withoutLineComments.match(/fs_run_file\s*\(\s*(['"])([^'"]+)\1\s*\)/);
        return match?.[2]?.trim() || '';
    }

    parseFileEntriesFromLs(lines) {
        const entries = [];
        const seenNames = new Set();

        for (const rawLine of lines) {
            const line = String(rawLine || '').trim();

            if (!line.startsWith('__webdiii_file\t')) continue;

            const parts = line.split('\t');
            if (parts.length < 3) continue;

            const name = String(parts[1] || '').trim();
            const isLua = name.toLowerCase().endsWith('.lua');
            const isInit = name === 'init';
            if (!isLua && !isInit) continue;
            if (seenNames.has(name)) continue;
            seenNames.add(name);

            const parsedSize = Number.parseInt(parts[2], 10);
            entries.push({
                name,
                size: Number.isFinite(parsedSize) ? parsedSize : null
            });
        }

        return entries;
    }

    parseMemoryFooterFromMem(lines) {
        const bytes = Number.parseInt(lines[0], 10);
        return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    }

    async refreshFirstBadgeFileNames(entries) {
        const hasInitLua = entries.some((entry) => entry.name === 'init.lua');
        if (!hasInitLua) {
            this.firstBadgeFileNames = new Set();
            return;
        }

        const initContent = await this.readRemoteFile('init.lua');
        const targetName = this.getFirstRunFileTargetFromInit(initContent);

        if (!targetName) {
            this.firstBadgeFileNames = new Set();
            return;
        }

        const hasMatchingFile = entries.some((entry) => entry.name === targetName);
        this.firstBadgeFileNames = hasMatchingFile
            ? new Set([targetName])
            : new Set();
    }

    async readRemoteFile(fileName) {
        const lines = await this.executeLuaCapture(`cat(${this.luaQuote(fileName)})`);
        return lines.join('\n');
    }

    async configureFirst(fileName) {
        try {
            await this.executeLuaCapture(`first(${this.luaQuote(fileName)})`);
            this.outputLine(`${fileName} will now run at at startup`);
            await this.refreshFileList();
        } catch (error) {
            this.outputLine(`First error: ${error.message}`);
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
            headerLine.textContent = `${fileName} contents:\n\n`;
            this.elements.output.appendChild(headerLine);

            const lines = await this.executeLuaCapture(`cat(${this.luaQuote(fileName)})`);
            for (const line of lines) {
                this.outputLine(line, { autoScroll: false });
            }

            this.outputText('\n', { autoScroll: false });

            this.elements.output.scrollTop = topSpacerLine.offsetTop;
        } catch (error) {
            this.outputLine(`Show error: ${error.message}`);
        }
    }

    async enqueueRunFile(fileName) {
        const task = async () => {
            await this.runFile(fileName);
        };

        this.fileRunQueue = this.fileRunQueue
            .catch(() => {})
            .then(task);

        return this.fileRunQueue;
    }

    async runFile(fileName) {
        this.queueSuppressedOutputLine('-- re-init with no script', 8000);
        this.queueSuppressedOutputLine('-- init: skip script', 8000);
        this.queueSuppressedOutputLine('-- lua lib', 8000);
        this.outputLine(`running ${fileName}...`);
        await this.iiiDevice.writeLine('^^c');
        await this.delay(500);
        await this.executeLua(`fs_run_file("lib.lua")`);
        await this.delay(500);
        await this.executeLua(`fs_run_file(${this.luaQuote(fileName)})`);
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
            await this.uploadSelectedFile(file);
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
            await this.executeLuaCapture('fs_reformat()');
            this.outputLine('Filesystem reformatted.');
            await this.refreshFileList();
        } catch (error) {
            this.outputLine(`Reformat error: ${error.message}`);
        }
    }

    showHelp() {
        this.outputLine('');
        this.outputLine(' diii helpers:');
        this.outputLine(' h            show this help');
        this.outputLine(' u            open file picker (same as upload button)');
        this.outputLine(' r            re-upload and run last uploaded script');
        this.outputLine(' Cmd/Ctrl+Shift+C  connect/disconnect');
        this.outputLine('');
        this.outputLine(' common iii commands:');
        this.outputLine(' ^^i          init');
        this.outputLine(' ^^c          clean init');
        this.outputLine(' help()       print iii api');
        this.outputLine('');
        this.outputHTML('Docs: <a href="https://monome.org/docs/iii/code" target="_blank" rel="noopener noreferrer">monome.org/docs/iii/code</a>\n');
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new diiiApp();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch((error) => {
            console.error('Service worker registration failed:', error);
        });
    }
});
