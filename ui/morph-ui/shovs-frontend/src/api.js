export const api = {
  get: async (endpoint, params = {}) => {
    try {
      const url = new URL(endpoint, window.location.origin);
      Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      // Graceful Fallback for Standalone / Demo Mode when backend is offline
      if (endpoint === '/api/config') {
        return {
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
      return { ok: true, status: "demo" };
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
      return { ok: true };
    }
  },
  delete: async (endpoint) => {
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      return res.ok;
    } catch (err) {
      return true;
    }
  }
};
