import { Conversation } from './elevenlabs-client.js';

let audioCtx = null;
let recordingCtx = null; // Store recording context globally
let nextStartTime = 0;
let micStream = null;
let micSource = null;
let processorNode = null;
let currentAgentLiveMessageEl = null;
let activeSources = [];

function base64ToPCM16(base64) {
    const raw = atob(base64);
    const buf = new ArrayBuffer(raw.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < raw.length; i++) {
        view[i] = raw.charCodeAt(i);
    }
    return new Int16Array(buf);
}

function pcm16ToFloat32(pcm16Array) {
    const float32 = new Float32Array(pcm16Array.length);
    for (let i = 0; i < pcm16Array.length; i++) {
        float32[i] = pcm16Array[i] / 32768;
    }
    return float32;
}

function playPCMChunk(base64Chunk) {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        nextStartTime = audioCtx.currentTime;
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    const pcm16 = base64ToPCM16(base64Chunk);
    const f32 = pcm16ToFloat32(pcm16);
    const buffer = audioCtx.createBuffer(1, f32.length, 24000);
    buffer.copyToChannel(f32, 0);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    const currentTime = audioCtx.currentTime;
    if (nextStartTime < currentTime) {
        nextStartTime = currentTime;
    }
    source.start(nextStartTime);
    
    activeSources.push(source);
    source.onended = () => {
        activeSources = activeSources.filter(s => s !== source);
    };
    
    nextStartTime += buffer.duration;
}

function stopAllPlayback() {
    activeSources.forEach(source => {
        try {
            source.stop();
        } catch (e) {}
    });
    activeSources = [];
    nextStartTime = audioCtx ? audioCtx.currentTime : 0;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function startMicRecording() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 24000 } });
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        recordingCtx = new AudioContextClass({ sampleRate: 24000 }); // Assign to global variable
        micSource = recordingCtx.createMediaStreamSource(micStream);
        
        // Fetch the absolute local extension URL for your registered audio worklet
        const workletUrl = chrome.runtime.getURL('raw-audio-processor.js');
        await recordingCtx.audioWorklet.addModule(workletUrl);
        
        // Instantiate modern AudioWorkletNode
        processorNode = new AudioWorkletNode(recordingCtx, 'rawAudioProcessor');
        
        // Configure formatting
        processorNode.port.postMessage({
            type: 'setFormat',
            format: 'pcm',
            sampleRate: 24000,
            chunkDurationMs: 100 // 100ms chunks provide smooth, low-latency buffering over socket transport
        });
        
        // Listen to formatted PCM16 messages from the worklet thread
        processorNode.port.onmessage = (e) => {
            if (!isConnected) return;
            const [encodedArray, maxVolume] = e.data;
            const base64Audio = arrayBufferToBase64(encodedArray.buffer);
            socket.emit('audio_chunk', { data: base64Audio });
        };
        
        micSource.connect(processorNode);
        processorNode.connect(recordingCtx.destination);
    } catch (err) {
        console.error("Mic recording failed with AudioWorkletNode:", err);
    }
}

function stopMicRecording() {
    if (processorNode) {
        processorNode.disconnect();
        processorNode = null;
    }
    if (micSource) {
        micSource.disconnect();
        micSource = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    // FIX: Close recordingCtx (microphone), keep audioCtx (playback) alive!
    if (recordingCtx) {
        recordingCtx.close().catch(() => {});
        recordingCtx = null;
    }
}

function renderLiveTranscriptDelta(role, text) {
    if (!currentAgentLiveMessageEl) {
        const color = role === 'Agent' ? '#00e5ff' : '#00ff41';
        const div = document.createElement('div');
        div.style.marginBottom = "10px";
        div.style.padding = "10px";
        div.style.background = "rgba(0,0,0,0.03)";
        div.style.borderLeft = `3px solid ${color}`;
        div.style.borderRadius = "6px";
        div.style.borderTop = "1px solid var(--border)";
        div.style.borderRight = "1px solid var(--border)";
        div.style.borderBottom = "1px solid var(--border)";
        div.innerHTML = `
            <button class="close-card-btn" style="position:relative; float:right; top:0; right:0; margin-left:8px; background:transparent; border:none; color:var(--text-mut); font-size:1.2rem; padding:0; height:auto; width:auto; box-shadow:none;" title="Dismiss Message">×</button>
            <strong style="color:${color}; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px;">${role}:</strong><br>
            <span class="live-text-content" style="font-size: 0.85rem; color: var(--text); line-height: 1.5;"></span>
        `;
        transcriptBox.appendChild(div);
        currentAgentLiveMessageEl = div.querySelector('.live-text-content');
    }
    currentAgentLiveMessageEl.innerText += text;
    
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    const workspace = document.querySelector('.app-workspace');
    if (workspace) {
        workspace.scrollTop = workspace.scrollHeight;
    }
}

if (typeof globalThis.process === 'undefined') {
    globalThis.process = { env: { NODE_ENV: 'production' } };
}

// Concurrency-throttled map helper
async function pAll(items, fn, limit = 2) {
    const results = [];
    for (let i = 0; i < items.length; i += limit) {
        const batch = items.slice(i, i + limit);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
    }
    return results;
}

window.activePeerConnections = new Set();
(() => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    if (!OriginalRTCPeerConnection) return;

    const trackPc = (pc) => {
        if (!pc || typeof pc.getStats !== 'function') return pc;
        window.activePeerConnections.add(pc);
        if (!pc.__lensdnaTrackedClose) {
            pc.__lensdnaTrackedClose = true;
            const originalClose = pc.close.bind(pc);
            pc.close = function(...args) {
                window.activePeerConnections.delete(pc);
                return originalClose(...args);
            };
        }
        return pc;
    };

    try {
        window.RTCPeerConnection = class LensDNAPeerConnection extends OriginalRTCPeerConnection {
            constructor(...args) {
                super(...args);
                trackPc(this);
            }
        };
        Object.getOwnPropertyNames(OriginalRTCPeerConnection).forEach((key) => {
            if (key === 'prototype' || key === 'name' || key === 'length') return;
            try {
                const desc = Object.getOwnPropertyDescriptor(OriginalRTCPeerConnection, key);
                if (desc) Object.defineProperty(window.RTCPeerConnection, key, desc);
            } catch (_) {}
        });
    } catch (_) {
        window.RTCPeerConnection = function(...args) {
            return trackPc(new OriginalRTCPeerConnection(...args));
        };
        window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
        Object.getOwnPropertyNames(OriginalRTCPeerConnection).forEach((key) => {
            if (key === 'prototype' || key === 'name' || key === 'length') return;
            try {
                window.RTCPeerConnection[key] = OriginalRTCPeerConnection[key];
            } catch (_) {}
        });
    }

    const originalGetStats = OriginalRTCPeerConnection.prototype.getStats;
    OriginalRTCPeerConnection.prototype.getStats = function(...args) {
        trackPc(this);
        return originalGetStats.apply(this, args);
    };
})();

const SERVER_URL = 'https://lensdj.app'; 

// --- TIMEOUT & CIRCUIT BREAKER UTILITIES ---
class CircuitBreaker {
    constructor(name, failureThreshold = 3, recoveryTime = 20000) {
        this.name = name;
        this.failureThreshold = failureThreshold;
        this.recoveryTime = recoveryTime;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF-OPEN
        this.failureCount = 0;
        this.nextAttempt = 0;
    }

    async execute(fn, fallbackValue = null) {
        if (this.state === 'OPEN') {
            if (Date.now() > this.nextAttempt) {
                this.state = 'HALF-OPEN';
                console.info(`[CIRCUIT BREAKER] ${this.name} entered HALF-OPEN state. Retrying...`);
            } else {
                console.warn(`[CIRCUIT BREAKER] Blocked execution. ${this.name} is OPEN.`);
                return fallbackValue || JSON.stringify({
                    status: "degraded",
                    tool: this.name,
                    message: "Circuit breaker active. Tool is temporarily offline."
                });
            }
        }

        try {
            const result = await fn();
            this.success();
            return result;
        } catch (err) {
            this.failure();
            console.error(`[CIRCUIT BREAKER] ${this.name} execution failed:`, err);
            return fallbackValue || `[Failure] ${this.name} execution failed: ${err.message}`;
        }
    }

    success() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }

    failure() {
        this.failureCount++;
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.recoveryTime;
            console.warn(`[CIRCUIT BREAKER] Tripped to OPEN state for: ${this.name}`);
        }
    }
}

// Instantiate distinct breakers to decouple faults
const peerBreaker = new CircuitBreaker('PeerConsultAgent', 3, 15000);
const visionBreaker = new CircuitBreaker('VisionAnalysis', 3, 15000);
const reasoningBreaker = new CircuitBreaker('DeepReasoning', 5, 10000);

