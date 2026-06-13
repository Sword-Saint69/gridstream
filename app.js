'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
    channels:       [],
    playlists:      [],
    activePlaylist: null,
    activeChannel:  null,
    player:         null,
    stallInterval:  null,
    stallCount:     0,
    lastTime:       -1,
    hasStarted:     false,
};

// ── DOM ───────────────────────────────────────────────────────────────────────

const videoEl         = document.getElementById('video-ch1');
const errorOverlay    = document.getElementById('ch1-error-overlay');
const spinnerOverlay  = document.getElementById('ch1-spinner');
const labelTitle      = document.getElementById('label-ch1-title');
const statResolution  = document.getElementById('stat-resolution');
const channelList     = document.getElementById('m3u-channel-list');
const searchInput     = document.getElementById('channel-search');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const appSidebar      = document.getElementById('app-sidebar');
const playlistTabs    = document.getElementById('playlist-tabs');

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHTML(str) {
    if (!str) return '';
    return str.toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseStreamUrl(raw) {
    if (!raw) return { url: '', cookie: '' };
    const parts = raw.split('|cookie=');
    return { url: parts[0].trim(), cookie: parts[1] ? parts[1].trim() : '' };
}

function getProxyUrl(url) {
    if (url.startsWith('http://'))  return window.location.origin + '/proxy/http/'  + url.slice(7);
    if (url.startsWith('https://')) return window.location.origin + '/proxy/https/' + url.slice(8);
    return url;
}


function setStreamCookie(cookieString, targetUrl) {
    if (!cookieString) return;
    const eqIdx = cookieString.indexOf('=');
    if (eqIdx === -1) return;
    const key = cookieString.slice(0, eqIdx).trim();
    const val = cookieString.slice(eqIdx + 1).trim();
    let domain = '';
    try { domain = `; domain=${new URL(targetUrl).hostname}`; } catch (_) {}
    document.cookie = `${key}=${val}${domain}; path=/; SameSite=None; Secure`;
}

// ── Volume Persistence ────────────────────────────────────────────────────────

function loadVolume() {
    try {
        videoEl.volume = parseFloat(localStorage.getItem('gs_volume') ?? '1');
        videoEl.muted  = localStorage.getItem('gs_muted') === 'true';
    } catch (_) {}
}

videoEl.addEventListener('volumechange', () => {
    try {
        localStorage.setItem('gs_volume', videoEl.volume);
        localStorage.setItem('gs_muted',  videoEl.muted);
    } catch (_) {}
});

// ── Spinner / Buffering ───────────────────────────────────────────────────────

function showSpinner() { if (spinnerOverlay) spinnerOverlay.classList.remove('hidden'); }
function hideSpinner() { if (spinnerOverlay) spinnerOverlay.classList.add('hidden'); }

videoEl.addEventListener('waiting',  showSpinner);
videoEl.addEventListener('stalled',  showSpinner);
videoEl.addEventListener('playing',  hideSpinner);
videoEl.addEventListener('canplay',  hideSpinner);

// ── Stall Monitor ─────────────────────────────────────────────────────────────

function startStallMonitor() {
    if (state.stallInterval) clearInterval(state.stallInterval);
    state.lastTime  = -1;
    state.stallCount = 0;
    state.hasStarted = false;

    state.stallInterval = setInterval(() => {
        if (!videoEl || videoEl.paused || videoEl.ended || videoEl.readyState < 2) {
            state.stallCount = 0;
            return;
        }
        if (videoEl.currentTime > 0) state.hasStarted = true;
        if (!state.hasStarted) return;

        if (videoEl.currentTime === state.lastTime) {
            state.stallCount++;
            if (state.stallCount >= 8) {
                console.warn('[Stall] reconnecting');
                state.stallCount = 0;
                initPlayer();
            }
        } else {
            state.stallCount = 0;
            state.lastTime   = videoEl.currentTime;
        }
    }, 1000);
}

// ── Player ────────────────────────────────────────────────────────────────────

function destroyPlayer() {
    if (state.stallInterval) { clearInterval(state.stallInterval); state.stallInterval = null; }
    if (state.player) { try { state.player.destroy(); } catch (_) {} state.player = null; }
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
}

function initPlayer() {
    if (!state.activeChannel) return;
    destroyPlayer();
    showSpinner();

    const parsed    = parseStreamUrl(state.activeChannel.url);
    errorOverlay.classList.add('hidden');
    videoEl.classList.remove('hidden');

    const iframe = document.getElementById('iframe-player');
    if (iframe) { iframe.classList.add('hidden'); iframe.src = ''; }

    if (!parsed.url) { errorOverlay.classList.remove('hidden'); hideSpinner(); return; }

    let streamUrl = parsed.url;
    if (window.location.protocol === 'http:' && streamUrl.startsWith('https://')) {
        streamUrl = streamUrl.replace(/^https:\/\//i, 'http://').replace(/:443\//, '/');
    }
    streamUrl = getProxyUrl(streamUrl);
    if (parsed.cookie) setStreamCookie(parsed.cookie, streamUrl);

    labelTitle.innerText   = state.activeChannel.name;
    statResolution.innerText = 'Loading...';

    const cleanUrl = streamUrl.split('?')[0].split('#')[0].toLowerCase();

    if (cleanUrl.endsWith('.html')) {
        videoEl.classList.add('hidden');
        if (iframe) { iframe.src = streamUrl; iframe.classList.remove('hidden'); }
        statResolution.innerText = 'External Embed';
        hideSpinner();
        return;
    }

    if (cleanUrl.endsWith('.m3u8') || cleanUrl.endsWith('.m3u')) {
        if (typeof Hls !== 'undefined' && Hls.isSupported()) { loadHls(streamUrl); return; }
        if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            videoEl.src = streamUrl; videoEl.play().catch(() => {}); startStallMonitor(); return;
        }
        errorOverlay.classList.remove('hidden'); hideSpinner(); return;
    }

    if (cleanUrl.endsWith('.ts') || /\/\d+$/.test(cleanUrl)) {
        if (typeof mpegts !== 'undefined' && mpegts.getFeatureList().mseLivePlayback) {
            loadMpegts(streamUrl); return;
        }
    }

    if (typeof shaka !== 'undefined') { shaka.polyfill.installAll(); }
    if (typeof shaka !== 'undefined' && shaka.Player.isBrowserSupported()) {
        loadShaka(streamUrl, parsed.url);
    } else {
        loadHls(streamUrl);
    }
}

function loadMpegts(url) {
    const player = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url },
        { enableWorker: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 5, liveBufferLatencyMinRemain: 1, stashInitialSize: 384 }
    );
    player.attachMediaElement(videoEl);
    player.load();
    state.player = player;
    statResolution.innerText = 'MPEG-TS Live';
    startStallMonitor();
    player.on(mpegts.Events.ERROR, (type, detail) => {
        if (detail && detail.fatal) { errorOverlay.classList.remove('hidden'); hideSpinner(); }
    });
    videoEl.play().catch(() => {});
}

