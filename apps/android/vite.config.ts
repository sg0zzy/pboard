import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom', 'rxdb', 'rxjs', 'simple-peer', 'dexie', 'fractional-indexing', 'fflate'] },
  server: { fs: { allow: ['../..'] } },
  plugins: [react()],
  build: {
    rolldownOptions: { output: { codeSplitting: { groups: [
      { name: 'storage', test: /node_modules[\\/](?:rxdb|dexie|rxjs|fractional-indexing)[\\/]/ },
      { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
    ] } } },
  },
  test: { include: ['tests/**/*.check.{ts,tsx}'], environment: 'jsdom' },
});
