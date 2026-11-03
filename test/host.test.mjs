import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

/** Build a plugin context double that records the registered route. */
function makeContext(defaultProvider) {
  const routes = [];
  const ctx = {
    effect(fn) {
      fn();
    },
    get(name) {
      if (name === 'agentDefaultModel' && defaultProvider !== undefined) {
        return { currentSelection: () => ({ provider: defaultProvider, model: 'test-model' }) };
      }
      return undefined;
    },
    credentials: {
      async describe() {
        return { configured: true };
      },
      async resolve() {
        return { value: 'test-key' };
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  return { ctx, routes };
}

/** Invoke the registered route with a fake request/response pair. */
async function callRoute(routes, url, method = 'GET') {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  await routes[0].handler({ method, url }, res);
  let payload;
  if (res.body.length > 0) {
    try {
      payload = JSON.parse(res.body);
    } catch {
      payload = undefined;
    }
  }
  return { status: res.status, payload };
}

/** Replace fetch for the duration of one test. */
function withFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

/** A successful GLM cash report. */
function cashBody(amount) {
  return {
    code: 200,
    success: true,
    data: {
      availableBalance: amount,
      rechargeAmount: amount,
      giveAmount: 0,
      totalSpendAmount: 0,
      frozenBalance: 0,
    },
  };
}

/** A rejected GLM envelope. */
function rejectedBody(code = 401, msg = 'token expired') {
  return { code, success: false, msg };
}

/** Quota limits shaped like the coding-plan response. */
function quotaBody() {
  return {
    code: 200,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 8.5, nextResetTime: 1792590000000 },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 21, nextResetTime: 1793000000000 },
      ],
    },
  };
}

const DEEPSEEK_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '184.71', granted_balance: '0.00', topped_up_balance: '184.71' },
  ],
};

test('detects DeepSeek from the default model selection', async () => {
  const restore = withFetch(async (url) => {
    assert.match(url, /\/user\/balance$/);
    return new Response(JSON.stringify(DEEPSEEK_BODY), { status: 200 });
  });
  try {
    const { ctx, routes } = makeContext('deepseek-official');
    apply(ctx, {});
    const { payload } = await callRoute(routes, '/deepseek-balance');
    assert.equal(payload.status, 'ok');
    assert.equal(payload.provider, 'deepseek-official');
    assert.equal(payload.kind, 'cash');
    assert.equal(payload.currency, 'CNY');
    assert.deepEqual(payload.balances, [
      { currency: 'CNY', total: '184.71', granted: '0.00', toppedUp: '184.71' },
    ]);
  } finally {
    restore();
  }
});

test('keeps granted and topped-up amounts on their own fields', async () => {
  const restore = withFetch(async () =>
    new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '30.00', granted_balance: '10.00', topped_up_balance: '20.00' },
        ],
      }),
      { status: 200 },
    ),
  );
  try {
    const { ctx, routes } = makeContext('deepseek');
    apply(ctx, {});
    const { payload } = await callRoute(routes, '/deepseek-balance');
    assert.equal(payload.balances[0].granted, '10.00');
    assert.equal(payload.balances[0].toppedUp, '20.00');
  } finally {
    restore();
  }
});

