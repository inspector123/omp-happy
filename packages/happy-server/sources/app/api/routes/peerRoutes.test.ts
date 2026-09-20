import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FeedBody, type FeedOptions } from "@/app/feed/types";
import { type Fastify } from "../types";

type SessionRecord = {
    id: string;
    accountId: string;
};

type FeedRecord = {
    id: string;
    userId: string;
    repeatKey: string | null;
    body: FeedBody;
    counter: number;
    cursor: string;
    createdAt: number;
};

type SessionFindFirstArgs = {
    where?: {
        id?: string;
        accountId?: string;
    };
};

type PostPayload = {
    id: string;
    fromSessionId: string;
    fromTitle: string;
    toSessionId: string;
    body: string;
    replyTo?: string | null;
};

const {
    state,
    dbMock,
    feedPostMock,
    feedGetMock,
    emitEphemeralMock,
    hasSessionScopedSocketMock,
    resetState,
    seedSession,
    seedFeedItem
} = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[],
        feedItems: [] as FeedRecord[],
        nextCounter: 1,
        nowMs: 1700000000000
    };

    const resetState = () => {
        state.sessions = [];
        state.feedItems = [];
        state.nextCounter = 1;
        state.nowMs = 1700000000000;
    };

    const seedSession = (id: string, accountId: string) => {
        state.sessions.push({ id, accountId });
    };

    const seedFeedItem = (userId: string, body: FeedBody) => {
        const counter = state.nextCounter++;
        const item: FeedRecord = {
            id: `feed-${counter}`,
            userId,
            repeatKey: null,
            body,
            counter,
            cursor: `0-${counter}`,
            createdAt: state.nowMs++
        };
        state.feedItems.push(item);
        return item;
    };

    const sessionFindFirst = vi.fn(async (args: SessionFindFirstArgs) => {
        const session = state.sessions.find(item => (
            item.id === args?.where?.id &&
            item.accountId === args?.where?.accountId
        ));
        return session ? { id: session.id } : null;
    });

    const feedPostMock = vi.fn(async (_tx: unknown, ctx: { uid: string }, body: FeedBody) => (
        seedFeedItem(ctx.uid, body)
    ));

    const feedGetMock = vi.fn(async (_tx: unknown, ctx: { uid: string }, options?: FeedOptions) => {
        let items = state.feedItems
            .filter(item => item.userId === ctx.uid)
            .sort((a, b) => b.counter - a.counter);
        const before = options?.cursor?.before;
        if (typeof before === 'string' && before.startsWith('0-')) {
            const counter = Number.parseInt(before.slice(2), 10);
            items = items.filter(item => item.counter < counter);
        }
        const limit = options?.limit ?? 100;
        return {
            items: items.slice(0, limit),
            hasMore: items.length > limit
        };
    });

    const emitEphemeralMock = vi.fn();
    const hasSessionScopedSocketMock = vi.fn(async () => false);

    return {
        state,
        dbMock: { session: { findFirst: sessionFindFirst } },
        feedPostMock,
        feedGetMock,
        emitEphemeralMock,
        hasSessionScopedSocketMock,
        resetState,
        seedSession,
        seedFeedItem
    };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/inTx", () => ({
    inTx: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({})
}));
vi.mock("@/app/feed/feedPost", () => ({ feedPost: feedPostMock }));
vi.mock("@/app/feed/feedGet", () => ({ feedGet: feedGetMock }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitEphemeral: emitEphemeralMock,
        hasSessionScopedSocket: hasSessionScopedSocketMock
    }
}));

import { peerRoutes } from "./peerRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    peerRoutes(typed);
    await typed.ready();
    return typed;
}

function postPayload(overrides: Partial<PostPayload> = {}): PostPayload {
    return {
        id: "peer-1",
        fromSessionId: "sender-session",
        fromTitle: "Sender title",
        toSessionId: "target-session",
        body: "Hello from another session",
        ...overrides
    };
}

