import React, { useState } from 'react';

export function DataView({ value, label = 'data' }) {
  const [activeTab, setActiveTab] = useState('insight');

  if (value === undefined || value === null) {
    return <div className="data-val null">null</div>;
  }

  const renderVal = (v) => {
    if (typeof v === 'boolean') return <span className="data-val bool">{String(v)}</span>;
    if (typeof v === 'number') return <span className="data-val number">{v}</span>;
    if (typeof v === 'string') return <span className="data-val string">"{v}"</span>;
    if (typeof v === 'object') return <span className="data-val">{Array.isArray(v) ? `[${v.length} items]` : `{${Object.keys(v).length} keys}`}</span>;
    return <span className="data-val">{String(v)}</span>;
  };

  const isObject = typeof value === 'object' && value !== null;

  return (
    <div className="data-view">
      <div className="data-view-tabs">
        <button className={`data-view-tab ${activeTab === 'insight' ? 'active' : ''}`} onClick={() => setActiveTab('insight')}>
          Insights
        </button>
        <button className={`data-view-tab ${activeTab === 'raw' ? 'active' : ''}`} onClick={() => setActiveTab('raw')}>
          Raw JSON
        </button>
      </div>

      <div className="data-view-body">
        {activeTab === 'insight' ? (
          isObject ? (
            <div className="data-insight">
              {Object.entries(value).map(([k, v]) => (
                <div key={k} className="data-kv">
                  <span className="data-key">{k}:</span>
                  {renderVal(v)}
                </div>
              ))}
            </div>
          ) : (
            <div className="data-val">{String(value)}</div>
          )
        ) : (
          <pre style={{ margin: 0, color: 'var(--ink-2)', fontSize: 11 }}>
            {JSON.stringify(value, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