function loadHls(url) {
    const hls = new Hls({ enableWorker: true, maxBufferLength: 10, liveSyncDurationCount: 2 });
    hls.loadSource(url);
    hls.attachMedia(videoEl);
    state.player = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoEl.play().catch(() => {});
        statResolution.innerText = 'HLS Live';
        startStallMonitor();
    });
    hls.on(Hls.Events.ERROR, (e, data) => {
        if (data.fatal) { errorOverlay.classList.remove('hidden'); hideSpinner(); }
    });
}

function loadShaka(url, originalUrl) {
    const player = new shaka.Player();
    state.player = player;
    player.configure({ streaming: { bufferingGoal: 10, rebufferingGoal: 2, stallEnabled: true } });
    let mime = null;
    if (/\.(m3u8?)$/i.test(originalUrl.split('?')[0])) mime = 'application/x-mpegurl';
    player.attach(videoEl)
        .then(() => player.load(url, null, mime))
        .then(() => { videoEl.play().catch(() => {}); statResolution.innerText = 'HLS'; startStallMonitor(); })
        .catch(() => loadHls(url));
}

// ── Resolution display ────────────────────────────────────────────────────────

setInterval(() => {
    if (videoEl.readyState > 0 && state.activeChannel && videoEl.videoWidth > 0)
        statResolution.innerText = `${videoEl.videoWidth}×${videoEl.videoHeight}`;
}, 2000);

// ── Health Check ──────────────────────────────────────────────────────────────

async function checkHealth(url) {
    try {
        const r = await fetch(`/health?url=${encodeURIComponent(url)}`);
        return (await r.json()).ok;
    } catch (_) { return false; }
}

// ── Channel Selection ─────────────────────────────────────────────────────────

