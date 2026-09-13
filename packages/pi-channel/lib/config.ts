/**
 * pi-channel 配置加载。
 *
 * 唯一来源：`~/.pi/agent/extensions/pi-channel/config.json`
 * （目录约定见仓库根 AGENTS.md「配置与运行数据一律放 extensions 目录」）。
 *
 * 旧来源（`~/.config/rpiv-ask-user-question/config.json` 的 remote.feishu / remote.tg、
 * `~/.pi/agent/feishu/` 桥接）在 2026-09-13 迁移后**不再读取** —— 凭据只归本插件。
 *
 * 解析保持 fail-soft：字段缺失/类型不对时该 provider 视为「未配置」，绝不抛异常打断 pi 启动。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FeishuReceiverType } from "./events.ts";

export const EXTENSION_NAME = "pi-channel";

/** 配置文件路径（用户配置目录优先，且目前是**唯一**来源）。 */
export function resolveConfigPath(): string {
	return join(getAgentDir(), "extensions", EXTENSION_NAME, "config.json");
}

export type FeishuReceiver = { type: FeishuReceiverType; value: string };

export type FeishuChannelConfig = {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	/** 是否建立长连接接收入站事件（消息 / 卡片回调）。默认 true。 */
	inbound: boolean;
	/** 群聊里只有 @ 机器人 的消息才算入站。默认 true。 */
	requireMention: boolean;
	/** 私聊策略（对齐 SDK 的 PolicyConfig.dmMode）：open = 不额外配置即可收私聊。默认 open。 */
	dmMode: "open" | "allowlist" | "pair" | "disabled";
	/** 缺省收件人：消费方 `ag-pi-channel:send` 不带 `to` 时用它 */
	defaultReceiver?: FeishuReceiver;
};

export type TelegramChannelConfig = {
	botToken: string;
	/** 可选 HTTP(S) 代理，如 "http://127.0.0.1:6152"；缺省回退环境变量/系统代理。 */
	proxy?: string;
	/** 是否长轮询接收入站事件。默认 true。 */
	inbound: boolean;
	/** 缺省收件人（chat id）：消费方不带 `to` 时用它 */
	defaultChatId?: string;
};

export type ChannelConfig = {
	feishu?: FeishuChannelConfig;
	telegram?: TelegramChannelConfig;
};

const RECEIVER_TYPES: readonly FeishuReceiverType[] = ["open_id", "user_id", "union_id", "email", "chat_id"];
/** 私聊策略取值，对齐 SDK PolicyConfig.dmMode（缺省 open） */
const DM_MODES: readonly FeishuChannelConfig["dmMode"][] = ["open", "allowlist", "pair", "disabled"];

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function asBool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function parseReceiver(raw: unknown): FeishuReceiver | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.type !== "string" || !(RECEIVER_TYPES as readonly string[]).includes(r.type)) return undefined;
	if (!isNonEmptyString(r.value)) return undefined;
	return { type: r.type as FeishuReceiverType, value: r.value.trim() };
}

function parseFeishu(raw: unknown): FeishuChannelConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (!isNonEmptyString(r.appId) || !isNonEmptyString(r.appSecret)) return undefined;
	return {
		appId: r.appId.trim(),
		appSecret: r.appSecret.trim(),
		domain: r.domain === "lark" ? "lark" : "feishu",
		inbound: asBool(r.inbound, true),
		requireMention: asBool(r.requireMention, true),
		dmMode: DM_MODES.includes(r.dmMode as (typeof DM_MODES)[number]) ? (r.dmMode as FeishuChannelConfig["dmMode"]) : "open",
		defaultReceiver: parseReceiver(r.defaultReceiver),
	};
}

function parseTelegram(raw: unknown): TelegramChannelConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (!isNonEmptyString(r.botToken)) return undefined;
	const chatId = r.defaultChatId;
	return {
		botToken: r.botToken.trim(),
		proxy: isNonEmptyString(r.proxy) ? r.proxy.trim() : undefined,
		inbound: asBool(r.inbound, true),
		defaultChatId: isNonEmptyString(chatId) || typeof chatId === "number" ? String(chatId) : undefined,
	};
}

/** 读取并解析配置；文件缺失或非法时返回空配置（两个 provider 都视为未配置）。 */
export function loadChannelConfig(): ChannelConfig {
	try {
		const parsed = JSON.parse(readFileSync(resolveConfigPath(), "utf8")) as Record<string, unknown>;
		return { feishu: parseFeishu(parsed?.feishu), telegram: parseTelegram(parsed?.telegram) };
	} catch {
		return {};
	}
}

export function isFeishuConfigured(cfg: ChannelConfig): cfg is ChannelConfig & { feishu: FeishuChannelConfig } {
	return Boolean(cfg.feishu);
}

export function isTelegramConfigured(cfg: ChannelConfig): cfg is ChannelConfig & { telegram: TelegramChannelConfig } {
	return Boolean(cfg.telegram);
}

/** 脱敏显示账号（appId / bot id）：保留前 8 位与后 4 位。 */
export function maskAccount(id: string): string {
	if (id.length <= 14) return `${id.slice(0, 4)}…`;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
