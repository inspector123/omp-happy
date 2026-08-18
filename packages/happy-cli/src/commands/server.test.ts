import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { selectLanAddress } from './server';

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
    return {
        address,
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal,
        cidr: `${address}/24`,
    };
}

describe('selectLanAddress', () => {
    it('prefers a private IPv4 address that a phone on the LAN can reach', () => {
        expect(selectLanAddress({
            tailscale0: [ipv4('100.78.101.67')],
            lo: [ipv4('127.0.0.1', true)],
            eno1: [ipv4('192.168.0.215')],
        })).toBe('192.168.0.215');
    });

    it('falls back to another external IPv4 address', () => {
        expect(selectLanAddress({
            lo: [ipv4('127.0.0.1', true)],
            tailscale0: [ipv4('100.78.101.67')],
        })).toBe('100.78.101.67');
    });

    it('returns undefined when only loopback is available', () => {
        expect(selectLanAddress({ lo: [ipv4('127.0.0.1', true)] })).toBeUndefined();
    });
});
