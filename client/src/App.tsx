import { useState } from 'react';
import { BottomNav, type AppSection } from './components/BottomNav';
import { ChartPage } from './features/chart/ChartPage';
import { RecordsPage } from './features/records/RecordsPage';
import { PersonDetail } from './features/person/PersonDetail';
import { saveBaziRecord } from './data/clientRepository';
import { SettingsPage } from './features/settings/SettingsPage';
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
  function handleRecordCreated(record: Omit<BaziRecord, 'id' | 'aiStatus'>) {
    void saveBaziRecord(record).then((saved) => {
      // The raw record is durable before navigation; AI must never block the user.
      setRecordsRevision((revision) => revision + 1);
      setSection('records');
    });
  }
  return <div className="app-shell"><div className="app-content"><button className="settings-entry text-button" type="button" onClick={() => setSettingsOpen(true)}>设置</button>
    {settingsOpen ? <SettingsPage /> : section === 'chart' ? <ChartPage onRecordCreated={handleRecordCreated} /> : openedPersonId ? <PersonDetail refreshKey={recordsRevision} personId={openedPersonId} onBack={() => { setOpenedPersonId(null); setRecordsRevision((revision) => revision + 1); }} /> : <RecordsPage refreshKey={recordsRevision} onOpenPerson={setOpenedPersonId} />}
  </div><BottomNav active={section} onChange={(nextSection) => { setSettingsOpen(false); handleSectionChange(nextSection); }} /></div>;
}