test('prefers the funded 智谱 station and reports CNY', async () => {
  const calls = [];
  const restore = withFetch(async (url) => {
    calls.push(url);
    if (url.startsWith('https://open.bigmodel.cn/')) {
      return new Response(JSON.stringify(cashBody(50)), { status: 200 });
    }
    if (url.startsWith('https://api.z.ai/')) {
      return new Response(JSON.stringify(cashBody(7)), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { ctx, routes } = makeContext('zai');
    apply(ctx, {});
    const { payload } = await callRoute(routes, '/deepseek-balance?provider=zai&model=glm-5.3');
    assert.equal(payload.status, 'ok');
    assert.equal(payload.kind, 'cash');
    assert.equal(payload.station, 'cn');
    assert.equal(payload.currency, 'CNY');
    assert.deepEqual(payload.balances, [
      { currency: 'CNY', total: '50.00', granted: '0.00', toppedUp: '50.00' },
    ]);
    assert.ok(calls.some((url) => url.startsWith('https://open.bigmodel.cn/')));
  } finally {
    restore();
  }
});

test('defers to a funded z.ai station when the 智谱 account is empty', async () => {
  const restore = withFetch(async (url) => {
    if (url.startsWith('https://open.bigmodel.cn/')) {
      return new Response(JSON.stringify(cashBody(0)), { status: 200 });
    }
    if (url.startsWith('https://api.z.ai/')) {
      return new Response(JSON.stringify(cashBody(12.5)), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { ctx, routes } = makeContext('zai');
    apply(ctx, {});
    const { payload } = await callRoute(routes, '/deepseek-balance?provider=zai');
    assert.equal(payload.station, 'intl');
    assert.equal(payload.currency, 'USD');
    assert.equal(payload.balances[0].total, '12.50');
  } finally {
    restore();
  }
});

test('queries only the China station for zai-coding-cn', async () => {
  const calls = [];
  const restore = withFetch(async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(cashBody(50)), { status: 200 });
  });
  try {
    const { ctx, routes } = makeContext('zai-coding-cn');
    apply(ctx, {});
    const { payload } = await callRoute(routes, '/deepseek-balance');
    assert.equal(payload.station, 'cn');
    assert.equal(payload.currency, 'CNY');
    assert.ok(calls.every((url) => url.startsWith('https://open.bigmodel.cn/')));
  } finally {
    restore();
  }
});

test('honours an explicit intl region', async () => {
  const calls = [];
  const restore = withFetch(async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(cashBody(9.99)), { status: 200 });
  });
  try {
    const { ctx, routes } = makeContext('zai');
    apply(ctx, { region: 'intl' });
    const { payload } = await callRoute(routes, '/deepseek-balance');
    assert.equal(payload.station, 'intl');
    assert.equal(payload.currency, 'USD');
    assert.ok(calls.every((url) => url.startsWith('https://api.z.ai/')));
  } finally {
    restore();
  }
});

test('falls back to the coding-plan quota when there is no cash report', async () => {
  const restore = withFetch(async (url) => {
    if (url.includes('query-customer-account-report')) {
      return new Response(JSON.stringify(rejectedBody()), { status: 200 });
    }
    if (url.startsWith('https://open.bigmodel.cn/')) {
      return new Response(JSON.stringify(quotaBody()), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { ctx, routes } = makeContext('zai');
    apply(ctx, {});
    const { payload } = await callRoute(routes, '/deepseek-balance?provider=zai');
    assert.equal(payload.status, 'ok');
    assert.equal(payload.kind, 'quota');
    assert.equal(payload.station, 'cn');
    assert.equal(payload.quota.length, 2);
    assert.equal(payload.quota[0].id, '5h');
    assert.equal(Math.round(payload.quota[0].remaining), 92);
    assert.equal(Math.round(payload.quota[1].remaining), 79);
  } finally {
    restore();
  }
});

test('reports an unsupported provider route', async () => {
  const { ctx, routes } = makeContext('openai');
  apply(ctx, {});
  const { payload } = await callRoute(routes, '/deepseek-balance');
  assert.equal(payload.status, 'unsupported');
  assert.equal(payload.provider, 'openai');
});

test('reports an unconfigured credential', async () => {
  const { ctx, routes } = makeContext('deepseek-official');
  ctx.credentials.describe = async () => ({ configured: false });
  apply(ctx, {});
  const { payload } = await callRoute(routes, '/deepseek-balance');
  assert.equal(payload.status, 'unconfigured');
  assert.equal(payload.ref, 'DEEPSEEK_API_KEY');
});

test('lets the configured provider override the default selection', async () => {
  const restore = withFetch(async () =>
    new Response(JSON.stringify(DEEPSEEK_BODY), { status: 200 }),
  );
  try {
    const { ctx, routes } = makeContext('zai');
    apply(ctx, { provider: 'deepseek' });
    const { payload } = await callRoute(routes, '/deepseek-balance');
    assert.equal(payload.provider, 'deepseek');
  } finally {
    restore();
  }
});

test('maps a 401 to UNAUTHORIZED', async () => {
  const restore = withFetch(async () =>
    new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
  );
  try {
    const { ctx, routes } = makeContext('deepseek-official');
    apply(ctx, {});
    const { payload } = await callRoute(routes, '/deepseek-balance');
    assert.equal(payload.status, 'error');
    assert.equal(payload.code, 'UNAUTHORIZED');
    assert.equal(payload.message, 'bad key');
  } finally {
    restore();
  }
});

test('answers non-GET requests with 405', async () => {
  const { ctx, routes } = makeContext('deepseek-official');
  apply(ctx, {});
  const { status } = await callRoute(routes, '/deepseek-balance', 'POST');
  assert.equal(status, 405);
});
