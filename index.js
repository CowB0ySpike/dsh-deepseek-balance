/**
 * Host half of `dsh-deepseek-balance`.
 *
 * Resolves the credential of the provider the current session actually routes
 * to, reads that provider's account balance (or coding-plan quota) from its own
 * read-only endpoint, and serves the normalized result to the browser half over
 * one same-origin route. Keys never leave this process: the response carries
 * balances, quota, and status only.
 *
 * Supported providers:
 * - `deepseek` / `deepseek-official` — `GET /user/balance`
 * - `zai` (z.ai) and `zai-coding-cn` (open.bigmodel.cn) — cash account report,
 *   falling back to coding-plan quota limits
 *
 * @module dsh-deepseek-balance
 */

const DEFAULT_PROVIDER_ID = 'deepseek-official';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const ZAI_HOST = 'https://api.z.ai';
const BIGMODEL_HOST = 'https://open.bigmodel.cn';
const CASH_PATH = '/api/biz/account/query-customer-account-report';
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const PACKAGES_PATH = '/api/biz/tokenAccounts/list/my';
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const ERROR_CACHE_TTL_MS = 5_000;
const ROUTE_PATH = '/deepseek-balance';
const USER_AGENT = 'dsh-deepseek-balance/1.3.0';

/**
 * Known provider routes. `ref` is the credential reference DSH itself uses for
 * that provider, so no extra configuration is needed when DSH is configured.
 */
const PROVIDERS = {
	deepseek: {
		kind: 'deepseek',
		name: 'DeepSeek',
		ref: 'DEEPSEEK_API_KEY',
		host: DEEPSEEK_BASE_URL,
		currency: 'CNY',
	},
	zai: {
		kind: 'glm',
		name: 'GLM',
		ref: 'ZAI_API_KEY',
		host: ZAI_HOST,
		currency: 'USD',
	},
	'zai-coding-cn': {
		kind: 'glm',
		name: 'GLM',
		ref: 'ZAI_CODING_CN_API_KEY',
		host: BIGMODEL_HOST,
		currency: 'CNY',
	},
};

/** The credentials seam and the carrier that publishes the balance route. */
export const inject = ['credentials', 'webServer'];

/**
 * Register the balance route on the web carrier.
 *
 * @param ctx - plugin context carrying `credentials` and `webServer`.
 * @param config - optional row config; every field has a working default.
 */
