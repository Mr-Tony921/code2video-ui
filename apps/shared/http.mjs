/** HTTP primitives shared by the gateway and worker; their parse policies stay explicit. */
export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
export function err(res, status, code, message, details) {
  json(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}
export async function readJsonStrict(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
export async function readJson(req) {
  try { return await readJsonStrict(req); }
  catch (e) { if (e instanceof SyntaxError) return {}; throw e; }
}

export function matchRoute(routes, method, pathname) {
  const direct = routes[`${method} ${pathname}`];
  if (direct) return [direct, {}];
  for (const key of Object.keys(routes)) {
    const [m, pat] = key.split(' ');
    if (m !== method || !pat.includes(':')) continue;
    const pp = pat.split('/'), ap = pathname.split('/');
    if (pp.length !== ap.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return [routes[key], params];
  }
  return [null, null];
}
