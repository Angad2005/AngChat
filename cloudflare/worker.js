import { DurableObject } from 'cloudflare:workers';
import { verifyAccessAssertion } from './access.mjs';

const PROXY_KEY_HEADER = 'x-angchat-proxy-key';
const ACCESS_EMAIL_HEADER = 'x-angchat-access-email';
const SNAPSHOT_STORAGE_KEY = 'angchat-container-snapshot';
const PORT = 3000;
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const READINESS_ATTEMPTS = 60;
const SNAPSHOT_ROUTES = new Set([
  'POST /api/harness/run',
  'POST /api/verification/run',
  'POST /api/sessions',
  'PUT /api/settings',
  'PUT /api/workspace',
  'POST /api/memory',
  'PUT /api/memory/context-files',
  'POST /api/skills',
  'POST /api/signup',
  'POST /api/login',
  'POST /api/users'
]);

function rewriteRequestForContainer(request, claims, proxyKey) {
  const originalUrl = new URL(request.url);
  const url = new URL(originalUrl);
  url.protocol = 'http:';
  url.host = 'container';
  const forwarded = new Request(url, request);
  forwarded.headers.delete('host');
  forwarded.headers.set('x-forwarded-host', originalUrl.host);
  forwarded.headers.set('x-forwarded-proto', originalUrl.protocol.slice(0, -1));
  forwarded.headers.set(PROXY_KEY_HEADER, proxyKey);
  forwarded.headers.set(ACCESS_EMAIL_HEADER, String(claims.email || claims.sub || 'shared').slice(0, 254));
  return forwarded;
}

function envForContainer(env) {
  const values = {
    HOST: '0.0.0.0',
    PORT: String(PORT),
    CHAT_DB_PATH: '/data/chat.db',
    CHAT_WORKSPACE: '/app',
    CHAT_CAPTURE_TRACES: '0',
    CLOUDFLARE_CONTAINER: '1',
    CHAT_GATE_SECRET: env.CHAT_GATE_SECRET,
    SESSION_SECRET: env.SESSION_SECRET,
    LLM_PROVIDER: env.LLM_PROVIDER || 'mock',
    LLM_MODEL: env.LLM_MODEL || 'angchat-demo',
    LLM_BASE_URL: env.LLM_BASE_URL || ''
  };
  if (env.LLM_API_KEY) values.LLM_API_KEY = env.LLM_API_KEY;
  return values;
}

function shouldSnapshot(request) {
  const method = request.method.toUpperCase();
  const pathname = new URL(request.url).pathname;
  const route = `${method} ${pathname}`;
  if (SNAPSHOT_ROUTES.has(route)) return true;
  if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/sessions\/[^/]+$/.test(pathname)) return true;
  if (method === 'PUT' && /^\/api\/skills\/[^/]+$/.test(pathname)) return true;
  return (method === 'PUT' || method === 'DELETE') && /^\/api\/users\/[^/]+$/.test(pathname);
}

export class AngChatContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.requestTail = Promise.resolve();
    this.startupPromise = null;
  }

  async ensureContainer() {
    const container = this.ctx.container;
    if (!container) throw new Error('Cloudflare did not provide the AngChat container binding.');

    if (!container.running && !this.startupPromise) {
      this.startupPromise = (async () => {
        const snapshot = await this.ctx.storage.get(SNAPSHOT_STORAGE_KEY);
        const options = {
          enableInternet: true,
          instance: 'basic',
          env: envForContainer(this.env)
        };
        if (snapshot) options.containerSnapshot = snapshot;
        else options.image = container.images.base;
        container.start(options);
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      })();
    }

    if (this.startupPromise) {
      try {
        await this.startupPromise;
      } finally {
        this.startupPromise = null;
      }
    }

    const port = container.getTcpPort(PORT);
    let lastError;
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt++) {
      try {
        const response = await port.fetch('http://container/api/health');
        if (response.ok) {
          await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
          return port;
        }
        lastError = new Error(`Health check returned HTTP ${response.status}.`);
      } catch (error) {
        lastError = error;
      }
      await scheduler.wait(500);
    }
    throw new Error(`AngChat container did not become ready: ${lastError?.message || 'health check timed out'}`);
  }

  async saveSnapshot() {
    try {
      const snapshot = await this.ctx.container.snapshotContainer({
        name: `angchat-${crypto.randomUUID()}`
      });
      await this.ctx.storage.put(SNAPSHOT_STORAGE_KEY, snapshot);
    } catch (error) {
      console.error(`Could not persist the AngChat container snapshot: ${error.message}`);
      throw error;
    }
  }

  async responseWithCompletion(response, persist, release) {
    if (!response.body) {
      try {
        if (persist) await this.saveSnapshot();
      } finally {
        release();
      }
      return response;
    }

    const reader = response.body.getReader();
    let completed = false;
    const finish = async () => {
      if (completed) return;
      completed = true;
      try {
        if (persist) await this.saveSnapshot();
      } finally {
        release();
      }
    };
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            await finish();
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          controller.error(error);
          await finish();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await finish();
        }
      }
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  async fetch(request) {
    const previous = this.requestTail;
    let unlock;
    this.requestTail = new Promise(resolve => { unlock = resolve; });
    await previous;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      unlock();
    };

    try {
      const port = await this.ensureContainer();
      const claims = {
        email: request.headers.get(ACCESS_EMAIL_HEADER) || 'shared'
      };
      const proxyKey = this.env.CHAT_GATE_SECRET;
      if (!proxyKey) throw new Error('CHAT_GATE_SECRET is not configured.');
      const forwarded = rewriteRequestForContainer(request, claims, proxyKey);
      const response = await port.fetch(forwarded);
      const persist = shouldSnapshot(request);
      return await this.responseWithCompletion(response, persist, release);
    } catch (error) {
      release();
      console.error(`AngChat container request failed: ${error.message}`);
      return Response.json({ error: 'The AngChat Cloudflare container could not complete the request.' }, { status: 502 });
    }
  }
}

export default {
  async fetch(request, env) {
    if (!env.CHAT_GATE_SECRET || !env.SESSION_SECRET) {
      return new Response('Set the CHAT_GATE_SECRET and SESSION_SECRET Wrangler secrets before deploying.', { status: 503 });
    }

    let claims;
    try {
      claims = await verifyAccessAssertion(request, env);
    } catch (error) {
      console.error(`Cloudflare Access configuration error: ${error.message}`);
      return new Response('Cloudflare Access is not configured for this deployment.', { status: 503 });
    }
    if (!claims) return new Response('Sign in through the configured Cloudflare Access application.', { status: 401 });

    const headers = new Headers(request.headers);
    headers.delete(PROXY_KEY_HEADER);
    headers.delete(ACCESS_EMAIL_HEADER);
    headers.set(ACCESS_EMAIL_HEADER, String(claims.email || claims.sub || 'shared').slice(0, 254));
    const forwarded = new Request(request, { headers });
    const id = env.ANGCHAT.idFromName('angchat-demo');
    return env.ANGCHAT.get(id).fetch(forwarded);
  }
};
