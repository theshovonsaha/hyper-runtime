import React, { useEffect, useState } from 'react';
import { useShovs } from '../store/ShovsContext';
import { api } from '../api';

const KIND_COLOR = {
  input: "var(--baseline)", context_item: "var(--c-context)", packet: "var(--c-packet)",
  gate: "var(--c-gate)", plan: "var(--c-packet)", model: "var(--c-model)",
  tool: "var(--c-tool)", verify: "var(--c-gate)",
  output: "var(--c-output)", memory: "var(--c-memory)", error: "var(--s-critical)",
};

export function GateDrawer() {
  const { runId, events } = useShovs();
  const [isOpen, setIsOpen] = useState(false);
  const [packet, setPacket] = useState(null);
  const [editedItems, setEditedItems] = useState({});

  // Check if latest event is gate.open
  const latestEvent = events[events.length - 1];
  
  useEffect(() => {
    let active = true;
    if (latestEvent?.type === 'gate.open') {
      const fetchGate = async () => {
        try {
          // Polling slightly to wait for gate ready
          for (let i = 0; i < 10; i++) {
            const res = await fetch(`/api/runs/${runId}/gate`);
            if (res.ok) {
              const data = await res.json();
              if (active) {
                setPacket(data);
                setIsOpen(true);
              }
              break;
            }
            await new Promise(r => setTimeout(r, 150));
          }
        } catch(e) {
          console.error(e);
        }
      };
      fetchGate();
    } else if (latestEvent?.type === 'gate.resolved') {
      setIsOpen(false);
      setPacket(null);
    }
    return () => { active = false; };
  }, [latestEvent, runId]);

  if (!isOpen || !packet) return null;

  const handleApprove = async () => {
    try {
      const edits = [];
      packet.items.forEach(item => {
        const edit = { id: item.id };
        let changed = false;
        const currentData = editedItems[item.id] || {};
        
        if (currentData.included === false) {
           edit.included = false;
           changed = true;
        }
        if (currentData.text !== undefined && currentData.text !== item.text) {
           edit.text = currentData.text;
           changed = true;
        }
        if (changed) edits.push(edit);
      });

      await api.post(`/api/runs/${runId}/gate`, { action: 'approve', edits });
      setIsOpen(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCancel = async () => {
    try {
      await api.post(`/api/runs/${runId}/gate`, { action: 'cancel' });
      setIsOpen(false);
    } catch(e) {
      console.error(e);
    }
  };

  return (
    <div style={{
      flex: 'none', background: 'color-mix(in srgb, var(--c-gate) 14%, var(--surface))',
      borderTop: '2px solid var(--c-gate)', padding: '10px 22px'
    }}>
      <div style={{ maxWidth: 780, margin: '0 auto' }}>
        <div style={{ fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--c-gate)' }}></span>
          Context gate — this is exactly what the model will see
        </div>
        
        <div style={{ maxHeight: 300, overflow: 'auto', margin: '10px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {packet.items?.map(item => {
             const currentData = editedItems[item.id] || {};
             const included = currentData.included !== undefined ? currentData.included : item.included;
             const text = currentData.text !== undefined ? currentData.text : item.text;
             
             return (
               <div key={item.id} style={{ background: 'var(--surface)', border: '1px solid var(--grid)', borderRadius: 8, opacity: included ? 1 : 0.5 }}>
                 <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 12.5 }}>
                   <input type="checkbox" checked={included} onChange={(e) => setEditedItems(prev => ({...prev, [item.id]: {...prev[item.id], included: e.target.checked}}))} />
                   <span style={{ fontSize: 10.5, padding: '1px 8px', borderRadius: 999, color: '#fff', minWidth: 52, textAlign: 'center', background: KIND_COLOR[item.kind] || 'var(--baseline)' }}>
                     {item.kind}
                   </span>
                   <span style={{ fontWeight: 550 }}>{item.title}</span>
                   <span style={{ color: 'var(--muted)', fontSize: 11.5, flex: 1 }}>{item.reason}</span>
                 </div>
                 <textarea 
                   spellCheck={false}
                   value={text} 
                   onChange={(e) => setEditedItems(prev => ({...prev, [item.id]: {...prev[item.id], text: e.target.value}}))}
                   style={{ width: 'calc(100% - 20px)', margin: '0 10px 10px', minHeight: 70, display: 'block' }} 
                 />
               </div>
             );
          })}
        </div>
        
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={handleApprove} style={{ background: 'var(--c-gate)', color: '#1a1a19', fontWeight: 650, borderRadius: 8, padding: '7px 18px' }}>
            Approve & run
          </button>
          <button onClick={handleCancel} style={{ color: 'var(--s-critical)' }}>Cancel run</button>
        </div>
      </div>
    </div>
  );
}
