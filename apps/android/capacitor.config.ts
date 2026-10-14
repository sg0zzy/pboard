import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'it.stefanogozzi.pboard',
  appName: 'pboard',
  webDir: 'dist',
  plugins: {
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover', style: 'DEFAULT' },
  },
};
export default config;
