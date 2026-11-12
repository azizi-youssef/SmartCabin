'use client';

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { useEffect } from 'react';

import { useRouter } from '@/i18n/navigation';

import { getRealtimeAccess } from '../live-actions';

/**
 * Subscribes a queue screen to its private realtime topics (module 8b) and refreshes the server
 * data when a hint arrives. Hints carry ids and versions only (BR-Q-09); the data itself is always
 * re-read through RLS. Without a working realtime connection, AutoRefresh keeps polling.
 */
export function QueueLive({ clinicSlug, doctorIds }: { clinicSlug: string; doctorIds?: string[] }) {
  const router = useRouter();
  const doctorKey = (doctorIds ?? []).join(',');

  useEffect(() => {
    let client: SupabaseClient | null = null;
    let channels: RealtimeChannel[] = [];
    let renew: number | undefined;
    let pending: number | undefined;
    let stopped = false;

    const refresh = () => {
      window.clearTimeout(pending);
      // Several hints can arrive together (one per queue change): refresh once.
      pending = window.setTimeout(() => router.refresh(), 400);
    };

    async function connect() {
      const result = await getRealtimeAccess({ clinicSlug, ...(doctorKey ? { doctorIds: doctorKey.split(',') } : {}) });
      if (stopped || !result.ok) return;
      const { url, key, accessToken, topics, expiresIn } = result.data;
      if (!client) {
        client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      }
      await client.realtime.setAuth(accessToken);
      if (channels.length === 0) {
        channels = topics.map((topic) =>
          client!.channel(topic, { config: { private: true } }).on('broadcast', { event: 'queue_changed' }, refresh).subscribe(),
        );
      }
      // Renew the access token shortly before it expires.
      renew = window.setTimeout(() => void connect(), Math.max(30, expiresIn - 60) * 1000);
    }

    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(renew);
      window.clearTimeout(pending);
      for (const channel of channels) void client?.removeChannel(channel);
    };
  }, [clinicSlug, doctorKey, router]);

  return null;
}
