import Link from 'next/link';

export function TopBar({ provider, mode }: { provider: string; mode: 'customer' | 'reviewer' }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">A</span> Acme Shop <small>{mode === 'customer' ? 'support' : 'reviewer console'}</small>
      </div>
      <div className="top-right">
        <span className="chip provider">LLM: {provider}</span>
        <Link className="link" href={mode === 'customer' ? '/reviewer' : '/'}>
          {mode === 'customer' ? 'Reviewer console →' : '← Customer chat'}
        </Link>
      </div>
    </header>
  );
}