function selectChannel(ch) {
    state.activeChannel = ch;
    try { localStorage.setItem('gs_last_channel', JSON.stringify({ id: ch.id, url: ch.url })); } catch (_) {}
    initPlayer();
    document.querySelectorAll('#m3u-channel-list .channel-opt-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-channel-id="${ch.id}"]`)?.classList.add('active');
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderPlaylists() {
    if (!playlistTabs) return;
    playlistTabs.innerHTML = '';
    state.playlists.forEach(pl => {
        const tab = document.createElement('button');
        tab.className = 'playlist-tab' + (state.activePlaylist?.id === pl.id ? ' active' : '');
        tab.textContent = pl.name;
        tab.title = pl.name;
        tab.addEventListener('click', () => {
            state.activePlaylist = pl;
            renderPlaylists();
            loadChannels(pl.id);
        });
        if (state.playlists.length > 1) {
            const del = document.createElement('span');
            del.innerHTML = ' ×';
            del.style.cssText = 'opacity:0.5;font-size:0.7rem;margin-left:4px;';
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete playlist "${pl.name}"?`)) return;
                await fetch(`/api/playlists/${pl.id}`, { method: 'DELETE' });
                loadPlaylists();
            });
            tab.appendChild(del);
        }
        playlistTabs.appendChild(tab);
    });
}

function renderChannels(channels) {
    channelList.innerHTML = '';
    if (!channels.length) {
        channelList.innerHTML = `
            <div style="text-align:center;padding:30px 10px;">
                <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:15px;">No channels found.</p>
                <a href="/add" class="settings-btn" style="display:inline-flex;justify-content:center;margin:0 auto;">Upload M3U</a>
            </div>`;
        return;
    }

    const groups = {};
    channels.forEach(ch => { const g = ch.group || 'General'; (groups[g] = groups[g] || []).push(ch); });

    for (const [groupName, chs] of Object.entries(groups)) {
        const hdr = document.createElement('div');
        hdr.className = 'channel-group-header';
        hdr.innerText = groupName;
        channelList.appendChild(hdr);

        chs.forEach(ch => {
            const btn = document.createElement('button');
            btn.className = 'channel-opt-btn';
            btn.dataset.channelId = ch.id;
            if (state.activeChannel?.id === ch.id) btn.classList.add('active');

            const logoHtml = `<div style="width:24px;height:24px;border-radius:4px;background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;font-size:0.6rem;font-weight:800;color:var(--text-muted);">TV</div>`;

            btn.innerHTML = `
                ${logoHtml}
                <div class="opt-details" style="flex:1;min-width:0;">
                    <span class="opt-title ch-name" style="font-size:0.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${escapeHTML(ch.name)}</span>
                    <span class="opt-desc" style="font-size:0.65rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;opacity:0.5;">${escapeHTML(ch.group || '')}</span>
                </div>
                <div class="ch-actions" style="display:flex;gap:4px;flex-shrink:0;">
                    <span class="ch-edit-btn" title="Edit" style="font-size:0.7rem;opacity:0.5;padding:2px 4px;cursor:pointer;">✏️</span>
                    <span class="ch-del-btn"  title="Delete" style="font-size:0.7rem;opacity:0.5;padding:2px 4px;cursor:pointer;">🗑</span>
                </div>`;

            btn.querySelector('.ch-del-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete "${ch.name}"?`)) return;
                await fetch(`/api/channels/${ch.id}`, { method: 'DELETE' });
                state.channels = state.channels.filter(c => c.id !== ch.id);
                renderChannels(state.channels);
            });

            btn.querySelector('.ch-edit-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                startInlineEdit(btn, ch);
            });

            btn.addEventListener('click', () => selectChannel(ch));
            channelList.appendChild(btn);
        });
    }
}

