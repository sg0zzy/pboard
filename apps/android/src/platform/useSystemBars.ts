import { useEffect } from 'react';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';

/** Keep native bar icons in step with CSS when the system theme changes live. */
export function useSystemBars() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      void SystemBars.setStyle({ style: theme.matches ? SystemBarsStyle.Dark : SystemBarsStyle.Light })
        .catch(error => console.error('Could not update system bar style', error));
    };
    apply();
    theme.addEventListener('change', apply);
    return () => theme.removeEventListener('change', apply);
  }, []);
}
