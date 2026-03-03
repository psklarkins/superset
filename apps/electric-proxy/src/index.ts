import { verifyJWT } from "./auth";
import { buildUpstreamUrl } from "./electric";
import type { Env } from "./types";
import { buildWhereClause } from "./where";

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Expose-Headers":
		"electric-handle, electric-offset, electric-schema, electric-up-to-date, electric-cursor",
};

function corsResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: CORS_HEADERS });
}

function addCorsHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	if (headers.get("content-encoding")) {
		headers.delete("content-encoding");
		headers.delete("content-length");
	}
	for (const [key, value] of Object.entries(CORS_HEADERS)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// Global in-flight map for request coalescing.
// Workers on the same edge node share the isolate, so concurrent requests
// for the same shape+offset are collapsed into a single upstream fetch.
// We store the original Response promise — each consumer calls .clone()
// on it, leaving the original unconsumed so further clones are safe.
const inflight = new Map<string, Promise<Response>>();

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (request.method !== "GET") {
			return corsResponse(405, "Method not allowed");
		}

		const authHeader = request.headers.get("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return corsResponse(401, "Missing or invalid Authorization header");
		}

		const token = authHeader.slice(7);
		const auth = await verifyJWT(token, env.AUTH_URL);
		if (!auth) {
			return corsResponse(401, "Invalid or expired token");
		}

		const url = new URL(request.url);

		const tableName = url.searchParams.get("table");
		if (!tableName) {
			return corsResponse(400, "Missing table parameter");
		}

		const organizationId = url.searchParams.get("organizationId");

		if (tableName !== "auth.organizations") {
			if (!organizationId) {
				return corsResponse(400, "Missing organizationId parameter");
			}
			if (!auth.organizationIds.includes(organizationId)) {
				return corsResponse(403, "Not a member of this organization");
			}
		}

		const whereClause = buildWhereClause(
			tableName,
			organizationId ?? "",
			auth.organizationIds,
		);
		if (!whereClause) {
			return corsResponse(400, `Unknown table: ${tableName}`);
		}

		const upstreamUrl = buildUpstreamUrl(url, tableName, whereClause, env);

		// Cache key uses the Worker's own URL to stay in-zone for the Cache API.
		// organizationId stays in the key to prevent cross-tenant cache sharing.
		// For auth.organizations (no organizationId param), scope by JWT org list.
		const cacheUrl = new URL(request.url);
		if (tableName === "auth.organizations") {
			cacheUrl.searchParams.set(
				"_orgIds",
				[...auth.organizationIds].sort().join(","),
			);
		}
		const cacheKey = new Request(cacheUrl.toString());

		// 1. Check Cache API (serves previously-cached responses)
		const cache = caches.default;
		const cached = await cache.match(cacheKey);
		if (cached) {
			return addCorsHeaders(cached);
		}

		// 2. Request coalescing — if an identical upstream fetch is already
		//    in-flight on this edge node, piggyback on it instead of making
		//    a duplicate request to Electric.
		const coalescingKey = upstreamUrl.toString();
		let fetchPromise = inflight.get(coalescingKey);
		const isOriginator = !fetchPromise;

		if (!fetchPromise) {
			fetchPromise = fetch(coalescingKey);
			inflight.set(coalescingKey, fetchPromise);
			fetchPromise.finally(() => inflight.delete(coalescingKey));
		}

		const response = (await fetchPromise).clone();

		// Only the originator writes to cache to avoid duplicate puts
		if (isOriginator && response.ok && response.headers.has("cache-control")) {
			ctx.waitUntil(cache.put(cacheKey, response.clone()));
		}

		return addCorsHeaders(response);
	},
} satisfies ExportedHandler<Env>;
