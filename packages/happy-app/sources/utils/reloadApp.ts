import { DevSettings, Platform } from 'react-native';

export function reloadApp() {
    if (Platform.OS === 'web') {
        window.location.reload();
        return;
    }

    DevSettings.reload();
}
