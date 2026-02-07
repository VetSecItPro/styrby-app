import { describe, it, expect } from 'vitest';
import {
  LAST_VERIFIED,
  MODEL_PRICING,
  PROVIDER_DISPLAY_NAMES,
  type Provider,
  type ModelPricingEntry,
} from '../model-pricing';

describe('model-pricing', () => {
  describe('LAST_VERIFIED', () => {
    it('should be a non-empty string', () => {
      expect(LAST_VERIFIED).toBeTruthy();
      expect(typeof LAST_VERIFIED).toBe('string');
      expect(LAST_VERIFIED.length).toBeGreaterThan(0);
    });

    it('should be a valid date format (YYYY-MM-DD)', () => {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      expect(LAST_VERIFIED).toMatch(dateRegex);

      // Verify it's a valid date
      const date = new Date(LAST_VERIFIED);
      expect(date.toString()).not.toBe('Invalid Date');
    });
  });

  describe('MODEL_PRICING', () => {
    it('should have at least 7 entries', () => {
      expect(MODEL_PRICING.length).toBeGreaterThanOrEqual(7);
    });

    it('should have all required fields for each entry', () => {
      MODEL_PRICING.forEach((entry, index) => {
        expect(entry, `Entry at index ${index} missing 'name'`).toHaveProperty('name');
        expect(entry, `Entry at index ${index} missing 'provider'`).toHaveProperty('provider');
        expect(entry, `Entry at index ${index} missing 'inputPer1M'`).toHaveProperty('inputPer1M');
        expect(entry, `Entry at index ${index} missing 'outputPer1M'`).toHaveProperty('outputPer1M');

        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(['anthropic', 'openai', 'google']).toContain(entry.provider);
      });
    });

    it('should have positive prices for all models', () => {
      MODEL_PRICING.forEach((entry) => {
        expect(entry.inputPer1M, `${entry.name} has non-positive input price`).toBeGreaterThan(0);
        expect(entry.outputPer1M, `${entry.name} has non-positive output price`).toBeGreaterThan(0);
      });
    });

    it('should have output price >= input price for every model', () => {
      MODEL_PRICING.forEach((entry) => {
        expect(
          entry.outputPer1M,
          `${entry.name} has output price (${entry.outputPer1M}) less than input price (${entry.inputPer1M})`
        ).toBeGreaterThanOrEqual(entry.inputPer1M);
      });
    });

    it('should have at least one model per provider', () => {
      const providers: Provider[] = ['anthropic', 'openai', 'google'];

      providers.forEach((provider) => {
        const modelsForProvider = MODEL_PRICING.filter((m) => m.provider === provider);
        expect(
          modelsForProvider.length,
          `No models found for provider: ${provider}`
        ).toBeGreaterThan(0);
      });
    });

    it('should contain expected flagship models by name', () => {
      const expectedModels = ['Claude 3.5 Sonnet', 'GPT-4o', 'Gemini 1.5 Pro'];

      expectedModels.forEach((modelName) => {
        const found = MODEL_PRICING.find((m) => m.name === modelName);
        expect(found, `Expected model "${modelName}" not found in MODEL_PRICING`).toBeDefined();
      });
    });

    it('should have valid pricing ranges for known models', () => {
      const sonnet = MODEL_PRICING.find((m) => m.name === 'Claude 3.5 Sonnet');
      const haiku = MODEL_PRICING.find((m) => m.name === 'Claude 3.5 Haiku');
      const opus = MODEL_PRICING.find((m) => m.name === 'Claude 3 Opus');

      // Haiku should be cheapest Anthropic model
      if (sonnet && haiku && opus) {
        expect(haiku.inputPer1M).toBeLessThan(sonnet.inputPer1M);
        expect(haiku.inputPer1M).toBeLessThan(opus.inputPer1M);

        // Opus should be most expensive Anthropic model
        expect(opus.inputPer1M).toBeGreaterThan(sonnet.inputPer1M);
        expect(opus.outputPer1M).toBeGreaterThan(sonnet.outputPer1M);
      }
    });

    it('should have no duplicate model names', () => {
      const names = MODEL_PRICING.map((m) => m.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe('PROVIDER_DISPLAY_NAMES', () => {
    it('should have all 3 providers', () => {
      const providers: Provider[] = ['anthropic', 'openai', 'google'];

      providers.forEach((provider) => {
        expect(
          PROVIDER_DISPLAY_NAMES,
          `Missing provider: ${provider}`
        ).toHaveProperty(provider);
      });

      expect(Object.keys(PROVIDER_DISPLAY_NAMES).length).toBe(3);
    });

    it('should map to correct display names', () => {
      expect(PROVIDER_DISPLAY_NAMES.anthropic).toBe('Anthropic');
      expect(PROVIDER_DISPLAY_NAMES.openai).toBe('OpenAI');
      expect(PROVIDER_DISPLAY_NAMES.google).toBe('Google');
    });

    it('should have non-empty display names', () => {
      Object.values(PROVIDER_DISPLAY_NAMES).forEach((displayName) => {
        expect(displayName).toBeTruthy();
        expect(typeof displayName).toBe('string');
        expect(displayName.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Type safety', () => {
    it('should have correct TypeScript types', () => {
      // This test verifies compile-time type safety
      const entry: ModelPricingEntry = MODEL_PRICING[0];

      // These assignments should not throw TypeScript errors
      const name: string = entry.name;
      const provider: Provider = entry.provider;
      const input: number = entry.inputPer1M;
      const output: number = entry.outputPer1M;

      expect(name).toBeDefined();
      expect(provider).toBeDefined();
      expect(input).toBeDefined();
      expect(output).toBeDefined();
    });
  });
});
