import { useEffect } from 'react';
import { useDesktop } from './api';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { QuickSwitcher } from './components/QuickSwitcher';
import { SessionList } from './components/SessionList';
import { StatusBar } from './components/StatusBar';

export default function App() {
  const switcherOpen = useDesktop((s) => s.switcherOpen);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const st = useDesktop.getState();

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.toggleSwitcher();
        return;
      }
      if (mod && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        st.selectByIndex(Number(e.key) - 1);
        return;
      }
      if (mod && e.key === 's') return; // leave ⌘S etc. alone
      if (st.switcherOpen) return; // switcher handles its own keys

      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
      if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        st.cycleSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full bg-zinc-950 text-zinc-200">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <StatusBar />
        <div className="min-h-0 flex-1">
          <ChatView />
        </div>
        <Composer />
      </main>
      {switcherOpen && <QuickSwitcher />}
    </div>
  );
}