// Fetch wrapper with explicit execution limits
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 12000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeout}ms`);
        }
        throw err;
    }
}

window.silentAIActive = false;
window.activeWebRTCAudios = [];

(function() {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (!desc || !desc.set) return;
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        get: function() {
            return desc.get.call(this);
        },
        set: function(stream) {
            desc.set.call(this, stream);
            if (this.tagName !== 'AUDIO' || !(stream instanceof MediaStream)) return;
            
            window.activeWebRTCAudios.push(new WeakRef(this));

            stream.getTracks().forEach(track => {
                track.addEventListener('ended', () => cleanupAudioRegistry());
            });

            if (window.silentAIActive) {
                this.volume = 0;
                this.muted = true;
            }
        }
    });
})();

function cleanupAudioRegistry() {
    window.activeWebRTCAudios = window.activeWebRTCAudios.filter(ref => {
        const el = ref.deref();
        if (!el) return false;
        const stream = el.srcObject;
        if (!stream || !(stream instanceof MediaStream)) return false;
        
        const alive = stream.getTracks().some(t => t.readyState === 'live');
        if (!alive) {
            try {
                el.srcObject = null;
            } catch(e) {}
            return false;
        }
        return true;
    });
}

// Clear disconnected refs periodically to prevent memory leak
setInterval(cleanupAudioRegistry, 15000);

const btnConnect = document.getElementById('btnConnect');
const btnExtractDom = document.getElementById('btnExtractDom');
const btnSnap = document.getElementById('btnSnap');
const btnCamera = document.getElementById('btnCamera');
const btnScreen = document.getElementById('btnScreen');
const visionContainer = document.getElementById('nexusVisionContainer');
const visionFeed = document.getElementById('nexusVisionFeed');
const mediaStatusText = document.getElementById('mediaStatusText');
const btnSilence = document.getElementById('btnSilence');
const transcriptBox = document.getElementById('transcript');
const columnLeft = document.querySelector('.column-left');
const btnToggleSettings = document.getElementById('btnToggleSettings');
const btnHideSettings = document.getElementById('btnHideSettings');

window.visionActive = false;
const orb = document.getElementById('voiceOrb');

const extElevenKeyInput = document.getElementById('extElevenKey');
const extGeminiKeyInput = document.getElementById('extGeminiKey');
const extFishKeyInput = document.getElementById('extFishKey');
const extGrokKeyInput = document.getElementById('extGrokKey');
const extMonidKeyInput = document.getElementById('extMonidKey');
const extVoiceIdInput = document.getElementById('extVoiceId');
const extLlmSelect = document.getElementById('extLlmSelect');

const extManualInject = document.getElementById('extManualInject');
const btnSendText = document.getElementById('btnSendText');

const extMemoryBox = document.getElementById('extMemoryBox');
const btnWipeMemory = document.getElementById('btnWipeMemory');

// HIPAA Elements
const chkEnterprisePlan = document.getElementById('chkEnterprisePlan');
const chkSignedBAA = document.getElementById('chkSignedBAA');
const chkZeroRetention = document.getElementById('chkZeroRetention');
const chkCustomLlmBaa = document.getElementById('chkCustomLlmBaa');

let audioConversation = null;
let socket = null;
let isConnected = false;
let lastMeasuredLatency = null;
let memoryPending = false;

window.currentTrackDuration = 20;
window.lastSongFileId = null;
window.lastPastedContext = "";

const dawBridge = new BroadcastChannel('lensdj_daw_bridge');

function appendTranscript(role, text, isHtml = false) {
    const div = document.createElement('div');
    
    if (isHtml) {
        div.style.cssText = "position:relative; margin-bottom:8px;";
        div.innerHTML = `
            <button class="close-card-btn" style="position:absolute; top:18px; right:12px; z-index:10; background:var(--panel); border:1px solid var(--border); color:var(--text); border-radius:50%; width:22px; height:22px; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 10px rgba(0,0,0,0.5);" title="Dismiss Card">×</button>
            ${text}
        `;
    } else {
        const color = role === 'Agent' ? '#00e5ff' : (role === 'User' ? '#00ff41' : '#888888');
        div.style.cssText = `margin-bottom:10px; padding:10px; background:rgba(0,0,0,0.03); border-left:3px solid ${color}; border-radius:6px; overflow:hidden; word-wrap:break-word; line-height:1.5; border:1px solid var(--border);`;
        
        let copyBtn = '';
        if (role === 'Agent' || role === 'System') {
            const safeText = encodeURIComponent(text);
            copyBtn = `
                <button class="copy-btn" data-text="${safeText}"
                        style="float:right; margin-left:8px; background:var(--panel); border:1px solid var(--border); color:var(--text); border-radius:4px; font-size:0.65rem; cursor:pointer; padding:2px 8px; transition:0.2s;" 
                        title="Copy to clipboard">
                    📋 Copy
                </button>`;
        }
        
        const textSpan = document.createElement('span');
        textSpan.style.cssText = "font-size: 0.85rem; color: var(--text);";
        textSpan.textContent = text;
        
        div.innerHTML = `
            <button class="close-card-btn" style="position:relative; float:right; top:0; right:0; margin-left:8px; background:transparent; border:none; color:var(--text-mut); font-size:1.2rem; padding:0; height:auto; width:auto; box-shadow:none;" title="Dismiss Message">×</button>
            ${copyBtn}
            <strong style="color:${color}; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px;">${role}:</strong><br>
        `;
        div.appendChild(textSpan);
    }

    transcriptBox.appendChild(div);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    
    const workspace = document.querySelector('.app-workspace');
    if (workspace) {
        workspace.scrollTop = workspace.scrollHeight;
    }
}

async function getSavedKey(key) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return new Promise((resolve) => {
            chrome.storage.local.get([key], (result) => {
                resolve(result[key] || '');
            });
        });
    }
    return localStorage.getItem(key) || '';
}

async function saveKey(key, value) {
    const isHipaaActive = await getSavedKey('extHipaaModeActive') === 'true';
    if (isHipaaActive && ['agentMemory', 'lastPastedContext', 'transcript'].includes(key)) {
        console.warn(`[HIPAA Gate] Local persistence write blocked for: ${key}`);
        return;
    }

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [key]: value });
    } else {
        localStorage.setItem(key, value);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const savedEleven = await getSavedKey('extElevenKey');
    const savedGemini = await getSavedKey('extGeminiKey');
    const savedFish = await getSavedKey('extFishKey');
    const savedGrok = await getSavedKey('extGrokKey');
    const savedMonid = await getSavedKey('extMonidKey');
    const savedVoice = await getSavedKey('extVoiceId');
    const savedLlm = await getSavedKey('extLlmSelect');
    const savedMemory = await getSavedKey('agentMemory');
    const settingsCollapsed = await getSavedKey('settingsCollapsed');
    const promoDismissed = await getSavedKey('geminiPromoDismissed');
    
    if (savedEleven) extElevenKeyInput.value = savedEleven;
    if (savedGemini) extGeminiKeyInput.value = savedGemini;
    if (savedFish) extFishKeyInput.value = savedFish;
    if (savedGrok && extGrokKeyInput) extGrokKeyInput.value = savedGrok;
    if (savedMonid && extMonidKeyInput) extMonidKeyInput.value = savedMonid;
    if (savedVoice) extVoiceIdInput.value = savedVoice;
    if (savedLlm) {
        extLlmSelect.value = savedLlm;
        const telemetryLlm = document.getElementById('telemetry-llm');
        if (telemetryLlm && extLlmSelect.selectedIndex >= 0) {
            telemetryLlm.innerText = extLlmSelect.options[extLlmSelect.selectedIndex].text;
        }
    }
    if (savedMemory && extMemoryBox) extMemoryBox.value = savedMemory;

    // Load HIPAA Configurations
    const savedEnterprise = await getSavedKey('chkEnterprisePlan');
    const savedBaa = await getSavedKey('chkSignedBAA');
    const savedZrm = await getSavedKey('chkZeroRetention');
    const savedCustomBaa = await getSavedKey('chkCustomLlmBaa');

    if (chkEnterprisePlan) chkEnterprisePlan.checked = savedEnterprise === 'true';
    if (chkSignedBAA) chkSignedBAA.checked = savedBaa === 'true';
    if (chkZeroRetention) chkZeroRetention.checked = savedZrm === 'true';
    if (chkCustomLlmBaa) chkCustomLlmBaa.checked = savedCustomBaa === 'true';

    // Bind change listeners to evaluate status
    const hipaaControls = [chkEnterprisePlan, chkSignedBAA, chkZeroRetention, chkCustomLlmBaa];
    hipaaControls.forEach(ctrl => {
        if (ctrl) {
            ctrl.addEventListener('change', async (e) => {
                await saveKey(e.target.id, e.target.checked ? 'true' : 'false');
                await updateHipaaStatus();
            });
        }
    });

    // Run initial rendering
    await updateHipaaStatus();

    if (promoDismissed === 'true') {
        const promoBox = document.getElementById('geminiPromoBox');
        if (promoBox) promoBox.style.display = 'none';
    }

    if (settingsCollapsed === 'true') {
        columnLeft.classList.add('collapsed');
    }
    
    const tempSlider = document.getElementById('tempSlider');
    const tempValDisplay = document.getElementById('tempValDisplay');
    if (tempSlider && tempValDisplay) {
        tempSlider.addEventListener('input', (e) => {
            tempValDisplay.innerText = e.target.value;
        });
    }

    const btnDismissGeminiPromo = document.getElementById('btnDismissGeminiPromo');
    const geminiPromoBox = document.getElementById('geminiPromoBox');
    if (btnDismissGeminiPromo && geminiPromoBox) {
        btnDismissGeminiPromo.addEventListener('click', () => {
            geminiPromoBox.style.display = 'none';
            saveKey('geminiPromoDismissed', 'true');
        });
    }
});

extElevenKeyInput.addEventListener('input', (e) => saveKey('extElevenKey', e.target.value.trim()));
extGeminiKeyInput.addEventListener('input', (e) => saveKey('extGeminiKey', e.target.value.trim()));

extFishKeyInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    saveKey('extFishKey', val);
    if (socket && socket.connected) {
        socket.emit('update_keyring', { fish_key: val });
    }
});

if (extGrokKeyInput) {
    extGrokKeyInput.addEventListener('input', (e) => saveKey('extGrokKey', e.target.value.trim()));
}

if (extMonidKeyInput) {
    extMonidKeyInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        saveKey('extMonidKey', val);
        if (socket && socket.connected) {
            socket.emit('update_keyring', { monid_key: val });
        }
    });
}

extVoiceIdInput.addEventListener('input', (e) => saveKey('extVoiceId', e.target.value.trim()));

extLlmSelect.addEventListener('change', async (e) => {
    saveKey('extLlmSelect', e.target.value);
    const telemetryLlm = document.getElementById('telemetry-llm');
    if (telemetryLlm) {
        telemetryLlm.innerText = e.target.options[e.target.selectedIndex].text;
    }
    await updateHipaaStatus();
});

if (extMemoryBox) {
    extMemoryBox.addEventListener('input', (e) => saveKey('agentMemory', e.target.value));
}

if (btnWipeMemory) {
    btnWipeMemory.addEventListener('click', () => {
        if (confirm("Are you sure you want to completely wipe the Persistent Memory layer? This cannot be undone.")) {
            saveKey('agentMemory', '');
            if (extMemoryBox) extMemoryBox.value = '';
            appendTranscript('System', '🧹 Persistent Memory layer completely wiped.');
        }
    });
}

async function captureActiveTabBase64() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url) {
        const url = activeTab.url.toLowerCase();
        if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:') || url.startsWith('chrome-extension://') || url.includes('chrome.google.com/webstore')) {
            throw new Error("Cannot snap browser system pages or blank tabs. Navigate to a standard website and try again.");
        }
    }
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
        return dataUrl.split(',')[1];
    } catch (err) {
        throw new Error("Screen capture restricted by Chrome permissions. Click the extension icon once to grant permission.");
    }
}

if (btnSilence) {
    btnSilence.addEventListener('click', (e) => {
        window.silentAIActive = !window.silentAIActive;
        const btn = e.currentTarget;
        if (window.silentAIActive) {
            btn.style.color = 'var(--alert)';
            btn.style.borderColor = 'var(--alert)';
            btn.style.background = 'rgba(255,59,48,0.1)';
            btn.innerHTML = '🔇';
            appendTranscript('System', 'Silent Mode ON. Voice output muted.');
        } else {
            btn.style.color = 'var(--cyan)';
            btn.style.borderColor = 'var(--cyan)';
            btn.style.background = 'rgba(0,229,255,0.1)';
            btn.innerHTML = '🔊';
            appendTranscript('System', 'Silent Mode OFF. Voice output restored.');
        }
        window.activeWebRTCAudios.forEach(ref => {
            const el = ref.deref();
            if (!el) return;
            try {
                el.volume = window.silentAIActive ? 0 : 1;
                el.muted = window.silentAIActive;
            } catch (err) {}
        });
        cleanupAudioRegistry();
    });
}

btnConnect.addEventListener('click', async () => {
    if (btnConnect.innerText === "CONNECTING...") return; 

    if (isConnected) {
        if (audioConversation) {
            try { await audioConversation.endSession(); } catch(e) {}
            audioConversation = null;
        }
        stopMicRecording();
        isConnected = false;
        btnConnect.innerText = "INITIATE UPLINK";
        btnConnect.style.background = "rgba(0,229,255,0.1)";
        btnConnect.style.color = "var(--cyan)";
        orb.style.boxShadow = "0 0 20px var(--cyan)";
        orb.style.background = "radial-gradient(circle, var(--cyan), transparent)";
        cleanupAudioRegistry();
        appendTranscript('System', 'Uplink severed manually. Background socket remains active.');
        return;
    }

    const elKey = extElevenKeyInput.value.trim();
    const grokKey = extGrokKeyInput.value.trim();
    const gKey = extGeminiKeyInput.value.trim();

    if (!elKey && !grokKey && !gKey) {
        return alert("API Key required. Please configure an ElevenLabs Key, Grok Key, or Gemini Key in the settings (⚙️ CONFIG).");
    }

    const isHipaaActive = await getSavedKey('extHipaaModeActive') === 'true';
    if (isHipaaActive && extLlmSelect) {
        const val = extLlmSelect.value;
        const preconfiguredHipaaList = [
            'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
            'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro',
            'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-haiku-4-5',
            'qwen36-35b-a3b', 'qwen35-397b-a17b'
        ];
        const isCustomModel = !preconfiguredHipaaList.includes(val);
        if (isCustomModel && chkCustomLlmBaa && !chkCustomLlmBaa.checked) {
            alert("Uplink Gated: You must acknowledge that your Custom LLM provider is under a signed BAA and Zero-Retention agreement active before initiating PHI workflows.");
            btnConnect.innerText = "INITIATE UPLINK";
            return;
        }
    }

    btnConnect.innerText = "CONNECTING...";

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
    } catch (micErr) {
        appendTranscript('Error', "Microphone access was denied. Ensure the Microphone permission toggle is enabled.");
        btnConnect.innerText = "INITIATE UPLINK";
        return; 
    }

    appendTranscript('System', 'Negotiating secure socket connection with LensDNA Server...');

    const isPureGrok = !elKey && !!grokKey;
    const activeDomain = isPureGrok ? 'browser' : 'nexus_omni';

    const queryParams = new URLSearchParams({
        clearance: 'coDe7777',
        sovereign_key: grokKey || gKey || 'nexus_bypass',
        elevenlabs_key: elKey,
        fish_key: extFishKeyInput.value.trim() || '',
        domain: activeDomain,
        provider: elKey ? 'elevenlabs_agent' : (grokKey ? 'grok' : 'gemini'),
        voice_id: extVoiceIdInput.value.trim() || '',
        use_context: isPureGrok ? 'true' : 'false'
    }).toString();

    if (!socket || socket.disconnected) {
        socket = io(`${SERVER_URL}/live?${queryParams}`, { transports: ['websocket'] });

        socket.on('new_generative_stem', (data) => {
            if (data.file_id) {
                window.lastSongFileId = data.file_id;
            }
            
            if (data.channel_id) {
                const chAudio = document.getElementById(`ch${data.channel_id}-audio`);
                if (chAudio) {
                    chAudio.src = `${SERVER_URL}/fetch-audio/${data.file_id}`;
                    chAudio.load();
                }
            }

            const pendingStatus = document.querySelectorAll('.synth-status');
            pendingStatus.forEach(el => {
                el.innerHTML = "✅ SYNTHESIS COMPLETE";
                el.style.color = "var(--neon)";
                el.style.animation = "none";
                el.classList.remove('synth-status');
                
                const faderKnob = el.parentElement.querySelector('div[style*="autoMix"]');
                if (faderKnob) {
                    faderKnob.style.animation = "none";
                    faderKnob.style.left = "85%";
                    faderKnob.style.borderColor = "var(--neon)";
                    faderKnob.style.boxShadow = "0 0 10px var(--neon)";
                }
            });
            
            const cardHtml = `
                <div style="border: 1px solid #b000ff; border-radius: 8px; overflow: hidden; box-shadow: 0 0 15px rgba(176,0,255,0.2); background: rgba(176,0,255,0.05); padding: 15px; margin-top: 10px; box-sizing: border-box;">
                    <div style="font-family: 'Share Tech Mono', monospace; font-size: 0.75rem; color: #b000ff; margin-bottom: 8px; text-transform: uppercase;">🎵 GENERATED COMPOSITION READY</div>
                    <div style="font-size: 0.95rem; font-weight: bold; margin-bottom: 4px;">${data.track_title || 'Sovereign_Stem'}</div>
                    <p style="font-size: 0.75rem; color: #888; margin-bottom: 12px; line-height: 1.3;">
                        <strong>Description:</strong> ${data.description || 'None'}<br>
                        <strong>Tempo:</strong> ${data.bpm || 138} BPM | <strong>Duration:</strong> ${data.duration || 25}s
                    </p>
                    <audio id="audio-${data.file_id}" controls style="width: 100%; border-radius: 8px; outline: none; margin-top: 5px;">
                        <source src="${SERVER_URL}/fetch-audio/${data.file_id}">
                    </audio>
                    <div id="lyrics-${data.file_id}" style="margin-top: 10px; font-size: 0.85rem; color: var(--text-mut); line-height: 1.4; text-align: center; min-height: 20px; font-family: 'Share Tech Mono', monospace; font-weight: bold;"></div>
                </div>
            `;
            appendTranscript('System', cardHtml, true);
            
            if (data.alignment) {
                setTimeout(() => {
                    const audioEl = document.getElementById(`audio-${data.file_id}`);
                    const lyricsDiv = document.getElementById(`lyrics-${data.file_id}`);
                    if (audioEl && lyricsDiv) {
                        const chars = data.alignment.characters;
                        const starts = data.alignment.character_start_times_seconds;
                        const ends = data.alignment.character_end_times_seconds;
                        
                        audioEl.addEventListener('timeupdate', () => {
                            const cur = audioEl.currentTime;
                            let htmlStr = "";
                            for (let i = 0; i < chars.length; i++) {
                                if (cur >= starts[i] && cur <= ends[i]) {
                                    htmlStr += `<span style="color: var(--neon); text-shadow: 0 0 8px var(--neon);">${chars[i]}</span>`;
                                } else if (cur > ends[i]) {
                                    htmlStr += `<span style="color: var(--text-main); opacity: 0.8;">${chars[i]}</span>`;
                                } else {
                                    htmlStr += `<span style="color: var(--text-mut); opacity: 0.4;">${chars[i]}</span>`;
                                }
                            }
                            lyricsDiv.innerHTML = htmlStr;
                        });
                    }
                }, 500);
            }
        });

        socket.on('message', (data) => {
            if (data.type === 'sys-alert') appendTranscript('System', data.text);
            if (data.type === 'response.done' || data.serverContent?.turnComplete || data.type === 'response.complete') {
                currentAgentLiveMessageEl = null;
            }
            if (data.type === 'input_audio_buffer.speech_started') {
                stopAllPlayback();
                currentAgentLiveMessageEl = null;
            }
            if (data.type === 'response.output_audio.delta' && data.delta) {
                playPCMChunk(data.delta);
            }
            if ((data.type === 'response.audio_transcript.delta' || data.type === 'response.output_audio_transcript.delta') && data.delta) {
                renderLiveTranscriptDelta('Agent', data.delta);
            }
            if (data.serverContent?.modelTurn?.parts) {
                data.serverContent.modelTurn.parts.forEach(part => {
                    if (part.text) {
                        renderLiveTranscriptDelta('Agent', part.text);
                    }
                });
            }
        });

        let currentAgentMessageEl = null;
        socket.on('agent_transcript_delta', (data) => {
            if (!currentAgentMessageEl) {
                const div = document.createElement('div');
                div.style.marginBottom = "10px";
                div.style.padding = "10px";
                div.style.background = "rgba(0,0,0,0.03)";
                div.style.borderLeft = "3px solid #00e5ff";
                div.style.borderRadius = "6px";
                div.style.borderTop = "1px solid var(--border)";
                div.style.borderRight = "1px solid var(--border)";
                div.style.borderBottom = "1px solid var(--border)";
                div.innerHTML = `
                    <strong style="color:#00e5ff; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px;">Agent:</strong><br>
                    <span class="agent-text-content" style="font-size: 0.85rem; color: var(--text); line-height: 1.5;"></span>
                `;
                transcriptBox.appendChild(div);
                currentAgentMessageEl = div.querySelector('.agent-text-content');
            }
            currentAgentMessageEl.innerText += data.text;
            transcriptBox.scrollTop = transcriptBox.scrollHeight;
            const _nexusWorkspace = document.querySelector('.app-workspace');
            if (_nexusWorkspace) _nexusWorkspace.scrollTop = _nexusWorkspace.scrollHeight;
        });

        socket.on('agent_transcript', (data) => {
            appendTranscript(data.role, data.text);
        });

        socket.on('rpa_command', async (data) => {
            appendTranscript('System', `RPA Action Executing: ${data.tool}`);
            try {
                if (data.tool === 'open_url_in_tab') {
                    if (data.args.new_tab) {
                        chrome.tabs.create({ url: data.args.url, active: false });
                    } else {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        chrome.tabs.update(tab.id, { url: data.args.url });
                    }
                } else if (data.tool === 'type_text_in_active_page') {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    await chrome.tabs.sendMessage(tab.id, { 
                        action: 'TYPE_TEXT', 
                        data: {
                            selector: data.args.selector || null,
                            text: data.args.text
                        } 
                    });
                } else {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    const action = data.tool === 'scroll_active_page' ? 'SCROLL_PAGE' : 'CLICK_ELEMENT';
                    await chrome.tabs.sendMessage(tab.id, { action: action, data: data.args });
                }
            } catch (err) {
                console.error("RPA Execution failed:", err);
            }
        });
    }

    if (!elKey) {
        isConnected = true;
        btnConnect.innerText = "DISCONNECT (LIVE)";
        btnConnect.style.background = "var(--neon)";
        btnConnect.style.color = "#000";
        orb.style.boxShadow = "0 0 20px rgba(0, 255, 65, 0.5)";
        orb.style.background = "radial-gradient(circle, rgba(0, 255, 65, 0.8), transparent)";
        
        const mixerPanel = document.getElementById('dj-matrix-panel');
        const dialerPanel = document.getElementById('dialer-panel');
        if (mixerPanel) mixerPanel.style.display = 'none';
        if (dialerPanel) dialerPanel.style.display = 'none';

        if (grokKey) {
            appendTranscript('System', 'Grok Core online — Sovereign Browser Co-Pilot active. I can see your current page (DOM + vision). Music/mixer persona is disabled in this mode.');
            startMicRecording();

            setTimeout(async () => {
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
                        const ctxMsg = `[SYSTEM MEMORY] User is currently viewing: "${tab.title || 'Untitled'}" (${tab.url}). Focus on this page. Use DOM tools and vision when helpful. Do not talk about music, stems, channels, or DJ production unless the user explicitly asks.`;
                        window.lastPastedContext = ctxMsg;
                        if (socket && socket.connected) {
                            socket.emit('user_message', { text: ctxMsg });
                        }
                    }
                } catch (e) {}
            }, 1200);
        } else {
            appendTranscript('System', 'Sovereign Uplink established using local Keyring (Gemini Core). Conversational audio stream decoupled; real-time text + tool orchestration is active.');
        }
        return;
    }

    try {
        const llmVal = extLlmSelect.value || 'gemini-2.5-flash';
        const memoryVal = await getSavedKey('agentMemory') || '';
        const req = await fetch(`${SERVER_URL}/api/get-signed-url?agent_id=nexus_omni&elevenlabs_key=${elKey}&environment=chrome_extension&llm=${encodeURIComponent(llmVal)}&user_memory=${encodeURIComponent(memoryVal)}`);
        const tokenData = await req.json();

        if (tokenData.error) {
            throw new Error(tokenData.error);
        }

        audioConversation = await Conversation.startSession({
            signedUrl: tokenData.signed_url,
            workletPaths: {
                rawAudioProcessor: 'raw-audio-processor.js',
                audioConcatProcessor: 'audio-concat-processor.js'
            },
            clientTools: {
                hunt_reddit_leads: async (params = {}) => {
                    return await window.executeRedditLeadHunter(params);
                },
                oauth_keyring_handoff: async (params) => {
                    if (params.provider === 'fish' && extFishKeyInput.value) {
                         socket?.emit('update_keyring', { fish_key: extFishKeyInput.value.trim() });
                    }
                    appendTranscript('System', `🔑 Initiating OAuth handoff for provider: ${params.provider}...`);
                    try {
                        const redirectUrl = chrome.identity.getRedirectURL();
                        return `OAuth handoff initialized for ${params.provider}. Callback URI is ${redirectUrl}. Sovereign Keyring stands by for secure token storage.`;
                    } catch (err) {
                        return `OAuth handoff failed: ${err.message}`;
                    }
                },
                consult_peer_agent: async (params) => {
                    let target = params.target_agent ? params.target_agent.toLowerCase().trim() : "";
                    if (target === "cipher" || target === "developer" || target === "engineer") {
                        target = "premium_dev_engineer";
                    } else if (target === "vance" || target === "director") {
                        target = "premium_director";
                    } else if (target === "kira" || target === "ethereal") {
                        target = "premium_ethereal";
                    } else if (target === "kastro" || target === "phonk") {
                        target = "premium_phonk";
                    } else if (target === "nova" || target === "architect" || target === "omni") {
                        target = "premium_omni_flow";
                    } else if (target === "apex" || target === "banger" || target === "hitmaker") {
                        target = "premium_banger";
                    } else if (target === "valor") {
                        target = "premium_valor";
                    } else {
                        target = params.target_agent || "peer_agent";
                    }

                    appendTranscript('System', `⚡ Neural Pipeline: Routing query to ${target}...`);

                    const gKey = extGeminiKeyInput ? extGeminiKeyInput.value.trim() : '';
                    const grokKey = extGrokKeyInput ? extGrokKeyInput.value.trim() : '';
                    const elKey = extElevenKeyInput ? extElevenKeyInput.value.trim() : '';
                    const fishKey = extFishKeyInput ? extFishKeyInput.value.trim() : '';

                    try {
                        const result = await peerBreaker.execute(async () => {
                            const resp = await fetchWithTimeout(`${SERVER_URL}/api/consult-peer`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ 
                                    target_agent: target,
                                    query: params.query,
                                    context: (window.lastPastedContext || "").slice(0, 15000),
                                    gemini_key: gKey,
                                    grok_key: grokKey,
                                    elevenlabs_key: elKey,
                                    fish_key: fishKey
                                }),
                                timeout: 14000
                            });
                            const data = await resp.json();
                            if (data.response) {
                                appendTranscript('System', `✅ Neural link response received from ${target}.`);
                                return data.response;
                            }
                            throw new Error(data.error || 'Server rejected peer consultation');
                        }, `[Peer Consult Degraded]: Consultation with ${target} timed out or failed. Answer using your own reasoning.`);

                        return result;
                    } catch (err) {
                        appendTranscript('System', `⚠️ Neural link to ${target} timed out/failed. Proceeding with primary agent.`);
                        return `[Peer Consult Unavailable]: Consultation with ${target} did not complete in time. Answer using your own reasoning.`;
                    }
                },
                read_active_tab_data: async (params) => {
                    const deepScan = params && params.deep_scan === true;
                    appendTranscript('System', `⚡ Instantly extracting active tab URL and DOM content${deepScan ? ' (Deep Scan Active)' : ''}...`);
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (!tab || !tab.id) return "Cannot determine active tab.";
                        
                        const results = await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            args: [deepScan],
                            func: (isDeep) => {
                                const description = document.querySelector('meta[name="description"]')?.content || "None";
                                let text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 6000); 
                                
                                if (isDeep) {
                                    const interactiveElements = Array.from(document.querySelectorAll(
                                        '[role="combobox"], [role="listbox"], [role="switch"], [role="option"], select, [aria-labelledby], [aria-label], [aria-valuetext], [data-state]'
                                    ));
                                    
                                    const interactiveContexts = [];
                                    interactiveElements.forEach(el => {
                                        const role = el.getAttribute('role') || el.tagName.toLowerCase();
                                        const label = el.getAttribute('aria-label') || el.innerText?.slice(0, 60).trim() || '';
                                        const valueText = el.getAttribute('aria-valuetext') || el.getAttribute('data-state') || '';
                                        const isSelected = el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'checked' || el.selected;
                                        
                                        if (role === 'combobox' || role === 'listbox' || role === 'select' || isSelected || valueText) {
                                            interactiveContexts.push({
                                                element: role,
                                                label: label,
                                                value: valueText || el.value || '',
                                                status: isSelected ? 'selected/active' : 'inactive'
                                            });
                                        }
                                    });
                                    
                                    if (interactiveContexts.length > 0) {
                                        text += `\n\n[DEEP SCAN INTERACTIVE COMPONENT METADATA]:\n` + JSON.stringify(interactiveContexts, null, 2);
                                    }
                                }
                                return { description, text };
                            }
                        });
                        
                        const pageData = results[0].result;
                        const contextPayload = `[ACTIVE TAB INFO]\nURL: ${tab.url}\nTITLE: ${tab.title}\nDESCRIPTION: ${pageData.description}\nCONTENT: ${pageData.text}`;
                        
                        appendTranscript('System', `✅ Tab data loaded: ${tab.title.substring(0, 30)}...`);
                        return contextPayload;
                    } catch (err) {
                        return `Failed to read active tab DOM: ${err.message}. Ensure permissions are granted.`;
                    }
                },
                type_text_in_active_page: async (params) => {
                    appendTranscript('System', `Typing into active page: "${params.text}"...`);
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        const response = await chrome.tabs.sendMessage(tab.id, { 
                            action: 'TYPE_TEXT', 
                            data: {
                                selector: params.selector || null,
                                text: params.text
                            } 
                        });
                        return `Successfully typed text into active browser tab. Page status: ${response ? response.status : 'OK'}`;
                    } catch (err) {
                        return `Failed to type text inside active page: ${err.message}. Instruct the user to grant page permissions.`;
                    }
                },
                open_url_in_tab: async (params) => {
                    appendTranscript('System', `RPA Action: Opening URL -> ${params.url}...`);
                    try {
                        if (params.new_tab) {
                            await chrome.tabs.create({ url: params.url, active: false });
                            return `Successfully opened ${params.url} in a new tab.`;
                        } else {
                            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                            await chrome.tabs.update(tab.id, { url: params.url });
                            return `Successfully navigated the current tab to ${params.url}.`;
                        }
                    } catch (err) {
                        return `Failed to open URL: ${err.message}`;
                    }
                },
                click_element_in_active_page: async (params) => {
                    appendTranscript('System', `RPA Action: Executing click event...`);
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        const response = await chrome.tabs.sendMessage(tab.id, { action: 'CLICK_ELEMENT', data: params });
                        return `Successfully clicked element. Page status: ${response ? response.status : 'OK'}`;
                    } catch (err) {
                        return `Failed to click element: ${err.message}. Make sure the target page is fully loaded and allows content scripts.`;
                    }
                },
                scroll_active_page: async (params) => {
                    appendTranscript('System', `RPA Action: Scrolling page ${params.direction}...`);
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        const response = await chrome.tabs.sendMessage(tab.id, { action: 'SCROLL_PAGE', data: params });
                        return `Successfully scrolled the page. Status: ${response ? response.status : 'OK'}`;
                    } catch (err) {
                        return `Failed to scroll page: ${err.message}`;
                    }
                },
                update_intake_form: async (params) => {
                    appendTranscript('System', 'Executing DOM manipulation on active tab...');
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        const response = await chrome.tabs.sendMessage(tab.id, { action: 'UPDATE_DOM_FORM', data: params });
                        return "Form data successfully injected into the user's active browser tab.";
                    } catch (err) {
                        return `DOM update failed: ${err.message}. Make sure you are on a page with input fields.`;
                    }
                },
                launch_phone_delivery: async (params) => {
                    appendTranscript('System', `Initiating call to ${params.recipient_number || 'target'}...`);
                    try {
                        const fileId = params.file_id || window.lastSongFileId;
                        const mode = fileId ? 'play_song' : 'grok_voice';
                        const payload = {
                            to_number: params.recipient_number || "+31612345678",
                            mode: mode
                        };
                        
                        if (mode === 'play_song' && fileId) {
                            payload.file_id = fileId;
                        }

                        const resp = await fetch(`${SERVER_URL}/api/outbound-call`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const res = await resp.json();
                        if (res.ok) {
                            return `Phone call successfully dispatched using mode ${mode}. Twilio SID: ${res.call_sid}`;
                        } else {
                            return `Phone dispatch failed: ${res.error}`;
                        }
                    } catch (err) {
                        return `Phone dispatch failed: ${err.message}`;
                    }
                },
                read_optic_sensor: async () => {
                    appendTranscript('System', '🧠 Initiating Visual Acquisition...');
                    
                    const gKey = extGeminiKeyInput.value.trim();
                    const grokKey = extGrokKeyInput ? extGrokKeyInput.value.trim() : '';

                    if (window.visionActive && visionFeed && visionFeed.srcObject) {
                        appendTranscript('System', 'Snapping live hardware video feed...');
                        const maxDim = 1024;
                        let w = visionFeed.videoWidth || 640;
                        let h = visionFeed.videoHeight || 480;
                        
                        if (w > maxDim || h > maxDim) {
                            if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; } 
                            else { w = Math.round((w * maxDim) / h); h = maxDim; }
                        }
                        
                        const canvas = document.createElement('canvas');
                        canvas.width = w; canvas.height = h;
                        canvas.getContext('2d').drawImage(visionFeed, 0, 0, w, h);
                        const b64Image = canvas.toDataURL('image/jpeg', 0.60).split(',')[1];
                        
                        return visionBreaker.execute(async () => {
                            const resp = await fetchWithTimeout(`${SERVER_URL}/api/analyze-vision`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    image: b64Image,
                                    prompt: "Analyze the scene from the hardware camera or screen-share. Identify object positioning, text, layout, and describe it.",
                                    gemini_key: gKey,
                                    grok_key: grokKey
                                }),
                                timeout: 15000 // 15-second visual processing limit
                            });
                            const res = await resp.json();
                            if (res.error) throw new Error(res.error);
                            appendTranscript('Optic Sensor', `[HARDWARE VISION]: ${res.text}`);
                            return `[LIVE VIDEO CAPTURE]: ${res.text}`;
                        }, `[Graceful Degradation] Vision acquisition is temporarily offline or delayed.`);
                    }

                    if (!window.__opticCache) {
                        window.__opticCache = {
                            lastHash: "",
                            lastAnalysis: "",
                            lastMutationSeq: -1,
                            lastUrl: ""
                        };
                    }
                    
                    const cyrb128 = (str) => {
                        let h1 = 1779033703, h2 = 3024733117, h3 = 3362453659, h4 = 502493819;
                        for (let i = 0, k; i < str.length; i++) {
                            k = str.charCodeAt(i);
                            h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
                            h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
                            h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
                            h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
                        }
                        h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
                        h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
                        h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
                        h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
                        return [(h1^h2^h3^h4)>>>0].toString(16);
                    };

                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (!tab || !tab.id) return "No active tab detected.";

                        const domPromise = chrome.tabs.sendMessage(tab.id, { action: 'GET_DOM_STATE' }).catch(() => {
                            return { url: tab.url, title: tab.title, text: "", mutationCount: Date.now() };
                        });
                        const capturePromise = captureActiveTabBase64().catch(() => null);

                        const [domState, b64Image] = await Promise.all([domPromise, capturePromise]);

                        appendTranscript('System', `⚡ DOM Extracted: "${domState.title.substring(0, 30)}..." | Running asynchronous vision pass...`);
                        
                        if (audioConversation && typeof audioConversation.sendText === 'function') {
                            audioConversation.sendText(`[SYSTEM: Intermediate DOM State Retrieved. Page Title: ${domState.title}. Please provide a momentary comment about this context while the heavy vision analysis runs in the background.]`).catch(() => {});
                        }

                        const imageHash = b64Image ? cyrb128(b64Image) : "";
                        const isDirty = (domState.mutationCount !== window.__opticCache.lastMutationSeq) || 
                                        (domState.url !== window.__opticCache.lastUrl) || 
                                        (imageHash !== window.__opticCache.lastHash);

                        if (!isDirty && window.__opticCache.lastAnalysis) {
                            appendTranscript('System', '👁️ Mutation Observer: No new layout alterations detected. Returning cached analysis.');
                            return `[OPTIC SENSOR DATA (Cached)]: ${window.__opticCache.lastAnalysis}`;
                        }

                        if (!b64Image) {
                            return `[OPTIC SENSOR DATA (Failsafe)]: Could not extract pixel data. Standard DOM State: ${domState.title}`;
                        }

                        if (!gKey && !grokKey) {
                            return `[OPTIC SENSOR DATA]: Page Title: ${domState.title}. Vision processing skipped due to missing Compute credentials (Gemini or Grok).`;
                        }

                        return visionBreaker.execute(async () => {
                            const resp = await fetchWithTimeout(`${SERVER_URL}/api/analyze-vision`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ 
                                    image: b64Image, 
                                    prompt: "Examine active controls, primary visual layouts, and images. Provide a concise, professional assessment for a musical co-pilot.", 
                                    gemini_key: gKey,
                                    grok_key: grokKey
                                }),
                                timeout: 15000 // 15-second visual processing limit
                            });
                            const res = await resp.json();
                            if (res.error) throw new Error(res.error);

                            window.__opticCache = {
                                lastHash: imageHash,
                                lastAnalysis: res.text,
                                lastMutationSeq: domState.mutationCount,
                                lastUrl: domState.url
                            };

                            appendTranscript('Optic Sensor', res.text);
                            return `[OPTIC SENSOR DATA (Live Update)]: ${res.text}`;
                        }, `[Graceful Degradation] Screen scanner is temporarily unresponsive. Fallback Context: ${domState.title}`);

                    } catch (err) {
                        appendTranscript('Error', err.message);
                        return `Failed to read screen. Reason: ${err.message}. Ask the user to navigate to standard webpage.`;
                    }
                },
                animate_mixer_faders: async (params) => {
                    window.ensureMixerChannelExists(params.channel_id);
                    
                    const chInput = document.getElementById(`ch${params.channel_id}-prompt`);
                    const chWeight = document.getElementById(`ch${params.channel_id}-weight`);
                    
                    if (chInput) chInput.value = params.prompt;
                    if (chWeight) chWeight.value = params.weight !== undefined ? params.weight : 1.0;
                    
                    const chBox = document.getElementById(`channel-box-${params.channel_id}`);
                    if (chBox) {
                        chBox.style.transition = "0.1s";
                        chBox.style.borderColor = "var(--neon)";
                        chBox.style.boxShadow = "0 0 15px var(--neon-dim)";
                        setTimeout(() => {
                            chBox.style.transition = "1.5s";
                            chBox.style.borderColor = "var(--border)";
                            chBox.style.boxShadow = "none";
                        }, 200);
                    }

                    if (params.synthesize && socket) {
                        appendTranscript('System', `<span style="color:var(--cyan); font-size:0.75rem; font-family: 'Share Tech Mono', monospace;">⚡ SYNTH ROUTING ACTIVE ON CH ${params.channel_id}...</span>`, true);
                        
                        socket.emit('trigger_stem_generation', {
                            channel_id: params.channel_id,
                            prompt: params.prompt,
                            bpm: params.spd ? Math.round(138 * params.spd) : parseInt(document.getElementById('lyriaBpm').value || 138),
                            duration: parseInt(document.getElementById('lyriaDur').value || 25),
                            vocal_style: params.vocal_style,
                            voice_id: extVoiceIdInput.value.trim() || undefined
                        });
                    }
                    
                    dawBridge.postMessage({ type: 'animate_mixer_faders', params });
                    
                    return `Successfully configured Channel ${params.channel_id} with prompt: ${params.prompt}`;
                },
                set_track_duration: async (params) => {
                    window.currentTrackDuration = params.duration;
                    appendTranscript('System', `Setting Track Duration to ${params.duration}s...`);
                    dawBridge.postMessage({ type: 'set_track_duration', params });
                    return `Track duration successfully set to ${params.duration} seconds.`;
                },
                synthesize_configured_channels: async () => {
                    return "Synthesis command handled implicitly by animate_mixer_faders.";
                },
                analyze_mixer_state: async () => {
                    appendTranscript('System', 'Reading state of studio mixer...');
                    return new Promise((resolve) => {
                        const msgId = Date.now();
                        const listener = (e) => {
                            if (e.data.type === 'mixer_state_response' && e.data.msgId === msgId) {
                                dawBridge.removeEventListener('message', listener);
                                resolve(JSON.stringify(e.data.state));
                            }
                        };
                        dawBridge.addEventListener('message', listener);
                        dawBridge.postMessage({ type: 'analyze_mixer_state', msgId });
                        setTimeout(() => {
                            dawBridge.removeEventListener('message', listener);
                            resolve("DAW window offline or not responding. State defaults to generic track.");
                        }, 2500);
                    });
                },
                generate_cinematic_shot: async (params) => {
                    appendTranscript('System', `Synthesizing conceptual art: "${params.visual_prompt}"...`);
                    const gKey = extGeminiKeyInput.value.trim();
                    let imageUrl = '';
                    
                    if (gKey) {
                        try {
                            appendTranscript('System', 'Querying Google Imagen 3 via local secure keyring link...');
                            const resp = await fetch(`${SERVER_URL}/api/generate-image`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    prompt: params.visual_prompt,
                                    aspect_ratio: params.aspect_ratio || '1:1',
                                    gemini_key: gKey
                                })
                            });
                            const res = await resp.json();
                            if (res.ok && res.file_id) {
                                imageUrl = `${SERVER_URL}/fetch-image/${res.file_id}`;
                                appendTranscript('System', '✅ Imagen 3 concept art rendering complete.');
                            } else {
                                throw new Error(res.error || 'Imagen generation request rejected');
                            }
                        } catch (err) {
                            console.warn("Imagen 3 generation failed, falling back to Pollinations:", err);
                            appendTranscript('System', '⚠️ Premium rendering failed. Initiating standard visual fallback...');
                        }
                    }
                    
                    if (!imageUrl) {
                        const encodedPrompt = encodeURIComponent(params.visual_prompt);
                        const width = params.aspect_ratio === '16:9' ? 1024 : 576;
                        const height = params.aspect_ratio === '16:9' ? 576 : 1024;
                        imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true`;
                    }
                    
                    const imageCard = `
                        <div style="border: 1px solid var(--cyan); border-radius: 8px; overflow: hidden; margin-top: 10px;">
                            <img src="${imageUrl}" style="width: 100%; display: block;" alt="Generated Concept Art">
                        </div>
                    `;
                    appendTranscript('System', imageCard, true);
                    
                    dawBridge.postMessage({ type: 'render_concept_art', params: { imageUrl, prompt: params.visual_prompt } });
                    
                    window.lastGeneratedImageUrl = imageUrl;
                    
                    return `Concept art rendered successfully. Available at: ${imageUrl}`;
                },
                render_audio_visual_mp4: async (params) => {
                    appendTranscript('System', '🎥 Triggering server-side FFmpeg pipeline...');
                    try {
                        const audioId = params.audio_file_id || window.lastSongFileId;
                        const imageUrl = params.image_url || window.lastGeneratedImageUrl;
                        
                        if (!audioId || !imageUrl) return "Failed: Cannot render MP4. Missing an audio track or an image. Generate both first.";

                        const resp = await fetch(`${SERVER_URL}/api/render-mp4`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ audio_id: audioId, image_url: imageUrl })
                        });
                        const res = await resp.json();
                        if (res.ok) {
                            const videoUrl = `${SERVER_URL}${res.url}`;
                            const videoCard = `
                                <div style="border: 1px solid var(--neon); border-radius: 8px; overflow: hidden; margin-top: 10px; background: rgba(0, 255, 65, 0.05); padding: 10px;">
                                    <div style="font-family: 'Share Tech Mono', monospace; font-size: 0.75rem; color: var(--neon); margin-bottom: 8px;">🎬 MP4 RENDER COMPLETE</div>
                                    <video controls style="width: 100%; border-radius: 6px; outline: none;">
                                        <source src="${videoUrl}" type="video/mp4">
                                    </video>
                                    <a href="${videoUrl}" download class="btn mono" style="margin-top: 10px; display: block; text-align: center; text-decoration: none;">⬇ DOWNLOAD MP4</a>
                                </div>
                            `;
                            appendTranscript('System', videoCard, true);
                            return `MP4 rendered successfully and delivered to the user UI.`;
                        } else {
                            throw new Error(res.error || 'Server rejected FFmpeg rendering.');
                        }
                    } catch (err) {
                        return `Render failed: ${err.message}`;
                    }
                },
                propose_new_capability: async (params) => {
                    appendTranscript('System', `AI proposed new capability: ${params.tool_name}`);
                    return "Capability proposal acknowledged and saved to ledger.";
                },
                fetch_market_trends: async () => {
                    appendTranscript('System', 'Fetching market trends...');
                    try {
                        const resp = await fetch(`${SERVER_URL}/api/market-trends`, { method: 'POST' });
                        const data = await resp.json();
                        return JSON.stringify(data.trends || []);
                    } catch (err) {
                        return "Market trends fetch failed.";
                    }
                },
                read_pasted_context: async () => {
                    const pastedText = window.lastPastedContext || "";
                    if (pastedText) {
                        appendTranscript('System', 'Reading pasted context from the Command Hub...');
                        return `[PASTED CONTEXT]: ${pastedText.slice(0, 50000)}`;
                    }
                    return "The Command Hub context buffer is empty. Paste a document or text in first.";
                },
                web_search: async (params) => {
                    appendTranscript('System', `Searching live web for: "${params.query}"...`);
                    try {
                        const resp = await fetchWithTimeout(`${SERVER_URL}/api/web-search`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ query: params.query }),
                            timeout: 12000
                        });
                        if (resp.ok) {
                            const data = await resp.json();
                            if (data.results && data.results.length) {
                                return JSON.stringify(data.results.slice(0, 8));
                            }
                            if (data.content) return data.content.slice(0, 4000);
                        }
                    } catch (e) { /* fall through to X/Google fallback */ }

                    const q = encodeURIComponent(params.query);
                    const xUrl = `https://x.com/search?q=${q}&src=typed_query&f=live`;
                    chrome.tabs.create({ url: xUrl, active: false });
                    return `Opened live X search for "${params.query}". Tell the user to switch to that tab (or snap it with the 📸 TAB button) and I will read the latest posts.`;
                },

                scrape_webpage: async (params) => {
                    appendTranscript('System', `Extracting content from: ${params.url}...`);
                    try {
                        const resp = await fetchWithTimeout(`${SERVER_URL}/api/web-scrape`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: params.url }),
                            timeout: 15000
                        });
                        if (resp.ok) {
                            const data = await resp.json();
                            if (data.content) return data.content.slice(0, 8000);
                            if (data.error) return `Scrape failed: ${data.error}`;
                        }
                    } catch (e) {}

                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        if (tab && tab.url && params.url && tab.url.includes(new URL(params.url).hostname)) {
                            const dom = await chrome.tabs.sendMessage(tab.id, { action: 'SCRAPE_PAGE' });
                            if (dom && dom.text) return dom.text.slice(0, 8000);
                        }
                    } catch (e) {}

                    return `Could not scrape ${params.url}. Ask the user to open the page and press 📸 TAB so I can read it directly.`;
                },

                search_x: async (params) => {
                    const query = params.query || '';
                    const filters = params.filters || 'live'; // live | top | latest
                    const q = encodeURIComponent(query);
                    const url = `https://x.com/search?q=${q}&src=typed_query&f=${filters === 'top' ? 'top' : 'live'}`;
                    chrome.tabs.create({ url, active: true });
                    appendTranscript('System', `Opened X search: ${query}`);
                    return `Opened X advanced search for "${query}". The results tab is now active. Tell me when to snap it (or just say "read the posts") and I will extract the latest offers, grant announcements, and threads.`;
                },
                deep_reasoning_query: async (params) => {
                    appendTranscript('System', 'Running deep reasoning on server...');
                    const gKey = extGeminiKeyInput.value.trim();
                    const grokKey = extGrokKeyInput ? extGrokKeyInput.value.trim() : '';
                    
                    let finalPrompt = params.prompt;
                    if (window.lastPastedContext) {
                        finalPrompt = `[ATTACHED USER DOCUMENT/CODE (Context)]:\n${window.lastPastedContext.slice(0, 15000)}\n\n[AGENT'S QUERY TO SOLVE]:\n${params.prompt}`;
                    }

                    return reasoningBreaker.execute(async () => {
                        const resp = await fetchWithTimeout(`${SERVER_URL}/api/deep-reasoning`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ prompt: finalPrompt, gemini_key: gKey, grok_key: grokKey }),
                            timeout: 60000 // 60-second deep reasoning limit
                        });
                        const data = await resp.json();
                        if (data.response) return data.response;
                        throw new Error(data.error || 'Empty reasoning response');
                    }, `[Graceful Degradation] Deep reasoning query is temporarily offline or timed out.`);
                },
                monid_discover: async (params) => {
                    const mKey = extMonidKeyInput ? extMonidKeyInput.value.trim() : '';
                    appendTranscript('System', `🔍 Searching Monid 1,500+ tool registry for: "${params.query}"`);
                    const resp = await fetch(`${SERVER_URL}/api/monid/discover`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query: params.query, monid_key: mKey })
                    });
                    return JSON.stringify(await resp.json());
                },
                monid_inspect: async (params) => {
                    const mKey = extMonidKeyInput ? extMonidKeyInput.value.trim() : '';
                    appendTranscript('System', `🔍 Inspecting scraper schema for: ${params.provider} ${params.endpoint}`);
                    const resp = await fetch(`${SERVER_URL}/api/monid/inspect`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ provider: params.provider, endpoint: params.endpoint, monid_key: mKey })
                    });
                    return JSON.stringify(await resp.json());
                },
                monid_run: async (params = {}) => {
                    const mKey = extMonidKeyInput ? extMonidKeyInput.value.trim() : '';

                    let rawInput = params.input ?? params.inputs ?? params.data;
                    let baseInput = {};

                    if (typeof rawInput === 'string') {
                        try {
                            baseInput = JSON.parse(rawInput);
                        } catch (e) {
                            baseInput = { query: rawInput };
                        }
                    } else if (typeof rawInput === 'object' && rawInput !== null) {
                        baseInput = { ...rawInput };
                    }

                    // Preserve explicit top-level envelopes
                    if (params.body && typeof params.body === 'object') {
                        baseInput.body = { ...(baseInput.body || {}), ...params.body };
                    }
                    if (params.queryParams || params.query_params) {
                        baseInput.queryParams = { ...(baseInput.queryParams || {}), ...(params.queryParams || params.query_params) };
                    }
                    if (params.pathParams || params.path_params) {
                        baseInput.pathParams = { ...(baseInput.pathParams || {}), ...(params.pathParams || params.path_params) };
                    }

                    const reservedKeys = new Set([
                        'provider', 'endpoint', 'await_result', 'awaitResult',
                        'monid_key', 'monidKey', 'workspace_id', 'workspaceId', 'x_workspace_id',
                        'input', 'inputs', 'data', 'body', 'queryParams', 'query_params', 'pathParams', 'path_params', 'headers'
                    ]);

                    for (const [key, value] of Object.entries(params)) {
                        if (!reservedKeys.has(key) && value !== undefined && baseInput[key] === undefined) {
                            baseInput[key] = value;
                        }
                    }

                    const awaitResult = Boolean(
                        params.await_result === true ||
                        params.awaitResult === true ||
                        params.await_result === 'true' ||
                        params.awaitResult === 'true'
                    );

                    let workspaceId = params.workspace_id || params.workspaceId || params.x_workspace_id || '';
                    if (!workspaceId) {
                        workspaceId = await getSavedKey('extMonidWorkspaceId') || '';
                    }

                    appendTranscript('System', `⚡ Launching Monid data scraper: ${params.provider} ${params.endpoint} (Await: ${awaitResult})`);

                    try {
                        const resp = await fetch(`${SERVER_URL}/api/monid/run`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                provider: params.provider,
                                endpoint: params.endpoint,
                                input: baseInput,
                                await_result: awaitResult,
                                workspace_id: workspaceId,
                                monid_key: mKey
                            })
                        });

                        const result = await resp.json();
                        const resultStr = JSON.stringify(result);
                        return resultStr.length > 30000 ? resultStr.slice(0, 30000) + "...[TRUNCATED]" : resultStr;
                    } catch (err) {
                        console.error("Monid run execution failed:", err);
                        return JSON.stringify({
                            error: `Monid execution failed: ${err.message}`,
                            provider: params.provider,
                            endpoint: params.endpoint
                        });
                    }
                },
                monid_poll_run: async (params) => {
                    const mKey = extMonidKeyInput ? extMonidKeyInput.value.trim() : '';
                    appendTranscript('System', `⏳ Polling Monid scraper run: ${params.run_id}`);
                    const resp = await fetch(`${SERVER_URL}/api/monid/poll-run`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            run_id: params.run_id, 
                            max_wait_seconds: params.max_wait_seconds || 60, 
                            monid_key: mKey 
                        })
                    });
                    const result = await resp.json();
                    const resultStr = JSON.stringify(result);
                    return resultStr.length > 30000 ? resultStr.slice(0, 30000) + "...[TRUNCATED]" : resultStr;
                }
            },
            onConversationCreated: (conversation) => {
                    audioConversation = conversation;
                },
                onConnect: async () => {
                    isConnected = true;
                    btnConnect.innerText = "DISCONNECT (LIVE)";
                    btnConnect.style.background = "var(--neon)";
                    btnConnect.style.color = "#000";

                    appendTranscript('System', 'WebRTC active. Speak into the microphone.');

                    // --- ROBUST CLIENT-SIDE MEMORY REHYDRATION BRIDGE ---
                        try {
                            await new Promise(resolve => setTimeout(resolve, 1500));
                            
                            const memoryVal = await getSavedKey('agentMemory') || '';
                            if (memoryVal.trim() && audioConversation) {
                                const rehydratePayload = `[PERSISTENT MEMORY REHYDRATION]\nThe following are verified long-term facts about the user and LensDNA OS. Treat them as ground truth for this session and never ask for them again:\n${memoryVal}\n\n[END MEMORY]`;
                                if (typeof audioConversation.sendContextualUpdate === 'function') {
                                    audioConversation.sendContextualUpdate(rehydratePayload);
                                    console.info('[LensDNA] Persistent memory rehydrated via sendContextualUpdate');
                                } else if (typeof audioConversation.sendUserMessage === 'function') {
                                    audioConversation.sendUserMessage(rehydratePayload);
                                    console.info('[LensDNA] Persistent memory rehydrated via sendUserMessage');
                                }
                                appendTranscript('System', '🧠 Persistent Memory Layer rehydrated into runtime context.');
                            }
                            if (window.lastPastedContext && window.lastPastedContext.trim() && audioConversation) {
                                const ctxPayload = `[SESSION CONTEXT RESTORE]\n${window.lastPastedContext.slice(0, 12000)}`;
                                if (typeof audioConversation.sendContextualUpdate === 'function') {
                                    audioConversation.sendContextualUpdate(ctxPayload);
                                }
                            }
                        } catch (rehydrateErr) {
                            console.warn('[LensDNA] Memory rehydration bridge failed (non-fatal):', rehydrateErr);
                        }
                },
                onDisconnect: () => {
                    isConnected = false;
                    audioConversation = null; 
                    
                    btnConnect.innerText = "INITIATE UPLINK";
                    btnConnect.style.background = "rgba(0,229,255,0.1)";
                    btnConnect.style.color = "var(--cyan)";
                    orb.style.boxShadow = "0 0 20px var(--cyan)";
                    orb.style.background = "radial-gradient(circle, var(--cyan), transparent)";
                    
                    memoryPending = false;
                    cleanupAudioRegistry();
                    appendTranscript('System', 'Audio uplink severed.');
                },
                onMessage: async (msg) => {
                    const role = msg.source === 'ai' ? 'Agent' : 'User';

                    if (msg.message) {
                        appendTranscript(role, msg.message);
                        
                        const saveMatch = msg.message.match(/\[MEMORY_SAVE:\s*([\s\S]*?)\]/i) || msg.message.match(/\[MEMORY_UPDATE:\s*([\s\S]*?)\]/i);
                        if (saveMatch && msg.source === 'ai') {
                            const isHipaaActive = await getSavedKey('extHipaaModeActive') === 'true';
                            if (isHipaaActive) {
                                appendTranscript('System', `🧠 Zero Retention Active: Local persistent write dropped.`);
                                return;
                            }

                            const factToAppend = saveMatch[1].trim();
                            let currentMemory = await getSavedKey('agentMemory') || '';
                            
                            if (currentMemory) {
                                currentMemory += `\n- ${factToAppend}`;
                            } else {
                                currentMemory = `- ${factToAppend}`;
                            }
                            
                            await saveKey('agentMemory', currentMemory);
                            if (extMemoryBox) extMemoryBox.value = currentMemory;
                            appendTranscript('System', `🧠 Local Storage Synced: Memory added: "${factToAppend}"`);
                        }
                    }
                },
            onModeChange: (mode) => {
                if (mode.mode === 'speaking') {
                    orb.style.boxShadow = "0 0 40px rgba(0,255,65,0.8)";
                    orb.style.background = "radial-gradient(circle, rgba(0,255,65,0.8), transparent)";
                } else {
                    orb.style.boxShadow = "0 0 20px rgba(0,229,255,0.5)";
                    orb.style.background = "radial-gradient(circle, rgba(0,229,255,0.8), transparent)";
                }
            },

            onLatencyMeasurement: (latencyMs) => {
                if (typeof latencyMs === 'number' && isFinite(latencyMs) && latencyMs > 0) {
                    lastMeasuredLatency = Math.round(latencyMs);
                }
            }
        });

        } catch (err) {
            appendTranscript('Error', err.message);
            btnConnect.innerText = "INITIATE UPLINK";
            isConnected = false;
            audioConversation = null;
        }
});

