/**
 * View for OMP `present_media` tool calls: the agent uploads image/video files
 * as encrypted session attachments and the tool result lists their refs.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { z } from 'zod';
import { AttachmentMedia } from '@/components/media/AttachmentMedia';
import { ToolViewProps } from './_all';

const presentMediaResultSchema = z.object({
    details: z.object({
        media: z.array(z.object({
            ref: z.string(),
            name: z.string(),
            mimeType: z.string(),
            size: z.number().optional(),
        })).default([]),
        errors: z.array(z.object({
            path: z.string(),
            error: z.string(),
        })).default([]),
    }),
});

const toolErrorTextSchema = z.object({
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
});

export const PresentMediaView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const parsed = presentMediaResultSchema.safeParse(tool.result);
    if (!parsed.success) {
        if (tool.state !== 'error') return null;
        const errorText = typeof tool.result === 'string'
            ? tool.result
            : toolErrorTextSchema.safeParse(tool.result).data?.content.map((part) => part.text).join('\n');
        return errorText
            ? <Text style={[styles.error, { color: theme.colors.textSecondary }]}>{errorText}</Text>
            : null;
    }
    const { media, errors } = parsed.data.details;
    return (
        <View style={styles.container}>
            {media.map((item) => (
                <AttachmentMedia
                    key={item.ref}
                    sessionId={sessionId}
                    attachmentRef={item.ref}
                    name={item.name}
                    mimeType={item.mimeType}
                    size={item.size}
                />
            ))}
            {errors.map((failure) => (
                <Text key={failure.path} style={[styles.error, { color: theme.colors.textSecondary }]}>
                    {`${failure.path}: ${failure.error}`}
                </Text>
            ))}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        gap: 10,
        paddingVertical: 4,
    },
    error: {
        fontSize: 13,
    },
}));
