/**
 * Inline image that opens full screen on tap. Shared by encrypted chat
 * attachments and by images returned inside tool results.
 */
import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const MAX_MEDIA_HEIGHT = 480;
const DEFAULT_IMAGE_ASPECT = 4 / 3;

export type ImagePreviewProps = {
    /** Null while the image is still loading. */
    uri: string | null;
    error?: string | null;
    /** Used in accessibility labels. */
    name: string;
    /** Shows a Save button in the full-screen view. */
    onSave?: () => void;
};

export function ImagePreview(props: ImagePreviewProps) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { uri } = props;
    const [aspect, setAspect] = React.useState(DEFAULT_IMAGE_ASPECT);
    const [fullscreen, setFullscreen] = React.useState(false);

    return (
        <>
            <Pressable onPress={() => uri && setFullscreen(true)} accessibilityLabel={`Open ${props.name}`}>
                <View style={[styles.frame, { aspectRatio: aspect, backgroundColor: theme.colors.surfaceHigh }]}>
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
                        <MediaStatus error={props.error ?? null} />
                    )}
                </View>
            </Pressable>
            <Modal visible={fullscreen} transparent statusBarTranslucent animationType="fade" onRequestClose={() => setFullscreen(false)}>
                <View style={styles.viewer}>
                    {uri ? <Image source={{ uri }} style={styles.fill} contentFit="contain" /> : null}
                    <View style={[styles.viewerBar, { top: insets.top + 8 }]}>
                        {props.onSave ? (
                            <Pressable onPress={props.onSave} hitSlop={12} style={styles.viewerButton} accessibilityLabel={`Save ${props.name}`}>
                                <Ionicons name="download-outline" size={22} color="#fff" />
                            </Pressable>
                        ) : null}
                        <Pressable onPress={() => setFullscreen(false)} hitSlop={12} style={styles.viewerButton} accessibilityLabel="Close">
                            <Ionicons name="close" size={24} color="#fff" />
                        </Pressable>
                    </View>
                </View>
            </Modal>
        </>
    );
}

/** Spinner while media loads, or an error note once loading failed. */
export function MediaStatus(props: { error: string | null }) {
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
    frame: {
        width: '100%',
        maxHeight: MAX_MEDIA_HEIGHT,
        overflow: 'hidden',
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