if (btnExtractDom) {
    btnExtractDom.addEventListener('click', async () => {
        appendTranscript('System', '📄 Requesting on-demand page capture...');
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.id) {
                appendTranscript('Error', 'No active tab detected.');
                return;
            }

            if (tab.url) {
                const url = tab.url.toLowerCase();
                if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
                    appendTranscript('Error', 'Cannot extract DOM context from internal browser configurations or blank tabs.');
                    return;
                }
            }

            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const description = document.querySelector('meta[name="description"]')?.content || "None";
                    const text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 12000);
                    return { description, text };
                }
            });

            const pageData = results[0].result;
            const contextPayload = `[ACTIVE TAB REFRESH INFO]\nURL: ${tab.url}\nTITLE: ${tab.title}\nDESCRIPTION: ${pageData.description}\nCONTENT: ${pageData.text}`;
            
            window.lastPastedContext = contextPayload;
            appendTranscript('System', `✅ Captured page: "${tab.title.substring(0, 30)}...". Command Hub context buffer refreshed.`);

            if (audioConversation) {
                if (typeof audioConversation.sendText === 'function') {
                    try {
                        await audioConversation.sendText(`[SYSTEM: User manually clicked the DOM refresh button. The active page context has been updated to: ${tab.title}. Context: ${pageData.text.slice(0, 2000)}]`);
                    } catch (e) {}
                }
                if (typeof audioConversation.sendUserMessage === 'function') {
                    try {
                        await audioConversation.sendUserMessage("I just updated the page DOM context. Please review the current state of my screen.");
                    } catch (e) {}
                }
            } else if (socket && socket.connected) {
                socket.emit('ingest_context', { text: contextPayload });
            }

        } catch (err) {
            appendTranscript('Error', `Page capture failed: ${err.message}`);
        }
    });
}

