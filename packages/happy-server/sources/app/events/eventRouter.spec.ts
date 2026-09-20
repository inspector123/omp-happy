import type { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";
import { eventRouter } from "./eventRouter";

describe("eventRouter session socket presence", () => {
    it("reports only a matching session-scoped socket in the target room", async () => {
        let sockets: Array<{ data: Record<string, unknown> }> = [];
        const fetchSockets = vi.fn(async () => sockets);
        const inRoom = vi.fn(() => ({ fetchSockets }));
        const io = { in: inRoom };
        // The test double implements the Socket.IO methods exercised by this query.
        eventRouter.init(io as unknown as Server);

        await expect(eventRouter.hasSessionScopedSocket("user-1", "session-1")).resolves.toBe(false);

        sockets = [
            { data: { clientType: "user-scoped" } },
            { data: { clientType: "session-scoped", sessionId: "session-2" } }
        ];
        await expect(eventRouter.hasSessionScopedSocket("user-1", "session-1")).resolves.toBe(false);

        sockets.push({
            data: { clientType: "session-scoped", sessionId: "session-1" }
        });
        await expect(eventRouter.hasSessionScopedSocket("user-1", "session-1")).resolves.toBe(true);

        expect(inRoom).toHaveBeenCalledWith("user:user-1:session:session-1");
    });
});
