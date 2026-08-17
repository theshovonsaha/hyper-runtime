export const api = {
  get: async (endpoint, params = {}) => {
    try {
      const url = new URL(endpoint, window.location.origin);
      Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
      return await res.json();
    } catch {
      // Graceful Fallback for Standalone / Demo Mode when backend is offline
      if (endpoint === '/api/config') {
        return {
          ok: false,
          runtime: 'offline-demo',
          provider: 'demo-provider',
          providers_available: { 'demo-provider': true, 'openai': true },
          models: { 'demo-provider': 'morph-v1' },
          levels: ['debug', 'info', 'normal']
        };
      }
      if (endpoint.includes('/messages')) {
        return { messages: [] };
      }
      if (endpoint.includes('/runs')) {
        return { runs: [] };
      }
      return {};
    }
  },
  post: async (endpoint, body = {}) => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      return { ok: false, status: "offline", error: err.message };
    }
  },
  put: async (endpoint, body = {}) => {
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  patch: async (endpoint, body = {}) => {
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  delete: async (endpoint) => {
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      return res.ok;
    } catch {
      return false;
    }
  }
};