btnSnap.addEventListener('click', async () => {
    appendTranscript('System', 'Snapping active tab...');
    try {
        const b64Image = await captureActiveTabBase64();
        const gKey = extGeminiKeyInput.value.trim();
        const grokKey = extGrokKeyInput ? extGrokKeyInput.value.trim() : '';

        const resp = await fetch(`${SERVER_URL}/api/analyze-vision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                image: b64Image, 
                prompt: "What is on this screen?", 
                gemini_key: gKey,
                grok_key: grokKey
            })
        });
        const res = await resp.json();
        if (res.error) throw new Error(res.error);
        
        appendTranscript('Optic Sensor', res.text);
        
        if (audioConversation) {
            if (typeof audioConversation.sendUserMessage === 'function') {
                audioConversation.sendUserMessage(`[OPTIC SENSOR ALERT: The user just snapped their screen. Here is what is on it: ${res.text}. Use this context to help them.]`);
            }
        }
    } catch (err) {
        appendTranscript('Error', err.message);
    }
});

function startVisionFeed(stream, sourceName) {
    visionFeed.srcObject = stream;
    visionContainer.style.display = 'block';
    window.visionActive = true;
    
    if (sourceName.includes('Cam') || sourceName === 'Camera') {
        btnCamera.style.background = "var(--cyan)";
        btnCamera.style.color = "#000";
        if (currentFacingMode === "user") {
            visionFeed.style.transform = "scaleX(-1)";
        } else {
            visionFeed.style.transform = "none";
        }
    }
    mediaStatusText.innerText = `${sourceName} optic sensor linked.`;
    appendTranscript('System', `Hardware ${sourceName} link established.`);
    const _nexusWorkspace = document.querySelector('.app-workspace');
    setTimeout(() => { if (_nexusWorkspace) _nexusWorkspace.scrollTop = _nexusWorkspace.scrollHeight; }, 50);
}

function stopVisionFeed() {
    if (visionFeed.srcObject) {
        visionFeed.srcObject.getTracks().forEach(track => track.stop());
        visionFeed.srcObject = null;
    }
    visionContainer.style.display = 'none';
    window.visionActive = false;
    
    btnCamera.style.background = "rgba(0,229,255,0.1)";
    btnCamera.style.color = "var(--cyan)";
    btnCamera.innerText = "📷 CAM";
    
    visionFeed.style.transform = "none";
    mediaStatusText.innerText = "Hardware sensors idle.";
}

let currentFacingMode = "environment"; // default to rear-facing on mobile

if (btnCamera) {
    btnCamera.addEventListener('click', async () => {
        if (window.visionActive) {
            stopVisionFeed();
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: currentFacingMode } 
            }).catch(async () => {
                return await navigator.mediaDevices.getUserMedia({ video: true });
            });
            const label = currentFacingMode === "environment" ? "Rear Cam" : "Front Cam";
            btnCamera.innerText = currentFacingMode === "environment" ? "📷 REAR" : "📷 FRONT";
            startVisionFeed(stream, label);
        } catch (err) {
            appendTranscript('Error', 'Camera access denied: ' + err.message);
            stopVisionFeed();
        }
    });
}

async function triggerManualDomSync() {
    appendTranscript('System', '📄 Requesting on-demand page capture...');
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            appendTranscript('Error', 'No active tab detected.');
            return;
        }

        if (tab.url) {
            const url = tab.url.toLowerCase();
            if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:') || url.startsWith('chrome-extension://')) {
                appendTranscript('Error', 'Cannot extract DOM context from internal browser configurations or blank tabs.');
                return;
            }
        }

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const description = document.querySelector('meta[name="description"]')?.content || "None";
                const text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 12000);
                return { description, text };
            }
        });

        const pageData = results[0].result;
        const contextPayload = `[ACTIVE TAB REFRESH INFO]\nURL: ${tab.url}\nTITLE: ${tab.title}\nDESCRIPTION: ${pageData.description}\nCONTENT: ${pageData.text}`;
        
        window.lastPastedContext = contextPayload;
        appendTranscript('System', `✅ Captured page: "${tab.title.substring(0, 30)}...". Command Hub context buffer refreshed.`);

        if (audioConversation) {
            if (typeof audioConversation.sendText === 'function') {
                try {
                    await audioConversation.sendText(`[SYSTEM: User manually clicked the DOM refresh button. The active page context has been updated to: ${tab.title}. Context: ${pageData.text.slice(0, 2000)}]`);
                } catch (e) {}
            }
            if (typeof audioConversation.sendUserMessage === 'function') {
                try {
                    await audioConversation.sendUserMessage("I just updated the page DOM context. Please review the current state of my screen.");
                } catch (e) {}
            }
        } else if (socket && socket.connected) {
            socket.emit('ingest_context', { text: contextPayload });
        }

    } catch (err) {
        appendTranscript('Error', `Page capture failed: ${err.message}`);
    }
}

if (btnScreen) {
    btnScreen.addEventListener('click', triggerManualDomSync);
}

const btnFlipVision = document.getElementById('btnFlipVision');
if (btnFlipVision) {
    btnFlipVision.addEventListener('click', async () => {
        if (!window.visionActive) return;
        currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
        try {
            if (visionFeed.srcObject) {
                visionFeed.srcObject.getTracks().forEach(track => track.stop());
            }
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: currentFacingMode } 
            }).catch(async () => {
                return await navigator.mediaDevices.getUserMedia({ video: true });
            });
            const label = currentFacingMode === "environment" ? "Rear Cam" : "Front Cam";
            btnCamera.innerText = currentFacingMode === "environment" ? "📷 REAR" : "📷 FRONT";
            startVisionFeed(stream, label);
        } catch (err) {
            appendTranscript('Error', 'Failed to flip camera: ' + err.message);
        }
    });
}

const btnMinimizeVision = document.getElementById('btnMinimizeVision');
if (btnMinimizeVision) {
    btnMinimizeVision.addEventListener('click', () => {
        const isMinimized = visionContainer.style.height === '200px' || visionContainer.style.height === '';
        if (isMinimized) {
            visionContainer.style.height = '60vh';
            btnMinimizeVision.innerText = '[ - ] COLLAPSE';
        } else {
            visionContainer.style.height = '200px';
            btnMinimizeVision.innerText = '[ + ] EXPAND';
        }
    });
}

const btnCloseVision = document.getElementById('btnCloseVision');
if (btnCloseVision) {
    btnCloseVision.addEventListener('click', () => {
        stopVisionFeed();
    });
}

const btnCallVoice = document.getElementById('btnCallVoice');
const btnCallSong = document.getElementById('btnCallSong');
const outboundStatusText = document.getElementById('outboundStatusText');

async function triggerOutboundCall(mode) {
    const toNum = document.getElementById('outboundToNumber').value.trim();
    const fromNum = document.getElementById('outboundFromNumber').value.trim();
    
    if (!toNum) {
        alert("Please enter a valid recipient number in E.164 format (e.g. +31612345678)");
        return;
    }
    
    if (mode === 'play_song' && !window.lastSongFileId) {
        outboundStatusText.innerText = "Error: Ask the AI to generate a song first before dispatching.";
        outboundStatusText.style.color = "#ff3b30";
        return;
    }

    outboundStatusText.innerText = mode === 'play_song' ? "Initiating media injection..." : "Bridging secure voice agent...";
    outboundStatusText.style.color = "var(--cyan)";
    
    try {
        const payload = {
            to_number: toNum,
            from_number: fromNum,
            mode: mode
        };
        
        if (mode === 'play_song' && window.lastSongFileId) {
            payload.file_id = window.lastSongFileId;
        }
        
        const resp = await fetch(`${SERVER_URL}/api/outbound-call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const res = await resp.json();
        
        if (res.ok) {
            outboundStatusText.innerHTML = `
                <span style="color: var(--neon); font-weight: bold;">✅ CALL CONNECTED</span><br>
                <span style="font-size: 0.65rem; color: var(--text-mut);">SID: ${res.call_sid.slice(0, 14)}...</span>
            `;
        } else {
            outboundStatusText.innerText = `Error: ${res.error}`;
            outboundStatusText.style.color = "#ff3b30";
        }
    } catch (err) {
        outboundStatusText.innerText = `Failed: ${err.message}`;
        outboundStatusText.style.color = "#ff3b30";
    }
}

if (btnCallVoice) btnCallVoice.addEventListener('click', () => triggerOutboundCall('grok_voice'));
if (btnCallSong) btnCallSong.addEventListener('click', () => triggerOutboundCall('play_song'));

async function sendManualText() {
    const text = extManualInject.value.trim();
    if (!text) return;
    
    if (text.length > 1000) {
        window.lastPastedContext = text;
        appendTranscript('User', `[Code/Document Block Sync: ${text.length} characters loaded to buffer.]`);
        extManualInject.value = '';
        
        if (audioConversation) {
            if (typeof audioConversation.sendText === 'function') {
                try {
                    await audioConversation.sendText("[SYSTEM: The user pasted a massive text/code payload inside the Command Hub. Do NOT read it. Call the 'deep_reasoning_query' tool to instantly analyze, run audit operations, or extract details.]");
                } catch (e) {}
            }

            if (typeof audioConversation.sendUserMessage === 'function') {
                try {
                    await audioConversation.sendUserMessage("I just pasted a long document/code block into the Command Hub. Please analyze it using read_pasted_context + deep_reasoning_query.");
                } catch (e) {}
            }
        } else if (socket && socket.connected) {
            socket.emit('ingest_context', { text: text });
        }
        appendTranscript('System', 'Large block buffered. Use "deep_reasoning_query" to analyze it.');
        return;
    }

    appendTranscript('User', text);
    extManualInject.value = '';
    
    let sent = false;
    
    if (audioConversation) {
        try {
            if (typeof audioConversation.sendUserMessage === 'function') {
                await audioConversation.sendUserMessage(text);
            } else if (typeof audioConversation.sendText === 'function') {
                await audioConversation.sendText(text);
            }
            sent = true;
        } catch (e) {}
    }
    
    if (!sent && socket && socket.connected) {
        socket.emit('user_message', { text: text });
        sent = true;
    }
    
    if (sent) {
        appendTranscript('System', 'Command synchronized.');
    } else {
        appendTranscript('System', '⚠️ Voice session standby. Connect to a pilot first.');
    }
}

if (btnSendText) {
    btnSendText.addEventListener('click', sendManualText);
}

if (extManualInject) {
    extManualInject.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendManualText();
        }
    });
}

