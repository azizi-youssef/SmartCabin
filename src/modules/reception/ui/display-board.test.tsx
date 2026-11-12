import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import messages from '../../../../messages/fr.json';
import { DisplayBoard } from './display-board';

const TOKEN = 'a'.repeat(64);

function renderBoard() {
  return render(
    <NextIntlClientProvider locale="fr" messages={messages} timeZone="Africa/Casablanca">
      <DisplayBoard />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('waiting-room display board', () => {
  it('sends the token as a bearer header, never in the URL, and shows ticket numbers only', async () => {
    window.location.hash = TOKEN;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      clinic: 'Clinique Al Amal',
      screen: 'Salle principale',
      timezone: 'Africa/Casablanca',
      generated_at: '2027-01-04T10:00:00Z',
      doctors: [{ name: 'Dr Idrissi', name_ar: null, session: 'open', serving: 12, called: [13], next: [14, 15], waiting: 3 }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    renderBoard();
    expect(await screen.findByText('Dr Idrissi')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByText('14 · 15')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/display');
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('says the screen is no longer authorized when the token is revoked', async () => {
    window.location.hash = TOKEN;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"NOT_FOUND"}', { status: 404 })));
    renderBoard();
    expect(await screen.findByText(messages.display.revokedTitle)).toBeInTheDocument();
  });

  it('asks for the complete link when the token is missing, without calling the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderBoard();
    await waitFor(() => expect(screen.getByText(messages.display.missingTitle)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
