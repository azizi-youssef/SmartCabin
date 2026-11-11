import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Module boundaries (SYSTEM_ARCHITECTURE §3): UI never reaches into module internals,
    // and no code may import a privileged (service-role) client — none exists in the app.
    files: ['src/app/**/*.{ts,tsx}', 'src/shared/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/modules/*/infrastructure/*', '@/modules/*/infrastructure'], message: 'Import the module public interface instead.' },
          { group: ['**/privileged*'], message: 'Service-role clients are server-only and not allowed in the app or UI.' },
        ],
      }],
    },
  },
  {
    files: ['src/shared/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/modules/*'], message: 'Design-system components must not depend on business modules.' },
          { group: ['@supabase/*'], message: 'Design-system components must not access data.' },
        ],
      }],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'coverage/**', 'supabase/**',
    'src/shared/lib/supabase/database.types.ts']),
]);