async function toggleSettingsPanel() {
    const isCollapsed = columnLeft.classList.toggle('collapsed');
    await saveKey('settingsCollapsed', isCollapsed ? 'true' : 'false');
}

if (btnToggleSettings) {
    btnToggleSettings.addEventListener('click', toggleSettingsPanel);
}

if (btnHideSettings) {
    btnHideSettings.addEventListener('click', toggleSettingsPanel);
}

const btnThemeToggle = document.getElementById('btnThemeToggle');
const elevenBanner = document.getElementById('elevenBanner');

const THEME_ASSETS = {
    dark: {
        banner: 'https://eleven-public-cdn.elevenlabs.io/payloadcms/cy7rxce8uki-IIElevenLabsGrants%201.webp',
        label: 'THEME: DARK'
    },
    light: {
        banner: 'https://eleven-public-cdn.elevenlabs.io/payloadcms/pwsc4vchsqt-ElevenLabsGrants.webp',
        label: 'THEME: LIGHT'
    }
};

async function applyTheme(theme) {
    const isSystem = theme === 'system';
    let targetTheme = theme;
    
    if (isSystem) {
        targetTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    
    const btnThemeToggleHub = document.getElementById('btnThemeToggleHub');
    
    if (targetTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        elevenBanner.src = THEME_ASSETS.light.banner;
        if (btnThemeToggle) btnThemeToggle.innerText = isSystem ? 'THEME: AUTO (LIGHT)' : 'THEME: LIGHT';
        if (btnThemeToggleHub) btnThemeToggleHub.innerText = isSystem ? '🌓 AUTO' : '☀️ LIGHT';
    } else {
        document.documentElement.removeAttribute('data-theme');
        elevenBanner.src = THEME_ASSETS.dark.banner;
        if (btnThemeToggle) btnThemeToggle.innerText = isSystem ? 'THEME: AUTO (DARK)' : 'THEME: DARK';
        if (btnThemeToggleHub) btnThemeToggleHub.innerText = isSystem ? '🌓 AUTO' : '🌙 DARK';
    }
    
    await saveKey('selectedTheme', theme);
}

async function handleThemeToggle() {
    const saved = await getSavedKey('selectedTheme') || 'dark';
    let nextTheme = 'dark';
    
    if (saved === 'dark') nextTheme = 'light';
    else if (saved === 'light') nextTheme = 'system';
    
    await applyTheme(nextTheme);
}

if (btnThemeToggle) btnThemeToggle.addEventListener('click', handleThemeToggle);
const btnThemeToggleHub = document.getElementById('btnThemeToggleHub');
if (btnThemeToggleHub) btnThemeToggleHub.addEventListener('click', handleThemeToggle);

(async () => {
    const savedTheme = await getSavedKey('selectedTheme') || 'dark';
    await applyTheme(savedTheme);
    
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', async () => {
        const currentSetting = await getSavedKey('selectedTheme') || 'dark';
        if (currentSetting === 'system') {
            await applyTheme('system');
        }
    });

    let lastGoodLatency = null;
    let latencySamples = [];
    let telemetryWasLive = false;
    let httpProbeInFlight = false;
    let lastHttpRtt = null;
    let lastHttpProbeAt = 0;

    function updateLatencyDisplay(ms) {
        const latencySpan = document.getElementById('telemetry-latency');
        if (!latencySpan || !isFinite(ms) || ms <= 0) return;

        const sample = Math.round(ms);
        latencySamples.push(sample);
        if (latencySamples.length > 5) latencySamples.shift();
        const avg = Math.round(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length);

        lastGoodLatency = avg;
        latencySpan.innerText = `~${avg}ms`;
        latencySpan.style.color = avg < 150 ? 'var(--neon)' : (avg < 300 ? 'var(--cyan)' : 'var(--alert)');
    }

    function resetTelemetry() {
        lastGoodLatency = null;
        latencySamples = [];
        lastMeasuredLatency = null;
        telemetryWasLive = false;
        lastHttpRtt = null;
        lastHttpProbeAt = 0;
        const latencySpan = document.getElementById('telemetry-latency');
        const jitterSpan = document.getElementById('telephony-jitter');
        if (latencySpan) {
            latencySpan.innerText = 'OFFLINE';
            latencySpan.style.color = 'var(--text-mut)';
        }
        if (jitterSpan) {
            jitterSpan.innerText = 'OFFLINE';
            jitterSpan.style.color = 'var(--text-mut)';
        }
    }

    function updateStabilityDisplay(avgJitter, lossPercent, hasMediaStats) {
        const jitterSpan = document.getElementById('telephony-jitter');
        if (!jitterSpan) return;

        if (!hasMediaStats) {
            if (lastGoodLatency != null) {
                jitterSpan.innerText = lastGoodLatency < 150 ? 'STABLE' : 'FAIR';
                jitterSpan.style.color = lastGoodLatency < 150 ? 'var(--neon)' : 'var(--cyan)';
            } else {
                jitterSpan.innerText = 'LINKING...';
                jitterSpan.style.color = 'var(--cyan)';
            }
            return;
        }

        if (lossPercent > 5) {
            jitterSpan.innerText = `${lossPercent}% loss`;
            jitterSpan.style.color = 'var(--alert)';
        } else if (avgJitter < 20 && lossPercent === 0) {
            jitterSpan.innerText = 'EXCELLENT';
            jitterSpan.style.color = 'var(--neon)';
        } else if (avgJitter < 55 && lossPercent < 3) {
            jitterSpan.innerText = 'STABLE';
            jitterSpan.style.color = 'var(--cyan)';
        } else {
            jitterSpan.innerText = `${avgJitter}ms / ${lossPercent}%`;
            jitterSpan.style.color = (avgJitter > 70 || lossPercent > 3) ? 'var(--alert)' : 'var(--cyan)';
        }
    }

    async function probeHttpRtt() {
        const now = Date.now();
        if (httpProbeInFlight) return lastHttpRtt;
        if (now - lastHttpProbeAt < 2000 && lastHttpRtt != null) return lastHttpRtt;

        httpProbeInFlight = true;
        lastHttpProbeAt = now;
        const urls = [`${SERVER_URL}/favicon.ico`, SERVER_URL];

        try {
            for (const url of urls) {
                const t0 = performance.now();
                try {
                    await fetch(url, { method: 'GET', cache: 'no-store', mode: 'no-cors', credentials: 'omit' });
                    const rtt = Math.round(performance.now() - t0);
                    if (rtt > 0 && rtt < 15000) {
                        lastHttpRtt = rtt;
                        return rtt;
                    }
                } catch (_) {}
            }
        } finally {
            httpProbeInFlight = false;
        }
        return lastHttpRtt;
    }

    async function collectWebRtcStats() {
        let bestRtt = null;
        let totalJitter = 0;
        let jitterCount = 0;
        let totalPacketsLost = 0;
        let totalPacketsReceived = 0;

        for (const pc of [...(window.activePeerConnections || [])]) {
            if (!pc || pc.connectionState === 'closed' || pc.signalingState === 'closed') {
                window.activePeerConnections.delete(pc);
            }
        }

        for (const pc of window.activePeerConnections || []) {
            if (!pc) continue;
            try {
                const stats = await pc.getStats();
                stats.forEach((report) => {
                    if (report.type === 'candidate-pair') {
                        const rttSec = report.currentRoundTripTime ?? report.roundTripTime;
                        if (rttSec != null && rttSec > 0) {
                            const ms = rttSec * 1000;
                            const preferred = report.nominated === true || report.selected === true || report.state === 'succeeded';
                            if (preferred) {
                                bestRtt = bestRtt == null ? ms : Math.min(bestRtt, ms);
                            } else if (bestRtt == null) {
                                bestRtt = ms;
                            }
                        }
                    }

                    if (report.type === 'remote-inbound-rtp') {
                        const rttSec = report.roundTripTime ?? report.currentRoundTripTime;
                        if (rttSec != null && rttSec > 0) {
                            const ms = rttSec * 1000;
                            bestRtt = bestRtt == null ? ms : Math.min(bestRtt, ms);
                        }
                    }

                    const isAudioInbound = report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio');
                    if (isAudioInbound) {
                        if (report.jitter != null) {
                            totalJitter += report.jitter * 1000;
                            jitterCount++;
                        }
                        if (report.packetsLost != null) totalPacketsLost += report.packetsLost;
                        if (report.packetsReceived != null) totalPacketsReceived += report.packetsReceived;
                    }
                });
            } catch (_) {}
        }

        return {
            bestRtt: bestRtt != null ? Math.round(bestRtt) : null,
            avgJitter: jitterCount > 0 ? Math.round(totalJitter / jitterCount) : 0,
            lossPercent: totalPacketsReceived > 0 ? Math.round((totalPacketsLost / (totalPacketsReceived + totalPacketsLost)) * 100) : 0,
            hasMediaStats: jitterCount > 0 || totalPacketsReceived > 0,
        };
    }

    setInterval(async () => {
        const latencySpan = document.getElementById('telemetry-latency');
        const jitterSpan = document.getElementById('telephony-jitter');
        if (!latencySpan || !jitterSpan) return;

        if (!isConnected || !audioConversation) {
            if (telemetryWasLive) resetTelemetry();
            return;
        }
        telemetryWasLive = true;

        try {
            if (lastMeasuredLatency != null && lastMeasuredLatency > 0) {
                updateLatencyDisplay(lastMeasuredLatency);
            }

            const rtc = await collectWebRtcStats();
            if (rtc.bestRtt != null && rtc.bestRtt > 0) {
                updateLatencyDisplay(rtc.bestRtt);
            } else if (lastGoodLatency == null) {
                latencySpan.innerText = 'MEASURING...';
                latencySpan.style.color = 'var(--cyan)';
                const httpRtt = await probeHttpRtt();
                if (httpRtt != null && httpRtt > 0) {
                    updateLatencyDisplay(httpRtt);
                } else if (lastGoodLatency == null) {
                    latencySpan.innerText = 'MEASURING...';
                    latencySpan.style.color = 'var(--cyan)';
                }
            }

            updateStabilityDisplay(rtc.avgJitter, rtc.lossPercent, rtc.hasMediaStats);
        } catch (_) {
            if (lastGoodLatency != null) {
                latencySpan.innerText = `~${lastGoodLatency}ms`;
            }
        }
    }, 1000);

})();

