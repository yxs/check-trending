import { describe, expect, it } from 'vitest';

import { DONATE_PATH, DONATE_QR_PATH, GITHUB_URL } from './site';

describe('site links', () => {
  it('points to the public GitHub repository and donate QR route', () => {
    expect(GITHUB_URL).toBe('https://github.com/yxs/check-trending');
    expect(DONATE_PATH).toBe('/donate');
    expect(DONATE_QR_PATH).toBe('/donate/wechat-qr.jpg');
  });
});
