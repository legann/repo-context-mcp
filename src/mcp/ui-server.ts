import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { extractUiGraph } from './ui-graph.js';
import type { AppContext } from './context.js';
import { packageRoot } from '../paths.js';

export interface UiServerOptions {
  port: number;
  host?: string;
}

export interface UiServerHandle {
  /** Close SSE clients and the HTTP server so the port is released (call on process shutdown). */
  stop: () => Promise<void>;
  /** Same as configured port (always fixed — no fallback). */
  port: number;
}

function listenOnce(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => {
      server.removeListener('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

function pathnameOnly(url: string | undefined): string {
  const raw = url ?? '/';
  const i = raw.indexOf('?');
  return (i === -1 ? raw : raw.slice(0, i)) || '/';
}

function mimeFor(filePath: string): string {
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.map')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.woff2')) return 'font/woff2';
  if (filePath.endsWith('.woff')) return 'font/woff';
  if (filePath.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

function safeFileUnderDir(baseDir: string, urlPath: string): string | null {
  const rel = urlPath.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  const abs = path.resolve(baseDir, rel);
  const base = path.resolve(baseDir);
  if (!abs.startsWith(base + path.sep) && abs !== base) return null;
  return abs;
}

function serveViewerNotBuilt(res: http.ServerResponse): void {
  const body =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Repo Context Ui</title></head><body>' +
    '<pre>UI viewer bundle missing.\n\n' +
    'From repo-context:\n  cd ui && npm install && npm run build\n</pre></body></html>';
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export async function startUiServer(
  ctx: AppContext,
  options: UiServerOptions,
): Promise<UiServerHandle> {
  const { host = '127.0.0.1', port } = options;
  const sseClients = new Set<http.ServerResponse>();

  ctx.onRefresh(() => {
    const data = extractUiGraph(ctx.getState());
    const payload = `event: refresh\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
    console.log(`  [ui] pushed refresh to ${sseClients.size} client(s)`);
  });

  const distDir = path.join(packageRoot, 'ui', 'dist');
  const indexHtmlPath = path.join(distDir, 'index.html');
  const hasDist = fs.existsSync(indexHtmlPath);
  if (!hasDist) {
    console.warn(`  [ui] bundle missing: ${indexHtmlPath}`);
    console.warn('  [ui] Build with: cd ui && npm install && npm run build');
  }

  const requestListener: http.RequestListener = (req, res) => {
    const origin = req.headers.origin;
    if (origin && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const pathname = pathnameOnly(req.url);

    if (pathname.startsWith('/api/graph')) {
      const data = extractUiGraph(ctx.getState());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ builtAt: ctx.getState().builtAt })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));

      const keepAlive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); sseClients.delete(res); }
      }, 30_000);
      req.on('close', () => clearInterval(keepAlive));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      if (!hasDist) {
        serveViewerNotBuilt(res);
        return;
      }
      let html = '';
      try {
        html = fs.readFileSync(indexHtmlPath, 'utf-8');
        const servedAt = new Date().toISOString();
        if (html.includes('<head>')) {
          html = html.replace(
            '<head>',
            `<head>\n<meta name="repo-context-viewer-served-at" content="${servedAt}">`,
          );
        }
      } catch (e) {
        console.error(`  [ui] read index: ${(e as Error).message}`);
        serveViewerNotBuilt(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(html);
      return;
    }

    if (!hasDist) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const fileAbs = safeFileUnderDir(distDir, pathname);
    if (fileAbs && fs.existsSync(fileAbs) && fs.statSync(fileAbs).isFile()) {
      res.writeHead(200, {
        'Content-Type': mimeFor(fileAbs),
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(fileAbs).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  };

  const server = http.createServer(requestListener);

  try {
    await listenOnce(server, port, host);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    try { server.close(); } catch { /* ignore */ }
    if (err.code === 'EADDRINUSE') {
      console.error(
        `  [ui] port ${port} already in use on ${host}. ` +
          `Stop the other process on this port (or disable duplicate MCP ui). ` +
          `Bookmark: http://localhost:${port}`,
      );
    } else {
      console.error(`  [ui] listen error: ${err.message}`);
    }
    throw err;
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`  [ui] server error: ${err.message}`);
  });

  console.log(`  UI graph: http://localhost:${port}`);

  async function stop(): Promise<void> {
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) reject(err);
        else resolve();
      });
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        (server as http.Server & { closeAllConnections(): void }).closeAllConnections();
      }
    });
  }

  return { stop, port };
}