describe("peerRoutes", () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
        feedPostMock.mockClear();
        feedGetMock.mockClear();
        emitEphemeralMock.mockClear();
        hasSessionScopedSocketMock.mockReset();
        hasSessionScopedSocketMock.mockResolvedValue(false);
    });

    afterEach(async () => {
        if (app) {
            await app.close();
        }
        vi.restoreAllMocks();
    });

    it("rejects sender and target sessions outside the authenticated account", async () => {
        app = await createApp();
        seedSession("sender-session", "other-user");
        seedSession("target-session", "user-1");

        const foreignSender = await app.inject({
            method: "POST",
            url: "/v1/peer-messages",
            headers: { "x-user-id": "user-1" },
            payload: postPayload()
        });
        expect(foreignSender.statusCode).toBe(404);

        resetState();
        seedSession("sender-session", "user-1");
        const unknownTarget = await app.inject({
            method: "POST",
            url: "/v1/peer-messages",
            headers: { "x-user-id": "user-1" },
            payload: postPayload()
        });
        expect(unknownTarget.statusCode).toBe(404);
        expect(state.feedItems).toEqual([]);
        expect(emitEphemeralMock).not.toHaveBeenCalled();
    });

    it("persists the message, emits it to the target room, and reports no session socket", async () => {
        app = await createApp();
        seedSession("sender-session", "user-1");
        seedSession("target-session", "user-1");
        vi.spyOn(Date, "now").mockReturnValue(1700000000999);

        const response = await app.inject({
            method: "POST",
            url: "/v1/peer-messages",
            headers: { "x-user-id": "user-1" },
            payload: postPayload()
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ id: "peer-1", delivered: false });
        expect(state.feedItems).toHaveLength(1);
        expect(state.feedItems[0].body).toEqual({
            kind: "peer_message",
            id: "peer-1",
            fromSessionId: "sender-session",
            fromTitle: "Sender title",
            toSessionId: "target-session",
            body: "Hello from another session",
            replyTo: null,
            ts: 1700000000999
        });
        expect(hasSessionScopedSocketMock).toHaveBeenCalledWith("user-1", "target-session");
        expect(emitEphemeralMock).toHaveBeenCalledWith({
            userId: "user-1",
            payload: {
                type: "peer-message",
                id: "peer-1",
                fromSessionId: "sender-session",
                fromTitle: "Sender title",
                toSessionId: "target-session",
                body: "Hello from another session",
                replyTo: null,
                ts: 1700000000999
            },
            recipientFilter: {
                type: "all-interested-in-session",
                sessionId: "target-session"
            }
        });
    });

    it("returns stored messages for the requested session newest first", async () => {
        app = await createApp();
        seedSession("target-session", "user-1");
        seedFeedItem("user-1", { kind: "text", text: "unrelated" });
        seedFeedItem("user-1", {
            kind: "peer_message",
            id: "older",
            fromSessionId: "sender-a",
            fromTitle: "Sender A",
            toSessionId: "target-session",
            body: "Older message",
            replyTo: null,
            ts: 100
        });
        seedFeedItem("user-1", {
            kind: "peer_message",
            id: "other-target",
            fromSessionId: "sender-b",
            fromTitle: "Sender B",
            toSessionId: "another-session",
            body: "Wrong inbox",
            replyTo: null,
            ts: 200
        });
        const newest = seedFeedItem("user-1", {
            kind: "peer_message",
            id: "newest",
            fromSessionId: "sender-c",
            fromTitle: "Sender C",
            toSessionId: "target-session",
            body: "Newest message",
            replyTo: "older",
            ts: 300
        });

        const response = await app.inject({
            method: "GET",
            url: "/v1/peer-messages?sessionId=target-session&limit=1",
            headers: { "x-user-id": "user-1" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            items: [{
                id: "newest",
                fromSessionId: "sender-c",
                fromTitle: "Sender C",
                toSessionId: "target-session",
                body: "Newest message",
                replyTo: "older",
                ts: 300,
                cursor: newest.cursor,
                createdAt: newest.createdAt
            }],
            hasMore: true
        });
    });

    it("rejects reads for a foreign session", async () => {
        app = await createApp();
        seedSession("target-session", "other-user");

        const response = await app.inject({
            method: "GET",
            url: "/v1/peer-messages?sessionId=target-session",
            headers: { "x-user-id": "user-1" }
        });

        expect(response.statusCode).toBe(404);
        expect(feedGetMock).not.toHaveBeenCalled();
    });
});