let channelCount = 0;
const channelsContainer = document.getElementById('channels-container');
const btnAddChannel = document.getElementById('btn-add-channel');
const btnLyriaGen = document.getElementById('btn-lyria-gen');

window.ensureMixerChannelExists = function(chId, forceOpen = true) {
    if (document.getElementById(`channel-box-${chId}`)) return;
    channelCount = Math.max(channelCount, chId);
    
    const div = document.createElement('div');
    div.className = 'dj-channel';
    div.id = `channel-box-${chId}`;
    
    div.innerHTML = `
        <!-- Col 1: Playback State / ID -->
        <div style="display:flex; flex-direction:column; align-items:center; gap:6px; width:22px; flex-shrink:0;">
            <div style="font-size:0.7rem; color:var(--text-mut); font-weight:bold; text-align:center;" class="mono">${chId}</div>
            <button class="channel-play-btn" data-ch="${chId}" style="background:none; border:none; color:var(--neon); font-size:1.1rem; cursor:pointer; padding:0;">▶️</button>
        </div>
        
        <!-- Col 2: Dynamic Text Prompt (Auto-expands to fill space) -->
        <div style="flex:1; min-width: 0; display: flex; flex-direction: column; align-self: stretch; justify-content: center;">
            <textarea id="ch${chId}-prompt" class="mono" placeholder="Stem description..." style="width:100%; height:100%; min-height:65px; resize:none; padding:8px; font-size:0.75rem; border-color:var(--border) !important; background:var(--bg) !important; color:var(--text) !important; box-sizing: border-box; border-radius:6px;"></textarea>
        </div>
        
        <!-- Col 3: Consolidated Vertical Fader Deck -->
        <div style="display:flex; gap:4px; align-items:center; flex-shrink:0; background:rgba(0,0,0,0.15); padding:4px 6px; border-radius:6px; border:1px solid var(--border);">
            <div class="fader-vertical" title="Volume"><span class="mono">VOL</span><input type="range" id="ch${chId}-volume" min="0" max="1.5" step="0.1" value="1.0"></div>
            <div class="fader-vertical" title="Panning"><span class="mono">PAN</span><input type="range" id="ch${chId}-pan" min="-1" max="1" step="0.1" value="0"></div>
            <div class="fader-vertical" title="Low EQ"><span class="mono">LO</span><input type="range" id="ch${chId}-bass" min="-20" max="20" step="1" value="0"></div>
            <div class="fader-vertical" title="Mid EQ"><span class="mono">MID</span><input type="range" id="ch${chId}-mid" min="-20" max="20" step="1" value="0"></div>
            <div class="fader-vertical" title="High EQ"><span class="mono">HI</span><input type="range" id="ch${chId}-treb" min="-20" max="20" step="1" value="0"></div>
            <div class="fader-vertical" title="Weight Focus" style="border-left:1px dashed var(--border); padding-left:4px;"><span class="mono" style="color:var(--neon);">WT</span><input type="range" id="ch${chId}-weight" min="0" max="1.5" step="0.1" value="1.0"></div>
        </div>
        
        <!-- Col 4: Channel Discard -->
        <button class="remove-channel-btn" style="background:none; border:none; color:var(--text-mut); font-size:1.1rem; cursor:pointer; padding:0; width:16px; flex-shrink:0;" title="Remove Channel">×</button>
        <audio id="ch${chId}-audio" style="display:none;"></audio>
    `;
    channelsContainer.appendChild(div);
    channelsContainer.scrollTop = channelsContainer.scrollHeight;
    
    if (forceOpen) {
        const mixerPanel = document.getElementById('dj-matrix-panel');
        if (mixerPanel && (mixerPanel.style.display === 'none' || mixerPanel.style.display === '')) {
            mixerPanel.style.display = 'flex';
        }
    }
};

