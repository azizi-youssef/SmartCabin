import { z } from 'zod';

/**
 * Public Supabase configuration. These values are designed to be public (RLS protects the data).
 * Returns null when the backend is not configured, so pages can render an explicit
 * "service unavailable" state instead of crashing or inventing data.
 *
 * There is deliberately no service-role key here: the web app never uses one.
 */
const publicEnvSchema = z.object({
  url: z.url(),
  key: z.string().min(20),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function publicEnv(): PublicEnv | null {
  const parsed = publicEnvSchema.safeParse({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  return parsed.success ? parsed.data : null;
}
