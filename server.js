'use strict';

process.on('uncaughtException',  err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const express     = require('express');
const Database    = require('better-sqlite3');
const http        = require('http');
const https       = require('https');
const path        = require('path');
const compression = require('compression');

const PORT    = process.env.PORT || 8085;
const DB_FILE = path.join(__dirname, 'gridstream.db');

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database(DB_FILE);
db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        epg_url    TEXT DEFAULT '',
        created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS channels (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        url         TEXT NOT NULL,
        logo        TEXT DEFAULT '',
        group_name  TEXT DEFAULT 'General',
        tvg_id      TEXT DEFAULT '',
        playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE
    );
`);

// Safe migrations for existing DBs
for (const sql of [
    `ALTER TABLE channels ADD COLUMN tvg_id TEXT DEFAULT ''`,
    `ALTER TABLE channels ADD COLUMN playlist_id INTEGER`,
]) { try { db.exec(sql); } catch (_) {} }

// Ensure a Default playlist exists and adopt orphan channels
db.exec(`INSERT OR IGNORE INTO playlists (id, name) VALUES (1, 'Default')`);
db.exec(`UPDATE channels SET playlist_id = 1 WHERE playlist_id IS NULL`);

const stmt = {
    allChannels:    db.prepare(`SELECT id, name, url, logo, group_name AS "group", tvg_id, playlist_id FROM channels ORDER BY id ASC`),
    channelsByList: db.prepare(`SELECT id, name, url, logo, group_name AS "group", tvg_id, playlist_id FROM channels WHERE playlist_id = ? ORDER BY id ASC`),
    insertChannel:  db.prepare(`INSERT INTO channels (name, url, logo, group_name, tvg_id, playlist_id) VALUES (?, ?, ?, ?, ?, ?)`),
    updateChannel:  db.prepare(`UPDATE channels SET name=?, url=?, logo=?, group_name=?, tvg_id=? WHERE id=?`),
    deleteChannel:  db.prepare(`DELETE FROM channels WHERE id=?`),
    clearPlaylist:  db.prepare(`DELETE FROM channels WHERE playlist_id=?`),
    allPlaylists:   db.prepare(`SELECT id, name, epg_url FROM playlists ORDER BY id ASC`),
    insertPlaylist: db.prepare(`INSERT INTO playlists (name, epg_url) VALUES (?, ?)`),
    deletePlaylist: db.prepare(`DELETE FROM playlists WHERE id=?`),
    renamePlaylist: db.prepare(`UPDATE playlists SET name=? WHERE id=?`),
};

function saveChannels(channels, playlistId, append) {
    const tx = db.transaction((chs) => {
        if (!append) stmt.clearPlaylist.run(playlistId);
        for (const ch of chs)
            stmt.insertChannel.run(ch.name, ch.url, ch.logo || '', ch.group || 'General', ch.tvg_id || '', playlistId);
    });
    tx(channels);
}

// ── M3U Parser ────────────────────────────────────────────────────────────────

function parseM3U(content) {
    const channels = [];
    let epgUrl = '';
    const lines = content.split(/\r?\n/);
    let current = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('#EXTM3U')) {
            const m = line.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/i);
            if (m) epgUrl = m[1];
            continue;
        }

        if (line.startsWith('#EXTINF:')) {
            current = {};
            const logoM  = line.match(/tvg-logo="([^"]+)"/);
            const groupM = line.match(/group-title="([^"]+)"/);
            const tvgId  = line.match(/tvg-id="([^"]+)"/);
            const nameI  = line.lastIndexOf(',');
            current.logo   = logoM  ? logoM[1]  : '';
            current.group  = groupM ? groupM[1] : 'General';
            current.tvg_id = tvgId  ? tvgId[1]  : '';
            current.name   = nameI !== -1 ? line.slice(nameI + 1).trim() : 'Unnamed';
        } else if (!line.startsWith('#') && current) {
            current.url = line;
            channels.push(current);
            current = null;
        }
    }
    return { channels, epgUrl };
}

// ── Redirect Cache ─────────────────────────────────────────────────────────────

const redirectCache  = new Map();
const REDIRECT_TTL   = 5 * 60 * 1000; // 5 minutes

function getCachedRedirect(url) {
    const entry = redirectCache.get(url);
    if (!entry) return null;
    if (Date.now() > entry.expires) { redirectCache.delete(url); return null; }
    return entry.target;
}

function setCachedRedirect(url, target) {
    redirectCache.set(url, { target, expires: Date.now() + REDIRECT_TTL });
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

const PROXY_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection':      'keep-alive',
};

const MAX_RETRIES   = 10;
const MAX_REDIRECTS = 5;

function rewriteM3U(body, base) {
    return body.split(/\r?\n/).map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        let abs = /^https?:\/\//i.test(t) ? t : base + t;
        if (/^http:\/\//i.test(abs))  return '/proxy/http/'  + abs.slice(7);
        if (/^https:\/\//i.test(abs)) return '/proxy/https/' + abs.slice(8);
        return line;
    }).join('\n');
}

function fetchUrl(targetUrl, extraHeaders, cb) {
    const parsed   = new URL(targetUrl);
    const useHttps = parsed.protocol === 'https:';
    const lib      = useHttps ? https : http;
    const options  = {
        hostname: parsed.hostname,
        port:     parsed.port || (useHttps ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { ...PROXY_HEADERS, ...extraHeaders },
        rejectUnauthorized: false,
    };
    const req = lib.request(options, cb);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', cb);
    req.end();
    return req;
}

function proxyStream(originalUrl, clientReq, clientRes, redirects = 0, retries = 0) {
    if (clientRes.destroyed || clientRes.writableEnded) return;

    // Hard stop on too many retries
    if (retries >= MAX_RETRIES) {
        console.warn(`[Proxy] max retries reached for ${originalUrl}`);
        if (!clientRes.headersSent) clientRes.status(503).send('Stream unavailable after max retries');
        else clientRes.end();
        return;
    }

    // Use cached redirect target if available
    const cached = getCachedRedirect(originalUrl);
    const targetUrl = cached || originalUrl;

    const extraHeaders = {};
    if (clientReq.headers['range']) extraHeaders['Range'] = clientReq.headers['range'];

    const upReq = fetchUrl(targetUrl, extraHeaders, (upRes) => {
        if (upRes instanceof Error) {
            console.error(`[Proxy] error: ${upRes.message}`);
            if (!clientRes.headersSent) {
                clientRes.set('Access-Control-Allow-Origin', '*');
                clientRes.status(502).send(upRes.message);
            } else {
                setTimeout(() => proxyStream(originalUrl, clientReq, clientRes, 0, retries + 1), 1000);
            }
            return;
        }

        const status = upRes.statusCode;
        const ct     = upRes.headers['content-type'] || 'application/octet-stream';
        console.log(`[Proxy] ${status} ${ct} → ${targetUrl}`);

        // Follow redirects and cache the destination
        if ([301, 302, 303, 307, 308].includes(status)) {
            if (redirects >= MAX_REDIRECTS) { clientRes.status(502).send('Too many redirects'); return; }
            const loc = upRes.headers['location'];
            if (!loc) { clientRes.status(502).send('Redirect with no location'); return; }
            upRes.resume();
            const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, targetUrl).href;
            setCachedRedirect(originalUrl, next);
            console.log(`[Proxy] redirect (cached) → ${next}`);
            return proxyStream(originalUrl, clientReq, clientRes, redirects + 1, retries);
        }

        if (status >= 400) {
            // Invalidate cache on 4xx so next request tries fresh
            redirectCache.delete(originalUrl);
            if (!clientRes.headersSent) {
                clientRes.set('Access-Control-Allow-Origin', '*');
                clientRes.status(status).send(`Upstream ${status}`);
            }
            return;
        }

        const isPlaylist = /mpegurl/i.test(ct) || /\.(m3u8?)(\?|$)/i.test(targetUrl);

        if (isPlaylist) {
            let body = '';
            upRes.setEncoding('utf8');
            upRes.on('data', c => { body += c; });
            upRes.on('end', () => {
                const base      = targetUrl.replace(/\/[^/?]*(\?.*)?$/, '/');
                const rewritten = rewriteM3U(body, base);
                clientRes.set({ 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
                clientRes.send(rewritten);
            });
            return;
        }

        // Live stream — pipe directly
        if (!clientRes.headersSent) {
            clientRes.set({
                'Content-Type':          ct,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control':         'no-cache',
                'X-Accel-Buffering':     'no',
            });
            clientRes.status(status);
        }

        upRes.pipe(clientRes, { end: false });

        upRes.once('end', () => {
            if (!clientRes.destroyed && !clientRes.writableEnded) {
                console.log(`[Proxy] upstream closed, retry ${retries + 1}/${MAX_RETRIES}`);
                setTimeout(() => proxyStream(originalUrl, clientReq, clientRes, 0, retries + 1), 500);
            }
        });

        upRes.once('error', () => {
            if (!clientRes.destroyed && !clientRes.writableEnded)
                setTimeout(() => proxyStream(originalUrl, clientReq, clientRes, 0, retries + 1), 500);
        });
    });

    clientReq.once('close', () => upReq.destroy());
}

// ── Express App ───────────────────────────────────────────────────────────────

const app = express();
app.use(compression());
app.use(express.json());

// Raw body for non-JSON POST
app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if ((req.headers['content-type'] || '').includes('multipart/form-data')) return next();
    if ((req.headers['content-type'] || '').includes('application/json')) return next();
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => { data += c; });
    req.on('end', () => { req.rawBody = data; next(); });
});

// Static files with cache headers
const STATIC_CACHE = 'public, max-age=3600';
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/add',        (req, res) => res.sendFile(path.join(__dirname, 'add.html')));
app.get('/styles.css', (req, res) => res.set('Cache-Control', STATIC_CACHE).sendFile(path.join(__dirname, 'styles.css')));
app.get('/app.js',     (req, res) => res.set('Cache-Control', STATIC_CACHE).sendFile(path.join(__dirname, 'app.js')));

// ── Health / Latency ──────────────────────────────────────────────────────────

function measureLatency(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const t0  = Date.now();
        const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, latency: null, error: 'timeout' }); }, timeoutMs);
        const req = fetchUrl(url, {}, (upRes) => {
            if (upRes instanceof Error) { clearTimeout(timer); return resolve({ ok: false, latency: null, error: upRes.message }); }
            const latency = Date.now() - t0;
            const status  = upRes.statusCode;
            upRes.destroy(); // don't download the body
            clearTimeout(timer);
            const ok = status < 400 || [301,302,303,307,308].includes(status);
            resolve({ ok, latency, status, contentType: upRes.headers['content-type'] || '' });
        });
    });
}

app.get('/health', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ ok: false, error: 'No url' });
    res.json(await measureLatency(url));
});

// Bulk latency check — body: { urls: [...] }
// Checks up to 50 URLs concurrently and returns sorted results
app.post('/api/latency', async (req, res) => {
    const urls = (req.body?.urls || []).slice(0, 50);
    if (!urls.length) return res.json([]);

    const results = await Promise.all(
        urls.map(async (url) => {
            const r = await measureLatency(url);
            return { url, ...r };
        })
    );

    // Sort: working streams first by latency, failed last
    results.sort((a, b) => {
        if (a.ok && !b.ok) return -1;
        if (!a.ok && b.ok) return  1;
        return (a.latency ?? 99999) - (b.latency ?? 99999);
    });

    res.json(results);
});

// ── Playlists API ─────────────────────────────────────────────────────────────

app.get('/api/playlists', (req, res) => res.json(stmt.allPlaylists.all()));

app.post('/api/playlists', (req, res) => {
    const { name = 'New Playlist', epg_url = '' } = req.body || {};
    const info = stmt.insertPlaylist.run(name, epg_url);
    res.json({ id: info.lastInsertRowid, name, epg_url });
});

app.put('/api/playlists/:id', (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    stmt.renamePlaylist.run(name, req.params.id);
    res.json({ ok: true });
});

app.delete('/api/playlists/:id', (req, res) => {
    if (req.params.id == 1) return res.status(400).json({ error: 'Cannot delete Default playlist' });
    stmt.deletePlaylist.run(req.params.id);
    res.json({ ok: true });
});

// ── Channels API ──────────────────────────────────────────────────────────────

app.get('/api/channels', (req, res) => {
    const pid = req.query.playlist_id;
    res.json(pid ? stmt.channelsByList.all(pid) : stmt.allChannels.all());
});

app.put('/api/channels/:id', (req, res) => {
    const { name, url, logo = '', group = 'General', tvg_id = '' } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    stmt.updateChannel.run(name, url, logo, group, tvg_id, req.params.id);
    res.json({ ok: true });
});

app.delete('/api/channels/:id', (req, res) => {
    stmt.deleteChannel.run(req.params.id);
    res.json({ ok: true });
});

// ── Upload API ────────────────────────────────────────────────────────────────

app.post('/api/upload', (req, res) => {
    const append     = req.query.append === 'true';
    const playlistId = parseInt(req.query.playlist_id) || 1;
    const ct         = req.headers['content-type'] || '';

    const finish = (content) => {
        const { channels, epgUrl } = parseM3U(content);
        if (!channels.length) return res.status(400).json({ success: false, message: 'No valid M3U streams found.' });
        // Store epg_url on playlist if found
        if (epgUrl) db.prepare(`UPDATE playlists SET epg_url=? WHERE id=?`).run(epgUrl, playlistId);
        saveChannels(channels, playlistId, append);
        res.json({ success: true, message: `Parsed ${channels.length} streams.`, epgUrl });
    };

    if (ct.includes('multipart/form-data')) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const raw     = Buffer.concat(chunks).toString('utf8');
            const bMatch  = ct.match(/boundary=(.+)/);
            if (!bMatch) return res.status(400).json({ success: false, message: 'No boundary' });
            const boundary = '--' + bMatch[1];
            const parts    = raw.split(boundary).slice(1, -1);
            for (const part of parts) {
                const [header, ...bodyParts] = part.split('\r\n\r\n');
                if (header.includes('filename=')) {
                    return finish(bodyParts.join('\r\n\r\n').replace(/\r\n$/, ''));
                }
            }
            res.status(400).json({ success: false, message: 'No file in upload.' });
        });
        return;
    }

    finish(req.rawBody || '');
});

// ── Stream Proxy ──────────────────────────────────────────────────────────────

app.get('/proxy/*', (req, res) => {
    const raw = req.params[0];
    let targetUrl;
    if (raw.startsWith('http/'))       targetUrl = 'http://'  + raw.slice(5);
    else if (raw.startsWith('https/')) targetUrl = 'https://' + raw.slice(6);
    else                               targetUrl = 'http://'  + raw;

    if (req.query && Object.keys(req.query).length) {
        targetUrl += '?' + new URLSearchParams(req.query).toString();
    }

    console.log(`[Proxy] → ${targetUrl}`);
    proxyStream(targetUrl, req, res);
});

// ── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => console.log(`GridStream running on http://localhost:${PORT}`));
server.on('error', err => console.error('[Server error]', err));
