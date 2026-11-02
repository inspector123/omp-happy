/**
 * Inline image/video for an encrypted session attachment, with a Save action.
 * Images decode from a data URI and open full screen on tap; videos play from
 * a decrypted file through expo-video's native controls. Save hands the
 * decrypted file to the share sheet (native) or a browser download (web).
 */
import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { ensureAttachmentFile, useAttachmentFile } from '@/hooks/useAttachmentFile';
import { saveAttachmentFile } from '@/utils/attachmentFile';
import { Modal as AppModal } from '@/modal';

export type AttachmentMediaProps = {
    sessionId?: string;
    attachmentRef: string;
    name: string;
    mimeType: string;
    size?: number;
};

const DEFAULT_IMAGE_ASPECT = 4 / 3;
const DEFAULT_VIDEO_ASPECT = 16 / 9;
const MAX_MEDIA_HEIGHT = 480;

export const AttachmentMedia = React.memo((props: AttachmentMediaProps) => {
    const { theme } = useUnistyles();
    const isVideo = props.mimeType.startsWith('video/');
    const [saving, setSaving] = React.useState(false);

    const save = React.useCallback(async () => {
        if (!props.sessionId || saving) return;
        setSaving(true);
        try {
            const uri = await ensureAttachmentFile(props.sessionId, props.attachmentRef, props.name, props.mimeType);
            await saveAttachmentFile(uri, props.name, props.mimeType);
        } catch (error) {
            AppModal.alert('Could not save file', error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    }, [props.sessionId, props.attachmentRef, props.name, props.mimeType, saving]);

    return (
        <View style={[styles.card, { borderColor: theme.colors.divider }]}>
            {isVideo ? <AttachmentVideo {...props} /> : <AttachmentImage {...props} onSave={save} />}
            <View style={styles.footer}>
                <Ionicons name={isVideo ? 'videocam-outline' : 'image-outline'} size={16} color={theme.colors.textSecondary} />
                <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>{props.name}</Text>
                {typeof props.size === 'number' ? (
                    <Text style={[styles.size, { color: theme.colors.textSecondary }]}>{formatBytes(props.size)}</Text>
                ) : null}
                <Pressable
                    onPress={save}
                    disabled={saving || !props.sessionId}
                    hitSlop={8}
                    style={({ pressed }) => [styles.saveButton, { backgroundColor: theme.colors.surfaceHigh }, pressed && styles.pressed]}
                    accessibilityLabel={`Save ${props.name}`}
                >
                    {saving
                        ? <ActivityIndicator size="small" color={theme.colors.text} />
                        : <Ionicons name="download-outline" size={16} color={theme.colors.text} />}
                    <Text style={[styles.saveText, { color: theme.colors.text }]}>Save</Text>
                </Pressable>
            </View>
        </View>
    );
});

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentImage(props: AttachmentMediaProps & { onSave: () => void }) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { uri, error } = useAttachmentImage(props.sessionId ?? '', props.sessionId ? props.attachmentRef : undefined);
    const [aspect, setAspect] = React.useState(DEFAULT_IMAGE_ASPECT);
    const [fullscreen, setFullscreen] = React.useState(false);

    return (
        <>
            <Pressable onPress={() => uri && setFullscreen(true)} accessibilityLabel={`Open ${props.name}`}>
                <View style={[styles.mediaFrame, { aspectRatio: aspect, backgroundColor: theme.colors.surfaceHigh }]}>
                    {uri ? (
                        <Image
                            source={{ uri }}
                            style={styles.fill}
                            contentFit="contain"
                            transition={150}
                            onLoad={(event) => {
                                const { width, height } = event.source;
                                if (width > 0 && height > 0) setAspect(width / height);
                            }}
                        />
                    ) : (
                        <MediaStatus error={error} />
                    )}
                </View>
            </Pressable>
            <Modal visible={fullscreen} transparent statusBarTranslucent animationType="fade" onRequestClose={() => setFullscreen(false)}>
                <View style={styles.viewer}>
                    {uri ? <Image source={{ uri }} style={styles.fill} contentFit="contain" /> : null}
                    <View style={[styles.viewerBar, { top: insets.top + 8 }]}>
                        <Pressable onPress={props.onSave} hitSlop={12} style={styles.viewerButton} accessibilityLabel={`Save ${props.name}`}>
                            <Ionicons name="download-outline" size={22} color="#fff" />
                        </Pressable>
                        <Pressable onPress={() => setFullscreen(false)} hitSlop={12} style={styles.viewerButton} accessibilityLabel="Close">
                            <Ionicons name="close" size={24} color="#fff" />
                        </Pressable>
                    </View>
                </View>
            </Modal>
        </>
    );
}

function AttachmentVideo(props: AttachmentMediaProps) {
    const { theme } = useUnistyles();
    const { uri, error } = useAttachmentFile(props.sessionId, props.attachmentRef, props.name, props.mimeType);
    return (
        <View style={[styles.mediaFrame, styles.videoFrame, uri ? null : { backgroundColor: theme.colors.surfaceHigh }]}>
            {uri ? <VideoPlayer uri={uri} /> : <MediaStatus error={error} />}
        </View>
    );
}

// Mounted only once the decrypted file exists so the player gets a real source.
function VideoPlayer(props: { uri: string }) {
    const player = useVideoPlayer(props.uri);
    const [aspect, setAspect] = React.useState(DEFAULT_VIDEO_ASPECT);
    React.useEffect(() => {
        const subscription = player.addListener('sourceLoad', ({ availableVideoTracks }) => {
            const size = availableVideoTracks[0]?.size;
            if (size && size.width > 0 && size.height > 0) setAspect(size.width / size.height);
        });
        return () => subscription.remove();
    }, [player]);
    return (
        <VideoView
            player={player}
            style={[styles.video, { aspectRatio: aspect }]}
            contentFit="contain"
            nativeControls
            fullscreenOptions={{ enable: true }}
        />
    );
}

function MediaStatus(props: { error: string | null }) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.status}>
            {props.error ? (
                <>
                    <Ionicons name="alert-circle-outline" size={20} color={theme.colors.textSecondary} />
                    <Text style={[styles.statusText, { color: theme.colors.textSecondary }]}>Could not load media</Text>
                </>
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    card: {
        borderWidth: 1,
        borderRadius: 10,
        overflow: 'hidden',
        width: '100%',
        maxWidth: 560,
    },
    mediaFrame: {
        width: '100%',
        maxHeight: MAX_MEDIA_HEIGHT,
        overflow: 'hidden',
    },
    videoFrame: {
        minHeight: 180,
        backgroundColor: '#000',
        justifyContent: 'center',
    },
    video: {
        width: '100%',
        maxHeight: MAX_MEDIA_HEIGHT,
    },
    fill: {
        width: '100%',
        height: '100%',
    },
    status: {
        flex: 1,
        minHeight: 180,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    statusText: {
        fontSize: 13,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    name: {
        flex: 1,
        fontSize: 13,
        fontWeight: '500',
    },
    size: {
        fontSize: 12,
    },
    saveButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
    },
    pressed: {
        opacity: 0.6,
    },
    saveText: {
        fontSize: 13,
        fontWeight: '600',
    },
    viewer: {
        flex: 1,
        backgroundColor: '#000',
    },
    viewerBar: {
        position: 'absolute',
        right: 12,
        flexDirection: 'row',
        gap: 12,
    },
    viewerButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
