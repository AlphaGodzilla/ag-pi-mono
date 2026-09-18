/**
 * pi-channel 运行日志。
 *
 * 写入 `~/.pi/agent/extensions/pi-channel/error.log`（与 config.json 同目录）；
 * 绝不写 console / stderr —— 在 pi TUI 与 cmux 环境下会污染界面并干扰 busy/idle 判断。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME } from "./config.ts";

export function logPath(): string {
	return join(getAgentDir(), "extensions", EXTENSION_NAME, "error.log");
}

export function logError(line: string): void {
	try {
		const file = logPath();
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, "utf8");
	} catch {
		// 日志写入失败静默，绝不影响主流程
	}
}

/**
 * 诊断日志（debug.log）：默认关闭，由配置 `debug: true` 打开（`/channel reload` 后生效）。
 *
 * 为什么要有它：默认的 `silentLogger` 把 SDK 的 error/warn/debug 全部静音（避免污染 pi TUI），
 * 代价是排障时零证据——「卡片点击要连点好几次」这类问题就发生在这些被静音的行里
 * （SDK safety 流水线的去重/排队/丢弃、长连接握手时序、回调到达时刻）。
 * 开启后写 `debug.log`（同目录），只落文件、绝不写 stdout。
 */
let debugEnabled = false;

/** 由插件加载 / `/channel reload` 时按配置设置。 */
export function setDebugEnabled(enabled: boolean): void {
	debugEnabled = enabled;
}

export function logDebugPath(): string {
	return join(getAgentDir(), "extensions", EXTENSION_NAME, "debug.log");
}

export function logDebug(line: string): void {
	if (!debugEnabled) return;
	// node --test 下绝不写盘：getAgentDir() 会缓存首个调用结果，测试里的 PI_CODING_AGENT_DIR
	// 兜不住，诊断日志会落到真实用户目录（实测发生过）。
	if (process.env.NODE_TEST_CONTEXT !== undefined) return;
	try {
		const file = logDebugPath();
		mkdirSync(dirname(file), { recursive: true });
		// pid 前缀：多个 pi 进程会往同一份 debug.log 里写，排「回调落到哪个实例」时必须能分辨。
		appendFileSync(file, `[${new Date().toISOString()}] [pid ${process.pid}] ${line.slice(0, 400)}\n`, "utf8");
	} catch {
		// 诊断日志失败绝不影响主流程
	}
}
