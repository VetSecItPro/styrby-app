/**
 * Tests for the pure helpers in `account/constants.ts`.
 *
 * WHY: validators and cooldown math are extracted from the orchestrator and
 * shared by the hook + future server-side parity checks. Unit testing them
 * directly catches regressions far faster than re-rendering the whole
 * Account screen.
 */

import {
  isValidEmail,
  passwordResetCooldownRemainingSec,
  PASSWORD_RESET_COOLDOWN_MS,
} from '../constants';

describe('isValidEmail', () => {
  it.each([
    ['foo@bar.com', true],
    ['  Foo@Bar.com  ', true],
    ['user.name+tag@sub.example.co', true],
    ['plainaddress', false],
    ['no-at-sign.com', false],
    ['no-tld@example', false],
    ['has space@example.com', false],
    ['', false],
    ['@example.com', false],
    ['foo@', false],
  ])('returns %p for %p', (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });
});

describe('passwordResetCooldownRemainingSec', () => {
  it('returns 0 when no email has been sent', () => {
    expect(passwordResetCooldownRemainingSec(null, 1_000_000)).toBe(0);
  });

  it('returns 0 once the cooldown has fully elapsed', () => {
    const now = 2_000_000;
    expect(passwordResetCooldownRemainingSec(now - PASSWORD_RESET_COOLDOWN_MS, now)).toBe(0);
    expect(passwordResetCooldownRemainingSec(now - PASSWORD_RESET_COOLDOWN_MS - 1, now)).toBe(0);
  });

  it('returns ceil(remaining seconds) while cooling down', () => {
    const now = 5_000_000;
    // 1ms after sending: should be the full window in seconds
    expect(passwordResetCooldownRemainingSec(now - 1, now)).toBe(60);
    // halfway through
    expect(passwordResetCooldownRemainingSec(now - 30_000, now)).toBe(30);
    // 1 second remaining of cooldown -> 1
    expect(passwordResetCooldownRemainingSec(now - (PASSWORD_RESET_COOLDOWN_MS - 1_000), now)).toBe(1);
  });

  it('rounds up sub-second remaining time', () => {
    const now = 10_000_000;
    // 500ms remain -> ceil to 1
    expect(passwordResetCooldownRemainingSec(now - (PASSWORD_RESET_COOLDOWN_MS - 500), now)).toBe(1);
  });
});
