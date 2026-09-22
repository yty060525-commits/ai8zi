import { useEffect, useState } from 'react';
import { BottomNav, type AppSection } from './components/BottomNav';
import { ChartPage } from './features/chart/ChartPage';
import { RecordsPage } from './features/records/RecordsPage';
import { PersonDetail } from './features/person/PersonDetail';
import { saveBaziRecord } from './data/clientRepository';
import { SettingsPage } from './features/settings/SettingsPage';
import { BUILD_ID, buildLabel } from './utils/buildInfo';
import type { BaziRecord } from './types/domain';

export function App() {
  const [section, setSection] = useState<AppSection>('chart');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openedPersonId, setOpenedPersonId] = useState<string | null>(null);
  const [recordsRevision, setRecordsRevision] = useState(0);
  const handleSectionChange = (nextSection: AppSection) => {
    if (nextSection === 'chart') setOpenedPersonId(null);
    setSection(nextSection);
  };
  useEffect(() => {
    // 聊天面板等子组件的「去设置」入口：不钻 prop，统一走窗口事件。
    const open = () => setSettingsOpen(true);
    window.addEventListener('mingli:open-settings', open);
    return () => window.removeEventListener('mingli:open-settings', open);
  }, []);
  function handleRecordCreated(record: Omit<BaziRecord, 'id' | 'aiStatus'>) {
    void saveBaziRecord(record).then((saved) => {
      // The raw record is durable before navigation; AI must never block the user.
      setRecordsRevision((revision) => revision + 1);
      setSection('records');
    });
  }
  return <div className="app-shell"><div className="app-content"><button className="settings-entry text-button" type="button" onClick={() => setSettingsOpen(true)}>设置</button>
    {settingsOpen ? <SettingsPage /> : section === 'chart' ? <ChartPage onRecordCreated={handleRecordCreated} /> : openedPersonId ? <PersonDetail refreshKey={recordsRevision} personId={openedPersonId} onBack={() => { setOpenedPersonId(null); setRecordsRevision((revision) => revision + 1); }} /> : <RecordsPage refreshKey={recordsRevision} onOpenPerson={setOpenedPersonId} />}
  </div><p className="build-stamp" title={'构建号 ' + BUILD_ID} aria-label="页面版本">{buildLabel()}</p><BottomNav active={section} onChange={(nextSection) => { setSettingsOpen(false); handleSectionChange(nextSection); }} /></div>;
}
