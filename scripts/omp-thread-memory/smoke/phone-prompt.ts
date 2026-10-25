/**
 * Smoke-test helper extension: submits one prompt the way the Happy bridge forwards a phone
 * message (`pi.sendUserMessage`, which skips slash-command expansion). Used by phone-path.ts.
 */
interface SmokeApi {
	on(event: string, handler: (event: unknown, ctx: SmokeContext) => unknown): void;
	sendUserMessage(content: string): unknown;
}

interface SmokeContext {
	agent?: { kind: "main" | "sub" };
	setTimeout(callback: () => unknown, ms: number): unknown;
}

export default function phonePrompt(pi: SmokeApi): void {
	pi.on("session_start", (_event, ctx) => {
		const prompt = process.env.THREAD_MEMORY_SMOKE_PROMPT;
		if (ctx.agent?.kind === "sub" || !prompt) return;
		ctx.setTimeout(() => pi.sendUserMessage(prompt), 1_000);
	});
}