export function apply(ctx, config) {
	const options = resolveOptions(config);

	/** Cache per provider/model selection. */
	const cache = new Map();
	/** Shared in-flight reads so concurrent pages cost one upstream call. */
	const inflight = new Map();

	/**
	 * Resolve the provider the session routes to.
	 *
	 * Precedence: explicit provider sent by the page, configured provider, DSH's
	 * default model selection, then the historical DeepSeek route.
	 *
	 * @param requested - provider id sent by the browser half, if any.
	 * @returns the provider id.
	 */
	function currentProvider(requested) {
		if (requested !== undefined) return requested;
		if (options.provider !== undefined) return options.provider;
		try {
			const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
			const provider = selection?.provider;
			if (typeof provider === 'string' && provider.length > 0) return provider;
		} catch {
			// A deployment without the service keeps the fallback.
		}
		return DEFAULT_PROVIDER_ID;
	}

	/**
	 * Read the balance (or quota) for one provider selection.
	 *
	 * @param selection - provider id plus the model id used for display.
	 * @returns the normalized payload.
	 */
	async function readBalance(selection) {
		const { provider, model } = selection;
		const known = providerOf(provider);
		if (known === undefined) return { status: 'unsupported', provider, model };

		let key;
		try {
			const ref = options.apiKeyEnv ?? known.ref;
			const info = await ctx.credentials.describe(ref);
			if (info === undefined || info.configured !== true) {
				return { status: 'unconfigured', provider, providerName: known.name, ref, model };
			}
			const resolved = await ctx.credentials.resolve(ref);
			if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value.length === 0) {
				return { status: 'unconfigured', provider, providerName: known.name, ref, model };
			}
			key = resolved.value;
		} catch (error) {
			return failure(provider, known, 'CREDENTIALS', describeError(error), model);
		}

		if (known.kind === 'deepseek') return readDeepSeek(known, key, options, provider, model);
		return readGlm(known, key, options, provider, model);
	}

	/**
	 * Serve one payload, reusing the cache unless a forced refresh is requested.
	 *
	 * @param selection - provider id plus model id.
	 * @param force - bypass the cache (the refresh action).
	 * @returns the payload the route returns.
	 */
	function getBalance(selection, force) {
		const key = `${selection.provider}\u0000${selection.model ?? ''}`;
		if (force !== true) {
			const hit = cache.get(key);
			if (hit !== undefined && Date.now() < hit.expiresAt) return Promise.resolve(hit.payload);
		}
		const pending = inflight.get(key);
		if (pending !== undefined) return pending;

		const read = readBalance(selection).then(
			(payload) => {
				inflight.delete(key);
				const ttl = payload.status === 'ok' ? options.cacheTtlMs : ERROR_CACHE_TTL_MS;
				cache.set(key, { payload, expiresAt: Date.now() + ttl });
				return payload;
			},
			(error) => {
				inflight.delete(key);
				const payload = failure(selection.provider, providerOf(selection.provider), 'INTERNAL', describeError(error), selection.model);
				cache.set(key, { payload, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
				return payload;
			},
		);
		inflight.set(key, read);
		return read;
	}

	ctx.effect(() =>
		ctx.webServer.register({
			kind: 'exact',
			path: ROUTE_PATH,
			handler: async (req, res) => {
				try {
					if (req.method !== 'GET') {
						res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' });
						res.end('Method Not Allowed');
						return;
					}
					const requested = new URL(req.url ?? '/', 'http://localhost');
					const provider = currentProvider(text(requested.searchParams.get('provider')));
					const model = text(requested.searchParams.get('model'));
					if (requested.searchParams.get('debug') === '1') {
						sendJson(res, 200, await debugPayload(ctx, options, provider));
						return;
					}
					const payload = await getBalance({ provider, model }, requested.searchParams.get('refresh') === '1');
					sendJson(res, 200, payload);
				} catch (error) {
					if (res.headersSent) {
						res.end();
						return;
					}
					sendJson(res, 500, failure(options.provider ?? DEFAULT_PROVIDER_ID, undefined, 'INTERNAL', describeError(error), undefined));
				}
			},
		}),
	);
}

/**
 * Diagnostic: return the upstream token-package rows verbatim so the field
 * semantics (`tokenBalance` / `tokensMagnitude`) can be verified against the
 * console. Opt-in via `?debug=1` on the localhost-only route.
 *
 * @param ctx - plugin context.
 * @param options - resolved options.
 * @param provider - provider id.
 * @returns raw per-station responses.
 */
async function debugPayload(ctx, options, provider) {
	const known = providerOf(provider);
	if (known === undefined || known.kind !== 'glm') {
		return { note: 'debug is only implemented for GLM routes', provider };
	}
	const ref = options.apiKeyEnv ?? known.ref;
	const resolved = await ctx.credentials.resolve(ref);
	if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value.length === 0) {
		return { note: 'credential is not configured', ref };
	}
	const key = resolved.value;
	const stations = glmStations(known, options);
	const out = [];
	for (const station of stations) {
		const result = await fetchJson(
			`${station.host}${PACKAGES_PATH}?pageNum=1&pageSize=100`,
			{ authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': USER_AGENT },
			options.timeoutMs,
		);
		out.push({ station: station.station, host: station.host, status: result.status, body: result.body ?? null });
	}
	return { provider, ref, stations: out };
}

/**
 * Normalize the row config; an unusable value falls back to the shipped default
 * instead of failing the plugin fiber.
 *
 * @param config - raw row config, possibly absent.
 * @returns the resolved options.
 */
function resolveOptions(config) {
	const source = config !== null && typeof config === 'object' ? config : {};
	const rawBaseUrl = text(source.baseURL);
	const baseURL = rawBaseUrl !== undefined && URL.canParse(rawBaseUrl) ? rawBaseUrl.replace(/\/+$/, '') : undefined;
	const region = text(source.region);
	return {
		provider: text(source.provider),
		apiKeyEnv: text(source.apiKeyEnv),
		baseURL,
		region: region === 'cn' || region === 'intl' ? region : undefined,
		cacheTtlMs: positiveNumber(source.cacheTtlMs, DEFAULT_CACHE_TTL_MS),
		timeoutMs: positiveNumber(source.timeoutMs, DEFAULT_TIMEOUT_MS),
	};
}

/**
 * Map a DSH provider route onto its balance endpoint.
 *
 * @param provider - provider id such as `deepseek-official` or `zai`.
 * @returns the provider descriptor, or undefined when unsupported.
 */
function providerOf(provider) {
	if (typeof provider !== 'string') return undefined;
	if (Object.hasOwn(PROVIDERS, provider)) return PROVIDERS[provider];
	const id = provider.toLowerCase();
	if (id.includes('deepseek')) return PROVIDERS.deepseek;
	if (id.includes('zai') || id.includes('glm') || id.includes('zhipu') || id.includes('bigmodel')) {
		return id.includes('cn') ? PROVIDERS['zai-coding-cn'] : PROVIDERS.zai;
	}
	return undefined;
}

/**
 * Read the DeepSeek account balance.
 *
 * @param known - provider descriptor.
 * @param key - resolved API key.
 * @param options - resolved plugin options.
 * @param provider - provider id to echo.
 * @param model - model id to echo.
 * @returns the normalized payload.
 */
async function readDeepSeek(known, key, options, provider, model) {
	const baseURL = options.baseURL ?? known.host;
	const result = await fetchJson(
		`${baseURL}/user/balance`,
		{ authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': USER_AGENT },
		options.timeoutMs,
	);
	if (result.failure !== undefined) return failure(provider, known, result.failure.code, result.failure.message, model);
	if (result.status === 401 || result.status === 403) {
		return failure(provider, known, 'UNAUTHORIZED', detailOf(result.body) ?? `HTTP ${result.status}`, model);
	}
	if (result.status < 200 || result.status >= 300) {
		return failure(provider, known, 'HTTP', detailOf(result.body) ?? `HTTP ${result.status}`, model);
	}
	if (result.body === undefined || typeof result.body !== 'object') {
		return failure(provider, known, 'RESPONSE', 'response body is not valid JSON', model);
	}

	const infos = Array.isArray(result.body.balance_infos) ? result.body.balance_infos : [];
	const balances = [];
	for (const item of infos) {
		const currency = text(item?.currency);
		if (currency === undefined) continue;
		balances.push({
			currency,
			total: text(item?.total_balance) ?? '',
			granted: text(item?.granted_balance) ?? '',
			toppedUp: text(item?.topped_up_balance) ?? '',
		});
	}
	return {
		status: 'ok',
		provider,
		providerName: known.name,
		model,
		kind: 'cash',
		currency: balances[0]?.currency ?? known.currency,
		isAvailable: result.body.is_available !== false,
		balances,
		fetchedAt: Date.now(),
	};
}

/** China station: the 智谱 open platform, amounts in CNY. */
const CN_STATION = { station: 'cn', host: BIGMODEL_HOST, currency: 'CNY' };
/** International station: z.ai, amounts in USD. */
const INTL_STATION = { station: 'intl', host: ZAI_HOST, currency: 'USD' };

/**
 * Candidate stations for a GLM route, in preference order.
 *
 * `auto` asks both stations for a `zai` route because one key can belong to
 * either account; a funded China answer wins, and a zero China answer defers
 * to a funded z.ai answer.
 *
 * @param known - provider descriptor.
 * @param options - resolved options.
 * @returns stations to query.
 */
function glmStations(known, options) {
	if (options.baseURL !== undefined) {
		const cn = options.baseURL.includes('bigmodel');
		return [{ station: cn ? 'cn' : 'intl', host: options.baseURL, currency: cn ? 'CNY' : 'USD' }];
	}
	if (options.region === 'cn') return [CN_STATION];
	if (options.region === 'intl') return [INTL_STATION];
	if (known.host === BIGMODEL_HOST) return [CN_STATION];
	return [CN_STATION, INTL_STATION];
}

/**
 * Read a GLM cash balance, falling back to coding-plan quota when the account
 * has no cash report (subscription keys). The answering station's token
 * packages (资源包) are attached when present.
 *
 * @param known - provider descriptor.
 * @param key - resolved API key.
 * @param options - resolved plugin options.
 * @param provider - provider id to echo.
 * @param model - model id to echo.
 * @returns the normalized payload.
 */
async function readGlm(known, key, options, provider, model) {
	const stations = glmStations(known, options);
	const cash = await Promise.all(
		stations.map((station) => readGlmCash(known, key, station, options.timeoutMs, provider, model)),
	);
	const picked = pickCashIndex(cash);
	if (picked >= 0) {
		return withPackages(key, stations[picked], cash[picked].payload, options, provider, model);
	}

	const quota = await Promise.all(
		stations.map((station) => readGlmQuota(known, key, station, options.timeoutMs, provider, model)),
	);
	const quotaIndex = quota.findIndex((result) => result.payload !== undefined);
	if (quotaIndex >= 0) {
		return withPackages(key, stations[quotaIndex], quota[quotaIndex].payload, options, provider, model);
	}

	const preferred = Math.max(
		0,
		stations.findIndex((station) => station.host === known.host),
	);
	return (quota[preferred] ?? quota[0])?.error ?? (cash[preferred] ?? cash[0])?.error;
}

/**
 * Attach the station's token packages to a finished payload.
 *
 * @param key - resolved API key.
 * @param station - the station that answered.
 * @param payload - the cash or quota payload.
 * @param options - resolved plugin options.
 * @returns the payload, with `packages` when the account has any.
 */
async function withPackages(key, station, payload, options) {
	const packages = await readGlmPackages(key, station, options.timeoutMs);
	if (packages.length > 0) payload.packages = packages;
	return payload;
}

/**
 * Read the station's granted token packages (资源包).
 *
 * Verified against the live API: `tokenBalance` is the remaining amount in the
 * package's native unit (tokens for `consumeType: TOKENS`, calls for TIMES),
 * `tokensMagnitude` is the package's total grant (5000000 = 500万), and
 * `expirationTime` is a naive UTC+8 timestamp.
 *
 * @param key - resolved API key.
 * @param station - station descriptor.
 * @param timeoutMs - per-request timeout.
 * @returns package rows, possibly empty; read failures degrade to empty.
 */
async function readGlmPackages(key, station, timeoutMs) {
	const result = await fetchJson(
		`${station.host}${PACKAGES_PATH}?pageNum=1&pageSize=100`,
		{ authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': USER_AGENT },
		timeoutMs,
	);
	if (result.failure !== undefined) return [];
	if (result.status < 200 || result.status >= 300) return [];
	if (businessFailure(result.body) !== undefined) return [];
	const rows = result.body?.rows ?? result.body?.data?.rows;
	if (!Array.isArray(rows)) return [];

	const packages = [];
	for (const row of rows) {
		if (row === null || typeof row !== 'object') continue;
		const remaining = numberOf(row.tokenBalance) ?? numberOf(row.availableBalance);
		if (remaining === undefined) continue;
		const entry = {
			name: text(row.resourcePackageName) ?? 'token package',
			remaining,
		};
		const grant = numberOf(row.tokensMagnitude);
		if (grant !== undefined) entry.grant = grant;
		const consumeType = text(row.consumeType);
		if (consumeType !== undefined) entry.consumeType = consumeType;
		const model = text(row.suitableModel);
		if (model !== undefined) entry.model = model;
		const expiresAt = packageExpiry(row);
		if (expiresAt !== undefined) entry.expiresAt = expiresAt;
		packages.push(entry);
	}
	return packages;
}

/**
 * Best-effort expiry extraction from a package row.
 *
 * @param row - one raw package row.
 * @returns the expiry in epoch milliseconds, or undefined.
 */
function packageExpiry(row) {
	for (const field of ['expirationTime', 'packageExpirationTime', 'expireTime', 'validEndTime', 'endTime', 'expireAt', 'validUntil']) {
		const value = row[field];
		if (value === undefined || value === null) continue;
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value < 1e12 ? value * 1000 : value;
		}
		if (typeof value === 'string' && value.trim() !== '') {
			// The platform writes naive timestamps in UTC+8.
			const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value.trim()) ? `${value.trim()}+08:00` : value;
			const parsed = Date.parse(normalized);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

/**
 * Choose the cash payload to display.
 *
 * @param results - per-station cash results.
 * @returns the index of the chosen result, or -1.
 */
function pickCashIndex(results) {
	let firstSuccess = -1;
	for (let index = 0; index < results.length; index++) {
		if (results[index].payload === undefined) continue;
		if (firstSuccess === -1) firstSuccess = index;
		if (isFunded(results[index].payload)) return index;
	}
	return firstSuccess;
}

/**
 * Whether a cash payload reports any money.
 *
 * @param payload - cash payload.
 * @returns true when a balance, spend, or freeze is non-zero.
 */
function isFunded(payload) {
	const amounts = payload.balances.flatMap((balance) => [balance.total, balance.granted, balance.toppedUp]);
	amounts.push(payload.extras.spent, payload.extras.frozen);
	return amounts.some((value) => numberOrZero(value) > 0);
}

/**
 * Read the cash account report.
 *
 * @param known - provider descriptor.
 * @param key - resolved API key.
 * @param station - station descriptor carrying host and currency.
 * @param timeoutMs - per-request timeout.
 * @param provider - provider id to echo.
 * @param model - model id to echo.
 * @returns a payload or an error.
 */
async function readGlmCash(known, key, station, timeoutMs, provider, model) {
	const result = await fetchJson(
		`${station.host}${CASH_PATH}`,
		{ authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': USER_AGENT },
		timeoutMs,
	);
	if (result.failure !== undefined) {
		return { error: failure(provider, known, result.failure.code, result.failure.message, model) };
	}
	if (result.status === 401 || result.status === 403) {
		return { error: failure(provider, known, 'UNAUTHORIZED', detailOf(result.body) ?? `HTTP ${result.status}`, model) };
	}
	const envelope = businessFailure(result.body);
	if (envelope !== undefined) {
		return { error: failure(provider, known, envelope.unauthorized ? 'UNAUTHORIZED' : 'HTTP', envelope.message, model) };
	}

	const data = result.body?.data !== null && typeof result.body?.data === 'object' ? result.body.data : undefined;
	const total = numberOf(data?.availableBalance) ?? numberOf(data?.balance);
	const granted = numberOf(data?.giveAmount);
	const toppedUp = numberOf(data?.rechargeAmount);
	const spent = numberOf(data?.totalSpendAmount);
	const frozen = numberOf(data?.frozenBalance);
	if (total === undefined && granted === undefined && toppedUp === undefined) {
		return { error: failure(provider, known, 'RESPONSE', 'cash report carries no amounts', model) };
	}
	return {
		payload: {
			status: 'ok',
			provider,
			providerName: known.name,
			model,
			station: station.station,
			kind: 'cash',
			currency: station.currency,
			isAvailable: total === undefined ? true : total > 0,
			balances: [
				{
					currency: station.currency,
					total: formatAmount(total),
					granted: formatAmount(granted),
					toppedUp: formatAmount(toppedUp),
				},
			],
			extras: { spent: formatAmount(spent), frozen: formatAmount(frozen) },
			fetchedAt: Date.now(),
		},
	};
}

/**
 * Read coding-plan quota limits.
 *
 * The China monitor endpoint authenticates with the raw key, z.ai with a bearer
 * token — the same split the plan's own clients use.
 *
 * @param known - provider descriptor.
 * @param key - resolved API key.
 * @param station - station descriptor carrying host and currency.
 * @param timeoutMs - per-request timeout.
 * @param provider - provider id to echo.
 * @param model - model id to echo.
 * @returns a payload or an error.
 */
async function readGlmQuota(known, key, station, timeoutMs, provider, model) {
	const result = await fetchJson(
		`${station.host}${QUOTA_PATH}`,
		{
			authorization: station.host === BIGMODEL_HOST ? key : `Bearer ${key}`,
			accept: 'application/json',
			'user-agent': USER_AGENT,
		},
		timeoutMs,
	);
	if (result.failure !== undefined) {
		return { error: failure(provider, known, result.failure.code, result.failure.message, model) };
	}
	if (result.status === 401 || result.status === 403) {
		return { error: failure(provider, known, 'UNAUTHORIZED', detailOf(result.body) ?? `HTTP ${result.status}`, model) };
	}
	const envelope = businessFailure(result.body);
	if (envelope !== undefined) {
		return { error: failure(provider, known, envelope.unauthorized ? 'UNAUTHORIZED' : 'HTTP', envelope.message, model) };
	}

	const quota = parseQuota(result.body);
	if (quota.length === 0) {
		return { error: failure(provider, known, 'RESPONSE', 'this account exposes neither a cash balance nor a coding-plan quota', model) };
	}
	return {
		payload: {
			status: 'ok',
			provider,
			providerName: known.name,
			model,
			station: station.station,
			kind: 'quota',
			currency: station.currency,
			quota,
			fetchedAt: Date.now(),
		},
	};
}

/**
 * Extract remaining percentages from a coding-plan quota response.
 *
 * @param body - parsed quota response.
 * @returns quota entries, possibly empty.
 */
function parseQuota(body) {
	const container = body?.data ?? body;
	const limits = Array.isArray(container) ? container : Array.isArray(container?.limits) ? container.limits : [];
	const quota = [];
	for (const item of limits) {
		if (item === null || typeof item !== 'object') continue;
		const kind = text(item.type) ?? text(item.name);
		if (kind === undefined) continue;
		const percentage = numberOf(item.percentage);
		if (kind === 'TIME_LIMIT') {
			const used = numberOrZero(item.currentValue);
			const limit = numberOrZero(item.usage);
			const remaining = limit > 0 ? clamp(100 - (used / limit) * 100, 0, 100) : 100;
			quota.push({ id: 'web', remaining, resetsAt: numberOf(item.nextResetTime) });
			continue;
		}
		if (percentage === undefined) continue;
		const id = item.unit === 3 ? '5h' : item.unit === 6 ? 'week' : undefined;
		if (id === undefined) continue;
		quota.push({ id, remaining: clamp(100 - percentage, 0, 100), resetsAt: numberOf(item.nextResetTime) });
	}
	const seen = new Set();
	return quota.filter((entry) => {
		if (seen.has(entry.id)) return false;
		seen.add(entry.id);
		return true;
	});
}

/**
 * GET a JSON endpoint, mapping transport failures to stable codes.
 *
 * @param url - absolute endpoint.
 * @param headers - request headers.
 * @param timeoutMs - per-request timeout.
 * @returns parsed response or a failure.
 */
async function fetchJson(url, headers, timeoutMs) {
	let response;
	try {
		response = await fetch(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		const timedOut = error !== null && typeof error === 'object' && error.name === 'TimeoutError';
		return { failure: { code: timedOut ? 'TIMEOUT' : 'NETWORK', message: describeError(error) } };
	}
	let body;
	try {
		const raw = await response.text();
		body = raw.length > 0 ? JSON.parse(raw) : undefined;
	} catch {
		body = undefined;
	}
	return { status: response.status, body };
}

/**
 * Report the provider's own failure message when its envelope says it failed.
 *
 * @param body - parsed provider response.
 * @returns the failure, or undefined for a successful envelope.
 */
function businessFailure(body) {
	if (body === undefined || body === null || typeof body !== 'object') {
		return { unauthorized: false, message: 'response body is not valid JSON' };
	}
	if (body.success === true) return undefined;
	if (body.code === 200 || body.code === '200') return undefined;
	if (body.success === false || typeof body.code === 'number') {
		const unauthorized = body.code === 401 || body.code === 403;
		return { unauthorized, message: detailOf(body) ?? `provider code ${body.code}` };
	}
	return undefined;
}

/**
 * Read the provider's human-readable detail without trusting its shape.
 *
 * @param body - parsed provider response.
 * @returns the detail text, or undefined.
 */
function detailOf(body) {
	if (body === undefined || body === null || typeof body !== 'object') return undefined;
	const candidate = body.msg ?? body.message ?? body.error?.message ?? (typeof body.error === 'string' ? body.error : undefined);
	if (typeof candidate !== 'string') return undefined;
	const trimmed = candidate.trim();
	return trimmed.length > 0 ? trimmed.slice(0, 512) : undefined;
}

/**
 * Build one error payload.
 *
 * @param provider - provider id.
 * @param known - provider descriptor, when known.
 * @param code - stable failure code for the client.
 * @param message - human-readable cause.
 * @param model - model id, when known.
 * @returns the payload.
 */
function failure(provider, known, code, message, model) {
	return { status: 'error', provider, providerName: known?.name, model, code, message };
}

/**
 * Write one JSON response.
 *
 * @param res - response object.
 * @param status - HTTP status.
 * @param payload - JSON-serializable payload.
 */
function sendJson(res, status, payload) {
	const json = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(json),
	});
	res.end(json);
}

/**
 * Describe an unknown thrown value for a payload.
 *
 * @param error - the thrown value.
 * @returns its message.
 */
function describeError(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Coerce a provider amount to a number.
 *
 * @param value - number or numeric string.
 * @returns the number, or undefined.
 */
function numberOf(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * Format an amount for display, keeping two decimals.
 *
 * @param value - the amount.
 * @returns the formatted amount, or an empty string.
 */
function formatAmount(value) {
	if (value === undefined) return '';
	return value.toFixed(2);
}

/**
 * Coerce to a finite number, defaulting to zero.
 *
 * @param value - the candidate.
 * @returns the number.
 */
function numberOrZero(value) {
	return numberOf(value) ?? 0;
}

/**
 * Clamp a number into a range.
 *
 * @param value - the value to clamp.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped value.
 */
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

/**
 * Trim a non-empty string.
 *
 * @param value - any value.
 * @returns the trimmed text, or undefined.
 */
function text(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Accept a positive finite number.
 *
 * @param value - candidate value.
 * @param fallback - value to use when the candidate is unusable.
 * @returns the accepted value or the fallback.
 */
function positiveNumber(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
