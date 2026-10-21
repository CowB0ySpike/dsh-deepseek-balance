/**
 * Host half of `dsh-deepseek-balance`.
 *
 * Resolves the configured DeepSeek API key through the credentials service and
 * reads the account balance from `GET /user/balance`, then serves the result to
 * the browser half over one read-only same-origin route. The key never leaves
 * this process: the response carries balances and status only.
 *
 * @module dsh-deepseek-balance
 */

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const ERROR_CACHE_TTL_MS = 5_000;
const ROUTE_PATH = '/deepseek-balance';
const USER_AGENT = 'dsh-deepseek-balance/1.0.0';

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

	/** Cached payload plus the instant it stops being reusable. */
	let cached;
	/** Shared in-flight read so concurrent pages cost one upstream call. */
	let inflight;

	/**
	 * Read the balance from the provider, mapping every failure to a status the
	 * client can render.
	 *
	 * @returns the balance payload.
	 */
	async function readBalance() {
		const ref = options.apiKeyEnv;
		let info;
		try {
			info = await ctx.credentials.describe(ref);
		} catch (error) {
			return failure(ref, 'CREDENTIALS', describeError(error));
		}
		if (info === undefined || info.configured !== true) return { status: 'unconfigured', ref };

		let resolved;
		try {
			resolved = await ctx.credentials.resolve(ref);
		} catch (error) {
			return failure(ref, 'CREDENTIALS', describeError(error));
		}
		if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value.length === 0) {
			return { status: 'unconfigured', ref };
		}

		const endpoint = `${options.baseURL}/user/balance`;
		let response;
		try {
			response = await fetch(endpoint, {
				method: 'GET',
				redirect: 'error',
				headers: {
					authorization: `Bearer ${resolved.value}`,
					accept: 'application/json',
					'user-agent': USER_AGENT,
				},
				signal: AbortSignal.timeout(options.timeoutMs),
			});
		} catch (error) {
			const timedOut = error !== null && typeof error === 'object' && error.name === 'TimeoutError';
			return failure(ref, timedOut ? 'TIMEOUT' : 'NETWORK', describeError(error));
		}

		if (!response.ok) {
			const detail = await readErrorDetail(response);
			const unauthorized = response.status === 401 || response.status === 403;
			return {
				status: 'error',
				ref,
				code: unauthorized ? 'UNAUTHORIZED' : 'HTTP',
				httpStatus: response.status,
				message: detail ?? `HTTP ${response.status}`,
			};
		}

		let body;
		try {
			body = await response.json();
		} catch {
			return failure(ref, 'RESPONSE', 'response body is not valid JSON');
		}

		const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
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
			ref,
			isAvailable: body?.is_available !== false,
			balances,
			fetchedAt: Date.now(),
		};
	}

	/**
	 * Serve one payload, reusing the cache unless a forced refresh is requested.
	 *
	 * @param force - bypass the cache (the refresh action).
	 * @returns the payload the route returns.
	 */
	function getBalance(force) {
		if (force !== true && cached !== undefined && Date.now() < cached.expiresAt) {
			return Promise.resolve(cached.payload);
		}
		if (inflight !== undefined) return inflight;
		inflight = readBalance().then(
			(payload) => {
				inflight = undefined;
				const ttl = payload.status === 'ok' ? options.cacheTtlMs : ERROR_CACHE_TTL_MS;
				cached = { payload, expiresAt: Date.now() + ttl };
				return payload;
			},
			(error) => {
				inflight = undefined;
				const payload = failure(options.apiKeyEnv, 'INTERNAL', describeError(error));
				cached = { payload, expiresAt: Date.now() + ERROR_CACHE_TTL_MS };
				return payload;
			},
		);
		return inflight;
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
					const payload = await getBalance(requested.searchParams.get('refresh') === '1');
					const json = JSON.stringify(payload);
					res.writeHead(200, {
						'content-type': 'application/json; charset=utf-8',
						'cache-control': 'no-store',
						'content-length': Buffer.byteLength(json),
					});
					res.end(json);
				} catch (error) {
					if (res.headersSent) {
						res.end();
						return;
					}
					const json = JSON.stringify(failure(options.apiKeyEnv, 'INTERNAL', describeError(error)));
					res.writeHead(500, {
						'content-type': 'application/json; charset=utf-8',
						'cache-control': 'no-store',
						'content-length': Buffer.byteLength(json),
					});
					res.end(json);
				}
			},
		}),
	);
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
	const rawBaseUrl = text(source.baseURL) ?? DEFAULT_BASE_URL;
	const baseURL = URL.canParse(rawBaseUrl) ? rawBaseUrl.replace(/\/+$/, '') : DEFAULT_BASE_URL;
	return {
		apiKeyEnv: text(source.apiKeyEnv) ?? DEFAULT_API_KEY_ENV,
		baseURL,
		cacheTtlMs: positiveNumber(source.cacheTtlMs, DEFAULT_CACHE_TTL_MS),
		timeoutMs: positiveNumber(source.timeoutMs, DEFAULT_TIMEOUT_MS),
	};
}

/**
 * Build one error payload.
 *
 * @param ref - credential reference name (never its value).
 * @param code - stable failure code for the client.
 * @param message - human-readable cause.
 * @returns the payload.
 */
function failure(ref, code, message) {
	return { status: 'error', ref, code, message };
}

/**
 * Read the provider's error detail without trusting its shape.
 *
 * @param response - a non-2xx provider response.
 * @returns the detail text, or undefined when none could be read.
 */
async function readErrorDetail(response) {
	try {
		const raw = await response.text();
		if (typeof raw !== 'string' || raw.length === 0) return undefined;
		try {
			const parsed = JSON.parse(raw);
			const detail = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
			if (typeof detail === 'string' && detail.length > 0) return detail.slice(0, 512);
		} catch {
			// Not JSON: fall through to the raw body.
		}
		return raw.slice(0, 512);
	} catch {
		return undefined;
	}
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
