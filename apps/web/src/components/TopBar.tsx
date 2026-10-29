import Link from 'next/link';
import type { StreamStatus } from '@/lib/stream';

export function TopBar({ provider, mode, stream }: { provider: string; mode: 'customer' | 'reviewer'; stream?: StreamStatus }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">A</span> Acme Shop <small>{mode === 'customer' ? 'support' : 'reviewer console'}</small>
      </div>
      <div className="top-right">
        {stream && (
          <span className={`chip stream ${stream}`} title={stream === 'live' ? 'Updates arrive as they happen' : stream === 'connecting' ? 'Connecting to live updates' : 'Live updates are down; refreshing every few seconds'}>
            <span className="dot" aria-hidden /> {stream === 'live' ? 'Live' : stream === 'connecting' ? 'Connecting' : 'Polling'}
          </span>
        )}
        <span className="chip provider">LLM: {provider}</span>
        <Link className="link" href={mode === 'customer' ? '/reviewer' : '/'}>
          {mode === 'customer' ? 'Reviewer console →' : '← Customer chat'}
        </Link>
      </div>
    </header>
  );
}