if (btnAddChannel) {
    btnAddChannel.addEventListener('click', () => {
        if (channelCount >= 8) {
            alert("Maximum 8 channels allowed.");
            return;
        }
        window.ensureMixerChannelExists(channelCount + 1);
    });
}

if (btnLyriaGen) {
    btnLyriaGen.addEventListener('click', () => {
        if (!socket || !socket.connected) {
            alert("Please click 'INITIATE UPLINK' in the sidebar first to connect to the Sovereign AI Audio Engine.");
            return;
        }
        
        const bpm = parseInt(document.getElementById('lyriaBpm').value || 138);
        const dur = parseInt(document.getElementById('lyriaDur').value || 25);
        const voiceId = document.getElementById('extVoiceId').value.trim() || undefined;
        
        const channels = document.querySelectorAll('.dj-channel');
        if (channels.length === 0) {
            alert("Please add at least one channel and enter a prompt.");
            return;
        }

        let triggered = 0;
        channels.forEach(chBox => {
            const idMatch = chBox.id.match(/\d+/);
            if (!idMatch) return;
            const chId = parseInt(idMatch[0]);
            const promptVal = document.getElementById(`ch${chId}-prompt`).value.trim();
            const weightVal = parseFloat(document.getElementById(`ch${chId}-weight`).value);
            
            if (promptVal && weightVal > 0) {
                socket.emit('trigger_stem_generation', {
                    channel_id: chId,
                    prompt: promptVal,
                    bpm: bpm,
                    duration: dur,
                    voice_id: voiceId
                });
                triggered++;
            }
        });

        if (triggered > 0) {
            appendTranscript('System', `<span style="color:var(--neon); font-family:'Share Tech Mono', monospace;">🚀 Triggered ${triggered} channels for synthesis. Audio will appear here momentarily!</span>`, true);
            btnLyriaGen.innerText = "SYNTHESIZING...";
            btnLyriaGen.style.background = "var(--neon)";
            btnLyriaGen.style.color = "#000";
            setTimeout(() => {
                btnLyriaGen.innerText = "SYNTHESIZE AUDIO";
                btnLyriaGen.style.background = "#b000ff";
                btnLyriaGen.style.color = "#fff";
            }, 2000);
        }
    });
}

setTimeout(() => {
    window.ensureMixerChannelExists(1, false);
    window.ensureMixerChannelExists(2, false);
    const ch1Input = document.getElementById('ch1-prompt');
    if (ch1Input) ch1Input.placeholder = "Channel 1 (Vocals): <singing> Paste lyrics here </singing>";
    const ch2Input = document.getElementById('ch2-prompt');
    if (ch2Input) ch2Input.placeholder = "Channel 2 (Inst): 120 BPM, punchy kick, analog moog bass";
}, 500);

document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
        const textToCopy = decodeURIComponent(copyBtn.getAttribute('data-text'));
        
        navigator.clipboard.writeText(textToCopy).then(() => {
            copyBtn.innerHTML = '✓';
            copyBtn.style.color = '#00ff41';
            copyBtn.style.borderColor = '#00ff41';
            
            setTimeout(() => {
                copyBtn.innerHTML = '📋 Copy';
                copyBtn.style.color = 'var(--text)';
                copyBtn.style.borderColor = 'var(--border)';
            }, 2000);
        }).catch(err => {
            console.error("Failed to copy text: ", err);
        });
        return;
    }

    const closeBtn = e.target.closest('.close-card-btn');
    if (closeBtn) {
        const targetId = closeBtn.getAttribute('data-target');
        if (targetId) {
            const targetEl = document.getElementById(targetId);
            if (targetEl) targetEl.style.display = 'none';
        } else {
            closeBtn.parentElement.remove();
        }
        return;
    }

    const minBtn = e.target.closest('.min-card-btn');
    if (minBtn) {
        const targetId = minBtn.getAttribute('data-target');
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
            const content = targetEl.querySelector('.card-content');
            if (content) {
                const isHidden = content.style.display === 'none';
                content.style.display = isHidden ? 'block' : 'none';
                minBtn.innerHTML = isHidden ? '_' : '□';
            }
        }
        return;
    }

    const clearKeyBtn = e.target.closest('.clear-btn');
    if (clearKeyBtn) {
        const inputId = clearKeyBtn.getAttribute('data-input');
        const inputEl = document.getElementById(inputId);
        if (inputEl) {
            inputEl.value = '';
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
    }

    const unlinkKeysBtn = e.target.closest('.unlink-keys-btn');
    if (unlinkKeysBtn) {
        const keys = ['extElevenKey', 'extGeminiKey', 'extFishKey', 'extGrokKey', 'extVoiceId'];
        keys.forEach(k => {
            const el = document.getElementById(k);
            if (el) {
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        return;
    }

    const removeChBtn = e.target.closest('.remove-channel-btn');
    if (removeChBtn) {
        const chDiv = removeChBtn.closest('.dj-channel');
        if (chDiv) chDiv.remove();
        return;
    }

    const chPlayBtn = e.target.closest('.channel-play-btn');
    if (chPlayBtn) {
        const chId = chPlayBtn.getAttribute('data-ch');
        const audio = document.getElementById(`ch${chId}-audio`);
        if(!audio) return;
        
        if(!audio.src || audio.src.endsWith("undefined") || audio.src === window.location.href) {
            alert("Generate a stem for this channel first!");
            return;
        }

        if(audio.paused) {
            audio.play().then(() => {
                chPlayBtn.innerText = '⏸️';
            }).catch(err => {
                console.error("Playback failed:", err);
                alert("Audio playback was blocked. Please try generating again.");
            });
        } else {
            audio.pause();
            chPlayBtn.innerText = '▶️';
        }
        return;
    }

    const syncPlayBtn = e.target.closest('#btn-sync-play');
    if (syncPlayBtn) {
        const audios = [];
        for(let i=1; i<=8; i++) {
            const a = document.getElementById(`ch${i}-audio`);
            if(a && a.src && !a.src.endsWith("undefined") && a.src !== window.location.href) {
                audios.push(a);
            }
        }
        
        if(audios.length === 0) {
            alert("No tracks generated yet! Click 'SYNTHESIZE AUDIO' first.");
            return;
        }
        
        const anyPlaying = audios.some(a => !a.paused);
        audios.forEach(a => {
            const match = a.id.match(/\d+/);
            if(!match) return;
            const btn = document.querySelector(`.channel-play-btn[data-ch="${match[0]}"]`);
            
            if(anyPlaying) {
                a.pause();
                if(btn) btn.innerText = '▶️';
            } else {
                a.currentTime = 0;
                a.play().catch(e => console.error(e));
                if(btn) btn.innerText = '⏸️';
            }
        });
        return;
    }
});

const btnToggleMixer = document.getElementById('btnToggleMixer');
const mixerPanel = document.getElementById('dj-matrix-panel');
if (btnToggleMixer && mixerPanel) {
    btnToggleMixer.addEventListener('click', () => {
        const _nexusWorkspace = document.querySelector('.app-workspace');
        if (mixerPanel.style.display === 'none' || mixerPanel.style.display === '') {
            mixerPanel.style.display = 'flex';
            setTimeout(() => { if (_nexusWorkspace) _nexusWorkspace.scrollTop = _nexusWorkspace.scrollHeight; }, 50);
        } else {
            mixerPanel.style.display = 'none';
        }
    });
}

const btnToggleDialer = document.getElementById('btnToggleDialer');
const dialerPanel = document.getElementById('dialer-panel');
if (btnToggleDialer && dialerPanel) {
    btnToggleDialer.addEventListener('click', () => {
        const _nexusWorkspace = document.querySelector('.app-workspace');
        if (dialerPanel.style.display === 'none' || dialerPanel.style.display === '') {
            dialerPanel.style.display = 'block';
            setTimeout(() => { if (_nexusWorkspace) _nexusWorkspace.scrollTop = _nexusWorkspace.scrollHeight; }, 50);
        } else {
            dialerPanel.style.display = 'none';
        }
    });
}

const btnToggleCommandHub = document.getElementById('btnToggleCommandHub');
const commandHubContainer = document.getElementById('floatingCommandHubContainer');
if (btnToggleCommandHub && commandHubContainer) {
    btnToggleCommandHub.addEventListener('click', () => {
        if (commandHubContainer.style.display === 'none' || commandHubContainer.style.display === '') {
            commandHubContainer.style.display = 'block';
        } else {
            commandHubContainer.style.display = 'none';
        }
    });
}

// --- AGENT UPLINK FOR PASSIVE DOM & CROSS-TAB MEMORY ---
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'TAB_CONTEXT_SWITCH') {
            const contextMsg = `[SYSTEM MEMORY] User switched to a new tab: ${request.data.title} (${request.data.url}). Treat this as the new primary context. Do not discuss music or stems.`;
            window.lastPastedContext = contextMsg;
            if (audioConversation && typeof audioConversation.sendText === 'function') {
                audioConversation.sendText(contextMsg).catch(() => {});
            } else if (socket && socket.connected) {
                socket.emit('user_message', { text: contextMsg });
            }
        }
        
        if (request.action === 'PASSIVE_FORM_UPDATE') {
            const formMsg = `[SYSTEM MEMORY] A form or input field was just updated on ${request.data.title}. Assess if the user needs passive auto-fill assistance. Stay focused on the current page.`;
            if (audioConversation && typeof audioConversation.sendText === 'function') {
                audioConversation.sendText(formMsg).catch(() => {});
            } else if (socket && socket.connected) {
                socket.emit('user_message', { text: formMsg });
            }
        }
    });
}

