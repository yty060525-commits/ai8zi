import { useEffect, useState } from 'react';
import { deleteScopeNote, getScopeNote, NOTE_MAX_LEN, saveScopeNote } from '../../data/scopeNotes';
import { sanitizeAnalysisText } from '../chart/elements';

export function ScopeNoteBox({ recordId, taskId, scopeLabel }: { recordId: string; taskId: string; scopeLabel: string }) {
  const [note, setNote] = useState(() => getScopeNote(recordId, taskId));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note?.text ?? '');
  const [error, setError] = useState('');

  useEffect(() => {
    const next = getScopeNote(recordId, taskId);
    setNote(next);
    setDraft(next?.text ?? '');
    setEditing(false);
    setError('');
  }, [recordId, taskId]);

  const save = () => {
    if (!saveScopeNote(recordId, taskId, draft)) { setError('点评保存失败，请检查本机存储空间'); return; }
    const next = getScopeNote(recordId, taskId);
    setNote(next);
    setDraft(next?.text ?? '');
    setEditing(false);
    setError('');
  };

  const remove = () => {
    if (!deleteScopeNote(recordId, taskId)) { setError('点评删除失败，请检查本机存储空间'); return; }
    setNote(undefined);
    setDraft('');
    setEditing(false);
    setError('');
  };

  return <div className="note-box" aria-label={`${sanitizeAnalysisText(scopeLabel)}点评`}>
    {note && !editing && <p className="note-text">{sanitizeAnalysisText(note.text)}</p>}
    {editing ? <div className="note-editor">
      <textarea aria-label={`${sanitizeAnalysisText(scopeLabel)}点评内容`} value={draft} maxLength={NOTE_MAX_LEN} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" onClick={save}>保存</button>
      <button type="button" onClick={() => { setDraft(note?.text ?? ''); setEditing(false); setError(''); }}>取消</button>
      {note && <button type="button" onClick={remove}>删除点评</button>}
    </div> : <button className="note-toggle" type="button" onClick={() => { setDraft(note?.text ?? ''); setEditing(true); setError(''); }}>{note ? '修改点评' : '点评'}</button>}
    {error && <p className="note-error" role="alert">{error}</p>}
  </div>;
}
