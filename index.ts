/**
 * pi-dsearch — 基于 DeepSeek Search / Fetch API 的网页搜索与抓取扩展。
 *
 * https://api-docs.deepseek.com/zh-cn/guides/search
 *   POST https://api.deepseek.com/v1/tools/search   搜索网页（DeepSeek 自研搜索引擎）
 *   POST https://api.deepseek.com/v1/tools/fetch    抓取单个网页，以 Markdown 返回正文
 *   鉴权: Authorization: Bearer <DeepSeek API Key>
 *
 * 行为:
 *   - `web_search` / `web_fetch` 注册时 defaultActive: false —— 会话开始时不出现在模型上下文中
 *   - 主命令 `/ds`（唯一命令）：`/ds <搜索词>` 搜索、`/ds <URL>` 抓取，两者都会打开常驻
 *   - 常驻开启后，两个工具对本会话后续每个 run 都保持激活（模型可自行继续搜索/抓取）
 *   - `/ds` 无参数 = 切换开关（再执行一次即关闭），没有 on/off/status 子命令
 *   - 关闭后两个工具立即从活跃集合移除，并在下一次 run 开始前再次确认移除
 *   - 每次 run 开始前按常驻开关同步激活集合，会话恢复、切换分支后依然生效
 *
 * 密钥来源（按 pi 内置配置解析，优先级由 pi 决定）:
 *   - /login deepseek 存入 auth.json 的密钥（含 "!command" 动态密钥）
 *   - 环境变量 DEEPSEEK_API_KEY
 *   - models.json 中 deepseek provider 的 apiKey
 *   以上都不存在时，回退到直接读 DEEPSEEK_API_KEY
 *
 * 计费与限速（见官方文档）:
 *   - Search / Fetch 均按成功请求计费（Search 1000 次 5 元，Fetch 1000 次 5 元），失败或无结果不计费
 *   - 每个账号 Search / Fetch 各 5 QPS，互不占用；Fetch 另有按目标域名的限速
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_TOOL = "web_search";
const FETCH_TOOL = "web_fetch";
const TOOL_NAMES = [SEARCH_TOOL, FETCH_TOOL] as const;
const TOOL_SET: ReadonlySet<string> = new Set(TOOL_NAMES);
const NO_TOOLS: ReadonlySet<string> = new Set();

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const PROVIDER_ID = "deepseek";

const MAX_QUERY = 128; // 搜索词最多 128 个 Unicode 字符
const MAX_ORI_QUESTION = 128;
const MAX_URL = 8192;
const SEARCH_CONTENT_CHARS = 4000; // need_content 时每条正文的截断长度
const FETCH_CONTENT_CHARS = 20_000; // 抓取正文的默认截断长度
const FETCH_CONTENT_MAX = 100_000;

const NO_KEY = "未找到 DeepSeek API Key，请先 /login deepseek 或设置 DEEPSEEK_API_KEY";

/** 按 Unicode 码点截断，避免把代理对（emoji）切成半个字符 */
const clampChars = (value: string, max: number): string =>
	value.length <= max ? value : Array.from(value).slice(0, max).join("");

/** 从 pi 内置配置解析 DeepSeek API Key（auth.json / 环境变量 / models.json），失败时回退环境变量 */
const resolveApiKey = async (ctx: { modelRegistry: {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
} }): Promise<string | undefined> => {
	try {
		return (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? process.env.DEEPSEEK_API_KEY;
	} catch {
		return process.env.DEEPSEEK_API_KEY;
	}
};

const ERROR_HINTS: Record<number, string> = {
	400: "请求不合法",
	401: "API Key 缺失或无效",
	402: "账号余额不足，请先充值",
	403: "被安全策略拒绝",
	404: "未能获取可用的网页内容",
	408: "读取请求体超时，可稍后重试",
	413: "请求体超过大小限制",
	429: "超过 QPS 限制（每账号 5 QPS），请稍后重试",
	500: "服务器内部错误，可稍后重试",
	504: "下游请求超时，可稍后重试",
};

interface ApiErrorPayload {
	error?: { message?: string; type?: string; code?: string };
}

/** 调用 Search / Fetch 接口；非 2xx 时把 OpenAI 兼容错误体转成可读报错 */
const callApi = async <T>(
	endpoint: string,
	label: string,
	payload: unknown,
	apiKey: string,
	signal?: AbortSignal,
): Promise<T> => {
	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		signal,
	});
	if (!res.ok) {
		const raw = await res.text().catch(() => "");
		let detail = "";
		try {
			detail = (JSON.parse(raw) as ApiErrorPayload).error?.message ?? "";
		} catch {
			// 非 JSON 错误体，退回原始文本
		}
		if (!detail) detail = raw.replace(/\s+/g, " ").slice(0, 200);
		const hint = ERROR_HINTS[res.status] ?? "请求失败";
		throw new Error(`${label}失败 (HTTP ${res.status} ${hint})${detail ? `: ${detail}` : ""}`);
	}
	return (await res.json()) as T;
};