// Evaluate HIPAA Eligibility based on BAA, Enterprise, and ZRM toggles
async function updateHipaaStatus() {
    const chkEnterprise = document.getElementById('chkEnterprisePlan');
    const chkBaa = document.getElementById('chkSignedBAA');
    const chkZrm = document.getElementById('chkZeroRetention');
    const badge = document.getElementById('hipaaStatusBadge');
    const warningBlock = document.getElementById('hipaaActiveWarning');

    if (!chkEnterprise || !chkBaa || !chkZrm || !badge) return;

    const isEnterprise = chkEnterprise.checked;
    const isBaa = chkBaa.checked;
    const isZrm = chkZrm.checked;

    const isFullyEligible = isEnterprise && isBaa && isZrm;

    if (isFullyEligible) {
        badge.innerText = "STATUS: HIPAA ELIGIBLE";
        badge.style.background = "rgba(0, 255, 65, 0.1)";
        badge.style.borderColor = "var(--neon)";
        badge.style.color = "var(--neon)";
        if (warningBlock) warningBlock.style.display = "block";
        await saveKey('extHipaaModeActive', 'true');
    } else {
        badge.innerText = "STATUS: NOT YET ELIGIBLE";
        badge.style.background = "rgba(255, 59, 48, 0.1)";
        badge.style.borderColor = "var(--alert)";
        badge.style.color = "var(--alert)";
        if (warningBlock) warningBlock.style.display = "none";
        await saveKey('extHipaaModeActive', 'false');
    }

    updateCustomLlmBaaVisibility(isFullyEligible);
}

// Toggle Custom LLM provider acknowledgment checkbox based on the selected LLM
function updateCustomLlmBaaVisibility(isHipaaModeActive) {
    const selectEl = document.getElementById('extLlmSelect');
    const customGroup = document.getElementById('customLlmAcknowledgeGroup');
    if (!selectEl || !customGroup) return;

    const val = selectEl.value;
    const preconfiguredHipaaList = [
        'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
        'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro',
        'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-haiku-4-5',
        'qwen36-35b-a3b', 'qwen35-397b-a17b'
    ];

    const isCustomModel = !preconfiguredHipaaList.includes(val);

    if (isCustomModel && isHipaaModeActive) {
        customGroup.style.display = 'block';
    } else {
        customGroup.style.display = 'none';
    }
}

/**
 * Executes a single pipeline call to retrieve, score, and draft replies for high-intent leads,
 * then appends them to the sidebar interface as clickable, copy-to-clipboard cards.
 */
window.executeRedditLeadHunter = async function(params = {}) {
    const broadMode = !!(params && params.broad_mode === true);
    appendTranscript('System', broadMode
        ? '🔍 Executing Monid automated pipeline: Broad mode — scoring entire popular feed...'
        : '🔍 Executing Monid automated pipeline: Scanning tech subreddits and compiling draft replies...');
    
    try {
        const monid_key = document.getElementById('extMonidKey')?.value || "";
        const gemini_key = document.getElementById('extGeminiKey')?.value || "";
        const grok_key = document.getElementById('extGrokKey')?.value || "";
        
        const body = { monid_key, gemini_key, grok_key };
        if (broadMode) {
            body.subreddit_filter = null;
            body.broad_mode = true;
        } else {
            body.subreddit_filter = [
                "chrome_extensions", "entrepreneur", "saas", "automation",
                "sideproject", "productivity", "webdev", "ai_agents"
            ];
        }

        const response = await fetch(`${SERVER_URL}/api/hunt-reddit-leads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const result = await response.json();
        if (!response.ok || !result.ok) {
            throw new Error(result.error || "Failed to process lead search.");
        }
        
        const leads = result.leads || [];
        if (leads.length === 0) {
            return broadMode
                ? "Executed successfully in broad mode, but no high-intent threads were found in the popular feed."
                : "Executed successfully, but no high-intent threads were found matching the whitelist.";
        }
        
        let htmlContent = `
            <div style="border: 1px dashed var(--border); border-radius: 8px; padding: 12px; background: rgba(0,0,0,0.25); margin-top: 10px; width: 100%; box-sizing: border-box;">
                <div style="font-family: 'Share Tech Mono', monospace; font-size: 0.75rem; color: var(--neon, #00FF41); margin-bottom: 10px; border-bottom: 1px dashed rgba(0,255,65,0.2); padding-bottom: 6px;">
                    🎯 HIGH-INTENT REDDIT LEADS
                </div>
        `;
        
        leads.forEach((lead) => {
            const safeDraft = btoa(unescape(encodeURIComponent(lead.draft_reply)));
            
            htmlContent += `
                <div class="reddit-lead-card" data-draft-content="${safeDraft}" style="border: 1px solid var(--border); border-radius: 6px; background: var(--panel, #0a0a0a); padding: 10px; margin-bottom: 10px; cursor: pointer; transition: transform 0.2s;">
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem; color: var(--neon, #00FF41); margin-bottom: 4px;">
                        <span><strong>r/${lead.subreddit}</strong></span>
                        <span style="color: #00E5FF;">Score: ${lead.score}</span>
                    </div>
                    <div style="font-size: 0.85rem; font-weight: bold; color: #fff; margin-bottom: 4px;">${lead.title}</div>
                    <p style="font-size: 0.75rem; color: #aaa; margin: 0 0 8px 0; line-height: 1.3;">${lead.text}</p>
                    <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: #666; margin-bottom: 8px;">
                        <span>💬 ${lead.comment_count} comments</span>
                        <a href="#" data-reddit-url="${lead.url}" class="open-reddit-thread" style="color: var(--neon, #00FF41); text-decoration: none;">Open Thread 🔗</a>
                    </div>
                    <div class="lead-reply-preview" style="margin-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 6px;">
                        <span class="lead-reply-label" style="font-size: 0.65rem; color: #00E5FF; font-weight: bold; display: block; margin-bottom: 2px;">DRAFT RESPONSE (CLICK CARD TO COPY):</span>
                        <p style="font-size: 0.75rem; color: #e0e0e0; margin: 0; font-style: italic; white-space: pre-wrap;">${lead.draft_reply}</p>
                    </div>
                </div>
            `;
        });
        
        htmlContent += `</div>`;
        appendTranscript('System', htmlContent, true);
        
        return `Successfully fetched and rendered ${leads.length} high-intent Reddit leads in the side panel window.`;
    } catch (err) {
        console.error("executeRedditLeadHunter failure:", err);
        return `Reddit lead hunter execution failed: ${err.message}`;
    }
};

// Open Reddit thread in a real browser tab (side-panel safe) — reject dead/mock links
document.addEventListener('click', (e) => {
    const openLink = e.target.closest('.open-reddit-thread');
    if (openLink) {
        e.preventDefault();
        e.stopPropagation();
        const url = (openLink.getAttribute('data-reddit-url') || '').trim();
        const isValidRedditThread = /^https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+/i.test(url);
        if (!isValidRedditThread) {
            const toast = document.createElement('div');
            toast.textContent = 'Dead link, skipped.';
            toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#ff3b30;border:1px solid #ff3b30;padding:8px 16px;border-radius:6px;font-size:0.8rem;z-index:99999;font-family:monospace;';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2200);
            return;
        }
        if (typeof chrome !== 'undefined' && chrome.tabs) {
            chrome.tabs.create({ url });
        } else {
            window.open(url, '_blank');
        }
        return;
    }
});

// Delegated clipboard copying handler for lead cards
document.addEventListener('click', (e) => {
    const leadCard = e.target.closest('.reddit-lead-card');
    if (leadCard && leadCard.hasAttribute('data-draft-content')) {
        const rawDraft = decodeURIComponent(escape(atob(leadCard.getAttribute('data-draft-content'))));
        navigator.clipboard.writeText(rawDraft).then(() => {
            const label = leadCard.querySelector('.lead-reply-label');
            if (label) {
                const originalText = label.innerText;
                label.innerText = "COPIED TO CLIPBOARD! ✅";
                label.style.color = "var(--neon, #00FF41)";
                setTimeout(() => {
                    label.innerText = originalText;
                    label.style.color = "#00E5FF";
                }, 2000);
            }
        });
    }
});

// Listener for Manual Hardcoded Monid Scraper Presets (Verified Native Monid Tools)
const btnRunMonidPreset = document.getElementById('btnRunMonidPreset');
if (btnRunMonidPreset) {
    btnRunMonidPreset.addEventListener('click', async () => {
        const presetKey = document.getElementById('extMonidPreset').value;
        const inputField = document.getElementById('extManualInject');
        const queryText = inputField.value.trim() || prompt(target.promptMsg || "Enter input query:", "WebRTC AI Agents");

        if (!queryText) return;

        const presetMap = {
            exa_search: { provider: "exa", endpoint: "/search", promptMsg: "Enter search query for Exa AI:" },
            apify_tweet: { provider: "apify", endpoint: "/apidojo/tweet-scraper", promptMsg: "Enter search keyword or hashtag for X/Twitter:" },
            youtube_transcript: { provider: "apify", endpoint: "/starvibe/youtube-video-transcript", promptMsg: "Enter YouTube video URL:" },
            apollo_company: { provider: "apollo", endpoint: "/mixed_companies/search", promptMsg: "Enter company keyword or industry:" },
            akta_company: { provider: "akta", endpoint: "/v1/company/search", promptMsg: "Enter company name or domain:" },
            elevenlabs_tts: { provider: "elevenlabs", endpoint: "/text-to-speech", promptMsg: "Enter text to convert to speech:" },
            apify_google_news: { provider: "apify", endpoint: "/data_xplorer/google-news-scraper-fast", promptMsg: "Enter news topic or query:" },
            gmaps_extractor: { provider: "apify", endpoint: "/compass/google-maps-extractor", promptMsg: "Enter location & query (e.g., 'Coffee shops in London'):" },
            bytedance_video: { provider: "bytedance", endpoint: "/v1/video/seedance-2.0-mini", promptMsg: "Enter video generation prompt:" },
            semrush_domain: { provider: "semrush", endpoint: "/domain_ranks", promptMsg: "Enter target domain (e.g. example.com):" },
            pdl_company: { provider: "peopledatalabs", endpoint: "/v5/company/enrich", promptMsg: "Enter company domain (e.g. stripe.com):" },
            apify_amazon: { provider: "apify", endpoint: "/trgar/amazon-search-scraper", promptMsg: "Enter Amazon product keyword:" }
        };

        const target = presetMap[presetKey];
        if (!target) return;

        appendTranscript('System', `⚡ Executing verified Monid preset: ${target.provider} -> ${target.endpoint} for query: "${queryText}"`);

        try {
            const mKey = document.getElementById('extMonidKey')?.value || '';
            const resp = await fetch(`${SERVER_URL}/api/monid/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: target.provider,
                    endpoint: target.endpoint,
                    input: { query: queryText },
                    await_result: true,
                    monid_key: mKey
                })
            });

            const result = await resp.json();
            const outputClean = result.output || result.data || result;
            appendTranscript('System', `✅ Distilled Scraper Result Received:\n${JSON.stringify(outputClean, null, 2).slice(0, 3000)}`);
        } catch (err) {
            appendTranscript('Error', `Preset execution failed: ${err.message}`);
        }
    });
}