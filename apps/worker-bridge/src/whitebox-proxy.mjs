/** Per-job authenticated whitebox model routing; C2V traffic never enters this path. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWhiteboxModel } from '../../shared/whitebox.mjs';
import { whiteboxPhaseContext } from './whitebox-context.mjs';
import { toWhiteboxJson, fromWhiteboxJson, whiteboxJsonSSE } from './whitebox-json-transport.mjs';
import { toResponses, fromResponses, anthropicSSE } from '../../shared/responses-adapter.mjs';
import { readJsonStrict, json } from '../../shared/http.mjs';
import { adaptAnthropicRequest, normalizeAnthropicUsage, anthropicUsageStream } from '../../shared/anthropic-compat.mjs';

export const whiteboxToken = (secret, jid) => createHmac('sha256', secret).update(`whitebox:${jid}`).digest('hex');
export function routedWhiteboxModel(config, selection, jid) {
  const model = resolveWhiteboxModel(config.raw, selection);
  return { ...model, baseUrl: `http://127.0.0.1:${config.worker.port}/whitebox-model/${jid}`,
    apiKey: whiteboxToken(config.gateway.internalToken, jid) };
}
export function createWhiteboxProxy(config, getJob, fetchImpl = fetch) {
  const cooldown = new Map();
  return async function handle(req, res, jid, suffix) {
    const state = getJob(jid);
    const token = String(req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = whiteboxToken(config.gateway.internalToken, jid);
    if (!state || state.mode !== 'blockout_3d' || Buffer.byteLength(token) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
      return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid whitebox job authorization' } });
    if (!['/v1/messages', '/v1/messages/count_tokens'].includes(suffix) || req.method !== 'POST')
      return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Unsupported whitebox model route' } });
    const meta = JSON.parse(await readFile(join(state.jobDir, '_meta.json'), 'utf8'));
    const model = resolveWhiteboxModel(config.raw, meta.model_selection);
    const body = await readJsonStrict(req);
    const phase = meta.whitebox_host?.state_path
      ? JSON.parse(await readFile(meta.whitebox_host.state_path, 'utf8')) : null;
    const context = whiteboxPhaseContext(body, meta.whitebox_host, phase);
    const phaseJson = suffix === '/v1/messages' && model.protocol === 'anthropic' && meta.whitebox_host?.stage_transport === 'chat-json-v1' && context.audit.policy === 'current-phase-v1';
    const effort = phase ? (phase.repairs > 0 || phase.needs_repair ? 'high' : 'low') : model.reasoningEffort;
    if (suffix.endsWith('/count_tokens') && model.protocol === 'responses')
      return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'Token counting is unavailable for this provider' } });
    const dir = join(state.jobDir, 'model-capture', `${Date.now()}-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'request.json'), JSON.stringify(body));
    const attempts = [];
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', abort);
    let finalStatus = 502, finalError = 'Model channel unavailable';
    let completed = false;
    try {
      for (const [i, channel] of model.channels.entries()) {
        const identity = `${model.snapshot.revision}:${i}`;
        if (cooldown.get(identity) > Date.now() && i < model.channels.length - 1) continue;
        const adapted = adaptAnthropicRequest(context.request, channel.compatibility);
        const request = phaseJson ? toWhiteboxJson(context.request, channel, effort, phase.mcp_phase) : model.protocol === 'responses' ? toResponses(context.request, channel, effort) : {
          ...adapted.request, model: channel.model,
          ...(model.thinking ? { thinking: model.thinking } : {}),
          output_config: { ...body.output_config, effort },
        };
        const path = phaseJson ? '/v1/chat/completions' : model.protocol === 'responses' ? '/v1/responses' : suffix;
        await writeFile(join(dir, `upstream-${i}.request.json`), JSON.stringify(request));
        const attempt = { channel: i + 1, model: channel.model, endpoint: channel.baseUrl, request_path: path, protocol: phaseJson ? 'chat-json-v1' : model.protocol,
          effort, phase: phase?.phase ?? null, context: context.audit, compatibility: channel.compatibility, lifted_images: adapted.images,
          started_at: new Date().toISOString() };
        attempts.push(attempt);
        let upstream;
        try {
          upstream = await fetchImpl(channel.baseUrl.replace(/\/$/, '') + path, { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': channel.apiKey, authorization: `Bearer ${channel.apiKey}`, 'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01' },
            body: JSON.stringify(request), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(model.requestTimeoutMs)]) });
        } catch (e) {
          attempt.error = e.name; finalError = `Channel request failed (${e.name})`;
          if (controller.signal.aborted) break;
          cooldown.set(identity, Date.now() + 30000); continue;
        }
        attempt.http = upstream.status;
        attempt.request_id = upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id');
        attempt.headers_received_at = new Date().toISOString();
        if (!upstream.ok) {
          const raw = await upstream.text();
          await writeFile(join(dir, `upstream-${i}.response.txt`), raw);
          finalStatus = upstream.status; finalError = `Model channel HTTP ${upstream.status}`;
          if ([401, 403, 408, 429].includes(upstream.status) || upstream.status >= 500) {
            cooldown.set(identity, Date.now() + 30000); continue;
          }
          break;
        }
        cooldown.delete(identity);
        if (phaseJson || model.protocol === 'responses') {
          let message;
          try {
            const raw = await upstream.text();
            await writeFile(join(dir, `upstream-${i}.response.json`), raw);
            if (phaseJson) {
              const converted = fromWhiteboxJson(JSON.parse(raw), model.model);
              message = converted.message; attempt.transport = converted.audit;
            } else message = fromResponses(JSON.parse(raw), model.model);
          } catch (e) {
            attempt.error = e.message; finalError = e.message;
            if (controller.signal.aborted) break;
            cooldown.set(identity, Date.now() + 30000); continue;
          }
          const wire = body.stream ? (phaseJson ? whiteboxJsonSSE(message) : anthropicSSE(message)) : JSON.stringify(message);
          await writeFile(join(dir, 'response.txt'), wire);
          res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
          res.end(wire); completed = true;
        } else {
          // Archive native bytes, separately archive the usage-normalized client wire.
          // Never replay a partial answer on a fallback channel.
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
          let tail = '';
          const capture = await open(join(dir, 'response.txt'), 'w');
          const normalize = channel.compatibility.input_tokens_include_cache === true;
          const clientCapture = normalize ? await open(join(dir, 'client-response.txt'), 'w') : null;
          const transform = normalize && body.stream ? anthropicUsageStream(channel.compatibility) : null;
          let rawChunks = [], rawSize = 0, clientChunks = [], writeMs = 0, previousAt = null;
          const flush = async () => {
            const t = Date.now();
            if (rawSize) await capture.writeFile(Buffer.concat(rawChunks));
            if (clientCapture && clientChunks.length) await clientCapture.writeFile(clientChunks.join(''));
            rawChunks = []; rawSize = 0; clientChunks = []; writeMs += Date.now() - t;
          };
          try {
            for await (const chunk of upstream.body) {
              const bytes = Buffer.from(chunk);
              const at = Date.now();
              attempt.first_byte_ms ??= at - started;
              attempt.max_chunk_gap_ms = Math.max(attempt.max_chunk_gap_ms ?? 0, previousAt == null ? 0 : at - previousAt);
              previousAt = at;
              rawChunks.push(bytes); rawSize += bytes.length;
              tail = (tail + bytes.toString()).slice(-8192);
              const wire = transform ? transform.push(bytes) : normalize ? '' : bytes;
              if (wire.length && !res.destroyed) res.write(wire);
              if (clientCapture && wire.length) clientChunks.push(wire);
              if (body.stream && rawSize >= 65536) await flush();
            }
            if (transform) {
              const wire = transform.end(); clientChunks.push(wire);
              if (!res.destroyed) res.write(wire);
            } else if (normalize) {
              const message = JSON.parse(Buffer.concat(rawChunks).toString('utf8'));
              if (message.usage) message.usage = normalizeAnthropicUsage(message.usage, channel.compatibility);
              const wire = JSON.stringify(message); clientChunks.push(wire);
              if (!res.destroyed) res.write(wire);
            }
          } finally {
            await flush(); await capture.close(); await clientCapture?.close();
            attempt.capture_write_ms = writeMs;
          }
          completed = body.stream ? /"type"\s*:\s*"message_stop"/.test(tail) && !/"type"\s*:\s*"error"/.test(tail) : !/"type"\s*:\s*"error"/.test(tail);
          if (!completed) finalError = 'Upstream did not complete its message';
          res.end();
        }
        attempt.finished_at = new Date().toISOString();
        return;
      }
      if (!res.headersSent) json(res, finalStatus, { type: 'error', error: { type: 'api_error', message: finalError } });
    } catch (e) {
      finalError = e.message;
      if (!res.headersSent) json(res, 502, { type: 'error', error: { type: 'api_error', message: e.message } });
      else res.destroy();
    } finally {
      res.off('close', abort);
      await writeFile(join(dir, 'meta.json'), JSON.stringify({ profile: model.snapshot, request_path: suffix,
        client_headers: Object.fromEntries(['anthropic-version', 'anthropic-beta', 'user-agent', 'content-type'].filter(k => req.headers[k] != null).map(k => [k, req.headers[k]])),
        attempts, complete: completed,
        elapsed_ms: Date.now() - started, finished_at: new Date().toISOString(), ...(!completed ? { error: finalError } : {}) }, null, 2));
    }
  };
}
