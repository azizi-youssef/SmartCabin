import '@/styles/globals.css';

import Link from 'next/link';

/** Requests outside any locale (rare: the proxy adds one). Bilingual by necessity. */
export default function GlobalNotFound() {
  return (
    <html lang="fr">
      <body className="grid min-h-dvh place-items-center bg-canvas p-6">
        <main className="grid max-w-md gap-2 text-center">
          <h1 className="text-title">Page introuvable · الصفحة غير موجودة</h1>
          <Link className="text-accent underline" href="/fr">
            SmartClinic
          </Link>
        </main>
      </body>
    </html>
  );
}
