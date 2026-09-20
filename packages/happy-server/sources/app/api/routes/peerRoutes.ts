import { eventRouter } from "@/app/events/eventRouter";
import { feedGet } from "@/app/feed/feedGet";
import { feedPost } from "@/app/feed/feedPost";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { z } from "zod";
import { Fastify } from "../types";

const MAX_FEED_ITEMS_TO_SCAN = 1000;

const peerMessageResponseItemSchema = z.object({
    id: z.string(),
    fromSessionId: z.string(),
    fromTitle: z.string(),
    toSessionId: z.string(),
    body: z.string(),
    replyTo: z.string().nullable(),
    ts: z.number(),
    cursor: z.string(),
    createdAt: z.number()
});

const errorResponseSchema = z.object({
    error: z.string()
});

export function peerRoutes(app: Fastify) {
    app.post('/v1/peer-messages', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                fromSessionId: z.string(),
                fromTitle: z.string(),
                toSessionId: z.string(),
                body: z.string(),
                replyTo: z.string().nullish()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    delivered: z.boolean()
                }),
                404: errorResponseSchema
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, fromSessionId, fromTitle, toSessionId, body, replyTo } = request.body;

        const [fromSession, toSession] = await Promise.all([
            db.session.findFirst({
                where: { id: fromSessionId, accountId: userId },
                select: { id: true }
            }),
            db.session.findFirst({
                where: { id: toSessionId, accountId: userId },
                select: { id: true }
            })
        ]);
        if (!fromSession || !toSession) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const ts = Date.now();
        const peerMessage = {
            kind: 'peer_message' as const,
            id,
            fromSessionId,
            fromTitle,
            toSessionId,
            body,
            replyTo: replyTo ?? null,
            ts
        };

        await inTx(async (tx) => {
            await feedPost(tx, Context.create(userId), peerMessage);
        });

        const delivered = await eventRouter.hasSessionScopedSocket(userId, toSessionId);
        eventRouter.emitEphemeral({
            userId,
            payload: {
                type: 'peer-message',
                id,
                fromSessionId,
                fromTitle,
                toSessionId,
                body,
                replyTo: replyTo ?? null,
                ts
            },
            recipientFilter: { type: 'all-interested-in-session', sessionId: toSessionId }
        });

        return reply.send({ id, delivered });
    });

    app.get('/v1/peer-messages', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                sessionId: z.string(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                before: z.string().optional()
            }),
            response: {
                200: z.object({
                    items: z.array(peerMessageResponseItemSchema),
                    hasMore: z.boolean()
                }),
                404: errorResponseSchema
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, limit, before } = request.query;
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const feed = await feedGet(db, Context.create(userId), {
            cursor: { before },
            limit: MAX_FEED_ITEMS_TO_SCAN
        });
        const matchingItems = feed.items.filter(item => (
            item.body.kind === 'peer_message' &&
            item.body.toSessionId === sessionId
        ));
        const items = matchingItems.slice(0, limit).map(item => {
            if (item.body.kind !== 'peer_message') {
                throw new Error('Unexpected feed body kind');
            }
            return {
                id: item.body.id,
                fromSessionId: item.body.fromSessionId,
                fromTitle: item.body.fromTitle,
                toSessionId: item.body.toSessionId,
                body: item.body.body,
                replyTo: item.body.replyTo,
                ts: item.body.ts,
                cursor: item.cursor,
                createdAt: item.createdAt
            };
        });

        return reply.send({
            items,
            hasMore: matchingItems.length > limit || feed.hasMore
        });
    });
}
