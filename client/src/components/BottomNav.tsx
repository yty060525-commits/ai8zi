export type AppSection = 'chart' | 'records';

interface BottomNavProps {
  active: AppSection;
  onChange: (section: AppSection) => void;
}

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      <button className={active === 'chart' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => onChange('chart')} aria-current={active === 'chart' ? 'page' : undefined}>排盘</button>
      <button className={active === 'records' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => onChange('records')} aria-current={active === 'records' ? 'page' : undefined}>记录</button>
    </nav>
  );
}
