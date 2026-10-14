import type { ReactNode } from 'react';
import { Icon } from './Icon';
export function ScreenHeader({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return <header className="toolbar">
    <button className="icon-button" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
    <h1>{title}</h1>{children}
  </header>;
}