function startInlineEdit(btn, ch) {
    const nameEl = btn.querySelector('.ch-name');
    const oldName = ch.name;
    nameEl.contentEditable = 'true';
    nameEl.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(nameEl);

    const save = async () => {
        nameEl.contentEditable = 'false';
        const newName = nameEl.textContent.trim() || oldName;
        nameEl.textContent = newName;
        if (newName !== oldName) {
            ch.name = newName;
            await fetch(`/api/channels/${ch.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName, url: ch.url, logo: ch.logo, group: ch.group, tvg_id: ch.tvg_id })
            });
        }
    };

    nameEl.addEventListener('blur',    save, { once: true });
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
}

// ── Data Loading ──────────────────────────────────────────────────────────────

async function loadPlaylists() {
    const r = await fetch('/api/playlists');
    state.playlists = await r.json();
    if (!state.activePlaylist) state.activePlaylist = state.playlists[0];
    renderPlaylists();
    loadChannels(state.activePlaylist?.id);
}

async function loadChannels(playlistId) {
    const url = playlistId ? `/api/channels?playlist_id=${playlistId}` : '/api/channels';
    try {
        const r = await fetch(url);
        state.channels = await r.json();
        renderChannels(state.channels);

        // Restore last channel
        let restored = false;
        try {
            const last = JSON.parse(localStorage.getItem('gs_last_channel') || 'null');
            if (last) {
                const ch = state.channels.find(c => c.id === last.id || c.url === last.url);
                if (ch) { selectChannel(ch); restored = true; }
            }
        } catch (_) {}

        if (!restored && state.channels.length > 0) selectChannel(state.channels[0]);
    } catch (err) {
        channelList.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);text-align:center;padding:20px;">Failed to load channels.</p>';
    }
}

// ── Latency Sort ──────────────────────────────────────────────────────────────

const btnSortQuality = document.getElementById('btn-sort-quality');
let sortingActive = false;

btnSortQuality?.addEventListener('click', async () => {
    if (sortingActive) return;
    sortingActive = true;
    btnSortQuality.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btnSortQuality.disabled = true;

    // Clear old badges
    document.querySelectorAll('.latency-badge').forEach(el => el.remove());

    const urls = state.channels.map(ch => ch.url);

    try {
        const r = await fetch('/api/latency', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
        });
        const results = await r.json(); // already sorted by latency

        // Build latency map
        const latencyMap = {};
        results.forEach(res => { latencyMap[res.url] = res; });

        // Re-order state.channels by the sorted results
        const urlOrder = results.map(r => r.url);
        state.channels.sort((a, b) => {
            const ai = urlOrder.indexOf(a.url);
            const bi = urlOrder.indexOf(b.url);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        // Re-render with latency badges
        renderChannels(state.channels);

        // Inject badges after render
        state.channels.forEach(ch => {
            const btn  = document.querySelector(`[data-channel-id="${ch.id}"]`);
            if (!btn) return;
            const info = latencyMap[ch.url];
            if (!info) return;

            const badge = document.createElement('span');
            badge.className = 'latency-badge';
            const ms = info.latency;
            if (!info.ok || ms === null) {
                badge.textContent = 'dead';
                badge.style.cssText = 'font-size:0.6rem;padding:2px 5px;border-radius:8px;background:rgba(231,76,60,0.2);color:#e74c3c;flex-shrink:0;';
            } else {
                badge.textContent = ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`;
                const color = ms < 500 ? '#2ecc71' : ms < 2000 ? '#f39c12' : '#e74c3c';
                badge.style.cssText = `font-size:0.6rem;padding:2px 5px;border-radius:8px;background:${color}22;color:${color};flex-shrink:0;`;
            }
            btn.querySelector('.ch-actions')?.before(badge);
        });

    } catch (err) {
        console.error('Latency check failed', err);
    }

    btnSortQuality.innerHTML = '<i class="fa-solid fa-signal"></i>';
    btnSortQuality.disabled = false;
    sortingActive = false;
});

// ── Search ────────────────────────────────────────────────────────────────────

searchInput?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    renderChannels(q ? state.channels.filter(ch =>
        ch.name.toLowerCase().includes(q) || (ch.group || '').toLowerCase().includes(q)
    ) : state.channels);
});

// ── Keyboard Shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Ignore when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.contentEditable === 'true') return;

    switch (e.key) {
        case ' ':
        case 'k':
            e.preventDefault();
            videoEl.paused ? videoEl.play().catch(() => {}) : videoEl.pause();
            break;
        case 'f':
        case 'F':
            e.preventDefault();
            if (!document.fullscreenElement) {
                videoEl.requestFullscreen?.() || videoEl.webkitRequestFullscreen?.();
            } else {
                document.exitFullscreen?.();
            }
            break;
        case 'm':
        case 'M':
            videoEl.muted = !videoEl.muted;
            break;
        case 'ArrowUp': {
            e.preventDefault();
            const idx = state.channels.indexOf(state.activeChannel);
            if (idx > 0) selectChannel(state.channels[idx - 1]);
            break;
        }
        case 'ArrowDown': {
            e.preventDefault();
            const idx = state.channels.indexOf(state.activeChannel);
            if (idx < state.channels.length - 1) selectChannel(state.channels[idx + 1]);
            break;
        }
    }
});

// ── Sidebar Toggle ────────────────────────────────────────────────────────────

btnToggleSidebar?.addEventListener('click', () => {
    appSidebar?.classList.toggle('collapsed');
    btnToggleSidebar.classList.toggle('active');
});

// ── Fullscreen Buttons ────────────────────────────────────────────────────────

document.querySelectorAll('.fullscreen-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        const video = document.getElementById(this.dataset.target);
        video?.requestFullscreen?.() || video?.webkitRequestFullscreen?.();
    });
});

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    loadVolume();
    loadPlaylists();
});
