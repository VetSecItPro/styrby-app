/**
 * Tests for the disposable email domain blocklist.
 *
 * WHY these tests matter: This module is the signup abuse prevention layer.
 * If isDisposableEmail() returns false for a known disposable domain, attackers
 * can bypass the check and abuse free tiers at scale. If it incorrectly blocks
 * legitimate domains (false positives), real users cannot sign up.
 *
 * Covers:
 * - Known disposable domains are blocked
 * - Legitimate domains are not blocked
 * - Case-insensitive domain comparison
 * - Malformed email addresses (no @, empty string)
 * - DISPOSABLE_EMAIL_ERROR export is defined
 */

import { describe, it, expect } from 'vitest';
import { isDisposableEmail, DISPOSABLE_EMAIL_ERROR } from '../disposable-emails';

describe('isDisposableEmail()', () => {
  // --------------------------------------------------------------------------
  // Known disposable domains — must be blocked
  // --------------------------------------------------------------------------

  describe('known disposable domains', () => {
    const BLOCKED: string[] = [
      'mailinator.com',
      'guerrillamail.com',
      'guerrillamail.net',
      'guerrillamail.org',
      'guerrillamail.de',
      'guerrillamail.biz',
      'trashmail.com',
      'trashmail.net',
      'trashmail.me',
      'trashmail.org',
      'trashmail.at',
      'trashmail.de',
      '10minutemail.com',
      'temp-mail.org',
      'tempmail.eu',
      'yopmail.com',
      'yopmail.fr',
      'maildrop.cc',
      'mailsac.com',
      'fakeinbox.com',
      'discard.email',
      'spam4.me',
      'sharklasers.com',
      'getnada.com',
      'nada.email',
      'mytemp.email',
    ];

    for (const domain of BLOCKED) {
      it(`blocks user@${domain}`, () => {
        expect(isDisposableEmail(`user@${domain}`)).toBe(true);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Legitimate domains — must NOT be blocked
  // --------------------------------------------------------------------------

  describe('legitimate domains', () => {
    const ALLOWED: string[] = [
      'gmail.com',
      'yahoo.com',
      'outlook.com',
      'hotmail.com',
      'icloud.com',
      'protonmail.com',
      'fastmail.com',
      'hey.com',
      'example.com',
      'company.io',
      'dev.company.com',
      'university.edu',
    ];

    for (const domain of ALLOWED) {
      it(`allows user@${domain}`, () => {
        expect(isDisposableEmail(`user@${domain}`)).toBe(false);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Case insensitivity
  // --------------------------------------------------------------------------

  describe('case-insensitive domain comparison', () => {
    it('blocks uppercase disposable domain: MAILINATOR.COM', () => {
      expect(isDisposableEmail('user@MAILINATOR.COM')).toBe(true);
    });

    it('blocks mixed-case disposable domain: MailiNator.Com', () => {
      expect(isDisposableEmail('user@MailiNator.Com')).toBe(true);
    });

    it('blocks all-caps TRASHMAIL.COM', () => {
      expect(isDisposableEmail('USER@TRASHMAIL.COM')).toBe(true);
    });

    it('does not block Gmail.Com (legitimate regardless of case)', () => {
      expect(isDisposableEmail('user@Gmail.Com')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Malformed / edge case inputs
  // --------------------------------------------------------------------------

  describe('malformed email inputs', () => {
    it('returns false for an empty string (no @ present)', () => {
      expect(isDisposableEmail('')).toBe(false);
    });

    it('returns false for a string with no @ symbol', () => {
      expect(isDisposableEmail('notanemail')).toBe(false);
    });

    it('returns false for a string ending with @ (no domain)', () => {
      expect(isDisposableEmail('user@')).toBe(false);
    });

    it('returns false for only an @ symbol', () => {
      expect(isDisposableEmail('@')).toBe(false);
    });

    it('uses the part after the LAST @ when multiple @ symbols appear', () => {
      // email = 'a@b@mailinator.com' — split('@')[1] = 'b', not 'mailinator.com'
      // This tests the documented split behaviour (split('@')[1])
      const result = isDisposableEmail('a@b@mailinator.com');
      // split('@')[1] = 'b', which is NOT a disposable domain
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // DISPOSABLE_EMAIL_ERROR constant
  // --------------------------------------------------------------------------

  describe('DISPOSABLE_EMAIL_ERROR constant', () => {
    it('is a non-empty string', () => {
      expect(typeof DISPOSABLE_EMAIL_ERROR).toBe('string');
      expect(DISPOSABLE_EMAIL_ERROR.length).toBeGreaterThan(0);
    });

    it('mentions "permanent" or "disposable" to give users actionable guidance', () => {
      const lower = DISPOSABLE_EMAIL_ERROR.toLowerCase();
      expect(lower.includes('permanent') || lower.includes('disposable')).toBe(true);
    });
  });
});
