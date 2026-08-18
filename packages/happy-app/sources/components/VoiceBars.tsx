import React, { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';

interface VoiceBarsProps {
    isActive: boolean;
    color?: string;
    size?: 'small' | 'medium';
}

export const VoiceBars: React.FC<VoiceBarsProps> = ({ 
    isActive, 
    color = '#fff',
    size = 'small' 
}) => {
    const bar1 = useRef(new Animated.Value(0.3)).current;
    const bar2 = useRef(new Animated.Value(0.5)).current;
    const bar3 = useRef(new Animated.Value(0.4)).current;

    useEffect(() => {
        if (isActive) {
            const configurations = [
                { bar: bar1, duration: 300, delay: 0 },
                { bar: bar2, duration: 350, delay: 100 },
                { bar: bar3, duration: 400, delay: 200 },
            ];
            const animations: Animated.CompositeAnimation[] = [];

            for (const { bar, duration, delay } of configurations) {
                const animation = Animated.loop(
                    Animated.sequence([
                        Animated.delay(delay),
                        Animated.timing(bar, {
                            toValue: 1,
                            duration,
                            useNativeDriver: true,
                        }),
                        Animated.timing(bar, {
                            toValue: 0.3,
                            duration,
                            useNativeDriver: true,
                        }),
                    ])
                );
                animations.push(animation);
                animation.start();
            }

            return () => {
                for (const animation of animations) {
                    animation.stop();
                }
            };
        }

        const resetAnimation = Animated.parallel([
            Animated.timing(bar1, { toValue: 0.3, duration: 200, useNativeDriver: true }),
            Animated.timing(bar2, { toValue: 0.3, duration: 200, useNativeDriver: true }),
            Animated.timing(bar3, { toValue: 0.3, duration: 200, useNativeDriver: true }),
        ]);
        resetAnimation.start();
        return () => resetAnimation.stop();
    }, [isActive, bar1, bar2, bar3]);

    const barWidth = size === 'small' ? 2 : 3;
    const barHeight = size === 'small' ? 12 : 16;
    const gap = size === 'small' ? 1.5 : 2;

    return (
        <View style={{ 
            flexDirection: 'row', 
            alignItems: 'center', 
            gap,
            height: barHeight 
        }}>
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar1 }],
                overflow: 'hidden',
            }} />
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar2 }],
                overflow: 'hidden',
            }} />
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar3 }],
                overflow: 'hidden',
            }} />
        </View>
    );
};