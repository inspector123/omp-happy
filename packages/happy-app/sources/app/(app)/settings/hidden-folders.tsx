import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { useLocalSettingMutable } from '@/sync/storage';
import { areHiddenFolderPathsEqual, normalizeHiddenFolderPath } from '@/utils/hiddenFolders';
import { t } from '@/text';

export default function HiddenFoldersSettingsScreen() {
    const [hiddenFolderPaths, setHiddenFolderPaths] = useLocalSettingMutable('hiddenFolderPaths');

    const handleAdd = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsHiddenFolders.promptTitle'),
            t('settingsHiddenFolders.promptMessage'),
            {
                placeholder: t('settingsHiddenFolders.placeholder'),
            },
        );
        if (value === null) {
            return;
        }

        const normalizedPath = normalizeHiddenFolderPath(value);
        if (!normalizedPath) {
            Modal.alert(t('common.error'), t('settingsHiddenFolders.invalidPath'));
            return;
        }
        if (hiddenFolderPaths.some((path) => areHiddenFolderPathsEqual(path, normalizedPath))) {
            Modal.alert(t('common.error'), t('settingsHiddenFolders.duplicatePath'));
            return;
        }

        setHiddenFolderPaths([...hiddenFolderPaths, normalizedPath]);
    }, [hiddenFolderPaths, setHiddenFolderPaths]);

    const handleRemove = React.useCallback((index: number) => {
        setHiddenFolderPaths(hiddenFolderPaths.filter((_, currentIndex) => currentIndex !== index));
    }, [hiddenFolderPaths, setHiddenFolderPaths]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup>
                <Item
                    title={t('settingsHiddenFolders.addTitle')}
                    subtitle={t('settingsHiddenFolders.addSubtitle')}
                    icon={<Ionicons name="add-circle-outline" size={29} color="#34C759" />}
                    onPress={handleAdd}
                />
            </ItemGroup>

            <ItemGroup
                title={t('settingsHiddenFolders.sectionTitle')}
                footer={t('settingsHiddenFolders.footer')}
            >
                {hiddenFolderPaths.length === 0 ? (
                    <Item
                        title={t('settingsHiddenFolders.empty')}
                        showChevron={false}
                    />
                ) : hiddenFolderPaths.map((path, index) => (
                    <Item
                        key={`${path}-${index}`}
                        title={path}
                        subtitle={t('settingsHiddenFolders.remove')}
                        rightElement={<Ionicons name="trash-outline" size={22} color="#FF3B30" />}
                        onPress={() => handleRemove(index)}
                        destructive
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}
