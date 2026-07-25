import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';

/**
 * Standalone-render verification: the whole UI renders from the mock bridge
 * with no Electron and no DOM (server-side render into a string).
 *
 * SSR reads zustand's server snapshot (api.getInitialState), which is frozen
 * at store creation — so the module-level singleton always renders its empty
 * creation state here. We therefore mock the api module with an equivalent
 * store whose *initial* state is the seeded mock-bridge state.
 */

vi.mock('./api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./api')>();
  const bridge = mod.createMockBridge({ background: false });
  mod.useDesktop.getState().applyState(await bridge.getState());
  const seeded = mod.useDesktop.getState();
  // Fresh store with the seeded state as its creation-time initial state.
  const api = createStore(() => seeded);
  const bound = <T,>(selector: (s: typeof seeded) => T): T => useStore(api, selector);
  Object.assign(bound, api);
  return { ...mod, useDesktop: bound };
});

let html: string;

beforeAll(() => {
  html = renderToStaticMarkup(<App />);
});

describe('App renders standalone from the mock bridge', () => {
  it('renders the sidebar with sessions, agents and the connection pill', () => {
    expect(html).toContain('Happy');
    expect(html).toContain('Connected');
    expect(html).toContain('happy-desktop electron client');
    expect(html).toContain('fix auth token refresh race');
    // agent badges (text-transform: uppercase is visual only)
    expect(html).toContain('>omp<');
    expect(html).toContain('>claude<');
  });

  it('marks keyless sessions as encrypted', () => {
    expect(html).toContain('encrypted');
    expect(html).toContain('phone session');
  });

  it('auto-selects the most recent session and renders its messages', () => {
    // first session (s-alpha) messages visible
    expect(html).toContain('I scaffolded packages/happy-desktop');
    expect(html).toContain('Auto-scroll should pin');
    // user bubble + agent text both present
    expect(html).toContain('Build a protocol-native Electron desktop client');
  });

  it('renders the status bar with title, agent badge and path', () => {
    expect(html).toContain('~/projects/omp-happy');
    // s-alpha is thinking in the mock -> spinner label
    expect(html).toContain('thinking');
  });

  it('renders the composer enabled for the selected session', () => {
    expect(html).toContain('Message composer');
    expect(html).toContain('Message happy-desktop electron client');
  });

  it('renders tool calls and events with their own styles', () => {
    expect(html).toContain('Read packages/happy-cli/src/api/encryption.ts');
    expect(html).toContain('Daemon connected');
  });

  it('does not render the quick switcher when closed', () => {
    expect(html).not.toContain('Switch to session…');
  });

  it('exposes the contract data-testid hooks for the UI e2e', () => {
    expect(html).toContain('data-testid="session-list"');
    expect(html).toContain('data-testid="session-item"');
    expect(html).toContain('data-testid="message-list"');
    expect(html).toContain('data-testid="composer-input"');
  });
});
