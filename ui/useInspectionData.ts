import { useEffect, useState } from 'react';
type Api = (path: string) => Promise<any>;
export function useLive<T>(api: Api, path: string) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<T>(); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false; let busy = false;
    setData(undefined); setError('');
    const load = async () => {
      if (busy) return; busy = true; setLoading(true);
      try { const value = await api(path); if (!cancelled) { setData(value); setError(''); } }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : '读取失败'); }
      finally { busy = false; if (!cancelled) setLoading(false); }
    };
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, path, refresh]);
  return { data, error, loading, reload: () => setRefresh(x => x + 1) };
}
