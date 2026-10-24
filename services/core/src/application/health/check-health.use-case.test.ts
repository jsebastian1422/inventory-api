import { describe, expect, it } from 'vitest';
import { CheckHealthUseCase } from './check-health.use-case.js';

const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');

describe('CheckHealthUseCase', () => {
  it('reports database up when the port says available', async () => {
    const useCase = new CheckHealthUseCase({ isAvailable: async () => true }, fixedNow);
    expect(await useCase.execute()).toEqual({
      api: 'up',
      database: 'up',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports database down when unavailable', async () => {
    const useCase = new CheckHealthUseCase({ isAvailable: async () => false }, fixedNow);
    expect((await useCase.execute()).database).toBe('down');
  });

  it('does not throw when the port throws', async () => {
    const useCase = new CheckHealthUseCase(
      {
        isAvailable: async () => {
          throw new Error('boom');
        },
      },
      fixedNow,
    );
    const status = await useCase.execute();
    expect(status.api).toBe('up');
    expect(status.database).toBe('down');
  });
});
