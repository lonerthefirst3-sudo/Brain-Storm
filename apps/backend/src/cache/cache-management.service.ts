import { CACHE_MANAGER, Inject, Injectable } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { CoursesService } from '../courses/courses.service';

@Injectable()
export class CacheManagementService {
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly coursesService: CoursesService,
  ) {}

  async getStats() {
    const store: any = (this.cacheManager as any).store;
    const client = store?.getClient?.();
    const stats: Record<string, unknown> = {
      backend: 'redis',
      isAvailable: !!client,
    };

    if (client && typeof client.info === 'function') {
      try {
        stats.info = await client.info();
      } catch (error) {
        stats.error = (error as Error).message;
      }
    }

    return stats;
  }

  async clear() {
    await this.cacheManager.reset();
    return { cleared: true };
  }

  async warm(target?: string) {
    const result: Record<string, unknown> = {};

    if (!target || target === 'courses') {
      await this.coursesService.warmCache();
      result.courses = 'warmed';
    }

    return result;
  }
}