/** 校验 Fetch 接口要求的 URL：http/https、含 host、不带用户名密码、长度 ≤ 8192 */
const parseFetchUrl = (raw: string): string => {
	const value = raw.trim();
	if (!value) throw new Error("url 不能为空");
	if (value.length > MAX_URL) throw new Error(`url 过长（最多 ${MAX_URL} 个字符）`);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`不是合法的 URL: ${clampChars(value, 120)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("仅支持 http/https URL");
	if (parsed.username || parsed.password) throw new Error("URL 不能携带用户名或密码");
	if (!parsed.hostname) throw new Error("URL 缺少 host");
	return parsed.toString();
};

interface SearchParams {
	query: string;
	count?: number;
	ori_question?: string;
	need_content?: boolean;
}

interface SearchResultItem {
	rerank_score?: number;
	title?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	site_name?: string | null;
	site_icon?: string | null;
	date?: string | null;
	authority?: number;
}

interface FetchParams {
	url: string;
	maxChars?: number;
}

interface FetchResult {
	title?: string;
	content?: string;
}

export default function dsearch(pi: ExtensionAPI) {
	// 常驻开关：一旦用 /ds 激活过，本会话后续 run 都保留两个工具
	let enabled = false;

	// 只改动本扩展这两个工具；其他工具的激活状态不受影响
	const setActive = (want: ReadonlySet<string>) => {
		const current = pi.getActiveTools();
		const next = current.filter((name) => !TOOL_SET.has(name));
		for (const name of TOOL_NAMES) if (want.has(name)) next.push(name);
		if (next.length !== current.length || next.some((name, i) => name !== current[i])) pi.setActiveTools(next);
	};

	pi.registerTool({
		name: SEARCH_TOOL,
		label: "Web Search",
		description:
			"通过 DeepSeek 搜索引擎搜索网页，返回标题、链接、摘要（可选正文）。query 支持 site:、-site:、-关键词、" +
			'-"精确短语"、"精确短语"、lang:、after:、before: 等搜索操作符。需要某个链接的完整内容时，' +
			"设 need_content=true，或对该 URL 调用 web_fetch。",
		promptSnippet: "web_search — 网页搜索（DeepSeek Search API）",
		parameters: Type.Object({
			query: Type.String({
				description: `搜索词（1~${MAX_QUERY} 字符），如 "DeepSeek V4 发布 lang:zh after:2025"`,
			}),
			count: Type.Optional(Type.Number({ description: "返回条数 1~50，默认 10" })),
			ori_question: Type.Optional(
				Type.String({ description: `触发搜索的用户原始问题（1~${MAX_ORI_QUESTION} 字符），有助于理解搜索意图` }),
			),
			need_content: Type.Optional(
				Type.Boolean({ description: `是否在结果中返回网页正文（每条截断到 ${SEARCH_CONTENT_CHARS} 字符），默认 false` }),
			),
		}),
		exposure: "direct",
		defaultActive: false, // 注册即不激活：其他情况下上下文不可见
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params: SearchParams, signal, _onUpdate, ctx) {
			const apiKey = await resolveApiKey(ctx);
			if (!apiKey) throw new Error(NO_KEY);

			const query = clampChars(params.query.trim(), MAX_QUERY);
			if (!query) throw new Error("query 不能为空");
			const needContent = params.need_content === true;

			const body: Record<string, unknown> = { query };
			if (params.count != null) body.count = Math.min(50, Math.max(1, Math.round(params.count)));
			const oriQuestion = params.ori_question?.trim();
			if (oriQuestion) body.ori_question = clampChars(oriQuestion, MAX_ORI_QUESTION);
			if (params.need_content != null) body.need_content = needContent;

			const data = await callApi<{ results?: SearchResultItem[] }>(SEARCH_URL, "搜索", body, apiKey, signal);
			const results = data.results ?? [];
			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: `没有找到与 "${query}" 相关的结果。` }],
					details: { query, resultCount: 0 },
				};
			}

			const blocks = results.map((r, i) => {
				const lines = [`[${i + 1}] ${r.title || "(无标题)"}`];
				if (r.url) lines.push(`URL: ${r.url}`);
				const authority = r.authority != null && r.authority >= 0 ? `权威 ${r.authority}/4` : undefined;
				const meta = [r.site_name, r.date?.slice(0, 10), authority].filter(Boolean).join(" · ");
				if (meta) lines.push(`来源: ${meta}`);
				const digest = r.summary || r.snippet || "";
				if (digest) lines.push(`摘要: ${digest}`);
				if (needContent && r.content) lines.push(`正文: ${clampChars(r.content, SEARCH_CONTENT_CHARS)}`);
				return lines.join("\n");
			});

			return {
				content: [
					{ type: "text" as const, text: `已搜索 "${query}"，共 ${results.length} 条结果：\n\n${blocks.join("\n\n")}` },
				],
				details: {
					query,
					resultCount: results.length,
					results: results.map((r) => ({
						title: r.title ?? "",
						url: r.url ?? "",
						date: r.date ?? null,
						authority: r.authority ?? -1,
						rerank_score: r.rerank_score ?? null,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: FETCH_TOOL,
		label: "Web Fetch",
		description:
			"抓取单个网页，返回 Markdown 正文（DeepSeek Fetch API）。适合在 web_search 之后读取具体结果的完整内容。" +
			"目标站点不可用、返回错误内容类型或被安全策略拦截时会失败（HTTP 403/404）。",
		promptSnippet: "web_fetch — 抓取网页正文（DeepSeek Fetch API，Markdown）",
		parameters: Type.Object({
			url: Type.String({ description: `要抓取的网页地址，必须为 http/https 且含 host，最多 ${MAX_URL} 字符` }),
			maxChars: Type.Optional(
				Type.Number({
					description: `返回正文的最大字符数，默认 ${FETCH_CONTENT_CHARS}，范围 1000~${FETCH_CONTENT_MAX}`,
				}),
			),
		}),
		exposure: "direct",
		defaultActive: false,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params: FetchParams, signal, _onUpdate, ctx) {
			const apiKey = await resolveApiKey(ctx);
			if (!apiKey) throw new Error(NO_KEY);

			const url = parseFetchUrl(params.url);
			const maxChars = Math.min(
				FETCH_CONTENT_MAX,
				Math.max(1000, Math.round(params.maxChars ?? FETCH_CONTENT_CHARS)),
			);

			const data = await callApi<FetchResult>(FETCH_URL, "网页抓取", { url }, apiKey, signal);
			const content = data.content ?? "";
			if (!content.trim()) throw new Error(`未能从 ${url} 提取到正文（页面无可读 Markdown 内容）`);

			const chars = Array.from(content);
			const truncated = chars.length > maxChars;
			const bodyText = truncated ? chars.slice(0, maxChars).join("") : content;
			const title = data.title?.trim() || "(无标题)";
			const footer = truncated ? `\n\n[已截断：全文 ${chars.length} 字符，仅返回前 ${maxChars} 字符]` : "";

			return {
				content: [{ type: "text" as const, text: `URL: ${url}\n标题: ${title}\n\n${bodyText}${footer}` }],
				details: { url, title, chars: chars.length, truncated },
			};
		},
	});

	const applyEnabled = () => setActive(enabled ? TOOL_SET : NO_TOOLS);

	// 每次 run 开始前按常驻开关同步一次：开启则保留，关闭则移除
	pi.on("before_agent_start", () => {
		applyEnabled();
	});

	const notify = (ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, type);
	};

	const statusText = () => `web_search / web_fetch 常驻: ${enabled ? "开" : "关"}`;

	const disable = () => {
		enabled = false;
		applyEnabled();
	};

	// 开启前先确认有 Key，避免开了也用不了
	const enable = async (ctx: ExtensionCommandContext): Promise<boolean> => {
		if (!(await resolveApiKey(ctx))) {
			notify(ctx, NO_KEY, "warning");
			return false;
		}
		enabled = true;
		applyEnabled();
		return true;
	};

	const buildPrompt = (kind: "search" | "fetch", input: string): string =>
		kind === "search"
			? `搜索: ${input}\n请使用 web_search 工具搜索；如有需要，再用 web_fetch 读取具体结果页。然后基于结果简要回答，并注明来源链接。`
			: `抓取: ${input}\n请使用 web_fetch 工具抓取该网页，然后总结要点，并给出原文链接。`;

	// 搜索/抓取：校验参数 -> 确认 Key -> 打开常驻 -> 发起一次 run
	const runQuery = async (kind: "search" | "fetch", input: string, ctx: ExtensionCommandContext) => {
		if (kind === "fetch") {
			try {
				parseFetchUrl(input);
			} catch (err) {
				notify(ctx, (err as Error).message, "warning");
				return;
			}
		}
		if (!(await enable(ctx))) return;
		pi.sendUserMessage(buildPrompt(kind, input));
	};

	// /ds：唯一命令，完成搜索、抓取、开/关常驻
	const dsCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const input = args.trim();

		if (!input) {
			// 无参数 = 切换：再执行一次即可关闭
			if (enabled) {
				disable();
				notify(ctx, `${statusText()}（已从后续 run 移除）`, "warning");
			} else if (await enable(ctx)) {
				notify(ctx, statusText());
			}
			return;
		}

		// 参数像 URL 就抓取，否则搜索
		if (/^https?:\/\//i.test(input)) await runQuery("fetch", input, ctx);
		else await runQuery("search", input, ctx);
	};

	pi.registerCommand("ds", {
		description: "网页搜索/抓取（DeepSeek）: /ds <搜索词|URL>，无参数切换常驻",
		handler: dsCommand,
	});
}
