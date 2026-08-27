/**
 * Image picker hook for attaching images to messages.
 *
 * Wraps expo-image-picker with permission handling and thumbhash generation.
 * Enforces limits: max 20 images per message, 10MB per file.
 *
 * Note: fileSize from expo-image-picker is optional — some platforms do not
 * provide it (returns undefined → size=0). Such files pass the client-side
 * size check; the server enforces the limit on upload. Phase 5 should handle
 * 413 responses gracefully.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { AppState, Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IOS_ATTACHMENT_JPEG_QUALITY = 0.92;

export type { AttachmentPreview };

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<void>;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};
export function requiresMediaLibraryPermission(platform: typeof Platform.OS): boolean {
    return platform === 'ios';
}

function withJpegExtension(fileName: string | null | undefined): string {
    const fallback = `image_${Date.now()}.jpg`;
    const name = fileName?.trim() || fallback;
    const extensionIndex = name.lastIndexOf('.');
    const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
    return `${stem}.jpg`;
}

export async function normalizePickedAssetForUpload(asset: ImagePicker.ImagePickerAsset): Promise<{
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    name: string;
}> {
    if (Platform.OS !== 'ios') {
        return {
            uri: asset.uri,
            width: asset.width,
            height: asset.height,
            mimeType: asset.mimeType ?? 'image/jpeg',
            name: asset.fileName ?? `image_${Date.now()}.jpg`,
        };
    }

    const converted = await manipulateAsync(asset.uri, [], {
        compress: IOS_ATTACHMENT_JPEG_QUALITY,
        format: SaveFormat.JPEG,
    });

    return {
        uri: converted.uri,
        width: converted.width || asset.width,
        height: converted.height || asset.height,
        mimeType: 'image/jpeg',
        name: withJpegExtension(asset.fileName),
    };
}

const selectedImagesByComposer = new Map<string, AttachmentPreview[]>();

export function useImagePicker(composerId: string): UseImagePickerResult {
    const [selectedImages, setSelectedImages] = useState<AttachmentPreview[]>(
        () => selectedImagesByComposer.get(composerId) ?? [],
    );
    const selectedCountRef = useRef(selectedImages.length);
    const requestSequenceRef = useRef(0);
    const activeRequestsRef = useRef(0);

    useEffect(() => {
        selectedCountRef.current = selectedImages.length;
        console.warn('[ImagePicker] selection-state', {
            platform: Platform.OS,
            selectedCount: selectedImages.length,
            cachedCount: selectedImagesByComposer.get(composerId)?.length ?? 0,
        });
    }, [composerId, selectedImages]);

    useEffect(() => {
        console.warn('[ImagePicker] hook-mounted', {
            platform: Platform.OS,
            appState: AppState.currentState,
            cachedCount: selectedImagesByComposer.get(composerId)?.length ?? 0,
        });
        return () => {
            console.warn('[ImagePicker] hook-unmounted', {
                platform: Platform.OS,
                appState: AppState.currentState,
                activeRequests: activeRequestsRef.current,
                cachedCount: selectedImagesByComposer.get(composerId)?.length ?? 0,
            });
        };
    }, [composerId]);

    const requestPermission = useCallback(async (): Promise<boolean> => {
        if (!requiresMediaLibraryPermission(Platform.OS)) return true;

        console.warn('[ImagePicker] permission-request-start');
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        console.warn('[ImagePicker] permission-request-result', { status });
        if (status !== 'granted') {
            Modal.alert(
                t('imageUpload.permissionTitle'),
                t('imageUpload.permissionMessage'),
                [{ text: t('common.ok') }],
            );
            return false;
        }
        return true;
    }, []);

    const pickImages = useCallback(async () => {
        const requestId = ++requestSequenceRef.current;
        const startedAt = Date.now();
        activeRequestsRef.current += 1;
        console.warn('[ImagePicker] request-start', {
            requestId,
            platform: Platform.OS,
            appState: AppState.currentState,
            activeRequests: activeRequestsRef.current,
            selectedCount: selectedCountRef.current,
            cachedCount: selectedImagesByComposer.get(composerId)?.length ?? 0,
        });

        try {
            if (requiresMediaLibraryPermission(Platform.OS)) {
                const hasPermission = await requestPermission();
                if (!hasPermission) {
                    console.warn('[ImagePicker] request-stopped-no-permission', { requestId });
                    return;
                }
            }

            const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
            if (remaining <= 0) {
                console.warn('[ImagePicker] request-stopped-limit', {
                    requestId,
                    selectedCount: selectedCountRef.current,
                });
                Modal.alert(
                    t('imageUpload.limitTitle'),
                    t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                    [{ text: t('common.ok') }],
                );
                return;
            }

            console.warn('[ImagePicker] native-launch-start', {
                requestId,
                remaining,
                activeRequests: activeRequestsRef.current,
                appState: AppState.currentState,
            });
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsMultipleSelection: true,
                selectionLimit: remaining,
                quality: 1,
                exif: false,
            });
            const nativeDurationMs = Date.now() - startedAt;
            console.warn('[ImagePicker] native-launch-result', {
                requestId,
                nativeDurationMs,
                canceled: result.canceled,
                assetCount: result.assets?.length ?? 0,
                appState: AppState.currentState,
                immediateCancel: result.canceled && nativeDurationMs < 500,
            });

            if (result.canceled || !result.assets.length) return;

            const assets = result.assets.slice(0, remaining);
            const previews: AttachmentPreview[] = [];

            for (const [assetIndex, asset] of assets.entries()) {
                const size = asset.fileSize ?? 0;
                console.warn('[ImagePicker] asset-processing-start', {
                    requestId,
                    assetIndex,
                    width: asset.width,
                    height: asset.height,
                    size,
                    mimeType: asset.mimeType ?? null,
                    hasFileName: Boolean(asset.fileName),
                });

                if (size > MAX_FILE_SIZE) {
                    console.warn('[ImagePicker] asset-rejected-size', {
                        requestId,
                        assetIndex,
                        size,
                    });
                    Modal.alert(
                        t('imageUpload.fileTooLargeTitle'),
                        t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: 10 }),
                        [{ text: t('common.ok') }],
                    );
                    continue;
                }

                const normalized = await normalizePickedAssetForUpload(asset);
                const thumbhashStartedAt = Date.now();
                const thumbhash = (normalized.width > 0 && normalized.height > 0)
                    ? await generateThumbhash(normalized.uri, normalized.width, normalized.height)
                    : undefined;

                previews.push({
                    id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    uri: normalized.uri,
                    width: normalized.width,
                    height: normalized.height,
                    mimeType: normalized.mimeType,
                    size,
                    name: normalized.name,
                    thumbhash,
                });
                console.warn('[ImagePicker] asset-processing-complete', {
                    requestId,
                    assetIndex,
                    normalizedWidth: normalized.width,
                    normalizedHeight: normalized.height,
                    normalizedMimeType: normalized.mimeType,
                    thumbhashGenerated: Boolean(thumbhash),
                    thumbhashDurationMs: Date.now() - thumbhashStartedAt,
                });
            }

            if (previews.length > 0) {
                const previousCount = selectedImagesByComposer.get(composerId)?.length ?? 0;
                const next = [...(selectedImagesByComposer.get(composerId) ?? []), ...previews]
                    .slice(0, MAX_IMAGES_PER_MESSAGE);
                selectedImagesByComposer.set(composerId, next);
                selectedCountRef.current = next.length;
                setSelectedImages(next);
                console.warn('[ImagePicker] request-committed', {
                    requestId,
                    previousCount,
                    addedCount: previews.length,
                    nextCount: next.length,
                    totalDurationMs: Date.now() - startedAt,
                });
            }
        } catch (error) {
            console.error('[ImagePicker] request-failed', {
                requestId,
                durationMs: Date.now() - startedAt,
                appState: AppState.currentState,
                error,
            });
        } finally {
            activeRequestsRef.current -= 1;
            console.warn('[ImagePicker] request-finished', {
                requestId,
                durationMs: Date.now() - startedAt,
                activeRequests: activeRequestsRef.current,
                appState: AppState.currentState,
            });
        }
    }, [composerId, requestPermission]);

    const removeImage = useCallback((id: string) => {
        const previousCount = selectedImagesByComposer.get(composerId)?.length ?? 0;
        const next = (selectedImagesByComposer.get(composerId) ?? []).filter(img => img.id !== id);
        if (next.length > 0) {
            selectedImagesByComposer.set(composerId, next);
        } else {
            selectedImagesByComposer.delete(composerId);
        }
        selectedCountRef.current = next.length;
        setSelectedImages(next);
        console.warn('[ImagePicker] image-removed', { previousCount, nextCount: next.length });
    }, [composerId]);

    const clearImages = useCallback(() => {
        const previousCount = selectedImagesByComposer.get(composerId)?.length ?? 0;
        selectedImagesByComposer.delete(composerId);
        selectedCountRef.current = 0;
        setSelectedImages([]);
        console.warn('[ImagePicker] selection-cleared', { previousCount });
    }, [composerId]);

    const addImages = useCallback((images: AttachmentPreview[]) => {
        const current = selectedImagesByComposer.get(composerId) ?? [];
        const remaining = MAX_IMAGES_PER_MESSAGE - current.length;
        if (remaining <= 0) {
            console.warn('[ImagePicker] external-images-rejected-limit', {
                currentCount: current.length,
                requestedCount: images.length,
            });
            return;
        }
        const next = [...current, ...images.slice(0, remaining)];
        selectedImagesByComposer.set(composerId, next);
        selectedCountRef.current = next.length;
        setSelectedImages(next);
        console.warn('[ImagePicker] external-images-added', {
            previousCount: current.length,
            requestedCount: images.length,
            nextCount: next.length,
        });
    }, [composerId]);

    return { selectedImages, pickImages, removeImage, clearImages, addImages };
}
