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
