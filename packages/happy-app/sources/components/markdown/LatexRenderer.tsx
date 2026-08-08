import * as React from 'react';
import { Platform, View } from 'react-native';
import { KaTeXAutoHeightWebView, createKaTeXHTML } from '@adheil_gupta/react-native-latex-renderer';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export const LatexRenderer = React.memo((props: { content: string }) => {
    const { theme } = useUnistyles();
    const html = React.useMemo(() => createKaTeXHTML(
        // The renderer's bracket-delimiter config loses its backslashes when
        // embedded in WebView JavaScript. Dollar delimiters are preserved.
        `$$${escapeHtml(props.content)}$$`,
        {
            padding: '8px 0',
            color: theme.colors.text,
            'background-color': 'transparent',
        },
        {
            color: theme.colors.text,
            'font-size': '1em',
            'line-height': '1.5',
        },
    ), [props.content, theme.colors.text]);

    if (Platform.OS === 'web') {
        return (
            <View style={styles.container}>
                {/* @ts-ignore -- iframe is available only in the web build. */}
                <iframe
                    srcDoc={html}
                    title="Rendered equation"
                    style={{ width: '100%', height: 72, border: 0, background: 'transparent' }}
                />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <KaTeXAutoHeightWebView
                source={html}
                minHeight={48}
                containerStyle={{ backgroundColor: 'transparent' }}
            />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        width: '100%',
        marginVertical: 8,
        overflow: 'hidden',
    },
}));
