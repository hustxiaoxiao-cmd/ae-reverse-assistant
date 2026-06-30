const http = require('http');

const { app } = require('./dist/index.js');
console.log('[fc-handler] Express app imported');

const PORT = 9001;
http.createServer(app).listen(PORT, () => {
    console.log(`[fc-handler] Express server listening on port ${PORT}`);
});

const SKIP_HEADERS = new Set([
    'host', 'content-length', 'transfer-encoding', 'connection',
    'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer',
]);

exports.handler = async (event, context) => {
    const evt = JSON.parse(event.toString());
    const method = evt.requestContext?.http?.method || 'GET';
    const rawPath = evt.rawPath || '/';
    console.log(`[fc-handler] ${method} ${rawPath}`);

    // ★ 临时测试：根路径直接返回静态 HTML，不走代理
    if (rawPath === '/' || rawPath === '') {
        console.log('[fc-handler] TEST: returning static HTML directly');
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
            },
            body: '<html><body><h1>FC is working!</h1><p>If you see this, the response format is correct.</p></body></html>',
            isBase64Encoded: false,
        };
    }

    // 正常代理逻辑（测试通过后恢复使用）
    let url = rawPath;
    const qs = Object.entries(evt.queryParameters || {})
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    if (qs) url += '?' + qs;

    const headers = {};
    Object.entries(evt.headers || {}).forEach(([k, v]) => {
        if (!SKIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    });

    let body = evt.body || '';
    if (evt.isBase64Encoded && body) body = Buffer.from(body, 'base64').toString('utf-8');
    if (body) headers['content-length'] = Buffer.byteLength(body);

    return new Promise((resolve) => {
        const proxyReq = http.request(
            { hostname: '127.0.0.1', port: PORT, path: url, method, headers },
            (proxyRes) => {
                const chunks = [];
                proxyRes.on('data', (c) => chunks.push(c));
                proxyRes.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const resHeaders = {};
                    Object.entries(proxyRes.headers).forEach(([k, v]) => {
                        if (!SKIP_HEADERS.has(k.toLowerCase())) {
                            resHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
                        }
                    });
                    if (!resHeaders['content-type'] && !resHeaders['Content-Type']) {
                        resHeaders['Content-Type'] = 'text/html; charset=utf-8';
                    }
                    const ct = resHeaders['content-type'] || resHeaders['Content-Type'] || '';
                    const isText = /text|json|xml|javascript|csv|html/i.test(ct);
                    resolve({
                        statusCode: proxyRes.statusCode,
                        headers: resHeaders,
                        body: isText ? buf.toString('utf-8') : buf.toString('base64'),
                        isBase64Encoded: !isText,
                    });
                });
            }
        );
        proxyReq.on('error', (e) => {
            console.error('[fc-handler] Proxy error:', e.message);
            resolve({ statusCode: 502, headers: { 'Content-Type': 'text/plain' }, body: 'Bad Gateway', isBase64Encoded: false });
        });
        if (body) proxyReq.write(body);
        proxyReq.end();
    });
};
