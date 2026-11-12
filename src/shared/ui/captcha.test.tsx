import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Captcha } from './captcha';

function renderCaptcha(onToken: (t: string | null) => void, locale: 'fr' | 'ar' = 'fr') {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <Captcha onToken={onToken} />
    </NextIntlClientProvider>,
  );
}

describe('Captcha (Turnstile, SC-AUD-01)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete window.turnstile;
    document.getElementById('cf-turnstile-script')?.remove();
  });

  it('renders nothing and loads no script when no site key is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    const { container } = renderCaptcha(() => undefined);
    expect(container).toBeEmptyDOMElement();
    expect(document.getElementById('cf-turnstile-script')).toBeNull();
  });

  it('renders the widget in the page language and hands its single-use token to the form', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key-test');
    let options: Record<string, unknown> = {};
    window.turnstile = {
      render: vi.fn((_el: HTMLElement, o: Record<string, unknown>) => {
        options = o;
        return 'widget-1';
      }),
      remove: vi.fn(),
    };
    const onToken = vi.fn();
    const { unmount } = renderCaptcha(onToken, 'ar');
    expect(await screen.findByTestId('captcha')).toBeInTheDocument();
    await vi.waitFor(() => expect(window.turnstile?.render).toHaveBeenCalled());
    expect(options).toMatchObject({ sitekey: 'site-key-test', language: 'ar' });
    (options['callback'] as (t: string) => void)('token-xyz');
    expect(onToken).toHaveBeenLastCalledWith('token-xyz');
    (options['expired-callback'] as () => void)();
    expect(onToken).toHaveBeenLastCalledWith(null);
    unmount();
    expect(window.turnstile?.remove).toHaveBeenCalledWith('widget-1');
  });
});
