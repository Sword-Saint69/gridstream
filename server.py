import os
import json
import re
from flask import Flask, request, jsonify, render_template_string, send_from_directory, Response
import urllib.request
import requests as req_lib

app = Flask(__name__, static_folder='.')
PORT = 8085
import sqlite3

DB_FILE = 'gridstream.db'

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            logo TEXT,
            group_name TEXT
        )
    ''')
    conn.commit()
    conn.close()

def get_channels():
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT name, url, logo, group_name AS "group" FROM channels ORDER BY id ASC')
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"Error fetching from database: {e}")
        return []

def save_channels(channels, append=False):
    try:
        conn = get_db()
        cursor = conn.cursor()
        if not append:
            cursor.execute('DELETE FROM channels')
        for ch in channels:
            cursor.execute(
                'INSERT INTO channels (name, url, logo, group_name) VALUES (?, ?, ?, ?)',
                (ch['name'], ch['url'], ch.get('logo', ''), ch.get('group', 'General'))
            )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error saving to database: {e}")

def parse_m3u_content(content):
    channels = []
    lines = content.splitlines()
    current_ch = None
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("#EXTINF:"):
            current_ch = {}
            # Parse logo
            logo_match = re.search(r'tvg-logo="([^"]+)"', line)
            current_ch['logo'] = logo_match.group(1) if logo_match else ""
            
            # Parse group title
            group_match = re.search(r'group-title="([^"]+)"', line)
            current_ch['group'] = group_match.group(1) if group_match else "General"
            
            # Parse name
            comma_idx = line.rfind(',')
            if comma_idx != -1:
                current_ch['name'] = line[comma_idx + 1:].strip()
            else:
                name_match = re.search(r'tvg-name="([^"]+)"', line)
                current_ch['name'] = name_match.group(1) if name_match else "Unnamed Stream"
        elif not line.startswith("#"):
            if current_ch is not None:
                current_ch['url'] = line
                channels.append(current_ch)
                current_ch = None
                
    return channels

@app.route('/')
def index():
    # Read index.html directly from file
    with open('index.html', 'r', encoding='utf-8') as f:
        return f.read()

@app.route('/add')
def add():
    # Read add.html directly from file
    with open('add.html', 'r', encoding='utf-8') as f:
        return f.read()

@app.route('/styles.css')
def styles():
    return send_from_directory('.', 'styles.css')

@app.route('/app.js')
def app_js():
    return send_from_directory('.', 'app.js')

@app.route('/api/channels', methods=['GET'])
def api_channels():
    return jsonify(get_channels())

@app.route('/api/upload', methods=['POST'])
def api_upload():
    append = request.args.get('append', 'false').lower() == 'true'
    
    if 'file' in request.files:
        file = request.files['file']
        if file.filename == '':
            return jsonify({"success": False, "message": "No selected file"}), 400
        try:
            content = file.read().decode('utf-8', errors='ignore')
            channels = parse_m3u_content(content)
            save_channels(channels, append=append)
            return jsonify({"success": True, "message": f"Successfully parsed {len(channels)} streams."})
        except Exception as e:
            return jsonify({"success": False, "message": f"Error parsing file: {str(e)}"}), 500
            
    # Fallback to raw text body if they posted M3U content directly
    try:
        content = request.data.decode('utf-8', errors='ignore')
        channels = parse_m3u_content(content)
        if channels:
            save_channels(channels, append=append)
            return jsonify({"success": True, "message": f"Successfully parsed {len(channels)} streams."})
        return jsonify({"success": False, "message": "No valid M3U streams found in request body."}), 400
    except Exception as e:
        return jsonify({"success": False, "message": f"Error parsing request: {str(e)}"}), 500

PROXY_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
}

@app.route('/proxy/<path:url>')
def proxy(url):
    # Reconstruct original target URL
    if url.startswith('http/'):
        target_url = 'http://' + url[5:]
    elif url.startswith('https/'):
        target_url = 'https://' + url[6:]
    else:
        target_url = 'http://' + url

    if request.query_string:
        target_url += '?' + request.query_string.decode('utf-8', errors='ignore')

    print(f"[Proxy] Fetching: {target_url}")

    try:
        headers = dict(PROXY_HEADERS)
        # Forward Range header if present (needed for some streams)
        if 'Range' in request.headers:
            headers['Range'] = request.headers['Range']

        upstream = req_lib.get(target_url, headers=headers, stream=True, timeout=30, verify=False)

        print(f"[Proxy] Upstream status: {upstream.status_code} content-type: {upstream.headers.get('Content-Type')}")

        if upstream.status_code >= 400:
            return Response(f"Upstream error {upstream.status_code}", status=upstream.status_code)

        content_type = upstream.headers.get('Content-Type', 'application/octet-stream')

        # For M3U/M3U8 playlists, rewrite segment URLs to also pass through the proxy
        if 'mpegurl' in content_type.lower() or target_url.split('?')[0].lower().endswith(('.m3u', '.m3u8')):
            content = upstream.text
            base = target_url.rsplit('/', 1)[0] + '/'
            rewritten_lines = []
            for line in content.splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith('#'):
                    if stripped.startswith('http://'):
                        line = '/proxy/http/' + stripped[7:]
                    elif stripped.startswith('https://'):
                        line = '/proxy/https/' + stripped[8:]
                    else:
                        abs_url = base + stripped
                        if abs_url.startswith('http://'):
                            line = '/proxy/http/' + abs_url[7:]
                        else:
                            line = '/proxy/https/' + abs_url[8:]
                rewritten_lines.append(line)
            resp = Response('\n'.join(rewritten_lines), status=200)
            resp.headers['Content-Type'] = content_type
            resp.headers['Access-Control-Allow-Origin'] = '*'
            return resp

        # Stream live feeds chunk by chunk
        def generate():
            try:
                for chunk in upstream.iter_content(chunk_size=13160):  # 188 * 70 TS packets
                    if chunk:
                        yield chunk
            finally:
                upstream.close()

        resp = Response(generate(), status=upstream.status_code)
        resp.headers['Content-Type'] = content_type
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['X-Accel-Buffering'] = 'no'
        resp.headers['Cache-Control'] = 'no-cache'
        return resp

    except Exception as e:
        print(f"[Proxy] Exception for {target_url}: {e}")
        return Response(str(e), status=500, headers={'Access-Control-Allow-Origin': '*'})

if __name__ == '__main__':
    init_db()
    print(f"Starting GridStream F1 server on http://localhost:{PORT}")
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True, use_reloader=False)
