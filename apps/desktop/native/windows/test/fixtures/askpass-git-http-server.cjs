// apps/desktop/native/windows/test/fixtures/askpass-git-http-server.cjs
//
// Todo 30 QA fixture: a LOCAL smart-HTTP Git server behind Basic authentication.
//
//   - every request requires `Authorization: Basic base64(hf_user:<token>)`;
//     without it, a 401 with `WWW-Authenticate: Basic` is returned so real Git
//     asks its AskPass helper for credentials;
//   - authenticated requests are proxied to `git http-backend` (smart HTTP) so
//     `git clone` works fully offline against the bare repository.
//
// Usage:  node askpass-git-http-server.cjs <bareRepoDir> <port> <token> <authLog>
// Prints "LISTENING <port>" once ready. Every observed Authorization header is
// appended to <authLog> (base64 form) so the QA can assert the EXACT
// `Basic base64(hf_user:<token>)` header the helper produced.
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const bareRepo = process.argv[2]
const port = Number(process.argv[3])
const token = process.argv[4]
const authLog = process.argv[5]
const GIT = process.env.ASKPASS_FIXTURE_GIT || 'C:\\Program Files\\Git\\cmd\\git.exe'

const expected = 'Basic ' + Buffer.from('hf_user:' + token).toString('base64')

function headersToObject(raw) {
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    out['HTTP_' + k.toUpperCase().replace(/-/g, '_')] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  return out
}

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || ''
  fs.appendFileSync(authLog, (auth || '<none>') + '\n')
  if (auth !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="hf"' })
    res.end('unauthorized')
    return
  }
  const url = new global.URL(req.url || '/', 'http://127.0.0.1')
  const env = {
    ...process.env,
    // http-backend resolves the repo as `$GIT_PROJECT_ROOT/<PATH_INFO[0]>`;
    // the fixture serves `repo.git` whose parent is the project root.
    GIT_PROJECT_ROOT: path.dirname(bareRepo),
    PATH_INFO: url.pathname,
    QUERY_STRING: url.searchParams.toString(),
    REQUEST_METHOD: req.method || 'GET',
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: req.headers['content-length'] || '0',
    REMOTE_USER: 'hf_user',
    GIT_HTTP_EXPORT_ALL: '1',
    ...headersToObject(req.headers)
  }
  const child = spawn(GIT, ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = Buffer.alloc(0)
  let err = ''
  child.stdout.on('data', (d) => {
    out = Buffer.concat([out, d])
  })
  child.stderr.on('data', (d) => {
    err += d.toString()
  })
  req.pipe(child.stdin)
  child.on('error', (e) => {
    res.writeHead(500)
    res.end('http-backend spawn failed: ' + e.message)
  })
  child.on('exit', (code) => {
    // git http-backend writes the HTTP status line + headers + body to stdout.
    const headerEnd = out.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      res.writeHead(code === 0 ? 200 : 500)
      res.end(err || out.toString())
      return
    }
    const headerText = out.slice(0, headerEnd).toString('utf8')
    const body = out.slice(headerEnd + 4)
    const lines = headerText.split('\r\n')
    const statusLine = lines[0] || ''
    const statusMatch = /HTTP\/1\.[01] (\d{3})/.exec(statusLine)
    const status = statusMatch ? Number(statusMatch[1]) : code === 0 ? 200 : 500
    const headers = {}
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(':')
      if (idx > 0) {
        headers[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim()
      }
    }
    res.writeHead(status, headers)
    res.end(body)
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('LISTENING ' + port + '\n')
})
