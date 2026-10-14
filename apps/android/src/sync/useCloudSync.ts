import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import { getAndroidSync } from './service';
import { openRepository } from '../storage/repository';

export function useCloudSync(ready: boolean, projectId: string | null) {
  const [service] = useState(() => Capacitor.getPlatform?.() === 'android' ? getAndroidSync(openRepository) : null);
  const [state, setState] = useState(() => service?.state());
  useEffect(() => {
    if (!service || !ready) return;
    let active = true;
    const unsubscribe = service.subscribe(() => { if (active) setState(service.state()); });
    const foreground = (isActive: boolean) => { void service.setForeground(isActive).catch(error => console.error('Cloud sync lifecycle failed', error)); };
    void service.initialize().then(() => { if (active) foreground(document.visibilityState !== 'hidden'); });
    const visibility = () => foreground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    const listener = NativeApp.addListener('appStateChange', event => foreground(event.isActive));
    const online = () => { void service.sync(); };
    window.addEventListener('online', online);
    const timer = setInterval(() => service.pollLive(), 1_000);
    return () => {
      active = false; unsubscribe(); clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', online);
      void listener.then(handle => handle.remove());
      foreground(false);
    };
  }, [service, ready]);
  useEffect(() => {
    if (service && ready) void service.selectProject(projectId);
  }, [service, ready, projectId]);
  return { service, state };
}
